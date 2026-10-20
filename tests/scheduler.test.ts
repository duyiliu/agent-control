import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { AgentCallResult } from '../src/runners/types.js';
import type { CoderSession, CoderTurn } from '../src/runners/session.js';
import { runChecks, type ChecksSummary } from '../src/verify/checks.js';
import type { AppConfig, ReviewResult } from '../src/types.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';
import type { Store } from '../src/store/sqlite.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace(calls?: string[]): GitWorkspace {
  return {
    ensureWorktree: async (i: { worktreePath: string }) => ({ path: i.worktreePath, created: true }),
    isDirty: async () => false,
    head: async () => 'head-sha',
    commitAll: async () => false,
    aheadCount: async () => 1,
    diffVsBase: async () => 'diff',
    push: async () => {},
    removeWorktree: async (_repo: string, p: string) => { calls?.push(`rm-wt:${p}`); },
    deleteLocalBranch: async (_repo: string, b: string) => { calls?.push(`del-local:${b}`); },
    deleteRemoteBranch: async (_repo: string, b: string) => { calls?.push(`del-remote:${b}`); },
  } as unknown as GitWorkspace;
}

function okCoder(): AgentCallResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: 42 };
}

/** Fake session: one turn per call, driven by the same canned AgentCallResult. */
function fakeCoderSession(get: () => Promise<AgentCallResult>): CoderSession {
  return {
    pid: 42,
    async prompt(): Promise<CoderTurn> {
      const r = await get();
      const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
      return {
        ok, aborted: r.aborted, timedOut: r.timedOut, exitCode: r.exitCode,
        lastMessage: null, durationMs: r.durationMs, stderrTail: r.stderrTail,
        ...(ok ? {} : { error: `exit ${r.exitCode}` }),
      };
    },
    async close() {},
  };
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

const reviewPass: ReviewFn = async () => ({ result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' });
const reviewHuman: ReviewFn = async () => ({ result: { verdict: 'HUMAN_REVIEW_REQUIRED', risk: 'high', summary: 'risky', findings: [] }, logPath: 'r' });

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
  coder?: () => Promise<AgentCallResult>;
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
    openCoderSessionFn: () => fakeCoderSession(over.coder ?? (async () => okCoder())),
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
    const phases = store.eventsForRun(run.run_id).filter((e) => e.from_phase !== e.to_phase).map((e) => e.to_phase);
    assert.deepEqual(phases, ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING_PR', 'REVIEWING', 'AWAITING_MERGE']);

    await tickAndDrain(engine);
    assert.equal(store.runsForTask(task.id).length, 1);
    assert.equal(env.tracker.prCreated, 1);
  } finally { env.done(); }
});

test('FIXING continues the coder session opened by RUNNING', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(30, { ...ISSUE });
    const store = makeStore(env.dir);
    env.stores.push(store);
    let opens = 0;
    let checks = 0;
    const prompts: string[] = [];
    const engine = new Engine({
      store,
      config: env.config,
      tracker: env.tracker as unknown as GitHubTracker,
      workspace: fakeWorkspace(),
      appLog: nullLog,
      installDir: env.dir,
      openCoderSessionFn: () => {
        opens++;
        return {
          pid: 7,
          async prompt(text: string): Promise<CoderTurn> {
            prompts.push(text);
            return { ok: true, aborted: false, timedOut: false, exitCode: 0, lastMessage: 'ok', durationMs: 1, stderrTail: '' };
          },
          async close() {},
        };
      },
      runChecksFn: async () => (++checks === 1 ? checksFail() : checksOk()),
      runReviewFn: reviewPass as never,
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 30)!;
    assert.equal(task.status, 'AWAITING_MERGE');
    assert.equal(opens, 1); // one process for the whole run, not one per phase
    assert.equal(prompts.length, 2); // RUNNING + FIXING
    assert.match(prompts[1]!, /check x failed/); // the fix turn carries the evidence
    const run = store.runsForTask(task.id)[0]!;
    assert.equal(store.checksForRun(run.run_id).filter((c) => c.kind === 'agent').length, 2);
  } finally { env.done(); }
});

