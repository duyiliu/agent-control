import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from '../store/sqlite.js';
import { RunLog, type AppLog } from '../telemetry/logging.js';
import { approvalHash, GitHubTracker, type OpenPr } from '../tracker/github.js';
import { runProcessRisk, type ProcessSafetyDeps } from '../proc.js';
import { markRecoveryRequired } from './recovery.js';
import { DiffTooLargeError, GitWorkspace } from '../workspace/git.js';
import { openPiCoderSession, SessionRestoreError, type CoderSession, type CoderSessionOpts, type CoderTurn } from '../runners/session.js';
import { PI_ALL_TOOLS } from '../runners/pi.js';
import { checksForPlatform, runChecks, skippedChecks, type ChecksSummary } from '../verify/checks.js';
import { resolveCheckPlan, type CheckPlan } from '../verify/discovery.js';
import { assessmentResult } from '../verify/review-v2.js';
import { runReview, ReviewInfraError } from '../verify/review.js';
import { createHash } from 'node:crypto';
import { newReviewControl, reserveReview, reserveFix, retryReview, unresolvedDecisions, validateReviewAssessment } from '../verify/review-policy.js';
import type { ReviewControl, ReviewAssessment, ReviewScope, DecisionRequest } from '../types.js';
import { publishDraftPr, PublishError } from '../publish/pr.js';
import { buildCoderPrompt, buildFixPrompt, CODER_RESUME_NOTE, MAX_REVIEW_DIFF_CHARS, type PromptContext } from './prompts.js';
import {
  classifyPath, codeStats, DEFAULT_POLICY, filterGenerated, SENSITIVE_PATH, splitDiff, type DiffFile, type PathPolicy,
} from './diff-paths.js';
import type { AppConfig, CheckSpec, IssueData, PendingFix, Phase, ProjectConfig, ReviewResult, RunRow, TaskRow } from '../types.js';
import { RUN_ACTIVE_PHASES } from '../types.js';
import { IssueTriage } from '../triage/service.js';
import { MANAGED } from '../triage/state.js';
import { acceptsAllIssues, parseOutcome } from '../triage/intake.js';

// Older v2 rounds auto-generated this exact question for any breaking change.
// It is a host template, not a reviewer judgement, so reruns drop it.
const HOST_BREAKING_QUESTION = '是否接受本提交的破坏性兼容变化？';

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
  /** Process-safety seam for the deferred-resume sweep (tests inject fakes). */
  recoveryProcessDeps?: ProcessSafetyDeps;
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

/** Human-declared complexity marker: selects agent.complex_* for every coder
 *  turn of this task (initial implementation, fixes and conflict repair). */
const COMPLEX_LABEL = 'agent-complex';

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

function priorReviewItems(assessment: ReviewAssessment): string {
  const items = [
    ...assessment.findings.map(f => `[finding] ${f.file}:${f.line} ${f.trigger} → ${f.impact}；验证：${f.verification}`),
    ...assessment.verification_requests.map(v => `[verification] ${v.claim}；场景：${v.scenario}；通过标准：${v.expected}`),
  ];
  return items.length ? items.join('\n') : '（上轮无未解决项）';
}

export class Engine {
  readonly triage: IssueTriage;
  private controllers = new Map<string, AbortController>();
  private inFlight = new Set<string>(); // run_ids currently executing in this process
  /** task:approved:head triples already proven reproducible — a merge retry
   *  must not rebuild the same tree every tick. */
  private verifiedBuilds = new Set<string>();
  /** Resumable runs held back by max_concurrent: run_id -> target phase. */
  private deferredResumes = new Map<string, Phase>();
  private openCoderSessionFn: NonNullable<EngineDeps['openCoderSessionFn']>;
  private runReviewFn: NonNullable<EngineDeps['runReviewFn']>;
  private runChecksFn: NonNullable<EngineDeps['runChecksFn']>;
  private ticking = false;
  private stopping = false;
  /** Runs already annotated as suspended for this shutdown (write once). */
  private suspended = new Set<string>();
  private closedCursor = 0;

  private async reconcileClosedIssues() {
    const candidates = this.store.listTasks().filter(t => t.source === 'issue'
      && !['COMPLETED', 'CANCELED'].includes(t.status) && !this.store.activeRunForTask(t.id)
      && !this.store.getIntake<{ kind?: string; locked?: boolean }>(t.repo, t.issue_number)?.kind
      && !this.store.getIntake<{ locked?: boolean }>(t.repo, t.issue_number)?.locked);
    const ordered = [...candidates.filter(t => t.id > this.closedCursor), ...candidates.filter(t => t.id <= this.closedCursor)].slice(0, 10);
    for (const task of ordered) {
      if (this.stopping) return;
      this.closedCursor = task.id;
      try {
        const issue = await this.tracker.getIssue(task.repo, task.issue_number);
        if (!issue || issue.state !== 'CLOSED') continue;
        const version = task.updated_at;
        const prNumber = prNumberFromUrl(task.pr_url);
        if (prNumber && await this.tracker.getPrState(task.repo, prNumber) === 'MERGED') {
          const project = this.projectFor(task.repo);
          if (project) await this.completeMergedTask(task, project);
          continue;
        }
        this.store.tx(() => {
          const current = this.store.getTaskById(task.id);
          const intake = this.triage.state(task.repo, task.issue_number);
          if (!current || current.updated_at !== version || this.store.activeRunForTask(task.id) || intake?.kind || intake?.locked) return;
          if (intake) this.store.saveIntake(task.repo, task.issue_number, { ...intake, pending: null, error: null, reason: 'Issue 已在外部关闭', version: intake.version + 1, updated_at: new Date().toISOString() });
          const control = this.store.getReviewControl(task.id);
          if (control) this.store.saveReviewControl(task.id, { ...control, next_attempt_at: null });
          const last = this.store.runsForTask(task.id).at(-1);
          if (last) this.store.transition(last.run_id, last.phase, last.phase, { kind: 'external_issue_closed', task_status: 'CANCELED' });
          this.store.setTaskStatus(task.id, 'CANCELED', { pending_fix: null, approved_sha: null, approved_by: null });
          this.appLog.event('external_issue_closed', { task: task.id });
        });
      } catch (error) { this.appLog.event('closed_reconcile_error', { task: task.id, error: String(error) }); }
    }
  }

  private reviewExecutionFailure(run: RunRow, task: TaskRow, reason: string, artifactPath?: string): boolean {
    const control = this.store.getReviewControl(task.id);
    if (!control) return false;
    this.store.tx(() => {
      const next = retryReview(control);
      this.store.saveReviewControl(task.id, next);
      this.writeReviewVerdict(run.run_id, run.head_sha!, 'ERROR', artifactPath);
      this.store.transition(run.run_id, run.phase === 'CLAIMED' ? 'REVIEWING' : run.phase, 'REVIEWING', {
        kind: 'review_execution_error', reason, next_attempt_at: next.next_attempt_at, policy_version: 2,
      });
      this.finishReview(run, task, 'FAILED', reason, next.next_attempt_at ? 'AWAITING_REVIEW' : 'BLOCKED');
    });
    return true;
  }

  private async applyReviewV2(run: RunRow, task: TaskRow, project: ProjectConfig, result: ReviewResult, logPath: string, diff: string) {
    let assessment: ReviewAssessment;
    try { assessment = validateReviewAssessment(result.assessment); }
    catch (error) { this.reviewExecutionFailure(run, task, `review infra: invalid v2 assessment: ${String(error)}`, logPath); return; }
    const control = this.store.getReviewControl(task.id)!;
    const sha = run.head_sha!;
    if (control.assessment && control.head_sha === sha) {
      const unique = <T>(values: T[]) => [...new Map(values.map(v => [JSON.stringify(v), v])).values()];
      assessment.findings = unique([...control.assessment.findings, ...assessment.findings]);
      assessment.verification_requests = unique([...control.assessment.verification_requests, ...assessment.verification_requests]);
    }
    const requests: DecisionRequest[] = [...assessment.decision_requests];
    const protectedFiles = splitDiff(diff).filter(f => classifyPath(f.path, { generated: project.human_review_paths ?? [], docs: [] }) === 'generated');
    for (const file of protectedFiles) requests.push({ type: 'configured_hold', file: file.path,
      question: `是否批准修改受保护路径 ${file.path}？`, options: ['批准当前提交', '拒绝当前提交'],
      impact: `项目 human_review_paths 覆盖 ${file.path}`, reason: '项目显式设置的人工门禁',
    });
    const requested = requests.map(request => ({ ...request,
      ...(request.type !== 'product_choice' ? { options: ['批准当前提交', '拒绝当前提交'] } : {}), request_id: createHash('sha256').update(JSON.stringify({
      requirement: control.requirement_hash, type: request.type, file: request.file ?? '', question: request.question, options: request.options,
    })).digest('hex').slice(0, 24), head_sha: sha, requirement_hash: control.requirement_hash }));
    const decisions = [...new Map([...control.decisions.filter(d => d.head_sha === sha
      && !(d.type === 'breaking_change' && d.question === HOST_BREAKING_QUESTION)), ...requested].map(d => [d.request_id, d])).values()];
    const next = { ...control, assessment, decisions, next_attempt_at: null };
    this.store.saveReviewControl(task.id, next);
    const pending = unresolvedDecisions(next, sha);
    const findings = assessment.findings.map(f => `${f.file}:${f.line}: ${f.trigger}; ${f.impact}; 验证: ${f.verification}`);
    findings.push(...assessment.verification_requests.map(v => `补充验证：${v.claim}; 场景：${v.scenario}; 通过标准：${v.expected}`));
    if (assessment.compatibility.kind === 'unknown') findings.push('核对受影响调用方及旧默认行为，补齐兼容性证据；不得仅凭未知状态放行');
    if (assessment.compatibility.kind === 'breaking') findings.push(`破坏性兼容变化：${assessment.compatibility.evidence.join('；')}；先恢复既有行为，或由评审提出具体产品取舍`);
    const verdict = pending.length ? 'HUMAN_REVIEW_REQUIRED' : findings.length ? 'BLOCK' : 'PASS';
    this.store.addCheck({ run_id: run.run_id, kind: 'review', command: 'agent (review v2)', exit_code: null,
      artifact_path: logPath, verdict, head_sha: sha, detail_json: JSON.stringify(assessment) });
    this.store.transition(run.run_id, 'REVIEWING', 'REVIEWING', { kind: 'review_completed', head_sha: sha, verdict, policy_version: 2, summary: assessment.summary, decisions: pending.length });
    if (this.reviewDenied(next, sha)) { this.finishReview(run, task, 'BLOCKED', 'current head authorization was rejected'); return; }
    if (pending.length) { this.finishReview(run, task, 'AWAITING_HUMAN', `decision required: ${pending.map(d => d.question).join('; ')}`); return; }
    if (findings.length) {
      try {
        this.store.tx(() => {
          const current = this.store.getTaskById(task.id);
          if (current?.status !== 'REVIEWING' || this.store.getRun(run.run_id)?.cancel_requested) throw new Error('task changed during review');
          this.store.saveReviewControl(task.id, reserveFix(next, this.config.server.retry_limit));
          this.store.bumpFixRounds(task.id);
          this.finishReview(run, task, 'BLOCKED', 'review v2 requires repair or verification', 'DISCOVERED');
          this.store.setTaskStatus(task.id, 'DISCOVERED', { pending_fix: JSON.stringify({ head_sha: sha, summary: assessment.summary, findings } satisfies PendingFix) });
        });
      } catch (error) { this.finishReview(run, task, 'BLOCKED', `review repair budget or state exhausted: ${String(error)}`); }
      return;
    }
    const prNumber = prNumberFromUrl(task.pr_url);
    if (!prNumber) { this.finishReview(run, task, 'AWAITING_HUMAN', 'Review PASS but no PR is available for human handoff'); return; }
    await this.handoffPassedReview(run, task, project, sha, control.base_sha, this.store.lastCodeWorkspace(task.id) ?? this.worktreePathFor(project, task), assessment.summary, diff);
  }

