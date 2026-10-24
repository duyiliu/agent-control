import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/scheduler/engine.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { CoderSession, CoderTurn } from '../src/runners/session.js';
import type { ChecksSummary } from '../src/verify/checks.js';
import { runProc } from '../src/proc.js';
import { requestDrain, resumeDispatch } from '../src/ops.js';
import { Store } from '../src/store/sqlite.js';
import type { AppConfig, Phase, ReviewResult } from '../src/types.js';
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
    refSha: async (_repo: string, ref: string) => ref,
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

function okTurn(): CoderTurn {
  return { ok: true, aborted: false, timedOut: false, exitCode: 0, lastMessage: null, durationMs: 1, stderrTail: '' };
}

const ISSUE = { title: 'Fix parser', body: 'Fix the parsing bug.\n\nAC: test passes', labels: ['agent-ready'], state: 'OPEN', url: 'https://x/1' };

interface Env {
  dir: string;
  config: AppConfig;
  tracker: ReturnType<typeof makeFakeTracker>;
  store: Store;
  done: () => void;
}

function setup(opts: { maxConcurrent?: number } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-drain-'));
  const config = makeConfig(dir);
  config.server.max_concurrent = opts.maxConcurrent ?? 1;
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  return { dir, config, tracker, store, done: () => teardown(dir, [store]) };
}

function makeEngine(env: Env, session: () => CoderSession): Engine {
  return new Engine({
    store: env.store,
    config: env.config,
    tracker: env.tracker as unknown as GitHubTracker,
    workspace: fakeWorkspace(),
    appLog: nullLog,
    installDir: env.dir,
    openCoderSessionFn: session,
    runChecksFn: async () => checksOk(),
    runReviewFn: reviewPass as never,
    claimArbitrationMs: 0,
    recoveryProcessDeps: { isPidAlive: () => false, findProcs: async () => [] },
  });
}

/** Session whose prompt hangs until release. */
function hangingSession() {
  let mark!: () => void;
  let rel!: () => void;
  const entered = new Promise<void>((r) => (mark = r));
  const gate = new Promise<void>((r) => (rel = r));
  const session: CoderSession = {
    pid: 42,
    async prompt(): Promise<CoderTurn> {
      mark();
      await gate;
      return okTurn();
    },
    async close() {},
  };
  return { session, entered, release: rel };
}

function seedActiveRun(env: Env, n: number, phase: Phase) {
  const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: n, issue_title: 't', issue_url: 'u' });
  env.store.setTaskStatus(task.id, 'RUNNING');
  env.tracker.issues.set(n, { ...ISSUE });
  const run = env.store.claimRun(task.id);
  env.store.transition(run.run_id, 'CLAIMED', phase);
  const wt = join(env.dir, `wt-${n}`);
  mkdirSync(wt, { recursive: true });
  env.store.updateRunFields(run.run_id, { workspace: wt, branch: `agent/issue-${n}` });
  return { task, run: env.store.getRun(run.run_id)! };
}

test('drain: an in-flight run finishes without abort, then the ack lands', async () => {
  const env = setup();
  const h = hangingSession();
  try {
    const engine = makeEngine(env, () => h.session);
    env.tracker.issues.set(1, { ...ISSUE });
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });

    await engine.tick();
    await h.entered;
    const requestId = requestDrain(env.store);
    h.release();
    await waitFor(() => engine.activeCount() === 0);

    // The run landed normally — drain never cancels.
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    assert.notEqual(env.store.getMeta('drain_ack'), requestId);

    await engine.tick();
    assert.equal(env.store.getMeta('drain_ack'), requestId);
    // The pause held: no review run was dispatched for the new AWAITING_REVIEW.
    assert.equal(env.store.runsForTask(task.id).length, 1);
  } finally { h.release(); env.done(); }
});