test('AC2: no approval label → task cancelled, zero agent calls', async () => {
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

test('agent-running label → claimed elsewhere, stays DISCOVERED', async () => {
  const env = setup();
  try {
    // Discovered before the claim; agent-running lands between polls.
    env.tracker.issues.set(16, { ...ISSUE, labels: ['agent-ready', 'agent-running'] });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 16, issue_title: 't', issue_url: 'u' });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 16)!.status, 'DISCOVERED');
    assert.equal(coderCalls, 0);
    assert.equal(env.tracker.prCreated, 0);
    assert.ok(!env.tracker.labelsAdded.some(([n, l]) => n === 16 && l === 'agent-running'));
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
    let checks = 0;
    const review: ReviewFn = async () => {
      reviews++;
      return { result: { verdict: reviews === 1 ? 'BLOCK' : 'PASS', risk: 'low', summary: 'r', findings: reviews === 1 ? ['parser.ts: empty input crashes; validate with an empty-input test'] : [] }, logPath: 'l' };
    };
    const { store, engine } = makeEngine(env, { review, checks: async () => { checks++; return checksOk(); } });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 6)!;
    assert.equal(task.status, 'AWAITING_MERGE');
    assert.equal(reviews, 2);
    assert.equal(checks, 2, 'review-driven fixes must rerun checks');
    const phases = store.eventsForRun(store.runsForTask(task.id)[0]!.run_id)
      .filter((e) => e.from_phase !== e.to_phase).map((e) => e.to_phase);
    assert.deepEqual(phases.slice(4), ['PUBLISHING_PR', 'REVIEWING', 'FIXING', 'VERIFYING', 'PUBLISHING_PR', 'REVIEWING', 'AWAITING_MERGE']);
  } finally { env.done(); }
});

test('review BLOCK without findings stops without a blind repair', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(17, { ...ISSUE });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, {
      coder: async () => { coderCalls++; return okCoder(); },
      review: async () => ({ result: { verdict: 'BLOCK', risk: 'low', summary: 'unclear concern', findings: [] }, logPath: 'r' }),
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 17)!;
    assert.equal(task.status, 'BLOCKED');
    assert.equal(coderCalls, 1);
    assert.equal(store.runsForTask(task.id)[0]!.fix_count, 0);
  } finally { env.done(); }
});

test('review infrastructure failure does not consume fix budget', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(18, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: async () => { throw new Error('review output unavailable'); } });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 18)!;
    assert.equal(task.status, 'FAILED');
    assert.equal(store.runsForTask(task.id)[0]!.fix_count, 0);
    assert.equal(env.tracker.prCreated, 1);
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('AC5b: HUMAN_REVIEW_REQUIRED → BLOCKED, PR stays draft', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(7, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: reviewHuman });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 7)!.status, 'BLOCKED');
    assert.equal(env.tracker.prCreated, 1);
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('review evidence carries the check log tail, not just the verdict', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(41, { ...ISSUE });
    const logFile = join(env.dir, 'check.log');
    writeFileSync(logFile, 'start\nPASS src/a.test.ts\n3 passed, 0 failed\n');
    const seen: string[] = [];
    const { store, engine } = makeEngine(env, {
      checks: async () => ({
        ...checksOk(),
        outcomes: [{ spec: { argv: ['x'] }, command: 'npm test', exitCode: 0, timedOut: false, tail: '', logPath: logFile }],
      }),
      review: (async (_ctx, ev: string) => {
        seen.push(ev);
        return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] } as ReviewResult, logPath: 'r' };
      }) as ReviewFn,
    });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 41)!.status, 'AWAITING_MERGE');
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /3 passed, 0 failed/); // raw output, not just "PASS (exit 0)"
  } finally { env.done(); }
});

test('review tamper: HEAD moved during review → BLOCKED, no merge', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(15, { ...ISSUE });
    let headCalls = 0;
    const ws = {
      ...fakeWorkspace(),
      head: async () => (headCalls++ < 3 ? 'sha-a' : 'sha-b'),
    } as unknown as GitWorkspace;
    const { store, engine } = makeEngine(env, { workspace: ws });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 15)!;
    assert.equal(task.status, 'BLOCKED');
    assert.match(store.runsForTask(task.id)[0]!.reason ?? '', /changed after review|HEAD moved/);
    assert.equal(env.tracker.merged.length, 0);
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

