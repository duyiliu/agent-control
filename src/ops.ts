import { approvalHash } from './tracker/github.js';
import { runProcessRisk, type ProcessSafetyDeps } from './proc.js';
import type { Store } from './store/sqlite.js';
import type { AppConfig, IssueData, Phase, TaskRow } from './types.js';
import { RUN_ACTIVE_PHASES } from './types.js';

/** Minimal tracker surface the shared stop/retry actions need. */
export interface OpsTracker {
  getIssue(repo: string, issueNumber: number): Promise<IssueData | null>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
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
  return `任务 ${task.repo}#${task.issue_number} 没有活动的运行（状态=${task.status}）`;
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
    if (run.phase === 'AWAITING_MERGE' || run.phase === 'COMPLETED') continue;
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
    store.setTaskStatus(task.id, 'DISCOVERED', { approved_hash: approvalHash(issue) });
  });
  await tracker.removeLabel(task.repo, task.issue_number, 'agent-blocked').catch(() => {});
  return `任务 ${task.repo}#${task.issue_number} 已重新排队（哈希 ${approvalHash(issue).slice(0, 12)}）`;
}
