import { existsSync } from 'node:fs';
import { pidAlive, processStartedAt } from '../proc.js';
import type { Store } from '../store/sqlite.js';
import type { AppLog } from '../telemetry/logging.js';
import type { Phase, RunRow, TaskRow } from '../types.js';
import type { Engine } from './engine.js';
import type { GitHubTracker } from '../tracker/github.js';
import type { AppConfig } from '../types.js';

export interface RecoveryDeps {
  store: Store;
  config: AppConfig;
  tracker: GitHubTracker;
  appLog: AppLog;
  engine: Engine;
  isPidAlive?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => Promise<number | null>;
}

export interface RecoveryReport {
  resumed: string[];
  recoveryRequired: { run_id: string; why: string }[];
  finalized: string[];
}

const MAX_RESUMES = 2;

/**
 * Boot-time reconciliation. Runs left in active phases are classified:
 * - child possibly alive (PID + start-time identity match) -> RECOVERY_REQUIRED
 *   (never spawn a duplicate, never kill by PID alone)
 * - child gone -> resume idempotently from the saved phase
 * - PUBLISHING_PR -> check GitHub first: existing PR means the side effect
 *   already happened -> AWAITING_MERGE; otherwise re-run the idempotent publish.
 */
export async function reconcile(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { store, appLog } = deps;
  const alive = deps.isPidAlive ?? pidAlive;
  const startedAt = deps.processStartedAt ?? processStartedAt;
  const report: RecoveryReport = { resumed: [], recoveryRequired: [], finalized: [] };

  for (const run of store.activeRuns()) {
    const task = store.getTaskById(run.task_id);
    if (!task) {
      store.endRun(run.run_id, 'FAILED', 'task row missing during recovery');
      continue;
    }

    const childMightLive = await childAliveCheck(run, alive, startedAt);
    if (childMightLive) {
      markRecoveryRequired(store, task, run, 'child process still alive; refusing duplicate');
      report.recoveryRequired.push({ run_id: run.run_id, why: 'child alive' });
      continue;
    }

    switch (run.phase) {
      case 'PUBLISHING_PR': {
        const project = deps.config.projects.find((p) => p.repo === task.repo);
        const branch = run.branch ?? (project ? `${project.branch_prefix}${task.issue_number}` : null);
        let existing = null;
        if (project && branch) {
          existing = await deps.tracker.findPrForBranch(project.repo, branch).catch(() => null);
        }
        if (existing) {
          // Side effect already happened before the crash.
          store.endRun(run.run_id, 'AWAITING_MERGE', 'recovered: PR already exists');
          store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: existing.url });
          report.finalized.push(run.run_id);
        } else if (run.resume_count >= MAX_RESUMES) {
          markRecoveryRequired(store, task, run, 'publish resume budget exhausted');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else {
          resume(store, run, 'PUBLISHING_PR');
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
        break;
      }

      case 'VERIFYING':
      case 'REVIEWING': {
        if (run.resume_count >= MAX_RESUMES || !run.workspace || !existsSync(run.workspace)) {
          markRecoveryRequired(store, task, run, 'resume budget exhausted or workspace missing');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'budget/workspace' });
        } else {
          resume(store, run, run.phase);
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
        break;
      }

      case 'FIXING':
      case 'RUNNING':
      case 'PREPARING':
      case 'CLAIMED': {
        if (run.resume_count >= MAX_RESUMES) {
          markRecoveryRequired(store, task, run, 'resume budget exhausted');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else if (run.phase === 'FIXING' || run.phase === 'RUNNING') {
          if (!run.workspace || !existsSync(run.workspace)) {
            markRecoveryRequired(store, task, run, 'workspace missing; cannot continue safely');
            report.recoveryRequired.push({ run_id: run.run_id, why: 'workspace missing' });
          } else {
            resume(store, run, run.phase);
            deps.engine.resumeRun(run.run_id);
            report.resumed.push(run.run_id);
          }
        } else {
          resume(store, run, 'PREPARING');
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
        break;
      }

      default: {
        markRecoveryRequired(store, task, run, `unexpected active phase ${run.phase}`);
        report.recoveryRequired.push({ run_id: run.run_id, why: 'unexpected phase' });
      }
    }
  }

  appLog.event('reconcile_done', {
    resumed: report.resumed.length,
    recovery_required: report.recoveryRequired.length,
    finalized: report.finalized.length,
  });
  return report;
}

async function childAliveCheck(
  run: RunRow,
  alive: (pid: number) => boolean,
  startedAt: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  if (!run.pid || !run.process_identity) return false;
  if (!alive(run.pid)) return false;
  const [, startMsStr] = run.process_identity.split(':');
  const expectedMs = Number(startMsStr);
  if (!Number.isFinite(expectedMs)) {
    // Identity unverifiable while PID is alive -> assume it might be the child.
    return true;
  }
  const actual = await startedAt(run.pid);
  if (actual == null) {
    // Cannot prove it's someone else's process -> conservative.
    return true;
  }
  // PID was reused if the live process started notably after our recorded spawn.
  return Math.abs(actual - expectedMs) < 10_000;
}

function resume(store: Store, run: RunRow, phase: Phase) {
  store.tx(() => {
    store.db
      .prepare('UPDATE runs SET resume_count = resume_count + 1, pid = NULL, process_identity = NULL WHERE run_id = ?')
      .run(run.run_id);
    store.transition(run.run_id, run.phase, phase, { recovered: true });
  });
}

function markRecoveryRequired(store: Store, task: TaskRow, run: RunRow, why: string) {
  store.endRun(run.run_id, 'RECOVERY_REQUIRED', why);
  store.setTaskStatus(task.id, 'RECOVERY_REQUIRED');
}
