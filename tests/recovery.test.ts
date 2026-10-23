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
    resumeRun: (id: string, phase?: Phase) => {
      env.store.resumeRun(id, phase ?? env.store.getRun(id)!.phase);
      env.resumed.push(id);
      return true;
    },
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

test('crash after PR create with review PASS → AWAITING_REVIEW, no second PR', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready'], state: 'OPEN', url: 'u' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    const { task, run } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    env.store.addCheck({ run_id: run.run_id, kind: 'review', command: 'agent (review)', exit_code: null, verdict: 'PASS' });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.finalized, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'AWAITING_REVIEW');
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    assert.equal(env.store.getTaskById(task.id)!.pr_url, 'https://x/pull/9');
  } finally { env.done(); }
});

test('crash after PR create → AWAITING_REVIEW; review dispatches separately', async () => {
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
    assert.equal(env.store.getRun(run.run_id)!.phase, 'AWAITING_REVIEW');
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
  } finally { env.done(); }
});

test('stranded review run resumes on its pinned head sha', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready'], state: 'OPEN', url: 'u' });
    const { task, run } = await seedRun(env.store, 'REVIEWING', { workspace: env.dir });
    env.store.db.prepare("UPDATE runs SET kind = 'review', head_sha = 'sha-x', pr_url = 'https://x/pull/9' WHERE run_id = ?").run(run.run_id);
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'REVIEWING');
    assert.deepEqual(env.resumed, [run.run_id]);
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
    (env.tracker as { closePr?: (r: string, n: number) => Promise<void> }).closePr = async () => { closed++; };
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

test('max_resumes=3 resumes a run at resume_count 2', async () => {
  const env = setup();
  try {
    env.config.server.max_resumes = 3;
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'VERIFYING', { workspace: wt, resumeCount: 2 });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.equal(env.store.getRun(run.run_id)!.resume_count, 3);
  } finally { env.done(); }
});

test('max_resumes=0 disables automatic recovery entirely', async () => {
  const env = setup();
  try {
    env.config.server.max_resumes = 0;
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'VERIFYING', { workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(report.recoveryRequired.length, 1);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
  } finally { env.done(); }
});

test('a deferred resume is queued, not launched, and spends no budget', async () => {
  const env = setup();
  try {
    env.fakeEngine.resumeRun = (() => false) as unknown as Engine['resumeRun'];
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { run } = await seedRun(env.store, 'VERIFYING', { workspace: wt });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.deferred, [run.run_id]);
    assert.deepEqual(report.resumed, []);
    assert.deepEqual(env.resumed, []);
    // Queuing never runs Store.resumeRun: no pid clear, no resume_count.
    assert.equal(env.store.getRun(run.run_id)!.resume_count, 0);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'VERIFYING');
  } finally { env.done(); }
});

test('budget-exhausted park releases agent-running once the child is proven dead', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready', 'agent-running'], state: 'OPEN', url: 'u' });
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { task } = await seedRun(env.store, 'VERIFYING', { workspace: wt, resumeCount: 2 });
    await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(env.tracker.labelsRemoved.some(([n, l]) => n === 1 && l === 'agent-running'));
    assert.ok(!env.tracker.issues.get(1)!.labels.includes('agent-running'));
  } finally { env.done(); }
});

test('a possibly-live child keeps agent-running on the issue', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready', 'agent-running'], state: 'OPEN', url: 'u' });
    const t0 = Date.now();
    const { task } = await seedRun(env.store, 'RUNNING', { pid: 1234, identity: `1234:${t0}`, workspace: env.dir });
    await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => true,
      processStartedAt: async () => t0 + 500,
    });
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(!env.tracker.labelsRemoved.some(([n, l]) => l === 'agent-running'));
  } finally { env.done(); }
});

test('an unresolved orphan scan keeps agent-running on the issue', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready', 'agent-running'], state: 'OPEN', url: 'u' });
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { task } = await seedRun(env.store, 'RUNNING', { workspace: wt });
    await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, isPidAlive: () => false,
      findProcs: async () => null,
    });
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(!env.tracker.labelsRemoved.some(([n, l]) => l === 'agent-running'));
  } finally { env.done(); }
});

test('label release failure is logged but the local park stands', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready', 'agent-running'], state: 'OPEN', url: 'u' });
    env.tracker.removeLabel = async () => { throw new Error('gh api down'); };
    const events: string[] = [];
    const appLog = { event: (name: string) => { events.push(name); } } as unknown as typeof nullLog;
    const wt = join(env.dir, 'wt'); mkdirSync(wt, { recursive: true });
    const { task, run } = await seedRun(env.store, 'VERIFYING', { workspace: wt, resumeCount: 2 });
    await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RECOVERY_REQUIRED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(events.includes('label_release_error'));
  } finally { env.done(); }
});

test('a parked review run clears agent-reviewing but never the issue label', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready', 'agent-running'], state: 'OPEN', url: 'u' });
    env.tracker.prLabels.set(9, ['agent-reviewing']);
    const { task, run } = await seedRun(env.store, 'REVIEWING', { workspace: env.dir });
    // A review run with no pinned head_sha cannot be resumed.
    env.store.db.prepare("UPDATE runs SET kind = 'review', head_sha = NULL, pr_url = 'https://x/pull/9' WHERE run_id = ?").run(run.run_id);
    await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.deepEqual(env.tracker.prLabels.get(9), []);
    assert.ok(!env.tracker.labelsRemoved.some(([, l]) => l === 'agent-running'));
  } finally { env.done(); }
});

test('a bare-PR task never touches an issue agent-running label', async () => {
  const env = setup();
  try {
    const { task } = env.store.upsertPrTask({ repo: 'me/sandbox', number: 9, title: 't', url: 'https://x/pull/9', branch: 'feature' });
    const run = env.store.claimRun(task.id, { kind: 'review' });
    env.store.transition(run.run_id, 'CLAIMED', 'REVIEWING');
    // Missing head_sha -> parked; a PR-only task must not write issue labels.
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.equal(report.recoveryRequired.length, 1);
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.deepEqual(env.tracker.labelsRemoved, []);
  } finally { env.done(); }
});

test('PUBLISHING_PR with existing PR on a MERGING repair → resume publish, not finalize', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready'], state: 'OPEN', url: 'u' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    const { task, run } = await seedRun(env.store, 'PUBLISHING_PR', { workspace: env.dir });
    env.store.setTaskStatus(task.id, 'MERGING', { approved_sha: 'sha-old', approved_by: 'human' });
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.fakeEngine, findProcs: async () => [],
      isPidAlive: () => false,
    });
    assert.deepEqual(report.resumed, [run.run_id], 'repair must resume publish, not be finalized to review');
    assert.equal(report.finalized.length, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'MERGING', 'repair task stays MERGING');
    assert.equal(env.store.getTaskById(task.id)!.approved_by, 'human');
    assert.equal(env.store.getRun(run.run_id)!.phase, 'PUBLISHING_PR');
  } finally { env.done(); }
});
