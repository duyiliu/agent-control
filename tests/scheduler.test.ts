import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { AgentCallResult } from '../src/runners/types.js';
import type { CoderSession, CoderTurn } from '../src/runners/session.js';
import { runChecks, type ChecksSummary } from '../src/verify/checks.js';
import { stopTask } from '../src/ops.js';
import type { AppConfig, ReviewResult } from '../src/types.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';
import type { Store } from '../src/store/sqlite.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace(calls?: string[]): GitWorkspace {
  // Detached review sites remember the sha they were materialized at —
  // head() must answer per-path or a moved-head review cannot be faked.
  const siteHeads = new Map<string, string>();
  return {
    ensureWorktree: async (i: { worktreePath: string }) => ({ path: i.worktreePath, created: true }),
    isDirty: async () => false,
    head: async (p?: string) => siteHeads.get(p ?? '') ?? 'head-sha',
    commitAll: async () => false,
    aheadCount: async () => 1,
    diffVsBase: async () => 'diff',
    push: async () => {},
    fetchBranch: async (_repo: string, b: string) => { calls?.push(`fetch:${b}`); },
    resetHard: async (_p: string, ref: string) => { calls?.push(`reset:${ref}`); },
    addDetachedWorktree: async (_repo: string, sha: string, p: string) => { siteHeads.set(p, sha); return p; },
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
  return { ok: true, outcomes: [{ spec: { argv: ['x'] }, command: 'x', exitCode: 0, timedOut: false, tail: '', logPath: 'l' }], skipped: [], failureEvidence: '' };
}

function checksFail(): ChecksSummary {
  return {
    ok: false,
    outcomes: [{ spec: { argv: ['x'] }, command: 'x', exitCode: 1, timedOut: false, tail: 'boom', logPath: 'l' }],
    skipped: [],
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
    claimArbitrationMs: 0,
  });
  return { store, engine };
}

async function tickAndDrain(engine: Engine) {
  await engine.tick();
  for (let i = 0; i < 300 && engine.activeCount() > 0; i++) await sleep(20);
}

const ISSUE = { title: 'Fix parser', body: 'Fix the parsing bug.\n\nAC: test passes', labels: ['agent-ready'], state: 'OPEN', url: 'https://x/1' };

test('stranded AWAITING_REVIEW parks for a human instead of showing forever', async () => {
  const env = setup();
  try {
    const { store, engine } = makeEngine(env);
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 50, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_REVIEW', {
      branch: 'agent/issue-50',
      pr_url: 'https://github.com/me/sandbox/pull/50',
    });
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'head-sha' });
    store.endRun(run.run_id, 'BLOCKED', 'block');
    store.addCheck({
      run_id: run.run_id, kind: 'review', command: 'agent (review)',
      exit_code: null, verdict: 'BLOCK', head_sha: 'head-sha',
    });

    await tickAndDrain(engine);

    const after = store.getTaskById(task.id)!;
    assert.equal(after.status, 'BLOCKED');
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 50 && l === 'agent-blocked'));
    assert.equal(store.runsForTask(task.id).filter((r) => r.kind === 'review').length, 1);
  } finally { env.done(); }
});

test('AC1: happy path produces exactly one draft PR and awaits merge', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 1)!;
    assert.equal(task.status, 'AWAITING_REVIEW');
    assert.match(task.pr_url ?? '', /pull\/\d+/);
    assert.equal(env.tracker.prCreated, 1);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 1 && l === 'agent-running'));
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 1 && l === 'agent-pr'));
    const run = store.runsForTask(task.id)[0]!;
    const phases = store.eventsForRun(run.run_id).filter((e) => e.from_phase !== e.to_phase).map((e) => e.to_phase);
    assert.deepEqual(phases, ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING_PR', 'AWAITING_REVIEW']);

    await tickAndDrain(engine); // dispatches the auto review run — no second PR
    const runs = store.runsForTask(task.id);
    assert.equal(runs.filter((r) => r.kind === 'code').length, 1);
    assert.equal(runs.filter((r) => r.kind === 'review').length, 1);
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
      claimArbitrationMs: 0,
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 30)!;
    assert.equal(task.status, 'AWAITING_REVIEW');
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

