import { createHash } from 'node:crypto';
import type { IssueData, PrInfo } from '../types.js';
import { runProc, which, type ProcResult } from '../proc.js';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      });
      if (res.exitCode === 0) return res;
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
    }));
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueData | null> {
    const res = await this.gh([
      'issue', 'view', String(issueNumber), '-R', repo,
      '--json', 'number,title,body,labels,state,url',
    ]).catch((err) => {
      if (err instanceof TrackerError && /not found|Could not resolve/i.test(err.message)) return null;
      throw err;
    });
    if (res === null) return null;
    const r = JSON.parse(res.stdoutTail) as {
      number: number; title: string; body: string; labels: { name: string }[]; state: string; url: string;
    };
    return {
      number: r.number,
      title: r.title,
      body: r.body ?? '',
      labels: (r.labels ?? []).map((l) => l.name),
      state: r.state,
      url: r.url,
    };
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

  /** Post a comment on an issue (used to surface attention states on GitHub). */
  async addComment(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.gh(['issue', 'comment', String(issueNumber), '-R', repo, '--body', body]);
  }

  async ensureLabels(repo: string, labels: string[]): Promise<{ ok: boolean; missing: string[] }> {
    const rows = await this.ghJson<{ name: string }[]>([
      'label', 'list', '-R', repo, '--json', 'name', '--limit', '200',
    ]);
    const have = new Set(rows.map((r) => r.name));
    return { ok: labels.every((l) => have.has(l)), missing: labels.filter((l) => !have.has(l)) };
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
