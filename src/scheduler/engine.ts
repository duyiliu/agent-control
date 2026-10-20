import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Store } from '../store/sqlite.js';
import { RunLog, type AppLog } from '../telemetry/logging.js';
import { approvalHash, GitHubTracker } from '../tracker/github.js';
import { GitWorkspace } from '../workspace/git.js';
import { openPiCoderSession, type CoderSession, type CoderSessionOpts, type CoderTurn } from '../runners/session.js';
import { PI_ALL_TOOLS } from '../runners/pi.js';
import { runChecks, type ChecksSummary } from '../verify/checks.js';
import { runReview, ReviewInfraError } from '../verify/review.js';
import { publishDraftPr, PublishError } from '../publish/pr.js';
import { buildCoderPrompt, buildFixPrompt, type PromptContext } from './prompts.js';
import type { AppConfig, IssueData, Phase, ProjectConfig, ReviewResult, RunRow, TaskRow } from '../types.js';
import { RUN_ACTIVE_PHASES } from '../types.js';

export interface EngineDeps {
  store: Store;
  config: AppConfig;
  tracker: GitHubTracker;
  workspace: GitWorkspace;
  appLog: AppLog;
  /** Install dir of agent-control (for WORKFLOW.md). */
  installDir: string;
  openCoderSessionFn?: (opts: CoderSessionOpts) => CoderSession;
  runReviewFn?: typeof runReview;
  runChecksFn?: typeof runChecks;
}

const TERMINAL_FOR_TASK: Phase[] = [
  'AWAITING_MERGE', 'COMPLETED', 'BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED',
];

/** Task states a human must look at — surfaced as a GitHub issue comment. */
const ATTENTION_PHASES: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'];

