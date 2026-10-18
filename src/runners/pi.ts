import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runProc, scrubEnvForAgent, which } from '../proc.js';
import type { AppConfig } from '../types.js';
import type { AgentCallOpts, AgentCallResult } from './types.js';

export interface PiInvocation {
  argv0: string;
  prefix: string[];
}

/**
 * Resolve `pi`: the npm .cmd shim spawns poorly without a shell on Windows,
 * so invoke the bundled cli.js via node directly.
 */
export function resolvePiInvocation(envPath = process.env.PATH ?? ''): PiInvocation {
  const found = which('pi', envPath);
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
    return { argv0: found, prefix: [] };
  }
  return { argv0: 'pi', prefix: [] };
}

/** Reviewer runs read-only at the TOOL level — no shell, no write tools. */
export const PI_REVIEW_TOOLS = ['read', 'grep', 'find', 'ls'];
const PI_ALL_TOOLS = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * argv for one non-interactive `pi -p` call. Ambient project/user config is
 * disabled so the worktree (or its contents) cannot inject tools, skills,
 * templates or context files into the run.
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
    '--no-approve',
    '--tools', (opts.tools ?? PI_ALL_TOOLS).join(','),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.thinking ? ['--thinking', opts.thinking] : []),
    '--',
    `@${opts.promptPath}`,
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
 * pi has no sandbox flag: confinement is the tool allowlist + scrubbed env.
 */
export async function runPi(
  opts: AgentCallOpts,
  config: AppConfig['agent'],
  invocation?: PiInvocation,
): Promise<AgentCallResult> {
  const inv = invocation ?? resolvePiInvocation();
  const promptPath = join(dirname(opts.lastMessagePath), `pi-prompt-${Date.now()}.txt`);
  writeFileSync(promptPath, opts.prompt, 'utf8');

  const argv = buildPiArgv(
    { tools: opts.tools, promptPath, model: opts.model ?? config.model, thinking: config.reasoning_effort },
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
