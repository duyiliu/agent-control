/**
 * Pure state-machine coverage for PR-first review. Nothing here executes a
 * real coder, reviewer, git command or gh call: the workspace is a stub, the
 * reviewer returns canned verdicts, and the coder session throws if it is
 * ever opened. Every assertion is about task/run state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { approveMergeTask, retryTask, stopTask, OpsError } from '../src/ops.js';
import { ReviewInfraError } from '../src/verify/review.js';
import { DiffTooLargeError, GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { AppConfig, ReviewResult } from '../src/types.js';
import type { Store } from '../src/store/sqlite.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPO = 'me/sandbox';

type ReviewFn = () => Promise<{ result: ReviewResult; logPath: string }>;

const pass: ReviewFn = async () => ({
  result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] },
  logPath: 'r',
});

function fakeWorkspace(over: Partial<GitWorkspace> = {}): GitWorkspace {
  return {
    isDirty: async () => false,
    head: async () => 'head-sha',
    diffVsBase: async () => 'diff',
    fetchBranch: async () => {},
    addDetachedWorktree: async (_r: string, _s: string, p: string) => p,
    removeWorktree: async () => {},
    deleteLocalBranch: async () => {},
    deleteRemoteBranch: async () => {},
    ...over,
  } as unknown as GitWorkspace;
}

interface Ctx {
  dir: string;
  config: AppConfig;
  tracker: ReturnType<typeof makeFakeTracker>;
  store: Store;
  engine: Engine;
  done: () => void;
}

function boot(over: { review?: ReviewFn; workspace?: GitWorkspace } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'ac-prstate-'));
  const config = makeConfig(dir);
  config.projects[0]!.pr_review = 'auto';
  const tracker = makeFakeTracker();
  const store = makeStore(dir);
  const engine = new Engine({
    store,
    config,
    tracker: tracker as unknown as GitHubTracker,
    workspace: over.workspace ?? fakeWorkspace(),
    appLog: nullLog,
    installDir: dir,
    openCoderSessionFn: () => ({
      pid: 1,
      prompt: async () => { throw new Error('a bare PR must never reach the coder'); },
      close: async () => {},
    }),
    runChecksFn: async () => { throw new Error('a bare PR has no checks'); },
    runReviewFn: (over.review ?? pass) as never,
    claimArbitrationMs: 0,
  });
  return {
    dir, config, tracker, store, engine,
    done: () => teardown(dir, [store]),
  };
}

async function tick(engine: Engine) {
  await engine.tick();
  for (let i = 0; i < 300 && engine.activeCount() > 0; i++) await sleep(20);
}

function pr(over: Record<string, unknown> = {}) {
  const number = (over.number as number | undefined) ?? 11;
  return {
    number,
    title: 'external',
    url: `https://github.com/${REPO}/pull/${number}`,
    isDraft: false,
    headRefName: 'feature/x',
    baseRefName: 'main',
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    labels: [] as string[],
    isCrossRepository: false,
    ...over,
  };
}

/** Register a bare PR task directly — bypasses discovery on purpose. */
function seed(ctx: Ctx, number = 11) {
  return ctx.store.upsertPrTask({
    repo: REPO,
    number,
    title: 'external',
    url: `https://github.com/${REPO}/pull/${number}`,
    branch: 'feature/x',
  }).task;
}

function verdicts(ctx: Ctx, taskId: number): string[] {
  return ctx.store
    .runsForTask(taskId)
    .flatMap((r) => ctx.store.checksForRun(r.run_id))
    .filter((c) => c.kind === 'review')
    .map((c) => c.verdict);
}

function codeRuns(ctx: Ctx, taskId: number): number {
  return ctx.store.runsForTask(taskId).filter((r) => r.kind === 'code').length;
}

// ---------------------------------------------------------------- discovery

test('S1 new PR registers as AWAITING_REVIEW before any run exists', async () => {
  const ctx = boot();
  try {
    ctx.tracker.openPrs = [pr()];
    await tick(ctx.engine); // seeds pr_review_since
    const task = ctx.store.getTask(REPO, 11);
    assert.equal(task, null);

    // Discovery and the review dispatch share a tick, so assert the state the
    // registration produces by draining without a reviewer.
    ctx.tracker.openPrs = [pr({ number: 12 })];
    await ctx.engine.tick();
    const registered = ctx.store.getTask(REPO, 12)!;
    assert.equal(registered.source, 'pr');
    assert.equal(registered.branch, 'feature/x');
    assert.equal(registered.pr_url, `https://github.com/${REPO}/pull/12`);
    for (let i = 0; i < 300 && ctx.engine.activeCount() > 0; i++) await sleep(20);
  } finally { ctx.done(); }
});

test('S2 draft is skipped until it becomes ready for review', async () => {
  const ctx = boot();
  try {
    ctx.tracker.openPrs = [pr({ number: 21, isDraft: true })];
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 21), null);

    ctx.tracker.openPrs = [pr({ number: 21, isDraft: false })];
    await tick(ctx.engine);
    assert.ok(ctx.store.getTask(REPO, 21));
  } finally { ctx.done(); }
});

