import { approvalHash } from './tracker/github.js';
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
    return `cancel requested for run ${run.run_id}; the scheduler aborts it within one poll cycle`;
  }
  if ((RUN_ACTIVE_PHASES as readonly Phase[]).includes(task.status)) {
    store.setTaskStatus(task.id, 'CANCELED');
    return `task ${task.repo}#${task.issue_number} cancelled`;
  }
  return `task ${task.repo}#${task.issue_number} has no active run (status=${task.status})`;
}

export async function retryTask(
  store: Store,
  config: AppConfig,
  tracker: OpsTracker,
  task: TaskRow,
): Promise<string> {
  if (!RETRYABLE.includes(task.status)) {
    throw new OpsError(`task status ${task.status} is not retryable`);
  }
  if (store.activeRunForTask(task.id)) {
    throw new OpsError('an active run still exists; stop it first');
  }

  // Re-validate approval against the CURRENT issue content — a human
  // retry means "the current issue text is what I approve".
  const project = config.projects.find((p) => p.repo === task.repo);
  if (!project) throw new OpsError(`project ${task.repo} not in config`);
  const issue = await tracker.getIssue(task.repo, task.issue_number);
  if (!issue || issue.state !== 'OPEN') throw new OpsError('issue is closed or missing');
  if (!issue.labels.includes(project.ready_label)) {
    throw new OpsError(`issue lacks ${project.ready_label} label`);
  }

  store.setTaskStatus(task.id, 'DISCOVERED', { approved_hash: approvalHash(issue) });
  await tracker.removeLabel(task.repo, task.issue_number, 'agent-blocked').catch(() => {});
  return `task ${task.repo}#${task.issue_number} re-queued (hash ${approvalHash(issue).slice(0, 12)})`;
}
