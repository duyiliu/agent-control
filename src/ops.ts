import { newReviewControl, unresolvedDecisions } from './verify/review-policy.js';
import { acceptsAllIssues, type IntakeState } from './triage/intake.js';
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
  getPrHeadSha?(repo: string, prNumber: number): Promise<string>;
  getPrState(repo: string, prNumber: number): Promise<'MERGED' | 'CLOSED' | 'OPEN'>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  addPrLabel(repo: string, prNumber: number, label: string): Promise<void>;
  removePrLabel(repo: string, prNumber: number, label: string): Promise<void>;
}

const RETRYABLE: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'];

export class OpsError extends Error {}

const taskOperations = new WeakMap<Store, Map<number, Promise<void>>>();

async function withTaskOperation<T>(store: Store, taskId: number, operation: () => Promise<T>): Promise<T> {
  let tasks = taskOperations.get(store);
  if (!tasks) { tasks = new Map(); taskOperations.set(store, tasks); }
  const previous = tasks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  tasks.set(taskId, queued);
  await previous;
  try { return await operation(); }
  finally { release(); if (tasks.get(taskId) === queued) tasks.delete(taskId); }
}

export function rereviewTask(store: Store, config: AppConfig, tracker: OpsTracker, task: TaskRow, expectedUpdatedAt: string): Promise<string> {
  if (task.issue_workflow_json !== null) {
    return Promise.reject(new OpsError('该任务由 GitHub 七状态驱动：请在 Issue 上把状态改为 Human Review/Todo 触发新一轮，面板不会另建状态'));
  }
  return withTaskOperation(store, task.id, () => doRereviewTask(store, config, tracker, task, expectedUpdatedAt));
}

async function doRereviewTask(store: Store, config: AppConfig, tracker: OpsTracker, task: TaskRow, expectedUpdatedAt: string): Promise<string> {
  const project = config.projects.find(p => p.repo === task.repo);
  if (!project || task.source === 'issue' && project.review_mode !== 'auto') throw new OpsError('项目使用人工评审，请在 GitHub 处理');
  const assertCurrent = () => {
    const current = store.getTaskById(task.id);
    if (!current || current.status !== 'AWAITING_HUMAN' || current.updated_at !== expectedUpdatedAt || store.activeRunForTask(task.id)) throw new OpsError('任务状态已变化，请刷新后重新评审');
    const intake = store.getIntake<IntakeState>(task.repo, task.issue_number);
    if (task.source === 'issue' && intake && (!intake.imported || intake.kind || intake.locked || intake.pending || intake.error || intake.external_hold || intake.external_needs)) throw new OpsError('Issue 仍有人工门禁或同步未完成');
    return current;
  };
  assertCurrent();
  const prNumber = Number(task.pr_url?.match(/\/pull\/(\d+)/)?.[1]);
  if (!prNumber || await tracker.getPrState(task.repo, prNumber) !== 'OPEN') throw new OpsError('关联 PR 已关闭、已合并或不存在');
  if (task.source === 'issue') {
    const issue = await tracker.getIssue(task.repo, task.issue_number);
    if (!issue || issue.state !== 'OPEN') throw new OpsError('Issue 已关闭或不存在');
    if (issue.labels.some(l => ['agent-human-hold', 'agent-needs-human', 'agent-running'].includes(l))) throw new OpsError('Issue 仍被人工锁定或其他运行持有');
    if (!acceptsAllIssues(project) && !issue.labels.includes(project.ready_label)) throw new OpsError(`Issue 缺少 ${project.ready_label} 标签`);
    if (task.approved_hash && task.approved_hash !== approvalHash(issue)) throw new OpsError('Issue 内容已变化，请先重新确认需求');
  }
  assertCurrent();
  await tracker.removePrLabel(task.repo, prNumber, 'agent-merge');
  store.tx(() => {
    assertCurrent();
    const last = store.runsForTask(task.id).at(-1);
    const priorControl = store.getReviewControl(task.id);
    if (last) store.transition(last.run_id, last.phase, last.phase, { kind: 'review_requeued', reason: 'operator_request', policy_version: config.review_policy?.version ?? priorControl?.policy_version ?? 'legacy', budget_renewed: config.review_policy?.version === 2 || !!priorControl,
      previous_rounds: priorControl?.rounds ?? 0, previous_infra_attempts: priorControl?.infra_attempts ?? 0, previous_fix_attempts: priorControl?.fix_attempts ?? 0 });
    if (config.review_policy?.version === 2 || store.getReviewControl(task.id)) {
      const previous = store.getReviewControl(task.id);
      const renewed = newReviewControl(task.approved_hash ?? previous?.requirement_hash ?? `pr:${task.repo}:${task.issue_number}`);
      store.saveReviewControl(task.id, previous && previous.requirement_hash === renewed.requirement_hash
        ? { ...previous, rounds: 0, infra_attempts: 0, fix_attempts: 0, next_attempt_at: null }
        : renewed);
    } else store.deleteReviewVerdicts(task.id);
    store.setTaskStatus(task.id, 'AWAITING_REVIEW', { pending_fix: null, approved_sha: null, approved_by: null, merge_attempts: 0 });
  });
  return `PR #${prNumber} 已重新排队评审，将复核当前提交`;
}

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
export function approveMergeTask(store: Store, tracker: OpsTracker, task: TaskRow, expectedUpdatedAt = task.updated_at): Promise<string> {
  // A github-workflow task is authorized only by a verified Issue event.
  if (task.issue_workflow_json !== null) {
    return Promise.reject(new OpsError('该任务由 GitHub 七状态驱动：请在 Issue 上将 Human Review 改为 Merging，面板批准不会绕过授权校验'));
  }
  return withTaskOperation(store, task.id, () => doApproveMergeTask(store, tracker, task, expectedUpdatedAt));
}