test('mergeReconcile: merged PR → COMPLETED + worktree/branch cleanup', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(12, { ...ISSUE });
    const calls: string[] = [];
    const { store, engine } = makeEngine(env, { workspace: fakeWorkspace(calls) });
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 12, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: 'https://x/pull/77', branch: 'agent/issue-12' });
    env.tracker.prStates.set(77, 'MERGED');
    await engine.tick();
    assert.equal(store.getTask('me/sandbox', 12)!.status, 'COMPLETED');
    assert.ok(calls.some((c) => c.startsWith('rm-wt:')), `worktree cleanup ran: ${calls}`);
    assert.ok(calls.includes('del-local:agent/issue-12'), `local branch deleted: ${calls}`);
    assert.ok(calls.includes('del-remote:agent/issue-12'), `remote branch deleted: ${calls}`);
  } finally { env.done(); }
});

test('mergeReconcile: cleanup failure never un-completes a task', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(13, { ...ISSUE });
    const ws = {
      ...fakeWorkspace(),
      removeWorktree: async () => { throw new Error('wt locked'); },
      deleteLocalBranch: async () => { throw new Error('branch busy'); },
      deleteRemoteBranch: async () => { throw new Error('network'); },
    } as unknown as GitWorkspace;
    const { store, engine } = makeEngine(env, { workspace: ws });
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 13, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: 'https://x/pull/78', branch: 'agent/issue-13' });
    env.tracker.prStates.set(78, 'MERGED');
    await engine.tick();
    assert.equal(store.getTask('me/sandbox', 13)!.status, 'COMPLETED');
    assert.match(store.getMeta('last_error') ?? '', /cleanup_error/);
  } finally { env.done(); }
});

test('attention state posts an issue comment with check summary', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(14, { ...ISSUE });
    const { store, engine } = makeEngine(env, { checks: async () => checksFail() });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 14)!.status, 'BLOCKED');
    const c = env.tracker.comments.find(([n, body]) => n === 14 && /BLOCKED/.test(body));
    assert.ok(c, 'attention comment posted');
    assert.match(c[1], /检查结果/, 'check summary included');
    assert.match(c[1], /FAIL/);
  } finally { env.done(); }
});

test('mergeReconcile posts a completion summary comment', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(15, { ...ISSUE });
    const { store, engine } = makeEngine(env, { workspace: fakeWorkspace() });
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 15, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_MERGE', { pr_url: 'https://x/pull/79', branch: 'agent/issue-15' });
    env.tracker.prStates.set(79, 'MERGED');
    await engine.tick();
    assert.equal(store.getTask('me/sandbox', 15)!.status, 'COMPLETED');
    const c = env.tracker.comments.find(([n, body]) => n === 15 && /任务完成/.test(body));
    assert.ok(c, 'completion summary posted');
    assert.match(c[1], /https:\/\/x\/pull\/79/);
    assert.match(c[1], /attempt/);
  } finally { env.done(); }
});

test('overlapping ticks never overlap discovery or dispatch', async () => {
  const env = setup();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    let calls = 0;
    env.tracker.listReadyIssues = async () => { calls++; entered(); await gate; return []; };
    const { engine } = makeEngine(env);
    const first = engine.tick(); await waiting;
    await engine.tick();
    assert.equal(calls, 1);
    release(); await first;
  } finally { release?.(); env.done(); }
});

test('stop during checks aborts their process before network polling completes', async () => {
  const env = setup();
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  try {
    env.tracker.issues.set(19, { ...ISSUE });
    env.config.projects[0]!.checks = [{ argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeout_seconds: 60 }];
    const store = makeStore(env.dir); env.stores.push(store);
    const engine = new Engine({ store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      workspace: fakeWorkspace(), appLog: nullLog, installDir: env.dir,
      openCoderSessionFn: () => fakeCoderSession(async () => okCoder()),
      runReviewFn: reviewPass as never,
      runChecksFn: (...args) => runChecks(args[0], args[1], args[2], args[3], args[4], (pid) => { args[5]?.(pid); started(); }) });
    await engine.tick(); await checking;
    const task = store.getTask('me/sandbox', 19)!; const run = store.activeRunForTask(task.id)!;
    store.requestCancel(run.run_id);
    engine.sweepCancels();
    for (let i = 0; i < 150 && engine.activeCount(); i++) await sleep(20);
    assert.equal(engine.activeCount(), 0);
    assert.equal(store.getTaskById(task.id)!.status, 'CANCELED');
    assert.equal(store.getRun(run.run_id)!.fix_count, 0);
  } finally { env.done(); }
});

