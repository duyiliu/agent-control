import { approvalHash } from './tracker/github.js';
import { runProcessRisk, type ProcessSafetyDeps } from './proc.js';
import type { Store } from './store/sqlite.js';
import type { AppConfig, IssueData, Phase, TaskRow } from './types.js';
import { RUN_ACTIVE_PHASES } from './types.js';

/** Minimal tracker surface the shared stop/retry actions need. */
export interface OpsTracker {
  getIssue(repo: string, issueNumber: number): Promise<IssueData | null>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  addPrLabel(repo: string, prNumber: number, label: string): Promise<void>;
}

const RETRYABLE: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'];

export class OpsError extends Error {}

export function stopTask(store: Store, task: TaskRow): string {
  const run = store.activeRunForTask(task.id);
  if (run) {
    store.requestCancel(run.run_id);
    return `已请求取消运行 ${run.run_id}；调度器会在一个轮询周期内中止它`;
  }
  if ((RUN_ACTIVE_PHASES as readonly Phase[]).includes(task.status)) {
    store.setTaskStatus(task.id, 'CANCELED');
    return `任务 ${task.repo}#${task.issue_number} 已取消`;
  }
  // MERGING has no run — stopping opts the task out of the auto-merge
  // sweep and parks it on the human merge path.
  if (task.status === 'MERGING') {
    store.setTaskStatus(task.id, 'AWAITING_HUMAN');
    return `任务 ${task.repo}#${task.issue_number} 已退出自动合并，等待人工处理`;
  }
  // AWAITING_REVIEW has no run either — stopping opts out of the automatic
  // review and hands the PR to a human as-is.
  if (task.status === 'AWAITING_REVIEW') {
    store.setTaskStatus(task.id, 'AWAITING_HUMAN');
    return `任务 ${task.repo}#${task.issue_number} 已退出自动评审，等待人工处理`;
  }
  // DISCOVERED + pending_fix is a queued fix run — stoppable, and the fix
  // intent dies with the cancellation.
  if (task.status === 'DISCOVERED' && task.pending_fix) {
    store.setTaskStatus(task.id, 'CANCELED', { pending_fix: null });
    return `任务 ${task.repo}#${task.issue_number} 已取消（含待执行修复）`;
  }
  return `任务 ${task.repo}#${task.issue_number} 没有活动的运行（状态=${task.status}）`;
}

/**
 * Panel action: approve merging the PR under human review. The approval is
 * the `agent-merge` label — the same signal a human would add by hand — so
 * the merge sweep keeps its sha check, one-shot consumption and retry loop.
 */
export async function approveMergeTask(store: Store, tracker: OpsTracker, task: TaskRow): Promise<string> {
  const current = store.getTaskById(task.id);
  if (!current) throw new OpsError('任务不存在');
  if (current.status !== 'AWAITING_HUMAN') {
    throw new OpsError(`只有待人工处理（AWAITING_HUMAN）的任务可以批准合并，当前状态 ${current.status}`);
  }
  const prNum = current.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  if (!prNum) throw new OpsError('任务没有关联 PR，无法批准合并');
  await tracker.addPrLabel(current.repo, Number(prNum), 'agent-merge');
  return `已提交批准：PR #${prNum} 标记为 agent-merge；调度器将在下个 tick 校验被审 sha 后自动合并`;
}

export async function retryTask(
  store: Store,
  config: AppConfig,
  tracker: OpsTracker,
  task: TaskRow,
  processDeps: ProcessSafetyDeps = {},
): Promise<string> {
  if (!RETRYABLE.includes(task.status)) {
    throw new OpsError(`任务状态 ${task.status} 不可重试`);
  }
  if (store.activeRunForTask(task.id)) {
    throw new OpsError('仍有活动的运行，请先停止');
  }

  const previous = store.runsForTask(task.id);
  for (const run of previous) {
    if (run.phase === 'AWAITING_REVIEW' || run.phase === 'AWAITING_HUMAN' || run.phase === 'COMPLETED') continue;
    const risk = await runProcessRisk(run, processDeps);
    if (risk) throw new OpsError(`无法重试：${risk}`);
  }

  // Re-validate approval against the CURRENT issue content — a human
  // retry means "the current issue text is what I approve".
  const project = config.projects.find((p) => p.repo === task.repo);
  if (!project) throw new OpsError(`项目 ${task.repo} 不在配置中`);
  const issue = await tracker.getIssue(task.repo, task.issue_number);
  if (!issue || issue.state !== 'OPEN') throw new OpsError('issue 已关闭或不存在');
  if (!issue.labels.includes(project.ready_label)) {
    throw new OpsError(`issue 缺少 ${project.ready_label} 标签`);
  }
  if (issue.labels.includes('agent-running')) {
    throw new OpsError('issue 带有 agent-running 标签；请先确认没有调度器持有它，再移除过期标签并重试');
  }

  store.tx(() => {
    const current = store.getTaskById(task.id);
    if (!current || !RETRYABLE.includes(current.status) || store.activeRunForTask(task.id)) {
      throw new OpsError('检查重试期间任务已变化，请刷新后重试');
    }
    // A human retry re-approves the whole pipeline: discard any stale
    // review-fix intent so the new run starts clean.
    store.setTaskStatus(task.id, 'DISCOVERED', { approved_hash: approvalHash(issue), pending_fix: null });
  });
  await tracker.removeLabel(task.repo, task.issue_number, 'agent-blocked').catch(() => {});
  return `任务 ${task.repo}#${task.issue_number} 已重新排队（哈希 ${approvalHash(issue).slice(0, 12)}）`;
}
