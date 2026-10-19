import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runProc, scrubEnvForAgent, which } from '../proc.js';
import type { AppConfig } from '../types.js';
import type { ContainerSession } from './container.js';
import type { AgentCallOpts, AgentCallResult } from './types.js';

export interface CodexInvocation {
  /** Full argv: [nodeOrBinary, ...scriptPrefix?] — 'exec' etc. appended by buildArgv. */
  argv0: string;
  prefix: string[];
}

/**
 * Resolve how to invoke codex. npm-installed codex on Windows is a .cmd shim
 * over a node script; spawning `node codex.js` directly avoids cmd.exe quoting
 * and the 8k command-line limit.
 */
export function resolveCodexInvocation(envPath = process.env.PATH ?? ''): CodexInvocation {
  const found = which('codex', envPath);
  if (found) {
    if (found.toLowerCase().endsWith('.cmd') || found.toLowerCase().endsWith('.bat')) {
      // npm shim convention: <prefix>/codex.cmd -> <prefix>/node_modules/@openai/codex/bin/codex.js
      const js = join(dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(js)) return { argv0: process.execPath, prefix: [js] };
      // Unknown wrapper — run through cmd.exe (prompt still goes via stdin).
      const comspec = process.env.ComSpec ?? 'cmd.exe';
      return { argv0: comspec, prefix: ['/d', '/s', '/c', found] };
    }
    return { argv0: found, prefix: [] };
  }
  // Not found: let spawn fail with a clear error at exec time.
  return { argv0: 'codex', prefix: [] };
}

/**
 * One isolated `codex exec` invocation. The prompt is piped through stdin
 * (`exec -`) so it never hits command-line limits or shell quoting.
 * Output events land in logPath as JSONL (--json).
 * With `opts.session`, codex runs inside the container: cwd maps to /work,
 * `-o` lands in /ac and is pulled back host-side after the run.
 */
export async function runCodex(
  opts: AgentCallOpts,
  config: AppConfig['agent'],
  invocation?: CodexInvocation,
): Promise<AgentCallResult> {
  if (opts.session) return runCodexInSession(opts, config, opts.session);
  const inv = invocation ?? resolveCodexInvocation();
  const argv = [
    inv.argv0,
    ...inv.prefix,
    'exec',
    '--json',
    '--ephemeral',
    '--color', 'never',
    '-s', opts.sandbox ?? 'danger-full-access',
    '-C', opts.workdir,
    '-o', opts.lastMessagePath,
    ...(opts.schemaPath ? ['--output-schema', opts.schemaPath] : []),
    ...(opts.model ?? config.model ? ['-m', (opts.model ?? config.model)!] : []),
    ...(config.reasoning_effort ? ['-c', `model_reasoning_effort="${config.reasoning_effort}"`] : []),
    '-',
  ];
  const env = scrubEnvForAgent(process.env, config.env_deny);

  let capturedPid: number | null = null;
  const startedAt = Date.now();
  const res = await runProc({
    argv,
    cwd: opts.workdir,
    env,
    stdinData: opts.prompt,
    timeoutMs: opts.timeoutMs,
    logPath: opts.logPath,
    signal: opts.signal,
    onSpawn: (pid) => {
      capturedPid = pid;
      opts.onSpawn?.(pid, pid != null ? `${pid}:${startedAt}` : null);
    },
  });
  return { ...res, pid: capturedPid };
}

async function runCodexInSession(
  opts: AgentCallOpts,
  config: AppConfig['agent'],
  session: ContainerSession,
): Promise<AgentCallResult> {
  const lastName = `codex-last-${Date.now()}.txt`;
  const schemaName = opts.schemaPath ? `codex-schema-${Date.now()}.json` : null;
  if (schemaName) {
    await session.pushFile(schemaName, opts.schemaPath!);
  }
  const argv = [
    'codex',
    'exec',
    '--json',
    '--ephemeral',
    '--color', 'never',
    '-s', opts.sandbox ?? 'danger-full-access',
    '-C', '/work',
    '-o', `/ac/${lastName}`,
    ...(schemaName ? ['--output-schema', `/ac/${schemaName}`] : []),
    ...(opts.model ?? config.model ? ['-m', (opts.model ?? config.model)!] : []),
    ...(config.reasoning_effort ? ['-c', `model_reasoning_effort="${config.reasoning_effort}"`] : []),
    '-',
  ];

  let capturedPid: number | null = null;
  const startedAt = Date.now();
  const res = await session.run(argv, {
    stdinData: opts.prompt,
    timeoutMs: opts.timeoutMs,
    logPath: opts.logPath,
    signal: opts.signal,
    onSpawn: (pid) => {
      capturedPid = pid;
      opts.onSpawn?.(pid, pid != null ? `${pid}:${startedAt}` : null);
    },
  });
  await session.pullArtifact(lastName, opts.lastMessagePath);
  return { ...res, pid: capturedPid };
}
