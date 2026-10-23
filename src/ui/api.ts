import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Store } from '../store/sqlite.js';
import type { AppConfig, CheckResultRow, Phase, ProjectConfig, RunRow, TaskRow, TaskSource } from '../types.js';
import type { OpsTracker } from '../ops.js';
import { appendProjectToConfigFile, ConfigError } from '../config.js';
import { runProc } from '../proc.js';
import { SYSTEM_LABELS } from '../tracker/github.js';

export interface TaskSummary {
  id: number;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  /** 'pr' means the number is a PR, not an issue — the UI must not show it as one. */
  source: TaskSource;
  status: Phase;
  pr_url: string | null;
  fix_rounds: number;
  updated_at: string;
  created_at: string;
  active_run: { run_id: string; attempt: number; phase: Phase; started_at: string } | null;
  last_run: { attempt: number; phase: Phase } | null;
}

export interface RunDetail extends RunRow {
  events: { id: number; at: string; from_phase: string | null; to_phase: string; detail_json: string | null }[];
  checks: CheckResultRow[];
}

export interface TaskDetail {
  task: TaskRow;
  runs: RunDetail[];
  has_active_run: boolean;
  retryable: boolean;
}

export interface HealthInfo {
  pid: number;
  uptime_s: number;
  poll_interval_seconds: number;
  active_runs_in_process: number;
  active_runs: { run_id: string; task_id: number; kind: string; phase: Phase; heartbeat_at: string }[];
  last_error: { at: string; kind: string; error: string } | null;
}

export interface UiDeps {
  store: Store;
  config: AppConfig;
  activeCount(): number;
  tracker: OpsTracker;
  /** Set when the service knows which file it loaded; absent in tests →
   *  POST /api/projects reports itself as read-only. */
  configPath?: string;
  /** Optional remote validation (gh repo view); absent → skipped. */
  checkRepoExists?: (repo: string) => Promise<void>;
  /** Optional canonical-name resolution (follows rename redirects). */
  resolveRepo?: (repo: string) => Promise<string>;
  /** Optional label provisioning; returns warnings. */
  provisionRepo?: (repo: string, readyLabel: string) => Promise<string[]>;
}

export interface ProjectInfo {
  repo: string;
  local_repo: string;
  base_branch: string;
  git_remote: string;
  ready_label: string;
  branch_prefix: string;
  review_mode: 'auto' | 'manual';
  pr_review: 'auto' | 'manual';
  checks: { argv: string[]; timeout_seconds?: number; platforms?: string[] }[];
}

export function projectsPayload(deps: UiDeps): { projects: ProjectInfo[]; config_path: string | null; editable: boolean } {
  return {
    config_path: deps.configPath ?? null,
    editable: deps.configPath !== undefined,
    projects: deps.config.projects.map((p) => ({
      repo: p.repo,
      local_repo: p.local_repo,
      base_branch: p.base_branch,
      git_remote: p.git_remote,
      ready_label: p.ready_label,
      branch_prefix: p.branch_prefix,
      review_mode: p.review_mode,
      pr_review: p.pr_review,
      checks: p.checks.map((c) => ({ argv: c.argv, timeout_seconds: c.timeout_seconds, platforms: c.platforms })),
    })),
  };
}

const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** git@github.com:o/n.git, https://github.com/o/n(.git), ssh://git@github.com/o/n */
const GITHUB_REMOTE = /github\.com[:/]+([A-Za-z0-9._-]+)\/+([A-Za-z0-9._-]+?)(?:\.git)?\s*$/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * `git remote get-url <remote>` cross-check: when it resolves to a GitHub
 * owner/name that disagrees with the requested repo, the local path was
 * almost certainly mis-typed — refuse, unless gh resolves the remote's repo
 * to the same canonical name (the URL survives a repo rename). Anything
 * inconclusive is a warning.
 */
