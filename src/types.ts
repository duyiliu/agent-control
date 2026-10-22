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
  'AWAITING_REVIEW',
  'AWAITING_HUMAN',
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
  /** Platforms this check can run on (`node` platform names). Unset = all.
   *  A check whose list excludes the host is skipped: it never runs, never
   *  consumes fix budget, and is recorded as SKIP rather than FAIL. */
  platforms?: NodeJS.Platform[];
}

export interface ProjectConfig {
  repo: string;
  local_repo: string;
  base_branch: string;
  ready_label: string;
  branch_prefix: string;
  checks: CheckSpec[];
  /** 'auto': every published PR head gets an independent review run.
   *  'manual': no review run — the PR parks in AWAITING_HUMAN (Human Review)
   *  for a human to review and merge. */
  review_mode: 'auto' | 'manual';
  /** 'auto': PRs opened in this repo are reviewed without an issue backing
   *  them (the PR is the whole input). 'manual': only PRs a human summons
   *  with the agent-review label are reviewed. */
  pr_review: 'auto' | 'manual';
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
    provider: 'pi';
    /** pi model identifier from models.json: "<provider>/<model id>". */
    model: string;
    reasoning_effort?: ReasoningEffort;
    /** Optional reviewer model and thinking level; the runner remains Pi. */
    review_model?: string;
    review_reasoning_effort?: ReasoningEffort;
    env_deny: string[];
    /**
     * Absolute path to the pi executable. Required when pi is not on the
     * service's PATH — a systemd unit's Environment is not inherited by an
     * interactive shell, so `ac doctor` and any manual run would otherwise
     * resolve pi differently from the service. Falls back to a PATH lookup
     * when unset.
     */
    pi_path?: string;
  };
  approvals: {
    /** Host-side auto-merge for low-risk PRs that pass review. */
    auto_merge: {
      enabled: boolean;
      max_files: number;
      max_lines: number;
    };
  };
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Embedded web UI. Loopback-only by default — it can stop/retry tasks.
 *  Set token when exposing beyond loopback (e.g. an NPS tunnel): all
 *  routes then require it via cookie, ?token=, or Bearer header. */
export interface UiConfig {
  enabled: boolean;
  host: string;
  port: number;
  token?: string;
}

/** Pi thinking levels accepted by the --thinking option. */
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

/** What a task was discovered from. See TaskRow.issue_number. */
export type TaskSource = 'issue' | 'pr';

/** Run kind: 'code' drives the coding state machine; 'review' is a
 *  separately-dispatched verdict on one PR head sha. */
export type RunKind = 'code' | 'review';

/** tasks.pending_fix JSON payload: a review BLOCK or merge failure that
 *  spawned a fix run. `title` labels the fix prompt section. */
export interface PendingFix {
  head_sha: string;
  summary: string;
  findings: string[];
  title?: string;
}

export interface TaskRow {
  id: number;
  repo: string;
  /** GitHub numbers issues and PRs from one sequence, so a PR-only task
   *  stores its PR number here; `source` says which one it is. */
  issue_number: number;
  issue_title: string;
  issue_url: string;
  /** 'issue': the task drives a coding run and owns its published PR.
   *  'pr': an external PR reviewed in place — never coded against, never
   *  auto-merged. */
  source: TaskSource;
  approved_hash: string | null;
  status: Phase;
  branch: string | null;
  pr_url: string | null;
  fix_rounds: number;
  pending_fix: string | null;
  merge_attempts: number;
  /** The exact sha cleared to land; set when the task enters MERGING. */
  approved_sha: string | null;
  /** Who cleared it: 'review' (PASS+low) or 'human' (agent-merge label). */
  approved_by: 'review' | 'human' | null;
  updated_at: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  run_id: string;
  task_id: number;
  kind: RunKind;
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
  head_sha: string | null;
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
  head_sha: string | null;
  created_at: string;
}

export type ReviewVerdict = 'PASS' | 'BLOCK' | 'HUMAN_REVIEW_REQUIRED';

/** Reviewer's own risk assessment; host rules can escalate low to high. */
export type ReviewRisk = 'low' | 'high';

export interface ReviewResult {
  verdict: ReviewVerdict;
  risk: ReviewRisk;
  summary: string;
  findings: string[];
}
