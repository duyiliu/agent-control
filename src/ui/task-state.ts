import { parseReviewControl, unresolvedDecisions } from '../verify/review-policy.js';
import type { DecisionRequest } from '../types.js';
import type { AppConfig, RunRow, TaskRow } from '../types.js';
import { RUN_ACTIVE_PHASES } from '../types.js';
import type { IntakeState } from '../triage/intake.js';

export interface TaskActions {
  stop: boolean;
  retry: boolean;
  rereview: boolean;
  approve_merge: boolean;
}

export interface Attention {
  kind: 'decision' | 'approval' | 'execution_error' | 'recovery' | 'advisory' | 'hold';
  decisions?: DecisionRequest[];
  decision_version?: string;
  head_sha?: string;
  next_attempt_at?: string | null;
  summary: string;
  detail: string;
  next_step: string;
}

export function taskActions(task: TaskRow, active: boolean, intake: IntakeState | null, config?: AppConfig): TaskActions {
  const project = config?.projects.find(p => p.repo === task.repo);
  const hold = !!intake && (!intake.imported || !!intake.kind || intake.locked || !!intake.pending || !!intake.error || !!intake.external_hold || !!intake.external_needs);
  const control = parseReviewControl(task.review_control_json);
  const pendingDecision = control && (!control.head_sha || unresolvedDecisions(control, control.head_sha).length > 0 || control.decisions.some(request => request.type !== 'product_choice' && control.resolutions.some(answer => answer.request_id === request.request_id && answer.requirement_hash === control.requirement_hash && answer.head_sha === control.head_sha && answer.selected_option === '拒绝当前提交')));
  return {
    stop: active || RUN_ACTIVE_PHASES.includes(task.status) || ['MERGING', 'AWAITING_REVIEW'].includes(task.status) || task.status === 'DISCOVERED' && !!task.pending_fix,
    retry: !active && !intake && ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'].includes(task.status),
    rereview: !active && !hold && task.status === 'AWAITING_HUMAN' && !!task.pr_url && (task.source === 'pr' || project?.review_mode === 'auto'),
    approve_merge: !active && !hold && !pendingDecision && task.status === 'AWAITING_HUMAN' && !!task.pr_url && task.source === 'issue',
  };
}

