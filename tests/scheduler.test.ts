import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { CodexCallResult } from '../src/runners/codex.js';
import type { ChecksSummary } from '../src/verify/checks.js';
import type { AppConfig, ReviewResult } from '../src/types.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';
import type { Store } from '../src/store/sqlite.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace(): GitWorkspace {
  return {
    ensureWorktree: async (i: { worktreePath: string }) => ({ path: i.worktreePath, created: true }),
    isDirty: async () => false,
    aheadCount: async () => 1,
    diffVsBase: async () => 'diff',
    push: async () => {},
  } as unknown as GitWorkspace;
}

function okCoder(): CodexCallResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: 42 };
}

function checksOk(): ChecksSummary {
  return { ok: true, outcomes: [{ spec: { argv: ['x'] }, command: 'x', exitCode: 0, timedOut: false, tail: '', logPath: 'l' }], failureEvidence: '' };
}

function checksFail(): ChecksSummary {
  return {
    ok: false,
    outcomes: [{ spec: { argv: ['x'] }, command: 'x', exitCode: 1, timedOut: false, tail: 'boom', logPath: 'l' }],
    failureEvidence: 'check x failed: boom',
  };
}

type ReviewFn = (ctx: unknown, ev: string, deps: unknown) => Promise<{ result: ReviewResult; logPath: string }>;

const reviewPass: ReviewFn = async () => ({ result: { verdict: 'PASS', summary: 'ok', findings: [] }, logPath: 'r' });
const reviewHuman: ReviewFn = async () => ({ result: { verdict: 'HUMAN_REVIEW_REQUIRED', summary: 'risky', findings: [] }, logPath: 'r' });

interface Env {
  dir: string;
  config: AppConfig;
  tracker: ReturnType<typeof makeFakeTracker>;
  stores: Store[];
  done: () => void;
}

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-sched-'));
  const env: Env = {
    dir,
    config: makeConfig(dir),
    tracker: makeFakeTracker(),
    stores: [],
    done() { teardown(dir, env.stores); },
  };
  return env;
}

function makeEngine(env: Env, over: {
  coder?: () => Promise<CodexCallResult>;
  checks?: () => Promise<ChecksSummary>;
  review?: ReviewFn;
  workspace?: GitWorkspace;
} = {}) {
  const store = makeStore(env.dir);
  env.stores.push(store);
  const engine = new Engine({
    store,
    config: env.config,
    tracker: env.tracker as unknown as GitHubTracker,
    workspace: over.workspace ?? fakeWorkspace(),
    appLog: nullLog,
    installDir: env.dir,
    runCoderFn: over.coder ? async () => over.coder!() : async () => okCoder(),
    runChecksFn: over.checks ? async () => over.checks!() : async () => checksOk(),
    runReviewFn: (over.review ?? reviewPass) as never,
  });
  return { store, engine };
}

async function tickAndDrain(engine: Engine) {
  await engine.tick();
  for (let i = 0; i < 300 && engine.activeCount() > 0; i++) await sleep(20);
}

const ISSUE = { title: 'Fix parser', body: 'Fix the parsing bug.\n\nAC: test passes', labels: ['agent-ready'], state: 'OPEN', url: 'https://x/1' };

test('AC1: happy path produces exactly one draft PR and awaits merge', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 1)!;
    assert.equal(task.status, 'AWAITING_MERGE');
    assert.match(task.pr_url ?? '', /pull\/\d+/);
    assert.equal(env.tracker.prCreated, 1);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 1 && l === 'agent-running'));
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 1 && l === 'agent-pr'));
    const run = store.runsForTask(task.id)[0]!;
    const phases = store.eventsForRun(run.run_id).map((e) => e.to_phase);
    assert.deepEqual(phases, ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'REVIEWING', 'PUBLISHING_PR', 'AWAITING_MERGE']);

    await tickAndDrain(engine);
    assert.equal(store.runsForTask(task.id).length, 1);
    assert.equal(env.tracker.prCreated, 1);
  } finally { env.done(); }
});

test('AC2: no approval label → task cancelled, zero codex calls', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(2, { ...ISSUE, labels: [] });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 2, issue_title: 't', issue_url: 'u' });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 2)!.status, 'CANCELED');
    assert.equal(coderCalls, 0);
  } finally { env.done(); }
});

test('AC2: approval drift after snapshot → BLOCKED_APPROVAL_CHANGED', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(3, { ...ISSUE });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 3, issue_title: 't', issue_url: 'u' });
    store.setApprovedHash(task.id, 'deadbeef'.repeat(8));
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 3)!.status, 'BLOCKED_APPROVAL_CHANGED');
    assert.equal(coderCalls, 0);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 3 && l === 'agent-blocked'));
  } finally { env.done(); }
});

