import type { AppConfig, IssueData, ProjectConfig } from '../types.js';
import type { Store } from '../store/sqlite.js';
import type { GitHubTracker } from '../tracker/github.js';
import type { GitWorkspace } from '../workspace/git.js';
import type { AppLog } from '../telemetry/logging.js';
import type { AgentCallOpts } from '../runners/types.js';
import { runPi } from '../runners/pi.js';
import { runProcessRisk, type ProcessSafetyDeps } from '../proc.js';
import { retryTask } from '../ops.js';
import { acceptsAllIssues, emptyIntake, type IntakeState } from './intake.js';
import { HUMAN_HOLD, NEEDS_HUMAN, MANAGED, RUNNING, REASONS, inputComments, inputHash, readState, readClaims,
  type IssueComment, type TriageItem, type TriageJob } from './state.js';

type Tracker = Pick<GitHubTracker, 'listOpenIssues' | 'issueComments' | 'getIssue' | 'addLabel' | 'removeLabel' | 'authLogin' | 'createIssueComment' | 'editIssueComment'>;
export interface TriageDeps {
  config: AppConfig; store: Store; tracker: Tracker; workspace: Pick<GitWorkspace, 'fetchBranch' | 'refSha' | 'addDetachedWorktree' | 'head' | 'isDirty' | 'removeWorktree'>;
  appLog: AppLog; canStart?: () => boolean; claimMs?: number; processDeps?: ProcessSafetyDeps;
  runModel?: (opts: AgentCallOpts) => ReturnType<typeof runPi>;
}
export type TriageAction = 'sync' | 'approve' | 'defer' | 'reevaluate' | 'lock' | 'unlock' | 'recover' | 'reset' | 'release-claim';

