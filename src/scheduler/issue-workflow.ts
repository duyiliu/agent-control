import type { IssueData, ProjectConfig, TaskRow } from '../types.js';

export type WorkflowState = 'Backlog' | 'Todo' | 'In Progress' | 'Human Review' | 'Rework' | 'Merging' | 'Done';

export const WORKFLOW_STATES: readonly WorkflowState[] = ['Backlog', 'Todo', 'In Progress', 'Human Review', 'Rework', 'Merging', 'Done'];

export const WORKFLOW_LABEL: Record<WorkflowState, string> = {
  Backlog: 'Backlog', Todo: 'Todo', 'In Progress': 'In Progress', 'Human Review': 'Human Review',
  Rework: 'Rework', Merging: 'Merging', Done: 'Done',
};

/** Transitions a human may perform on the Issue; everything else is host-owned. */
export const HUMAN_TARGETS: readonly WorkflowState[] = ['Todo', 'Backlog', 'Human Review', 'Rework', 'Merging'];

export interface WorkflowHandoff {
  pr: number;
  pr_url: string;
  head_sha: string;
  base_sha: string | null;
  requirement_hash: string;
  generation: number;
  at: string;
}

export interface WorkflowApproval {
  event_id: number;
  actor: string;
  target: 'Merging' | 'Rework';
  head_sha: string;
  base_sha: string | null;
  requirement_hash: string;
  pr: number;
  generation: number;
  at: string;
  /** 'github' is a verified Issue label event; 'board' is a token-authenticated local operator. */
  source?: 'github' | 'board';
}

/** A local board approval is bound to the same scope as a verified GitHub event. */
export interface BoardApproval {
  target: 'Merging' | 'Rework';
  actor: string;
  at: string;
  head_sha: string;
  base_sha: string | null;
  requirement_hash: string;
  pr: number;
  generation: number;
}

export interface WorkflowHistoryEntry {
  generation: number;
  pr_url: string | null;
  branch: string | null;
  head_sha: string | null;
  closed_at: string;
  reason: string;
}

export interface WorkflowRework {
  event_id: number;
  actor: string;
  from_generation: number;
  source?: 'github' | 'board';
}

export interface WorkflowRecord {
  version: 1;
  observed_state: WorkflowState | null;
  event_cursor: number;
  generation: number;
  handoff: WorkflowHandoff | null;
  approval: WorkflowApproval | null;
  history: WorkflowHistoryEntry[];
  pending_label: WorkflowState | null;
  rework: WorkflowRework | null;
  board_approval: BoardApproval | null;
  diagnostic: string | null;
}

export function newWorkflowRecord(): WorkflowRecord {
  return { version: 1, observed_state: null, event_cursor: 0, generation: 1,
    handoff: null, approval: null, history: [], pending_label: null, rework: null,
    board_approval: null, diagnostic: null };
}

/** null/undefined means a legacy task; corrupt JSON is never silently legacy. */
export function parseWorkflow(json: string | null | undefined): WorkflowRecord | null {
  if (json === null || json === undefined) return null;
  const value = JSON.parse(json) as Partial<WorkflowRecord>;
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.history)
    || typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 1) {
    throw new Error('issue workflow record is invalid');
  }
  if (value.board_approval === undefined) value.board_approval = null;
  return value as WorkflowRecord;
}

export function workflowOf(task: Pick<TaskRow, 'issue_workflow_json'>): WorkflowRecord | null {
  return parseWorkflow(task.issue_workflow_json);
}

export function isWorkflowTask(task: Pick<TaskRow, 'issue_workflow_json'>): boolean {
  return workflowOf(task) !== null;
}

export function workflowEnabled(project: ProjectConfig): boolean {
  return project.workflow_mode === 'github';
}

/** The mutually exclusive Issue state; conflicts and absence are explicit. */
export function stateFromLabels(labels: readonly string[]): { state: WorkflowState | null; conflicts: WorkflowState[] } {
  const found = WORKFLOW_STATES.filter(state => labels.includes(WORKFLOW_LABEL[state]));
  return { state: found.length === 1 ? found[0] ?? null : null, conflicts: found.length > 1 ? found : [] };
}

/** A new issue is never dispatched until a human moves it out of Backlog. */
export function initialState(labels: readonly string[]): WorkflowState {
  return stateFromLabels(labels).state ?? 'Backlog';
}

export interface LabelEvent {
  id: number;
  event: string;
  label: string | null;
  actor: string;
  actorType: string;
  createdAt: string;
}

export interface ApprovalCheck {
  event: LabelEvent | null;
  reason: string;
}

/**
 * The human authorization is the newest labelled/unlabelled event that
 * established the requested target after the handoff, by a non-bot actor with
 * repository write access. A later unlabel/re-add sequence invalidates older
 * events because only the latest transition per label counts.
 */
export function authorizeHumanEvent(input: {
  events: readonly LabelEvent[];
  target: 'Merging' | 'Rework';
  hostLogin: string | null;
  permission: string | null;
  handoff: WorkflowHandoff;
  requirementHash: string;
  pr: number;
  headSha: string;
  baseSha: string | null;
  generation: number;
}): ApprovalCheck {
  const label = WORKFLOW_LABEL[input.target];
  const after = input.events.filter(event => event.createdAt >= input.handoff.at
    && event.id > 0 && (event.event === 'labeled' || event.event === 'unlabeled'));
  const latest = after.filter(event => event.label === label).at(-1);
  if (!latest || latest.event !== 'labeled') return { event: null, reason: '缺少交付之后的人工状态事件' };
  if (!latest.actor || latest.actorType !== 'User') return { event: null, reason: '操作者不是可核验的人类账号' };
  if (input.hostLogin && latest.actor === input.hostLogin) return { event: null, reason: '宿主自动化身份不能充当批准人' };
  const allowed = ['admin', 'maintain', 'write', 'push'];
  if (!input.permission || !allowed.includes(input.permission)) return { event: null, reason: '操作者缺少仓库写权限' };
  if (input.requirementHash !== input.handoff.requirement_hash) return { event: null, reason: 'Issue 需求已变化' };
  if (input.pr !== input.handoff.pr || input.headSha !== input.handoff.head_sha
    || (input.baseSha ?? null) !== (input.handoff.base_sha ?? null)) return { event: null, reason: 'PR head/base 已变化' };
  if (input.generation !== input.handoff.generation) return { event: null, reason: '返工代际已变化' };
  return { event: latest, reason: 'ok' };
}
