import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { retryTask } from '../src/ops.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { AppConfig, ReviewResult } from '../src/types.js';
import type { Store } from '../src/store/sqlite.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace(): GitWorkspace {
  return {
    isDirty: async () => false,
    head: async () => 'head-sha',
    refSha: async (_repo: string, ref: string) => ref,
    diffVsBase: async () => 'diff',
    fetchBranch: async () => {},
    addDetachedWorktree: async (_repo: string, _sha: string, p: string) => p,
    removeWorktree: async () => {},
    deleteLocalBranch: async () => {},
    deleteRemoteBranch: async () => {},
  } as unknown as GitWorkspace;
}

interface Env {
  dir: string;
  config: AppConfig;
  tracker: ReturnType<typeof makeFakeTracker>;
  stores: Store[];
  done: () => void;
}

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-prreview-'));
  const env: Env = {
    dir,
    config: makeConfig(dir),
    tracker: makeFakeTracker(),
    stores: [],
    done() { teardown(dir, env.stores); },
  };
  env.config.projects[0]!.pr_review = 'auto';
  return env;
}

function makeEngine(env: Env, review?: () => Promise<{ result: ReviewResult; logPath: string }>) {
  const store = makeStore(env.dir);
  env.stores.push(store);
  const engine = new Engine({
    store,
    config: env.config,
    tracker: env.tracker as unknown as GitHubTracker,
    workspace: fakeWorkspace(),
    appLog: nullLog,
    installDir: env.dir,
    openCoderSessionFn: () => ({ pid: 1, prompt: async () => { throw new Error('a bare PR must never reach the coder'); }, close: async () => {} }),
    runChecksFn: async () => { throw new Error('a bare PR has no checks'); },
    runReviewFn: (review ?? (async () => ({
      result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] },
      logPath: 'r',
    }))) as never,
    claimArbitrationMs: 0,
  });
  return { store, engine };
}

async function tickAndDrain(engine: Engine) {
  await engine.tick();
  for (let i = 0; i < 300 && engine.activeCount() > 0; i++) await sleep(20);
}

function openPr(over: Partial<ReturnType<typeof basePr>> = {}) {
  return { ...basePr(), ...over };
}

function basePr() {
  return {
    number: 11,
    title: 'External contribution',
    url: 'https://github.com/me/sandbox/pull/11',
    isDraft: false,
    headRefName: 'feature/external',
    baseRefName: 'main',
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    labels: [] as string[],
    isCrossRepository: false,
  };
}

test('PR discovery: first tick only writes the anchor, so a backlog is not queued', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr({ createdAt: new Date(Date.now() - 86_400_000).toISOString() })];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 11), null);
    assert.ok(store.getMeta('pr_review_since:me/sandbox'));
  } finally { env.done(); }
});

test('v2 PR discovery pins new advisory tasks without enabling checks or coding', async () => {
  const env = setup(); try {
    env.config.review_policy = { version: 2 };
    env.tracker.openPrs = [openPr()];
    const { store, engine } = makeEngine(env, async () => ({ result: { verdict: 'PASS', risk: 'low', summary: 'reviewed', findings: [],
      assessment: { protocol_version: 2, summary: 'reviewed', findings: [], verification_requests: [], decision_requests: [], compatibility: { kind: 'unchanged', evidence: ['callers inspected'] } } }, logPath: 'r' }));
    await tickAndDrain(engine); await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 11)!;
    assert.equal(store.getReviewControl(task.id)?.policy_version, 2);
    assert.equal(store.getReviewControl(task.id)?.rounds, 1);
    assert.equal(task.status, 'AWAITING_HUMAN'); assert.deepEqual(env.tracker.merged, []);
  } finally { env.done(); }
});

