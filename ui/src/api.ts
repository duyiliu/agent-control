export type Phase =
  | 'DISCOVERED'
  | 'CLAIMED'
  | 'PREPARING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'FIXING'
  | 'PUBLISHING_PR'
  | 'AWAITING_MERGE'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'BLOCKED_APPROVAL_CHANGED'
  | 'FAILED'
  | 'CANCELED'
  | 'RECOVERY_REQUIRED';

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

export interface CheckRow {
  id: number;
  kind: string;
  command: string;
  exit_code: number | null;
  artifact_path: string | null;
  verdict: string;
}

export interface RunDetail {
  run_id: string;
  attempt: number;
  phase: Phase;
  fix_count: number;
  resume_count: number;
  cancel_requested: number;
  pid: number | null;
  branch: string | null;
  pr_url: string | null;
  reason: string | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  events: { id: number; at: string; from_phase: string | null; to_phase: string; detail_json: string | null }[];
  checks: CheckRow[];
}

export interface TaskDetail {
  task: TaskSummary & {
    approved_hash: string | null;
    branch: string | null;
  };
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

export interface Artifact {
  name: string;
  kind: 'jsonl' | 'text';
  truncated: boolean;
  content?: string;
  lines?: Record<string, unknown>[];
}

export interface TailChunk {
  file: string;
  size: number;
  offset: number;
  chunk: string;
  pending: number;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchTasks = () => get<{ tasks: TaskSummary[] }>('/api/tasks');
export const fetchTask = (id: number) => get<TaskDetail>(`/api/tasks/${id}`);
export const fetchHealth = () => get<HealthInfo>('/api/health');
export const fetchArtifact = (path: string) =>
  get<Artifact>(`/api/artifact?path=${encodeURIComponent(path)}`);
export const fetchTail = (runId: string, offset: number | null, file: string | null) => {
  const params = new URLSearchParams();
  if (offset !== null) params.set('offset', String(offset));
  if (file) params.set('file', file);
  return get<TailChunk>(`/api/runs/${encodeURIComponent(runId)}/tail?${params}`);
};

export async function postAction(id: number, action: 'stop' | 'retry'): Promise<string> {
  const r = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST' });
  const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d.message ?? 'done';
}