test('AC4: checks fail → bounded fix rounds → BLOCKED at limit', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(4, { ...ISSUE });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, {
      coder: async () => { coderCalls++; return okCoder(); },
      checks: async () => checksFail(),
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 4)!;
    assert.equal(task.status, 'BLOCKED');
    assert.equal(coderCalls, 1 + env.config.server.retry_limit);
    assert.equal(env.tracker.prCreated, 0);
  } finally { env.done(); }
});

test('AC4b: check fails once, fix succeeds → AWAITING_MERGE', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(5, { ...ISSUE });
    let checksN = 0;
    const { store, engine } = makeEngine(env, {
      checks: async () => (++checksN === 1 ? checksFail() : checksOk()),
    });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 5)!.status, 'AWAITING_MERGE');
    assert.equal(checksN, 2);
  } finally { env.done(); }
});

test('AC5: review BLOCK → fix → re-review → PASS', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(6, { ...ISSUE });
    let reviews = 0;
    const review: ReviewFn = async () => {
      reviews++;
      return { result: { verdict: reviews === 1 ? 'BLOCK' : 'PASS', summary: 'r', findings: [] }, logPath: 'l' };
    };
    const { store, engine } = makeEngine(env, { review });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 6)!.status, 'AWAITING_MERGE');
    assert.equal(reviews, 2);
  } finally { env.done(); }
});

test('AC5b: HUMAN_REVIEW_REQUIRED → BLOCKED, no PR', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(7, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: reviewHuman });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 7)!.status, 'BLOCKED');
    assert.equal(env.tracker.prCreated, 0);
  } finally { env.done(); }
});

test('AC8: label revoked mid-run → cancelled before publish', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(8, { ...ISSUE });
    let firstCall = true;
    const { store, engine } = makeEngine(env, {
      coder: async () => {
        if (firstCall) { firstCall = false; env.tracker.issues.get(8)!.labels = []; }
        return okCoder();
      },
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 8)!;
    assert.notEqual(task.status, 'AWAITING_MERGE');
    assert.notEqual(task.status, 'COMPLETED');
    assert.equal(env.tracker.prCreated, 0);
  } finally { env.done(); }
});

test('AC9: coder timeout → FAILED with reason, evidence kept', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(9, { ...ISSUE });
    const { store, engine } = makeEngine(env, {
      coder: async () => ({ ...okCoder(), timedOut: true, exitCode: null }),
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 9)!;
    assert.equal(task.status, 'FAILED');
    const run = store.runsForTask(task.id)[0]!;
    assert.match(run.reason ?? '', /timeout/i);
    assert.ok(store.eventsForRun(run.run_id).length > 0);
  } finally { env.done(); }
});

test('existing PR for branch → AWAITING_MERGE without running', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(10, { ...ISSUE });
    env.tracker.prs.set('agent/issue-10', { number: 55, url: 'https://x/pull/55', state: 'OPEN', isDraft: true });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 10)!;
    assert.equal(task.status, 'AWAITING_MERGE');
    assert.equal(task.pr_url, 'https://x/pull/55');
    assert.equal(coderCalls, 0);
  } finally { env.done(); }
});

test('dependency not complete → stays DISCOVERED', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(11, { ...ISSUE, body: 'x\nDepends-On: #99' });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 11)!.status, 'DISCOVERED');
    assert.equal(coderCalls, 0);
  } finally { env.done(); }
});

test('mergeReconcile: merged PR → COMPLETED', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(12, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 12, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: 'https://x/pull/77' });
    env.tracker.prStates.set(77, 'MERGED');
    await engine.tick();
    assert.equal(store.getTask('me/sandbox', 12)!.status, 'COMPLETED');
  } finally { env.done(); }
});

test('workspace ensureWorktree creates and reuses (real git)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-git-'));
  try {
    const { runProc } = await import('../src/proc.js');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 't@t'],
      ['config', 'user.name', 't'],
    ]) {
      const r = await runProc({ argv: ['git', ...args], cwd: repo, timeoutMs: 15_000 });
      assert.equal(r.exitCode, 0, r.stderrTail);
    }
    writeFileSync(join(repo, 'a.txt'), 'x');
    await runProc({ argv: ['git', 'add', '-A'], cwd: repo, timeoutMs: 15_000 });
    const c = await runProc({ argv: ['git', 'commit', '-m', 'init'], cwd: repo, timeoutMs: 15_000 });
    assert.equal(c.exitCode, 0, c.stderrTail);

    const ws = new GitWorkspace();
    const wt = join(dir, 'wt', 'issue-1');
    const first = await ws.ensureWorktree({ repoDir: repo, branch: 'agent/issue-1', baseBranch: 'main', worktreePath: wt });
    assert.equal(first.created, true);
    const second = await ws.ensureWorktree({ repoDir: repo, branch: 'agent/issue-1', baseBranch: 'main', worktreePath: wt });
    assert.equal(second.created, false);
    assert.equal(await ws.isDirty(wt), false);
    assert.equal(await ws.aheadCount(wt, 'main'), 0);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp residue ok */ }
  }
});
