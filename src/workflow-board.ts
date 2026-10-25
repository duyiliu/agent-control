import type { Store } from './store/sqlite.js';
import type { AppConfig, IssueData, TaskRow } from './types.js';
import {
  parseWorkflow,
  stateFromLabels,
  WORKFLOW_LABEL,
  type BoardApproval,
  type WorkflowRecord,
  type WorkflowState,
} from './scheduler/issue-workflow.js';
import { approvalHash } from './tracker/github.js';
import { OpsError } from './ops.js';

export interface WorkflowBoardTracker {
  getIssue(repo: string, issueNumber: number): Promise<IssueData | null>;
  getPrDetails(repo: string, prNumber: number): Promise<{
    state: 'MERGED' | 'CLOSED' | 'OPEN';
    headSha: string;
    baseSha?: string;
    url: string;
  }>;
  setWorkflowState(repo: string, issueNumber: number, label: string, allLabels: readonly string[]): Promise<void>;
}

/** Transitions a human may make from the board. Host-owned states are not targets. */
export type BoardTarget = 'Backlog' | 'Todo' | 'Human Review' | 'Rework' | 'Merging';

export const BOARD_TARGETS: readonly BoardTarget[] = ['Backlog', 'Todo', 'Human Review', 'Rework', 'Merging'];

const ALLOWED: Record<WorkflowState, readonly WorkflowState[]> = {
  Backlog: ['Todo'],
  Todo: ['Backlog', 'Human Review'],
  'In Progress': ['Human Review'],
  'Human Review': ['Todo', 'Backlog', 'Merging', 'Rework'],
  Rework: ['Human Review'],
  Merging: ['Human Review'],
  Done: [],
};

function isBoardTarget(value: string): value is BoardTarget {
  return (BOARD_TARGETS as readonly string[]).includes(value);
}

export function sameApprovalScope(
  approval: { generation: number; pr: number; head_sha: string; base_sha: string | null; requirement_hash: string },
  input: { generation: number; pr: number; headSha: string; baseSha: string | null; requirementHash: string },
): boolean {
  return approval.generation === input.generation
    && approval.pr === input.pr
    && approval.head_sha === input.headSha
    && (approval.base_sha ?? null) === (input.baseSha ?? null)
    && approval.requirement_hash === input.requirementHash;
}

/**
 * A board action is a token-authenticated human channel, not a GitHub label
 * event. It writes the state label and records a scope-bound approval for
 * Merging/Rework; the engine still rechecks the Issue, PR head/base, checks
 * and CI before landing.
 */