test('PR discovery: a new non-draft PR is reviewed and parked for a human', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr()];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // anchor
    await tickAndDrain(engine); // register + review

    const task = store.getTask('me/sandbox', 11)!;
    assert.equal(task.source, 'pr');
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(task.branch, 'feature/external');
    assert.equal(task.pr_url, 'https://github.com/me/sandbox/pull/11');
    assert.equal(env.tracker.prCreated, 0);
    assert.equal(store.runsForTask(task.id).filter((r) => r.kind === 'review').length, 1);
    assert.ok(env.tracker.prComments.some(([n, body]) => n === 11 && /自动评审/.test(body)));
  } finally { env.done(); }
});

test('PR discovery skips drafts, forks, agent branches and other base branches', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [
      openPr({ number: 21, isDraft: true }),
      openPr({ number: 22, isCrossRepository: true }),
      openPr({ number: 23, headRefName: 'agent/issue-23' }),
      openPr({ number: 24, baseRefName: 'release' }),
      openPr({ number: 25, createdAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    for (const n of [21, 22, 23, 24, 25]) assert.equal(store.getTask('me/sandbox', n), null, `PR ${n} must be skipped`);
  } finally { env.done(); }
});

test('PR discovery: the agent-review label summons an older PR and is consumed', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr({
      number: 31,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      labels: ['agent-review'],
    })];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // anchor
    await tickAndDrain(engine); // summoned PR is still eligible

    assert.ok(store.getTask('me/sandbox', 31));
    assert.ok(!(env.tracker.prLabels.get(31) ?? []).includes('agent-review'));
  } finally { env.done(); }
});

test('a bare PR keeps one review per head sha', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr({ number: 41 })];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 41)!;
    const before = store.runsForTask(task.id).length;

    await tickAndDrain(engine);
    assert.equal(store.runsForTask(task.id).length, before);
  } finally { env.done(); }
});

test('a bare PR BLOCK parks as BLOCKED, never spawns a fix run or a merge', async () => {
  const env = setup();
  try {
    env.config.approvals.auto_merge.enabled = true;
    env.tracker.openPrs = [openPr({ number: 51 })];
    const { store, engine } = makeEngine(env, async () => ({
      result: { verdict: 'BLOCK', risk: 'low', summary: 'broken', findings: ['bug'] },
      logPath: 'r',
    }));
    await tickAndDrain(engine);
    await tickAndDrain(engine);

    const task = store.getTask('me/sandbox', 51)!;
    assert.equal(task.status, 'BLOCKED');
    assert.equal(task.pending_fix, null);
    assert.equal(store.runsForTask(task.id).filter((r) => r.kind === 'code').length, 0);
    assert.equal(env.tracker.merged.length, 0);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 51 && l === 'agent-blocked'));
  } finally { env.done(); }
});

test('retry on a bare PR drops the verdict and re-reviews the same head', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr({ number: 71 })];
    let verdict: ReviewResult['verdict'] = 'BLOCK';
    const { store, engine } = makeEngine(env, async () => ({
      result: { verdict, risk: 'low', summary: 's', findings: ['bug'] },
      logPath: 'r',
    }));
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 71)!;
    assert.equal(task.status, 'BLOCKED');
    assert.equal(store.runsForTask(task.id).length, 1);

    verdict = 'PASS';
    const msg = await retryTask(store, env.config, env.tracker as never, task);
    assert.match(msg, /重新排队评审/);
    assert.equal(store.getTask('me/sandbox', 71)!.status, 'AWAITING_REVIEW');

    await tickAndDrain(engine);
    assert.equal(store.runsForTask(task.id).length, 2);
    assert.equal(store.getTask('me/sandbox', 71)!.status, 'AWAITING_HUMAN');
  } finally { env.done(); }
});

test('agent-merge on a bare PR is ignored — the host never lands it', async () => {
  const env = setup();
  try {
    env.tracker.openPrs = [openPr({ number: 61 })];
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 61)!;
    assert.equal(task.status, 'AWAITING_HUMAN');

    env.tracker.prLabels.set(61, ['agent-merge']);
    await tickAndDrain(engine);
    const after = store.getTask('me/sandbox', 61)!;
    assert.equal(after.status, 'AWAITING_HUMAN');
    assert.equal(after.approved_by, null);
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});
