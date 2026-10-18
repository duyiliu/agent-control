import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { AppConfig, CheckSpec, ProjectConfig } from './types.js';

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(`config: ${msg}`);
}

function asObj(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${name} must be an object`);
  return v as Record<string, unknown>;
}

function asStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string`);
  return v;
}

function asNum(v: unknown, name: string, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${name} must be a number >= ${min}`);
  return v;
}

function asBool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(`${name} must be a boolean`);
  return v;
}

function parseCheck(v: unknown, name: string): CheckSpec {
  const o = asObj(v, name);
  const argv = o['argv'];
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    fail(`${name}.argv must be a non-empty string array`);
  }
  const spec: CheckSpec = { argv: argv as string[] };
  if (o['timeout_seconds'] !== undefined) {
    spec.timeout_seconds = asNum(o['timeout_seconds'], `${name}.timeout_seconds`, 1);
  }
  return spec;
}

function parseProject(v: unknown, idx: number): ProjectConfig {
  const name = `projects[${idx}]`;
  const o = asObj(v, name);
  const checksRaw = o['checks'] ?? [];
  if (!Array.isArray(checksRaw)) fail(`${name}.checks must be an array`);
  return {
    repo: asStr(o['repo'], `${name}.repo`),
    local_repo: resolve(asStr(o['local_repo'], `${name}.local_repo`)),
    base_branch: asStr(o['base_branch'] ?? 'main', `${name}.base_branch`),
    ready_label: asStr(o['ready_label'] ?? 'agent-ready', `${name}.ready_label`),
    branch_prefix: asStr(o['branch_prefix'] ?? 'agent/issue-', `${name}.branch_prefix`),
    checks: checksRaw.map((c, i) => parseCheck(c, `${name}.checks[${i}]`)),
  };
}

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf8');
  const doc = YAML.parse(raw) as unknown;
  const root = asObj(doc, 'root');

  const server = asObj(root['server'] ?? {}, 'server');
  const database = resolve(asStr(server['database'], 'server.database'));
  const logsDir = server['logs_dir'] !== undefined
    ? resolve(asStr(server['logs_dir'], 'server.logs_dir'))
    : resolve(dirname2(database), 'logs');

  const projectsRaw = root['projects'];
  if (!Array.isArray(projectsRaw) || projectsRaw.length === 0) {
    fail('projects must be a non-empty array');
  }

  const agent = asObj(root['agent'] ?? {}, 'agent');
  const provider = agent['provider'] ?? 'codex';
  if (provider !== 'codex' && provider !== 'pi' && provider !== 'claude') {
    fail('agent.provider: expected "codex", "pi" or "claude"');
  }
  const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
  const sandbox = agent['sandbox'] ?? 'danger-full-access';
  if (!sandboxModes.includes(sandbox as string)) {
    fail('agent.sandbox must be read-only, workspace-write or danger-full-access');
  }
  const reviewSandbox = agent['review_sandbox'] ?? 'danger-full-access';
  if (!sandboxModes.includes(reviewSandbox as string)) {
    fail('agent.review_sandbox must be read-only, workspace-write or danger-full-access');
  }
  const envDeny = agent['env_deny'] ?? [];
  if (!Array.isArray(envDeny) || envDeny.some((e) => typeof e !== 'string')) {
    fail('agent.env_deny must be a string array');
  }
  const claudeEnv = agent['claude_env'];
  if (claudeEnv !== undefined) {
    const o = asObj(claudeEnv, 'agent.claude_env');
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'string') fail(`agent.claude_env.${k} must be a string`);
    }
  }

  const approvals = asObj(root['approvals'] ?? {}, 'approvals');

  return {
    server: {
      poll_interval_seconds: asNum(server['poll_interval_seconds'] ?? 30, 'server.poll_interval_seconds', 1),
      max_concurrent: asNum(server['max_concurrent'] ?? 1, 'server.max_concurrent', 1),
      retry_limit: asNum(server['retry_limit'] ?? 3, 'server.retry_limit', 0),
      max_task_minutes: asNum(server['max_task_minutes'] ?? 45, 'server.max_task_minutes', 1),
      worktree_root: resolve(asStr(server['worktree_root'], 'server.worktree_root')),
      database,
      logs_dir: logsDir,
      cancel_poll_seconds: asNum(server['cancel_poll_seconds'] ?? 5, 'server.cancel_poll_seconds', 1),
    },
    projects: projectsRaw.map(parseProject),
    agent: {
      provider: provider as AppConfig['agent']['provider'],
      model: agent['model'] !== undefined ? asStr(agent['model'], 'agent.model') : undefined,
      sandbox: sandbox as AppConfig['agent']['sandbox'],
      review_sandbox: reviewSandbox as AppConfig['agent']['review_sandbox'],
      env_deny: envDeny as string[],
      claude_env: claudeEnv as Record<string, string> | undefined,
    },
    approvals: {
      require_design_approval: asBool(approvals['require_design_approval'] ?? true, 'approvals.require_design_approval'),
      require_manual_merge: asBool(approvals['require_manual_merge'] ?? true, 'approvals.require_manual_merge'),
      allow_auto_deploy: asBool(approvals['allow_auto_deploy'] ?? false, 'approvals.allow_auto_deploy'),
    },
  };
}

function dirname2(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}
