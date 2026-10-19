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

/** Runs in these phases hold the per-task active-run slot. */
export const RUN_ACTIVE_PHASES: readonly Phase[] = [
  'CLAIMED',
  'PREPARING',
  'RUNNING',
  'VERIFYING',
  'FIXING',
  'REVIEWING',
  'PUBLISHING_PR',
];

/** Run phases where the attempt has ended (waiting on human counts as ended). */
export const RUN_INACTIVE_PHASES: readonly Phase[] = [
  'AWAITING_MERGE',
  'COMPLETED',
  'BLOCKED',
  'BLOCKED_APPROVAL_CHANGED',
  'FAILED',
  'CANCELED',
  'RECOVERY_REQUIRED',
];

/** Task-level statuses eligible for dispatch. */
export const DISPATCHABLE_TASK_STATUS: readonly Phase[] = ['DISCOVERED'];

export interface CheckSpec {
  argv: string[];
  timeout_seconds?: number;
}

export interface ProjectConfig {
  repo: string;
  local_repo: string;
  base_branch: string;
  ready_label: string;
  branch_prefix: string;
  checks: CheckSpec[];
}

export interface AppConfig {
  server: {
    poll_interval_seconds: number;
    max_concurrent: number;
    retry_limit: number;
    max_task_minutes: number;
    worktree_root: string;
    database: string;
    logs_dir: string;
    cancel_poll_seconds: number;
    ui: UiConfig;
  };
  projects: ProjectConfig[];
  agent: {
    provider: 'pi' | 'codex';
    /** pi: "<provider>/<model id>" (models.json); codex: `-m` model name. */
    model: string;
    /** Optional thinking level — pi `--thinking`, codex `model_reasoning_effort`. */
    reasoning_effort?: ReasoningEffort;
    /** Review phase overrides; fall back to provider/model/reasoning_effort. */
    review_provider?: 'pi' | 'codex';
    review_model?: string;
    review_reasoning_effort?: ReasoningEffort;
    /** codex only: `-s` confinement for coder / reviewer. pi ignores these. */
    sandbox: SandboxMode;
    review_sandbox: SandboxMode;
    env_deny: string[];
  };
  approvals: {
    require_design_approval: boolean;
    require_manual_merge: boolean;
    allow_auto_deploy: boolean;
  };
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Embedded web UI. Loopback-only by default — it can stop/retry tasks. */
export interface UiConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/** Union across runners — pi accepts all; codex maps to model_reasoning_effort. */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  url: string;
  updatedAt?: string;
}

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
}

export interface TaskRow {
  id: number;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  approved_hash: string | null;
  status: Phase;
  branch: string | null;
  pr_url: string | null;
  fix_rounds: number;
  updated_at: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  run_id: string;
  task_id: number;
  attempt: number;
  phase: Phase;
  return_phase: Phase | null;
  resume_count: number;
  fix_count: number;
  cancel_requested: number;
  pid: number | null;
  process_identity: string | null;
  workspace: string | null;
  branch: string | null;
  pr_url: string | null;
  reason: string | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
}

export interface CheckResultRow {
  id: number;
  run_id: string;
  kind: string;
  command: string;
  exit_code: number | null;
  artifact_path: string | null;
  verdict: string;
  created_at: string;
}

export type ReviewVerdict = 'PASS' | 'BLOCK' | 'HUMAN_REVIEW_REQUIRED';

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: string[];
}