/** Compact elapsed span for issue comments; a null `to` means "until now". */
function fmtSpan(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class Engine {
  private controllers = new Map<string, AbortController>();
  private inFlight = new Set<string>(); // run_ids currently executing in this process
  private openCoderSessionFn: NonNullable<EngineDeps['openCoderSessionFn']>;
  private runReviewFn: NonNullable<EngineDeps['runReviewFn']>;
  private runChecksFn: NonNullable<EngineDeps['runChecksFn']>;
  private ticking = false;

  constructor(private deps: EngineDeps) {
    this.openCoderSessionFn = deps.openCoderSessionFn ?? openPiCoderSession;
    this.runReviewFn = deps.runReviewFn ?? runReview;
    this.runChecksFn = deps.runChecksFn ?? runChecks;
  }

  private get store() { return this.deps.store; }
  private get config() { return this.deps.config; }
  private get tracker() { return this.deps.tracker; }
  private get workspace() { return this.deps.workspace; }
  private get appLog() { return this.deps.appLog; }

  isRunning(runId: string) { return this.inFlight.has(runId); }
  activeCount() { return this.inFlight.size; }

  /** Abort an in-flight run (used by shutdown and the cancel sweep). */
  abortRun(runId: string, why = 'cancelled') {
    const ctl = this.controllers.get(runId);
    if (ctl) ctl.abort(why);
  }

  // ---------------- poll cycle ----------------

  async tick(): Promise<void> {
    this.sweepCancels();
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.mergeReconcile();
      await this.discover();
      await this.dispatch();
    } finally {
      this.ticking = false;
    }
  }

  /** AWAITING_MERGE tasks: human merge/close state is written back by tracker. */
  private async mergeReconcile() {
    for (const task of this.store.listTasks('AWAITING_MERGE')) {
      try {
        const project = this.projectFor(task.repo);
        if (!project) continue;
        const prNum = prNumberFromUrl(task.pr_url) ?? undefined;
        const state = prNum
          ? await this.tracker.getPrState(project.repo, prNum)
          : await this.tracker.findPrForBranch(project.repo, task.branch ?? '').then((p) => p?.state ?? 'OPEN');
        if (state === 'MERGED') {
          this.setTaskStatus(task.id, 'COMPLETED');
          this.appLog.event('task_completed', { task: task.id, repo: task.repo, issue: task.issue_number });
          await this.notifyTaskCompleted(task);
          await this.cleanupMerged(project, task);
        } else if (state === 'CLOSED') {
          this.setTaskStatus(task.id, 'BLOCKED');
          this.appLog.event('task_blocked_pr_closed', { task: task.id });
        }
      } catch (err) {
        this.appLog.event('reconcile_error', { task: task.id, error: String(err) });
        this.recordError('reconcile_error', err);
      }
    }
  }

  /** Register newly agent-ready issues; detect approval drift on waiting tasks. */
  private async discover() {
    for (const project of this.config.projects) {
      let issues: IssueData[];
      try {
        issues = await this.tracker.listReadyIssues(project.repo, project.ready_label);
      } catch (err) {
        this.appLog.event('discover_error', { repo: project.repo, error: String(err) });
        this.recordError('discover_error', err);
        continue;
      }
      for (const issue of issues) {
        const { task, created } = this.store.upsertDiscovered({
          repo: project.repo,
          issue_number: issue.number,
          issue_title: issue.title,
          issue_url: issue.url,
        });
        if (created) {
          this.appLog.event('task_discovered', { repo: project.repo, issue: issue.number });
          continue;
        }
        // Approval drift on a waiting task: hash changed while DISCOVERED.
        if (task.status === 'DISCOVERED' && task.approved_hash) {
          const h = approvalHash(issue);
          if (h !== task.approved_hash) {
            this.setTaskStatus(task.id, 'BLOCKED_APPROVAL_CHANGED');
            this.appLog.event('approval_drift', { task: task.id });
            await this.labelQuietly(project.repo, issue.number, 'add', 'agent-blocked');
          }
        }
      }
    }
  }

  /** Stop runs whose cancel flag was set (by `agent-control stop`). */
  sweepCancels() {
    for (const run of this.store.runsWithCancelRequested()) {
      this.abortRun(run.run_id, 'cancel_requested');
    }
  }

  private async dispatch() {
    const max = this.config.server.max_concurrent;
    for (const task of this.store.listTasks('DISCOVERED')) {
      if (this.activeCount() >= max) return;
      const project = this.projectFor(task.repo);
      if (!project) continue;
      if (this.store.activeRunForTask(task.id)) continue;
      try {
        await this.tryDispatch(task, project);
      } catch (err) {
        this.appLog.event('dispatch_error', { task: task.id, error: String(err) });
        this.recordError('dispatch_error', err);
      }
    }
  }

  /** Gate check + claim + launch for one task. All gating failures are explicit. */
  private async tryDispatch(task: TaskRow, project: ProjectConfig) {
    const issue = await this.tracker.getIssue(project.repo, task.issue_number);
    if (!issue || issue.state !== 'OPEN') {
      this.setTaskStatus(task.id, 'CANCELED');
      this.appLog.event('dispatch_skip', { task: task.id, why: 'issue closed or missing' });
      return;
    }
    if (!issue.labels.includes(project.ready_label)) {
      this.setTaskStatus(task.id, 'CANCELED');
      this.appLog.event('dispatch_skip', { task: task.id, why: 'ready label revoked' });
      return;
    }
    // Another scheduler instance claimed it — stay DISCOVERED; the winner's
    // PR reconciles this task via the existing-PR path below.
    if (issue.labels.includes('agent-running')) {
      this.appLog.event('dispatch_skip', { task: task.id, why: 'claimed by another instance' });
      return;
    }

    const hash = approvalHash(issue);
    if (task.approved_hash == null) {
      this.store.setApprovedHash(task.id, hash);
    } else if (task.approved_hash !== hash) {
      this.setTaskStatus(task.id, 'BLOCKED_APPROVAL_CHANGED');
      await this.labelQuietly(project.repo, issue.number, 'add', 'agent-blocked');
      return;
    }

    // Declared dependencies must be closed/complete before dispatch.
    for (const depNum of parseDependsOn(issue.body)) {
      const depTask = this.store.getTask(project.repo, depNum);
      if (depTask && depTask.status === 'COMPLETED') continue;
      const depIssue = await this.tracker.getIssue(project.repo, depNum).catch(() => null);
      if (!depIssue || depIssue.state !== 'CLOSED') {
        this.appLog.event('dispatch_skip', { task: task.id, why: `dependency #${depNum} not complete` });
        return;
      }
    }

    const branch = `${project.branch_prefix}${task.issue_number}`;
    const existingPr = await this.tracker.findPrForBranch(project.repo, branch);
    if (existingPr) {
      if (existingPr.state === 'CLOSED') {
        this.store.setTaskStatus(task.id, 'BLOCKED', { branch, pr_url: existingPr.url });
        void this.notifyTaskAttention(task, 'BLOCKED', 'PR is closed; reopen it or create a new issue before retrying');
        this.appLog.event('dispatch_skip', { task: task.id, why: 'PR is closed; reopen it or create a new issue before retrying' });
        return;
      }
      if (existingPr.state === 'MERGED') {
        this.setTaskStatus(task.id, 'COMPLETED', { branch, pr_url: existingPr.url });
        this.appLog.event('dispatch_skip', { task: task.id, why: `PR already merged: ${existingPr.url}` });
        return;
      }
      if (this.store.hasReviewPass(task.id)) {
        this.setTaskStatus(task.id, 'AWAITING_MERGE', { branch, pr_url: existingPr.url });
        await this.labelQuietly(project.repo, issue.number, 'add', 'agent-pr');
        this.appLog.event('dispatch_skip', { task: task.id, why: `PR already exists: ${existingPr.url}` });
        return;
      }
      // PR exists but was never reviewed (e.g. retry after a crash): fall
      // through and claim a run that goes PREPARING → VERIFYING → review.
      this.store.setTaskStatus(task.id, 'DISCOVERED', { branch, pr_url: existingPr.url });
      this.appLog.event('dispatch_skip', { task: task.id, why: `PR exists but has no review PASS; re-entering verification: ${existingPr.url}` });
    }

    const run = this.store.claimRun(task.id);
    this.store.updateRunFields(run.run_id, { branch, pr_url: existingPr?.url ?? null });
    await this.labelQuietly(project.repo, issue.number, 'add', 'agent-running');
    await this.tracker.addComment(project.repo, issue.number,
      `agent-control: 已领取（\`${hostname()}\`）`).catch((err) => {
      this.appLog.event('comment_error', { task: task.id, error: String(err) });
    });
    this.appLog.event('run_claimed', { run: run.run_id, task: task.id, attempt: run.attempt });
    this.launch(run.run_id);
  }

  /** Resume a run left in an active phase by a previous process. */
  resumeRun(runId: string) {
    this.launch(runId);
  }

  private launch(runId: string) {
    if (this.inFlight.has(runId)) return;
    this.inFlight.add(runId);
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    void this.runTask(runId, ctl.signal)
      .catch((err) => {
        this.appLog.event('run_crashed', { run: runId, error: String(err) });
        this.recordError('run_crashed', err);
        try {
          const run = this.store.getRun(runId);
          if (run && RUN_ACTIVE_PHASES.includes(run.phase)) {
            this.store.endRun(runId, 'FAILED', `engine crash: ${String(err).slice(0, 500)}`);
            const task = this.store.getTaskById(run.task_id);
            if (task && task.status === 'RUNNING') this.setTaskStatus(task.id, 'FAILED');
          }
        } catch (e2) {
          this.appLog.event('run_crashed_cleanup_failed', { run: runId, error: String(e2) });
        }
      })
      .finally(() => {
        this.inFlight.delete(runId);
        this.controllers.delete(runId);
      });
  }

  // ---------------- per-run state machine ----------------

  private async runTask(runId: string, signal: AbortSignal) {
    const store = this.store;
    const run = store.getRun(runId);
    if (!run) return;
    const task = store.getTaskById(run.task_id);
    if (!task) { store.endRun(runId, 'FAILED', 'task row missing'); return; }
    const project = this.projectFor(task.repo);
    if (!project) { this.finish(run, task, 'FAILED', 'project removed from config'); return; }

    if (task.status === 'DISCOVERED') store.setTaskStatus(task.id, 'RUNNING');
    const log = this.logFor(run);
    const heartbeat = setInterval(() => {
      try { store.heartbeat(runId); } catch { /* db closed during shutdown */ }
    }, 10_000);

    const aborted = () => signal.aborted || store.getRun(runId)?.cancel_requested === 1;

    // One conversation per run: FIXING continues the turn that produced the
    // failing diff instead of re-priming a cold process with the same facts.
    const coderRef: { current: { session: CoderSession; logPath: string } | null } = { current: null };

    try {
      let phase: Phase = run.phase;
      // Lazily populated context shared by phases.
      const ctx = await this.makePromptContext(run, task, project);
      let worktreePath = run.workspace ?? '';
      let lastFailureEvidence = '';
      let verifiedHead: string | null = null;

      const ensureCoder = () => {
        if (coderRef.current) return coderRef.current;
        const artifactsDir = this.artifactsDirFor(run);
        mkdirSync(artifactsDir, { recursive: true });
        const stamp = Date.now();
        const logPath = join(artifactsDir, `agent-${stamp}.jsonl`);
        const session = this.openCoderSessionFn({
          workdir: worktreePath,
          agentConfig: this.config.agent,
          model: this.config.agent.model,
          thinking: this.config.agent.reasoning_effort,
          tools: PI_ALL_TOOLS,
          logPath,
          lastMessagePath: join(artifactsDir, `coder-last-${stamp}.txt`),
          onSpawn: (pid, identity) => this.store.updateRunFields(run.run_id, { pid, process_identity: identity }),
        });
        coderRef.current = { session, logPath };
        return coderRef.current;
      };

      while (RUN_ACTIVE_PHASES.includes(phase)) {
        if (aborted()) { this.finish(run, task, 'CANCELED', 'cancelled'); return; }

        switch (phase) {
          case 'CLAIMED': {
            store.transition(runId, phase, (phase = 'PREPARING'));
            break;
          }

          case 'PREPARING': {
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval gate failed at prepare'); return; }
            const wt = await this.workspace.ensureWorktree({
              repoDir: project.local_repo,
              branch: run.branch ?? `${project.branch_prefix}${task.issue_number}`,
              baseBranch: project.base_branch,
              worktreePath: this.worktreePathFor(project, task),
            });
            worktreePath = wt.path;
            store.updateRunFields(runId, { workspace: wt.path, branch: run.branch ?? `${project.branch_prefix}${task.issue_number}` });
            // An existing PR with no review PASS skips coding and goes
            // straight to verification: the code is already on the branch.
            store.transition(runId, phase, (phase = task.pr_url ? 'VERIFYING' : 'RUNNING'));
            break;
          }

          case 'RUNNING': {
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed during run'); return; }
            const turn = ensureCoder();
            const res = await this.coderTurn(run, log, turn, buildCoderPrompt(ctx), 'RUNNING', signal);
            if (res.aborted) { this.finish(run, task, 'CANCELED', 'cancelled'); return; }
            if (!res.ok) {
              this.finish(run, task, 'FAILED', res.timedOut
                ? `agent timeout: exceeded ${this.config.server.max_task_minutes}m`
                : `agent failed: ${res.error ?? `exit ${res.exitCode}`}`);
              return;
            }
            await this.commitLeftovers(run, log, worktreePath, task);
            store.transition(runId, phase, (phase = 'VERIFYING'));
            break;
          }

          case 'VERIFYING': {
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed before checks'); return; }
            const headBeforeChecks = await this.workspace.head(worktreePath);
            store.transition(runId, phase, phase, {
              kind: 'checks_started', head_sha: headBeforeChecks,
              commands: project.checks.map((check) => check.argv.join(' ')),
            });
            const summary = await this.callChecks(run, log, worktreePath, signal);
            const headAfterChecks = await this.workspace.head(worktreePath).catch(() => null);
            const checksWorktreeClean = !(await this.workspace.isDirty(worktreePath));
            store.transition(runId, phase, phase, {
              kind: 'checks_completed', head_sha: headBeforeChecks, head_sha_after: headAfterChecks,
              worktree_clean: checksWorktreeClean, ok: summary.ok, aborted: summary.aborted,
              infra_error: summary.infraError,
              outcomes: summary.outcomes.map((outcome) => ({ command: outcome.command, exit_code: outcome.exitCode, timed_out: outcome.timedOut })),
            });
            if (aborted() || summary.aborted) { this.finish(run, task, 'CANCELED', 'cancelled during checks'); return; }
            if (headAfterChecks !== headBeforeChecks || !checksWorktreeClean) {
              this.finish(run, task, 'BLOCKED', 'code changed during checks; verification does not match the worktree');
              return;
            }
            if (summary.infraError) { this.finish(run, task, 'FAILED', `checks infra: ${summary.infraError}`); return; }
            if (summary.ok) {
              verifiedHead = headBeforeChecks;
              store.transition(runId, phase, (phase = 'PUBLISHING_PR'), { head_sha: verifiedHead });
            } else {
              lastFailureEvidence = summary.failureEvidence;
              if (this.canFix(run)) {
                store.transition(runId, phase, (phase = 'FIXING'), { return_to: 'VERIFYING', head_sha: headBeforeChecks });
                this.setReturnPhase(runId, 'VERIFYING');
              } else {
                this.finish(run, task, 'BLOCKED', 'checks failed; fix budget exhausted');
                return;
              }
            }
            break;
          }

          case 'REVIEWING': {
            // run/task are snapshots taken at launch; PUBLISHING_PR writes the
            // PR url to the DB mid-run, so re-read instead of trusting them.
            const prUrl = store.getRun(runId)?.pr_url ?? run.pr_url ?? task.pr_url;
            if (!verifiedHead) {
              store.transition(runId, phase, (phase = 'VERIFYING'), { recovered: true, reason: 'revalidate before review after restart' });
              break;
            }
            if (!prUrl) {
              store.transition(runId, phase, (phase = 'PUBLISHING_PR'), { recovered: true, reason: 'publish before review' });
              break;
            }
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed before review'); return; }
            let diffEvidence: string;
            try {
              diffEvidence = await this.workspace.diffVsBase(worktreePath, project.base_branch);
              mkdirSync(this.artifactsDirFor(run), { recursive: true });
              writeFileSync(join(this.artifactsDirFor(run), 'review-diff.patch'), diffEvidence, 'utf8');
            } catch (err) {
              this.finish(run, task, 'FAILED', `review diff unavailable: ${String(err).slice(0, 300)}`);
              return;
            }
            // Record HEAD pre-review: `status --porcelain` alone cannot see
            // commits/resets/ref moves by the unsandboxed reviewer.
            const headBefore = await this.workspace.head(worktreePath).catch(() => null);
            if (headBefore !== verifiedHead || await this.workspace.isDirty(worktreePath)) {
              this.finish(run, task, 'BLOCKED', 'code changed after publish; refusing review on stale verification');
              return;
            }
            store.transition(runId, phase, phase, { kind: 'review_started', head_sha: headBefore, pr_url: prUrl });
            const prNumber = prNumberFromUrl(prUrl);
            if (prNumber) await this.setPrLabel(project.repo, prNumber, true);
            let reviewOutcome: Awaited<ReturnType<typeof runReview>> | undefined;
            let reviewError: unknown;
            try {
              reviewOutcome = await this.runReviewFn(ctx, this.testEvidenceFor(run, verifiedHead), diffEvidence, {
                agentConfig: this.config.agent,
                timeoutMs: this.config.server.max_task_minutes * 60_000,
                artifactsDir: this.artifactsDirFor(run), signal, headSha: verifiedHead,
                onSpawn: (pid, identity) => store.updateRunFields(runId, { pid, process_identity: identity }),
              });
            } catch (err) { reviewError = err; }
            if (prNumber) await this.setPrLabel(project.repo, prNumber, false);
            // A failed reviewer can still have tampered with the worktree.
            const headAfter = await this.workspace.head(worktreePath).catch(() => null);
            const headMoved = headBefore === null || headAfter === null || headAfter !== headBefore;
            if (headMoved || (await this.workspace.isDirty(worktreePath))) {
              this.finish(run, task, 'BLOCKED', headMoved
                ? 'branch HEAD moved during review; refusing to continue'
                : 'worktree modified during review; refusing to continue');
              return;
            }
            if (aborted()) { this.finish(run, task, 'CANCELED', 'cancelled during review'); return; }
            if (!reviewOutcome) {
              store.addCheck({ run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
                artifact_path: reviewError instanceof ReviewInfraError ? reviewError.logPath : undefined, verdict: 'ERROR' });
              store.transition(runId, phase, phase, { kind: 'review_completed', head_sha: headBefore,
                head_sha_after: headAfter, verdict: 'ERROR', error: String(reviewError) });
              this.finish(run, task, 'FAILED', `review infra: ${String(reviewError).slice(0, 400)}`);
              return;
            }
            const { result, logPath } = reviewOutcome;
            store.addCheck({ run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
              artifact_path: logPath, verdict: result.verdict });
            store.transition(runId, phase, phase, { kind: 'review_completed', head_sha: headBefore,
              head_sha_after: headAfter, verdict: result.verdict, risk: result.risk,
              summary: result.summary, artifact_path: logPath });
            if (result.verdict === 'PASS') {
              const riskReasons = this.assessRisk(diffEvidence, result.risk);
              if (riskReasons.length > 0) {
                if (prNumber) {
                  await this.tracker.commentPr(project.repo, prNumber, this.riskComment(result, riskReasons))
                    .catch((err) => this.appLog.event('pr_comment_error', { run: run.run_id, error: String(err) }));
                }
                await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
                this.finish(run, task, 'AWAITING_MERGE', `review PASS but high risk: ${riskReasons.join('; ')}`, { pr_url: prUrl });
                return;
              }
              if (prNumber && this.config.approvals.auto_merge.enabled) {
                await this.autoMerge(run, task, project, prNumber, prUrl, headBefore);
                return;
              }
              this.finish(run, task, 'AWAITING_MERGE', 'review PASS', { pr_url: prUrl });
              return;
            } else if (result.verdict === 'HUMAN_REVIEW_REQUIRED' || !result.findings.some((finding) => finding.trim())) {
              this.finish(run, task, 'BLOCKED', `review requires human: ${result.summary}; no automatic repair without concrete findings`, { pr_url: prUrl });
              return;
            } else if (this.canFix(run)) {
              lastFailureEvidence = `Review BLOCK: ${result.summary}\n${result.findings.join('\n')}`;
              store.transition(runId, phase, (phase = 'FIXING'), { return_to: 'VERIFYING', head_sha: headAfter, verdict: result, pr_url: prUrl });
              this.setReturnPhase(runId, 'VERIFYING');
            } else {
              this.finish(run, task, 'BLOCKED', `review blocked, fix budget exhausted: ${result.summary}`, { pr_url: prUrl });
              return;
            }
            break;
          }

          case 'FIXING': {
            if (!lastFailureEvidence) {
              store.transition(runId, phase, (phase = 'VERIFYING'), { recovered: true, reason: 'refresh failure evidence before another repair' });
              break;
            }
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed before repair'); return; }
            this.store.bumpRunFixCount(runId);
            const evidence = lastFailureEvidence;
            const turn = ensureCoder();
            const res = await this.coderTurn(run, log, turn, buildFixPrompt(ctx, evidence), 'FIXING', signal);
            if (res.aborted) { this.finish(run, task, 'CANCELED', 'cancelled'); return; }
            if (!res.ok) {
              this.finish(run, task, 'FAILED', res.timedOut ? 'fix turn timed out' : `fix turn failed: ${res.error ?? `exit ${res.exitCode}`}`);
              return;
            }
            await this.commitLeftovers(run, log, worktreePath, task);
            verifiedHead = null;
            this.setReturnPhase(runId, null);
            store.transition(runId, phase, (phase = 'VERIFYING'));
            break;
          }

          case 'PUBLISHING_PR': {
            if (!verifiedHead) {
              store.transition(runId, phase, (phase = 'VERIFYING'), { recovered: true, reason: 'revalidate before publishing after restart' });
              break;
            }
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed before publish'); return; }
            const issue = (await this.tracker.getIssue(project.repo, task.issue_number))!;
            const prBody = this.buildPrBody(run, task, issue, verifiedHead);
            try {
              const pr = await publishDraftPr({
                project, worktreePath, branch: run.branch ?? `${project.branch_prefix}${task.issue_number}`,
                issue, prBody, workspace: this.workspace, tracker: this.tracker, expectedHead: verifiedHead,
                beforeCreate: async () => aborted() ? 'CANCELED' : this.gateApproval(project, task),
              });
              store.updateRunFields(runId, { pr_url: pr.url });
              run.pr_url = pr.url;
              // Post-create check: no atomic approve+publish exists on
              // GitHub, so bound the residual window — if approval was
              // revoked during publish, close the PR we just created.
              const postGate = await this.gateApproval(project, task);
              if (postGate !== 'ok') {
                try { await this.tracker.closePr(project.repo, pr.number); } catch { /* best effort */ }
                this.finish(run, task, postGate, 'approval revoked just after PR create; PR closed');
                return;
              }
              store.transition(runId, phase, phase, { kind: 'pr_published', head_sha: verifiedHead, pr_url: pr.url });
              await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-pr');
              store.transition(runId, phase, (phase = 'REVIEWING'), { head_sha: verifiedHead, pr_url: pr.url });
              break;
            } catch (err) {
              if (err instanceof PublishError && err.reason === 'approval_revoked') {
                if (aborted()) { this.finish(run, task, 'CANCELED', 'cancelled before PR create'); return; }
                // Re-evaluate to pick the right terminal phase.
                const gate = await this.gateApproval(project, task);
                this.finish(run, task, gate === 'ok' ? 'BLOCKED' : gate, 'approval revoked during publish');
                return;
              }
              if (err instanceof PublishError && (err.reason === 'uncommitted_changes' || err.reason === 'head_changed')) {
                this.finish(run, task, 'BLOCKED', `code changed after verification: ${err.message}`);
                return;
              }
              this.finish(run, task, 'FAILED', `publish failed: ${String(err).slice(0, 500)}`);
              return;
            }
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      await coderRef.current?.session.close().catch(() => { /* run already terminal */ });
    }
  }

  // ---------------- helpers ----------------

  /**
   * Host-side fallback commit: the agent's sandbox may block `git commit`
   * (observed on Windows, exit 0xC0000142). Commit leftovers verbatim so
   * later phases (review diff, publish) see a clean, committed state.
   */
  private async commitLeftovers(run: RunRow, log: RunLog, worktreePath: string, task: TaskRow) {
    try {
      const msg = `agent-control: commit uncommitted agent work for issue #${task.issue_number}`;
      if (await this.workspace.commitAll(worktreePath, msg)) {
        log.event('host_fallback_commit', { run: run.run_id });
      }
    } catch (err) {
      log.event('host_fallback_commit_failed', { run: run.run_id, error: String(err).slice(0, 300) });
      throw err;
    }
    if (await this.workspace.isDirty(worktreePath)) throw new Error('worktree still dirty before verification');
  }


  private async makePromptContext(run: RunRow, task: TaskRow, project: ProjectConfig): Promise<PromptContext> {
    const issue = await this.tracker.getIssue(project.repo, task.issue_number);
    return {
      project,
      issue: issue ?? { number: task.issue_number, title: task.issue_title, body: '(issue unavailable at prompt build)', labels: [], state: 'UNKNOWN', url: task.issue_url },
      branch: run.branch ?? `${project.branch_prefix}${task.issue_number}`,
      workflowPath: join(this.deps.installDir, 'WORKFLOW.md'),
      worktreePath: run.workspace ?? this.worktreePathFor(project, task),
    };
  }

  private async coderTurn(
    run: RunRow,
    log: RunLog,
    turn: { session: CoderSession; logPath: string },
    prompt: string,
    label: 'RUNNING' | 'FIXING',
    signal: AbortSignal,
  ): Promise<CoderTurn> {
    const res = await turn.session.prompt(prompt, {
      timeoutMs: this.config.server.max_task_minutes * 60_000,
      signal,
    });
    log.event('coder_turn', {
      run: run.run_id, phase: label, ok: res.ok,
      timed_out: res.timedOut, aborted: res.aborted, ms: res.durationMs,
    });
    // Recorded as an artifact row so the UI can open the agent log per turn.
    this.store.addCheck({
      run_id: run.run_id, kind: 'agent', command: `agent (${label.toLowerCase()})`,
      exit_code: res.exitCode, artifact_path: turn.logPath,
      verdict: res.ok ? 'PASS' : res.aborted ? 'CANCELED' : 'FAIL',
    });
    return res;
  }

  private async callChecks(run: RunRow, log: RunLog, worktreePath: string, signal: AbortSignal): Promise<ChecksSummary> {
    const project = this.projectFor((this.store.getTaskById(run.task_id))!.repo)!;
    const summary = await this.runChecksFn(
      project.checks, worktreePath,
      (i) => join(this.artifactsDirFor(run), `check-${i}-${Date.now()}.log`),
      undefined, signal,
      (pid) => this.store.updateRunFields(run.run_id, { pid, process_identity: pid ? `${pid}:${Date.now()}` : null }),
    );
    summary.outcomes.forEach((o) => {
      this.store.addCheck({
        run_id: run.run_id, kind: 'check', command: o.command,
        exit_code: o.exitCode, artifact_path: o.logPath,
        verdict: summary.aborted ? 'CANCELED' : summary.infraError ? 'ERROR' : o.exitCode === 0 ? 'PASS' : 'FAIL',
      });
    });
    log.event('checks', { run: run.run_id, ok: summary.ok, count: summary.outcomes.length });
    return summary;
  }

  private testEvidenceFor(run: RunRow, headSha?: string | null): string {
    const checks = this.store.checksForRun(run.run_id).filter((c) => c.kind === 'check');
    const latest = [...new Map(checks.map((c) => [c.command, c])).values()];
    const prefix = headSha ? `提交 SHA: ${headSha}\n` : '';
    if (checks.length === 0) return `${prefix}(no checks recorded)`;
    return prefix + latest
      .map((c) => `命令: ${c.command}\n结果: ${c.verdict} (exit ${c.exit_code ?? 'n/a'})\n日志: ${c.artifact_path ?? '-'}`)
      .join('\n\n');
  }

  private canFix(run: RunRow): boolean {
    const fresh = this.store.getRun(run.run_id);
    return (fresh?.fix_count ?? 0) < this.config.server.retry_limit;
  }

  /**
   * Gate that must pass before work starts and before side effects:
   * issue open + ready label + approval hash unchanged.
   * Returns 'ok' or a terminal phase.
   */
  private async gateApproval(project: ProjectConfig, task: TaskRow): Promise<'ok' | Phase> {
    const issue = await this.tracker.getIssue(project.repo, task.issue_number);
    if (!issue || issue.state !== 'OPEN' || !issue.labels.includes(project.ready_label)) return 'CANCELED';
    const current = this.store.getTaskById(task.id)!;
    if (current.approved_hash && approvalHash(issue) !== current.approved_hash) {
      return 'BLOCKED_APPROVAL_CHANGED';
    }
    return 'ok';
  }

  private buildPrBody(run: RunRow, task: TaskRow, issue: IssueData, headSha: string): string {
    const checks = this.store.checksForRun(run.run_id);
    const checkEvents = this.store.eventsForRun(run.run_id)
      .filter((event) => event.to_phase === 'VERIFYING' && event.detail_json)
      .map((event) => JSON.parse(event.detail_json!) as { kind?: string; head_sha?: string; outcomes?: { command: string; exit_code: number | null }[] })
      .filter((detail): detail is { kind: string; head_sha: string; outcomes: { command: string; exit_code: number | null }[] } =>
        detail.kind === 'checks_completed' && detail.head_sha === headSha && Array.isArray(detail.outcomes))
      .at(-1);
    const checksMd = checkEvents
      ? checkEvents.outcomes.map((outcome) => `- \`${outcome.command}\` → **${outcome.exit_code === 0 ? 'PASS' : 'FAIL'}**${outcome.exit_code !== null ? ` (exit ${outcome.exit_code})` : ''}`).join('\n') || '- (无配置检查)'
      : '- 最新提交的检查证据缺失';
    const review = checks.filter((c) => c.kind === 'review').at(-1);
    return [
      `> 本 PR 由 agent-control 自动创建（Draft）。人工审查合并前不会合入主干。`,
      ``,
      `## 关联 Issue`,
      `Closes #${issue.number}`,
      ``,
      `## 验收与证据`,
      `- 需求来源：${issue.url}`,
      `- 运行 ID：\`${run.run_id}\`（attempt ${run.attempt}）`,
      `- 提交：\`${headSha}\``,
      `- Review 结论：${review ? review.verdict : 'PR 创建后自动执行'}`,
      ``,
      `## 测试命令与结果`,
      checksMd,
      ``,
      `## 风险`,
      `- 首次人工审查请重点核对 diff 是否满足 Issue 验收标准、是否越界改动。`,
    ].join('\n');
  }

  /**
   * Host-side risk escalation. Reviewer judgement alone is not enough: any
   * touch on auth/deps/build/tests forces a human look before auto-merge.
   */
  private assessRisk(diff: string, reviewerRisk: ReviewResult['risk']): string[] {
    const cfg = this.config.approvals.auto_merge;
    const reasons: string[] = [];
    if (reviewerRisk === 'high') reasons.push('reviewer marked risk=high');
    const files = new Set<string>();
    let changedLines = 0;
    for (const line of diff.split('\n')) {
      const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (header) { files.add(header[2]!); continue; }
      if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
        changedLines++;
      }
    }
    if (files.size > cfg.max_files) reasons.push(`${files.size} files changed > ${cfg.max_files}`);
    if (changedLines > cfg.max_lines) reasons.push(`${changedLines} changed lines > ${cfg.max_lines}`);
    const sensitive = /(^|\/)(auth|security|secrets?|crypto|permissions?)(\/|\.|$)|(^|\/)\.github\/workflows\//i;
    const dependency = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i;
    const build = /(^|\/)(Dockerfile|docker-compose\.ya?ml|Makefile)$|(^|\/)(migrations?|schema)\//i;
    const tests = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
    for (const file of files) {
      if (sensitive.test(file)) reasons.push(`sensitive path: ${file}`);
      else if (dependency.test(file)) reasons.push(`dependency change: ${file}`);
      else if (build.test(file)) reasons.push(`build or migration change: ${file}`);
      else if (tests.test(file)) reasons.push(`test change: ${file}`);
    }
    return reasons;
  }

  private riskComment(result: ReviewResult, reasons: string[]): string {
    return [
      '## 自动审查：通过，但标记为高风险',
      '',
      `- 结论：${result.verdict}`,
      `- 风险：${result.risk}`,
      `- 摘要：${result.summary}`,
      '',
      '### 触发原因',
      ...reasons.map((reason) => `- ${reason}`),
      '',
      '本 PR 不会自动合并，请人工审查后再合并。',
    ].join('\n');
  }

  /** Ready + squash-merge pinned to the reviewed SHA; any doubt falls back to a human. */
  private async autoMerge(
    run: RunRow, task: TaskRow, project: ProjectConfig, prNumber: number, prUrl: string, headSha: string,
  ) {
    try {
      const actual = await this.tracker.getPrHeadSha(project.repo, prNumber);
      if (actual !== headSha) {
        this.finish(run, task, 'BLOCKED', 'auto-merge aborted: PR head moved since review', { pr_url: prUrl });
        return;
      }
      await this.tracker.markPrReady(project.repo, prNumber);
      await this.tracker.mergePr(project.repo, prNumber, headSha);
      const state = await this.tracker.getPrState(project.repo, prNumber);
      if (state !== 'MERGED') {
        this.finish(run, task, 'AWAITING_MERGE', 'auto-merge did not confirm MERGED; waiting for a human', { pr_url: prUrl });
        return;
      }
      this.store.transition(run.run_id, 'REVIEWING', 'REVIEWING', { kind: 'auto_merged', head_sha: headSha, pr_url: prUrl });
      this.finish(run, task, 'COMPLETED', 'auto-merged low-risk PR', { pr_url: prUrl });
      await this.cleanupMerged(project, task);
    } catch (err) {
      this.finish(run, task, 'AWAITING_MERGE', `auto-merge failed: ${String(err).slice(0, 300)}`, { pr_url: prUrl });
    }
  }

  private finish(run: RunRow, task: TaskRow, finalPhase: Phase, reason?: string, taskFields?: { pr_url?: string }) {
    if (!TERMINAL_FOR_TASK.includes(finalPhase)) throw new Error(`finish() requires terminal phase, got ${finalPhase}`);
    try {
      this.store.tx(() => {
        this.store.endRun(run.run_id, finalPhase, reason);
        this.store.setTaskStatus(task.id, finalPhase, { pr_url: taskFields?.pr_url });
      });
      if (ATTENTION_PHASES.includes(finalPhase)) void this.notifyTaskAttention(task, finalPhase, reason);
      if (finalPhase === 'BLOCKED' || finalPhase === 'BLOCKED_APPROVAL_CHANGED') {
        const project = this.projectFor(task.repo);
        if (project) void this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-blocked');
      }
      const project = this.projectFor(task.repo);
      if (project) void this.labelQuietly(project.repo, task.issue_number, 'remove', 'agent-running');
    } catch (err) {
      this.appLog.event('finish_error', { run: run.run_id, error: String(err) });
      this.recordError('finish_error', err);
    }
  }

  /** Task transition + GitHub-side notification for attention states. */
  private setTaskStatus(
    taskId: number,
    status: Phase,
    fields?: { approved_hash?: string | null; branch?: string | null; pr_url?: string | null },
  ) {
    this.store.setTaskStatus(taskId, status, fields);
    if (ATTENTION_PHASES.includes(status)) {
      const task = this.store.getTaskById(taskId);
      if (task) void this.notifyTaskAttention(task, status);
    }
  }

  /**
   * Post an issue comment when a task needs a human. Best-effort: a
   * comment failure is logged, never thrown into the state machine.
   */
  async notifyTaskAttention(task: TaskRow, status: Phase, detail?: string): Promise<void> {
    try {
      const runs = this.store.runsForTask(task.id);
      const last = runs[runs.length - 1];
      const reason = detail ?? last?.reason;
      const checks = last ? this.store.checksForRun(last.run_id) : [];
      const body = [
        `agent-control: 任务进入 **${status}**，需要人工处理。`,
        reason ? `\n原因：${reason}` : '',
        last ? `\nrun：\`${last.run_id}\`（attempt ${last.attempt}，耗时 ${fmtSpan(last.started_at, last.ended_at)}）` : '',
        checks.length
          ? `\n检查结果：\n${checks.map((c) => `- ${c.kind}: **${c.verdict}**${c.exit_code !== null ? `（exit ${c.exit_code}）` : ''}`).join('\n')}`
          : '',
        `\n排查：\`npm run ac -- runs ${task.issue_number}\`；处理后用 \`npm run ac -- retry ${task.issue_number}\` 重新排队。`,
      ].join('');
      await this.tracker.addComment(task.repo, task.issue_number, body);
    } catch (err) {
      this.appLog.event('comment_error', { task: task.id, error: String(err) });
      this.recordError('comment_error', err);
    }
  }

  /** Run summary on the issue when the PR merges — GitHub-side audit trail. */
  async notifyTaskCompleted(task: TaskRow): Promise<void> {
    try {
      const runs = this.store.runsForTask(task.id);
      const first = runs[0];
      const last = runs[runs.length - 1];
      const body = [
        `agent-control: 任务完成，PR 已合并。`,
        `\n- attempt：${runs.length} 次`,
        first ? `\n- 总耗时：${fmtSpan(first.started_at, null)}（首次领取 → 合并）` : '',
        task.fix_rounds > 0 ? `\n- 修复轮次：${task.fix_rounds}` : '',
        last && last.fix_count > 0 ? `\n- 本轮修复次数：${last.fix_count}` : '',
        task.pr_url ? `\n- PR：${task.pr_url}` : '',
      ].join('');
      await this.tracker.addComment(task.repo, task.issue_number, body);
    } catch (err) {
      this.appLog.event('comment_error', { task: task.id, error: String(err) });
      this.recordError('comment_error', err);
    }
  }

  /**
   * After merge, reclaim the worktree and both branch refs. Every step is
   * independent and best-effort — a cleanup failure never un-completes.
   */
  private async cleanupMerged(project: ProjectConfig, task: TaskRow) {
    const last = this.store.runsForTask(task.id).at(-1);
    const worktree = last?.workspace ?? this.worktreePathFor(project, task);
    const done: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        done.push(name);
      } catch (err) {
        this.appLog.event('cleanup_error', { task: task.id, step: name, error: String(err) });
        this.recordError('cleanup_error', err);
      }
    };
    await step('worktree', () => this.workspace.removeWorktree(project.local_repo, worktree));
    const branch = task.branch;
    if (branch && branch.startsWith(project.branch_prefix)) {
      await step('local-branch', () => this.workspace.deleteLocalBranch(project.local_repo, branch));
      await step('remote-branch', () => this.workspace.deleteRemoteBranch(project.local_repo, branch));
    }
    this.appLog.event('cleanup_done', { task: task.id, steps: done });
  }

  /** Record the latest internal error for `ac status` to surface. */
  private recordError(kind: string, err: unknown) {
    try {
      this.store.setMeta('last_error', JSON.stringify({
        at: new Date().toISOString(), kind, error: String(err).slice(0, 400),
      }));
    } catch { /* db closed during shutdown */ }
  }

  private setReturnPhase(runId: string, phase: Phase | null) {
    this.store.db
      .prepare('UPDATE runs SET return_phase = ? WHERE run_id = ?')
      .run(phase, runId);
  }

  private worktreePathFor(project: ProjectConfig, task: TaskRow): string {
    const safeRepo = project.repo.replace(/[^\w.-]+/g, '_');
    return resolve(this.config.server.worktree_root, safeRepo, `issue-${task.issue_number}`);
  }

  private artifactsDirFor(run: RunRow): string {
    return join(this.config.server.logs_dir, 'artifacts', run.run_id);
  }

  private logFor(run: RunRow): RunLog {
    return new RunLog(this.config.server.logs_dir, run.run_id);
  }

  private projectFor(repo: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.repo === repo);
  }

  private async labelQuietly(repo: string, issue: number, op: 'add' | 'remove', label: string) {
    try {
      if (op === 'add') await this.tracker.addLabel(repo, issue, label);
      else await this.tracker.removeLabel(repo, issue, label);
    } catch (err) {
      this.appLog.event('label_error', { repo, issue, op, label, error: String(err) });
      this.recordError('label_error', err);
    }
  }

  /** Review visibility on GitHub: the only signal that a run reached REVIEWING. */
  private async setPrLabel(repo: string, prNumber: number, add: boolean) {
    try {
      if (add) await this.tracker.addPrLabel(repo, prNumber, 'agent-reviewing');
      else await this.tracker.removePrLabel(repo, prNumber, 'agent-reviewing');
    } catch (err) {
      this.appLog.event('label_error', {
        repo, pr: prNumber, op: add ? 'add' : 'remove', label: 'agent-reviewing', error: String(err),
      });
    }
  }
}

export function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** `Depends-On: #12` / `依赖: #12` lines in the issue body. */
export function parseDependsOn(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/(?:depends[- ]?on|依赖)[:：]?\s*#(\d+)/gi)) {
    out.add(Number(m[1]));
  }
  return [...out];
}