async function checkRemote(
  deps: UiDeps, localRepo: string, remote: string, repo: string, warnings: string[],
): Promise<{ reject?: string; missing?: string }> {
  const res = await runProc({
    argv: ['git', '-C', localRepo, 'remote', 'get-url', remote],
    timeoutMs: 15_000,
    streamStdoutToLog: false,
  });
  if (res.exitCode !== 0) {
    return { missing: res.spawnError ?? (res.stderrTail.trim() || `no ${remote}`) };
  }
  const url = res.stdoutTail.trim();
  const m = GITHUB_REMOTE.exec(url);
  if (!m) {
    warnings.push(`${remote} 不是可识别的 GitHub 地址（${url.slice(0, 120)}），未能确认归属`);
    return {};
  }
  const actual = `${m[1]}/${m[2]}`;
  if (actual.toLowerCase() === repo.toLowerCase()) return {};
  const canonical = deps.resolveRepo ? await deps.resolveRepo(actual).catch(() => null) : null;
  if (canonical && canonical.toLowerCase() === repo.toLowerCase()) {
    warnings.push(`${remote} 指向 ${actual}，GitHub 重定向到 ${canonical}，归属一致`);
    return {};
  }
  return { reject: canonical ? `${actual}（解析为 ${canonical}）` : actual };
}

/**
 * POST /api/projects: validate → append to the yaml (comments preserved) →
 * splice the re-parsed list into the live config so the next tick picks the
 * project up without a restart → best-effort label provisioning.
 */