test('AC4b: check fails once, fix succeeds → AWAITING_REVIEW', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(5, { ...ISSUE });
    let checksN = 0;
    const { store, engine } = makeEngine(env, {
      checks: async () => (++checksN === 1 ? checksFail() : checksOk()),
    });
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 5)!.status, 'AWAITING_REVIEW');
    assert.equal(checksN, 2);
  } finally { env.done(); }
});

test('AC5: review BLOCK → fix run → re-review → PASS', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(6, { ...ISSUE });
    let reviews = 0;
    let checks = 0;
    const review: ReviewFn = async () => {
      reviews++;
      return { result: { verdict: reviews === 1 ? 'BLOCK' : 'PASS', risk: 'low', summary: 'r', findings: reviews === 1 ? ['parser.ts: empty input crashes; validate with an empty-input test'] : [] }, logPath: 'l' };
    };
    const ws = fakeWorkspace();
    ws.head = async () => env.tracker.headSha;
    const { store, engine } = makeEngine(env, { review, checks: async () => { checks++; return checksOk(); }, workspace: ws });
    await tickAndDrain(engine); // code run → publish → AWAITING_HUMAN
    await tickAndDrain(engine); // review #1 → BLOCK → pending_fix → DISCOVERED
    let task = store.getTask('me/sandbox', 6)!;
    assert.equal(task.status, 'DISCOVERED');
    assert.ok(task.pending_fix);
    env.tracker.headSha = 'sha-2'; // the fix produces a new head
    await tickAndDrain(engine); // fix code run → publish → AWAITING_HUMAN
    await tickAndDrain(engine); // review #2 on the new sha → PASS
    task = store.getTask('me/sandbox', 6)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(reviews, 2);
    assert.equal(checks, 2, 'review-driven fixes must rerun checks');
    assert.equal(store.runsForTask(task.id).length, 4); // code + review + fix-code + review#2
    assert.equal(store.getTask('me/sandbox', 6)!.fix_rounds, 1);
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
    await tickAndDrain(engine); // code run
    await tickAndDrain(engine); // review run → BLOCK, no findings
    const task = store.getTask('me/sandbox', 17)!;
    assert.equal(task.status, 'BLOCKED');
    assert.equal(coderCalls, 1);
    const runs = store.runsForTask(task.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.kind, 'review');
    assert.equal(runs[1]!.phase, 'BLOCKED');
    assert.ok(store.checksForRun(runs[1]!.run_id).some((c) => c.kind === 'review' && c.verdict === 'BLOCK' && c.head_sha === 'head-sha'));
  } finally { env.done(); }
});

test('review infrastructure failure degrades to human review, not task failure', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(18, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: async () => { throw new Error('review output unavailable'); } });
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 18)!;
    // An un-runnable review never punishes the code: ERROR verdict pins the
    // sha so it is not re-dispatched, and the task waits for a human.
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(task.fix_rounds, 0);
    const runs = store.runsForTask(task.id);
    assert.equal(runs.length, 2);
    assert.ok(store.checksForRun(runs[1]!.run_id).some((c) => c.kind === 'review' && c.verdict === 'ERROR'));
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 18 && l === 'agent-high-risk'));
    assert.equal(env.tracker.prCreated, 1);
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('AC5b: HUMAN_REVIEW_REQUIRED → AWAITING_HUMAN + high-risk, PR stays draft', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(7, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: reviewHuman });
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 7)!.status, 'AWAITING_HUMAN');
    assert.equal(env.tracker.prCreated, 1);
    assert.equal(env.tracker.merged.length, 0);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 7 && l === 'agent-high-risk'));
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
    await tickAndDrain(engine); // code run
    await tickAndDrain(engine); // review run reads cross-run sha-bound evidence
    assert.equal(store.getTask('me/sandbox', 41)!.status, 'AWAITING_HUMAN');
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
    assert.notEqual(task.status, 'AWAITING_HUMAN');
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

test('existing PR for branch → no coder run, review dispatches on the attached PR', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(10, { ...ISSUE });
    env.tracker.prs.set('agent/issue-10', { number: 55, url: 'https://x/pull/55', state: 'OPEN', isDraft: true });
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 10)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
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
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/77', branch: 'agent/issue-12' });
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
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/78', branch: 'agent/issue-13' });
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
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/79', branch: 'agent/issue-15' });
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
      claimArbitrationMs: 0,
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

