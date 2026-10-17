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
      provider: 'codex',
      sandbox: 'danger-full-access',
      review_sandbox: 'danger-full-access',
      env_deny: [],
    },
    approvals: {
      require_design_approval: true,
      require_manual_merge: true,
      allow_auto_deploy: false,
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
  prCreated: number;
}

export function makeFakeTracker(): FakeTracker & {
  listReadyIssues: (repo: string, label: string) => Promise<any[]>;
  getIssue: (repo: string, n: number) => Promise<any>;
  addLabel: (repo: string, n: number, l: string) => Promise<void>;
  removeLabel: (repo: string, n: number, l: string) => Promise<void>;
  findPrForBranch: (repo: string, b: string) => Promise<any>;
  getPrState: (repo: string, n: number) => Promise<any>;
  createDraftPr: (repo: string, o: any) => Promise<any>;
} {
  const t: FakeTracker = {
    issues: new Map(),
    prs: new Map(),
    prStates: new Map(),
    labelsAdded: [],
    labelsRemoved: [],
    prCreated: 0,
  };
  return Object.assign(t, {
    async listReadyIssues(_repo: string, label: string) {
      return [...t.issues.entries()]
        .filter(([, i]) => i.state === 'OPEN' && i.labels.includes(label))
        .map(([number, i]) => ({ number, ...i }));
    },
    async getIssue(_repo: string, n: number) {
      const i = t.issues.get(n);
      if (!i) return null;
      return { number: n, ...i };
    },
    async addLabel(_r: number | string, n: number, l: string) {
      t.labelsAdded.push([n, l]);
      t.issues.get(n)?.labels.push(l);
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
    async createDraftPr(_repo: string, o: { head: string; title: string }) {
      t.prCreated++;
      const pr = { number: 100 + t.prCreated, url: `https://github.com/x/y/pull/${100 + t.prCreated}`, state: 'OPEN', isDraft: true };
      t.prs.set(o.head, pr);
      return pr;
    },
  });
}