async function doApproveMergeTask(store: Store, tracker: OpsTracker, task: TaskRow, expectedUpdatedAt: string): Promise<string> {
  const current = store.getTaskById(task.id);
  if (!current) throw new OpsError('任务不存在');
  if (current.status !== 'AWAITING_HUMAN') {
    throw new OpsError(`只有待人工处理（AWAITING_HUMAN）的任务可以批准合并，当前状态 ${current.status}`);
  }
  if (current.updated_at !== expectedUpdatedAt) throw new OpsError('任务状态已变化，请刷新后批准合并');
  // A bare PR was never coded by the agent and its review is advisory; the
  // host must not land someone else's branch.
  if (current.source === 'pr') {
    throw new OpsError('该任务只评审外部 PR，不会被自动合并；请在 GitHub 上人工合并');
  }
  if (store.activeRunForTask(task.id)) throw new OpsError('仍有活动的运行');
  const control = store.getReviewControl(task.id);
  if (control && control.decisions.some(request => request.type !== 'product_choice' && control.resolutions.some(answer => answer.request_id === request.request_id && answer.requirement_hash === control.requirement_hash && answer.head_sha === control.head_sha && answer.selected_option === '拒绝当前提交'))) throw new OpsError('当前提交的授权已被拒绝，必须修改实现并重新评审');
  if (control && (!control.head_sha || unresolvedDecisions(control, control.head_sha).length || control.assessment && (control.assessment.findings.length || control.assessment.verification_requests.length || control.assessment.compatibility.kind === 'unknown'))) throw new OpsError('仍有未解决决策或技术门禁，请先完成具体问题与重新评审');
  const prNum = current.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  if (!prNum) throw new OpsError('任务没有关联 PR，无法批准合并');
  if (control) {
    const intake = store.getIntake<IntakeState>(current.repo, current.issue_number);
    if (intake && (!intake.imported || intake.kind || intake.locked || intake.pending || intake.error || intake.external_hold || intake.external_needs)) throw new OpsError('Issue 仍有人工门禁或同步未完成');
    const issue = await tracker.getIssue(current.repo, current.issue_number);
    if (!issue || issue.state !== 'OPEN' || approvalHash(issue) !== control.requirement_hash || current.approved_hash !== control.requirement_hash) throw new OpsError('Issue 已关闭或需求已变化');
    if (issue.labels.some(l => ['agent-human-hold', 'agent-needs-human', 'agent-running'].includes(l))) throw new OpsError('Issue 仍被人工锁定或其他运行持有');
    if (await tracker.getPrState(current.repo, Number(prNum)) !== 'OPEN' || !tracker.getPrHeadSha || await tracker.getPrHeadSha(current.repo, Number(prNum)) !== control.head_sha) throw new OpsError('PR 已关闭或提交已变化');
    const fresh = store.getTaskById(task.id);
    if (!fresh || fresh.updated_at !== expectedUpdatedAt || fresh.status !== 'AWAITING_HUMAN' || store.activeRunForTask(task.id)) throw new OpsError('批准期间任务状态已变化，请刷新');
  }
  const reviewRun = store.runsForTask(task.id).at(-1)?.run_id;
  await tracker.addPrLabel(current.repo, Number(prNum), 'agent-merge');
  const after = store.getTaskById(task.id);
  const consumed = after && ['MERGING', 'COMPLETED'].includes(after.status) && after.approved_by === 'human' && store.runsForTask(task.id).at(-1)?.run_id === reviewRun;
  if (!consumed && (!after || after.status !== 'AWAITING_HUMAN' || after.updated_at !== expectedUpdatedAt)) {
    await tracker.removePrLabel(current.repo, Number(prNum), 'agent-merge');
    throw new OpsError('批准期间任务状态已变化，已撤销旧批准；请刷新');
  }
  return `已提交批准：PR #${prNum} 标记为 agent-merge；调度器将在下个 tick 校验被审 sha 后自动合并`;
}