test('checks infrastructure failure never triggers a code repair', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(20, { ...ISSUE });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, {
      coder: async () => { coderCalls++; return okCoder(); },
      checks: async () => ({ ...checksFail(), infraError: 'executable missing' }),
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 20)!;
    assert.equal(task.status, 'FAILED');
    assert.equal(coderCalls, 1);
    assert.equal(store.runsForTask(task.id)[0]!.fix_count, 0);
  } finally { env.done(); }
});

test('approval drift before repair stops without another coder call', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(21, { ...ISSUE });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, {
      coder: async () => { coderCalls++; return okCoder(); },
      checks: async () => { env.tracker.issues.get(21)!.body = 'changed requirements'; return checksFail(); },
    });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 21)!.status, 'BLOCKED_APPROVAL_CHANGED');
    assert.equal(coderCalls, 1);
  } finally { env.done(); }
});

test('review tampering is blocked even when reviewer throws', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(22, { ...ISSUE });
    let dirty = false;
    const { store, engine } = makeEngine(env, {
      workspace: { ...fakeWorkspace(), isDirty: async () => dirty } as unknown as GitWorkspace,
      review: async () => { dirty = true; throw new Error('review failed'); },
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 22)!;
    assert.equal(task.status, 'BLOCKED');
    assert.match(store.runsForTask(task.id)[0]!.reason ?? '', /modified during review/);
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('PR summary uses final review PASS after a repaired BLOCK', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(23, { ...ISSUE });
    let body = ''; let reviews = 0;
    const create = env.tracker.createDraftPr.bind(env.tracker);
    env.tracker.createDraftPr = async (repo, opts) => { body = opts.body; return create(repo, opts); };
    const { engine } = makeEngine(env, { review: async () => ({ result: { verdict: ++reviews === 1 ? 'BLOCK' : 'PASS', risk: 'low',
      summary: 'checked', findings: reviews === 1 ? ['parser: empty input causes crash; add a regression'] : [] }, logPath: 'r' }) });
    await tickAndDrain(engine);
    assert.match(body, /Review 结论：PR 创建后自动执行/);
    assert.doesNotMatch(body, /Review 结论：BLOCK/);
  } finally { env.done(); }
});

test('closed and merged existing PRs do not masquerade as awaiting review', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(24, { ...ISSUE });
    env.tracker.issues.set(25, { ...ISSUE });
    env.tracker.prs.set('agent/issue-24', { number: 24, url: 'https://x/pull/24', state: 'CLOSED', isDraft: true });
    env.tracker.prs.set('agent/issue-25', { number: 25, url: 'https://x/pull/25', state: 'MERGED', isDraft: false });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 24)!.status, 'BLOCKED');
    assert.equal(store.getTask('me/sandbox', 25)!.status, 'COMPLETED');
    assert.equal(coderCalls, 0);
  } finally { env.done(); }
});

test('successful checks that change HEAD cannot authorize review or publish', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(26, { ...ISSUE });
    let sha = 'before'; let reviews = 0;
    const { store, engine } = makeEngine(env, {
      workspace: { ...fakeWorkspace(), head: async () => sha } as unknown as GitWorkspace,
      checks: async () => { sha = 'after'; return checksOk(); },
      review: async () => { reviews++; return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' }; },
    });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 26)!.status, 'BLOCKED');
    assert.equal(reviews, 0);
    assert.equal(env.tracker.prCreated, 0);
  } finally { env.done(); }
});

test('recovering publish without in-memory evidence reruns checks and review', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(27, { ...ISSUE });
    let checks = 0; let reviews = 0; let coder = 0;
    const { store, engine } = makeEngine(env, {
      coder: async () => { coder++; return okCoder(); },
      checks: async () => { checks++; return checksOk(); },
      review: async () => { reviews++; return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' }; },
    });
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 27, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'RUNNING');
    const run = store.claimRun(task.id);
    store.updateRunFields(run.run_id, { workspace: env.dir, branch: 'agent/issue-27' });
    store.transition(run.run_id, 'CLAIMED', 'PUBLISHING_PR');
    engine.resumeRun(run.run_id);
    for (let i = 0; i < 150 && engine.activeCount(); i++) await sleep(20);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_MERGE');
    assert.equal(coder, 0); assert.equal(checks, 1); assert.equal(reviews, 1);
  } finally { env.done(); }
});