export class IssueTriage {
  private stopped = false;
  private login: string | null = null;
  private syncing = new Map<string, Promise<void>>();
  constructor(private deps: TriageDeps) {}
  activeCount() { return 0; }
  private user() { return this.login ? Promise.resolve(this.login) : this.deps.tracker.authLogin().then(login => this.login = login); }
  private project(repo: string) {
    const p = this.deps.config.projects.find(p => p.repo === repo);
    if (!p) throw new Error('仓库不属于当前配置项目');
    return p;
  }
  state(repo: string, number: number) { return this.deps.store.getIntake<IntakeState>(repo, number); }
  list(): (TriageItem & { intake: IntakeState | null })[] {
    const repos = new Set(this.deps.config.projects.filter(acceptsAllIssues).map(p => p.repo));
    return this.deps.store.listTriage<TriageItem>().filter(i => repos.has(i.repo)).map(i => ({ ...i, intake: this.state(i.repo, i.issue.number) }));
  }
  private cache(repo: string, issue: IssueData, state: IntakeState) {
    this.deps.store.cacheTriage(repo, issue.number, { repo, issue, state: null,
      status: state.kind ?? (state.locked || state.error ? 'human' : 'routed'), locked: state.locked,
      error: state.error || state.reason || null, comment_id: null, claim_id: null, observed_at: new Date().toISOString() });
  }
  private async importIssue(project: ProjectConfig, issue: IssueData): Promise<IntakeState> {
    const existing = this.state(project.repo, issue.number);
    if (existing?.imported) return existing;
    const value = emptyIntake();
    try {
      const jobs = this.deps.store.triageJobs<TriageJob>().filter(j => j.repo === project.repo && j.number === issue.number);
      if (jobs.length) throw new Error('旧分流进程需核验退出后恢复');
      const comments = await this.deps.tracker.issueComments(project.repo, issue.number);
      const login = await this.user();
      const old = readState(comments, login).state;
      if (readClaims(comments, login).length || old?.pending_action) throw new Error('旧分流认领或同步动作未结束，需人工恢复');
      if (!old && issue.labels.includes(MANAGED)) throw new Error('旧分流记录缺失，需人工恢复');
      value.kind = old?.decision === 'HUMAN' ? 'human' : old?.decision === 'DEFER' ? 'deferred' : old?.decision === 'SKIP' ? 'skipped' : null;
      value.reason = old ? REASONS[old.reason_code] : '';
      value.defer_until = old?.defer_until ?? null;
      // locked is the local human lock; the remote label is tracked by external_hold
      // in the scan loop, so removing it in GitHub must not leave a stale local lock.
      value.locked = false;
      if (issue.labels.includes(NEEDS_HUMAN)) value.kind = 'human';
    } catch (err) {
      value.kind = 'human'; value.error = String(err); value.imported = false;
    }
    // A concurrent human action must win over this remote read.
    const current = this.state(project.repo, issue.number);
    if (current && current.version !== existing?.version) return current;
    this.deps.store.saveIntake(project.repo, issue.number, value);
    return value;
  }
  async scan() {
    if (this.stopped) return;
    for (const project of this.deps.config.projects.filter(acceptsAllIssues)) {
      if (project.issue_triage?.enabled && project.issue_intake === undefined) {
        const key = `intake-deprecation:${project.repo}`;
        if (!this.deps.store.getMeta(key)) {
          this.deps.appLog.event('config_deprecated', { repo: project.repo, message: 'issue_triage 已映射到 issue_intake: all；timeout_seconds 不再使用' });
          this.deps.store.setMeta(key, '1');
        }
      }
      try {
        const issues = await this.deps.tracker.listOpenIssues(project.repo);
        for (const issue of issues) {
          if (this.stopped) return;
          const allowedAuthors = project.issue_author_association;
          if (allowedAuthors?.length && !allowedAuthors.includes(issue.author_association ?? 'NONE')) {
            // Persist a skipped disposition so the disposition model stays
            // honest and the issue never creates a task card. Persisted
            // dispositions are never auto-retried: trusting the author later
            // requires an explicit human action, same as any other skip.
            const known = this.state(project.repo, issue.number);
            if (!known?.imported) {
              const skipped = { ...emptyIntake(), imported: true, kind: 'skipped' as const,
                reason: `非可信作者（${issue.author ?? '?'}:${issue.author_association ?? 'NONE'}），issue_author_association 白名单过滤` };
              this.deps.store.saveIntake(project.repo, issue.number, skipped);
              this.cache(project.repo, issue, skipped);
              this.deps.appLog.event('issue_intake_author_filtered', { repo: project.repo, issue: issue.number, author: issue.author ?? null, author_association: issue.author_association ?? 'NONE' });
            }
            continue;
          }
          let value = await this.importIssue(project, issue);
          const externalHold = issue.labels.includes(HUMAN_HOLD);
          const externalNeeds = issue.labels.includes(NEEDS_HUMAN);
          const latest = this.state(project.repo, issue.number)!;
          if (!latest.pending && (Boolean(latest.external_hold) !== externalHold || Boolean(latest.external_needs) !== externalNeeds)) {
            value = { ...latest, external_hold: externalHold, external_needs: externalNeeds, version: latest.version + 1, updated_at: new Date().toISOString() };
            this.deps.store.saveIntake(project.repo, issue.number, value);
          } else value = latest;
          const { task } = this.deps.store.upsertDiscovered({ repo: project.repo, issue_number: issue.number, issue_title: issue.title, issue_url: issue.url });
          const gated = Boolean(value.kind || value.locked || value.external_hold || value.external_needs || value.error);
          if (!this.deps.store.activeRunForTask(task.id) && task.status === 'DISCOVERED' && gated) {
            this.deps.store.setTaskStatus(task.id, 'BLOCKED');
          }
          // A card parked only by an intake gate has never run; once every
          // gate clears it must return to DISCOVERED, otherwise it is
          // stranded in BLOCKED forever. Tasks that actually ran (and then
          // failed) keep their BLOCKED until an explicit retry.
          if (task.status === 'BLOCKED' && !gated && !this.deps.store.runsForTask(task.id).length) {
            this.deps.store.setTaskStatus(task.id, 'DISCOVERED');
          }
          this.cache(project.repo, issue, value);
          if (value.pending) this.startSync(project, issue.number);
        }
      } catch (err) { this.deps.appLog.event('issue_scan_error', { repo: project.repo, error: String(err) }); }
    }
  }
  async authorize(project: ProjectConfig, issue: IssueData): Promise<{ issue: IssueData; comments: IssueComment[]; hash: string } | null> {
    if (!acceptsAllIssues(project)) {
      return issue.labels.some(l => [HUMAN_HOLD, NEEDS_HUMAN].includes(l)) ? null : { issue, comments: [], hash: '' };
    }
    try {
      const current = await this.deps.tracker.getIssue(project.repo, issue.number);
      if (!current || current.state !== 'OPEN' || current.labels.some(l => [HUMAN_HOLD, NEEDS_HUMAN].includes(l))) return null;
      // Defense in depth: a task card created before the allowlist existed
      // (or by a path other than scan) must not dispatch either.
      if (project.issue_author_association?.length && !project.issue_author_association.includes(current.author_association ?? 'NONE')) return null;
      const state = this.state(project.repo, issue.number);
      if (!state?.imported || state.kind || state.locked || state.pending || state.error) return null;
      const comments = await this.deps.tracker.issueComments(project.repo, issue.number);
      const login = await this.user();
      return { issue: current, comments: inputComments(comments, login), hash: inputHash(current, comments, login) };
    } catch (err) { this.deps.appLog.event('intake_authorize_error', { repo: project.repo, issue: issue.number, error: String(err) }); return null; }
  }
  recordOutcome(repo: string, number: number, kind: IntakeState['kind'], reason: string) {
    const old = this.state(repo, number) ?? emptyIntake();
    this.deps.store.saveIntake(repo, number, { ...old, kind, reason, pending: null, version: old.version + 1, updated_at: new Date().toISOString() });
  }
  async action(repo: string, number: number, action: TriageAction, params: { expected_version?: number; defer_until?: string; claim_id?: string; confirm_owner_exited?: boolean } = {}) {
    const project = this.project(repo);
    if (!acceptsAllIssues(project)) throw new Error('项目尚未启用自动接手');
    if (this.stopped) throw new Error('服务正在停止');
    const task = this.deps.store.getTask(repo, number);
    if (!task || task.source !== 'issue') throw new Error('Issue 尚未发现，请等待扫描');
    if (this.deps.store.activeRunForTask(task.id) || ['MERGING', 'AWAITING_REVIEW', 'AWAITING_HUMAN'].includes(task.status)) throw new Error('任务正在执行或评审，请使用任务停止入口');
    if (task.status === 'COMPLETED') throw new Error('已完成任务不能隐式重跑');
    let old = this.state(repo, number);
    if (!old) throw new Error('Issue 处置记录未初始化');
    if (action === 'sync') {
      if (params.expected_version !== old.version) throw new Error('状态已变化，请刷新');
      if (old.pending) this.startSync(project, number);
      return old;
    }
    if (['reset', 'release-claim'].includes(action)) throw new Error('旧认领请先在 GitHub 核验 owner 并解除，再使用恢复操作');
    if (action === 'recover') {
      const jobs = this.deps.store.triageJobs<TriageJob>().filter(j => j.repo === repo && j.number === number);
      for (const job of jobs) {
        const risk = await runProcessRisk({ pid: job.pid, process_identity: job.process_identity, workspace: job.workspace }, this.deps.processDeps);
        if (risk) throw new Error(risk);
      }
      const comments = await this.deps.tracker.issueComments(repo, number);
      if (readClaims(comments, await this.user()).length) throw new Error('仍有旧认领，需先核验并解除');
      for (const job of jobs) this.deps.store.dropTriageJob(job.id);
      const latest = this.state(repo, number)!;
      if (latest.version !== old.version) throw new Error('状态已变化，请刷新');
    } else if (!old.imported) throw new Error('旧分流状态未完成迁移，请先恢复');
    const resume = ['approve', 'reevaluate', 'recover'].includes(action);
    const achieved = action === 'lock' && old.locked || action === 'unlock' && !old.locked && !old.external_hold
      || resume && !old.kind && !old.locked && !old.external_hold && !old.external_needs && !old.error && task.status === 'DISCOVERED';
    if (achieved) { if (old.pending) this.startSync(project, number); return old; }
    if (params.expected_version !== old.version) throw new Error('状态已变化，请刷新后重试');
    if (params.defer_until && !Number.isFinite(Date.parse(params.defer_until))) throw new Error('暂缓时间无效');
    const value: IntakeState = { ...old, version: old.version + 1, updated_at: new Date().toISOString(), error: null };
    if (action === 'lock') { value.locked = true; value.pending = null; }
    else if (action === 'unlock') { value.locked = false; value.external_hold = false; value.pending = { remove: [HUMAN_HOLD], retry: false }; }
    else if (action === 'defer') { value.pending = null; value.kind = 'deferred'; value.reason = '人工暂缓'; value.defer_until = params.defer_until ?? null; }
    else if (resume) {
      value.kind = null; value.reason = ''; value.locked = false; value.external_hold = false; value.external_needs = false; value.defer_until = null; value.imported = true;
      value.pending = { remove: [HUMAN_HOLD, NEEDS_HUMAN], retry: true };
    }
    this.deps.store.tx(() => {
      if (this.state(repo, number)?.version !== old.version || this.deps.store.activeRunForTask(task.id)) throw new Error('状态已变化，请刷新');
      this.deps.store.saveIntake(repo, number, value);
      if ((value.kind || value.locked) && task.status === 'DISCOVERED') this.deps.store.setTaskStatus(task.id, 'BLOCKED');
    });
    if (value.pending) this.startSync(project, number);
    return value;
  }
  private startSync(project: ProjectConfig, number: number) {
    const key = `${project.repo}#${number}`;
    if (this.syncing.has(key) || this.stopped) return;
    const promise = this.sync(project, number).catch(err => {
      this.deps.appLog.event('intake_sync_error', { repo: project.repo, issue: number, error: String(err) });
    }).finally(() => { this.syncing.delete(key); });
    this.syncing.set(key, promise);
  }
  private async sync(project: ProjectConfig, number: number) {
    const old = this.state(project.repo, number);
    if (!old?.pending) return;
    try {
      const issue = await this.deps.tracker.getIssue(project.repo, number);
      if (!issue || issue.state !== 'OPEN') throw new Error('Issue 已关闭或无法读取');
      for (const label of old.pending.remove) {
        if (this.state(project.repo, number)?.version !== old.version || this.stopped) return;
        if (issue.labels.includes(label)) await this.deps.tracker.removeLabel(project.repo, number, label);
      }
      if (this.state(project.repo, number)?.version !== old.version || this.stopped) return;
      const value = { ...old, pending: null, error: null };
      this.deps.store.saveIntake(project.repo, number, value);
      try {
        const task = this.deps.store.getTask(project.repo, number)!;
        if (old.pending.retry && task.status !== 'DISCOVERED') {
          // retryTask only uses the host tracker methods; the full runtime tracker supplies them.
          await retryTask(this.deps.store, this.deps.config, this.deps.tracker as GitHubTracker, task, this.deps.processDeps);
        }
      } catch (err) {
        if (this.state(project.repo, number)?.version === old.version) this.deps.store.saveIntake(project.repo, number, { ...old, error: String(err) });
      }
    } catch (err) {
      if (this.state(project.repo, number)?.version === old.version) this.deps.store.saveIntake(project.repo, number, { ...old, error: String(err) });
    }
  }
  async shutdown() { this.stopped = true; await Promise.allSettled(this.syncing.values()); }
}
