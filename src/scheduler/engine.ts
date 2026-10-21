import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from '../store/sqlite.js';
import { RunLog, type AppLog } from '../telemetry/logging.js';
import { approvalHash, GitHubTracker, type OpenPr } from '../tracker/github.js';
import { DiffTooLargeError, GitWorkspace } from '../workspace/git.js';
import { openPiCoderSession, type CoderSession, type CoderSessionOpts, type CoderTurn } from '../runners/session.js';
import { PI_ALL_TOOLS } from '../runners/pi.js';
import { runChecks, type ChecksSummary } from '../verify/checks.js';
import { runReview, ReviewInfraError } from '../verify/review.js';
import { publishDraftPr, PublishError } from '../publish/pr.js';
import { buildCoderPrompt, buildFixPrompt, type PromptContext } from './prompts.js';
import type { AppConfig, IssueData, PendingFix, Phase, ProjectConfig, ReviewResult, RunRow, TaskRow } from '../types.js';
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
  /** Settle window before re-reading claim comments for race arbitration. */
  claimArbitrationMs?: number;
}

const TERMINAL_FOR_TASK: Phase[] = [
  'AWAITING_REVIEW', 'AWAITING_HUMAN', 'COMPLETED', 'BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'CANCELED',
  'RECOVERY_REQUIRED',
];

/** Failed `gh pr merge` retries before a MERGING task gives up to a human. */
const MAX_MERGE_ATTEMPTS = 20;

/** New PR-first tasks registered per tick — a burst of PRs must not fan out
 *  into a burst of review runs. */
const PR_REVIEW_BATCH = 1;

