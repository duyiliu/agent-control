import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProc, scrubEnvForAgent, which } from '../proc.js';
import type { AppConfig } from '../types.js';
import type { CodexCallOpts, CodexCallResult } from './codex.js';

export interface ClaudeInvocation {
  argv0: string;
  prefix: string[];
}

/**
 * `claude.cmd` wraps a bundled claude.exe (not a JS entrypoint like codex/pi)
 * — resolve it so spawn never needs a shell.
 */
export function resolveClaudeInvocation(envPath = process.env.PATH ?? ''): ClaudeInvocation {
  const found = which('claude', envPath);
  if (found) {
    if (found.toLowerCase().endsWith('.cmd') || found.toLowerCase().endsWith('.bat')) {
      const exe = join(
        dirname(found),
        'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
      );
      if (existsSync(exe)) return { argv0: exe, prefix: [] };
      const comspec = process.env.ComSpec ?? 'cmd.exe';
      return { argv0: comspec, prefix: ['/d', '/s', '/c', found] };
    }
    return { argv0: found, prefix: [] };
  }
  return { argv0: 'claude', prefix: [] };
}

/** Reviewer runs read-only at the TOOL level — no shell, no write tools. */
export const CLAUDE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

/** Shared empty MCP config — ambient user MCP servers must not leak into runs. */
let emptyMcp: string | null = null;
function emptyMcpPath(): string {
  if (!emptyMcp) {
    emptyMcp = join(tmpdir(), 'agent-control-empty-mcp.json');
    writeFileSync(emptyMcp, '{"mcpServers":{}}', 'utf8');
  }
  return emptyMcp;
}

/**
 * argv for one non-interactive `claude -p` call:
 * - stream-json + verbose → full event evidence (incl. result envelope)
 * - --strict-mcp-config + empty mcp file → ambient MCP servers are off
 * - --dangerously-skip-permissions → unattended tool use; confinement is
 *   still the --tools allowlist + scrubbed env, same as the other runners
 * - prompt via stdin (runProc closes it — an open stdin hangs -p)
 */
export function buildClaudeArgv(
  opts: Pick<CodexCallOpts, 'tools'> & { model?: string; settingsPath?: string; schemaJson?: string },
  inv: ClaudeInvocation,
): string[] {
  return [
    inv.argv0,
    ...inv.prefix,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--mcp-config', emptyMcpPath(),
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    ...(opts.tools ? ['--tools', opts.tools.join(',')] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.settingsPath ? ['--settings', opts.settingsPath] : []),
    ...(opts.schemaJson ? ['--json-schema', opts.schemaJson] : []),
    '--',
  ];
}

/**
 * The stream-json tail ends with the result envelope
 * ({"type":"result",...}). Prefer structured_output (--json-schema),
 * fall back to the result text.
 */
export function extractResult(logText: string): string | null {
  for (const line of logText.split('\n').reverse()) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; result?: string; structured_output?: unknown };
      if (ev.type !== 'result') continue;
      if (ev.structured_output !== undefined && ev.structured_output !== null) {
        return JSON.stringify(ev.structured_output);
      }
      return typeof ev.result === 'string' ? ev.result : null;
    } catch { /* try the next candidate line */ }
  }
  return null;
}

/**
 * One isolated `claude -p` invocation. `agent.claude_env` (optional) is
 * materialized as a --settings env block, which outranks the user's
 * ~/.claude/settings.json env — needed when ambient auth config is wrong
 * for unattended runs.
 */
export async function runClaude(
  opts: CodexCallOpts,
  config: AppConfig['agent'],
  invocation?: ClaudeInvocation,
): Promise<CodexCallResult> {
  const inv = invocation ?? resolveClaudeInvocation();
  let settingsPath: string | undefined;
  if (config.claude_env && Object.keys(config.claude_env).length > 0) {
    settingsPath = join(dirname(opts.lastMessagePath), 'claude-settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ env: config.claude_env }), 'utf8');
  }
  const schemaJson = opts.schemaPath && existsSync(opts.schemaPath)
    ? readFileSync(opts.schemaPath, 'utf8')
    : undefined;

  const argv = buildClaudeArgv(
    {
      tools: opts.tools,
      model: opts.model ?? config.model,
      settingsPath,
      schemaJson,
    },
    inv,
  );
  const env = scrubEnvForAgent(process.env, config.env_deny);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

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

  const logText = opts.logPath && existsSync(opts.logPath)
    ? readFileSync(opts.logPath, 'utf8')
    : res.stdoutTail;
  const result = extractResult(logText);
  if (result !== null) writeFileSync(opts.lastMessagePath, result, 'utf8');
  return { ...res, pid: capturedPid };
}
