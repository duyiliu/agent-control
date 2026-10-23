import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { reconcile } from '../src/scheduler/recovery.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { CoderSession, CoderTurn } from '../src/runners/session.js';
import type { ChecksSummary } from '../src/verify/checks.js';
import type { ProcessSafetyDeps } from '../src/proc.js';
import type { AppConfig, Phase, ReviewResult } from '../src/types.js';
import type { Store } from '../src/store/sqlite.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function fakeWorkspace(): GitWorkspace {
  return {
    ensureWorktree: async (i: { worktreePath: string }) => ({ path: i.worktreePath, created: true }),
    isDirty: async () => false,
    head: async () => 'head-sha',
    commitAll: async () => false,
    aheadCount: async () => 1,
    diffVsBase: async () => 'diff',
    push: async () => {},
    fetchBranch: async () => {},
    resetHard: async () => {},
    addDetachedWorktree: async (_repo: string, _sha: string, p: string) => p,
    removeWorktree: async () => {},
    deleteLocalBranch: async () => {},
    deleteRemoteBranch: async () => {},
  } as unknown as GitWorkspace;
}

function checksOk(): ChecksSummary {
  return { ok: true, outcomes: [{ spec: { argv: ['x'] }, command: 'x', exitCode: 0, timedOut: false, tail: '', logPath: 'l' }], skipped: [], failureEvidence: '' };
}

const reviewPass = async () => ({ result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] } as ReviewResult, logPath: 'r' });

/** Coder sessions whose prompt() hangs until released; tracks concurrency. */
function hangingCoders() {
  const sessions: { entered: Promise<void>; release: () => void; prompts: string[] }[] = [];
  let inside = 0;
  let peak = 0;
  const make = (): CoderSession => {
    let mark!: () => void;
    let rel!: () => void;
    const entered = new Promise<void>((r) => (mark = r));
    const gate = new Promise<void>((r) => (rel = r));
    const s = { entered, release: rel, prompts: [] as string[] };
    sessions.push(s);
    return {
      pid: 42,
      async prompt(text: string): Promise<CoderTurn> {
        s.prompts.push(text);
        inside++;
        peak = Math.max(peak, inside);
        mark();
        await gate;
        inside--;
        return { ok: true, aborted: false, timedOut: false, exitCode: 0, lastMessage: null, durationMs: 1, stderrTail: '' };
      },
      async close() {},
    };
  };
  return { sessions, make, peak: () => peak };
}

/** Wait until session i exists and its prompt turn has been entered. */
async function entered(coders: ReturnType<typeof hangingCoders>, i: number) {
  assert.ok(await waitFor(() => coders.sessions.length > i), `coder session ${i} never started`);
  await coders.sessions[i]!.entered;
}

const ISSUE = { title: 'Fix parser', body: 'Fix the parsing bug.\n\nAC: test passes', labels: ['agent-ready'], state: 'OPEN', url: 'https://x/1' };

interface Env {
  dir: string;
  config: AppConfig;
  tracker: ReturnType<typeof makeFakeTracker>;
  coders: ReturnType<typeof hangingCoders>;
  store: Store;
  engine: Engine;
  done: () => void;
}

function setup(opts: { maxConcurrent?: number; processDeps?: ProcessSafetyDeps } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-'));
  const config = makeConfig(dir);
  config.server.max_concurrent = opts.maxConcurrent ?? 1;
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  const coders = hangingCoders();
  const engine = new Engine({
    store,
    config,
    tracker: tracker as unknown as GitHubTracker,
    workspace: fakeWorkspace(),
    appLog: nullLog,
    installDir: dir,
    openCoderSessionFn: () => coders.make(),
    runChecksFn: async () => checksOk(),
    runReviewFn: reviewPass as never,
    claimArbitrationMs: 0,
    recoveryProcessDeps: opts.processDeps ?? { isPidAlive: () => false, findProcs: async () => [] },
  });
  // Releasing every gate on teardown keeps a failed assertion from stranding
  // a hanging prompt turn (which would wedge the test process).
  const done = () => { for (const s of coders.sessions) s.release(); teardown(dir, [store]); };
  return { dir, config, tracker, coders, store, engine, done };
}

/** A crashed-looking run: active phase, recorded workspace, dead child. */
function seedActiveRun(env: Env, n: number, phase: Phase, opts: { wt?: boolean; pid?: number; identity?: string; resumeCount?: number } = {}) {
  const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: n, issue_title: 't', issue_url: 'u' });
  env.store.setTaskStatus(task.id, 'RUNNING');
  env.tracker.issues.set(n, { ...ISSUE });
  const run = env.store.claimRun(task.id);
  env.store.transition(run.run_id, 'CLAIMED', phase);
  let workspace: string | null = null;
  if (opts.wt !== false) {
    workspace = join(env.dir, `wt-${n}`);
    mkdirSync(workspace, { recursive: true });
  }
  env.store.updateRunFields(run.run_id, {
    workspace,
    branch: `agent/issue-${n}`,
    pid: opts.pid ?? null,
    process_identity: opts.identity ?? null,
    resume_count: opts.resumeCount ?? 0,
  });
  return { task, run: env.store.getRun(run.run_id)! };
}