test('S3 PRs opened before the anchor stay untouched', async () => {
  const ctx = boot();
  try {
    ctx.tracker.openPrs = [pr({ number: 31, createdAt: new Date(Date.now() - 86_400_000).toISOString() })];
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 31), null);
  } finally { ctx.done(); }
});

test('S4 agent-review summons a pre-anchor PR and is consumed once', async () => {
  const ctx = boot();
  try {
    ctx.tracker.openPrs = [pr({ number: 41, createdAt: new Date(Date.now() - 86_400_000).toISOString(), labels: ['agent-review'] })];
    await tick(ctx.engine); // anchor
    await tick(ctx.engine); // summoned PR is still eligible
    assert.ok(ctx.store.getTask(REPO, 41));
    assert.ok(!(ctx.tracker.prLabels.get(41) ?? []).includes('agent-review'));
  } finally { ctx.done(); }
});

test('S5 pr_review: manual never scans PRs', async () => {
  const ctx = boot();
  try {
    ctx.config.projects[0]!.pr_review = 'manual';
    ctx.tracker.openPrs = [pr({ number: 51 })];
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 51), null);
  } finally { ctx.done(); }
});

test('S6 an existing task is never overwritten by rediscovery', async () => {
  const ctx = boot();
  try {
    const seeded = seed(ctx, 61);
    ctx.store.setTaskStatus(seeded.id, 'AWAITING_HUMAN');
    ctx.tracker.openPrs = [pr({ number: 61 })];
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 61)!.status, 'AWAITING_HUMAN');
  } finally { ctx.done(); }
});

// ---------------------------------------------------------------- execution

test('S7 AWAITING_REVIEW -> REVIEWING -> AWAITING_HUMAN on PASS', async () => {
  const ctx = boot({
    review: async () => {
      const t = ctx.store.getTask(REPO, 71)!;
      assert.equal(t.status, 'REVIEWING');
      const run = ctx.store.activeRunForTask(t.id)!;
      assert.equal(run.kind, 'review');
      return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' };
    },
  });
  try {
    const task = seed(ctx, 71);
    assert.equal(task.status, 'AWAITING_REVIEW');
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 71)!.status, 'AWAITING_HUMAN');
    assert.deepEqual(verdicts(ctx, task.id), ['PASS']);
    assert.equal(ctx.store.runsForTask(task.id)[0]!.phase, 'COMPLETED');
  } finally { ctx.done(); }
});

test('S8 a head sha with a verdict is never reviewed twice', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 81);
    await tick(ctx.engine);
    const runs = ctx.store.runsForTask(task.id).length;
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.runsForTask(task.id).length, runs);
  } finally { ctx.done(); }
});

// ---------------------------------------------------------------- verdicts

test('S9 BLOCK parks as BLOCKED and labels the PR', async () => {
  const ctx = boot({
    review: async () => ({ result: { verdict: 'BLOCK', risk: 'low', summary: 's', findings: ['bug'] }, logPath: 'r' }),
  });
  try {
    seed(ctx, 91);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 91)!.status, 'BLOCKED');
    assert.ok(ctx.tracker.labelsAdded.some(([n, l]) => n === 91 && l === 'agent-blocked'));
    assert.equal(ctx.store.activeRunForTask(ctx.store.getTask(REPO, 91)!.id), null);
  } finally { ctx.done(); }
});

test('S10 HUMAN_REVIEW_REQUIRED parks as AWAITING_HUMAN', async () => {
  const ctx = boot({
    review: async () => ({ result: { verdict: 'HUMAN_REVIEW_REQUIRED', risk: 'high', summary: 's', findings: [] }, logPath: 'r' }),
  });
  try {
    seed(ctx, 101);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 101)!.status, 'AWAITING_HUMAN');
  } finally { ctx.done(); }
});

test('S11 reviewer infrastructure failure records ERROR and parks for a human', async () => {
  const ctx = boot({ review: async () => { throw new ReviewInfraError('pi died'); } });
  try {
    const task = seed(ctx, 111);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 111)!.status, 'AWAITING_HUMAN');
    assert.deepEqual(verdicts(ctx, task.id), ['ERROR']);
  } finally { ctx.done(); }
});

test('S12 an oversized diff parks for a human without a verdict', async () => {
  const ctx = boot({
    workspace: fakeWorkspace({ diffVsBase: async () => { throw new DiffTooLargeError('too big'); } }),
  });
  try {
    const task = seed(ctx, 121);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 121)!.status, 'AWAITING_HUMAN');
    assert.deepEqual(verdicts(ctx, task.id), ['HUMAN_REVIEW_REQUIRED']);
  } finally { ctx.done(); }
});

// ------------------------------------------------------- external movements

test('S13 a head that moves between dispatch and pre-flight abandons the round', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 131);
    // 1st getPrDetails = dispatch claim, 2nd = pre-flight.
    ctx.tracker.headShaSequence = ['sha-a', 'sha-b'];
    await tick(ctx.engine);

    assert.equal(ctx.store.getTask(REPO, 131)!.status, 'AWAITING_REVIEW');
    assert.deepEqual(verdicts(ctx, task.id), []);
    assert.equal(ctx.store.runsForTask(task.id)[0]!.phase, 'CANCELED');
  } finally { ctx.done(); }
});

