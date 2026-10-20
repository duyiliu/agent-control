import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CheckSpec } from '../types.js';
import { runProc, scrubEnvForAgent, which } from '../proc.js';

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
  aborted?: boolean;
  infraError?: string;
}

export function resolveCheckArgv(argv: string[]): string[] {
  if (process.platform !== 'win32') return argv;
  const name = argv[0]!;
  const found = existsSync(name) ? name : which(name);
  if (!found) return argv;
  if (!/\.(cmd|bat)$/i.test(found)) return [found, ...argv.slice(1)];
  const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(name.split(/[\\/]/).pop()!);
  if (npm) {
    const cli = join(dirname(found), 'node_modules', 'npm', 'bin', `${npm[1]!.toLowerCase()}-cli.js`);
    if (existsSync(cli)) return [process.execPath, cli, ...argv.slice(1)];
  }
  throw new Error(`check launcher ${found} is a shell script; configure its executable or JS entry point explicitly`);
}

/** Checks execute agent-written code, so they retain the agent credential jail. */
export async function runChecks(
  checks: CheckSpec[],
  workdir: string,
  logPathFor: (idx: number) => string,
  exec: typeof runProc = runProc,
  signal?: AbortSignal,
  onSpawn?: (pid: number | null) => void,
): Promise<ChecksSummary> {
  const outcomes: CheckOutcome[] = [];
  let infraError: string | undefined;
  let aborted = signal?.aborted ?? false;
  for (let i = 0; i < checks.length && !aborted; i++) {
    const spec = checks[i]!;
    const logPath = logPathFor(i);
    let argv: string[];
    try { argv = resolveCheckArgv(spec.argv); }
    catch (err) { infraError = String(err); break; }
    const res = await exec({
      argv, cwd: workdir,
      env: scrubEnvForAgent(process.env),
      timeoutMs: (spec.timeout_seconds ?? 600) * 1000,
      logPath, signal, onSpawn,
    });
    outcomes.push({
      spec, command: spec.argv.join(' '), exitCode: res.exitCode, timedOut: res.timedOut,
      tail: [res.stdoutTail, res.stderrTail].filter(Boolean).join('\n').slice(-20_000), logPath,
    });
    aborted = res.aborted || (signal?.aborted ?? false);
    if (!aborted && (res.spawnError || res.timedOut || res.exitCode === null || res.signal !== null)) {
      infraError = res.spawnError ?? (res.timedOut ? `check timed out: ${spec.argv.join(' ')}` : `check terminated without a normal exit: ${res.signal ?? 'unknown'}`);
    }
    if (aborted || infraError || res.exitCode !== 0) break;
  }
  const failures = outcomes.filter((o) => o.exitCode !== 0 || o.timedOut);
  return {
    ok: !aborted && !infraError && failures.length === 0,
    outcomes, aborted, infraError,
    failureEvidence: infraError ?? failures
      .map((f) => `命令: ${f.command}\n退出码: ${f.exitCode}${f.timedOut ? ' (超时)' : ''}\n输出尾部:\n${f.tail}`)
      .join('\n\n'),
  };
}
