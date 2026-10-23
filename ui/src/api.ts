export type Phase =
  | 'DISCOVERED'
  | 'CLAIMED'
  | 'PREPARING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'FIXING'
  | 'PUBLISHING_PR'
  | 'AWAITING_REVIEW'
  | 'AWAITING_HUMAN'
  | 'MERGING'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'BLOCKED_APPROVAL_CHANGED'
  | 'FAILED'
  | 'CANCELED'
  | 'RECOVERY_REQUIRED';

export type TaskSource = 'issue' | 'pr';

export interface IntakeState {
  external_hold?: boolean; external_needs?: boolean;
  kind: 'human' | 'deferred' | 'skipped' | null; reason: string; locked: boolean; defer_until: string | null;
  version: number; updated_at: string; pending: { remove: string[]; retry: boolean } | null; error: string | null; imported: boolean;
}

export interface TaskSummary {
  intake?: IntakeState | null;
  id: number;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  source: TaskSource;
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

export interface ProjectInfo {
  issue_intake: 'all' | 'labeled';
  issue_triage: { enabled: boolean; timeout_seconds: number };
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

export interface ProjectsPayload {
  projects: ProjectInfo[];
  config_path: string | null;
  editable: boolean;
}

export interface NewProjectInput {
  issue_intake?: 'all' | 'labeled';
  issue_triage?: { enabled: boolean; timeout_seconds?: number };
  repo: string;
  local_repo: string;
  base_branch?: string;
  git_remote?: string;
  ready_label?: string;
  branch_prefix?: string;
  review_mode?: 'auto' | 'manual';
  pr_review?: 'auto' | 'manual';
  checks?: { argv: string[]; timeout_seconds?: number }[];
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
export interface TriageHistory {
  generation: number; decision: string; reason_code: string; at: string;
}
export interface TriageItem {
  repo: string;
  issue: { number: number; title: string; body: string; url: string; labels: string[]; createdAt?: string; updatedAt?: string };
  status: 'pending' | 'evaluating' | 'human' | 'deferred' | 'skipped' | 'routed';
  locked: boolean; error: string | null; claim_id: string | null; comment_id: number | null; observed_at: string;
  state: { decision: string | null; reason_code: string; at: string; base_sha: string | null; defer_until: string | null; history: TriageHistory[] } | null;
}
export interface TriagePayload { issues: TriageItem[]; projects: { repo: string; enabled: boolean }[] }
export type TriageAction = 'sync' | 'approve' | 'defer' | 'reevaluate' | 'lock' | 'unlock' | 'recover' | 'reset' | 'release-claim';
export const fetchTriage = () => get<TriagePayload>('/api/triage');
export async function actOnTriage(repo: string, number: number, action: TriageAction, params: Record<string, unknown> = {}): Promise<{ message: string; state: IntakeState }> {
  const r = await fetch('/api/triage/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, number, action, ...params }) });
  const d = await r.json() as { error?: string; message?: string; state: IntakeState };
  if (!r.ok) throw Object.assign(new Error(d.error ?? `HTTP ${r.status}`), { state: d.state });
  return { message: d.message ?? '已保存', state: d.state };
}
export const fetchProjects = () => get<ProjectsPayload>('/api/projects');

export async function addProject(input: NewProjectInput): Promise<{ message: string; warnings: string[] }> {
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const d = (await r.json().catch(() => ({}))) as { message?: string; warnings?: string[]; error?: string };
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return { message: d.message ?? 'done', warnings: d.warnings ?? [] };
}

export const fetchArtifact = (path: string) =>
  get<Artifact>(`/api/artifact?path=${encodeURIComponent(path)}`);
export const fetchTail = (runId: string, offset: number | null, file: string | null) => {
  const params = new URLSearchParams();
  if (offset !== null) params.set('offset', String(offset));
  if (file) params.set('file', file);
  return get<TailChunk>(`/api/runs/${encodeURIComponent(runId)}/tail?${params}`);
};

export async function postAction(id: number, action: 'stop' | 'retry' | 'approve-merge'): Promise<string> {
  const r = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST' });
  const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d.message ?? 'done';
}
