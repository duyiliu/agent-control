import { existsSync } from 'node:fs';
import { runProcessRisk } from '../proc.js';
import type { Store } from '../store/sqlite.js';
import type { AppLog } from '../telemetry/logging.js';
import type { Phase, RunRow, TaskRow } from '../types.js';
import type { Engine } from './engine.js';
import { approvalHash, type GitHubTracker } from '../tracker/github.js';
import { retryReview } from '../verify/review-policy.js';
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

/** Narrower deps for the shared park path — the engine's deferred-resume
 *  sweep reuses it without a full RecoveryDeps. */
export interface RecoveryParkingDeps {
  store: Store;
  tracker: GitHubTracker;
  appLog: AppLog;
  engine: Pick<Engine, 'notifyTaskAttention'>;
}

export interface RecoveryReport {
  resumed: string[];
  /** Safe to resume but held back by `server.max_concurrent`; the tick sweep takes them. */
  deferred: string[];
  recoveryRequired: { run_id: string; why: string }[];
  finalized: string[];
}

/**
 * Boot-time reconciliation. Runs left in active phases are classified:
 * - child possibly alive (PID + start-time identity match) -> RECOVERY_REQUIRED
 *   (never spawn a duplicate, never kill by PID alone)
 * - child gone -> resume idempotently from the saved phase
 * - PUBLISHING_PR -> check GitHub first: existing PR means the side effect
 *   already happened -> AWAITING_HUMAN; otherwise re-run the idempotent publish.
 *
 * Resumes go through `engine.resumeRun`: when the concurrency budget is full
 * the run is queued in the engine's deferred set and started by the tick
 * sweep, so a crash that left N runs cannot restart all N at once. Queuing
 * spends no resume budget — `Store.resumeRun` runs only at launch.
 */
