import { createHash } from 'node:crypto';
import type { IssueData, PrInfo } from '../types.js';
import { runProc, which, type ProcResult } from '../proc.js';
import type { IssueComment } from '../triage/state.js';

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly result?: ProcResult,
  ) {
    super(message);
  }
}

const TRANSIENT = /429|rate limit|timed? ?out|timeout|ECONN|ENET|EAI_AGAIN|temporarily|connection (reset|refused)|502|503|504/i;
const MAX_TRIES = 4;

/** One entry of `gh pr list --state open`, for PR-first discovery. */
export interface OpenPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  labels: string[];
  isCrossRepository: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Labels the scheduler relies on beyond the per-project ready_label —
 *  provisioned (best-effort) when a project is added through the UI. */
export const SYSTEM_LABELS = [
  'agent-running', 'agent-blocked', 'agent-pr', 'agent-reviewing',
  'agent-high-risk', 'agent-merge', 'agent-review',
  'agent-needs-human', 'agent-human-hold', 'agent-triage-managed',
];
export const TRIAGE_LABELS = ['agent-needs-human', 'agent-human-hold', 'agent-triage-managed'];

/** Symphony's seven mutually exclusive Issue states (#6). */
export const WORKFLOW_STATE_LABELS = ['Backlog', 'Todo', 'In Progress', 'Human Review', 'Rework', 'Merging', 'Done'];

export function requiredLabelsForProject(readyLabel: string, triageEnabled: boolean, workflow = false): string[] {
  if (workflow) {
    // Issue #6: the seven state labels are the only labels this design owns.
    return [...WORKFLOW_STATE_LABELS];
  }
  return [...new Set([...(triageEnabled ? [] : [readyLabel]), ...SYSTEM_LABELS.filter(label => label !== 'agent-triage-managed' && (triageEnabled || !TRIAGE_LABELS.includes(label)))])];
}

/**
 * GitHub access via the `gh` CLI. Returns structured data; throws
 * TrackerError on persistent failure. Retries transient errors with
 * exponential backoff; never retries 4xx-style validation errors.
 */
export class GitHubTracker {
  private ghPath: string;
  constructor(private exec: typeof runProc = runProc, ghPath?: string) {
    this.ghPath = ghPath ?? which('gh') ?? 'gh';
  }

  private async ghJson<T>(args: string[]): Promise<T> {
    const res = await this.gh(args);
    try {
      return JSON.parse(res.stdoutTail) as T;
    } catch (err) {
      throw new TrackerError(`gh JSON parse failed for: gh ${args.join(' ')}: ${String(err)}`, res);
    }
  }