test('truncated captured diff is not sent for automatic review', async () => {
  const { DiffTooLargeError } = await import('../src/workspace/git.js');
  const result = { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: 'output', stderrTail: '' };
  const ws = new GitWorkspace(async (opts) => ({ ...result, stdoutTruncated: opts.argv.includes('--find-renames') }));
  await assert.rejects(ws.diffVsBase('.', 'main'), DiffTooLargeError);
});

test('oversized review diff blocks for a human instead of failing the run', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(31, { ...ISSUE });
    const { DiffTooLargeError } = await import('../src/workspace/git.js');
    const { store, engine } = makeEngine(env, {
      workspace: {
        ...fakeWorkspace(),
        diffVsBase: async () => { throw new DiffTooLargeError('review diff exceeds captured output limit; human review required'); },
      } as unknown as GitWorkspace,
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 31)!;
    assert.equal(task.status, 'BLOCKED');
    assert.match(store.runsForTask(task.id)[0]!.reason ?? '', /human review required/);
  } finally { env.done(); }
});

test('workspace publishes the reviewed SHA rather than a moving branch ref', async () => {
  const calls: string[][] = [];
  const ws = new GitWorkspace(async (opts) => {
    calls.push(opts.argv);
    return { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '' };
  });
  await ws.push('.', 'agent/issue-1', 'reviewed-sha');
  assert.deepEqual(calls[0], ['git', 'push', 'origin', 'reviewed-sha:refs/heads/agent/issue-1']);
});

test('checks and review events bind their evidence to the published SHA', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(30, { ...ISSUE });
    let prBody = ''; let reviewEvidence = '';
    const create = env.tracker.createDraftPr.bind(env.tracker);
    env.tracker.createDraftPr = async (repo, opts) => { prBody = opts.body; return create(repo, opts); };
    const { store, engine } = makeEngine(env, {
      review: async (_ctx, evidence) => {
        reviewEvidence = evidence;
        return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'review.jsonl' };
      },
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 30)!;
    const events = store.eventsForRun(store.runsForTask(task.id)[0]!.run_id);
    const details = events.flatMap((event) => event.detail_json ? [JSON.parse(event.detail_json) as Record<string, unknown>] : []);
    assert.ok(details.some((detail) => detail.kind === 'checks_completed' && detail.head_sha === 'head-sha' && detail.ok === true));
    assert.ok(details.some((detail) => detail.kind === 'review_completed' && detail.head_sha === 'head-sha' && detail.verdict === 'PASS'));
    assert.ok(details.some((detail) => detail.kind === 'pr_published' && detail.head_sha === 'head-sha'));
    assert.match(reviewEvidence, /提交 SHA: head-sha/);
    assert.match(prBody, /提交：`head-sha`/);
    assert.match(prBody, /exit 0/);
  } finally { env.done(); }
});

test('failed checks record the checked SHA on the transition into fixing', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(31, { ...ISSUE });
    const { store, engine } = makeEngine(env, { checks: async () => checksFail() });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 31)!;
    const events = store.eventsForRun(store.runsForTask(task.id)[0]!.run_id);
    const detail = events.find((event) => event.to_phase === 'FIXING')!.detail_json!;
    assert.equal((JSON.parse(detail) as { head_sha?: string }).head_sha, 'head-sha');
    assert.ok(events.some((event) => event.to_phase === 'VERIFYING' && JSON.parse(event.detail_json ?? '{}').kind === 'checks_completed'));
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

    // Host-side fallback commit: dirty work → committed verbatim.
    writeFileSync(join(wt, 'b.txt'), 'new');
    assert.equal(await ws.isDirty(wt), true);
    assert.equal(await ws.commitAll(wt, 'agent-control: commit uncommitted agent work'), true);
    assert.equal(await ws.isDirty(wt), false);
    assert.equal(await ws.aheadCount(wt, 'main'), 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp residue ok */ }
  }
});