export async function reconcile(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { store, appLog } = deps;
  const report: RecoveryReport = { resumed: [], deferred: [], recoveryRequired: [], finalized: [] };
  const budget = deps.config.server.max_resumes;

  const resumeNow = (run: RunRow, to: Phase) => {
    if (deps.engine.resumeRun(run.run_id, to)) report.resumed.push(run.run_id);
    else report.deferred.push(run.run_id);
  };

  for (const run of store.activeRuns()) {
    const task = store.getTaskById(run.task_id);
    if (!task) {
      store.endRun(run.run_id, 'FAILED', 'task row missing during recovery');
      continue;
    }

    const risk = await runProcessRisk(run, deps);
    if (risk) {
      // Cannot prove the child is dead — the agent-running label stays.
      await markRecoveryRequired(deps, task, run, risk);
      report.recoveryRequired.push({ run_id: run.run_id, why: risk });
      continue;
    }

    if (run.kind === 'review') {
      const control = store.getReviewControl(task.id);
      if (control) {
        store.tx(() => {
          if (run.cancel_requested) {
            store.endRun(run.run_id, 'CANCELED', 'explicit stop recovered');
            store.setTaskStatus(task.id, 'CANCELED');
          } else {
            const next = retryReview(control);
            store.saveReviewControl(task.id, next);
            store.addCheck({ run_id: run.run_id, kind: 'review', command: 'agent (review v2)', exit_code: null,
              verdict: 'ERROR', head_sha: run.head_sha, detail_json: JSON.stringify({ reason: 'service interrupted review', policy_version: 2 }) });
            store.endRun(run.run_id, 'FAILED', 'review execution interrupted by service restart');
            store.setTaskStatus(task.id, next.next_attempt_at ? 'AWAITING_REVIEW' : 'BLOCKED');
          }
        });
        report.finalized.push(run.run_id);
        continue;
      }
      // A review run is resumable whenever it still pins a head sha: the
      // site is re-materialized, no workspace required. Anything else
      // (missing sha, unknown phase) cannot safely continue.
      if (run.head_sha && (run.phase === 'CLAIMED' || run.phase === 'REVIEWING')) {
        if (run.resume_count >= budget) {
          await markRecoveryRequired(deps, task, run, 'review resume budget exhausted', true);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else {
          resumeNow(run, run.phase);
        }
      } else {
        await markRecoveryRequired(deps, task, run, `review run missing head_sha or in unexpected phase ${run.phase}`, true);
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
          await markRecoveryRequired(deps, task, run, why, true);
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
            await markRecoveryRequired(deps, task, run, why, true);
            report.recoveryRequired.push({ run_id: run.run_id, why });
            break;
          }
          const labelled = !!issue && issue.state === 'OPEN' && issue.labels.includes(project.ready_label);
          const hashOk = !!issue && (!task.approved_hash || approvalHash(issue) === task.approved_hash);
          if (labelled && hashOk && task.status === 'MERGING') {
            // A merge-conflict repair publishes back into MERGING carrying
            // its approval — finalizing to the review queue here would
            // bounce it with a stale approved_sha. Resume the publish phase
            // instead: the engine's mergeRepair path re-verifies and lands
            // the new head with the original approved_by.
            if (run.resume_count >= budget) {
              await markRecoveryRequired(deps, task, run, 'publish resume budget exhausted', true);
              report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
            } else {
              resumeNow(run, 'PUBLISHING_PR');
            }
          } else if (labelled && hashOk) {
            // Publish already happened. Reviews are separate runs now — an
            // auto-review project lands in AWAITING_REVIEW for dispatch; a
            // manual-review project parks straight on the human merge path.
            const afterPublish: Phase = project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN';
            const control = store.getReviewControl(task.id);
            let details: Awaited<ReturnType<GitHubTracker['getPrDetails']>> | undefined;
            try { if (control) details = await deps.tracker.getPrDetails(project.repo, existing.number); }
            catch (error) {
              await markRecoveryRequired(deps, task, run, `cannot pin published review evidence: ${String(error)}`, true);
              report.recoveryRequired.push({ run_id: run.run_id, why: 'publish evidence unavailable' });
              break;
            }
            store.tx(() => {
              if (control && details) {
                const next = { ...control, head_sha: details.headSha, base_sha: details.baseSha ?? null, decisions: [], next_attempt_at: null };
                delete next.assessment;
                store.saveReviewControl(task.id, next);
              }
              store.endRun(run.run_id, afterPublish, 'recovered: PR already exists');
              store.setTaskStatus(task.id, afterPublish, { pr_url: existing.url, branch, ...(control ? { approved_sha: null, approved_by: null } : {}) });
            });
            report.finalized.push(run.run_id);
          } else {
            try { await deps.tracker.closePr(project.repo, existing.number); } catch { /* best effort */ }
            const phase: Phase = labelled ? 'BLOCKED_APPROVAL_CHANGED' : 'CANCELED';
            store.endRun(run.run_id, phase, 'approval revoked before recovery finalize; PR closed');
            store.setTaskStatus(task.id, phase, { pr_url: existing.url });
            if (phase === 'BLOCKED_APPROVAL_CHANGED') {
              void deps.engine.notifyTaskAttention(task, phase, 'approval revoked before recovery finalize; PR closed');
            }
            report.finalized.push(run.run_id);
          }
          // The MERGING-repair resume above reports through resumed/deferred —
          // it is intentionally not counted as finalized.
        } else if (run.resume_count >= budget) {
          await markRecoveryRequired(deps, task, run, 'publish resume budget exhausted', true);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else {
          resumeNow(run, 'PUBLISHING_PR');
        }
        break;
      }

      case 'REVIEWING': {
        // Legacy pre-v4 code run: review is a separate run kind now. Send it
        // back through VERIFYING so the code state machine stays consistent.
        if (run.resume_count >= budget || !run.workspace || !existsSync(run.workspace)) {
          await markRecoveryRequired(deps, task, run, 'resume budget exhausted or workspace missing', true);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'budget/workspace' });
        } else {
          resumeNow(run, 'VERIFYING');
        }
        break;
      }

      case 'VERIFYING': {
        if (run.resume_count >= budget || !run.workspace || !existsSync(run.workspace)) {
          await markRecoveryRequired(deps, task, run, 'resume budget exhausted or workspace missing', true);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'budget/workspace' });
        } else {
          resumeNow(run, run.phase);
        }
        break;
      }

      case 'FIXING':
      case 'RUNNING':
      case 'PREPARING':
      case 'CLAIMED': {
        if (run.resume_count >= budget) {
          await markRecoveryRequired(deps, task, run, 'resume budget exhausted', true);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'resume budget' });
        } else if (run.phase === 'FIXING' || run.phase === 'RUNNING') {
          if (!run.workspace || !existsSync(run.workspace)) {
            await markRecoveryRequired(deps, task, run, 'workspace missing; cannot continue safely', true);
            report.recoveryRequired.push({ run_id: run.run_id, why: 'workspace missing' });
          } else {
            resumeNow(run, run.phase);
          }
        } else {
          resumeNow(run, 'PREPARING');
        }
        break;
      }

      default: {
        await markRecoveryRequired(deps, task, run, `unexpected active phase ${run.phase}`, true);
        report.recoveryRequired.push({ run_id: run.run_id, why: 'unexpected phase' });
      }
    }
  }

  appLog.event('reconcile_done', {
    resumed: report.resumed.length,
    deferred: report.deferred.length,
    recovery_required: report.recoveryRequired.length,
    finalized: report.finalized.length,
  });
  return report;
}

/**
 * Park a run + its task on RECOVERY_REQUIRED for a human. `safeToReleaseClaim`
 * may be true only when the caller already proved no child can still be alive
 * (runProcessRisk returned null): budget exhausted, workspace missing, GitHub
 * unreachable. A possibly-live pid, a stray process, or a failed scan always
 * keeps `agent-running` — the label is the cross-instance claim and a false
 * release would let a second scheduler work the same issue. Releasing is
 * best-effort: an API failure is logged but the local park stands.
 */
export async function markRecoveryRequired(
  deps: RecoveryParkingDeps,
  task: TaskRow,
  run: RunRow,
  why: string,
  safeToReleaseClaim = false,
) {
  deps.store.tx(() => {
    deps.store.endRun(run.run_id, 'RECOVERY_REQUIRED', why);
    deps.store.setTaskStatus(task.id, 'RECOVERY_REQUIRED');
  });
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
  // Only a code run behind an issue can hold `agent-running`; a bare-PR task
  // never owns that label and must never touch it.
  if (safeToReleaseClaim && run.kind === 'code' && task.source === 'issue') {
    try {
      await deps.tracker.removeLabel(task.repo, task.issue_number, 'agent-running');
    } catch (err) {
      deps.appLog.event('label_release_error', { task: task.id, run: run.run_id, error: String(err) });
    }
  }
}