export async function addProjectPayload(
  deps: UiDeps,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = (status: number, error: string) => ({ status, body: { error } });
  if (!deps.configPath) return err(400, '配置文件路径未知，无法写入；请手动编辑 yaml 后重启');
  const o = asRecord(body);
  if (!o) return err(400, 'request body must be a JSON object');

  const repo = optStr(o, 'repo');
  if (!repo || !REPO_NAME.test(repo)) return err(400, 'repo 必须是 owner/name 形式');
  if (deps.config.projects.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) {
    return err(409, `项目 ${repo} 已在配置中`);
  }

  const localRepo = optStr(o, 'local_repo');
  if (!localRepo) return err(400, 'local_repo 必填：本机已 clone 的仓库路径');
  if (!existsSync(localRepo)) return err(400, `local_repo 不存在：${localRepo}`);
  if (!existsSync(join(localRepo, '.git'))) return err(400, `${localRepo} 不是 git 仓库（缺少 .git）`);

  const gitRemote = optStr(o, 'git_remote') ?? 'origin';
  if (!/^\S+$/.test(gitRemote)) return err(400, 'git_remote 不能包含空白字符');
  for (const key of ['base_branch', 'ready_label', 'branch_prefix']) {
    if (o[key] !== undefined && optStr(o, key) === undefined) return err(400, `${key} 不能为空`);
  }
  for (const key of ['review_mode', 'pr_review']) {
    const v = optStr(o, key);
    if (v !== undefined && v !== 'auto' && v !== 'manual') return err(400, `${key} 只能是 auto 或 manual`);
  }
  if (o['checks'] !== undefined && !Array.isArray(o['checks'])) return err(400, 'checks 必须是数组');

  const warnings: string[] = [];
  const remoteCheck = await checkRemote(deps, localRepo, gitRemote, repo, warnings);
  if (remoteCheck.reject) {
    return err(400, `local_repo 的 ${gitRemote} 指向 ${remoteCheck.reject}，与 ${repo} 不一致`);
  }
  if (remoteCheck.missing !== undefined) {
    if (gitRemote !== 'origin') {
      return err(400, `local_repo 没有 ${gitRemote} remote——调度器的 push/fetch 使用配置的 remote`);
    }
    if (remoteCheck.missing === 'no origin') {
      warnings.push('local_repo 没有 origin remote，无法确认它确实属于该 GitHub 仓库');
    } else {
      warnings.push(`无法读取 origin remote：${remoteCheck.missing.slice(0, 160)}`);
    }
  }

  if (deps.checkRepoExists) {
    try {
      await deps.checkRepoExists(repo);
    } catch (e) {
      return err(400, `GitHub 校验失败（gh repo view ${repo}）：${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  }

  const raw: Record<string, unknown> = {
    repo,
    local_repo: localRepo,
    base_branch: optStr(o, 'base_branch') ?? 'main',
    git_remote: gitRemote,
    ready_label: optStr(o, 'ready_label') ?? 'agent-ready',
    branch_prefix: optStr(o, 'branch_prefix') ?? 'agent/issue-',
    review_mode: optStr(o, 'review_mode') ?? 'auto',
    pr_review: optStr(o, 'pr_review') ?? 'auto',
  };
  if (Array.isArray(o['checks']) && o['checks'].length > 0) raw['checks'] = o['checks'];

  let fresh: AppConfig;
  try {
    fresh = appendProjectToConfigFile(deps.configPath, raw);
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : `写入配置文件失败：${String(e).slice(0, 200)}`;
    return err(e instanceof ConfigError ? 400 : 500, msg);
  }
  // Splice (not replace) so the reference the engine holds stays live.
  deps.config.projects.splice(0, deps.config.projects.length, ...fresh.projects);
  const project: ProjectConfig | undefined = fresh.projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase());

  if (deps.provisionRepo) {
    try {
      warnings.push(...await deps.provisionRepo(repo, project?.ready_label ?? 'agent-ready'));
    } catch (e) {
      warnings.push(`标签准备失败：${String(e).slice(0, 160)}`);
    }
  } else {
    warnings.push(`请确认 ${repo} 存在标签：${SYSTEM_LABELS.join(', ')}（ac doctor 可检查）`);
  }

  return {
    status: 200,
    body: {
      message: `已添加 ${repo}，下一个调度周期开始扫描；配置已写入 ${deps.configPath}`,
      warnings,
      project,
    },
  };
}

const RED_PHASES: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'];

export function tasksPayload(store: Store): { tasks: TaskSummary[] } {
  return {
    tasks: store.listTasks().map((t) => {
      const runs = store.runsForTask(t.id);
      const active = store.activeRunForTask(t.id);
      const last = runs[runs.length - 1];
      return {
        id: t.id,
        repo: t.repo,
        issue_number: t.issue_number,
        issue_title: t.issue_title,
        issue_url: t.issue_url,
        source: t.source,
        status: t.status,
        pr_url: t.pr_url,
        fix_rounds: t.fix_rounds,
        updated_at: t.updated_at,
        created_at: t.created_at,
        active_run: active
          ? { run_id: active.run_id, attempt: active.attempt, phase: active.phase, started_at: active.started_at }
          : null,
        last_run: last && !active ? { attempt: last.attempt, phase: last.phase } : null,
      };
    }),
  };
}

export function taskPayload(store: Store, id: number): TaskDetail | null {
  const task = store.getTaskById(id);
  if (!task) return null;
  const runs: RunDetail[] = store.runsForTask(id).map((r) => ({
    ...r,
    events: store.eventsForRun(r.run_id),
    checks: store.checksForRun(r.run_id),
  }));
  return {
    task,
    runs,
    has_active_run: store.activeRunForTask(id) !== null,
    retryable: [...RED_PHASES, 'CANCELED'].includes(task.status),
  };
}

export function healthPayload(deps: UiDeps): HealthInfo {
  const { store } = deps;
  let lastError: HealthInfo['last_error'] = null;
  const raw = store.getMeta('last_error');
  if (raw) {
    try {
      const e = JSON.parse(raw) as { at: string; kind: string; error: string };
      lastError = { at: e.at, kind: e.kind, error: e.error };
    } catch { /* raw non-JSON meta — ignore */ }
  }
  return {
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    poll_interval_seconds: deps.config.server.poll_interval_seconds,
    active_runs_in_process: deps.activeCount(),
    active_runs: store.activeRuns().map((r) => ({
      run_id: r.run_id, task_id: r.task_id, kind: r.kind, phase: r.phase, heartbeat_at: r.heartbeat_at,
    })),
    last_error: lastError,
  };
}

const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_TAIL_CHUNK = 128 * 1024;
/** First poll may pull a wider window so the panel is not empty on open. */
const INITIAL_TAIL_BYTES = 1024 * 1024;
/** Upper bound for skipping one oversized JSONL record (pi's system prompt). */
const MAX_LINE_SCAN = 16 * 1024 * 1024;

/**
 * Artifact paths come from the DB; resolve them strictly inside logs_dir —
 * an absolute path outside it (or a ../ traversal) must not be readable.
 * A bare name like "run-<id>.jsonl" is treated as logs_dir-relative.
 */
export function artifactPayload(
  logsDir: string,
  rawPath: string,
): { status: number; body: Record<string, unknown> } {
  const root = resolve(logsDir);
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(root, rawPath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { status: 403, body: { error: 'path outside logs_dir' } };
  }
  let content: string;
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return { status: 404, body: { error: 'not a file' } };
    content = readFileSync(candidate, 'utf8');
  } catch {
    return { status: 404, body: { error: `no artifact at ${rawPath}` } };
  }
  const truncated = Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES;
  if (truncated) content = content.slice(0, MAX_ARTIFACT_BYTES);
  const name = candidate.split(/[\\/]/).pop() ?? candidate;
  if (candidate.endsWith('.jsonl')) {
    const lines: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        lines.push(JSON.parse(s) as Record<string, unknown>);
      } catch {
        lines.push({ unparsed: s });
      }
    }
    return { status: 200, body: { name, kind: 'jsonl', truncated, lines } };
  }
  return { status: 200, body: { name, kind: 'text', truncated, content } };
}

/**
 * Incremental read of a run's agent log for the live view. The client passes
 * the byte offset it already consumed; we answer with whole lines only, so a
 * half-written JSONL record is never handed out.
 */
export function tailPayload(
  logsDir: string,
  runId: string,
  rawFile: string | null,
  rawOffset: string | null,
): { status: number; body: Record<string, unknown> } {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return { status: 400, body: { error: 'bad run id' } };
  const root = resolve(logsDir);
  const dir = resolve(join(root, 'artifacts', runId));
  if (!dir.startsWith(root + sep)) return { status: 403, body: { error: 'path outside logs_dir' } };

  let file: string;
  if (rawFile) {
    const base = rawFile.split(/[\\/]/).pop() ?? '';
    if (!/^(?:agent|review-agent)-[\w.-]+\.jsonl$/.test(base)) {
      return { status: 400, body: { error: 'not an agent log' } };
    }
    file = join(dir, base);
  } else {
    let names: string[];
    try { names = readdirSync(dir); } catch { return { status: 404, body: { error: 'no artifacts for run' } }; }
    // Follow whichever log is being written now: the coder log during
    // RUNNING/FIXING, the reviewer log during REVIEWING.
    const agentLogs = names
      .filter((n) => /^(?:agent|review-agent)-[\w.-]+\.jsonl$/.test(n))
      .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (agentLogs.length === 0) return { status: 404, body: { error: 'no agent log yet' } };
    file = join(dir, agentLogs[0]!.n);
  }

  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { status: 404, body: { error: 'not a file' } };
    size = st.size;
  } catch {
    return { status: 404, body: { error: 'log disappeared' } };
  }

  let start: number;
  const initial = rawOffset == null;
  if (initial) {
    // First poll: tail the file instead of replaying megabytes of history.
    start = Math.max(0, size - INITIAL_TAIL_BYTES);
    if (start > 0 && start < size) {
      // Align to the next line boundary so the first record is not a fragment.
      const fd = openSync(file, 'r');
      try {
        const probe = Buffer.alloc(Math.min(8192, size - start));
        readSync(fd, probe, 0, probe.length, start);
        const nl = probe.indexOf(0x0a);
        if (nl >= 0) start += nl + 1;
      } finally { closeSync(fd); }
    }
  } else {
    const asked = Number(rawOffset);
    start = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
    if (start > size) start = 0; // rotated or truncated file
  }
  const window = initial ? INITIAL_TAIL_BYTES : MAX_TAIL_CHUNK;

  const readAt = (from: number, len: number): Buffer => {
    const buf = Buffer.alloc(Math.max(0, len));
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
    return buf;
  };

  let skipped = 0;
  let buf = readAt(start, Math.min(window, size - start));
  let lastLf = buf.lastIndexOf(0x0a);
  // A single record can dwarf the window (pi echoes the whole system prompt in
  // one message_start line, several MB). Skipping it beats stalling the view.
  if (lastLf < 0 && start + buf.length < size) {
    const scan = readAt(start, Math.min(MAX_LINE_SCAN, size - start));
    const lf = scan.indexOf(0x0a);
    if (lf >= 0) {
      skipped = lf + 1;
      start += skipped;
      buf = readAt(start, Math.min(window, size - start));
      lastLf = buf.lastIndexOf(0x0a);
    } else {
      skipped = scan.length;
      start += skipped;
      buf = Buffer.alloc(0);
      lastLf = -1;
    }
  }
  // Never return a partial trailing line: everything after the last LF waits
  // for the next poll. (A caller that starts mid-record may receive one
  // fragment; clients skip lines that fail to parse.)
  const usable = lastLf >= 0 ? buf.subarray(0, lastLf + 1) : Buffer.alloc(0);
  const consumed = start + usable.length;
  return {
    status: 200,
    body: {
      file: file.split(/[\\/]/).pop(),
      size,
      offset: consumed,
      chunk: usable.toString('utf8'),
      pending: size - consumed,
      skipped,
    },
  };
}