test('recovery queue: reconcile defers the third crashed run past max_concurrent', async () => {
  const env = setup({ maxConcurrent: 2 });
  try {
    seedActiveRun(env, 1, 'RUNNING');
    seedActiveRun(env, 2, 'RUNNING');
    const r3 = seedActiveRun(env, 3, 'RUNNING').run;

    // Real reconcile path, not a fake engine: the first two launches happen
    // inside reconcile; the third queues for the tick sweep.
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: env.engine,
      isPidAlive: () => false, findProcs: async () => [],
    });
    assert.equal(report.resumed.length, 2);
    assert.deepEqual(report.deferred, [r3.run_id]);

    await entered(env.coders, 0);
    await entered(env.coders, 1);
    assert.equal(env.engine.activeCount(), 2);
    // Queuing never ran Store.resumeRun.
    assert.equal(env.store.getRun(r3.run_id)!.resume_count, 0);
    assert.equal(env.store.getRun(r3.run_id)!.phase, 'RUNNING');
    assert.equal(env.coders.sessions.length, 2);

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 1);
    await env.engine.tick();
    await entered(env.coders, 2);
    assert.equal(env.engine.activeCount(), 2);
    assert.equal(env.store.getRun(r3.run_id)!.resume_count, 1);

    env.coders.sessions[1]!.release();
    env.coders.sessions[2]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    assert.ok(env.coders.peak() <= 2, `peak ${env.coders.peak()} must stay within max_concurrent`);
  } finally { env.done(); }
});

test('recovery queue: a run cancelled while queued finishes via the cancel path, no spawn', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.store.requestCancel(r2.run_id);
    await env.engine.tick();

    assert.equal(env.coders.sessions.length, 1, 'queued run must not spawn');
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'CANCELED');

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
  } finally { env.done(); }
});

test('recovery queue: a run that went terminal while queued is dropped silently', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.store.endRun(r2.run_id, 'FAILED', 'ended while queued');
    await env.engine.tick();

    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'FAILED');
    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 0);

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
  } finally { env.done(); }
});

test('recovery queue: a legacy REVIEWING run keeps its VERIFYING resume target', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'REVIEWING'); // legacy code phase
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id, 'VERIFYING'), false);
    await entered(env.coders, 0);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'REVIEWING');

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    await env.engine.tick();
    await waitFor(() => env.engine.activeCount() === 0);

    const events = env.store.eventsForRun(r2.run_id);
    const recovered = events.find((e) => e.from_phase === 'REVIEWING' && e.to_phase === 'VERIFYING');
    assert.ok(recovered, 'resume must re-enter as VERIFYING, not the dead REVIEWING phase');
    assert.match(recovered!.detail_json ?? '', /recovered/);
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    // VERIFYING needs no coder turn — only the first run's session exists.
    assert.equal(env.coders.sessions.length, 1);
  } finally { env.done(); }
});

test('recovery queue: a run that turns risky while queued parks, never spawns', async () => {
  const env = setup({
    maxConcurrent: 1,
    processDeps: { isPidAlive: () => true, processStartedAt: async () => 1000 },
  });
  try {
    env.tracker.issues.set(2, { ...ISSUE, labels: ['agent-ready', 'agent-running'] });
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'RUNNING', { pid: 777, identity: '777:1000' });
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    // The sweep only dequeues once a slot frees.
    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    await env.engine.tick();

    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'RECOVERY_REQUIRED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    // A possibly-live child keeps the cross-instance claim on ITS issue —
    // run1's own finish path legitimately clears issue 1's label.
    assert.ok(!env.tracker.labelsRemoved.some(([n, l]) => n === 2 && l === 'agent-running'));
  } finally { env.done(); }
});

test('recovery queue: exhausted budget while queued parks and releases the claim', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    env.tracker.issues.set(2, { ...ISSUE, labels: ['agent-ready', 'agent-running'] });
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'RUNNING', { resumeCount: 2 }); // = default max_resumes
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    await env.engine.tick();

    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'RECOVERY_REQUIRED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    // Dead child is proven — the stale claim label is released.
    assert.ok(env.tracker.labelsRemoved.some(([n, l]) => n === 2 && l === 'agent-running'));
  } finally { env.done(); }
});

test('recovery queue: a normal dispatch cannot steal a queued resume slot', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    const { task: t3 } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 3, issue_title: 't', issue_url: 'u' });
    env.tracker.issues.set(3, { ...ISSUE });
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    await env.engine.tick();
    await entered(env.coders, 1);

    // The queued resume claimed the freed slot before dispatch ran.
    assert.equal(env.engine.activeCount(), 1);
    assert.equal(env.store.getTaskById(t3.id)!.status, 'DISCOVERED');
    assert.equal(env.coders.sessions.length, 2);

    env.coders.sessions[1]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
  } finally { env.done(); }
});

