import type { CheckSpec } from '../types.js';
import { runProc, scrubEnvForAgent } from '../proc.js';
import type { ContainerSession } from '../runners/container.js';

export interface CheckOutcome {
  spec: CheckSpec;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  logPath: string;
}

export interface ChecksSummary {
  ok: boolean;
  outcomes: CheckOutcome[];
  failureEvidence: string;
}

/**
 * Run the trusted check list from repo config inside the worktree.
 * Commands come from config only — never from issue content. The env is
 * scrubbed with the same allowlist as the agent: check commands execute
 * agent-written code (test files, npm scripts), which must not see host
 * credentials either.
 */
export async function runChecks(
  checks: CheckSpec[],
  workdir: string,
  logPathFor: (idx: number) => string,
  exec: typeof runProc = runProc,
  /** When set, checks run inside the container session (cwd=/work). */
  session?: ContainerSession,
): Promise<ChecksSummary> {
  const outcomes: CheckOutcome[] = [];
  for (let i = 0; i < checks.length; i++) {
    const spec = checks[i]!;
    const logPath = logPathFor(i);
    const res = session
      ? await session.run(spec.argv, {
          timeoutMs: (spec.timeout_seconds ?? 600) * 1000,
          logPath,
        })
      : await exec({
          argv: spec.argv,
          cwd: workdir,
          env: scrubEnvForAgent(process.env),
          timeoutMs: (spec.timeout_seconds ?? 600) * 1000,
          logPath,
        });
    outcomes.push({
      spec,
      command: spec.argv.join(' '),
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      tail: [res.stdoutTail, res.stderrTail].filter(Boolean).join('\n').slice(-20_000),
      logPath,
    });
    if (res.exitCode !== 0) break; // stop at first failure — fix loop re-runs all
  }
  const failures = outcomes.filter((o) => o.exitCode !== 0);
  return {
    ok: failures.length === 0,
    outcomes,
    failureEvidence: failures
      .map((f) => `命令: ${f.command}\n退出码: ${f.exitCode}${f.timedOut ? ' (超时)' : ''}\n输出尾部:\n${f.tail}`)
      .join('\n\n'),
  };
}
