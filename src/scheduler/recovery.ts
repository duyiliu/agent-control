import { existsSync } from 'node:fs';
import { runProcessRisk } from '../proc.js';
import type { Store } from '../store/sqlite.js';
import type { AppLog } from '../telemetry/logging.js';
import type { Phase, RunRow, TaskRow } from '../types.js';
import type { Engine } from './engine.js';
import { approvalHash, type GitHubTracker } from '../tracker/github.js';
import type { AppConfig } from '../types.js';

export interface RecoveryDeps {
  store: Store;
  config: AppConfig;
  tracker: GitHubTracker;
  appLog: AppLog;
  engine: Engine;
  isPidAlive?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => Promise<number | null>;
  /** Scan for live processes referencing a path (orphan detection). */
  findProcs?: (needle: string) => Promise<number[] | null>;
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
  const report: RecoveryReport = { resumed: [], recoveryRequired: [], finalized: [] };

  for (const run of store.activeRuns()) {
    const task = store.getTaskById(run.task_id);
    if (!task) {
      store.endRun(run.run_id, 'FAILED', 'task row missing during recovery');
      continue;
    }

    const risk = await runProcessRisk(run, deps);
    if (risk) {
      markRecoveryRequired(deps, task, run, risk);
      report.recoveryRequired.push({ run_id: run.run_id, why: risk });
      continue;
    }

    if (run.kind === 'review') {
      // A review run is resumable whenever it still pins a head sha: the
      // site is re-materialized, no workspace required. Anything else
      // (missing sha, unknown phase) cannot safely continue.
      if (run.head_sha && (run.phase === 'CLAIMED' || run.phase === 'REVIEWING')) {
        if (run.resume_count >= MAX_RESUMES) {
          markRecoveryRequired(deps, task, run, 'review resume budget exhausted');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else {
          resume(store, run, run.phase);
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
      } else {
        markRecoveryRequired(deps, task, run, `review run missing head_sha or in unexpected phase ${run.phase}`);
        report.recoveryRequired.push({ run_id: run.run_id, why: 'unexpected phase' });
      }
      continue;
    }

    switch (run.phase) {
      case 'PUBLISHING_PR': {
        const project = deps.config.projects.find((p) => p.repo === task.repo)!;
        const branch = run.branch ?? (project ? `${project.branch_prefix}${task.issue_number}` : null);
        let existing;
        try {
          existing = project && branch ? await deps.tracker.findPrForBranch(project.repo, branch) : null;
        } catch (err) {
          const why = `cannot query PR during recovery; no external action taken: ${String(err).slice(0, 300)}`;
          markRecoveryRequired(deps, task, run, why);
          report.recoveryRequired.push({ run_id: run.run_id, why });
          break;
        }
        if (existing?.state === 'MERGED' || existing?.state === 'CLOSED') {
          const phase = existing.state === 'MERGED' ? 'COMPLETED' : 'BLOCKED';
          store.endRun(run.run_id, phase, `recovered: PR is ${existing.state}`);
          store.setTaskStatus(task.id, phase, { pr_url: existing.url, branch });
          report.finalized.push(run.run_id);
          break;
        }
        if (existing) {
          // Side effect already happened before the crash. Re-validate
          // approval — the crash may have landed between PR create and the
          // engine's post-create gate. If revoked, close the stray PR.
          let issue;
          try {
            issue = await deps.tracker.getIssue(project.repo, task.issue_number);
          } catch (err) {
            const why = `cannot confirm approval during recovery; PR left unchanged: ${String(err).slice(0, 300)}`;
            markRecoveryRequired(deps, task, run, why);
            report.recoveryRequired.push({ run_id: run.run_id, why });
            break;
          }
          const labelled = !!issue && issue.state === 'OPEN' && issue.labels.includes(project.ready_label);
          const hashOk = !!issue && (!task.approved_hash || approvalHash(issue) === task.approved_hash);
          if (labelled && hashOk) {
            // Publish already happened. Reviews are separate runs now — the
            // PR goes to AWAITING_MERGE and dispatchReviews picks it up.
            store.endRun(run.run_id, 'AWAITING_MERGE', 'recovered: PR already exists');
            store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: existing.url, branch });
          } else {
            try { await deps.tracker.closePr(project.repo, existing.number); } catch { /* best effort */ }
            const phase: Phase = labelled ? 'BLOCKED_APPROVAL_CHANGED' : 'CANCELED';
            store.endRun(run.run_id, phase, 'approval revoked before recovery finalize; PR closed');
            store.setTaskStatus(task.id, phase, { pr_url: existing.url });
            if (phase === 'BLOCKED_APPROVAL_CHANGED') {
              void deps.engine.notifyTaskAttention(task, phase, 'approval revoked before recovery finalize; PR closed');
            }
          }
          report.finalized.push(run.run_id);
        } else if (run.resume_count >= MAX_RESUMES) {
          markRecoveryRequired(deps, task, run, 'publish resume budget exhausted');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else {
          resume(store, run, 'PUBLISHING_PR');
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
        break;
      }

      case 'REVIEWING': {
        // Legacy pre-v4 code run: review is a separate run kind now. Send it
        // back through VERIFYING so the code state machine stays consistent.
        if (run.resume_count >= MAX_RESUMES || !run.workspace || !existsSync(run.workspace)) {
          markRecoveryRequired(deps, task, run, 'resume budget exhausted or workspace missing');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'budget/workspace' });
        } else {
          resume(store, run, 'VERIFYING');
          deps.engine.resumeRun(run.run_id);
          report.resumed.push(run.run_id);
        }
        break;
      }

      case 'VERIFYING': {
        if (run.resume_count >= MAX_RESUMES || !run.workspace || !existsSync(run.workspace)) {
          markRecoveryRequired(deps, task, run, 'resume budget exhausted or workspace missing');
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
          markRecoveryRequired(deps, task, run, 'resume budget exhausted');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else if (run.phase === 'FIXING' || run.phase === 'RUNNING') {
          if (!run.workspace || !existsSync(run.workspace)) {
            markRecoveryRequired(deps, task, run, 'workspace missing; cannot continue safely');
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
        markRecoveryRequired(deps, task, run, `unexpected active phase ${run.phase}`);
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

function resume(store: Store, run: RunRow, phase: Phase) {
  store.tx(() => {
    store.db
      .prepare('UPDATE runs SET resume_count = resume_count + 1, pid = NULL, process_identity = NULL WHERE run_id = ?')
      .run(run.run_id);
    store.transition(run.run_id, run.phase, phase, { recovered: true });
  });
}

function markRecoveryRequired(deps: RecoveryDeps, task: TaskRow, run: RunRow, why: string) {
  deps.store.endRun(run.run_id, 'RECOVERY_REQUIRED', why);
  deps.store.setTaskStatus(task.id, 'RECOVERY_REQUIRED');
  void deps.engine.notifyTaskAttention(task, 'RECOVERY_REQUIRED', why);
  // A stranded review run must not leave `agent-reviewing` on the PR — that
  // label suppresses all future review dispatch for the task.
  if (run.kind === 'review') {
    const prNum = (run.pr_url ?? task.pr_url)?.match(/\/pull\/(\d+)/)?.[1];
    if (prNum) {
      deps.tracker.removePrLabel(task.repo, Number(prNum), 'agent-reviewing')
        .catch(() => { /* best effort */ });
    }
  }
}