/** Label a human adds to summon a review for a PR opened before the anchor. */
const PR_SUMMON_LABEL = 'agent-review';

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
      await this.reconcileMergeStates();
      await this.discover();
      await this.dispatch();
      await this.discoverPrs();
      await this.dispatchReviews();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Merge sweep, every tick:
   * - AWAITING_REVIEW / AWAITING_HUMAN tasks: external merge/close is
   *   written back (a human may land the PR while review is still pending).
   * - MERGING tasks: the host actively lands the PR — retries transient
   *   failures within a bounded budget, hands conflicts to a fix run, and
   *   parks for a human only after the budget is gone.
   */
  private async reconcileMergeStates() {
    for (const task of [
      ...this.store.listTasks('AWAITING_REVIEW'),
      ...this.store.listTasks('AWAITING_HUMAN'),
      ...this.store.listTasks('MERGING'),
    ]) {
      try {
        const project = this.projectFor(task.repo);
        if (!project) continue;
        const prNum = prNumberFromUrl(task.pr_url) ?? undefined;
        if (task.status === 'MERGING') {
          // A conflict-repair run is part of landing: the task stays MERGING
          // while that run works, and the sweep must not merge mid-repair.
          if (this.store.activeRunForTask(task.id)) continue;
          await this.driveMerge(task, project, prNum);
          continue;
        }
        const state = prNum
          ? await this.tracker.getPrState(project.repo, prNum)
          : await this.tracker.findPrForBranch(project.repo, task.branch ?? '').then((p) => p?.state ?? 'OPEN');
        if (state === 'MERGED') {
          await this.completeMergedTask(task, project);
        } else if (state === 'CLOSED') {
          this.setTaskStatus(task.id, 'BLOCKED');
          this.appLog.event('task_blocked_pr_closed', { task: task.id });
        } else if (task.status === 'AWAITING_HUMAN') {
          await this.maybeHumanMergeApproval(task, project, prNum);
        }
      } catch (err) {
        this.appLog.event('reconcile_error', { task: task.id, error: String(err) });
        this.recordError('reconcile_error', err);
      }
    }
  }

  /**
   * Human merge approval: a human adds `agent-merge` to the PR, and the
   * host lands it. The label is one-shot — consumed before the transition —
   * and the approval binds to the last reviewed sha: if the PR moved past
   * it, the approval is voided (label removed, comment posted) rather than
   * silently merging an unreviewed head. Manual-review projects have no
   * verdict sha; there the label approves whatever head is current.
   */
  private async maybeHumanMergeApproval(task: TaskRow, project: ProjectConfig, prNumber: number | undefined) {
    if (!prNumber) return;
    let pr: Awaited<ReturnType<GitHubTracker['getPrDetails']>>;
    try {
      pr = await this.tracker.getPrDetails(project.repo, prNumber);
    } catch (err) {
      this.appLog.event('human_merge_preflight_error', { task: task.id, error: String(err) });
      return;
    }
    if (pr.state !== 'OPEN') return;
    // Self-heal: an AWAITING_HUMAN task whose current head was never reviewed
    // (e.g. a repair pushed a new head while the task was parked) must go back
    // to the review queue — otherwise the new head can never be approved.
    if (this.reviewsPr(project, task) && !this.store.hasReviewVerdictForSha(task.id, pr.headSha)) {
      // Any pending approval covers the old head only — drop it, re-review.
      await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
      this.setTaskStatus(task.id, 'AWAITING_REVIEW');
      this.appLog.event('human_head_unreviewed', { task: task.id, head_sha: pr.headSha });
      return;
    }
    // External PRs are review-only: a human merges them by hand, so an
    // agent-merge label must never route one into the host merge sweep.
    if (task.source === 'pr') return;
    if (!pr.labels.includes('agent-merge')) return;
    const reviewedSha = this.store.latestReviewVerdictSha(task.id);
    if (reviewedSha && pr.headSha !== reviewedSha) {
      await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
      await this.tracker.commentPr(project.repo, prNumber,
        `## 人工批准已作废\n\nPR head 已从被审版本 \`${reviewedSha.slice(0, 12)}\` 变为 \`${pr.headSha.slice(0, 12)}\`——批准只对被审版本有效，已移除 \`agent-merge\` 标签。请等新一轮评审完成后重新打标签。`)
        .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
      this.appLog.event('human_merge_stale', { task: task.id, reviewed_sha: reviewedSha, head_sha: pr.headSha });
      return;
    }
    // Consume the label first: a crash between the CAS and the removal would
    // otherwise leave a one-shot approval armed for a future, unreviewed head.
    await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
    const moved = this.store.tx(() => {
      const now = this.store.getTaskById(task.id);
      if (!now || now.status !== 'AWAITING_HUMAN') return false;
      this.store.setTaskStatus(task.id, 'MERGING', { merge_attempts: 0, approved_sha: pr.headSha, approved_by: 'human' });
      return true;
    });
    if (!moved) return;
    await this.tracker.commentPr(project.repo, prNumber,
      `## 人工批准，排队自动合并\n\n合并将钉在 \`${pr.headSha.slice(0, 12)}\`；失败/冲突会走修复回路，需重新批准。`)
      .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
    this.appLog.event('human_merge_approved', { task: task.id, head_sha: pr.headSha });
  }

  /** Whether an autonomous review run may judge this task's PR. */
  private reviewsPr(project: ProjectConfig, task: TaskRow): boolean {
    return task.source === 'pr' || project.review_mode === 'auto';
  }

  /**
   * One merge-drive step for a MERGING task. Idempotent by construction:
   * every exit leaves the task in MERGING (retry next tick), a terminal
   * state, or a dispatched fix run — a crash mid-step loses nothing.
   */
  private async driveMerge(task: TaskRow, project: ProjectConfig, prNumber: number | undefined) {
    const store = this.store;
    // A manual-review project only disables REVIEW-driven auto-merge: a task
    // cleared by a human (agent-merge label) still lands.
    if (project.review_mode !== 'auto' && store.getTaskById(task.id)?.approved_by !== 'human') {
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      this.appLog.event('merge_mode_manual', { task: task.id });
      return;
    }
    if (!prNumber) {
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      this.appLog.event('merge_no_pr', { task: task.id });
      return;
    }
    // The cleared sha is recorded on entry to MERGING (review PASS or human
    // approval). The verdict fallback covers rows written before v8.
    const approvedSha = store.getTaskById(task.id)?.approved_sha ?? store.latestReviewVerdictSha(task.id);
    if (!approvedSha) {
      // MERGING without a cleared sha breaks the invariant — park for a human.
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      this.appLog.event('merge_no_verdict', { task: task.id });
      return;
    }
    let pr: Awaited<ReturnType<GitHubTracker['getPrDetails']>>;
    try {
      pr = await this.tracker.getPrDetails(project.repo, prNumber);
    } catch (err) {
      // Tracker flake is not a merge refusal — burn no attempt, retry next tick.
      this.appLog.event('merge_preflight_error', { task: task.id, error: String(err) });
      return;
    }
    if (pr.state === 'MERGED') { await this.completeMergedTask(task, project); return; }
    if (pr.state !== 'OPEN') {
      this.setTaskStatus(task.id, 'BLOCKED');
      this.appLog.event('task_blocked_pr_closed', { task: task.id });
      return;
    }
    if (pr.headSha !== approvedSha) {
      // Someone pushed past the reviewed head: the verdict covers the old
      // sha only. Back to AWAITING_REVIEW — a fresh review (or, if a verdict
      // already exists for the new head, the human path) decides next.
      this.setTaskStatus(task.id, 'AWAITING_REVIEW');
      this.appLog.event('merge_head_moved', { task: task.id, approved_sha: approvedSha, head_sha: pr.headSha });
      return;
    }
    if (pr.mergeable === 'CONFLICTING') {
      if (await this.spawnMergeFix(task, project, prNumber, approvedSha, `PR conflicts with ${project.base_branch}`)) return;
      if (store.getTaskById(task.id)?.status !== 'MERGING') return;
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      await this.tracker.commentPr(project.repo, prNumber,
        `## 自动合并受阻\n\n分支与 ${project.base_branch} 存在合并冲突且修复预算已耗尽，转人工处理。`)
        .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
      return;
    }
    try {
      await this.tracker.markPrReady(project.repo, prNumber);
      await this.tracker.mergePr(project.repo, prNumber, approvedSha);
    } catch (err) {
      // A conflict can appear between the pre-check and the merge call —
      // that is fixable work, not a retry-budget hit.
      if (await this.spawnMergeFix(task, project, prNumber, approvedSha, String(err))) return;
      await this.mergeAttemptFailed(task, project, prNumber, String(err));
      return;
    }
    const state = await this.tracker.getPrState(project.repo, prNumber).catch(() => 'UNKNOWN');
    if (state === 'MERGED') {
      // CAS: a concurrent stop/close must not be overridden by completion.
      const landed = store.tx(() => {
        if (store.getTaskById(task.id)?.status !== 'MERGING') return false;
        store.setTaskStatus(task.id, 'COMPLETED');
        return true;
      });
      if (!landed) return;
      this.appLog.event('task_completed', { task: task.id, repo: task.repo, issue: task.issue_number });
      await this.notifyTaskCompleted(task);
      await this.cleanupMerged(project, task);
      return;
    }
    await this.mergeAttemptFailed(task, project, prNumber, 'merge call returned but PR did not reach MERGED');
  }

  /** A failed merge attempt burns budget; exhaustion parks for a human. */
  private async mergeAttemptFailed(task: TaskRow, project: ProjectConfig, prNumber: number, why: string) {
    if (this.store.getTaskById(task.id)?.status !== 'MERGING') return;
    const attempts = this.store.bumpMergeAttempts(task.id);
    this.appLog.event('merge_attempt_failed', { task: task.id, attempts, why: why.slice(0, 200) });
    if (attempts < MAX_MERGE_ATTEMPTS) return;
    this.setTaskStatus(task.id, 'AWAITING_HUMAN');
    await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
    await this.tracker.commentPr(project.repo, prNumber,
      `## 自动合并重试失败\n\n已连续 ${attempts} 次未能合并（最后：${why.slice(0, 200)}），转人工合并。`)
      .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
  }

  /** Task-level completion shared by the reconcile path and driveMerge. */
  private async completeMergedTask(task: TaskRow, project: ProjectConfig) {
    this.setTaskStatus(task.id, 'COMPLETED');
    this.appLog.event('task_completed', { task: task.id, repo: task.repo, issue: task.issue_number });
    await this.notifyTaskCompleted(task);
    await this.cleanupMerged(project, task);
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
            this.setTaskStatus(task.id, 'BLOCKED_APPROVAL_CHANGED', { pending_fix: null });
            this.appLog.event('approval_drift', { task: task.id });
            await this.labelQuietly(project.repo, issue.number, 'add', 'agent-blocked');
          }
        }
      }
    }
  }

  /**
   * PR-first discovery: an external PR is a complete input on its own — no
   * issue is required. Registering a PR-only task puts it straight into
   * AWAITING_REVIEW, where the existing sha-idempotent review dispatch picks
   * it up; nothing here can start a coding run.
   *
   * Runs after dispatch() so coding work claims the concurrency budget first.
   */
  private async discoverPrs() {
    for (const project of this.config.projects) {
      if (project.pr_review !== 'auto') continue;
      const sinceKey = `pr_review_since:${project.repo}`;
      const since = this.store.getMeta(sinceKey);
      if (!since) {
        // Cold start: only PRs opened from now on are auto-reviewed. Without
        // this anchor, switching the feature on would queue every historical
        // PR in the repo.
        this.store.setMeta(sinceKey, new Date().toISOString());
        continue;
      }
      let prs: OpenPr[];
      try {
        prs = await this.tracker.listOpenPrs(project.repo);
      } catch (err) {
        this.appLog.event('pr_discover_error', { repo: project.repo, error: String(err) });
        this.recordError('pr_discover_error', err);
        continue;
      }
      const sinceMs = Date.parse(since);
      const candidates = prs.filter((pr) => {
        if (pr.isDraft) return false;
        // A fork head is not fetchable from the local repo's remote, so the
        // review site could never be materialized.
        if (pr.isCrossRepository) return false;
        if (pr.baseRefName !== project.base_branch) return false;
        // The agent's own PRs hang off issue tasks; registering them here
        // would race the task-driven review path for the same head.
        if (pr.headRefName.startsWith(project.branch_prefix)) return false;
        if (pr.labels.includes(PR_SUMMON_LABEL)) return true;
        return Date.parse(pr.createdAt) >= sinceMs;
      }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      let created = 0;
      for (const pr of candidates) {
        const summoned = pr.labels.includes(PR_SUMMON_LABEL);
        if (this.store.getTask(project.repo, pr.number)) {
          // Leftover authorization: the task exists, so the label already did
          // its job. A removal that failed last tick is retried here instead
          // of being skipped forever with the task.
          if (summoned) await this.prLabelQuietly(project.repo, pr.number, PR_SUMMON_LABEL, false);
          continue;
        }
        if (created >= PR_REVIEW_BATCH) break;
        this.store.upsertPrTask({
          repo: project.repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          branch: pr.headRefName,
        });
        created++;
        if (summoned) await this.prLabelQuietly(project.repo, pr.number, PR_SUMMON_LABEL, false);
        this.appLog.event('pr_task_discovered', { repo: project.repo, pr: pr.number, branch: pr.headRefName });
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
      this.setTaskStatus(task.id, 'CANCELED', { pending_fix: null });
      this.appLog.event('dispatch_skip', { task: task.id, why: 'issue closed or missing' });
      return;
    }
    if (!issue.labels.includes(project.ready_label)) {
      this.setTaskStatus(task.id, 'CANCELED', { pending_fix: null });
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
      this.setTaskStatus(task.id, 'BLOCKED_APPROVAL_CHANGED', { pending_fix: null });
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
      if (!task.pending_fix) {
        // OPEN PR with nothing to fix: the PR is the product now. Reviews are
        // dispatched separately against the PR head sha.
        this.setTaskStatus(task.id,
          project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN',
          { branch, pr_url: existingPr.url });
        await this.labelQuietly(project.repo, issue.number, 'add', 'agent-pr');
        this.appLog.event('dispatch_skip', { task: task.id, why: `PR already exists: ${existingPr.url}` });
        return;
      }
      // OPEN PR + pending_fix: claim a code run that goes straight to RUNNING
      // with the review findings as its prompt.
      this.store.setTaskStatus(task.id, 'DISCOVERED', { branch, pr_url: existingPr.url });
      this.appLog.event('dispatch_skip', { task: task.id, why: `PR exists with pending fix; claiming fix run: ${existingPr.url}` });
    }

    const run = this.store.claimRun(task.id);
    this.store.updateRunFields(run.run_id, { branch, pr_url: existingPr?.url ?? null });
    await this.labelQuietly(project.repo, issue.number, 'add', 'agent-running');
    // A stale agent-blocked (e.g. left by a failed attempt on another
    // instance) is meaningless once this task is claimed — remove it.
    await this.labelQuietly(project.repo, issue.number, 'remove', 'agent-blocked');
    await this.tracker.addComment(project.repo, issue.number,
      `agent-control: 已领取（\`${hostname()}\`）（run \`${run.run_id}\`）`).catch((err) => {
      this.appLog.event('comment_error', { task: task.id, error: String(err) });
    });
    // Label claiming is not atomic — a simultaneous foreign instance can pass
    // the agent-running check and claim too. The first claim comment wins;
    // losers back out before launching so only one process burns tokens.
    if (await this.lostClaimRace(project, task, run.run_id)) {
      this.store.endRun(run.run_id, 'CANCELED', 'lost claim race to another instance');
      this.appLog.event('claim_race_lost', { run: run.run_id, task: task.id });
      return;
    }
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
            if (run.kind === 'review') {
              // A crashed review leaves no verdict row; without one the same
              // sha would be re-dispatched forever. ERROR counts as a verdict.
              if (run.head_sha && !this.store.hasReviewVerdictForSha(run.task_id, run.head_sha)) {
                this.store.addCheck({
                  run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
                  verdict: 'ERROR', head_sha: run.head_sha,
                });
              }
              this.store.endRun(runId, 'FAILED', `engine crash: ${String(err).slice(0, 500)}`);
              const task = this.store.getTaskById(run.task_id);
              if (task && task.status === 'REVIEWING') this.setTaskStatus(task.id, 'AWAITING_HUMAN');
            } else {
              this.store.endRun(runId, 'FAILED', `engine crash: ${String(err).slice(0, 500)}`);
              const task = this.store.getTaskById(run.task_id);
              if (task && task.status === 'RUNNING') this.setTaskStatus(task.id, 'FAILED');
            }
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
    const taskRow = store.getTaskById(run.task_id);
    if (!taskRow) { store.endRun(runId, 'FAILED', 'task row missing'); return; }
    let task: TaskRow = taskRow;
    const project = this.projectFor(task.repo);
    if (!project) { this.finish(run, task, 'FAILED', 'project removed from config'); return; }

    if (task.status === 'DISCOVERED') store.setTaskStatus(task.id, 'RUNNING');
    const log = this.logFor(run);
    const heartbeat = setInterval(() => {
      try { store.heartbeat(runId); } catch { /* db closed during shutdown */ }
    }, 10_000);

    const aborted = () => signal.aborted || store.getRun(runId)?.cancel_requested === 1;

    if (run.kind === 'review') {
      try {
        await this.runReviewTask(run, task, project, signal, aborted);
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }

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
      // A merge-conflict repair is part of landing: its published head goes
      // straight back to MERGING (no re-review), carrying the original
      // approval source so a manual-mode human approval is not lost.
      let mergeRepair = false;
      let mergeRepairApprovedBy: 'review' | 'human' = 'review';

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
            // A fix run (pending_fix) must run the coder even though a PR
            // already exists; a plain existing-PR run re-verifies only.
            const pendingFix = task.pending_fix ? (JSON.parse(task.pending_fix) as PendingFix) : null;
            store.transition(runId, phase, (phase = task.pr_url && !pendingFix ? 'VERIFYING' : 'RUNNING'));
            break;
          }

          case 'RUNNING': {
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed during run'); return; }
            // Consume pending_fix once: the reviewed sha is pinned on the run
            // so publish-time can detect a fix that produced no new commits.
            const pendingFix = task.pending_fix ? (JSON.parse(task.pending_fix) as PendingFix) : null;
            let prompt = buildCoderPrompt(ctx);
            if (pendingFix) {
              store.updateRunFields(runId, { head_sha: pendingFix.head_sha });
              store.transition(runId, phase, phase, {
                kind: 'pending_fix_consumed', head_sha: pendingFix.head_sha,
                summary: pendingFix.summary, findings: pendingFix.findings,
              });
              // A merge-conflict repair keeps the task in MERGING (landing is
              // still in progress); review-driven fixes read as RUNNING.
              mergeRepair = pendingFix.title === '自动合并受阻';
              mergeRepairApprovedBy = store.getTaskById(task.id)?.approved_by ?? 'review';
              store.setTaskStatus(task.id, mergeRepair ? 'MERGING' : 'RUNNING', { pending_fix: null });
              task = { ...task, pending_fix: null };
              // Fix runs may need `git merge origin/<base>` — the child's
              // scrubbed env cannot fetch, so the host refreshes the ref.
              await this.workspace.fetchBranch(project.local_repo, project.base_branch)
                .catch((err) => this.appLog.event('fetch_error', { run: runId, error: String(err) }));
              // The work must start from the PR branch's remote head: a reused
              // worktree may sit at a stale commit, and merging base onto it
              // pushes a non-fast-forward that GitHub rejects.
              const fixBranch = run.branch ?? task.branch ?? `${project.branch_prefix}${task.issue_number}`;
              await this.workspace.fetchBranch(project.local_repo, fixBranch)
                .then(() => this.workspace.resetHard(worktreePath, `origin/${fixBranch}`))
                .catch((err) => this.appLog.event('fix_head_sync_error', { run: runId, error: String(err).slice(0, 300) }));
              prompt = buildFixPrompt(ctx, `${pendingFix.title ?? 'Review BLOCK'}：${pendingFix.summary}\n${pendingFix.findings.join('\n')}`);
            }
            const turn = ensureCoder();
            const res = await this.coderTurn(run, log, turn, prompt, 'RUNNING', signal);
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
            const summary = await this.callChecks(run, log, worktreePath, signal, headBeforeChecks);
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
            // Legacy only: code runs never enter REVIEWING anymore (reviews
            // are separate runs). A pre-v4 run resumed here re-verifies.
            store.transition(runId, phase, (phase = 'VERIFYING'), { recovered: true, reason: 'review moved to a separate run kind; revalidate' });
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
            // A fix run that produced no new commits verified the very sha a
            // review already BLOCKED — there is nothing new to publish.
            const reviewedSha = this.store.getRun(runId)?.head_sha ?? run.head_sha;
            if (reviewedSha && verifiedHead === reviewedSha) {
              this.finish(run, task, 'BLOCKED', 'fix run produced no new commits; reviewed sha unchanged');
              return;
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
              // Coding ends here. A merge-conflict repair lands directly
              // (Symphony-style: landing owns the repair); otherwise an
              // auto-review project enters its review wait state and a manual
              // one parks on the human path.
              if (mergeRepair) {
                this.finish(run, task, 'COMPLETED', `merge repair published: ${pr.url}`, {
                  pr_url: pr.url, merge_attempts: 0, approved_sha: verifiedHead, approved_by: mergeRepairApprovedBy,
                }, 'MERGING');
                return;
              }
              this.finish(run, task,
                project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN',
                `PR published: ${pr.url}`, { pr_url: pr.url });
              return;
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

  // ---------------- review runs (kind='review') ----------------

  /**
   * Dispatch a review run per AWAITING_REVIEW task — every published PR head
   * of an auto-review project is reviewed. Verdict rows are sha-idempotent:
   * any existing review row for the current PR head (PASS/BLOCK/
   * HUMAN_REVIEW_REQUIRED/ERROR) suppresses re-dispatch.
   */
  private async dispatchReviews() {
    const max = this.config.server.max_concurrent;
    for (const task of this.store.listTasks('AWAITING_REVIEW')) {
      if (this.activeCount() >= max) return;
      const project = this.projectFor(task.repo);
      if (!project) continue;
      // Manual-review projects never enter AWAITING_REVIEW — the PR parks
      // in AWAITING_HUMAN and a human reviews and merges, no run is spent.
      // reviewsPr() owns the exception for bare PRs.
      if (!this.reviewsPr(project, task)) continue;
      if (this.store.activeRunForTask(task.id)) continue;
      try {
        const prNum = prNumberFromUrl(task.pr_url)
          ?? (await this.tracker.findPrForBranch(project.repo, task.branch ?? '').catch(() => null))?.number
          ?? null;
        if (!prNum) continue;
        const pr = await this.tracker.getPrDetails(project.repo, prNum);
        if (pr.state !== 'OPEN') continue;
        if (pr.labels.includes('agent-reviewing')) {
          // Zombie lock: no active run for this task means the reviewing run
          // died without clearing its label. Clearing it lets the head be
          // reviewed again instead of stalling the task forever. (A review
          // run on another instance would look the same — accepted gap.)
          await this.setPrLabel(project.repo, prNum, false);
          this.appLog.event('stale_review_label_cleared', { task: task.id, pr: prNum });
        }
        if (this.store.hasReviewVerdictForSha(task.id, pr.headSha)) {
          // AWAITING_REVIEW + a verdict for exactly this head is a stranded
          // state: the sha idempotency below will never dispatch it again, so
          // the UI would show "reviewing" for a task that cannot move. BLOCKED
          // is the honest label and it is retryable — retry clears the verdict.
          this.setTaskStatus(task.id, 'BLOCKED');
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-blocked');
          this.appLog.event('review_stranded', { task: task.id, head_sha: pr.headSha, pr: prNum });
          continue;
        }

        // Claim + pin fields + task status in one transaction so a crash
        // cannot leave a zombie task with no active run or vice versa.
        const worktree = this.store.lastCodeWorkspace(task.id) ?? this.worktreePathFor(project, task);
        const run = this.store.tx(() => {
          const r = this.store.claimRun(task.id, { kind: 'review', headSha: pr.headSha });
          this.store.updateRunFields(r.run_id, {
            workspace: worktree,
            branch: task.branch ?? `${project.branch_prefix}${task.issue_number}`,
            pr_url: task.pr_url ?? pr.url,
          });
          this.store.setTaskStatus(task.id, 'REVIEWING');
          return r;
        });
        // Launch before logging: a throw after claim-tx must not strand a
        // CLAIMED run + REVIEWING task with nothing in flight.
        this.launch(run.run_id);
        this.appLog.event('review_run_claimed', { run: run.run_id, task: task.id, head_sha: pr.headSha, pr: prNum });
      } catch (err) {
        this.appLog.event('review_dispatch_error', { task: task.id, error: String(err) });
        this.recordError('review_dispatch_error', err);
      }
    }
  }

  /**
   * A review run: CLAIMED → REVIEWING → terminal. Judges one PR head sha;
   * the only "product" is a check_results review row + the task/run verdict.
   * Never writes a verdict row for an abandoned or cancelled round.
   */
  private async runReviewTask(run: RunRow, task: TaskRow, project: ProjectConfig, signal: AbortSignal, aborted: () => boolean) {
    const store = this.store;
    const runId = run.run_id;
    const reviewedSha = run.head_sha!;
    const prNum = prNumberFromUrl(run.pr_url ?? task.pr_url);
    let tempWorktree: string | null = null;
    let labelApplied = false;

    try {
      if (run.phase === 'CLAIMED') store.transition(runId, 'CLAIMED', 'REVIEWING');

      // --- pre-flight guards -------------------------------------------------
      let currentHead = reviewedSha;
      if (prNum) {
        const pr = await this.tracker.getPrDetails(project.repo, prNum)
          .catch((err) => { this.appLog.event('review_preflight_error', { run: runId, error: String(err) }); return null; });
        if (pr?.state === 'MERGED') {
          store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_skipped', reason: 'PR already merged' });
          this.finishReview(run, task, 'COMPLETED', 'PR merged before review');
          this.appLog.event('task_completed', { task: task.id, repo: task.repo, issue: task.issue_number });
          await this.notifyTaskCompleted(task);
          await this.cleanupMerged(project, task);
          return;
        }
        if (pr && pr.state !== 'OPEN') {
          this.finishReview(run, task, 'BLOCKED', 'PR closed before review');
          return;
        }
        if (pr) currentHead = pr.headSha;
      }
      const gate = await this.gateApproval(project, task);
      if (gate !== 'ok') { this.finishReview(run, task, gate, 'approval gate failed before review'); return; }
      if (currentHead !== reviewedSha) {
        // Head moved since dispatch: abandon this round without a verdict.
        // Task stays AWAITING_HUMAN so the next tick re-dispatches on the
        // new sha; the run itself is dead.
        this.finishReview(run, task, 'CANCELED', `PR head moved ${reviewedSha} -> ${currentHead}; abandoning round`, this.cancelTaskPhase(runId));
        return;
      }
      if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled', this.cancelTaskPhase(runId)); return; }

      // --- materialize the PR head as a local review site --------------------
      let sitePath = '';
      const codeWt = run.workspace ?? this.store.lastCodeWorkspace(task.id);
      if (codeWt) {
        const head = await this.workspace.head(codeWt).catch(() => null);
        if (head === reviewedSha && !(await this.workspace.isDirty(codeWt))) {
          sitePath = codeWt;
          // A resumed run reuses its own previous review site — still owned
          // by this run, so the finally must tear it down. Exact compare:
          // a code worktree must never be mistaken for a review site.
          if (sitePath === resolve(join(this.config.server.worktree_root, 'review-sites', runId.slice(0, 8)))) tempWorktree = sitePath;
        }
      }
      if (!sitePath) {
        sitePath = join(this.config.server.worktree_root, 'review-sites', `${runId.slice(0, 8)}`);
        try {
          // Refresh both the PR branch and the base ref — a stale local base
          // inflates the merge-base diff with unrelated commits.
          await this.workspace.fetchBranch(project.local_repo, run.branch ?? task.branch ?? project.base_branch);
          await this.workspace.fetchBranch(project.local_repo, project.base_branch);
          // A previous attempt may have died mid-`worktree add`; clear any
          // stale site path so the add cannot spuriously fail.
          await this.workspace.removeWorktree(project.local_repo, sitePath).catch(() => {});
          tempWorktree = await this.workspace.addDetachedWorktree(project.local_repo, reviewedSha, sitePath);
        } catch (err) {
          // A round cancelled during materialization must not pin the sha.
          if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during materialization', this.cancelTaskPhase(runId)); return; }
          // Cannot build a review site: infrastructure failure, not a code
          // verdict. ERROR counts as a verdict for this sha (no re-dispatch).
          this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
          this.finishReview(run, task, 'AWAITING_HUMAN', `review site unavailable: ${String(err).slice(0, 300)}`);
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
          void this.notifyReviewInfra(task, run, '自动评审现场搭建失败，转人工评审');
          return;
        }
      }
      store.updateRunFields(runId, { workspace: sitePath });
      if (prNum) { await this.setPrLabel(project.repo, prNum, true); labelApplied = true; }

      // --- run the read-only reviewer ----------------------------------------
      const ctx = await this.makePromptContext(run, task, project);
      ctx.worktreePath = sitePath;
      let diffEvidence: string;
      try {
        diffEvidence = await this.workspace.diffVsBase(sitePath, project.base_branch);
        mkdirSync(this.artifactsDirFor(run), { recursive: true });
        writeFileSync(join(this.artifactsDirFor(run), 'review-diff.patch'), diffEvidence, 'utf8');
      } catch (err) {
        if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during diff', this.cancelTaskPhase(runId)); return; }
        if (err instanceof DiffTooLargeError) {
          this.writeReviewVerdict(runId, reviewedSha, 'HUMAN_REVIEW_REQUIRED');
          this.finishReview(run, task, 'AWAITING_HUMAN', 'review diff too large; human review required');
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
          return;
        }
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
        this.finishReview(run, task, 'AWAITING_HUMAN', `review diff unavailable: ${String(err).slice(0, 300)}`);
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        return;
      }

      store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_started', head_sha: reviewedSha, pr_url: run.pr_url ?? task.pr_url });
      let outcome: Awaited<ReturnType<typeof runReview>> | undefined;
      let reviewError: unknown;
      try {
        outcome = await this.runReviewFn(ctx, this.testEvidenceFor(task, reviewedSha), diffEvidence, {
          agentConfig: this.config.agent,
          timeoutMs: this.config.server.max_task_minutes * 60_000,
          artifactsDir: this.artifactsDirFor(run), signal, headSha: reviewedSha,
          onSpawn: (pid, identity) => store.updateRunFields(runId, { pid, process_identity: identity }),
        });
      } catch (err) { reviewError = err; }

      // Cancel before any verdict row: a cancelled round must not pin the sha.
      if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during review', this.cancelTaskPhase(runId)); return; }

      // Tamper check on the materialized site before trusting the verdict.
      const headAfter = await this.workspace.head(sitePath).catch(() => null);
      const siteDirty = await this.workspace.isDirty(sitePath).catch(() => true);
      if (headAfter !== reviewedSha || siteDirty) {
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
        this.finishReview(run, task, 'AWAITING_HUMAN', headAfter !== reviewedSha
          ? 'review site HEAD moved during review; refusing verdict'
          : 'review site modified during review; refusing verdict');
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        return;
      }

      if (!outcome) {
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR',
          reviewError instanceof ReviewInfraError ? reviewError.logPath : undefined);
        store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_completed', head_sha: reviewedSha, verdict: 'ERROR', error: String(reviewError) });
        this.finishReview(run, task, 'AWAITING_HUMAN', `review infra: ${String(reviewError).slice(0, 400)}`);
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        void this.notifyReviewInfra(task, run, '自动评审不可用，转人工评审');
        return;
      }

      // --- verdict ------------------------------------------------------------
      const { result, logPath } = outcome;
      store.addCheck({ run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
        artifact_path: logPath, verdict: result.verdict, head_sha: reviewedSha });
      store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_completed', head_sha: reviewedSha,
        verdict: result.verdict, risk: result.risk, summary: result.summary, artifact_path: logPath });

      // An external PR has no issue to gate on and no branch the agent owns.
      // Its review is informational: post the verdict and park it. Never
      // spawn a fix run (nothing authorized touching someone's branch) and
      // never queue a merge. The state must still say which verdict it was:
      // BLOCK means the author has to change the PR (BLOCKED), while PASS and
      // HUMAN_REVIEW_REQUIRED both leave the decision with a human.
      if (task.source === 'pr') {
        if (prNum) {
          await this.tracker.commentPr(project.repo, prNum, this.externalPrReviewComment(result))
            .catch((err) => this.appLog.event('pr_comment_error', { run: runId, error: String(err) }));
        }
        const blocked = result.verdict === 'BLOCK';
        this.finishReview(run, task, blocked ? 'BLOCKED' : 'COMPLETED',
          `external PR review ${result.verdict}`, blocked ? 'BLOCKED' : 'AWAITING_HUMAN');
        return;
      }

      if (result.verdict === 'PASS') {
        const riskReasons = this.assessRisk(diffEvidence, result.risk);
        if (riskReasons.length > 0) {
          if (prNum) {
            await this.tracker.commentPr(project.repo, prNum, this.riskComment(result, riskReasons))
              .catch((err) => this.appLog.event('pr_comment_error', { run: runId, error: String(err) }));
          }
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
          this.finishReview(run, task, 'AWAITING_HUMAN', `review PASS but high risk: ${riskReasons.join('; ')}`);
          return;
        }
        if (prNum && this.config.approvals.auto_merge.enabled) {
          // A cancel that landed while the reviewer worked wins over the
          // merge handoff — never push a cancelled task into MERGING.
          if (aborted() || store.getRun(runId)?.cancel_requested === 1) {
            this.finishReview(run, task, 'CANCELED', 'cancelled at merge handoff', this.cancelTaskPhase(runId));
            return;
          }
          // The review run's job is the verdict; landing is the host-side
          // MERGING sweep's job — retried and crash-resumable there.
          this.finishReview(run, task, 'COMPLETED', 'review PASS; auto-merge queued', 'MERGING', { merge_attempts: 0, approved_sha: reviewedSha, approved_by: 'review' });
          return;
        }
        this.finishReview(run, task, 'AWAITING_HUMAN', 'review PASS');
        return;
      }

      if (result.verdict === 'HUMAN_REVIEW_REQUIRED') {
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        if (prNum) {
          await this.tracker.commentPr(project.repo, prNum, this.riskComment(result, ['reviewer requires human judgement']))
            .catch((err) => this.appLog.event('pr_comment_error', { run: runId, error: String(err) }));
        }
        this.finishReview(run, task, 'AWAITING_HUMAN', `review requires human: ${result.summary}`);
        return;
      }

      // BLOCK
      const findings = result.findings.filter((f) => f.trim());
      const budgetLeft = this.store.getTaskById(task.id)!.fix_rounds < this.config.server.retry_limit;
      if (findings.length > 0 && budgetLeft) {
        const payload: PendingFix = { head_sha: reviewedSha, summary: result.summary, findings };
        const spawned = store.tx(() => {
          // CAS: an out-of-band stop/merge between the abort check and this
          // write must not be overridden by a fix dispatch.
          const now = store.getTaskById(task.id);
          const cancelled = store.getRun(runId)?.cancel_requested === 1;
          if (!now || now.status !== 'REVIEWING') return false;
          // A stop in the verdict window: honor the cancel intent — never
          // leave a REVIEWING task with no live run and nothing to sweep it.
          if (cancelled) { store.setTaskStatus(task.id, 'CANCELED'); return false; }
          store.bumpFixRounds(task.id);
          store.setTaskStatus(task.id, 'DISCOVERED', { pending_fix: JSON.stringify(payload) });
          return true;
        });
        store.endRun(runId, 'BLOCKED', spawned
          ? `review BLOCK -> fix run spawned: ${result.summary}`
          : 'review BLOCK; fix spawn skipped — task state changed');
        if (spawned && prNum) {
          await this.tracker.commentPr(project.repo, prNum,
            `## 自动审查：BLOCK\n\n- 摘要：${result.summary}\n\n### Findings\n${findings.map((f) => `- ${f}`).join('\n')}\n\n已派生修复任务。`)
            .catch((err) => this.appLog.event('pr_comment_error', { run: runId, error: String(err) }));
        }
        this.appLog.event('review_block_fix_spawned', { run: runId, task: task.id, head_sha: reviewedSha, spawned });
        return;
      }
      this.finishReview(run, task, 'BLOCKED', findings.length === 0
        ? `review BLOCK without concrete findings: ${result.summary}; no automatic repair`
        : `review blocked, fix budget exhausted: ${result.summary}`);
    } finally {
      if (prNum && labelApplied) await this.setPrLabel(project.repo, prNum, false);
      if (tempWorktree) {
        await this.workspace.removeWorktree(project.local_repo, tempWorktree)
          .catch((err) => this.appLog.event('review_site_cleanup_error', { run: runId, error: String(err) }));
      }
    }
  }

  /**
   * Terminal write for review runs. Unlike finish() it never overrides a
   * task status already moved past REVIEWING (e.g. reconcileMergeStates COMPLETED
   * while the verdict was being written).
   */
  private finishReview(run: RunRow, task: TaskRow, finalPhase: Phase, reason?: string, taskPhase: Phase = finalPhase, taskFields?: { merge_attempts?: number; approved_sha?: string; approved_by?: 'review' | 'human' }) {
    if (!TERMINAL_FOR_TASK.includes(finalPhase)) throw new Error(`finishReview() requires terminal phase, got ${finalPhase}`);
    try {
      this.store.tx(() => {
        this.store.endRun(run.run_id, finalPhase, reason);
        const current = this.store.getTaskById(task.id);
        if (current && current.status === 'REVIEWING') {
          this.store.setTaskStatus(task.id, taskPhase, taskFields);
        }
      });
      if (ATTENTION_PHASES.includes(finalPhase)) void this.notifyTaskAttention(task, finalPhase, reason);
      if (finalPhase === 'BLOCKED' || finalPhase === 'BLOCKED_APPROVAL_CHANGED') {
        void this.labelQuietly(task.repo, task.issue_number, 'add', 'agent-blocked');
      }
      void this.labelQuietly(task.repo, task.issue_number, 'remove', 'agent-running');
    } catch (err) {
      this.appLog.event('finish_error', { run: run.run_id, error: String(err) });
      this.recordError('finish_error', err);
    }
  }

  /**
   * Land-style recovery for a MERGING task: GitHub refusing the merge
   * because the branch conflicts with base is fixable work — hand it to a
   * cold-start code run via pending_fix (shares the review-BLOCK fix
   * budget). The fix pushes a new head, which is a fresh sha and therefore
   * gets a fresh review before any merge. Non-conflict refusals stay on
   * the retry/human path.
   */
  private async spawnMergeFix(task: TaskRow, project: ProjectConfig, prNumber: number, headSha: string, mergeError: string): Promise<boolean> {
    const store = this.store;
    let mergeable: string = 'UNKNOWN';
    try {
      mergeable = (await this.tracker.getPrDetails(project.repo, prNumber)).mergeable;
    } catch (err) {
      this.appLog.event('mergeable_check_error', { task: task.id, error: String(err) });
    }
    if (mergeable !== 'CONFLICTING') return false;
    if (store.getTaskById(task.id)!.fix_rounds >= this.config.server.retry_limit) {
      await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
      return false;
    }
    const baseRef = `origin/${project.base_branch}`;
    const payload: PendingFix = {
      head_sha: headSha,
      title: '自动合并受阻',
      summary: `auto-merge failed: PR conflicts with ${project.base_branch}`,
      findings: [
        `GitHub 拒绝合并（${mergeError.slice(0, 200)}）：分支与 ${project.base_branch} 存在合并冲突。`,
        `执行 git merge ${baseRef}（base 引用已由宿主刷新，无需联网），逐个解决冲突文件，跑通项目 checks，正常收尾提交即可——宿主会自动推送同一 PR 分支并重新走一轮评审。`,
      ],
    };
    const spawned = store.tx(() => {
      const now = store.getTaskById(task.id);
      if (!now || now.status !== 'MERGING') return false;
      store.bumpFixRounds(task.id);
      store.setTaskStatus(task.id, 'DISCOVERED', { pending_fix: JSON.stringify(payload) });
      return true;
    });
    if (!spawned) return false;
    await this.tracker.commentPr(project.repo, prNumber,
      `## 自动合并受阻\n\n分支与 ${project.base_branch} 存在合并冲突，已派生修复任务：解冲突后将推送新 head 并自动重新评审。`)
      .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
    this.appLog.event('merge_fix_spawned', { task: task.id, head_sha: headSha });
    return true;
  }

  /**
   * User-requested cancel ends the task; a bare signal abort (shutdown) just
   * parks it back at AWAITING_REVIEW so the review can re-dispatch later.
   */
  private cancelTaskPhase(runId: string): Phase {
    return this.store.getRun(runId)?.cancel_requested === 1 ? 'CANCELED' : 'AWAITING_REVIEW';
  }

  /** Verdict row shared by all review exit paths that reach a conclusion. */
  private writeReviewVerdict(runId: string, headSha: string, verdict: string, artifactPath?: string) {
    this.store.addCheck({
      run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
      artifact_path: artifactPath, verdict, head_sha: headSha,
    });
  }

  /** Issue-side note when auto-review cannot run — never throws. */
  private async notifyReviewInfra(task: TaskRow, run: RunRow, detail: string) {
    try {
      await this.tracker.addComment(task.repo, task.issue_number,
        `agent-control: ${detail}。\nrun：\`${run.run_id}\``);
    } catch (err) {
      this.appLog.event('comment_error', { task: task.id, error: String(err) });
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
    if (task.source === 'pr') {
      // A PR-only task's description is the PR body — `gh issue view` does
      // not resolve a PR number.
      const prNum = prNumberFromUrl(task.pr_url);
      const pr = prNum ? await this.tracker.getPrDetails(project.repo, prNum).catch(() => null) : null;
      return {
        project,
        issue: {
          number: task.issue_number,
          title: task.issue_title,
          body: pr?.body ?? '',
          labels: [],
          state: 'OPEN',
          url: task.issue_url,
        },
        branch: run.branch ?? task.branch ?? project.base_branch,
        workflowPath: join(this.deps.installDir, 'WORKFLOW.md'),
        worktreePath: run.workspace ?? this.worktreePathFor(project, task),
      };
    }
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

  private async callChecks(run: RunRow, log: RunLog, worktreePath: string, signal: AbortSignal, headSha?: string | null): Promise<ChecksSummary> {
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
        head_sha: headSha,
      });
    });
    log.event('checks', { run: run.run_id, ok: summary.ok, count: summary.outcomes.length });
    return summary;
  }

  private testEvidenceFor(task: TaskRow, headSha: string): string {
    const render = (rows: ReturnType<Store['checkEvidenceForSha']>) =>
      rows
        .map((c) => `命令: ${c.command}\n结果: ${c.verdict} (exit ${c.exit_code ?? 'n/a'})\n日志: ${c.artifact_path ?? '-'}\n日志尾部:\n${this.checkLogTail(c.artifact_path)}`)
        .join('\n\n');
    const prefix = `提交 SHA: ${headSha}\n`;
    const scoped = this.store.checkEvidenceForSha(task.id, headSha);
    if (scoped.length > 0) return prefix + render(scoped);
    // Legacy rows predate head_sha binding: the evidence is still real
    // (usually produced by the run that authored this very head), but the
    // reviewer must be told it is not sha-scoped rather than given nothing.
    const fallback = this.store.latestCheckEvidence(task.id);
    if (fallback.length === 0) return `${prefix}(no checks recorded)`;
    return `${prefix}注意：以下检查证据来自更早的 run，未绑定此 SHA（历史数据无 head_sha 列）。通常它验证的正是本次被审提交，但请以 <diff> 自行核对，证据可信度按弱一等对待。\n` + render(fallback);
  }

  /**
   * The reviewer has no shell, so "verdict PASS (exit 0)" alone proves
   * nothing — it cannot tell a real suite from an empty script that exits 0.
   * Host-read output tail is the only evidence it can inspect.
   */
  private checkLogTail(path: string | null, lines = 30): string {
    if (!path) return '(日志文件缺失)';
    try {
      const tail = readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n').trim();
      return tail || '(日志为空)';
    } catch (err) {
      return `(日志不可读: ${String(err).slice(0, 80)})`;
    }
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
    // An external PR is authorized by its own existence: there is no ready
    // label to re-check and no approval hash to drift.
    if (task.source === 'pr') return 'ok';
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
    const files = new Map<string, 'new' | 'deleted' | 'modified'>();
    let changedLines = 0;
    let current: string | null = null;
    for (const line of diff.split('\n')) {
      const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (header) { current = header[2]!; if (!files.has(current)) files.set(current, 'modified'); continue; }
      if (current && line.startsWith('new file mode')) files.set(current, 'new');
      else if (current && line.startsWith('deleted file mode')) files.set(current, 'deleted');
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
    for (const [file, status] of files) {
      if (sensitive.test(file)) reasons.push(`sensitive path: ${file}`);
      else if (dependency.test(file)) reasons.push(`dependency change: ${file}`);
      else if (build.test(file)) reasons.push(`build or migration change: ${file}`);
      // Weakened coverage is the risk — deleting or editing existing tests —
      // not a newly added test file accompanying the change it covers.
      else if (tests.test(file) && status !== 'new') reasons.push(`test change (${status}): ${file}`);
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

  private externalPrReviewComment(result: ReviewResult): string {
    const findings = result.findings.filter((f) => f.trim());
    return [
      `## 自动评审：${result.verdict}`,
      '',
      `- 结论：${result.verdict}`,
      `- 风险：${result.risk}`,
      `- 摘要：${result.summary}`,
      '',
      ...(findings.length > 0 ? ['### 发现', ...findings.map((f) => `- ${f}`), ''] : []),
      '此 PR 没有关联 issue，agent-control 只做评审，不会修改分支、也不会自动合并。',
    ].join('\n');
  }

  private finish(run: RunRow, task: TaskRow, finalPhase: Phase, reason?: string, taskFields?: { pr_url?: string; merge_attempts?: number; approved_sha?: string; approved_by?: 'review' | 'human' }, taskPhase: Phase = finalPhase) {
    if (!TERMINAL_FOR_TASK.includes(finalPhase)) throw new Error(`finish() requires terminal phase, got ${finalPhase}`);
    try {
      this.store.tx(() => {
        this.store.endRun(run.run_id, finalPhase, reason);
        this.store.setTaskStatus(task.id, taskPhase, taskFields);
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
    fields?: { approved_hash?: string | null; branch?: string | null; pr_url?: string | null; pending_fix?: string | null },
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
    // The cleanup target is the CODING worktree — never a review run's
    // materialized site (the review's own finally already removes that).
    const worktree = this.store.lastCodeWorkspace(task.id) ?? this.worktreePathFor(project, task);
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

  /**
   * Post-claim arbitration for the documented non-atomic label race: after
   * posting our own claim comment, wait a settle window then re-read issue
   * comments. Among recent "已领取" comments the earliest (createdAt, body)
   * wins. A rival is any claim comment whose hostname is not ours — our own
   * earlier attempts' comments are ghosts, not rivals. Unknown same-hostname
   * siblings cannot be told apart from ghosts and are an accepted gap.
   * Losing leaves `agent-running` in place: it belongs to the winner.
   */
  private async lostClaimRace(project: ProjectConfig, task: TaskRow, runId: string): Promise<boolean> {
    await sleep(this.deps.claimArbitrationMs ?? 4000);
    const comments = await this.tracker.listIssueComments(project.repo, task.issue_number).catch((err) => {
      this.appLog.event('claim_arbiter_error', { task: task.id, error: String(err) });
      return null;
    });
    if (comments === null) return false; // arbiter is best-effort; never stall dispatch on API failure
    const cutoff = Date.now() - 10 * 60_000;
    const claims = comments.filter(
      (c) => c.body.startsWith('agent-control: 已领取') && Date.parse(c.createdAt) >= cutoff,
    );
    const key = (c: { body: string; createdAt: string }) => `${c.createdAt}${c.body}`;
    const rivals = claims.filter((c) => !c.body.includes(runId) && !c.body.includes(hostname()));
    if (rivals.length === 0) return false;
    const mine = claims.filter((c) => c.body.includes(runId)).map(key).sort()[0];
    const earliestRival = rivals.map(key).sort()[0]!;
    return mine === undefined || earliestRival < mine;
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

  /** Best-effort PR label write — never throws into the sweep. */
  private async prLabelQuietly(repo: string, prNumber: number, label: string, add: boolean) {
    try {
      if (add) await this.tracker.addPrLabel(repo, prNumber, label);
      else await this.tracker.removePrLabel(repo, prNumber, label);
    } catch (err) {
      this.appLog.event('label_error', {
        repo, pr: prNumber, op: add ? 'add' : 'remove', label, error: String(err),
      });
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