  private reviewDenied(control: ReviewControl, sha: string): boolean {
    return control.decisions.some(d => d.type !== 'product_choice' && control.resolutions.some(r =>
      r.request_id === d.request_id && r.requirement_hash === control.requirement_hash && r.head_sha === sha && r.selected_option === '拒绝当前提交'));
  }

  private async v2MergeGate(task: TaskRow, project: ProjectConfig, pr: { headSha: string; baseSha?: string }): Promise<boolean> {
    const control = this.store.getReviewControl(task.id);
    if (!control) return true;
    if (task.source === 'pr') return false;
    const current = this.store.getTaskById(task.id);
    if (!current || current.updated_at !== task.updated_at || this.store.activeRunForTask(task.id)) return false;
    const issue = await this.tracker.getIssue(task.repo, task.issue_number);
    if (!issue) return false;
    if (issue.state !== 'OPEN') { this.setTaskStatus(task.id, 'CANCELED', { pending_fix: null }); return false; }
    if (approvalHash(issue) !== control.requirement_hash || current.approved_hash !== control.requirement_hash) {
      this.setTaskStatus(task.id, 'BLOCKED_APPROVAL_CHANGED'); return false;
    }
    const intake = this.triage.state(task.repo, task.issue_number);
    if (issue.labels.some(l => ['agent-human-hold', 'agent-needs-human', 'agent-running'].includes(l))
      || intake && (!intake.imported || intake.kind || intake.locked || intake.pending || intake.error || intake.external_hold || intake.external_needs)) return false;
    if (control.head_sha !== pr.headSha) {
      this.store.setTaskStatus(task.id, project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN', { approved_sha: null, approved_by: null });
      return false;
    }
    if (unresolvedDecisions(control, pr.headSha).length || this.reviewDenied(control, pr.headSha)) return false;
    if (control.assessment && (control.assessment.findings.length || control.assessment.verification_requests.length
      || control.assessment.compatibility.kind === 'unknown' || control.assessment.compatibility.kind === 'breaking')) return false;
    if (project.review_mode === 'auto' && !control.assessment) return false;
    if (!pr.baseSha || !control.base_sha || pr.baseSha !== control.base_sha) {
      this.store.setTaskStatus(task.id, project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'BLOCKED', { approved_sha: null, approved_by: null });
      return false;
    }
    const site = this.store.lastCodeWorkspace(task.id);
    if ((project.human_review_paths?.length || project.review_mode === 'manual') && site) {
      if (await this.workspace.head(site) !== pr.headSha || await this.workspace.isDirty(site)) return false;
      const fullDiff = await this.workspace.diffVsBase(site, control.base_sha, Number.POSITIVE_INFINITY);
      const guarded = splitDiff(fullDiff).filter(file =>
        classifyPath(file.path, { generated: project.human_review_paths ?? [], docs: [] }) === 'generated'
        || project.review_mode === 'manual' && SENSITIVE_PATH.test(file.path));
      const missing = guarded.filter(file => !control.decisions.some(d => d.file === file.path && d.head_sha === pr.headSha
        && d.type !== 'product_choice' && control.resolutions.some(r => r.request_id === d.request_id && r.head_sha === pr.headSha
          && r.requirement_hash === control.requirement_hash && r.selected_option === '批准当前提交')));
      if (missing.length) {
        const decisions = missing.map(file => ({ type: 'configured_hold' as const, file: file.path,
          question: `是否批准修改受保护路径 ${file.path}？`, options: ['批准当前提交', '拒绝当前提交'],
          impact: `当前提交触及 ${file.path}`, reason: '宿主合并前的人工保护核验', head_sha: pr.headSha, requirement_hash: control.requirement_hash,
          request_id: createHash('sha256').update(`${control.requirement_hash}:${pr.headSha}:protected:${file.path}`).digest('hex').slice(0, 24),
        }));
        this.store.saveReviewControl(task.id, { ...control, decisions: [...control.decisions, ...decisions] });
        this.store.setTaskStatus(task.id, 'AWAITING_HUMAN', { approved_sha: null, approved_by: null });
        return false;
      }
    } else if ((project.human_review_paths?.length || project.review_mode === 'manual') && !site) {
      this.setTaskStatus(task.id, 'BLOCKED'); return false;
    }
    const plan = site ? resolveCheckPlan(project.checks, site) : { checks: project.checks, source: 'configured' as const };
    const evidence = this.guardedCheckEvidence(task.id, pr.headSha);
    if (plan.error || checksForPlatform(plan.checks).some(check => !evidence.some(row => row.command === check.argv.join(' ') && row.verdict === 'PASS'))) {
      this.setTaskStatus(task.id, project.review_mode === 'auto' ? 'AWAITING_REVIEW' : 'BLOCKED'); return false;
    }
    return this.store.getTaskById(task.id)?.updated_at === task.updated_at;
  }

  /**
   * v2 auto-merge eligibility: a PASS verdict only enters MERGING when the
   * task is proven routine. Unanswered decision requests, review leftovers,
   * guarded paths, intake vetoes, non-issue sources and the source-code size
   * gate each bounce the task back to the human path; resolved decisions do
   * not — answering a question already counts as the human's intervention.
   */
  private autoMergeEligibility(task: TaskRow, project: ProjectConfig, sha: string, files: DiffFile[]): { ok: boolean; reason: string } {
    const cfg = this.config.approvals.auto_merge;
    const control = this.store.getReviewControl(task.id);
    if (!cfg.enabled || task.source !== 'issue' || !control) return { ok: false, reason: '' };
    if (unresolvedDecisions(control, sha).length) return { ok: false, reason: '存在未解决的人工决策' };
    const assessment = control.assessment;
    if (assessment && (assessment.findings.length > 0 || assessment.verification_requests.length > 0
      || assessment.compatibility.kind === 'breaking' || assessment.compatibility.kind === 'unknown')) {
      return { ok: false, reason: '评审存在未决 findings、补证或兼容性疑点' };
    }
    const intake = this.store.getIntake<{ locked?: boolean; external_hold?: boolean; external_needs?: boolean }>(task.repo, task.issue_number);
    if (intake?.locked || intake?.external_hold || intake?.external_needs) return { ok: false, reason: '任务存在人工门禁' };
    const guarded = files.filter(file =>
      classifyPath(file.path, { generated: project.human_review_paths ?? [], docs: [] }) === 'generated'
      || (project.review_mode === 'manual' && SENSITIVE_PATH.test(file.path)));
    if (guarded.length) return { ok: false, reason: `触及受保护路径 ${guarded[0]!.path}` };
    const stats = codeStats(files, this.pathPolicy());
    if (stats.files > cfg.max_files || stats.lines > cfg.max_lines) {
      return { ok: false, reason: `源码改动 ${stats.files} 文件 / ${stats.lines} 行超过自动合并阈值 ${cfg.max_files}/${cfg.max_lines}` };
    }
    return { ok: true, reason: '' };
  }

  private async handoffPassedReview(run: RunRow, task: TaskRow, project: ProjectConfig, sha: string, baseSha: string | null | undefined, sitePath: string, summary: string, diff: string) {
    const prNumber = prNumberFromUrl(run.pr_url ?? task.pr_url);
    if (!prNumber) { this.finishReview(run, task, 'BLOCKED', 'review PASS but no PR is available for human handoff', 'AWAITING_HUMAN'); return; }
    if (this.store.getRun(run.run_id)?.cancel_requested || this.stopping) {
      this.finishReview(run, task, 'CANCELED', 'cancelled at human handoff', this.cancelTaskPhase(run.run_id)); return;
    }
    const gate = await this.gateApproval(project, task);
    if (gate !== 'ok') { this.finishReview(run, task, gate, 'approval gate changed before human handoff'); return; }
    let before;
    try { before = await this.tracker.getPrDetails(project.repo, prNumber); }
    catch (error) { this.finishReview(run, task, 'AWAITING_HUMAN', `Review PASS but cannot verify PR before handoff: ${String(error).slice(0, 250)}`); return; }
    if (before.state !== 'OPEN') { this.finishReview(run, task, 'AWAITING_HUMAN', `Review PASS but PR is ${before.state}`); return; }
    if (before.headSha !== sha || baseSha && before.baseSha !== baseSha) {
      this.finishReview(run, task, 'CANCELED', 'PR HEAD or base changed after review; re-review required', 'AWAITING_REVIEW'); return;
    }
    const plan = resolveCheckPlan(project.checks, sitePath);
    const applicable = checksForPlatform(plan.checks);
    const evidence = this.guardedCheckEvidence(task.id, sha);
    const missing = applicable.filter(check => !evidence.some(row => row.command === check.argv.join(' ') && row.verdict === 'PASS'));
    if (plan.error || applicable.length === 0 || missing.length) {
      const reason = plan.error ?? (applicable.length === 0
        ? '没有适用的宿主检查；零项检查不能证明验证通过'
        : `当前 SHA 缺少通过的宿主检查：${missing.map(check => check.argv.join(' ')).join('; ')}`);
      this.finishReview(run, task, 'AWAITING_HUMAN', `Review PASS，但不能安全交接：${reason}`);
      return;
    }
    const finalGate = await this.gateApproval(project, task);
    if (finalGate !== 'ok') { this.finishReview(run, task, finalGate, 'approval gate changed before PR ready'); return; }
    if (this.store.getTaskById(task.id)?.status !== 'REVIEWING') {
      this.finishReview(run, task, 'CANCELED', 'task left review before PR ready', this.store.getTaskById(task.id)?.status ?? 'CANCELED'); return;
    }
    if (this.store.getRun(run.run_id)?.cancel_requested || this.stopping) {
      this.finishReview(run, task, 'CANCELED', 'cancelled before PR ready', this.cancelTaskPhase(run.run_id)); return;
    }
    let readyRequested = !before.isDraft;
    try {
      if (before.isDraft) { readyRequested = true; await this.tracker.markPrReady(project.repo, prNumber); }
      const after = await this.tracker.getPrDetails(project.repo, prNumber);
      const currentGate = await this.gateApproval(project, task);
      const canceled = this.store.getRun(run.run_id)?.cancel_requested === 1 || this.stopping;
      const taskStillReviewing = this.store.getTaskById(task.id)?.status === 'REVIEWING';
      if (after.state !== 'OPEN' || after.headSha !== sha || baseSha && after.baseSha !== baseSha
        || after.isDraft || currentGate !== 'ok' || canceled || !taskStillReviewing) {
        let draftRestored = after.isDraft;
        if (!after.isDraft && after.state === 'OPEN') {
          await this.tracker.markPrDraft(project.repo, prNumber).then(() => { draftRestored = true; }).catch((error) => {
            this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(error) });
          });
        }
        const moved = after.headSha !== sha || Boolean(baseSha && after.baseSha !== baseSha);
        const finalPhase = canceled || moved ? 'CANCELED' : currentGate !== 'ok' ? currentGate : 'BLOCKED';
        const taskPhase = moved ? (this.reviewsPr(project, task) ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN') : canceled ? this.cancelTaskPhase(run.run_id)
          : currentGate !== 'ok' ? currentGate : !taskStillReviewing ? this.store.getTaskById(task.id)?.status ?? 'CANCELED' : 'AWAITING_HUMAN';
        this.finishReview(run, task, finalPhase,
          `${moved ? 'PR HEAD/base changed' : canceled ? 'handoff cancelled' : currentGate !== 'ok' ? 'approval changed' : 'handoff interrupted'} after Ready request${draftRestored ? '; PR returned to Draft' : '; PR draft state needs manual verification'}`,
          taskPhase);
        return;
      }
      const checkList = applicable.map(check => `- \`${check.argv.join(' ')}\`: PASS`).join('\n');
      const diffFiles = splitDiff(diff);
      const files = [...new Set(diffFiles.map(file => file.path))];
      const fileList = [...files.slice(0, 50).map(file => `- \`${file}\``), ...(files.length > 50 ? [`- 另有 ${files.length - 50} 个文件`] : [])].join('\n') || '- (未解析到文件路径)';
      const auto = this.autoMergeEligibility(task, project, sha, diffFiles);
      if (auto.ok) {
        await this.tracker.commentPr(project.repo, prNumber,
          `<!-- agent-control-human-handoff:${sha} -->\n## AI 已完成，符合自动合并条件\n\n- HEAD：\`${sha}\`\n- Review：PASS\n- Review 摘要 / 已知风险：${summary.slice(0, 500)}\n\n### 实现范围\n${fileList}\n\n### 宿主 Checks\n${checkList}\n\n已自动批准并进入合并流程（approvals.auto_merge）。`)
          .catch(error => { this.appLog.event('pr_handoff_comment_error', { task: task.id, pr: prNumber, error: String(error) }); throw error; });
        this.store.transition(run.run_id, 'REVIEWING', 'REVIEWING', { kind: 'auto_merge_approved', head_sha: sha, base_sha: baseSha });
        this.appLog.event('auto_merge_approved', { task: task.id, head_sha: sha });
        this.finishReview(run, task, 'COMPLETED', 'AI 已完成，符合自动合并条件，进入合并', 'MERGING', { merge_attempts: 0, approved_sha: sha, approved_by: 'review' });
        return;
      }
      if (auto.reason) this.appLog.event('auto_merge_ineligible', { task: task.id, reason: auto.reason });
      await this.tracker.commentPr(project.repo, prNumber,
        `<!-- agent-control-human-handoff:${sha} -->\n## AI 已完成，待人工审查\n\n- HEAD：\`${sha}\`\n- Review：PASS\n- Review 摘要 / 已知风险：${summary.slice(0, 500)}\n\n### 实现范围\n${fileList}\n\n### 宿主 Checks\n${checkList}\n\n请在 GitHub 审查并决定是否合并。AI PASS 不会自动合并。`)
        .catch(error => { this.appLog.event('pr_handoff_comment_error', { task: task.id, pr: prNumber, error: String(error) }); throw error; });
      const afterComment = await this.tracker.getPrDetails(project.repo, prNumber);
      const commentGate = await this.gateApproval(project, task);
      const commentCanceled = this.store.getRun(run.run_id)?.cancel_requested === 1 || this.stopping;
      const taskStillReviewingAfterComment = this.store.getTaskById(task.id)?.status === 'REVIEWING';
      const commentMoved = afterComment.headSha !== sha || Boolean(baseSha && afterComment.baseSha !== baseSha);
      if (afterComment.state !== 'OPEN' || afterComment.isDraft || commentMoved || commentGate !== 'ok'
        || commentCanceled || !taskStillReviewingAfterComment) {
        let draftRestored = afterComment.isDraft;
        if (afterComment.state === 'OPEN' && !afterComment.isDraft) {
          await this.tracker.markPrDraft(project.repo, prNumber).then(() => { draftRestored = true; }).catch(error => {
            this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(error) });
          });
        }
        const finalPhase = commentCanceled || commentMoved ? 'CANCELED' : commentGate !== 'ok' ? commentGate
          : !taskStillReviewingAfterComment ? 'CANCELED' : 'AWAITING_HUMAN';
        const taskPhase = commentMoved ? (this.reviewsPr(project, task) ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN')
          : commentCanceled ? this.cancelTaskPhase(run.run_id)
          : commentGate !== 'ok' ? commentGate
          : !taskStillReviewingAfterComment ? this.store.getTaskById(task.id)?.status ?? 'CANCELED' : 'AWAITING_HUMAN';
        this.finishReview(run, task, finalPhase,
          `${commentMoved ? 'PR HEAD/base changed' : commentCanceled ? 'handoff cancelled while publishing summary' : commentGate !== 'ok' ? 'approval changed while publishing summary' : 'handoff interrupted while publishing summary'}${draftRestored ? '; PR returned to Draft' : ''}`,
          taskPhase);
        return;
      }
      this.store.transition(run.run_id, 'REVIEWING', 'REVIEWING', { kind: 'human_handoff_ready', head_sha: sha, base_sha: baseSha ?? afterComment.baseSha, checks: applicable.map(check => check.argv.join(' ')) });
      this.finishReview(run, task, 'COMPLETED', 'AI 已完成，PR Ready for review，等待人工审查', 'AWAITING_HUMAN');
    } catch (error) {
      if (readyRequested) {
        try {
          const current = await this.tracker.getPrDetails(project.repo, prNumber);
          if (current.state === 'OPEN' && !current.isDraft) await this.tracker.markPrDraft(project.repo, prNumber);
        } catch (restoreError) {
          this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(restoreError) });
          await this.tracker.markPrDraft(project.repo, prNumber).catch(fallbackError => {
            this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(fallbackError), fallback: true });
          });
        }
      }
      const canceled = this.store.getRun(run.run_id)?.cancel_requested === 1 || this.stopping;
      this.finishReview(run, task, canceled ? 'CANCELED' : 'AWAITING_HUMAN',
        `${canceled ? 'human handoff cancelled' : 'Review PASS，但 PR 无法安全转 Ready'}：${String(error).slice(0, 250)}`,
        canceled ? this.cancelTaskPhase(run.run_id) : 'AWAITING_HUMAN');
    }
  }

  constructor(private deps: EngineDeps) {
    this.triage = new IssueTriage({ ...deps, canStart: () => !this.stopping && this.activeCount() < this.config.server.max_concurrent });
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
  activeCount() { return this.inFlight.size + this.triage.activeCount(); }

  /** Abort an in-flight run (used by shutdown and the cancel sweep). */
  abortRun(runId: string, why = 'cancelled') {
    const ctl = this.controllers.get(runId);
    if (ctl) ctl.abort(why);
  }

  /**
   * Service shutdown: abort in-flight runs and stop taking new work, then
   * wait — bounded — for the tick and every run's finally (session.close
   * included) to finish. Returns whether the process went fully quiet;
   * false means children may still be alive and the next boot's PID/orphan
   * checks must decide. Never writes CANCELED or touches pids.
   */
  async shutdown(timeoutMs = 10_000): Promise<boolean> {
    this.stopping = true;
    void this.triage.shutdown();
    for (const ctl of this.controllers.values()) ctl.abort('service shutdown');
    const deadline = Date.now() + timeoutMs;
    while ((!this.ticking && this.activeCount() === 0) === false && Date.now() < deadline) {
      await sleep(50);
    }
    return !this.ticking && this.activeCount() === 0;
  }

  /**
   * A code run cut short by service shutdown keeps its active DB row: the
   * next boot's reconcile resumes it (with the persisted Pi session). Only
   * an explicit user cancel outranks shutdown. Terminal runs are untouched.
   */
  private suspendForShutdown(run: RunRow) {
    if (this.suspended.has(run.run_id)) return;
    this.suspended.add(run.run_id);
    try {
      this.store.transition(run.run_id, run.phase, run.phase, { kind: 'service_shutdown', resumable: true });
    } catch { /* db closed */ }
    this.appLog.event('run_suspended_shutdown', { run: run.run_id, phase: run.phase });
  }

  /** True when `run` should suspend rather than take a terminal outcome. */
  private shouldSuspend(run: RunRow): boolean {
    if (!this.stopping || run.kind !== 'code') return false;
    const fresh = this.store.getRun(run.run_id);
    return !!fresh && RUN_ACTIVE_PHASES.includes(fresh.phase) && fresh.cancel_requested !== 1;
  }

  // ---------------- poll cycle ----------------

  async tick(): Promise<void> {
    if (this.stopping) return;
    this.sweepCancels();
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Recovery first: runs a crash left behind outrank new dispatch.
      await this.sweepDeferredResumes();
      // A requested drain pauses all new work; already-running runs and the
      // deferred-resume sweep still finish normally. A shutdown mid-tick
      // also stops every further step — async claims already made stay
      // active rows for the next boot's reconcile.
      if (!this.stopping && !(this.store.getMeta('drain_requested') ?? '')) {
        if (this.config.review_policy?.version === 2) await this.reconcileClosedIssues();
        await this.reconcileMergeStates();
        if (this.stopping) return;
        await this.triage.scan();
        if (this.stopping) return;
        await this.discover();
        if (this.stopping) return;
        await this.dispatch();
        if (this.stopping) return;
        await this.discoverPrs();
        if (this.stopping) return;
        await this.dispatchReviews();

      }
    } finally {
      this.ticking = false;
      this.maybeAckDrain();
    }
  }

  /**
   * A drain is acknowledged only once the tick has fully unwound: the
   * request may have landed while an async claim was in flight, so an empty
   * DB snapshot mid-tick is not proof the host is quiet. The nonce written
   * back is the CURRENT request — a replaced or cleared request is never acked.
   */
  private maybeAckDrain() {
    try {
      const nonce = this.store.getMeta('drain_requested');
      if (!nonce || this.activeCount() !== 0 || this.store.activeRuns().length !== 0) return;
      this.store.setMeta('drain_ack', nonce);
    } catch { /* db closed during shutdown */ }
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
      if (this.stopping) return; // no new merge/approval consumption mid-shutdown
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
        if (this.stopping) return;
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
    const reviewedBase = this.lastReviewedBaseSha(task.id, pr.headSha) ?? this.store.getReviewControl(task.id)?.base_sha ?? undefined;
    if (task.source === 'issue' && reviewedBase !== undefined && pr.baseSha && reviewedBase !== pr.baseSha) {
      await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
      const automaticReview = this.reviewsPr(project, task);
      if (automaticReview && !pr.isDraft) await this.tracker.markPrDraft(project.repo, prNumber)
        .catch(error => this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(error) }));
      let humanReviewHandoff = '项目使用人工评审，PR 保持 Ready for review，旧批准已失效，请人工复核当前差异。';
      if (!automaticReview && pr.isDraft) await this.tracker.markPrReady(project.repo, prNumber)
        .catch(error => {
          humanReviewHandoff = `项目使用人工评审，但 PR 无法转为 Ready（${String(error).slice(0, 180)}）；旧批准已失效，请人工处理。`;
          this.appLog.event('pr_ready_error', { task: task.id, pr: prNumber, error: String(error) });
        });
      const control = this.store.getReviewControl(task.id);
      if (control && !automaticReview) {
        const { assessment: _assessment, ...withoutAssessment } = control;
        this.store.saveReviewControl(task.id, { ...withoutAssessment, head_sha: pr.headSha, base_sha: pr.baseSha, decisions: [], resolutions: [], next_attempt_at: null });
      }
      const nextStatus = automaticReview ? 'AWAITING_REVIEW' : 'AWAITING_HUMAN';
      this.store.setTaskStatus(task.id, nextStatus, { approved_sha: null, approved_by: null });
      const lastReview = this.store.runsForTask(task.id).filter(item => item.kind === 'review').at(-1);
      if (lastReview) this.store.transition(lastReview.run_id, lastReview.phase, lastReview.phase, { kind: 'review_scope_moved', head_sha: pr.headSha, previous_base_sha: reviewedBase, base_sha: pr.baseSha, automatic_review: automaticReview });
      this.appLog.event('review_base_moved', { task: task.id, head_sha: pr.headSha, previous_base_sha: reviewedBase, base_sha: pr.baseSha, automatic_review: automaticReview });
      const handoff = automaticReview
        ? 'PR 已退回 Draft，正在重新运行适用检查并审查完整差异。'
        : humanReviewHandoff;
      await this.tracker.commentPr(project.repo, prNumber, `## 目标分支已变化\n\n目标分支 SHA 已从 ${reviewedBase.slice(0, 12)} 变为 ${pr.baseSha.slice(0, 12)}，旧评审和合并批准已失效。${handoff}`)
        .catch(error => this.appLog.event('pr_comment_error', { task: task.id, error: String(error) }));
      return;
    }
    // Self-heal: an AWAITING_HUMAN task whose current head was never reviewed
    // (e.g. a repair pushed a new head while the task was parked) must go back
    if (this.stopping) return; // shutdown mid-approval: consume nothing
    // to the review queue — otherwise the new head can never be approved.
    if (this.reviewsPr(project, task) && !this.store.hasReviewVerdictForScope(task.id, pr.headSha, pr.baseSha ?? null)) {
      // Any pending approval covers the old head only — drop it, re-review.
      await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
      if (!pr.isDraft) await this.tracker.markPrDraft(project.repo, prNumber)
        .catch(error => this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(error) }));
      this.store.setTaskStatus(task.id, 'AWAITING_REVIEW', { approved_sha: null, approved_by: null });
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
      if (this.reviewsPr(project, task) && !pr.isDraft) await this.tracker.markPrDraft(project.repo, prNumber)
        .catch(error => this.appLog.event('pr_draft_restore_error', { task: task.id, pr: prNumber, error: String(error) }));
      await this.tracker.commentPr(project.repo, prNumber,
        `## 人工批准已作废\n\nPR head 已从被审版本 \`${reviewedSha.slice(0, 12)}\` 变为 \`${pr.headSha.slice(0, 12)}\`——批准只对被审版本有效，已移除 \`agent-merge\` 标签。请等新一轮评审完成后重新打标签。`)
        .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
      this.appLog.event('human_merge_stale', { task: task.id, reviewed_sha: reviewedSha, head_sha: pr.headSha });
      return;
    }
    if (!await this.v2MergeGate(task, project, pr)) return;
    // Consume the label first: a crash between the CAS and the removal would
    // otherwise leave a one-shot approval armed for a future, unreviewed head.
    await this.prLabelQuietly(project.repo, prNumber, 'agent-merge', false);
    const moved = this.store.tx(() => {
      const now = this.store.getTaskById(task.id);
      if (!now || now.status !== 'AWAITING_HUMAN' || this.store.getReviewControl(task.id) && (now.updated_at !== task.updated_at || this.store.activeRunForTask(task.id))) return false;
      this.store.setTaskStatus(task.id, 'MERGING', { merge_attempts: 0, approved_sha: pr.headSha, approved_by: 'human' });
      return true;
    });
    if (!moved) return;
    await this.tracker.commentPr(project.repo, prNumber,
      `## 人工批准，排队自动合并\n\n合并将钉在 \`${pr.headSha.slice(0, 12)}\`；失败/冲突会走修复回路，需重新批准。`)
      .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
    this.appLog.event('human_merge_approved', { task: task.id, head_sha: pr.headSha });
  }

  private lastReviewedBaseSha(taskId: number, headSha: string): string | undefined {
    for (const run of this.store.runsForTask(taskId).filter(item => item.kind === 'review').reverse()) {
      for (const event of this.store.eventsForRun(run.run_id).reverse()) {
        try {
          const detail = JSON.parse(event.detail_json ?? 'null') as { kind?: unknown; head_sha?: unknown; base_sha?: unknown } | null;
          if (!['review_started', 'review_scope_moved'].includes(String(detail?.kind)) || detail?.head_sha !== headSha) continue;
          return typeof detail.base_sha === 'string' ? detail.base_sha : undefined;
        } catch { /* malformed historical event is not a base-SHA attestation */ }
      }
    }
    return undefined;
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
    if (task.approved_by !== 'human' && task.approved_by !== 'review') {
      this.setTaskStatus(task.id, 'AWAITING_HUMAN', { approved_sha: null, approved_by: null });
      this.appLog.event('merge_approval_required', { task: task.id, approved_by: task.approved_by, approved_sha: task.approved_sha });
      return;
    }
    // A manual-review project still permits an explicit human approval.
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
    if (this.stopping) return; // shutdown mid-merge: no new merge actions
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
      this.store.setTaskStatus(task.id, 'AWAITING_REVIEW', this.store.getReviewControl(task.id) ? { approved_sha: null, approved_by: null } : {});
      this.appLog.event('merge_head_moved', { task: task.id, approved_sha: approvedSha, head_sha: pr.headSha });
      return;
    }
    if (!await this.v2MergeGate(task, project, pr)) return;
    if (pr.mergeable === 'CONFLICTING') {
      if (await this.spawnMergeFix(task, project, prNumber, approvedSha, `PR conflicts with ${project.base_branch}`)) return;
      if (store.getTaskById(task.id)?.status !== 'MERGING') return;
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      await this.tracker.commentPr(project.repo, prNumber,
        `## 自动合并受阻\n\n分支与 ${project.base_branch} 存在合并冲突且修复预算已耗尽，转人工处理。`)
        .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
      return;
    }
    const verified = await this.verifyGeneratedConsistency(task, project, approvedSha, pr.headSha);
    if (!verified.ok) {
      this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
      await this.tracker.commentPr(project.repo, prNumber,
        `## 自动合并已阻止\n\n无法验证生成物（dist 等构建产物）与被审源码一致：\n\n\`\`\`\n${verified.detail ?? ''}\n\`\`\``)
        .catch((err) => this.appLog.event('pr_comment_error', { task: task.id, error: String(err) }));
      this.appLog.event('verify_build_failed', { task: task.id, detail: (verified.detail ?? '').slice(0, 300) });
      return;
    }
    try {
      if (this.store.getReviewControl(task.id) && !await this.v2MergeGate(task, project, await this.tracker.getPrDetails(project.repo, prNumber))) return;
      await this.tracker.markPrReady(project.repo, prNumber);
      if (this.stopping) return;
      if (this.store.getReviewControl(task.id) && (store.getTaskById(task.id)?.updated_at !== task.updated_at || store.getTaskById(task.id)?.status !== 'MERGING' || store.activeRunForTask(task.id))) return;
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
        if (acceptsAllIssues(project)) continue;
        issues = await this.tracker.listReadyIssues(project.repo, project.ready_label);
      } catch (err) {
        this.appLog.event('discover_error', { repo: project.repo, error: String(err) });
        this.recordError('discover_error', err);
        continue;
      }
      for (const issue of issues) {
        const authorized = await this.triage.authorize(project, issue);
        if (!authorized) continue;
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
        if (issue.labels.includes(MANAGED) && task.status === 'DISCOVERED' && !this.store.runsForTask(task.id).length) {
          this.store.setApprovedHash(task.id, approvalHash(authorized.issue));
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
      // 'manual' still scans: the agent-review label is the only way an
      // external PR gets reviewed there, so skipping the project entirely
      // would make the documented summon path dead.
      const autoOn = project.pr_review === 'auto';
      const sinceKey = `pr_review_since:${project.repo}`;
      const since = this.store.getMeta(sinceKey);
      if (autoOn && !since) {
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
      const sinceMs = since ? Date.parse(since) : Number.POSITIVE_INFINITY;
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
        if (!autoOn) return false;
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
        this.store.tx(() => {
          const registered = this.store.upsertPrTask({
            repo: project.repo, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName,
          });
          if (this.config.review_policy?.version === 2 && registered.created) this.store.saveReviewControl(registered.task.id, newReviewControl(`pr:${project.repo}:${pr.number}`));
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
      if (this.stopping) return;
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
    if (issue && !await this.triage.authorize(project, issue)) return;
    if (!issue || issue.state !== 'OPEN') {
      this.setTaskStatus(task.id, 'CANCELED', { pending_fix: null });
      this.appLog.event('dispatch_skip', { task: task.id, why: 'issue closed or missing' });
      return;
    }
    if (!acceptsAllIssues(project) && !issue.labels.includes(project.ready_label)) {
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
    if ((acceptsAllIssues(project) || issue.labels.includes(MANAGED)) && !this.store.runsForTask(task.id).length) {
      this.store.setApprovedHash(task.id, hash);
      task = { ...task, approved_hash: hash };
    }
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

    if (this.stopping) return; // claimed rows stay DISCOVERED for next boot
    const finalApproval = await this.triage.authorize(project, issue);
    if (!finalApproval || this.stopping) return;
    if (approvalHash(finalApproval.issue) !== hash) return;
    const run = this.store.tx(() => {
      if (this.config.review_policy?.version === 2 && !this.store.runsForTask(task.id).length && !this.store.getReviewControl(task.id)) this.store.saveReviewControl(task.id, newReviewControl(hash));
      return this.store.claimRun(task.id, { outcomeProtocol: acceptsAllIssues(project) && !task.pending_fix ? 1 : 0 });
    });
    if (finalApproval.hash) {
      try {
        const artifacts = this.artifactsDirFor(run);
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, 'approved-issue.json'), JSON.stringify(finalApproval), 'utf8');
      } catch (err) {
        this.store.endRun(run.run_id, 'FAILED', 'unable to persist authorized issue snapshot');
        throw err;
      }
    }
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

  /**
   * Single entry point for resuming a run left in an active phase by a
   * previous process. `phase` is the resume target chosen at reconciliation
   * (legacy REVIEWING -> VERIFYING, CLAIMED -> PREPARING); it is remembered
   * when the run has to wait for a concurrency slot so the sweep resumes to
   * the right phase.
   *
   * Returns true when the run is launched (or already in flight — re-entry
   * never consumes budget); false when it was queued for the tick sweep.
   * Queueing spends nothing: `Store.resumeRun` (pid clear, resume_count+1,
   * transition event) runs only when a process is actually launched.
   */
  resumeRun(runId: string, phase?: Phase): boolean {
    // Shutting down: leave the row active for the next boot's reconcile —
    // no spawn, no resume budget spent.
    if (this.stopping) return true;
    if (this.inFlight.has(runId)) return true;
    const run = this.store.getRun(runId);
    // Gone or already terminal — nothing left to resume.
    if (!run || !RUN_ACTIVE_PHASES.includes(run.phase)) return true;
    if (run.kind === 'review' && this.store.getReviewControl(run.task_id)) {
      throw new Error('v2 review must be reconciled and re-queued through its persistent budget');
    }
    const to = phase ?? run.phase;
    if (this.activeCount() >= this.config.server.max_concurrent) {
      this.deferredResumes.set(runId, to);
      return false;
    }
    this.store.resumeRun(runId, to);
    this.launch(runId);
    return true;
  }

  /**
   * Tick-time start of queued resumes. Every dequeue re-reads the run row —
   * a run that ended, was cancelled, or turned risky while queued is
   * resolved without spawning: terminal/gone drops silently, a user cancel
   * finishes through the normal finish paths (no process, no resume budget),
   * a proven-risky run parks on RECOVERY_REQUIRED with its claim label kept.
   */
  private async sweepDeferredResumes() {
    if (this.deferredResumes.size === 0) return;
    const max = this.config.server.max_concurrent;
    for (const [runId, to] of [...this.deferredResumes]) {
      if (this.inFlight.has(runId)) {
        this.deferredResumes.delete(runId);
        continue;
      }
      let run = this.store.getRun(runId);
      let task = run ? this.store.getTaskById(run.task_id) : null;
      if (!run || !task || !RUN_ACTIVE_PHASES.includes(run.phase)) {
        this.deferredResumes.delete(runId);
        continue;
      }
      // A queued resume that cannot launch this tick takes no slot at all:
      // keep scanning so cancel/terminal cleanup behind a waiting entry is
      // not starved by a full concurrency budget.
      if (run.cancel_requested !== 1 && this.activeCount() >= max) continue;

      // Re-verify the picture that made this resumable at boot — and also
      // for a cancel, which must prove the child dead before the finish
      // path releases the cross-instance claim label.
      const safetyKey = JSON.stringify([run.pid, run.process_identity, run.workspace]);
      const risk = await runProcessRisk(run, this.deps.recoveryProcessDeps ?? {});

      // The scan was async: a CLI cancel or an out-of-band endRun may have
      // landed meanwhile. Re-read and never act on the stale row; a run
      // whose safety inputs changed mid-scan is re-evaluated next tick.
      run = this.store.getRun(runId);
      task = run ? this.store.getTaskById(run.task_id) : null;
      if (!run || !task || !RUN_ACTIVE_PHASES.includes(run.phase) || this.inFlight.has(runId)) {
        this.deferredResumes.delete(runId);
        continue;
      }
      if (JSON.stringify([run.pid, run.process_identity, run.workspace]) !== safetyKey) continue;
      // Shutdown: a cancelled queued run still finishes through the cancel
      // path below (with its already-computed risk check); anything else
      // stays queued for the next boot — no new parking, no budget spent.
      if (this.stopping && run.cancel_requested !== 1) continue;

      if (risk) {
        this.deferredResumes.delete(runId);
        await this.parkRecovery(task, run, risk);
        continue;
      }
      if (run.cancel_requested === 1) {
        this.deferredResumes.delete(runId);
        if (run.kind === 'review') {
          this.finishReview(run, task, 'CANCELED', 'cancelled', this.cancelTaskPhase(runId));
        } else {
          this.finish(run, task, 'CANCELED', 'cancelled');
        }
        continue;
      }
      const parkWhy = this.resumeParkReason(run);
      if (parkWhy) {
        this.deferredResumes.delete(runId);
        // Risk just proved null: nothing alive can hold the claim label.
        await this.parkRecovery(task, run, parkWhy, true);
        continue;
      }

      if (this.stopping) continue; // leave queued for the next boot's reconcile
      if (this.activeCount() >= max) continue; // capacity can close over the awaits
      this.deferredResumes.delete(runId);
      this.store.resumeRun(runId, to);
      this.launch(runId);
    }
  }

  /** Budget/workspace/sha re-check for a queued resume (risk already null). */
  private resumeParkReason(run: RunRow): string | null {
    if (run.resume_count >= this.config.server.max_resumes) return 'resume budget exhausted';
    if (run.kind === 'review') {
      return run.head_sha && (run.phase === 'CLAIMED' || run.phase === 'REVIEWING')
        ? null
        : `review run missing head_sha or in unexpected phase ${run.phase}`;
    }
    // Phases that continue agent work need the workspace the run recorded;
    // legacy REVIEWING (a code phase) re-enters through VERIFYING and still
    // needs it. CLAIMED/PREPARING/PUBLISHING_PR recreate what they need.
    if (['RUNNING', 'FIXING', 'VERIFYING', 'REVIEWING'].includes(run.phase)
      && (!run.workspace || !existsSync(run.workspace))) {
      return 'workspace missing; cannot continue safely';
    }
    return null;
  }

  /**
   * Rebuild the fix intent of a resumed run from its last persisted
   * pending_fix_consumed event. The event is host-written evidence — a
   * malformed payload is never guessed at (caller parks the run).
   */
  private consumedFixFor(run: RunRow): PendingFix | null {
    for (const ev of [...this.store.eventsForRun(run.run_id)].reverse()) {
      if (ev.detail_json == null || !ev.detail_json.includes('pending_fix_consumed')) continue;
      const parsed = JSON.parse(ev.detail_json) as {
        kind?: unknown; head_sha?: unknown; title?: unknown; summary?: unknown; findings?: unknown;
      };
      if (parsed.kind !== 'pending_fix_consumed') continue;
      if (typeof parsed.head_sha !== 'string' || typeof parsed.summary !== 'string'
        || !Array.isArray(parsed.findings) || parsed.findings.some((f) => typeof f !== 'string')
        || (parsed.title !== undefined && typeof parsed.title !== 'string')) {
        throw new Error(`corrupt pending_fix_consumed event on run ${run.run_id}`);
      }
      return {
        head_sha: parsed.head_sha, title: parsed.title as string | undefined,
        summary: parsed.summary, findings: parsed.findings as string[],
      };
    }
    return null;
  }

  private previousReviewContext(task: TaskRow): string {
    const runs = this.store.runsForTask(task.id);
    for (const candidate of runs.reverse()) {
      if (candidate.kind !== 'code') continue;
      for (const event of this.store.eventsForRun(candidate.run_id).reverse()) {
        if (!event.detail_json?.includes('pending_fix_consumed')) continue;
        try {
          const detail = JSON.parse(event.detail_json) as Partial<PendingFix> & { kind?: string };
          if (detail.kind !== 'pending_fix_consumed' || typeof detail.summary !== 'string'
            || !Array.isArray(detail.findings) || detail.findings.some(f => typeof f !== 'string')) continue;
          return [`上轮修复主题：${detail.title ?? 'Review BLOCK'}`, `上轮摘要：${detail.summary}`,
            '上轮 findings：', ...detail.findings.map(f => `- ${f}`)].join('\n').slice(0, 12_000);
        } catch { /* malformed host evidence is not passed to the reviewer */ }
      }
    }
    return '';
  }

  private async parkRecovery(task: TaskRow, run: RunRow, why: string, safeToReleaseClaim = false) {
    await markRecoveryRequired(
      { store: this.store, tracker: this.tracker, appLog: this.appLog, engine: this },
      task, run, why, safeToReleaseClaim,
    );
  }

  private launch(runId: string) {
    // Shutdown in progress: a claimed/resumed row stays active in the DB —
    // never spawn a process we are about to abort.
    if (this.stopping) return;
    if (this.inFlight.has(runId)) return;
    this.inFlight.add(runId);
    const ctl = new AbortController();
    this.controllers.set(runId, ctl);
    void this.runTask(runId, ctl.signal)
      .catch((err) => {
        this.appLog.event('run_crashed', { run: runId, error: String(err) });
        this.recordError('run_crashed', err);
        // Returned, not voided: shutdown must observe parking/label cleanup
        // finishing — inFlight is only cleared after this settles.
        return this.handleRunCrash(runId, err);
      })
      .finally(() => {
        this.inFlight.delete(runId);
        this.controllers.delete(runId);
      });
  }

  /**
   * runTask rejected. Resolution order: an explicit user cancel always
   * wins (even mid-shutdown); then shutdown suspend semantics; then a
   * session-restore failure parks on RECOVERY_REQUIRED rather than FAILED —
   * nothing may spawn a fresh cold session over unreadable history.
   */
  private async handleRunCrash(runId: string, err: unknown) {
    try {
      const run = this.store.getRun(runId);
      if (!run || !RUN_ACTIVE_PHASES.includes(run.phase)) return;
      const task = this.store.getTaskById(run.task_id);
      if (run.cancel_requested === 1) {
        if (run.kind === 'review') {
          this.store.endRun(runId, 'CANCELED', 'cancelled');
          if (task && task.status === 'REVIEWING') this.setTaskStatus(task.id, this.cancelTaskPhase(runId));
        } else if (task) {
          // Same finish path a normal cancel takes — claim/labels are
          // released, not just the run row ended.
          this.finish(run, task, 'CANCELED', 'cancelled');
        }
        return;
      }
      if (this.stopping) {
        if (run.kind === 'review') {
          // A shutdown-cancelled round is not a verdict: the same sha
          // gets re-reviewed next boot.
          this.store.endRun(runId, 'CANCELED', 'service shutdown');
          if (task && task.status === 'REVIEWING') this.setTaskStatus(task.id, this.cancelTaskPhase(runId));
        } else {
          this.suspendForShutdown(run);
        }
        return;
      }
      if (err instanceof SessionRestoreError && task) {
        // Own session is already closed by runTask's finally (or never
        // spawned); the original file is left untouched, the claim kept —
        // nothing proves the label is safe to release.
        await this.parkRecovery(task, run, `Pi session restore failed: ${String(err).slice(0, 300)}`);
        return;
      }
      if (run.kind === 'review') {
        if (task && this.store.getReviewControl(task.id) && this.reviewExecutionFailure(run, task, `review infra: engine crash: ${String(err).slice(0, 400)}`)) return;
        // A crashed review leaves no verdict row; without one the same
        // sha would be re-dispatched forever. ERROR counts as a verdict.
        if (run.head_sha && !this.store.hasReviewVerdictForSha(run.task_id, run.head_sha)) {
          this.store.addCheck({
            run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
            verdict: 'ERROR', head_sha: run.head_sha,
          });
        }
        this.store.endRun(runId, 'FAILED', `engine crash: ${String(err).slice(0, 500)}`);
        if (task && task.status === 'REVIEWING') this.setTaskStatus(task.id, 'AWAITING_HUMAN');
      } else {
        this.store.endRun(runId, 'FAILED', `engine crash: ${String(err).slice(0, 500)}`);
        if (task && task.status === 'RUNNING') this.setTaskStatus(task.id, 'FAILED');
      }
    } catch (e2) {
      this.appLog.event('run_crashed_cleanup_failed', { run: runId, error: String(e2) });
    }
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
    const coderRef: {
      current: { session: CoderSession; logPath: string; pid: number | null; identity: string | null } | null;
    } = { current: null };

    try {
      let phase: Phase = run.phase;
      // Lazily populated context shared by phases.
      const ctx = await this.makePromptContext(run, task, project);
      let worktreePath = run.workspace ?? '';
      let lastFailureEvidence = '';
      let verifiedHead: string | null = null;
      // A conflict repair keeps its intent across recovery; the new head must
      // pass checks and review before the human can approve it again.
      let mergeRepair = false;
      // This process resumed the run from a previous boot: the FIRST real
      // coder turn (RUNNING or FIXING) is prefixed with the resume note —
      // later turns in this same process are not.
      const resumed = run.resume_count > 0;
      let resumeNotePending = resumed;
      const withResumeNote = (p: string) => {
        if (!resumeNotePending) return p;
        resumeNotePending = false;
        return CODER_RESUME_NOTE + '\n\n' + p;
      };
      // Restore fix metadata for ANY resumed phase — a merge-conflict repair
      // that restarts at VERIFYING/FIXING/PUBLISHING_PR must still land back
      // in MERGING on publish, not bounce to review. Host-written event
      // evidence only; corrupt payloads park instead of guessing.
      let fixIntent: PendingFix | null = null;
      if (resumed) {
        try {
          fixIntent = task.pending_fix
            ? (JSON.parse(task.pending_fix) as PendingFix)
            : this.consumedFixFor(run);
        } catch (e) {
          this.finish(run, task, 'RECOVERY_REQUIRED', `cannot restore pending fix intent: ${String(e).slice(0, 200)}`);
          return;
        }
        if (fixIntent) {
          mergeRepair = fixIntent.title ? fixIntent.title === '自动合并受阻' : task.status === 'MERGING';
        }
      }

      const ensureCoder = () => {
        if (coderRef.current) return coderRef.current;
        if (this.stopping) throw new Error('service shutdown');
        const artifactsDir = this.artifactsDirFor(run);
        mkdirSync(artifactsDir, { recursive: true });
        const stamp = Date.now();
        const logPath = join(artifactsDir, `agent-${stamp}.jsonl`);
        const spawned: { pid: number | null; identity: string | null } = { pid: null, identity: null };
        const firstCodeRun = store.runsForTask(task.id).find(candidate => candidate.kind === 'code') ?? run;
        const complex = ctx.issue.labels.includes(COMPLEX_LABEL);
        const model = complex ? this.config.agent.complex_model ?? this.config.agent.model : this.config.agent.model;
        const thinking = complex
          ? this.config.agent.complex_reasoning_effort ?? this.config.agent.reasoning_effort
          : this.config.agent.reasoning_effort;
        if (complex) this.appLog.event('coder_complex_model', { run: run.run_id, model, thinking: thinking ?? null });
        const session = this.openCoderSessionFn({
          workdir: worktreePath,
          agentConfig: this.config.agent,
          model,
          thinking,
          tools: PI_ALL_TOOLS,
          logPath,
          lastMessagePath: join(artifactsDir, `coder-last-${stamp}.txt`),
          onSpawn: (pid, identity) => {
            spawned.pid = pid;
            spawned.identity = identity;
            this.store.updateRunFields(run.run_id, { pid, process_identity: identity });
          },
          // The first code run owns the task's conversation history; later
          // repair runs close their own process but reopen this same session.
          sessionId: firstCodeRun.run_id,
          sessionDir: join(this.artifactsDirFor(firstCodeRun), 'pi-session'),
        });
        coderRef.current = { session, logPath, pid: spawned.pid, identity: spawned.identity };
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
            let prompt = resumed ? buildCoderPrompt(ctx, true) : buildCoderPrompt(ctx);
            // A live pending_fix is consumed now; a resumed run also reuses
            // the intent restored before the loop (event evidence).
            const intent = pendingFix ?? fixIntent;
            if (intent) {
              store.updateRunFields(runId, { head_sha: intent.head_sha });
              if (pendingFix) {
                store.transition(runId, phase, phase, {
                  kind: 'pending_fix_consumed', head_sha: pendingFix.head_sha, title: pendingFix.title,
                  summary: pendingFix.summary, findings: pendingFix.findings,
                });
                if (!resumed) {
                  // A merge-conflict repair keeps the task in MERGING until
                  // the new head is published back to review.
                  mergeRepair = pendingFix.title === '自动合并受阻';
                }
                store.setTaskStatus(task.id, mergeRepair ? 'MERGING' : 'RUNNING', { pending_fix: null });
                task = { ...task, pending_fix: null };
              }
              if (pendingFix && !resumed) {
                // Fix runs may need `git merge <remote>/<base>` — the child's
                // scrubbed env cannot fetch, so the host refreshes the ref.
                await this.workspace.fetchBranch(project.local_repo, project.base_branch, project.git_remote)
                  .catch((err) => this.appLog.event('fetch_error', { run: runId, error: String(err) }));
                // The work must start from the PR branch's remote head: a reused
                // worktree may sit at a stale commit, and merging base onto it
                // pushes a non-fast-forward that GitHub rejects. Resumed runs
                // skip this reset entirely — it would wipe half-finished fixes.
                const fixBranch = run.branch ?? task.branch ?? `${project.branch_prefix}${task.issue_number}`;
                await this.workspace.fetchBranch(project.local_repo, fixBranch, project.git_remote)
                  .then(() => this.workspace.resetHard(worktreePath, `${project.git_remote}/${fixBranch}`))
                  .catch((err) => this.appLog.event('fix_head_sync_error', { run: runId, error: String(err).slice(0, 300) }));
              }
              prompt = buildFixPrompt(ctx, `${intent.title ?? 'Review BLOCK'}：${intent.summary}\n${intent.findings.join('\n')}`);
            }
            const structuredOutcome = run.outcome_protocol === 1 && !intent;
            if (structuredOutcome) prompt += '\n# 最终结果协议\n在同一会话中先判断再实施，缺少必要信息时停止，不做猜测性修改。最终回复必须仅为一个 JSON 对象：{"outcome":"IMPLEMENTED|NEEDS_HUMAN|DEFER|NO_ACTION","reason":"具体原因"}。IMPLEMENTED 表示已经实现，进入宿主检查；其他结果要求工作树与本回合开始时一致且干净，不创建提交。不得为输出 IMPLEMENTED 而制造改动。';
            const headAtTurnStart = structuredOutcome ? await this.workspace.head(worktreePath) : null;
            const turn = ensureCoder();
            const res = await this.coderTurn(run, log, turn, withResumeNote(prompt), 'RUNNING', signal);
            if (res.aborted) { this.finish(run, task, 'CANCELED', 'cancelled'); return; }
            if (!res.ok) {
              this.finish(run, task, 'FAILED', res.timedOut
                ? `agent timeout: exceeded ${this.config.server.max_task_minutes}m`
                : `agent failed: ${res.error ?? `exit ${res.exitCode}`}`);
              return;
            }
            if (structuredOutcome) {
              let outcome;
              try { outcome = parseOutcome(res.lastMessage); }
              catch (err) {
                this.store.tx(() => {
                  this.triage.recordOutcome(task.repo, task.issue_number, 'human', `Agent 结果格式错误：${String(err)}`);
                  this.finish(run, task, 'BLOCKED', 'Agent 结果格式错误，保留现场供人工处理');
                });
                return;
              }
              if (outcome.outcome !== 'IMPLEMENTED') {
                const unchanged = await this.workspace.head(worktreePath) === headAtTurnStart && !await this.workspace.isDirty(worktreePath);
                const kind = !unchanged || outcome.outcome === 'NEEDS_HUMAN' ? 'human' : outcome.outcome === 'DEFER' ? 'deferred' : 'skipped';
                const reason = unchanged ? outcome.reason : `已有代码改动需人工处理：${outcome.reason}`;
                this.store.tx(() => {
                  this.triage.recordOutcome(task.repo, task.issue_number, kind, reason);
                  store.transition(runId, phase, phase, { kind: 'agent_outcome', ...outcome, unchanged });
                  this.finish(run, task, 'BLOCKED', reason);
                });
                return;
              }
              store.transition(runId, phase, phase, { kind: 'agent_outcome', ...outcome });
            }
            await this.commitLeftovers(run, log, worktreePath, task);
            store.transition(runId, phase, (phase = 'VERIFYING'));
            break;
          }

          case 'VERIFYING': {
            const gate = await this.gateApproval(project, task);
            if (gate !== 'ok') { this.finish(run, task, gate, 'approval changed before checks'); return; }
            const headBeforeChecks = await this.workspace.head(worktreePath);
            const checkPlan = resolveCheckPlan(project.checks, worktreePath);
            store.transition(runId, phase, phase, {
              kind: 'checks_started', head_sha: headBeforeChecks,
              source: checkPlan.source,
              commands: checksForPlatform(checkPlan.checks).map((check) => check.argv.join(' ')),
              skipped: skippedChecks(checkPlan.checks),
            });
            const summary = await this.callChecks(run, log, worktreePath, signal, headBeforeChecks, checkPlan);
            // runChecks borrowed runs.pid for its transient check child. Point
            // it back at the long-lived session process before FIXING or
            // PUBLISHING_PR, or a crash there sees a dead pid and resume spawns
            // a duplicate agent while the orphaned pi child still owns the
            // worktree (its argv carries no worktree path for the orphan scan).
            if (coderRef.current && coderRef.current.pid != null) {
              store.updateRunFields(runId, { pid: coderRef.current.pid, process_identity: coderRef.current.identity });
            }
            const headAfterChecks = await this.workspace.head(worktreePath).catch(() => null);
            const checksWorktreeClean = !(await this.workspace.isDirty(worktreePath));
            this.recordChecks(run, summary, headAfterChecks === headBeforeChecks && checksWorktreeClean ? headBeforeChecks : null);
            store.transition(runId, phase, phase, {
              kind: 'checks_completed', head_sha: headBeforeChecks, head_sha_after: headAfterChecks,
              worktree_clean: checksWorktreeClean, ok: summary.ok, aborted: summary.aborted,
              infra_error: summary.infraError,
              outcomes: summary.outcomes.map((outcome) => ({ command: outcome.command, exit_code: outcome.exitCode, timed_out: outcome.timedOut })),
              skipped: summary.skipped.map((s) => ({ command: s.command, reason: s.reason })),
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
            this.store.tx(() => {
              const control = this.store.getReviewControl(task.id);
              if (control) this.store.saveReviewControl(task.id, reserveFix(control, this.config.server.retry_limit));
              this.store.bumpRunFixCount(runId);
            });
            const evidence = lastFailureEvidence;
            const turn = ensureCoder();
            const res = await this.coderTurn(run, log, turn, withResumeNote(buildFixPrompt(ctx, evidence)), 'FIXING', signal);
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
              // A conflict repair creates a new head and cannot carry its old approval.
              if (mergeRepair) store.setTaskStatus(task.id, store.getTaskById(task.id)!.status, { approved_sha: null, approved_by: null });
              const policy = store.getReviewControl(task.id);
              if (policy) {
                const remote = await this.tracker.getPrDetails(project.repo, pr.number);
                const updated = { ...policy, head_sha: verifiedHead, base_sha: remote.baseSha ?? null, next_attempt_at: null, decisions: [] };
                delete updated.assessment;
                store.saveReviewControl(task.id, updated);
                store.setTaskStatus(task.id, store.getTaskById(task.id)!.status, { approved_sha: null, approved_by: null });
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
      if (this.stopping) return;
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
        const control = this.store.getReviewControl(task.id);
        if (control?.next_attempt_at && Date.parse(control.next_attempt_at) > Date.now()) continue;
        if (control && (control.rounds >= 6 || control.infra_attempts >= 3)) { this.setTaskStatus(task.id, 'BLOCKED'); continue; }
        if (!control && this.store.hasReviewVerdictForScope(task.id, pr.headSha, pr.baseSha ?? null)) {
          // AWAITING_REVIEW + a verdict for exactly this head is a stranded
          // state: the sha idempotency below will never dispatch it again, so
          // the UI would show "reviewing" for a task that cannot move. BLOCKED
          // is the honest label and it is retryable — retry clears the verdict.
          this.setTaskStatus(task.id, 'BLOCKED');
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-blocked');
          this.appLog.event('review_stranded', { task: task.id, head_sha: pr.headSha, pr: prNum });
          continue;
        }

        if (this.stopping) return; // no new review claim mid-shutdown
        // Claim + pin fields + task status in one transaction so a crash
        // cannot leave a zombie task with no active run or vice versa.
        const worktree = this.store.lastCodeWorkspace(task.id) ?? this.worktreePathFor(project, task);
        const run = this.store.tx(() => {
          const currentControl = this.store.getReviewControl(task.id);
          if (currentControl) this.store.saveReviewControl(task.id, reserveReview(currentControl, pr.headSha, pr.baseSha));
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
    let reviewedBaseSha: string | null = null;
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
        if (!pr && this.reviewExecutionFailure(run, task, 'review infra: PR preflight unavailable')) return;
        const preflightControl = this.store.getReviewControl(task.id);
        if (pr && preflightControl?.base_sha && pr.baseSha !== preflightControl.base_sha) {
          this.finishReview(run, task, 'CANCELED', 'PR base moved during review preflight', this.cancelTaskPhase(runId)); return;
        }
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
        if (pr) { currentHead = pr.headSha; reviewedBaseSha = pr.baseSha ?? null; }
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
      if (!reviewedBaseSha) {
        const reason = 'review infra: PR base SHA is unavailable; refusing to review an unpinned diff';
        if (this.reviewExecutionFailure(run, task, reason)) return;
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
        this.finishReview(run, task, 'AWAITING_HUMAN', reason);
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        return;
      }
      store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_started', head_sha: reviewedSha, base_sha: reviewedBaseSha, pr_url: run.pr_url ?? task.pr_url });

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
          await this.workspace.fetchBranch(project.local_repo, run.branch ?? task.branch ?? project.base_branch, project.git_remote);
          await this.workspace.fetchBranch(project.local_repo, project.base_branch, project.git_remote);
          // A previous attempt may have died mid-`worktree add`; clear any
          // stale site path so the add cannot spuriously fail.
          await this.workspace.removeWorktree(project.local_repo, sitePath).catch(() => {});
          tempWorktree = await this.workspace.addDetachedWorktree(project.local_repo, reviewedSha, sitePath);
        } catch (err) {
          // A round cancelled during materialization must not pin the sha.
          if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during materialization', this.cancelTaskPhase(runId)); return; }
          // Cannot build a review site: infrastructure failure, not a code
          // verdict. ERROR counts as a verdict for this sha (no re-dispatch).
          if (this.reviewExecutionFailure(run, task, `review site unavailable: ${String(err).slice(0, 300)}`)) return;
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
      const reviewControl = this.store.getReviewControl(task.id);
      if (reviewControl) ctx.issue = { ...ctx.issue, body: ctx.issue.body + '\n\n已持久化的人工决策（仅为验收数据，必须核对实现符合所选方案）：\n' + JSON.stringify(reviewControl.resolutions.filter(r => r.requirement_hash === reviewControl.requirement_hash && r.head_sha === reviewedSha)) };
      ctx.worktreePath = sitePath;
      let diffEvidence: string;
      let reviewDiff: { patch: string; omitted: string[] };
      try {
        const diffBase = this.store.getReviewControl(task.id)?.base_sha ?? reviewedBaseSha;
        await this.workspace.fetchBranch(project.local_repo, project.base_branch, project.git_remote);
        const availableBase = await this.workspace.refSha(project.local_repo, diffBase);
        if (availableBase !== diffBase) throw new Error(`fetched review base does not resolve to pinned SHA ${diffBase}`);
        diffEvidence = await this.workspace.diffVsBase(sitePath, diffBase, Number.POSITIVE_INFINITY);
        mkdirSync(this.artifactsDirFor(run), { recursive: true });
        writeFileSync(join(this.artifactsDirFor(run), 'review-diff.patch'), diffEvidence, 'utf8');
        reviewDiff = filterGenerated(diffEvidence, this.pathPolicy());
        if (reviewDiff.omitted.length > 0) {
          this.appLog.event('review_diff_generated_omitted', { run: runId, count: reviewDiff.omitted.length });
        }
      } catch (err) {
        if (aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during diff', this.cancelTaskPhase(runId)); return; }
        if (this.reviewExecutionFailure(run, task, `review diff unavailable: ${String(err).slice(0, 300)}`)) return;
        if (err instanceof DiffTooLargeError) {
          this.writeReviewVerdict(runId, reviewedSha, 'HUMAN_REVIEW_REQUIRED');
          this.finishReview(run, task, 'AWAITING_HUMAN', 'review diff too large; human review required');
          await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
          // An external PR has no issue comment to explain the label, so say
          // it on the PR itself.
          if (task.source === 'pr' && prNum) {
            await this.tracker.commentPr(project.repo, prNum,
              '## 自动评审：已跳过\n\n改动超过自动评审的大小上限（4 MB），无法自动判断，已转人工评审。')
              .catch((commentErr) => this.appLog.event('pr_comment_error', { run: runId, error: String(commentErr) }));
          }
          return;
        }
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
        this.finishReview(run, task, 'AWAITING_HUMAN', `review diff unavailable: ${String(err).slice(0, 300)}`);
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        if (task.source === 'pr' && prNum) {
          await this.tracker.commentPr(project.repo, prNum,
            `## 自动评审：失败\n\n无法生成评审所需 diff（${String(err).slice(0, 200)}），已转人工评审。`)
            .catch((commentErr) => this.appLog.event('pr_comment_error', { run: runId, error: String(commentErr) }));
        }
        return;
      }

      // Incremental re-review: a completed prior assessment at an older head
      // scopes the reviewer to the fix delta plus that round's open items.
      // The full diff stays in review-diff.patch; any delta failure falls back.
      let reviewScope: ReviewScope | undefined;
      const priorControl = this.store.getReviewControl(task.id);
      if (priorControl?.assessment && priorControl.head_sha && priorControl.head_sha !== reviewedSha) {
        try {
          const delta = filterGenerated(await this.workspace.diffVsBase(sitePath, priorControl.head_sha, Number.POSITIVE_INFINITY), this.pathPolicy());
          if (delta.patch.trim() && delta.patch.length <= MAX_REVIEW_DIFF_CHARS / 2) {
            reviewDiff = delta;
            reviewScope = { fromSha: priorControl.head_sha, toSha: reviewedSha, priorItems: priorReviewItems(priorControl.assessment) };
            this.appLog.event('review_incremental_scope', { run: runId, from: priorControl.head_sha.slice(0, 8), to: reviewedSha.slice(0, 8), chars: delta.patch.length });
          }
        } catch (err) {
          this.appLog.event('review_incremental_fallback', { run: runId, error: String(err).slice(0, 200) });
        }
      }

      let outcome: Awaited<ReturnType<typeof runReview>> | undefined;
      let reviewError: unknown;
      let hostCheckFailed = false;
      try {
        const plan: CheckPlan = task.source === 'issue' ? resolveCheckPlan(project.checks, sitePath) : { checks: [], source: 'none' };
        const evidence = this.guardedCheckEvidence(task.id, reviewedSha);
        const missing = checksForPlatform(plan.checks).some(check => !evidence.some(row => row.command === check.argv.join(' ') && row.verdict === 'PASS'));
        if (plan.error || plan.checks.length && (!evidence.length || missing)) {
          const summary = await this.callChecks(run, new RunLog(this.config.server.logs_dir, runId), sitePath, signal, reviewedSha, plan);
          const checkedHead = await this.workspace.head(sitePath).catch(() => null);
          const checksClean = await this.workspace.isDirty(sitePath).then(dirty => !dirty).catch(() => false);
          this.recordChecks(run, summary, checkedHead === reviewedSha && checksClean ? reviewedSha : null);
          store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'checks_completed', head_sha: reviewedSha, head_sha_after: checkedHead, worktree_clean: checksClean, ok: summary.ok });
          if (summary.aborted || aborted()) { this.finishReview(run, task, 'CANCELED', 'cancelled during review checks', this.cancelTaskPhase(runId)); return; }
          if (checkedHead !== reviewedSha || !checksClean) throw new Error('review checks changed HEAD or tracked files; verification does not match the approved head');
          if (summary.infraError) throw new Error(`checks infra: ${summary.infraError}`);
          if (!summary.ok) { hostCheckFailed = true; outcome = {
            result: { verdict: 'BLOCK', risk: 'low', summary: '宿主自动检查未通过，需要修复', findings: [summary.failureEvidence] },
            logPath: summary.outcomes.at(-1)!.logPath,
          }; }
        }
        if (!outcome) outcome = await this.runReviewFn(ctx, this.testEvidenceFor(task, reviewedSha), reviewDiff.patch, {
          agentConfig: this.config.agent,
          timeoutMs: Math.min(this.config.server.max_task_minutes, this.store.getReviewControl(task.id) ? this.config.review_policy?.timeout_minutes ?? 10 : this.config.server.max_task_minutes) * 60_000,
          policyVersion: this.store.getReviewControl(task.id) ? 2 : 1,
          previousReviewContext: this.previousReviewContext(task),
          reviewScope,
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
        if (this.store.getReviewControl(task.id)) {
          this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
          this.finishReview(run, task, 'RECOVERY_REQUIRED', 'review site integrity failure; HEAD or tracked files changed');
          return;
        }
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR');
        this.finishReview(run, task, 'AWAITING_HUMAN', headAfter !== reviewedSha
          ? 'review site HEAD moved during review; refusing verdict'
          : 'review site modified during review; refusing verdict');
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        return;
      }

      if (!outcome) {
        if (this.reviewExecutionFailure(run, task, `review infra: ${String(reviewError).slice(0, 400)}`, reviewError instanceof ReviewInfraError ? reviewError.logPath : undefined)) return;
        this.writeReviewVerdict(runId, reviewedSha, 'ERROR',
          reviewError instanceof ReviewInfraError ? reviewError.logPath : undefined);
        store.transition(runId, 'REVIEWING', 'REVIEWING', { kind: 'review_completed', head_sha: reviewedSha, verdict: 'ERROR', error: String(reviewError) });
        this.finishReview(run, task, 'AWAITING_HUMAN', `review infra: ${String(reviewError).slice(0, 400)}`);
        await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
        void this.notifyReviewInfra(task, run, '自动评审不可用，转人工评审');
        return;
      }

      // --- verdict ------------------------------------------------------------
      const { logPath } = outcome;
      let result = outcome.result;
      if (this.store.getReviewControl(task.id) && task.source === 'pr') {
        try { result = assessmentResult(validateReviewAssessment(result.assessment)); }
        catch (error) { this.reviewExecutionFailure(run, task, `review infra: invalid advisory assessment: ${String(error)}`, logPath); return; }
      }
      if (this.store.getReviewControl(task.id) && task.source === 'issue' && !hostCheckFailed) {
        await this.applyReviewV2(run, task, project, result, logPath, diffEvidence);
        return;
      }
      store.addCheck({ run_id: runId, kind: 'review', command: 'agent (review)', exit_code: null,
        artifact_path: logPath, verdict: result.verdict, head_sha: reviewedSha, detail_json: result.assessment ? JSON.stringify(result.assessment) : undefined });
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
        await this.handoffPassedReview(run, task, project, reviewedSha, reviewedBaseSha, sitePath, result.summary, reviewDiff.patch);
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
          const control = store.getReviewControl(task.id);
          if (control) store.saveReviewControl(task.id, reserveFix(control, this.config.server.retry_limit));
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
    const reviewControl = store.getReviewControl(task.id);
    if ((reviewControl?.fix_attempts ?? store.getTaskById(task.id)!.fix_rounds) >= this.config.server.retry_limit) {
      await this.labelQuietly(project.repo, task.issue_number, 'add', 'agent-high-risk');
      return false;
    }
    const baseRef = `${project.git_remote}/${project.base_branch}`;
    const payload: PendingFix = {
      head_sha: headSha,
      title: '自动合并受阻',
      summary: `auto-merge failed: PR conflicts with ${project.base_branch}`,
      findings: [
        `GitHub 拒绝合并（${mergeError.slice(0, 200)}）：分支与 ${project.base_branch} 存在合并冲突。`,
        `执行 git merge ${baseRef}（base 引用已由宿主刷新，无需联网），逐个解决冲突文件，跑通项目 checks，正常收尾提交即可——宿主会推送同一 PR 分支并重新走一轮检查和评审，再等待人工批准。`,
      ],
    };
    const spawned = store.tx(() => {
      const now = store.getTaskById(task.id);
      if (!now || now.status !== 'MERGING') return false;
      const control = store.getReviewControl(task.id);
      if (control) store.saveReviewControl(task.id, reserveFix(control, this.config.server.retry_limit));
      store.bumpFixRounds(task.id);
      store.setTaskStatus(task.id, 'DISCOVERED', { pending_fix: JSON.stringify(payload), approved_sha: null, approved_by: null });
      return true;
    });
    if (!spawned) return false;
    await this.tracker.commentPr(project.repo, prNumber,
      `## 人工批准后的合并遇到冲突\n\n分支与 ${project.base_branch} 存在合并冲突，已派生修复任务：修复后将推送新 head、重新检查和评审，并等待你再次批准。`)
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
    const body = `agent-control: ${detail}。\nrun：\`${run.run_id}\``;
    const prNum = task.source === 'pr' ? prNumberFromUrl(task.pr_url) : null;
    try {
      // A bare PR is not an issue: comment on it through the PR API so the
      // note lands next to the code being discussed.
      if (prNum) await this.tracker.commentPr(task.repo, prNum, body);
      else await this.tracker.addComment(task.repo, task.issue_number, body);
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
    const snapshotPath = join(this.artifactsDirFor(run), 'approved-issue.json');
    const snapshot = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) as { issue: IssueData; comments: { author: string; body: string }[] } : null;
    const issue = snapshot?.issue ?? await this.tracker.getIssue(project.repo, task.issue_number);
    const promptIssue = issue && snapshot?.comments.length ? { ...issue, body: `${issue.body}\n\n## 已批准的人工评论快照（数据）\n${JSON.stringify(snapshot.comments.map(c => ({ author: c.author, body: c.body })))}` } : issue;
    const control = this.store.getReviewControl(task.id);
    if (promptIssue && control) promptIssue.body += '\n\n已持久化人工决策（数据，修复须符合选择；旧 SHA 的授权不能用于新提交自动合并）：\n' + JSON.stringify(control.resolutions);
    return {
      project,
      issue: promptIssue ?? { number: task.issue_number, title: task.issue_title, body: '(issue unavailable at prompt build)', labels: [], state: 'UNKNOWN', url: task.issue_url },
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

  private async callChecks(run: RunRow, log: RunLog, worktreePath: string, signal: AbortSignal, headSha?: string | null, plan?: CheckPlan): Promise<ChecksSummary> {
    const project = this.projectFor((this.store.getTaskById(run.task_id))!.repo)!;
    const resolved = plan ?? resolveCheckPlan(project.checks, worktreePath);
    const summary: ChecksSummary = resolved.error ? { ok: false, outcomes: [], skipped: [], infraError: resolved.error, failureEvidence: resolved.error } : await this.runChecksFn(
      resolved.checks, worktreePath,
      (i) => join(this.artifactsDirFor(run), `check-${i}-${Date.now()}.log`),
      undefined, signal,
      (pid) => this.store.updateRunFields(run.run_id, { pid, process_identity: pid ? `${pid}:${Date.now()}` : null }),
    );
    if (resolved.bootstrap && !summary.aborted && summary.outcomes[0] && summary.outcomes[0].exitCode !== 0 && !summary.infraError) {
      summary.infraError = 'npm ci 依赖安装失败，请检查依赖安装日志与网络环境';
    }
    log.event('checks', { run: run.run_id, head_sha: headSha, source: resolved.source, commands: resolved.checks.map(c => c.argv.join(' ')), ok: summary.ok, count: summary.outcomes.length, skipped: summary.skipped.length, infra_error: summary.infraError });
    return summary;
  }

  private recordChecks(run: RunRow, summary: ChecksSummary, headSha: string | null) {
    summary.outcomes.forEach((o) => {
      this.store.addCheck({
        run_id: run.run_id, kind: 'check', command: o.command,
        exit_code: o.exitCode, artifact_path: o.logPath,
        verdict: summary.aborted ? 'CANCELED' : !headSha || summary.infraError ? 'ERROR' : o.exitCode === 0 ? 'PASS' : 'FAIL',
        head_sha: headSha,
      });
    });
    // Skipped checks are recorded so the dashboard and the reviewer see that
    // this host cannot attest them — silence would read as "verified".
    summary.skipped.forEach((s) => {
      this.store.addCheck({
        run_id: run.run_id, kind: 'check',
        command: `${s.command} (skipped: ${s.reason})`,
        exit_code: null, artifact_path: undefined, verdict: 'SKIP', head_sha: headSha,
      });
    });
  }

  private guardedCheckEvidence(taskId: number, headSha: string) {
    const guards = new Map<string, { at: string; valid: boolean }>();
    return this.store.checkEvidenceForSha(taskId, headSha).filter(row => {
      if (!guards.has(row.run_id)) {
        let guard = { at: '', valid: false };
        for (const event of this.store.eventsForRun(row.run_id)) {
          try {
            const detail = JSON.parse(event.detail_json ?? 'null');
            if (detail?.kind === 'checks_completed' && detail.head_sha === headSha
              && ['VERIFYING', 'REVIEWING'].includes(event.to_phase)) {
              guard = { at: event.at, valid: detail.ok === true && detail.head_sha_after === headSha && detail.worktree_clean === true };
            }
          } catch { /* Unstructured historical events cannot attest a check. */ }
        }
        guards.set(row.run_id, guard);
      }
      const guard = guards.get(row.run_id)!;
      return guard.valid && row.created_at <= guard.at;
    });
  }

  private testEvidenceFor(task: TaskRow, headSha: string): string {
    const render = (rows: ReturnType<Store['checkEvidenceForSha']>) =>
      rows
        .map((c) => `命令: ${c.command}\n结果: ${c.verdict} (exit ${c.exit_code ?? 'n/a'})\n日志: ${c.artifact_path ?? '-'}\n日志尾部:\n${this.checkLogTail(c.artifact_path)}`)
        .join('\n\n');
    const prefix = `提交 SHA: ${headSha}\n`;
    const scoped = this.guardedCheckEvidence(task.id, headSha);
    if (scoped.length > 0) return prefix + render(scoped);
    // Legacy rows predate head_sha binding: the evidence is still real
    // (usually produced by the run that authored this very head), but the
    // reviewer must be told it is not sha-scoped rather than given nothing.
    const fallback = this.store.latestCheckEvidence(task.id).filter(row => row.head_sha === null);
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
    const control = this.store.getReviewControl(run.task_id);
    return control ? control.fix_attempts < this.config.server.retry_limit : (fresh?.fix_count ?? 0) < this.config.server.retry_limit;
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
    if (!issue || issue.state !== 'OPEN' || !acceptsAllIssues(project) && !issue.labels.includes(project.ready_label)) return 'CANCELED';
    if (acceptsAllIssues(project)) {
      const state = this.triage.state(task.repo, task.issue_number);
      if (state && (state.kind || state.locked || state.pending || state.error) || issue.labels.includes('agent-human-hold') || issue.labels.includes('agent-needs-human')) return 'BLOCKED';
    }
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

  private pathPolicy(): PathPolicy {
    const cfg = this.config.approvals.auto_merge;
    return {
      generated: cfg.generated_paths ?? DEFAULT_POLICY.generated,
      docs: cfg.doc_paths ?? DEFAULT_POLICY.docs,
    };
  }

  /**
   * Generated files are excluded from review, so the host must prove they are
   * still reproducible from the reviewed source before an approved merge: rebuild the
   * approved head and refuse if `dist` (or any other generated path) drifts
   * from the commit. A hand-edited build output is the one thing the reviewer
   * can no longer see.
   *
   * The coding worktree is preferred (deps already installed). When it is
   * unusable — no code run for an existing-PR task, head moved, or the path
   * vanished — the approved sha is materialized as a detached worktree and
   * `verify_bootstrap` (e.g. `npm ci`) installs deps first. The detached site
   * proves the same invariant and is clean by construction, so only the
   * coding-worktree path needs the pre-build drift check.
   */
  private async verifyGeneratedConsistency(
    task: TaskRow, project: ProjectConfig, approvedSha: string, headSha: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const build = project.verify_build ?? this.config.approvals.auto_merge.verify_build;
    if (!build) return { ok: true };
    const key = `${task.id}:${approvedSha}:${headSha}`;
    if (this.verifiedBuilds.has(key)) return { ok: true };
    // Fail-closed below: a configured verify_build that cannot run proves
    // nothing, so the merge goes to a human rather than proceeding unverified.
    const fail = (detail: string) => ({ ok: false, detail });
    const globs = this.pathPolicy().generated;

    let site: string;
    let detached = false;
    const checks: CheckSpec[] = [];
    const code = this.store.lastCodeWorkspace(task.id);
    const codeHead = code && existsSync(code) ? await this.workspace.head(code).catch(() => null) : null;
    if (code && codeHead === approvedSha) {
      // Dirt under generated paths before the build is tampering evidence —
      // dirt elsewhere does not weaken the drift check.
      let pre: string;
      try { pre = await this.workspace.dirtyUnder(code, globs); }
      catch (err) { return fail(`无法检查生成物状态：${String(err).slice(0, 300)}`); }
      if (pre) {
        return fail(`生成物在构建前已有未提交改动（可能被人为修改）：\n${pre.slice(0, 800)}`);
      }
      site = code;
    } else {
      const bootstrap = project.verify_bootstrap ?? this.config.approvals.auto_merge.verify_bootstrap;
      if (bootstrap) checks.push(bootstrap);
      const verifyDir = resolve(this.config.server.worktree_root, '_verify', `${task.id}-${approvedSha.slice(0, 12)}`);
      try {
        site = await this.workspace.addDetachedWorktree(project.local_repo, approvedSha, verifyDir);
      } catch {
        // A crashed earlier attempt can leave the path or its registration
        // behind; both sit inside our own `_verify` namespace — clean & retry.
        rmSync(verifyDir, { recursive: true, force: true });
        await this.workspace.pruneWorktrees(project.local_repo).catch(() => {});
        try {
          site = await this.workspace.addDetachedWorktree(project.local_repo, approvedSha, verifyDir);
        } catch (err) {
          return fail(`无法物化被批准 SHA 的工作树：${String(err).slice(0, 300)}`);
        }
      }
      detached = true;
    }
    checks.push(build);
    try {
      const dir = join(this.config.server.logs_dir, 'artifacts', `merge-verify-${task.id}`);
      mkdirSync(dir, { recursive: true });
      const summary = await this.runChecksFn(
        checks, site, (i) => join(dir, `check-${i}-${Date.now()}.log`),
      );
      if (!summary.ok) {
        return fail((summary.infraError ?? summary.failureEvidence ?? '构建未通过').slice(0, 800));
      }
      if (summary.outcomes.length === 0) {
        return fail('verify_build 因平台限制被跳过，无法验证生成物与源码一致');
      }
      let drifted = '';
      try { drifted = await this.workspace.dirtyUnder(site, globs); }
      catch (err) { return fail(`无法检查构建产物：${String(err).slice(0, 300)}`); }
      if (drifted) {
        return fail(`构建后生成物与提交不一致：\n${drifted.slice(0, 800)}`);
      }
      this.verifiedBuilds.add(key);
      this.appLog.event('verify_build_ok', { task: task.id, head_sha: headSha, site: detached ? 'detached' : 'worktree' });
      return { ok: true };
    } finally {
      if (detached) {
        await this.workspace.removeWorktree(project.local_repo, site).catch(() => {});
      }
    }
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
      'AI Review PASS 不会自动合并；请人工审查后决定是否合并。',
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
    // Service shutdown never writes a terminal state for a code run — it
    // suspends so the next boot's reconcile can resume it. An explicit user
    // cancel (cancel_requested) still takes the normal terminal path.
    if (this.shouldSuspend(run)) { this.suspendForShutdown(this.store.getRun(run.run_id) ?? run); return; }
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
    fields?: { approved_hash?: string | null; branch?: string | null; pr_url?: string | null; pending_fix?: string | null; merge_attempts?: number; approved_sha?: string | null; approved_by?: 'review' | 'human' | null },
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
      await step('remote-branch', () => this.workspace.deleteRemoteBranch(project.local_repo, branch, project.git_remote));
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
