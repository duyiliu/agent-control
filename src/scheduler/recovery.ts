import { existsSync } from 'node:fs';
import { findProcessesReferencing, pidAlive, processStartedAt } from '../proc.js';
import { findContainerStrays, resolveIsolation } from '../runners/container.js';
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
  /** Scan for live containers belonging to a run (container-isolated runs). */
  findContainers?: (runId: string) => Promise<string[] | null>;
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
      markRecoveryRequired(deps, task, run, 'child process still alive; refusing duplicate');
      report.recoveryRequired.push({ run_id: run.run_id, why: 'child alive' });
      continue;
    }

    // Orphan scan: the recorded child is gone, but a killed host may have left
    // grandchildren behind. Refuse to resume a phase that could have spawned
    // subprocesses while anything still references the worktree — and also
    // refuse when we cannot prove the worktree is clean. Container-isolated
    // runs get the same treatment for containers: a docker.exe death does not
    // imply the detached container died.
    const childPhases = ['RUNNING', 'FIXING', 'VERIFYING', 'REVIEWING', 'PUBLISHING_PR'];
    if (childPhases.includes(run.phase) && run.workspace && existsSync(run.workspace)) {
      const scan = deps.findProcs ?? findProcessesReferencing;
      const strays = await scan(run.workspace)
        .then((pids) => pids?.filter((p) => p !== process.pid) ?? null)
        .catch(() => null);
      if (strays === null) {
        markRecoveryRequired(deps, task, run, 'cannot verify no orphaned processes on worktree');
        report.recoveryRequired.push({ run_id: run.run_id, why: 'orphan scan failed' });
        continue;
      }
      if (strays.length > 0) {
        markRecoveryRequired(deps, task, run, `orphaned process(es) on worktree: ${strays.join(', ')}`);
        report.recoveryRequired.push({ run_id: run.run_id, why: 'orphans alive' });
        continue;
      }

      const project = deps.config.projects.find((p) => p.repo === task.repo);
      if (project && resolveIsolation(project, deps.config.agent) === 'docker') {
        const scanContainers =
          deps.findContainers ??
          ((runId: string) =>
            findContainerStrays(runId, { host: deps.config.agent.container?.host }));
        const containers = await scanContainers(run.run_id).catch(() => null);
        if (containers === null) {
          markRecoveryRequired(deps, task, run, 'cannot verify no orphaned containers on worktree');
          report.recoveryRequired.push({ run_id: run.run_id, why: 'container scan failed' });
          continue;
        }
        if (containers.length > 0) {
          markRecoveryRequired(deps, task, run, `orphaned container(s) on worktree: ${containers.join(', ')}`);
          report.recoveryRequired.push({ run_id: run.run_id, why: 'containers alive' });
          continue;
        }
      }
    }

    switch (run.phase) {
      case 'PUBLISHING_PR': {
        const project = deps.config.projects.find((p) => p.repo === task.repo)!;
        const branch = run.branch ?? (project ? `${project.branch_prefix}${task.issue_number}` : null);
        let existing = null;
        if (project && branch) {
          existing = await deps.tracker.findPrForBranch(project.repo, branch).catch(() => null);
        }
        if (existing) {
          // Side effect already happened before the crash. Re-validate
          // approval — the crash may have landed between PR create and the
          // engine's post-create gate. If revoked, close the stray PR.
          const issue = await deps.tracker.getIssue(project.repo, task.issue_number).catch(() => null);
          const labelled = !!issue && issue.state === 'OPEN' && issue.labels.includes(project.ready_label);
          const hashOk = !!issue && (!task.approved_hash || approvalHash(issue) === task.approved_hash);
          if (labelled && hashOk) {
            store.endRun(run.run_id, 'AWAITING_MERGE', 'recovered: PR already exists');
            store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: existing.url });
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

      case 'VERIFYING':
      case 'REVIEWING': {
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

function markRecoveryRequired(deps: RecoveryDeps, task: TaskRow, run: RunRow, why: string) {
  deps.store.endRun(run.run_id, 'RECOVERY_REQUIRED', why);
  deps.store.setTaskStatus(task.id, 'RECOVERY_REQUIRED');
  void deps.engine.notifyTaskAttention(task, 'RECOVERY_REQUIRED', why);
}