test('recovery queue: re-resuming a queued run is a no-op', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    assert.equal(env.engine.resumeRun(r2.run_id), false); // duplicate stays queued
    await entered(env.coders, 0);

    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);
    await env.engine.tick();
    await entered(env.coders, 1);
    env.coders.sessions[1]!.release();
    await waitFor(() => env.engine.activeCount() === 0);

    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 1);
    assert.equal(env.coders.sessions.length, 2);
  } finally { env.done(); }
});

test('recovery queue: a cancel behind a full-capacity waiter is still cleaned up', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    const { task: t3, run: r3 } = seedActiveRun(env, 3, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    assert.equal(env.engine.resumeRun(r3.run_id), false);
    await entered(env.coders, 0);

    env.store.requestCancel(r3.run_id);
    await env.engine.tick();

    // r2 cannot launch (slot held) but must not starve r3's cleanup.
    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r3.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getRun(r3.run_id)!.resume_count, 0);
    assert.equal(env.store.getTaskById(t3.id)!.status, 'CANCELED');
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'RUNNING');
    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 0);
  } finally { env.done(); }
});

test('recovery queue: a cancel arriving mid risk-scan ends via finish, no spawn, no budget', async () => {
  let mark!: () => void;
  let rel!: () => void;
  const enteredScan = new Promise<void>((r) => (mark = r));
  const scanGate = new Promise<void>((r) => (rel = r));
  const env = setup({
    maxConcurrent: 1,
    processDeps: { isPidAlive: () => false, findProcs: async () => { mark(); await scanGate; return []; } },
  });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    // Free the slot so the sweep actually reaches the scan for r2.
    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);

    const tickP = env.engine.tick();
    await enteredScan;
    env.store.requestCancel(r2.run_id);
    rel();
    await tickP;

    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'CANCELED');
  } finally { env.done(); }
});

test('recovery queue: a run ended mid risk-scan is left terminal, no recovery event', async () => {
  let mark!: () => void;
  let rel!: () => void;
  const enteredScan = new Promise<void>((r) => (mark = r));
  const scanGate = new Promise<void>((r) => (rel = r));
  const env = setup({
    maxConcurrent: 1,
    processDeps: { isPidAlive: () => false, findProcs: async () => { mark(); await scanGate; return []; } },
  });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { run: r2 } = seedActiveRun(env, 2, 'RUNNING');
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);
    env.coders.sessions[0]!.release();
    await waitFor(() => env.engine.activeCount() === 0);

    const tickP = env.engine.tick();
    await enteredScan;
    env.store.endRun(r2.run_id, 'FAILED', 'ended out of band');
    const events = env.store.eventsForRun(r2.run_id).length;
    rel();
    await tickP;

    assert.equal(env.store.getRun(r2.run_id)!.phase, 'FAILED');
    assert.equal(env.store.getRun(r2.run_id)!.reason, 'ended out of band');
    assert.equal(env.store.eventsForRun(r2.run_id).length, events); // sweep wrote nothing
    assert.equal(env.coders.sessions.length, 1);
  } finally { env.done(); }
});

test('recovery queue: a cancelled queued run with a live child parks, claim kept', async () => {
  const env = setup({
    maxConcurrent: 1,
    processDeps: { isPidAlive: () => true, processStartedAt: async () => 1000 },
  });
  try {
    env.tracker.issues.set(2, { ...ISSUE, labels: ['agent-ready', 'agent-running'] });
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task, run: r2 } = seedActiveRun(env, 2, 'RUNNING', { pid: 777, identity: '777:1000' });
    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.store.requestCancel(r2.run_id);
    await env.engine.tick(); // cleanup runs even with the slot held

    assert.equal(env.coders.sessions.length, 1);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'RECOVERY_REQUIRED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(!env.tracker.labelsRemoved.some(([n, l]) => n === 2 && l === 'agent-running'));
  } finally { env.done(); }
});

test('recovery queue: a cancelled queued review run ends via cancelTaskPhase, no verdict', async () => {
  const env = setup({ maxConcurrent: 1 });
  try {
    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const { task: t2 } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 2, issue_title: 't', issue_url: 'u' });
    env.tracker.issues.set(2, { ...ISSUE });
    const r2 = env.store.claimRun(t2.id, { kind: 'review', headSha: 'sha-x' });
    env.store.transition(r2.run_id, 'CLAIMED', 'REVIEWING');
    env.store.updateRunFields(r2.run_id, { pr_url: 'https://x/pull/9' });
    env.store.setTaskStatus(t2.id, 'REVIEWING');

    env.engine.resumeRun(r1.run_id);
    assert.equal(env.engine.resumeRun(r2.run_id), false);
    await entered(env.coders, 0);

    env.store.requestCancel(r2.run_id);
    await env.engine.tick();

    assert.equal(env.store.getRun(r2.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getTaskById(t2.id)!.status, 'CANCELED');
    assert.equal(env.store.checksForRun(r2.run_id).filter((c) => c.kind === 'review').length, 0);
    assert.equal(env.store.getRun(r2.run_id)!.resume_count, 0);
  } finally { env.done(); }
});
