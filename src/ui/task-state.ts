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
  summary: string;
  detail: string;
  next_step: string;
}

export function taskActions(task: TaskRow, active: boolean, intake: IntakeState | null, config?: AppConfig): TaskActions {
  const project = config?.projects.find(p => p.repo === task.repo);
  const hold = !!intake && (!intake.imported || !!intake.kind || intake.locked || !!intake.pending || !!intake.error || !!intake.external_hold || !!intake.external_needs);
  return {
    stop: active || RUN_ACTIVE_PHASES.includes(task.status) || ['MERGING', 'AWAITING_REVIEW'].includes(task.status) || task.status === 'DISCOVERED' && !!task.pending_fix,
    retry: !active && !intake && ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'].includes(task.status),
    rereview: !active && !hold && task.status === 'AWAITING_HUMAN' && !!task.pr_url && (task.source === 'pr' || project?.review_mode === 'auto'),
    approve_merge: !active && task.status === 'AWAITING_HUMAN' && !!task.pr_url && task.source === 'issue',
  };
}

export function taskAttention(task: TaskRow, last: RunRow | undefined, intake: IntakeState | null, reviewSummary = ''): Attention | null {
  if (!['AWAITING_HUMAN', 'BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'].includes(task.status)) return null;
  if (intake?.kind === 'deferred' || intake?.kind === 'skipped') return null;
  if (intake && (intake.kind === 'human' || intake.locked || intake.external_hold || intake.external_needs || intake.error || intake.pending)) {
    return { summary: intake.pending ? '人工操作正在同步' : intake.error ? 'Issue 同步或恢复失败' : 'Issue 需要人工确认', detail: intake.error || intake.reason || 'Issue 存在人工门禁', next_step: intake.pending ? '等待同步完成；失败后可重试同步' : '核对原因后选择继续处理或解除锁定' };
  }
  const reason = last && (last.phase === task.status || task.source === 'pr' && task.status === 'AWAITING_HUMAN' && last.kind === 'review' && last.phase === 'COMPLETED') ? last.reason ?? '' : '';
  const detail = [reason, reviewSummary].filter(Boolean).join('\n');
  if (task.status === 'RECOVERY_REQUIRED') return { summary: '需要核验旧进程', detail, next_step: '确认旧进程已退出，再重试任务' };
  if (task.status === 'BLOCKED_APPROVAL_CHANGED') return { summary: 'Issue 需求已变化', detail, next_step: '核对最新需求后继续处理' };
  if (/protocol-recovered|JSON-only|invalid review output|review infra:|review site|review diff unavailable|review diff is incomplete|review diff too large|bounded review capacity/.test(detail)) return { summary: '自动评审未能可靠完成', detail, next_step: '核对评审日志及运行环境后重新评审' };
  if (/checks infra:/.test(reason)) return { summary: '检查环境异常', detail, next_step: '修复依赖或执行环境后重试' };
  if (/checks failed|checks did not pass/.test(reason)) return { summary: '自动检查未通过', detail, next_step: '查看检查日志并继续修复' };
  if (/PR closed|PR already closed/.test(reason)) return { summary: '关联 PR 已关闭', detail, next_step: '确认仍需处理后，在 GitHub 重新打开 PR 再重试' };
  if (task.status === 'AWAITING_HUMAN') {
    if (task.source === 'pr') return { summary: '独立 PR 已完成自动评审', detail, next_step: '在 GitHub 人工决定是否合并，或重新评审' };
    return { summary: /high risk|review requires human/.test(reason) ? '评审发现需要人工确认的风险' : '等待人工审阅或合并', detail, next_step: '核对评审意见后批准合并，或重新评审' };
  }
  return { summary: task.status === 'FAILED' ? '任务执行失败' : '任务被阻塞', detail: detail || '当前任务状态已变化，历史运行结论可能不再适用', next_step: task.pr_url ? '先查看 PR 当前状态和最新日志，再选择继续处理' : '查看最新日志后继续处理' };
}
