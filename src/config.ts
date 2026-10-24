import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { isMap, isSeq } from 'yaml';
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

function asNonNegInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(`${name} must be a non-negative integer`);
  return v;
}

function asBool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(`${name} must be a boolean`);
  return v;
}

function optStrArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${name} must be a non-empty string array`);
  }
  return v as string[];
}

const PLATFORMS: readonly NodeJS.Platform[] = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'];

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
  if (o['platforms'] !== undefined) {
    const raw = o['platforms'];
    if (!Array.isArray(raw) || raw.length === 0) {
      fail(`${name}.platforms must be a non-empty array of platform names`);
    }
    spec.platforms = raw.map((p, i) => {
      const platform = asStr(p, `${name}.platforms[${i}]`) as NodeJS.Platform;
      if (!PLATFORMS.includes(platform)) {
        fail(`${name}.platforms[${i}]: unknown platform ${platform} (expected one of ${PLATFORMS.join(', ')})`);
      }
      return platform;
    });
  }
  return spec;
}

function parseProject(v: unknown, idx: number | string): ProjectConfig {
  const name = `projects[${idx}]`;
  const o = asObj(v, name);
  const checksRaw = o['checks'] ?? [];
  if (!Array.isArray(checksRaw)) fail(`${name}.checks must be an array`);
  if (o['review'] !== undefined) fail(`${name}.review was removed — use review_mode: auto | manual`);
  const mode = o['review_mode'] ?? 'auto';
  if (mode !== 'auto' && mode !== 'manual') fail(`${name}.review_mode: expected auto or manual`);
  const prReview = o['pr_review'] ?? 'auto';
  if (prReview !== 'auto' && prReview !== 'manual') fail(`${name}.pr_review: expected auto or manual`);
  const triage = asObj(o['issue_triage'] ?? {}, `${name}.issue_triage`);
  const intake = o['issue_intake'];
  if (intake !== undefined && intake !== 'all' && intake !== 'labeled') fail(`${name}.issue_intake: expected all or labeled`);
  const humanPaths = o['human_review_paths'];
  if (humanPaths !== undefined && (!Array.isArray(humanPaths) || humanPaths.some(path => typeof path !== 'string' || !path.trim()))) {
    fail(`${name}.human_review_paths must be a string array`);
  }
  return {
    human_review_paths: humanPaths as string[] | undefined,
    issue_intake: intake as ProjectConfig['issue_intake'],
    repo: asStr(o['repo'], `${name}.repo`),
    local_repo: resolve(asStr(o['local_repo'], `${name}.local_repo`)),
    base_branch: asStr(o['base_branch'] ?? 'main', `${name}.base_branch`),
    git_remote: asStr(o['git_remote'] ?? 'origin', `${name}.git_remote`),
    ready_label: asStr(o['ready_label'] ?? 'agent-ready', `${name}.ready_label`),
    branch_prefix: asStr(o['branch_prefix'] ?? 'agent/issue-', `${name}.branch_prefix`),
    checks: checksRaw.map((c, i) => parseCheck(c, `${name}.checks[${i}]`)),
    review_mode: mode,
    pr_review: prReview,
    issue_triage: {
      enabled: asBool(triage['enabled'] ?? false, `${name}.issue_triage.enabled`),
      timeout_seconds: asNum(triage['timeout_seconds'] ?? 180, `${name}.issue_triage.timeout_seconds`, 1),
    },
    verify_build: o['verify_build'] !== undefined ? parseCheck(o['verify_build'], `${name}.verify_build`) : undefined,
    verify_bootstrap: o['verify_bootstrap'] !== undefined ? parseCheck(o['verify_bootstrap'], `${name}.verify_bootstrap`) : undefined,
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

  const uiRaw = asObj(server['ui'] ?? {}, 'server.ui');
  const uiHost = asStr(uiRaw['host'] ?? '127.0.0.1', 'server.ui.host');
  const uiEnabled = asBool(uiRaw['enabled'] ?? true, 'server.ui.enabled');
  const uiToken = uiRaw['token'] !== undefined ? asStr(uiRaw['token'], 'server.ui.token') : undefined;

  const projectsRaw = root['projects'];
  // An empty list is legitimate: the scheduler idles and projects are added
  // later through the UI (POST /api/projects writes back into this file).
  if (!Array.isArray(projectsRaw)) {
    fail('projects must be an array');
  }

  const agent = asObj(root['agent'] ?? {}, 'agent');
  const provider = agent['provider'] ?? 'pi';
  if (provider === 'codex') {
    fail('Codex support has been removed; set agent.provider to "pi" and configure agent.model with a Pi model from models.json');
  }
  if (provider !== 'pi') fail('agent.provider: only "pi" is supported');
  if (agent['review_provider'] !== undefined) {
    fail('agent.review_provider is no longer supported; Pi is used for both phases. Use review_model to select a different reviewer model');
  }
  if (agent['sandbox'] !== undefined || agent['review_sandbox'] !== undefined) {
    fail('legacy sandbox settings are no longer supported; Pi review confinement uses its read-only tool allowlist');
  }
  const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const effort = agent['reasoning_effort'];
  if (effort !== undefined && !efforts.includes(effort as string)) {
    fail(`agent.reasoning_effort: expected one of ${efforts.join('/')}`);
  }
  const complexEffort = agent['complex_reasoning_effort'];
  if (complexEffort !== undefined && !efforts.includes(complexEffort as string)) {
    fail(`agent.complex_reasoning_effort: expected one of ${efforts.join('/')}`);
  }
  const reviewEffort = agent['review_reasoning_effort'];
  if (reviewEffort !== undefined && !efforts.includes(reviewEffort as string)) {
    fail(`agent.review_reasoning_effort: expected one of ${efforts.join('/')}`);
  }
  const envDeny = agent['env_deny'] ?? [];
  if (!Array.isArray(envDeny) || envDeny.some((e) => typeof e !== 'string')) {
    fail('agent.env_deny must be a string array');
  }
  // Fail here rather than at spawn time: a wrong path would otherwise surface
  // as a mysterious run failure much later.
  const piPath = agent['pi_path'] !== undefined ? asStr(agent['pi_path'], 'agent.pi_path') : undefined;
  if (piPath !== undefined && !existsSync(piPath)) {
    fail(`agent.pi_path does not exist: ${piPath}`);
  }

  const approvals = asObj(root['approvals'] ?? {}, 'approvals');
  const autoMerge = asObj(approvals['auto_merge'] ?? {}, 'approvals.auto_merge');
  // These three were parsed but never enforced — approval is always the ready
  // label + issue hash, and merging is governed by review_mode + auto_merge.
  if (approvals['require_design_approval'] !== undefined) {
    fail('approvals.require_design_approval was removed — approval is always enforced by the ready label and the issue hash');
  }
  if (approvals['require_manual_merge'] !== undefined) {
    fail('approvals.require_manual_merge was removed — use projects[].review_mode (auto|manual) and approvals.auto_merge');
  }
  if (approvals['allow_auto_deploy'] !== undefined) {
    fail('approvals.allow_auto_deploy was removed — agent-control never deploys');
  }

  const projects = projectsRaw.map(parseProject);
  const reviewPolicy = asObj(root['review_policy'] ?? {}, 'review_policy');
  const policyVersion = reviewPolicy['version'] ?? 1;
  if (policyVersion !== 1 && policyVersion !== 2) fail('review_policy.version must be 1 or 2');
  const maxTaskMinutes = asNum(server['max_task_minutes'] ?? 45, 'server.max_task_minutes', 1);
  const timeoutMinutes = Math.min(asNum(reviewPolicy['timeout_minutes'] ?? 10, 'review_policy.timeout_minutes', 1), maxTaskMinutes);
  const normalizedUiHost = uiHost.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackUi = normalizedUiHost === 'localhost' || normalizedUiHost === '::1'
    || normalizedUiHost === '::ffff:127.0.0.1' || isIP(normalizedUiHost) === 4 && normalizedUiHost.split('.')[0] === '127';
  if (uiEnabled && projects.some(p => p.issue_intake === 'all' || p.issue_intake === undefined && p.issue_triage?.enabled) && !loopbackUi && !uiToken) {
    fail('server.ui.token is required when Issue triage is enabled on a non-loopback UI host');
  }

  return {
    review_policy: { version: policyVersion, timeout_minutes: timeoutMinutes },
    server: {
      poll_interval_seconds: asNum(server['poll_interval_seconds'] ?? 30, 'server.poll_interval_seconds', 1),
      max_concurrent: asNum(server['max_concurrent'] ?? 1, 'server.max_concurrent', 1),
      retry_limit: asNum(server['retry_limit'] ?? 3, 'server.retry_limit', 0),
      max_resumes: asNonNegInt(server['max_resumes'] ?? 2, 'server.max_resumes'),
      max_task_minutes: asNum(server['max_task_minutes'] ?? 45, 'server.max_task_minutes', 1),
      worktree_root: resolve(asStr(server['worktree_root'], 'server.worktree_root')),
      database,
      logs_dir: logsDir,
      cancel_poll_seconds: asNum(server['cancel_poll_seconds'] ?? 5, 'server.cancel_poll_seconds', 1),
      ui: {
        enabled: uiEnabled,
        host: uiHost,
        port: asNum(uiRaw['port'] ?? 8787, 'server.ui.port', 1),
        token: uiToken,
      },
    },
    projects,
    agent: {
      provider: 'pi',
      model: asStr(agent['model'], 'agent.model'),
      reasoning_effort: effort as AppConfig['agent']['reasoning_effort'],
      complex_model: agent['complex_model'] !== undefined ? asStr(agent['complex_model'], 'agent.complex_model') : undefined,
      complex_reasoning_effort: complexEffort as AppConfig['agent']['complex_reasoning_effort'],
      review_model: agent['review_model'] !== undefined ? asStr(agent['review_model'], 'agent.review_model') : undefined,
      review_reasoning_effort: reviewEffort as AppConfig['agent']['review_reasoning_effort'],
      env_deny: envDeny as string[],
      pi_path: piPath,
    },
    approvals: {
      auto_merge: {
        enabled: asBool(autoMerge['enabled'] ?? false, 'approvals.auto_merge.enabled'),
        max_files: asNum(autoMerge['max_files'] ?? 10, 'approvals.auto_merge.max_files', 1),
        max_lines: asNum(autoMerge['max_lines'] ?? 400, 'approvals.auto_merge.max_lines', 1),
        generated_paths: optStrArray(autoMerge['generated_paths'], 'approvals.auto_merge.generated_paths'),
        doc_paths: optStrArray(autoMerge['doc_paths'], 'approvals.auto_merge.doc_paths'),
        verify_build: autoMerge['verify_build'] !== undefined
          ? parseCheck(autoMerge['verify_build'], 'approvals.auto_merge.verify_build')
          : undefined,
        verify_bootstrap: autoMerge['verify_bootstrap'] !== undefined
          ? parseCheck(autoMerge['verify_bootstrap'], 'approvals.auto_merge.verify_bootstrap')
          : undefined,
      },
    },
  };
}

function dirname2(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

/** Validate a UI/CLI-supplied project object without touching the file. */
export function validateProject(v: unknown): ProjectConfig {
  return parseProject(v, 'new');
}

/**
 * Append a project to the config file and return the freshly parsed config.
 * The YAML Document API preserves comments and formatting everywhere else.
 * Validation runs before any write; if the re-parse somehow fails the
 * original bytes are restored.
 */
export function appendProjectToConfigFile(configPath: string, raw: unknown): AppConfig {
  validateProject(raw);
  const before = readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(before);
  const projects = doc.get('projects', true);
  if (!isSeq(projects)) fail('projects must be a sequence');
  // `projects: []` parses as a flow seq — appending would otherwise render
  // the whole list inline instead of the file's block style.
  projects.flow = false;
  const node = doc.createNode(raw);
  if (isMap(node)) {
    const checks = node.get('checks', true);
    if (isSeq(checks)) {
      for (const c of checks.items) {
        // Flow `[a, b]` argv keeps the file consistent with hand-written entries.
        const argv = isMap(c) ? c.get('argv', true) : undefined;
        if (isSeq(argv)) argv.flow = true;
      }
    }
  }
  projects.add(node);
  const tmp = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, doc.toString(), 'utf8');
    renameSync(tmp, configPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    return loadConfig(configPath);
  } catch (err) {
    writeFileSync(configPath, before, 'utf8');
    throw err;
  }
}
