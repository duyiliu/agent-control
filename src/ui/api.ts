import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
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
    const agentLogs = names
      .filter((n) => /^agent-[\w.-]+\.jsonl$/.test(n))
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