export async function retryTask(
  store: Store,
  config: AppConfig,
  tracker: OpsTracker,
  task: TaskRow,
  processDeps: ProcessSafetyDeps = {},
): Promise<string> {
  if (task.issue_workflow_json !== null) {
    throw new OpsError('该任务由 GitHub 七状态驱动：请在 Issue 上把状态改为 Todo 后由调度器重新领取');
  }
  // A bare PR has no issue to re-approve: retrying means "judge the current
  // head again", which is why the recorded verdicts are dropped instead of
  // re-reading a ready label that will never exist. This is the only way back
  // from an ERROR round, a stop, or a head nobody re-reviewed.
  if (task.source === 'pr') {
    if (store.activeRunForTask(task.id)) throw new OpsError('仍有活动的运行，请先停止');
    const prNum = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
    if (!prNum) throw new OpsError('任务没有关联 PR，无法重试');
    store.tx(() => {
      const control = store.getReviewControl(task.id);
      if (control) store.saveReviewControl(task.id, { ...control, rounds: 0, infra_attempts: 0, fix_attempts: 0, next_attempt_at: null });
      else store.deleteReviewVerdicts(task.id);
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
  if (!acceptsAllIssues(project) && !issue.labels.includes(project.ready_label)) {
    throw new OpsError(`issue 缺少 ${project.ready_label} 标签`);
  }
  const intake = store.getIntake<IntakeState>(task.repo, task.issue_number);
  if (acceptsAllIssues(project) && (intake && (!intake.imported || intake.kind || intake.locked || intake.pending || intake.error) || issue.labels.some(l => ['agent-human-hold', 'agent-needs-human'].includes(l)))) throw new OpsError('Issue 仍有人工门禁或同步未完成');
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
    const latestIntake = store.getIntake<IntakeState>(task.repo, task.issue_number);
    if (acceptsAllIssues(project) && latestIntake && (latestIntake.kind || latestIntake.locked || latestIntake.pending || latestIntake.error)) throw new OpsError('重试期间人工状态已变化');
    // A retry means "judge the current state again". Dropping the recorded
    // verdicts is what makes that true: a task whose branch already has an
    // OPEN PR goes DISCOVERED → existing-PR → AWAITING_REVIEW, and the sha
    // idempotency would otherwise skip the unchanged head forever, leaving a
    // task that shows as "reviewing" but can never move.
    const control = store.getReviewControl(task.id);
    if (control) {
      const hash = approvalHash(issue);
      store.saveReviewControl(task.id, control.requirement_hash === hash
        ? { ...control, rounds: 0, infra_attempts: 0, fix_attempts: 0, next_attempt_at: null }
        : newReviewControl(hash));
      const last = store.runsForTask(task.id).at(-1);
      if (last) store.transition(last.run_id, last.phase, last.phase, { kind: 'review_budget_renewed', actor: 'human', previous_rounds: control.rounds, previous_infra_attempts: control.infra_attempts, previous_fix_attempts: control.fix_attempts });
    } else store.deleteReviewVerdicts(task.id);
    // A human retry re-approves the whole pipeline: discard any stale
    // review-fix intent so the new run starts clean.
    store.setTaskStatus(task.id, control && prNum ? (project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN') : 'DISCOVERED', { approved_hash: approvalHash(issue), pending_fix: null, ...(control ? { approved_sha: null, approved_by: null } : {}) });
  });
  await tracker.removeLabel(task.repo, task.issue_number, 'agent-blocked').catch(() => {});
  return `任务 ${task.repo}#${task.issue_number} 已重新排队（哈希 ${approvalHash(issue).slice(0, 12)}）`;
}

export interface ResolveDecisionParams {
  expected_updated_at: string;
  decision_version: string;
  head_sha: string;
  selected_option: string;
  authorization: string;
}

export function resolveReviewDecision(store: Store, config: AppConfig, tracker: OpsTracker, task: TaskRow, requestId: string, params: ResolveDecisionParams): Promise<string> {
  return withTaskOperation(store, task.id, async () => {
    const assertCurrent = () => {
      const current = store.getTaskById(task.id);
      if (!current || current.source !== 'issue' || current.status !== 'AWAITING_HUMAN' || current.updated_at !== params.expected_updated_at || store.activeRunForTask(task.id)) throw new OpsError('任务状态已变化，请刷新后回答');
      const intake = store.getIntake<IntakeState>(current.repo, current.issue_number);
      if (intake && (!intake.imported || intake.kind || intake.locked || intake.pending || intake.error || intake.external_hold || intake.external_needs)) throw new OpsError('Issue 仍有人工门禁或同步未完成');
      const control = store.getReviewControl(task.id);
      if (!control || control.requirement_hash !== params.decision_version || control.head_sha !== params.head_sha) throw new OpsError('决策版本或提交已变化，请重新评审');
      const request = unresolvedDecisions(control, params.head_sha).find(r => r.request_id === requestId && r.head_sha === params.head_sha);
      if (!request || !request.options.includes(params.selected_option)) throw new OpsError('决策问题已失效或选项不合法');
      if (!params.authorization.trim() || params.authorization.length > 4000 || /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----|(?:password|token|secret)\s*[:=]\s*\S+)/i.test(params.authorization)) throw new OpsError('请填写具体授权范围，不要提交密码、令牌或私钥');
      return { current, control, request };
    };
    const { current, control, request: answeredRequest } = assertCurrent();
    if (!config.projects.some(p => p.repo === current.repo)) throw new OpsError('项目不在配置中');
    const prNumber = Number(current.pr_url?.match(/\/pull\/(\d+)/)?.[1]);
    if (!prNumber || await tracker.getPrState(current.repo, prNumber) !== 'OPEN') throw new OpsError('关联 PR 已关闭、已合并或不存在');
    const issue = await tracker.getIssue(current.repo, current.issue_number);
    if (!issue || issue.state !== 'OPEN') throw new OpsError('Issue 已关闭或不存在');
    if (approvalHash(issue) !== control.requirement_hash || current.approved_hash !== control.requirement_hash) throw new OpsError('Issue 内容已变化，请重新确认需求');
    if (issue.labels.some(l => ['agent-human-hold', 'agent-needs-human', 'agent-running'].includes(l))) throw new OpsError('Issue 仍被人工锁定或其他运行持有');
    if (!tracker.getPrHeadSha || await tracker.getPrHeadSha(current.repo, prNumber) !== params.head_sha) throw new OpsError('PR 提交已变化或无法核验，请重新评审');
    store.tx(() => {
      const { control: latest, request } = assertCurrent();
      latest.resolutions.push({ request_id: requestId, requirement_hash: latest.requirement_hash, head_sha: params.head_sha, selected_option: params.selected_option, authorization: params.authorization.trim(), actor: 'authenticated-ui', created_at: new Date().toISOString(), scope: request.file ? [request.file] : [] });
      store.saveReviewControl(task.id, latest);
      const run = store.runsForTask(task.id).at(-1);
      if (run) store.transition(run.run_id, run.phase, run.phase, { kind: 'review_decision_resolved', request_id: requestId, head_sha: params.head_sha });
      const rejected = latest.decisions.some(request => request.type !== 'product_choice' && latest.resolutions.some(answer => answer.request_id === request.request_id && answer.requirement_hash === latest.requirement_hash && answer.head_sha === params.head_sha && answer.selected_option === '拒绝当前提交'));
      if (rejected) store.setTaskStatus(task.id, 'BLOCKED', { approved_sha: null, approved_by: null });
      else if (!unresolvedDecisions(latest, params.head_sha).length) store.setTaskStatus(task.id, config.projects.find(p => p.repo === current.repo)?.review_mode === 'manual' ? 'AWAITING_HUMAN' : 'AWAITING_REVIEW', { approved_sha: null, approved_by: null });
    });
    return answeredRequest.type !== 'product_choice' && params.selected_option === '拒绝当前提交' ? '已记录拒绝，当前提交已阻塞；修改实现并重新评审后再处理' : '决策已记录并绑定当前提交；全部问题回答后将重新核验，不会立即合并';
  });
}