test('review tampering is refused even when reviewer throws', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(22, { ...ISSUE });
    let dirty = false;
    const { store, engine } = makeEngine(env, {
      workspace: { ...fakeWorkspace(), isDirty: async () => dirty } as unknown as GitWorkspace,
      review: async () => { dirty = true; throw new Error('review failed'); },
    });
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 22)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    const reviewRun = store.runsForTask(task.id).find((r) => r.kind === 'review')!;
    assert.match(reviewRun.reason ?? '', /modified during review/);
    assert.ok(store.checksForRun(reviewRun.run_id).some((c) => c.verdict === 'ERROR'));
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

test('recovering publish without in-memory evidence reruns checks; review is a separate run', async () => {
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
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    assert.equal(coder, 0); assert.equal(checks, 1); assert.equal(reviews, 0);
    await tickAndDrain(engine); // review is dispatched separately against the PR head
    assert.equal(reviews, 1);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
  } finally { env.done(); }
});

test('truncated captured diff is not sent for automatic review', async () => {
  const { DiffTooLargeError } = await import('../src/workspace/git.js');
  const result = { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: 'output', stderrTail: '' };
  const ws = new GitWorkspace(async (opts) => ({ ...result, stdoutTruncated: opts.argv.includes('--find-renames') }));
  await assert.rejects(ws.diffVsBase('.', 'main'), DiffTooLargeError);
});

test('oversized review diff degrades to human review instead of failing', async () => {
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
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 31)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    const reviewRun = store.runsForTask(task.id).find((r) => r.kind === 'review')!;
    assert.match(reviewRun.reason ?? '', /human review required|too large/);
    assert.ok(store.checksForRun(reviewRun.run_id).some((c) => c.verdict === 'HUMAN_REVIEW_REQUIRED'));
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 31 && l === 'agent-high-risk'));
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
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 30)!;
    const events = store.runsForTask(task.id).flatMap((r) => store.eventsForRun(r.run_id));
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

// ---------- review-run terminals (kind=review) ----------

test('AC15: PR head moved mid-review → run CANCELED, task stays AWAITING_REVIEW, no verdict row', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(50, { ...ISSUE });
    const ws = fakeWorkspace();
    ws.head = async () => env.tracker.headSha;
    const { store, engine } = makeEngine(env, { workspace: ws });
    await tickAndDrain(engine); // code run → AWAITING_HUMAN
    const task = store.getTask('me/sandbox', 50)!;
    // Review run pinned to the old sha; PR head moves before it starts.
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha-old' });
    store.updateRunFields(run.run_id, { pr_url: task.pr_url, workspace: env.dir });
    store.setTaskStatus(task.id, 'REVIEWING');
    env.tracker.headSha = 'sha-new';
    engine.resumeRun(run.run_id);
    for (let i = 0; i < 150 && engine.activeCount(); i++) await sleep(20);
    assert.equal(store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    assert.equal(store.checksForRun(run.run_id).filter((c) => c.kind === 'review').length, 0);
    // Next tick re-dispatches on the NEW sha and reaches a verdict.
    await tickAndDrain(engine);
    const reviewRuns = store.runsForTask(task.id).filter((r) => r.kind === 'review');
    assert.equal(reviewRuns.length, 2);
    assert.equal(reviewRuns[1]!.head_sha, 'sha-new');
    assert.ok(store.checksForRun(reviewRuns[1]!.run_id).some((c) => c.verdict === 'PASS' && c.head_sha === 'sha-new'));
  } finally { env.done(); }
});

test('AC19: cancel_requested on a review run cancels task and writes no verdict', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(51, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 51)!;
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'head-sha' });
    store.updateRunFields(run.run_id, { pr_url: task.pr_url, workspace: env.dir });
    store.setTaskStatus(task.id, 'REVIEWING');
    store.requestCancel(run.run_id);
    engine.resumeRun(run.run_id);
    for (let i = 0; i < 150 && engine.activeCount(); i++) await sleep(20);
    assert.equal(store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.equal(store.getTaskById(task.id)!.status, 'CANCELED');
    assert.equal(store.checksForRun(run.run_id).filter((c) => c.kind === 'review').length, 0);
  } finally { env.done(); }
});

