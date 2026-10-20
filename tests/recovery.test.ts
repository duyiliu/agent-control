import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile } from '../src/scheduler/recovery.js';
import type { Engine } from '../src/scheduler/engine.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { Phase } from '../src/types.js';
import type { Store } from '../src/store/sqlite.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-rec-'));
  const stores: Store[] = [];
  const env = {
    dir,
    config: makeConfig(dir),
    tracker: makeFakeTracker(),
    resumed: [] as string[],
    stores,
    store: (() => { const s = makeStore(dir); stores.push(s); return s; })(),
    fakeEngine: null as unknown as Engine,
    done: () => teardown(dir, stores),
  };
  env.fakeEngine = {
    resumeRun: (id: string) => env.resumed.push(id),
    notifyTaskAttention: async () => {},
  } as unknown as Engine;
  return env;
}

async function seedRun(store: Store, phase: Phase, opts: { pid?: number; identity?: string; workspace?: string; resumeCount?: number } = {}) {
  const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
  store.setTaskStatus(task.id, 'RUNNING');
  const run = store.claimRun(task.id);
  store.transition(run.run_id, 'CLAIMED', phase);
  store.updateRunFields(run.run_id, {
    pid: opts.pid ?? null,
    process_identity: opts.identity ?? null,
    workspace: opts.workspace ?? null,
    resume_count: opts.resumeCount ?? 0,
    branch: 'agent/issue-1',
  });
  return { task, run: store.getRun(run.run_id)! };
}

test('dead child at VERIFYING → resumed in place', async () => {
  const env = setup();
  try {
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'VERIFYING', { pid: 999999, identity: '999999:1', workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
      processStartedAt: async () => null,
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.deepEqual(env.resumed, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'VERIFYING');
    assert.equal(env.store.getRun(run.run_id)!.resume_count, 1);
  } finally { env.done(); }
});

test('child possibly alive (pid+start match) → RECOVERY_REQUIRED, no resume', async () => {
  const env = setup();
  try {
    const t0 = Date.now();
    const { task, run } = await seedRun(env.store, 'RUNNING', { pid: 1234, identity: `1234:${t0}`, workspace: env.dir });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => true,
      processStartedAt: async () => t0 + 500,
    });
    assert.equal(report.resumed.length, 0);
    assert.equal(report.recoveryRequired.length, 1);
    assert.deepEqual(env.resumed, []);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('pid alive but identity mismatch (reuse) → treated as dead, resumed', async () => {
  const env = setup();
  try {
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const t0 = Date.now();
    const { run } = await seedRun(env.store, 'VERIFYING', { pid: 1234, identity: `1234:${t0}`, workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => true,
      processStartedAt: async () => t0 + 60_000,
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.deepEqual(env.resumed, [run.run_id]);
  } finally { env.done(); }
});

test('crash after PR create → AWAITING_MERGE, no second PR', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready'], state: 'OPEN', url: 'u' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    const { task, run } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.finalized, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'AWAITING_MERGE');
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_MERGE');
    assert.equal(env.store.getTaskById(task.id)!.pr_url, 'https://x/pull/9');
  } finally { env.done(); }
});

test('crash after PR create + approval revoked → PR closed, task CANCELED', async () => {
  const env = setup();
  try {
    let closed = 0;
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: [], state: 'OPEN', url: 'u' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    (env.tracker as { closePr?: (r: string, n: number) => Promise<void> }).closePr = async () => { closed++; };
    const { task } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(report.resumed.length, 0);
    assert.equal(closed, 1);
    assert.equal(env.store.getTaskById(task.id)!.status, 'CANCELED');
  } finally { env.done(); }
});

test('GitHub issue read failure during publish recovery never closes PR', async () => {
  const env = setup();
  try {
    let closed = 0;
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    env.tracker.getIssue = async () => { throw new Error('network timeout'); };
    (env.tracker as { closePr?: () => Promise<void> }).closePr = async () => { closed++; };
    const { task } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    const report = await reconcile({ store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [], isPidAlive: () => false });
    assert.equal(closed, 0);
    assert.equal(report.resumed.length, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('PR query failure during recovery never starts another publisher', async () => {
  const env = setup();
  try {
    env.tracker.findPrForBranch = async () => { throw new Error('network timeout'); };
    const { task } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    const report = await reconcile({ store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [], isPidAlive: () => false });
    assert.equal(report.resumed.length, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('live recorded PID without identity is never safe to resume', async () => {
  const env = setup();
  try {
    const { task } = await seedRun(env.store, 'RUNNING', { pid: 123, workspace: env.dir });
    await reconcile({ store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [], isPidAlive: () => true, processStartedAt: async () => null });
    assert.equal(env.resumed.length, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('crash before PR create → publish re-run (idempotent check first)', async () => {
  const env = setup();
  try {
    const { run } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.deepEqual(env.resumed, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'PUBLISHING_PR');
  } finally { env.done(); }
});

test('orphaned process referencing worktree → RECOVERY_REQUIRED', async () => {
  const env = setup();
  try {
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'RUNNING', { workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine,
      isPidAlive: () => false,
      findProcs: async () => [4321],
    });
    assert.equal(report.resumed.length, 0);
    assert.equal(report.recoveryRequired.length, 1);
    assert.match(env.store.getRun(run.run_id)!.reason ?? '', /orphaned/);
  } finally { env.done(); }
});

test('orphan scan failure → RECOVERY_REQUIRED (cannot prove clean)', async () => {
  const env = setup();
  try {
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'RUNNING', { workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine,
      isPidAlive: () => false,
      findProcs: async () => null,
    });
    assert.equal(report.recoveryRequired.length, 1);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('missing workspace for RUNNING → RECOVERY_REQUIRED', async () => {
  const env = setup();
  try {
    const { run } = await seedRun(env.store, 'RUNNING', { workspace: join(env.dir, 'nonexistent') });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(report.recoveryRequired.length, 1);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('resume budget exhausted → RECOVERY_REQUIRED', async () => {
  const env = setup();
  try {
    const { run } = await seedRun(env.store, 'VERIFYING', { workspace: env.dir, resumeCount: 2 });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(report.recoveryRequired.length, 1);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});