test('drain: a paused tick starts no code, review or merge work', async () => {
  const env = setup({ maxConcurrent: 3 });
  try {
    const engine = makeEngine(env, () => { throw new Error('must not spawn'); });
    const requestId = requestDrain(env.store);

    env.tracker.issues.set(1, { ...ISSUE });
    const { task: code } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    const { task: rev } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 2, issue_title: 't', issue_url: 'u' });
    env.store.setTaskStatus(rev.id, 'AWAITING_REVIEW', { pr_url: 'https://x/pull/9', branch: 'agent/issue-2' });
    const { task: merging } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 3, issue_title: 't', issue_url: 'u' });
    env.store.setTaskStatus(merging.id, 'MERGING', { pr_url: 'https://x/pull/10', branch: 'agent/issue-3', approved_sha: 'head-sha', approved_by: 'review' });

    await engine.tick();

    assert.equal(env.store.getTaskById(code.id)!.status, 'DISCOVERED');
    assert.equal(env.store.getTaskById(rev.id)!.status, 'AWAITING_REVIEW');
    assert.equal(env.store.runsForTask(rev.id).length, 0);
    assert.equal(env.store.getTaskById(merging.id)!.status, 'MERGING');
    assert.equal(env.tracker.merged.length, 0);
    // Nothing in flight — the request is acked immediately.
    assert.equal(env.store.getMeta('drain_ack'), requestId);
  } finally { env.done(); }
});

test('drain: the deferred recovery queue still drains while paused', async () => {
  const env = setup({ maxConcurrent: 1 });
  const h1 = hangingSession();
  try {
    let second = false;
    const engine = makeEngine(env, () => (second ? { pid: 42, prompt: async () => okTurn(), close: async () => {} } : ((second = true), h1.session)));

    const r1 = seedActiveRun(env, 1, 'RUNNING').run;
    const r2 = seedActiveRun(env, 2, 'RUNNING').run;
    assert.equal(engine.resumeRun(r1.run_id), true);
    assert.equal(engine.resumeRun(r2.run_id), false);
    await h1.entered;

    const requestId = requestDrain(env.store);
    h1.release();
    await waitFor(() => engine.activeCount() === 0);

    await engine.tick(); // paused: sweep launches the deferred resume, nothing else
    await waitFor(() => engine.activeCount() === 0);
    await engine.tick(); // quiet tick → ack
    assert.equal(env.store.getMeta('drain_ack'), requestId);
    assert.equal(env.store.getRun(r2.run_id)!.phase, 'AWAITING_REVIEW');
  } finally { h1.release(); env.done(); }
});

test('drain: no ack while a tick is still inside an async claim', async () => {
  const env = setup();
  const h = hangingSession();
  try {
    const engine = makeEngine(env, () => h.session);
    env.tracker.issues.set(1, { ...ISSUE });
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });

    // getIssue hangs inside tryDispatch — the tick is mid-claim.
    let markGetIssue!: () => void;
    let releaseGetIssue!: () => void;
    const issueEntered = new Promise<void>((r) => (markGetIssue = r));
    const issueGate = new Promise<void>((r) => (releaseGetIssue = r));
    const realGetIssue = env.tracker.getIssue.bind(env.tracker);
    env.tracker.getIssue = async (repo, n) => { markGetIssue(); await issueGate; return realGetIssue(repo, n); };

    const tickP = engine.tick();
    await issueEntered;
    const requestId = requestDrain(env.store);

    releaseGetIssue();
    await h.entered;
    await tickP;
    // The request could not be acked off a quiet-looking DB mid-tick: the
    // claim it raced is now an in-flight run.
    assert.notEqual(env.store.getMeta('drain_ack'), requestId);
    assert.equal(engine.activeCount(), 1);

    h.release();
    await waitFor(() => engine.activeCount() === 0);
    await engine.tick();
    assert.equal(env.store.getMeta('drain_ack'), requestId);
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
  } finally { h.release(); env.done(); }
});

