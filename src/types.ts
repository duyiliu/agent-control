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
  human_review_paths?: string[];
  issue_intake?: 'all' | 'labeled';
  /** Optional allowlist of GitHub `author_association` values for
   *  `issue_intake: all`. Unset = import every open issue. Set = only issues
   *  whose author association matches get imported; the rest are recorded as
   *  skipped and never dispatch. `labeled` intake is unaffected — the ready
   *  label is already a human gate. */
  issue_author_association?: string[];
  issue_triage?: { enabled: boolean; timeout_seconds: number };
  repo: string;
  local_repo: string;
  base_branch: string;
  /** Remote the scheduler fetches/pushes — 'origin' by default; a clone may
   *  name its GitHub remote differently (e.g. 'github' when 'origin' is a
   *  company mirror). */
  git_remote: string;
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
  /** Rebuild the approved head before merging and refuse if generated paths
   *  drift from the commit. Project-level because each repo builds its own
   *  way; falls back to approvals.auto_merge.verify_build when unset. */
  verify_build?: CheckSpec;
  /** Optional dependency install run before verify_build when there is no
   *  usable coding worktree (e.g. existing-PR tasks) — the check then runs in
   *  a detached worktree of the approved sha, which starts with no deps. */
  verify_bootstrap?: CheckSpec;
}

export interface AppConfig {
  review_policy?: { version: 1 | 2; timeout_minutes?: number };
  server: {
    poll_interval_seconds: number;
    max_concurrent: number;
    retry_limit: number;
    /** Crash-recovery resumes allowed per run before parking on RECOVERY_REQUIRED. */
    max_resumes: number;
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
    /** Optional coder model and thinking level for issues labelled agent-complex. */
    complex_model?: string;
    complex_reasoning_effort?: ReasoningEffort;
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
    /** Legacy compatibility and guarded-build settings. AI review never authorizes a merge. */
    auto_merge: {
      enabled: boolean;
      /** Source files only — generated output, docs and tests are excluded. */
      max_files: number;
      /** Source lines only — generated output, docs and tests are excluded. */
      max_lines: number;
      /** Build outputs excluded from risk counting and the reviewer diff. */
      generated_paths?: string[];
      /** Documentation excluded from the size gate. */
      doc_paths?: string[];
      /** Rebuild before merging and refuse if the generated files drift from
       *  the commit. This is the counterweight for excluding them from review:
       *  a hand-edited build output would otherwise be invisible. */
      verify_build?: CheckSpec;
      /** Ran before verify_build on the detached-worktree fallback path —
       *  e.g. `npm ci` — since a fresh materialization has no node_modules. */
      verify_bootstrap?: CheckSpec;
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
  createdAt?: string;
  /** GitHub `user.login` of the issue author. */
  author?: string;
  /** GitHub `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER, ... */
  author_association?: string;
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
  review_control_json: string | null;
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
  /** The exact SHA covered by explicit human merge approval. */
  approved_sha: string | null;
  /** 'review' remains for older tasks; new merges require 'human'. */
  approved_by: 'review' | 'human' | null;
  updated_at: string;
  created_at: string;
}

export interface RunRow {
  outcome_protocol: number;
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
  review_detail_json: string | null;
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
  assessment?: ReviewAssessment;
  verdict: ReviewVerdict;
  risk: ReviewRisk;
  summary: string;
  findings: string[];
}

export interface DecisionRequest {
  type: 'product_choice' | 'breaking_change' | 'sensitive_authorization' | 'configured_hold';
  question: string;
  options: string[];
  impact: string;
  reason: string;
  file?: string;
  line?: number;
  request_id?: string;
  head_sha?: string;
  requirement_hash?: string;
}

export interface DecisionResolution {
  request_id: string;
  requirement_hash: string;
  head_sha: string;
  selected_option: string;
  authorization: string;
  actor: string;
  created_at: string;
  scope?: string[];
}

export interface ReviewAssessment {
  protocol_version: 2;
  summary: string;
  findings: { file: string; line: number; trigger: string; impact: string; verification: string }[];
  verification_requests: { claim: string; scenario: string; expected: string }[];
  decision_requests: DecisionRequest[];
  compatibility: { kind: 'unchanged' | 'additive' | 'breaking' | 'unknown'; evidence: string[] };
}

/** Incremental re-review scope: delta between the last reviewed head and the current head. */
export interface ReviewScope {
  fromSha: string;
  toSha: string;
  priorItems: string;
}

export interface ReviewControl {
  policy_version: 2;
  requirement_hash: string;
  rounds: number;
  infra_attempts: number;
  fix_attempts: number;
  next_attempt_at: string | null;
  head_sha: string | null;
  base_sha: string | null;
  assessment?: ReviewAssessment;
  decisions: DecisionRequest[];
  resolutions: DecisionResolution[];
  /** Head whose remaining verification requests were proven non-actionable by
   *  a fix round that produced no commits. Only an explicit human approval may
   *  merge past them; automatic merge stays strict. */
  evidence_only_sha?: string | null;
}