test('AC14: fix run that produces no new commits is a dead end, not silent', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(52, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // publish at head-sha
    const task = store.getTask('me/sandbox', 52)!;
    // Simulate a review-BLOCK pending fix whose fix changes nothing.
    store.setTaskStatus(task.id, 'DISCOVERED', {
      pending_fix: JSON.stringify({ head_sha: 'head-sha', summary: 'block', findings: ['f1'] }),
    });
    await tickAndDrain(engine);
    const t2 = store.getTaskById(task.id)!;
    assert.equal(t2.status, 'BLOCKED');
    const fixRun = store.runsForTask(task.id).at(-1)!;
    assert.equal(fixRun.kind, 'code');
    assert.match(fixRun.reason ?? '', /no new commits/);
  } finally { env.done(); }
});

test('AC04: review PASS + low risk + auto_merge enabled merges and completes', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(53, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // code run
    await tickAndDrain(engine); // review run → PASS → task MERGING
    assert.equal(store.getTask('me/sandbox', 53)!.status, 'MERGING');
    await tickAndDrain(engine); // merge sweep lands the PR
    const task = store.getTask('me/sandbox', 53)!;
    assert.equal(task.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('AC11: PR merged mid-review finalizes task COMPLETED', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(54, { ...ISSUE });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 54)!;
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'head-sha' });
    store.updateRunFields(run.run_id, { pr_url: task.pr_url, workspace: env.dir });
    store.setTaskStatus(task.id, 'REVIEWING');
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.prStates.set(prNum, 'MERGED');
    engine.resumeRun(run.run_id);
    for (let i = 0; i < 150 && engine.activeCount(); i++) await sleep(20);
    assert.equal(store.getRun(run.run_id)!.phase, 'COMPLETED');
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
  } finally { env.done(); }
});

test('AC08: a sha with any verdict row is never re-reviewed', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(55, { ...ISSUE });
    let reviews = 0;
    const { store, engine } = makeEngine(env, {
      review: async () => { reviews++; return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' }; },
    });
    await tickAndDrain(engine);
    await tickAndDrain(engine); // review PASS recorded
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    assert.equal(reviews, 1);
    assert.equal(store.runsForTask(store.getTask('me/sandbox', 55)!.id).filter((r) => r.kind === 'review').length, 1);
  } finally { env.done(); }
});

const DIFF_NEW_TEST = [
  'diff --git a/src/fraction.js b/src/fraction.js',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/src/fraction.js',
  '@@ -0,0 +1,5 @@',
  '+x',
  'diff --git a/tests/fraction.test.js b/tests/fraction.test.js',
  'new file mode 100644',
  'index 0000000..2222222',
  '--- /dev/null',
  '+++ b/tests/fraction.test.js',
  '@@ -0,0 +1,5 @@',
  '+test',
].join('\n');

test('risk: a newly added test file does not block auto-merge', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(60, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const ws = fakeWorkspace();
    ws.diffVsBase = async () => DIFF_NEW_TEST;
    const { store, engine } = makeEngine(env, { workspace: ws });
    await tickAndDrain(engine); // code run → publish
    await tickAndDrain(engine); // review PASS low — new tests are not weakened coverage
    await tickAndDrain(engine); // merge sweep
    assert.equal(store.getTask('me/sandbox', 60)!.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('risk: editing an existing test file keeps the human merge gate', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(61, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const ws = fakeWorkspace();
    ws.diffVsBase = async () => [
      'diff --git a/src/x.js b/src/x.js',
      'index 1111111..2222222 100644',
      '--- a/src/x.js',
      '+++ b/src/x.js',
      '@@ -1 +1 @@',
      '-a', '+b',
      'diff --git a/tests/x.test.js b/tests/x.test.js',
      'index 3333333..4444444 100644',
      '--- a/tests/x.test.js',
      '+++ b/tests/x.test.js',
      '@@ -1 +1 @@',
      '-assert.strictEqual(x, 1)', '+assert.ok(true)',
    ].join('\n');
    const { store, engine } = makeEngine(env, { workspace: ws });
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 61)!.status, 'AWAITING_HUMAN');
    assert.equal(env.tracker.merged.length, 0);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 61 && l === 'agent-high-risk'));
  } finally { env.done(); }
});