test('drain: ack waits for session.close — in-flight set is the gate', async () => {
  const env = setup();
  const rel: { f?: () => void } = {};
  try {
    let markClose!: () => void;
    const closeEntered = new Promise<void>((r) => (markClose = r));
    const closeGate = new Promise<void>((r) => (rel.f = r));
    const session: CoderSession = {
      pid: 42,
      prompt: async () => okTurn(),
      close: async () => { markClose(); await closeGate; },
    };
    const engine = makeEngine(env, () => session);
    env.tracker.issues.set(1, { ...ISSUE });
    env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });

    await engine.tick();
    await closeEntered; // run finished its phases, session teardown in progress
    const requestId = requestDrain(env.store);
    await engine.tick();
    // in-flight (session.close pending) → no ack even though the run row ended.
    assert.notEqual(env.store.getMeta('drain_ack'), requestId);

    rel.f!();
    await waitFor(() => engine.activeCount() === 0);
    await engine.tick();
    assert.equal(env.store.getMeta('drain_ack'), requestId);
  } finally { rel.f?.(); env.done(); }
});

test('drain: pause persists across engine instances; undrain resumes dispatch', async () => {
  const env = setup();
  const h = hangingSession();
  try {
    const e1 = makeEngine(env, () => h.session);
    env.tracker.issues.set(1, { ...ISSUE });
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });

    const requestId = requestDrain(env.store);
    await e1.tick();
    assert.equal(env.store.getMeta('drain_ack'), requestId);

    // A fresh engine (as after a restart) still honors the persisted pause.
    const e2 = makeEngine(env, () => h.session);
    await e2.tick();
    assert.equal(env.store.getTaskById(task.id)!.status, 'DISCOVERED');

    resumeDispatch(env.store);
    const tickP = e2.tick();
    await h.entered;
    await tickP;
    h.release();
    await waitFor(() => e2.activeCount() === 0);
    assert.notEqual(env.store.getTaskById(task.id)!.status, 'DISCOVERED');
  } finally { h.release(); env.done(); }
});

// ---------------- CLI boundary (no service, no network) ----------------

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLI = resolve(REPO_ROOT, 'src/cli.ts');

function writeCliConfig(dir: string): string {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    'projects:',
    '  - repo: owner/repo',
    `    local_repo: '${dir.replace(/\\/g, '/')}'`,
    'agent:',
    '  model: test/coder',
  ].join('\n'), 'utf8');
  return path;
}

test('cli: drain times out without a running service and keeps the pause; undrain clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-drain-cli-'));
  try {
    const cfg = writeCliConfig(dir);
    const argv = (args: string[]) => [process.execPath, '--import', 'tsx', CLI, '--config', cfg, ...args];

    const drain = await runProc({ argv: argv(['drain', '--timeout-seconds', '2']), timeoutMs: 60_000, cwd: REPO_ROOT });
    assert.equal(drain.exitCode, 1, drain.stderrTail + drain.stdoutTail);
    assert.match(drain.stdoutTail + drain.stderrTail, /超时/);

    // The CLI wrote to config.server.database (agent.db), not the test default.
    const store = new Store(join(dir, 'agent.db'));
    try {
      assert.ok(store.getMeta('drain_requested'), 'pause flag must survive the timeout');
      assert.equal(store.getMeta('drain_ack'), '');
    } finally { store.close(); }

    const undrain = await runProc({ argv: argv(['undrain']), timeoutMs: 60_000, cwd: REPO_ROOT });
    assert.equal(undrain.exitCode, 0, undrain.stderrTail + undrain.stdoutTail);
    assert.match(undrain.stdoutTail, /恢复派单/);

    const status = await runProc({ argv: argv(['status']), timeoutMs: 60_000, cwd: REPO_ROOT });
    assert.equal(status.exitCode, 0, status.stderrTail + status.stdoutTail);
    assert.match(status.stdoutTail, /调度状态：运行中/);
  } finally { teardown(dir, []); }
});

test('cli: drain --timeout-seconds rejects non-positive integers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-drain-cli-'));
  try {
    const cfg = writeCliConfig(dir);
    const res = await runProc({
      argv: [process.execPath, '--import', 'tsx', CLI, '--config', cfg, 'drain', '--timeout-seconds', '0'],
      timeoutMs: 60_000,
      cwd: REPO_ROOT,
    });
    assert.equal(res.exitCode, 1);
    assert.match(res.stdoutTail + res.stderrTail, /正整数/);
  } finally { teardown(dir, []); }
});
