import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Store } from '../store/sqlite.js';
import type { AppConfig, CheckResultRow, Phase, RunRow, TaskRow } from '../types.js';
import type { OpsTracker } from '../ops.js';

export interface TaskSummary {
  id: number;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
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
  active_runs: { run_id: string; task_id: number; phase: Phase; heartbeat_at: string }[];
  last_error: { at: string; kind: string; error: string } | null;
}

export interface UiDeps {
  store: Store;
  config: AppConfig;
  activeCount(): number;
  tracker: OpsTracker;
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
      run_id: r.run_id, task_id: r.task_id, phase: r.phase, heartbeat_at: r.heartbeat_at,
    })),
    last_error: lastError,
  };
}

const MAX_ARTIFACT_BYTES = 256 * 1024;

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