test('dispatch clears a stale agent-blocked label on claim', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(62, { ...ISSUE, labels: ['agent-ready', 'agent-blocked'] });
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    assert.ok(env.tracker.labelsRemoved.some(([n, l]) => n === 62 && l === 'agent-blocked'));
  } finally { env.done(); }
});

test('merge conflict after PASS spawns a fix run via pending_fix', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(63, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const calls: string[] = [];
    const { store, engine } = makeEngine(env, { workspace: fakeWorkspace(calls) });
    await tickAndDrain(engine); // code run → PR published
    const task = store.getTask('me/sandbox', 63)!;
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.mergeErrors.set(prNum, new Error('gh pr merge failed: the merge commit cannot be cleanly created'));
    env.tracker.mergeable.set(prNum, 'CONFLICTING');
    await tickAndDrain(engine); // review PASS → MERGING
    // Same tick: the sweep sees CONFLICTING → DISCOVERED + pending_fix, then
    // dispatch() claims the fix run — it ends BLOCKED because the fake
    // workspace head never moves off the reviewed sha.
    await tickAndDrain(engine);
    const t2 = store.getTaskById(task.id)!;
    assert.equal(t2.status, 'BLOCKED');
    assert.equal(t2.fix_rounds, 1);
    assert.equal(t2.pending_fix, null);
    assert.equal(t2.merge_attempts, 0); // a conflict is a fix, not a retry
    assert.equal(env.tracker.merged.length, 0);
    assert.equal(store.runsForTask(task.id).find((r) => r.kind === 'review')!.phase, 'COMPLETED');
    const fixRun = store.runsForTask(task.id).at(-1)!;
    assert.equal(fixRun.kind, 'code');
    assert.equal(fixRun.phase, 'BLOCKED');
    assert.match(fixRun.reason ?? '', /no new commits/);
    const consumed = store.eventsForRun(fixRun.run_id)
      .map((e) => (e.detail_json ? JSON.parse(e.detail_json) : null))
      .find((d) => d?.kind === 'pending_fix_consumed');
    assert.equal(consumed.head_sha, 'head-sha');
    assert.ok(consumed.findings.some((f: string) => f.includes('git merge origin/')));
    // The fix run must sync the worktree to the remote PR head before the
    // agent merges base — otherwise publish pushes a non-fast-forward.
    assert.ok(calls.includes('fetch:agent/issue-63'), `PR branch fetched: ${calls}`);
    assert.ok(calls.includes('reset:origin/agent/issue-63'), `worktree reset to remote head: ${calls}`);
  } finally { env.done(); }
});

test('merge refusal without conflicts retries, then parks for a human at the cap', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(64, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 64)!;
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.mergeErrors.set(prNum, new Error('gh pr merge failed: permission denied'));
    env.tracker.mergeable.set(prNum, 'MERGEABLE');
    await tickAndDrain(engine); // review PASS → MERGING
    await tickAndDrain(engine); // merge attempt 1 fails — still MERGING
    const mid = store.getTaskById(task.id)!;
    assert.equal(mid.status, 'MERGING');
    assert.equal(mid.merge_attempts, 1);
    // Burn the remaining budget minus one, then the next failure hits the cap.
    for (let i = mid.merge_attempts; i < 19; i++) store.bumpMergeAttempts(task.id);
    await tickAndDrain(engine); // attempt 20 fails → human path
    const t2 = store.getTaskById(task.id)!;
    assert.equal(t2.status, 'AWAITING_HUMAN');
    assert.equal(t2.pending_fix, null);
    assert.equal(env.tracker.merged.length, 0);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 64 && l === 'agent-high-risk'));
  } finally { env.done(); }
});

