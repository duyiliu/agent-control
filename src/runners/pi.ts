import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runProc, scrubEnvForAgent, which } from '../proc.js';
import type { AppConfig } from '../types.js';
import type { AgentCallOpts, AgentCallResult } from './types.js';

export interface PiInvocation {
  argv0: string;
  prefix: string[];
}

/**
 * `npm i -g` puts the pi shim in the same directory as the node binary that
 * runs it, so look beside the runtime node before shelling out to npm. This is
 * the "current user's default install" fallback: a systemd unit's Environment
 * is not inherited by an interactive shell, and the reverse holds too, so PATH
 * alone cannot be trusted to be the same in both contexts.
 */
export function piBesideNode(nodeDir: string): string | null {
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  for (const name of names) {
    const p = join(nodeDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * npm links `bin/pi` to `dist/bundle/cli.js`. Following it lets both platforms
 * run the entry with this process's node instead of relying on the shim's
 * `#!/usr/bin/env node`, which resolves through PATH and can pick a different
 * node than the one running agent-control. Returns null for a real script or
 * binary (a wrapper someone installed on purpose), so callers keep the shim.
 */
export function piEntryViaSymlink(shim: string): string | null {
  try {
    const abs = resolve(dirname(shim), readlinkSync(shim));
    return abs.endsWith('.js') && existsSync(abs) ? abs : null;
  } catch {
    return null; // not a symlink
  }
}

/**
 * Resolve `pi`: the npm .cmd shim spawns poorly without a shell on Windows,
 * so invoke the bundled cli.js via node directly.
 *
 * Order: an explicit `agent.pi_path` first (it is the operator's decision),
 * then PATH, then the runtime node's own directory.
 *
 * PATH stays ahead of discovery so it remains overridable — tests inject a shim
 * through PATH, and an operator may wrap pi with a script. Discovery only
 * covers the case where PATH does not have pi at all, which is exactly what
 * happens when the service unit's Environment is not inherited by a shell.
 */
export function resolvePiInvocation(
  envPath = process.env.PATH ?? '',
  explicit?: string,
  nodeDir = dirname(process.execPath),
): PiInvocation {
  const found = explicit || which('pi', envPath) || piBesideNode(nodeDir);
  if (found) {
    if (found.toLowerCase().endsWith('.cmd') || found.toLowerCase().endsWith('.bat')) {
      const js = join(
        dirname(found),
        'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js',
      );
      if (existsSync(js)) return { argv0: process.execPath, prefix: [js] };
      const comspec = process.env.ComSpec ?? 'cmd.exe';
      return { argv0: comspec, prefix: ['/d', '/s', '/c', found] };
    }
    const entry = piEntryViaSymlink(found);
    if (entry) return { argv0: process.execPath, prefix: [entry] };
    return { argv0: found, prefix: [] };
  }
  return { argv0: 'pi', prefix: [] };
}

/** Reviewer runs read-only at the TOOL level — no shell, no write tools. */
export const PI_REVIEW_TOOLS = ['read', 'grep', 'find', 'ls'];
export const PI_ALL_TOOLS = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * argv for one non-interactive `pi -p` call. Ambient project/user config is
 * disabled so the worktree (or its contents) cannot inject tools, skills,
 * templates or context files into the run (`--no-context-files` ignores
 * project-local files outright instead of prompting to trust them —
 * unattended runs must never block on a prompt), and `--` ends option
 * parsing so the trailing @prompt include is always taken as a message.
 */
export function buildPiArgv(
  opts: Pick<AgentCallOpts, 'tools'> & { promptPath: string; model?: string; thinking?: string },
  inv: PiInvocation,
): string[] {
  return [
    inv.argv0,
    ...inv.prefix,
    '-p',
    '--mode', 'json',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--tools', (opts.tools ?? PI_ALL_TOOLS).join(','),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.thinking ? ['--thinking', opts.thinking] : []),
    '--',
    `@${opts.promptPath}`,
  ];
}

/**
 * argv for a long-lived `pi --mode rpc` session: same isolation flags as the
 * one-shot form, but no prompt argument — prompts travel as JSONL commands on
 * stdin, and the process keeps its conversation between phases.
 */
export function buildRpcArgv(
  opts: { tools?: string[]; model?: string; thinking?: string; sessionId?: string; sessionDir?: string },
  inv: PiInvocation,
): string[] {
  if ((opts.sessionId == null) !== (opts.sessionDir == null)) {
    throw new Error('sessionId and sessionDir must be set together');
  }
  return [
    inv.argv0,
    ...inv.prefix,
    '--mode', 'rpc',
    ...(opts.sessionId != null
      ? ['--session-id', opts.sessionId, '--session-dir', opts.sessionDir!]
      : ['--no-session']),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--tools', (opts.tools ?? PI_ALL_TOOLS).join(','),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.thinking ? ['--thinking', opts.thinking] : []),
  ];
}

/**
 * Last assistant text from a `--mode json` event stream — extracted
 * host-side after the run (pi has no `-o` flag for this).
 */
export function extractLastMessage(jsonl: string): string | null {
  let last: string | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('message_end')) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: { type?: string; text?: string }[] };
      };
      if (ev.type !== 'message_end' || ev.message?.role !== 'assistant') continue;
      const texts = (ev.message.content ?? [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!);
      if (texts.length) last = texts.join('\n');
    } catch { /* partial/foreign line */ }
  }
  return last;
}

/**
 * One isolated `pi -p` invocation. The prompt travels via an @file include
 * (argv would hit Windows limits); the JSONL event stream lands in logPath;
 * the last assistant message is written to lastMessagePath post-hoc.
 * Confinement is the tool allowlist + scrubbed environment.
 */
export async function runPi(
  opts: AgentCallOpts,
  config: AppConfig['agent'],
  invocation?: PiInvocation,
): Promise<AgentCallResult> {
  const inv = invocation ?? resolvePiInvocation(process.env.PATH ?? '', config.pi_path);
  const promptPath = join(dirname(opts.lastMessagePath), `pi-prompt-${Date.now()}.txt`);
  writeFileSync(promptPath, opts.prompt, 'utf8');

  const argv = buildPiArgv(
    { tools: opts.tools, promptPath, model: opts.model ?? config.model, thinking: opts.thinking ?? config.reasoning_effort },
    inv,
  );
  const env = scrubEnvForAgent(process.env, config.env_deny);
  env.PI_OFFLINE = '1';
  env.PI_TELEMETRY = '0';

  let capturedPid: number | null = null;
  const startedAt = Date.now();
  const res = await runProc({
    argv,
    cwd: opts.workdir,
    env,
    timeoutMs: opts.timeoutMs,
    logPath: opts.logPath,
    signal: opts.signal,
    onSpawn: (pid) => {
      capturedPid = pid;
      opts.onSpawn?.(pid, pid != null ? `${pid}:${startedAt}` : null);
    },
  });

  const logText = opts.logPath && existsSync(opts.logPath)
    ? readFileSync(opts.logPath, 'utf8')
    : res.stdoutTail;
  const last = extractLastMessage(logText);
  if (last !== null) writeFileSync(opts.lastMessagePath, last, 'utf8');
  return { ...res, pid: capturedPid };
}