  private async gh(args: string[]): Promise<ProcResult> {
    let last: ProcResult | null = null;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const res = await this.exec({
        argv: [this.ghPath, ...args],
        timeoutMs: 60_000,
        streamStdoutToLog: false,
        stdoutLimit: 8 * 1024 * 1024,
      });
      if (res.exitCode === 0) {
        if (res.stdoutTruncated) throw new TrackerError('GitHub response exceeded capture limit', res);
        return res;
      }
      last = res;
      const tail = `${res.stdoutTail}\n${res.stderrTail}`;
      const retryable = res.timedOut || TRANSIENT.test(tail);
      if (!retryable || attempt === MAX_TRIES - 1) break;
      await sleep(1_000 * 2 ** attempt);
    }
    throw new TrackerError(`gh ${args.join(' ')} failed: ${last?.stderrTail.trim() || 'unknown'}`, last ?? undefined);
  }

  async listReadyIssues(repo: string, readyLabel: string): Promise<IssueData[]> {
    const rows = await this.ghJson<
      { number: number; title: string; body: string; labels: { name: string }[]; updatedAt: string; url: string; state?: string }[]
    >([
      'issue', 'list', '-R', repo, '--state', 'open', '--label', readyLabel,
      '--json', 'number,title,body,labels,updatedAt,url', '--limit', '100',
    ]);
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? '',
      labels: (r.labels ?? []).map((l) => l.name),
      state: 'OPEN',
      url: r.url,
      updatedAt: r.updatedAt,
    })).filter((r) => !r.labels.includes('agent-running'));
  }

  async listOpenIssues(repo: string): Promise<IssueData[]> {
    const rows = await this.pages<Record<string, unknown>>(`repos/${repo}/issues?state=open&per_page=50`);
    return rows.filter(r => !r.pull_request).map(r => ({
      number: r.number as number, title: r.title as string, body: (r.body as string) ?? '',
      labels: (r.labels as { name: string }[]).map(l => l.name), state: 'OPEN', url: r.html_url as string,
      updatedAt: r.updated_at as string, createdAt: r.created_at as string,
      author: (r.user as { login?: string } | undefined)?.login,
      author_association: r.author_association as string | undefined,
    }));
  }

  private async pages<T>(endpoint: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.ghJson<T[]>(['api', `${endpoint}&page=${page}`]);
      if (!Array.isArray(rows)) throw new TrackerError('Expected paginated GitHub array');
      result.push(...rows);
      if (rows.length < 50) return result;
    }
  }

  async issueComments(repo: string, number: number): Promise<IssueComment[]> {
    const rows = await this.pages<{ id: number; body: string; user: { login: string; type: string }; created_at: string; updated_at: string }>(`repos/${repo}/issues/${number}/comments?per_page=50`);
    return rows.map(r => ({ id: r.id, body: r.body, author: r.user.login, authorType: r.user.type, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async authLogin(): Promise<string> {
    return (await this.ghJson<{ login: string }>(['api', 'user'])).login;
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<number> {
    return (await this.ghJson<{ id: number }>(['api', `repos/${repo}/issues/${number}/comments`, '-X', 'POST', '-f', `body=${body}`])).id;
  }

  async editIssueComment(repo: string, id: number, body: string): Promise<void> {
    await this.gh(['api', `repos/${repo}/issues/comments/${id}`, '-X', 'PATCH', '-f', `body=${body}`]);
  }

  /**
   * Open PRs for the PR-first discovery path. Drafts and cross-repo (fork)
   * PRs are returned rather than filtered here so the caller owns the rules;
   * `isCrossRepository` matters because a fork head cannot be fetched from
   * the local repo's remote.
   */
  async listOpenPrs(repo: string): Promise<OpenPr[]> {
    const rows = await this.ghJson<
      {
        number: number; title: string; url: string; isDraft: boolean;
        headRefName: string; baseRefName: string; createdAt: string;
        labels: { name: string }[]; isCrossRepository: boolean;
      }[]
    >([
      'pr', 'list', '-R', repo, '--state', 'open',
      '--json', 'number,title,url,isDraft,headRefName,baseRefName,createdAt,labels,isCrossRepository',
      '--limit', '100',
    ]);
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      isDraft: r.isDraft,
      headRefName: r.headRefName,
      baseRefName: r.baseRefName,
      createdAt: r.createdAt,
      labels: (r.labels ?? []).map((l) => l.name),
      isCrossRepository: r.isCrossRepository,
    }));
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueData | null> {
    // REST, not `gh issue view`: the CLI's --json field set differs across gh
    // versions and rejects authorAssociation on some installs.
    const res = await this.gh(['api', `repos/${repo}/issues/${issueNumber}`]).catch((err) => {
      if (err instanceof TrackerError && /not found|Not Found|Could not resolve/i.test(err.message)) return null;
      throw err;
    });
    if (res === null) return null;
    const r = JSON.parse(res.stdoutTail) as {
      number: number; title: string; body: string | null; labels: { name: string }[];
      state: string; html_url: string; user?: { login?: string }; author_association?: string;
    };
    return {
      number: r.number,
      title: r.title,
      body: r.body ?? '',
      labels: (r.labels ?? []).map((l) => l.name),
      // REST returns lowercase open/closed; the rest of the engine compares
      // against the CLI's OPEN/CLOSED contract.
      state: r.state.toUpperCase(),
      url: r.html_url,
      author: r.user?.login,
      author_association: r.author_association,
    };
  }

  /** Paginated label events: the only place a human approval actor is visible. */
  async issueLabelEvents(repo: string, issueNumber: number): Promise<{
    id: number; event: string; label: string | null; actor: string; actorType: string; createdAt: string;
  }[]> {
    const rows = await this.pages<{
      id: number; event: string; label?: { name?: string }; actor?: { login?: string; type?: string }; created_at: string;
    }>(`repos/${repo}/issues/${issueNumber}/events?per_page=50`);
    return rows.map(row => ({
      id: row.id, event: row.event, label: row.label?.name ?? null,
      actor: row.actor?.login ?? '', actorType: row.actor?.type ?? '', createdAt: row.created_at,
    }));
  }

  /** Repository permission of a login; null when it cannot be resolved. */
  async collaboratorPermission(repo: string, login: string): Promise<string | null> {
    try {
      const row = await this.ghJson<{ permission?: string; role_name?: string }>([
        'api', `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      ]);
      return row.permission ?? row.role_name ?? null;
    } catch (err) {
      if (err instanceof TrackerError && /404|Not Found/i.test(err.message)) return null;
      throw err;
    }
  }

  async closeIssue(repo: string, issueNumber: number): Promise<void> {
    await this.gh(['issue', 'close', String(issueNumber), '-R', repo]);
  }

  /**
   * Set the single workflow state label while preserving every other label.
   * GitHub has no compare-and-swap, so the caller persists intent first and
   * re-reads afterwards; a concurrent human edit must not be overwritten.
   */
  async setWorkflowState(repo: string, issueNumber: number, label: string, allLabels: readonly string[]): Promise<void> {
    const remove = WORKFLOW_STATE_LABELS.filter(existing => existing !== label && allLabels.includes(existing));
    // Add first: a failed add must leave the previous state label in place,
    // never an Issue with zero state labels. A failed remove leaves a visible
    // conflict, which the engine already fails closed on.
    if (!allLabels.includes(label)) await this.addLabel(repo, issueNumber, label);
    for (const existing of remove) await this.removeLabel(repo, issueNumber, existing);
  }

  async addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    await this.gh(['issue', 'edit', String(issueNumber), '-R', repo, '--add-label', label]);
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    await this.gh(['issue', 'edit', String(issueNumber), '-R', repo, '--remove-label', label]);
  }

  async findPrForBranch(repo: string, branch: string): Promise<PrInfo | null> {
    const rows = await this.ghJson<{ number: number; url: string; state: string; isDraft: boolean }[]>([
      'pr', 'list', '-R', repo, '--head', branch, '--state', 'all',
      '--json', 'number,url,state,isDraft', '--limit', '5',
    ]);
    return rows[0] ?? null;
  }

  /** Returns MERGED | CLOSED | OPEN for an existing PR number. */
  async getPrState(repo: string, prNumber: number): Promise<'MERGED' | 'CLOSED' | 'OPEN'> {
    const r = await this.ghJson<{ state: string }>([
      'pr', 'view', String(prNumber), '-R', repo, '--json', 'state',
    ]);
    if (r.state === 'MERGED') return 'MERGED';
    return r.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  }

  /** One-shot PR snapshot for the review dispatcher: state + pinned head + labels. */
  async getPrDetails(repo: string, prNumber: number): Promise<{
    state: 'MERGED' | 'CLOSED' | 'OPEN';
    headSha: string;
    baseSha?: string;
    labels: string[];
    isDraft: boolean;
    url: string;
    body: string;
    mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    checks?: { name: string; status: string; conclusion: string | null }[];
  }> {
    const r = await this.ghJson<{
      state: string; headRefOid: string; baseRefOid?: string; labels: { name: string }[]; isDraft: boolean;
      url: string; body: string; mergeable: string;
      statusCheckRollup?: ({ name?: string; context?: string; status?: string; conclusion?: string | null; state?: string })[];
    }>([
      'pr', 'view', String(prNumber), '-R', repo, '--json', 'state,headRefOid,baseRefOid,labels,isDraft,url,body,mergeable,statusCheckRollup',
    ]);
    return {
      state: r.state === 'MERGED' ? 'MERGED' : r.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      headSha: r.headRefOid,
      baseSha: r.baseRefOid,
      labels: (r.labels ?? []).map((l) => l.name),
      isDraft: r.isDraft,
      url: r.url,
      body: r.body ?? '',
      mergeable: r.mergeable === 'CONFLICTING' ? 'CONFLICTING' : r.mergeable === 'MERGEABLE' ? 'MERGEABLE' : 'UNKNOWN',
      checks: (r.statusCheckRollup ?? []).map((c) => ({
        name: c.name ?? c.context ?? '-',
        status: c.status ?? 'COMPLETED',
        conclusion: c.conclusion ?? c.state ?? null,
      })),
    };
  }

  async createDraftPr(
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<PrInfo> {
    const res = await this.gh([
      'pr', 'create', '-R', repo, '--draft',
      '--head', opts.head, '--base', opts.base,
      '--title', opts.title, '--body', opts.body,
    ]);
    const m = res.stdoutTail.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
    const url = m?.[0] ?? res.stdoutTail.trim().split(/\s+/)[0] ?? '';
    const num = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
    return { number: num, url, state: 'OPEN', isDraft: true };
  }

  /** Best-effort close of a PR (used when approval is revoked right after create). */
  async closePr(repo: string, prNumber: number): Promise<void> {
    await this.gh(['pr', 'close', String(prNumber), '-R', repo]);
  }

  async getPrHeadSha(repo: string, prNumber: number): Promise<string> {
    const r = await this.ghJson<{ headRefOid: string }>([
      'pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefOid',
    ]);
    return r.headRefOid;
  }

  /** Draft → ready for review, required before `gh pr merge` accepts it. */
  async markPrReady(repo: string, prNumber: number): Promise<void> {
    await this.gh(['pr', 'ready', String(prNumber), '-R', repo]);
  }

  async markPrDraft(repo: string, prNumber: number): Promise<void> {
    await this.gh(['pr', 'ready', String(prNumber), '-R', repo, '--undo']);
  }

  /**
   * Squash-merge pinned to the reviewed commit. `--match-head-commit` makes
   * GitHub reject the merge if the branch moved since review.
   */
  async mergePr(repo: string, prNumber: number, headSha: string): Promise<void> {
    await this.gh([
      'pr', 'merge', String(prNumber), '-R', repo,
      '--squash', '--match-head-commit', headSha,
    ]);
  }

  async addPrLabel(repo: string, prNumber: number, label: string): Promise<void> {
    await this.gh(['pr', 'edit', String(prNumber), '-R', repo, '--add-label', label]);
  }

  async removePrLabel(repo: string, prNumber: number, label: string): Promise<void> {
    await this.gh(['pr', 'edit', String(prNumber), '-R', repo, '--remove-label', label]);
  }

  async commentPr(repo: string, prNumber: number, body: string): Promise<void> {
    await this.gh(['pr', 'comment', String(prNumber), '-R', repo, '--body', body]);
  }

  /** Post a comment on an issue (used to surface attention states on GitHub). */
  async addComment(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.gh(['issue', 'comment', String(issueNumber), '-R', repo, '--body', body]);
  }

  /** Issue comments for post-claim race arbitration. */
  async listIssueComments(repo: string, issueNumber: number): Promise<{ body: string; createdAt: string }[]> {
    return this.ghJson<{ body: string; createdAt: string }[]>([
      'issue', 'view', String(issueNumber), '-R', repo,
      '--json', 'comments', '--jq', '[.comments[] | {body, createdAt}]',
    ]);
  }

  async listLabels(repo: string): Promise<string[]> {
    const rows = await this.ghJson<{ name: string }[]>([
      'label', 'list', '-R', repo, '--json', 'name', '--limit', '500',
    ]);
    return rows.map(row => row.name);
  }

  async deleteLabel(repo: string, name: string): Promise<void> {
    await this.gh(['label', 'delete', name, '-R', repo, '--yes']);
  }

  async ensureLabels(repo: string, labels: string[]): Promise<{ ok: boolean; missing: string[] }> {
    const rows = await this.ghJson<{ name: string }[]>([
      'label', 'list', '-R', repo, '--json', 'name', '--limit', '200',
    ]);
    const have = new Set(rows.map((r) => r.name));
    return { ok: labels.every((l) => have.has(l)), missing: labels.filter((l) => !have.has(l)) };
  }

  /** Cheap existence+access check used when a project is added at runtime. */
  async checkRepoExists(repo: string): Promise<void> {
    await this.resolveRepo(repo);
  }

  /** Canonical owner/name — gh follows GitHub's rename redirects, so a stale
   *  remote URL still resolves to the repo it actually feeds. */
  async resolveRepo(repo: string): Promise<string> {
    const o = await this.ghJson<{ nameWithOwner: string }>(['repo', 'view', repo, '--json', 'nameWithOwner']);
    return o.nameWithOwner;
  }

  /** Create a label if missing; --force turns the already-exists race into a no-op. */
  async createLabel(repo: string, name: string): Promise<void> {
    const res = await this.exec({
      argv: [this.ghPath, 'label', 'create', name, '-R', repo, '--color', '7d7bff', '--force'],
      timeoutMs: 60_000,
      streamStdoutToLog: false,
    });
    if (res.exitCode !== 0) {
      throw new TrackerError(`gh label create ${name} failed: ${res.stderrTail.trim() || 'unknown'}`, res);
    }
  }
}

/**
 * SHA-256 over the approved issue content (title + normalized body).
 * A hash change after approval means the approved requirements drifted.
 */
export function approvalHash(issue: Pick<IssueData, 'title' | 'body'>): string {
  const canonical = `${issue.title.trim()}\n\n${issue.body.replace(/\r\n/g, '\n').trim()}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