test('merge conflict with fix budget exhausted lands on a human', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(65, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 65)!;
    for (let i = 0; i < env.config.server.retry_limit; i++) store.bumpFixRounds(task.id);
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.mergeErrors.set(prNum, new Error('gh pr merge failed: not mergeable'));
    env.tracker.mergeable.set(prNum, 'CONFLICTING');
    await tickAndDrain(engine); // review PASS → MERGING
    await tickAndDrain(engine); // sweep: CONFLICTING but fix budget gone → human
    const t2 = store.getTaskById(task.id)!;
    assert.equal(t2.status, 'AWAITING_HUMAN');
    assert.equal(t2.pending_fix, null);
    assert.ok(env.tracker.labelsAdded.some(([n, l]) => n === 65 && l === 'agent-high-risk'));
  } finally { env.done(); }
});

test('claim race: an earlier rival claim comment makes this run back out before launch', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(63, { ...ISSUE });
    env.tracker.issueComments.set(63, [
      { body: 'agent-control: 已领取（`OTHER-HOST`）', createdAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    let coderCalls = 0;
    const { store, engine } = makeEngine(env, { coder: async () => { coderCalls++; return okCoder(); } });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 63)!;
    const runs = store.runsForTask(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.phase, 'CANCELED');
    assert.equal(coderCalls, 0); // yielded before any agent work
    assert.equal(task.status, 'DISCOVERED'); // the winner owns the task
  } finally { env.done(); }
});

test('claim race: a stale rival claim comment does not block dispatch', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(64, { ...ISSUE });
    env.tracker.issueComments.set(64, [
      { body: 'agent-control: 已领取（`OTHER-HOST`）', createdAt: new Date(Date.now() - 11 * 60_000).toISOString() },
    ]);
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 64)!.status, 'AWAITING_REVIEW');
  } finally { env.done(); }
});

test('stop on an AWAITING_REVIEW task opts out to the human merge path', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(76, { ...ISSUE });
    env.config.projects[0]!.review_mode = 'manual'; // keep the review from running in the same tick
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 76)!;
    store.setTaskStatus(task.id, 'AWAITING_REVIEW');
    const msg = stopTask(store, store.getTaskById(task.id)!);
    assert.match(msg, /人工处理/);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
  } finally { env.done(); }
});

test('a human merge while AWAITING_REVIEW completes the task', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(77, { ...ISSUE });
    env.config.projects[0]!.review_mode = 'manual'; // keep the PR parked in review state
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 77)!;
    store.setTaskStatus(task.id, 'AWAITING_REVIEW');
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.prStates.set(prNum, 'MERGED');
    await tickAndDrain(engine); // the sweep writes the external merge back
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
  } finally { env.done(); }
});

test('manual review mode parks the PR in Human Review and spends no review run', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(74, { ...ISSUE });
    env.config.projects[0]!.review_mode = 'manual';
    env.config.approvals.auto_merge.enabled = true; // manual review must still win
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // code run → PR published
    const task = store.getTask('me/sandbox', 74)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    await tickAndDrain(engine);
    await tickAndDrain(engine);
    assert.equal(store.runsForTask(task.id).filter((r) => r.kind === 'review').length, 0);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('switching a project to manual review stops an in-flight MERGING task', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(75, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 75)!;
    await tickAndDrain(engine); // review PASS → MERGING
    assert.equal(store.getTaskById(task.id)!.status, 'MERGING');
    env.config.projects[0]!.review_mode = 'manual';
    await tickAndDrain(engine); // opt-out wins over the in-flight merge
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});

test('human approval label lands a reviewed head that review sent to a human', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(80, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: reviewHuman });
    await tickAndDrain(engine); // code run → AWAITING_REVIEW
    await tickAndDrain(engine); // review HRR → AWAITING_HUMAN
    const task = store.getTask('me/sandbox', 80)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.prLabels.set(prNum, ['agent-merge']);
    await tickAndDrain(engine); // approval consumed (one-shot) → MERGING
    assert.equal(store.getTaskById(task.id)!.status, 'MERGING');
    assert.ok(!(env.tracker.prLabels.get(prNum) ?? []).includes('agent-merge'));
    await tickAndDrain(engine); // the sweep lands it
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('a moved head is re-queued for review and the stale approval is dropped', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(81, { ...ISSUE });
    const { store, engine } = makeEngine(env, { review: reviewHuman });
    await tickAndDrain(engine);
    await tickAndDrain(engine); // review HRR → AWAITING_HUMAN on head-sha
    const task = store.getTask('me/sandbox', 81)!;
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.headSha = 'sha-new'; // someone pushed past the reviewed head
    env.tracker.prLabels.set(prNum, ['agent-merge']);
    await tickAndDrain(engine);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
    assert.equal(env.tracker.merged.length, 0);
    assert.ok(!(env.tracker.prLabels.get(prNum) ?? []).includes('agent-merge'));
  } finally { env.done(); }
});

