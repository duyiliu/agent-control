import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { approvalHash } from './tracker/github.js';
import { runProcessRisk, type ProcessSafetyDeps } from './proc.js';
import type { Store } from './store/sqlite.js';
import type { AppConfig, IssueData, Phase, TaskRow } from './types.js';
import { RUN_ACTIVE_PHASES } from './types.js';

/** Minimal tracker surface the shared stop/retry actions need. */
export interface OpsTracker {
  getIssue(repo: string, issueNumber: number): Promise<IssueData | null>;
  getPrState(repo: string, prNumber: number): Promise<'MERGED' | 'CLOSED' | 'OPEN'>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  addPrLabel(repo: string, prNumber: number, label: string): Promise<void>;
  removePrLabel(repo: string, prNumber: number, label: string): Promise<void>;
}

const RETRYABLE: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'];

export class OpsError extends Error {}

// ---------------- drain (pause dispatch, wait for in-flight runs) ----------------

/**
 * Pause all new work (discovery, code/review dispatch, merge sweep) while
 * letting in-flight runs finish. The request is a nonce in the meta table —
 * persisted, so it survives a restart — and the engine writes the same nonce
 * to drain_ack once it observes a fully quiet scheduler.
 */
export function requestDrain(store: Store): string {
  const id = randomUUID();
  store.tx(() => {
    store.setMeta('drain_requested', id);
    store.setMeta('drain_ack', '');
  });
  return id;
}

/** Lift a drain: clear both keys so the next tick resumes normal dispatch. */
export function resumeDispatch(store: Store): void {
  store.tx(() => {
    store.setMeta('drain_requested', '');
    store.setMeta('drain_ack', '');
  });
}

/**
 * Wait for the engine to acknowledge THIS drain request. The poll first
 * re-verifies the request is still ours — a cleared or replaced request
 * means the wait can never resolve — then requires ack === requestId. An
 * idle-looking DB or an older ack is never treated as drained.
 */
export async function waitForDrain(store: Store, requestId: string, timeoutMs: number, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const requested = store.getMeta('drain_requested');
    if (requested !== requestId) {
      throw new OpsError(requested ? '排空请求已被更新的请求替换' : '排空请求已被取消（undrain）');
    }
    if (store.getMeta('drain_ack') === requestId) return;
    if (Date.now() >= deadline) {
      throw new OpsError(`等待排空超时（${Math.round(timeoutMs / 1000)}s）；调度仍保持暂停，可用 undrain 恢复或稍后重试 drain`);
    }
    await sleep(pollMs);
  }
}

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
    // A bare PR has no human merge path in the host: AWAITING_HUMAN would be
    // pulled straight back into the review queue by the unreviewed-head
    // self-heal check, so opting out must be terminal here. Retry re-queues it.
    if (task.source === 'pr') {
      store.setTaskStatus(task.id, 'CANCELED');
      return `PR #${task.issue_number} 已停止自动评审；重新评审请使用重试`;
    }
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
  // A bare PR was never coded by the agent and its review is advisory; the
  // host must not land someone else's branch.
  if (current.source === 'pr') {
    throw new OpsError('该任务只评审外部 PR，不会被自动合并；请在 GitHub 上人工合并');
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
  // A bare PR has no issue to re-approve: retrying means "judge the current
  // head again", which is why the recorded verdicts are dropped instead of
  // re-reading a ready label that will never exist. This is the only way back
  // from an ERROR round, a stop, or a head nobody re-reviewed.
  if (task.source === 'pr') {
    if (store.activeRunForTask(task.id)) throw new OpsError('仍有活动的运行，请先停止');
    const prNum = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
    if (!prNum) throw new OpsError('任务没有关联 PR，无法重试');
    store.tx(() => {
      store.deleteReviewVerdicts(task.id);
      store.setTaskStatus(task.id, 'AWAITING_REVIEW', { pending_fix: null });
    });
    await tracker.removePrLabel(task.repo, Number(prNum), 'agent-blocked').catch(() => {});
    return `PR #${prNum} 已重新排队评审`;
  }

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

  const prNum = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  if (prNum && await tracker.getPrState(task.repo, Number(prNum)) === 'CLOSED') {
    throw new OpsError(`关联 PR #${prNum} 已关闭；请先重新打开 PR，再重试任务`);
  }

  store.tx(() => {
    const current = store.getTaskById(task.id);
    if (!current || !RETRYABLE.includes(current.status) || store.activeRunForTask(task.id)) {
      throw new OpsError('检查重试期间任务已变化，请刷新后重试');
    }
    // A retry means "judge the current state again". Dropping the recorded
    // verdicts is what makes that true: a task whose branch already has an
    // OPEN PR goes DISCOVERED → existing-PR → AWAITING_REVIEW, and the sha
    // idempotency would otherwise skip the unchanged head forever, leaving a
    // task that shows as "reviewing" but can never move.
    store.deleteReviewVerdicts(task.id);
    // A human retry re-approves the whole pipeline: discard any stale
    // review-fix intent so the new run starts clean.
    store.setTaskStatus(task.id, 'DISCOVERED', { approved_hash: approvalHash(issue), pending_fix: null });
  });
  await tracker.removeLabel(task.repo, task.issue_number, 'agent-blocked').catch(() => {});
  return `任务 ${task.repo}#${task.issue_number} 已重新排队（哈希 ${approvalHash(issue).slice(0, 12)}）`;
}
