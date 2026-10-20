import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/sqlite.js';
import type { AppConfig } from '../src/types.js';
import type { AppLog } from '../src/telemetry/logging.js';

export function tmpDir(prefix = 'ac-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* temp residue is harmless */ }
}

export function makeConfig(dir: string, overrides?: Partial<AppConfig>): AppConfig {
  return {
    server: {
      poll_interval_seconds: 30,
      max_concurrent: 1,
      retry_limit: 3,
      max_task_minutes: 45,
      worktree_root: join(dir, 'worktrees'),
      database: join(dir, 'ac.db'),
      logs_dir: join(dir, 'logs'),
      cancel_poll_seconds: 5,
      ui: { enabled: false, host: '127.0.0.1', port: 8787 },
    },
    projects: [
      {
        repo: 'me/sandbox',
        local_repo: join(dir, 'repo'),
        base_branch: 'main',
        ready_label: 'agent-ready',
        branch_prefix: 'agent/issue-',
        checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
    ],
    agent: {
      provider: 'pi',
      model: 'test/model',
      env_deny: [],
    },
    approvals: {
      require_design_approval: true,
      require_manual_merge: true,
      allow_auto_deploy: false,
      auto_merge: { enabled: false, max_files: 10, max_lines: 400 },
    },
    ...overrides,
  };
}

export function makeStore(dir: string): Store {
  return new Store(join(dir, 'ac.db'));
}

/** Close stores then remove dir; never throws so assertion errors aren't masked. */
export function teardown(dir: string, stores: { close(): void }[]) {
  for (const s of stores) {
    try { s.close(); } catch { /* already closed */ }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* Windows can hold WAL locks briefly; temp dir leftovers are harmless */ }
}

export const nullLog: AppLog = {
  event: () => {},
} as unknown as AppLog;

export interface FakeTracker {
  issues: Map<number, { title: string; body: string; labels: string[]; state: string; url: string }>;
  prs: Map<string, { number: number; url: string; state: string; isDraft: boolean }>;
  prStates: Map<number, 'OPEN' | 'CLOSED' | 'MERGED'>;
  labelsAdded: [number, string][];
  labelsRemoved: [number, string][];
  comments: [number, string][];
  prComments: [number, string][];
  merged: number[];
  prCreated: number;
  headSha: string;
}

export function makeFakeTracker(): FakeTracker & {
  listReadyIssues: (repo: string, label: string) => Promise<any[]>;
  getIssue: (repo: string, n: number) => Promise<any>;
  addLabel: (repo: string, n: number, l: string) => Promise<void>;
  removeLabel: (repo: string, n: number, l: string) => Promise<void>;
  findPrForBranch: (repo: string, b: string) => Promise<any>;
  getPrState: (repo: string, n: number) => Promise<any>;
  getPrHeadSha: (repo: string, n: number) => Promise<string>;
  markPrReady: (repo: string, n: number) => Promise<void>;
  mergePr: (repo: string, n: number, sha: string) => Promise<void>;
  addPrLabel: (repo: string, n: number, l: string) => Promise<void>;
  removePrLabel: (repo: string, n: number, l: string) => Promise<void>;
  commentPr: (repo: string, n: number, body: string) => Promise<void>;
  closePr: (repo: string, n: number) => Promise<void>;
  createDraftPr: (repo: string, o: any) => Promise<any>;
  addComment: (repo: string, n: number, body: string) => Promise<void>;
} {
  const t: FakeTracker = {
    issues: new Map(),
    prs: new Map(),
    prStates: new Map(),
    labelsAdded: [],
    labelsRemoved: [],
    comments: [],
    prComments: [],
    merged: [],
    prCreated: 0,
    headSha: 'head-sha',
  };
  return Object.assign(t, {
    async listReadyIssues(_repo: string, label: string) {
      return [...t.issues.entries()]
        .filter(([, i]) => i.state === 'OPEN' && i.labels.includes(label) && !i.labels.includes('agent-running'))
        .map(([number, i]) => ({ number, ...i }));
    },
    async getIssue(_repo: string, n: number) {
      const i = t.issues.get(n);
      if (!i) return null;
      return { number: n, ...i };
    },
    async addLabel(_r: number | string, n: number, l: string) {
      t.labelsAdded.push([n, l]);
      const i = t.issues.get(n);
      if (i) i.labels = [...i.labels, l];
    },
    async removeLabel(_r: number | string, n: number, l: string) {
      t.labelsRemoved.push([n, l]);
      const i = t.issues.get(n);
      if (i) i.labels = i.labels.filter((x) => x !== l);
    },
    async findPrForBranch(_repo: string, branch: string) {
      return t.prs.get(branch) ?? null;
    },
    async getPrState(_repo: string, n: number) {
      return t.prStates.get(n) ?? 'OPEN';
    },
    async getPrHeadSha(_repo: string, _n: number) {
      return t.headSha;
    },
    async getPrDetails(_repo: string, n: number) {
      const pr = [...t.prs.values()].find((p) => p.number === n);
      return {
        state: (t.prStates.get(n) ?? pr?.state ?? 'OPEN') as 'OPEN' | 'CLOSED' | 'MERGED',
        headSha: t.headSha,
        labels: [] as string[],
        isDraft: pr?.isDraft ?? true,
        url: pr?.url ?? `https://github.com/x/y/pull/${n}`,
      };
    },
    async markPrReady(_repo: string, _n: number) {},
    async mergePr(_repo: string, n: number, _sha: string) {
      t.merged.push(n);
      t.prStates.set(n, 'MERGED');
    },
    async addPrLabel(_repo: string, _n: number, _l: string) {},
    async removePrLabel(_repo: string, _n: number, _l: string) {},
    async commentPr(_repo: string, n: number, body: string) {
      t.prComments.push([n, body]);
    },
    async closePr(_repo: string, n: number) {
      t.prStates.set(n, 'CLOSED');
    },
    async createDraftPr(_repo: string, o: { head: string; title: string }) {
      t.prCreated++;
      const pr = { number: 100 + t.prCreated, url: `https://github.com/x/y/pull/${100 + t.prCreated}`, state: 'OPEN', isDraft: true };
      t.prs.set(o.head, pr);
      return pr;
    },
    async addComment(_repo: string, n: number, body: string) {
      t.comments.push([n, body]);
    },
  });
}