export function taskAttention(task: TaskRow, last: RunRow | undefined, intake: IntakeState | null, reviewSummary = ''): Attention | null {
  const control = parseReviewControl(task.review_control_json);
  if (control?.head_sha && task.status === 'BLOCKED' && control.decisions.some(request => request.type !== 'product_choice' && control.resolutions.some(answer => answer.request_id === request.request_id && answer.requirement_hash === control.requirement_hash && answer.head_sha === control.head_sha && answer.selected_option === '拒绝当前提交'))) return { kind: 'decision', summary: '当前提交未获授权', detail: '你已拒绝当前提交，系统不会自动合并或用重试覆盖决定', next_step: '修改实现或确认新需求后重新评审' };
  if (control?.next_attempt_at && task.status === 'AWAITING_REVIEW') return { kind: 'execution_error', summary: '自动评审正在恢复', detail: '临时故障正在按预算重试', next_step: '到期后自动重试，可查看运行日志', next_attempt_at: control.next_attempt_at };
  if (control?.head_sha && task.status === 'AWAITING_HUMAN') {
    const decisions = unresolvedDecisions(control, control.head_sha);
    if (decisions.length) return { kind: 'decision', summary: `待你回答 ${decisions.length} 个具体问题`, detail: decisions.map(r => r.question).join('\n'), next_step: '逐项选择方案并说明授权范围；回答后重新核验', decisions, decision_version: control.requirement_hash, head_sha: control.head_sha };
  }
  if (!['AWAITING_HUMAN', 'BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'].includes(task.status)) return null;
  if (intake?.kind === 'deferred' || intake?.kind === 'skipped') return null;
  if (intake && (intake.kind === 'human' || intake.locked || intake.external_hold || intake.external_needs || intake.error || intake.pending)) {
    if (intake.pending || intake.error) return { kind: 'execution_error', summary: intake.pending ? '人工操作正在同步' : 'Issue 同步或恢复失败', detail: intake.error || intake.reason || 'Issue 存在人工门禁', next_step: intake.pending ? '等待同步完成；失败后可重试同步' : '核对原因后选择继续处理或解除锁定' };
    if (intake.locked || intake.external_hold) {
      const hold = intake.external_hold
        ? { summary: 'Issue 已被 agent-human-hold 锁定', detail: 'GitHub 标签 agent-human-hold（外部人工门禁）' }
        : { summary: 'Issue 已本地人工锁定', detail: '本地人工锁定，未派发' };
      return { kind: 'hold', ...hold, next_step: '在 GitHub 摘除标签，或在看板选择继续处理/解除锁定' };
    }
    return { kind: 'decision', summary: intake.external_needs ? 'Issue 被标记为需要人工' : 'Issue 已判定需要人工', detail: intake.external_needs ? 'GitHub 标签 agent-needs-human（外部人工门禁）' : intake.reason || '人工分流结论：需要人工处理', next_step: '核对原因后选择继续处理或解除锁定' };
  }
  const reason = last && (last.phase === task.status || task.source === 'pr' && task.status === 'AWAITING_HUMAN' && last.kind === 'review' && last.phase === 'COMPLETED') ? last.reason ?? '' : '';
  const detail = [reason, reviewSummary].filter(Boolean).join('\n');
  if (task.status === 'RECOVERY_REQUIRED') return { kind: 'recovery', summary: '需要核验旧进程', detail, next_step: '确认旧进程已退出，再重试任务' };
  if (task.status === 'BLOCKED_APPROVAL_CHANGED') return { kind: 'decision', summary: 'Issue 需求已变化', detail, next_step: '核对最新需求后继续处理' };
  if (/protocol-recovered|JSON-only|invalid review output|review infra:|review site|review diff unavailable|review diff is incomplete|review diff too large|bounded review capacity/.test(detail)) return { kind: 'execution_error', summary: '自动评审未能可靠完成', detail, next_step: '核对评审日志及运行环境后重新评审' };
  if (/checks infra:/.test(reason)) return { kind: 'execution_error', summary: '检查环境异常', detail, next_step: '修复依赖或执行环境后重试' };
  if (/checks failed|checks did not pass/.test(reason)) return { kind: 'execution_error', summary: '自动检查未通过', detail, next_step: '查看检查日志并继续修复' };
  if (/PR closed|PR already closed/.test(reason)) return { kind: 'execution_error', summary: '关联 PR 已关闭', detail, next_step: '确认仍需处理后，在 GitHub 重新打开 PR 再重试' };
  if (/repair budget|fix budget|budget exhausted/.test(detail)) return { kind: 'execution_error', summary: '自动修复预算已耗尽', detail, next_step: '核对剩余缺陷后决定人工修复或重新评审' };
  if (/publish|push failed|create pr/i.test(reason)) return { kind: 'execution_error', summary: '发布 PR 失败', detail, next_step: '检查远程仓库与凭据后重试' };
  if (/fix run produced no new commits/.test(detail)) return { kind: 'execution_error', summary: '修复未产生新提交', detail, next_step: '查看修复日志，确认阻塞原因后重试或人工修复' };
  if (/external PR review BLOCK/.test(detail)) return { kind: 'execution_error', summary: '独立 PR 评审未通过', detail, next_step: '在 GitHub 查看评审意见并修改 PR' };
  if (task.status === 'AWAITING_HUMAN') {
    if (task.source === 'pr') return { kind: 'advisory', summary: '独立 PR 已完成自动评审', detail, next_step: '在 GitHub 人工决定是否合并，或重新评审' };
    return { kind: 'approval', summary: /high risk|review requires human/.test(reason) ? '评审发现需要人工确认的风险' : '等待人工审阅或合并', detail, next_step: '核对评审意见后批准合并，或重新评审' };
  }
  return { kind: 'execution_error', summary: task.status === 'FAILED' ? '任务执行失败' : '任务被阻塞', detail: detail || '当前任务状态已变化，历史运行结论可能不再适用', next_step: task.pr_url ? '先查看 PR 当前状态和最新日志，再选择继续处理' : '查看最新日志后继续处理' };
}