test('manual mode: the approval label lands the current head without any verdict', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(82, { ...ISSUE });
    env.config.projects[0]!.review_mode = 'manual';
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine); // publish → AWAITING_HUMAN directly
    const task = store.getTask('me/sandbox', 82)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    env.tracker.prLabels.set(prNum, ['agent-merge']);
    await tickAndDrain(engine); // approval → MERGING (no verdict sha involved)
    assert.equal(store.getTaskById(task.id)!.status, 'MERGING');
    await tickAndDrain(engine);
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('MERGING retries a transient merge failure and lands on the next tick', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(70, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 70)!;
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    await tickAndDrain(engine); // review PASS → MERGING
    env.tracker.mergeErrors.set(prNum, new Error('gh pr merge failed: transient 502'));
    await tickAndDrain(engine); // attempt 1 fails — stay MERGING, do not park
    const mid = store.getTaskById(task.id)!;
    assert.equal(mid.status, 'MERGING');
    assert.equal(mid.merge_attempts, 1);
    env.tracker.mergeErrors.delete(prNum);
    await tickAndDrain(engine); // attempt 2 lands
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('MERGING head move returns to AWAITING_REVIEW and re-reviews the new sha', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(71, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    let reviews = 0;
    const { store, engine } = makeEngine(env, {
      review: async () => { reviews++; return { result: { verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }, logPath: 'r' }; },
    });
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 71)!;
    await tickAndDrain(engine); // review PASS on head-sha → MERGING
    assert.equal(store.getTaskById(task.id)!.status, 'MERGING');
    env.tracker.headSha = 'sha-new';
    // Same tick: the sweep unpins the stale verdict, dispatchReviews then
    // claims a fresh review run for sha-new (drained by tickAndDrain).
    await tickAndDrain(engine);
    assert.equal(env.tracker.merged.length, 0); // the old-sha verdict never lands a different head
    assert.equal(reviews, 2);
    assert.ok(store.runsForTask(task.id).some((r) => r.kind === 'review' && r.head_sha === 'sha-new'));
    await tickAndDrain(engine); // sweep merges pinned to sha-new
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
    assert.equal(env.tracker.merged.length, 1);
  } finally { env.done(); }
});

test('a human merge while MERGING completes the task', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(73, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 73)!;
    const prNum = Number(task.pr_url!.match(/pull\/(\d+)/)![1]);
    await tickAndDrain(engine); // → MERGING
    env.tracker.prStates.set(prNum, 'MERGED');
    await tickAndDrain(engine); // sweep reconciles the external merge
    assert.equal(store.getTaskById(task.id)!.status, 'COMPLETED');
  } finally { env.done(); }
});

test('stop on a MERGING task opts out to the human merge path', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(72, { ...ISSUE });
    env.config.approvals.auto_merge.enabled = true;
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    const task = store.getTask('me/sandbox', 72)!;
    await tickAndDrain(engine); // → MERGING
    assert.equal(store.getTaskById(task.id)!.status, 'MERGING');
    const msg = stopTask(store, store.getTaskById(task.id)!);
    assert.match(msg, /人工处理/);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
    await tickAndDrain(engine); // the sweep must not merge an opted-out task
    assert.equal(env.tracker.merged.length, 0);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN');
  } finally { env.done(); }
});

test('claim race: an earlier claim from this same host is a ghost, not a rival', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(65, { ...ISSUE });
    env.tracker.issueComments.set(65, [
      { body: `agent-control: 已领取（\`${hostname()}\`）（run \`old-run\`）`, createdAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    const { store, engine } = makeEngine(env);
    await tickAndDrain(engine);
    assert.equal(store.getTask('me/sandbox', 65)!.status, 'AWAITING_REVIEW');
  } finally { env.done(); }
});