export async function setWorkflowStateFromBoard(
  store: Store,
  config: AppConfig,
  tracker: WorkflowBoardTracker,
  task: TaskRow,
  target: string,
  expectedUpdatedAt: string,
): Promise<string> {
  if (task.issue_workflow_json === null) throw new OpsError('该任务不是七状态工作流任务');
  if (!isBoardTarget(target)) throw new OpsError(`看板不能改为 ${target}；可选：${BOARD_TARGETS.join(' / ')}`);
  const project = config.projects.find(p => p.repo === task.repo);
  if (!project || (project.workflow_mode ?? 'github') !== 'github') throw new OpsError('项目未启用 GitHub 七状态工作流');
  const current = store.getTaskById(task.id);
  if (!current || current.updated_at !== expectedUpdatedAt) throw new OpsError('任务状态已变化，请刷新后重试');
  const record = parseWorkflow(current.issue_workflow_json);
  if (!record) throw new OpsError('工作流记录缺失');
  const issue = await tracker.getIssue(current.repo, current.issue_number);
  if (!issue || issue.state !== 'OPEN') throw new OpsError('Issue 已关闭或不存在');
  const { state, conflicts } = stateFromLabels(issue.labels);
  if (conflicts.length) throw new OpsError(`Issue 状态标签冲突：${conflicts.join('/')}，请先在 GitHub 修正`);
  if (!state) throw new OpsError('Issue 缺少七状态标签，请先在 GitHub 修正');
  if (state === target) {
    if (target !== 'Merging' && target !== 'Rework') {
      // The label can already be correct while the local cache is stale (for
      // example after a crash between the GitHub write and the local save).
      // A same-state click must repair the cache instead of silently returning.
      const synced: WorkflowRecord = {
        ...record,
        observed_state: target,
        pending_label: null,
        approval: null,
        board_approval: null,
        rework: null,
        diagnostic: target === 'Human Review' ? record.diagnostic : null,
      };
      store.saveIssueWorkflow(current.id, JSON.stringify(synced));
      return `Issue 已经是 ${target}（本地状态已同步）`;
    }
  } else if (!ALLOWED[state].includes(target)) {
    throw new OpsError(`不允许从 ${state} 改为 ${target}`);
  }

  const hash = approvalHash(issue);
  const now = new Date().toISOString();
  const next: WorkflowRecord = {
    ...record,
    board_approval: record.board_approval ?? null,
    rework: record.rework ?? null,
  };

  if (target === 'Merging') {
    const handoff = next.handoff;
    if (!handoff) throw new OpsError('还没有关联 PR，不能批准合并');
    const pr = await tracker.getPrDetails(current.repo, handoff.pr);
    if (!pr || pr.state !== 'OPEN') throw new OpsError('PR 已关闭、已合并或不存在');
    if (pr.headSha !== handoff.head_sha || (pr.baseSha ?? null) !== (handoff.base_sha ?? null)) {
      throw new OpsError('PR head/base 已变化，旧批准已失效；请重新审核后再批准');
    }
    if (hash !== handoff.requirement_hash) throw new OpsError('Issue 需求已变化，请重新审核');
    if (next.generation !== handoff.generation) throw new OpsError('返工代际已变化，请重新审核');
    next.board_approval = {
      target, actor: 'board', at: now, head_sha: pr.headSha, base_sha: pr.baseSha ?? null,
      requirement_hash: hash, pr: handoff.pr, generation: next.generation,
    };
    next.diagnostic = null;
  } else if (target === 'Rework') {
    next.board_approval = {
      target, actor: 'board', at: now, head_sha: next.handoff?.head_sha ?? '',
      base_sha: next.handoff?.base_sha ?? null, requirement_hash: hash,
      pr: next.handoff?.pr ?? 0, generation: next.generation,
    };
    next.rework = null;
    next.diagnostic = null;
  } else if (target === 'Human Review') {
    next.approval = null;
    next.board_approval = null;
    next.rework = null;
    next.diagnostic = state === 'In Progress' ? '人工在看板暂停执行'
      : state === 'Merging' ? '人工在看板撤回合并'
        : state === 'Rework' ? '人工在看板取消返工'
          : '人工在看板移到 Human Review';
  } else {
    // Leaving Human Review voids the old approval, but keep the handoff until
    // the label write is confirmed: a failed write must not destroy the
    // reviewed scope. The engine clears it when it observes the new state.
    next.approval = null;
    next.board_approval = null;
    next.rework = null;
    next.diagnostic = null;
  }
  next.pending_label = target;
  store.saveIssueWorkflow(current.id, JSON.stringify(next));

  try {
    await tracker.setWorkflowState(current.repo, current.issue_number, WORKFLOW_LABEL[target], issue.labels);
  } catch (error) {
    next.diagnostic = `状态标签写入失败：${String(error).slice(0, 200)}`;
    store.saveIssueWorkflow(current.id, JSON.stringify(next));
    throw new OpsError(`操作已记录，但 GitHub 标签写入失败：${String(error).slice(0, 200)}；调度器会重试`);
  }

  const after = await tracker.getIssue(current.repo, current.issue_number);
  const confirmed = after ? stateFromLabels(after.labels) : { state: null, conflicts: [] as WorkflowState[] };
  if (confirmed.state !== target || confirmed.conflicts.length) {
    next.diagnostic = `状态标签写入未确认：期望 ${target}，实际 ${confirmed.conflicts.length ? `冲突 ${confirmed.conflicts.join('/')}` : confirmed.state ?? '缺失'}`;
    store.saveIssueWorkflow(current.id, JSON.stringify(next));
    throw new OpsError(`GitHub 标签写入未确认（当前 ${confirmed.state ?? '缺失'}）；调度器会重试`);
  }

  next.pending_label = null;
  next.observed_state = target;
  store.saveIssueWorkflow(current.id, JSON.stringify(next));
  // A pause takes effect immediately; the engine reconcile would abort it on
  // the next tick anyway, but the UI should not wait for that.
  const active = store.activeRunForTask(current.id);
  if (active && (target === 'Backlog' || target === 'Human Review' || target === 'Rework' || target === 'Merging')) {
    store.requestCancel(active.run_id);
  }
  return `Issue 状态已改为 ${target}`;
}