test('S14 a PR closed before review parks as BLOCKED', async () => {
  const ctx = boot();
  try {
    seed(ctx, 141);
    ctx.tracker.prStates.set(141, 'CLOSED');
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 141)!.status, 'BLOCKED');
    assert.equal(ctx.store.runsForTask(ctx.store.getTask(REPO, 141)!.id).length, 0);
  } finally { ctx.done(); }
});

test('S15 a PR merged elsewhere completes the task', async () => {
  const ctx = boot();
  try {
    seed(ctx, 151);
    ctx.tracker.prStates.set(151, 'MERGED');
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 151)!.status, 'COMPLETED');
  } finally { ctx.done(); }
});

// ---------------------------------------------------------------- human ops

test('S16 stop on AWAITING_REVIEW is terminal and survives the next tick', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 161);
    const msg = stopTask(ctx.store, task);
    assert.match(msg, /停止自动评审/);
    assert.equal(ctx.store.getTask(REPO, 161)!.status, 'CANCELED');
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 161)!.status, 'CANCELED');
    assert.equal(ctx.store.runsForTask(task.id).length, 0);
  } finally { ctx.done(); }
});

test('S17 retry from BLOCKED drops the verdict and re-reviews the same head', async () => {
  let v: ReviewResult['verdict'] = 'BLOCK';
  const ctx = boot({
    review: async () => ({ result: { verdict: v, risk: 'low', summary: 's', findings: ['bug'] }, logPath: 'r' }),
  });
  try {
    const task = seed(ctx, 171);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 171)!.status, 'BLOCKED');

    v = 'PASS';
    await retryTask(ctx.store, ctx.config, ctx.tracker as never, task);
    assert.equal(ctx.store.getTask(REPO, 171)!.status, 'AWAITING_REVIEW');
    assert.deepEqual(verdicts(ctx, task.id), []);

    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 171)!.status, 'AWAITING_HUMAN');
    assert.deepEqual(verdicts(ctx, task.id), ['PASS']);
  } finally { ctx.done(); }
});

test('S18 retry from AWAITING_HUMAN recovers an ERROR round', async () => {
  const ctx = boot({ review: async () => { throw new ReviewInfraError('pi died'); } });
  try {
    const task = seed(ctx, 181);
    await tick(ctx.engine);
    assert.deepEqual(verdicts(ctx, task.id), ['ERROR']);

    await retryTask(ctx.store, ctx.config, ctx.tracker as never, task);
    assert.equal(ctx.store.getTask(REPO, 181)!.status, 'AWAITING_REVIEW');
    await tick(ctx.engine);
    assert.equal(ctx.store.runsForTask(task.id).length, 2);
  } finally { ctx.done(); }
});

test('S19 retry refuses while a review run is in flight', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 191);
    const run = ctx.store.claimRun(task.id, { kind: 'review', headSha: 'head-sha' });
    await assert.rejects(
      () => retryTask(ctx.store, ctx.config, ctx.tracker as never, task),
      (err: Error) => err instanceof OpsError && /活动/.test(err.message),
    );
    ctx.store.endRun(run.run_id, 'CANCELED');
  } finally { ctx.done(); }
});

test('S20 agent-merge on a bare PR is inert', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 201);
    await tick(ctx.engine);
    assert.equal(ctx.store.getTask(REPO, 201)!.status, 'AWAITING_HUMAN');

    ctx.tracker.prLabels.set(201, ['agent-merge']);
    await tick(ctx.engine);
    const after = ctx.store.getTask(REPO, 201)!;
    assert.equal(after.status, 'AWAITING_HUMAN');
    assert.equal(after.approved_by, null);
    assert.equal(ctx.tracker.merged.length, 0);
    assert.equal(ctx.tracker.prCreated, 0);
  } finally { ctx.done(); }
});

test('S21 approve-merge action rejects a bare PR', async () => {
  const ctx = boot();
  try {
    const task = seed(ctx, 211);
    await tick(ctx.engine);
    await assert.rejects(
      () => approveMergeTask(ctx.store, ctx.tracker as never, ctx.store.getTask(REPO, 211)!),
      (err: Error) => err instanceof OpsError && /人工合并/.test(err.message),
    );
    assert.ok(task);
  } finally { ctx.done(); }
});

// ---------------------------------------------------------------- invariants

test('S22 a bare PR never produces a code run, a published PR or a merge', async () => {
  const ctx = boot({
    review: async () => ({ result: { verdict: 'BLOCK', risk: 'low', summary: 's', findings: ['bug'] }, logPath: 'r' }),
  });
  try {
    const task = seed(ctx, 221);
    await tick(ctx.engine);
    await tick(ctx.engine);
    assert.equal(codeRuns(ctx, task.id), 0);
    assert.equal(ctx.tracker.prCreated, 0);
    assert.equal(ctx.tracker.merged.length, 0);
    const runs = ctx.store.runsForTask(task.id);
    assert.deepEqual(runs.map((r) => r.kind), ['review']);
  } finally { ctx.done(); }
});
