import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type EngineDeps } from '../src/scheduler/engine.js';
import { reconcile } from '../src/scheduler/recovery.js';
import { CODER_RESUME_NOTE } from '../src/scheduler/prompts.js';
import { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { CoderSession, CoderSessionOpts, CoderTurn } from '../src/runners/session.js';
import type { ChecksSummary } from '../src/verify/checks.js';
import type { AppConfig, Phase, ReviewResult } from '../src/types.js';
import { RUN_ACTIVE_PHASES } from '../src/types.js';
import type { Store } from '../src/store/sqlite.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';

async function waitFor(pred: () => boolean, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
}
const okTurn = (text = 'done'): CoderTurn => ({ ok: true, aborted: false, timedOut: false, exitCode: 0, lastMessage: text, durationMs: 1, stderrTail: '' });
const abortedTurn = (): CoderTurn => ({ ok: false, aborted: true, timedOut: false, exitCode: null, lastMessage: null, durationMs: 1, stderrTail: '' });
const okChecks = (): ChecksSummary => ({ ok: true, aborted: false, infraError: undefined, failureEvidence: '', outcomes: [], skipped: [] });
const reviewPass = async (): Promise<ReviewResult> => ({ verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] });
const ISSUE = { title: 'Fix parser', body: 'Fix the parsing bug.', labels: ['agent-ready'], state: 'OPEN', url: 'https://x/1' };

interface Env {
  dir: string; config: AppConfig; tracker: ReturnType<typeof makeFakeTracker>;
  store: Store; sessionOpts: CoderSessionOpts[];
  sessions: { entered: Promise<void>; release: () => void; prompts: string[] }[];
  done: () => void;
}

function setup(opts: { maxConcurrent?: number } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-shutdown-'));
  const config = makeConfig(dir);
  config.server.max_concurrent = opts.maxConcurrent ?? 1;
  config.server.poll_interval_seconds = 1;
  const env: Env = {
    dir, config, tracker: makeFakeTracker(), store: makeStore(dir),
    sessionOpts: [], sessions: [],
    done: () => { for (const s of env.sessions) s.release(); teardown(dir, [env.store]); },
  };
  return env;
}

/** Session factory: hanging prompt honoring abort; records opts + prompts. */
function makeSessionFactory(env: Env) {
  return (opts: CoderSessionOpts) => {
    env.sessionOpts.push(opts);
    let mark!: () => void; let rel!: () => void;
    const entered = new Promise<void>((r) => (mark = r));
    const gate = new Promise<void>((r) => (rel = r));
    const rec = { entered, release: () => rel(), prompts: [] as string[] };
    env.sessions.push(rec);
    const session: CoderSession = {
      pid: 42,
      prompt: (text, { signal }) => {
        rec.prompts.push(text); mark();
        return new Promise<CoderTurn>((res) => {
          if (signal?.aborted) { res(abortedTurn()); return; }
          let settled = false;
          const finish = () => { if (!settled) { settled = true; res(signal?.aborted ? abortedTurn() : okTurn()); } };
          signal?.addEventListener('abort', finish, { once: true });
          gate.then(finish);
        });
      },
      close: async () => {},
    };
    return session;
  };
}

function makeEngine(env: Env, extra: Partial<EngineDeps> = {}): Engine {
  return new Engine({
    store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
    workspace: new GitWorkspace(), appLog: nullLog,
    installDir: join(env.dir, 'install'),
    openCoderSessionFn: makeSessionFactory(env),
    runChecksFn: async () => okChecks(),
    runReviewFn: reviewPass as never,
    claimArbitrationMs: 0,
    recoveryProcessDeps: { isPidAlive: () => false, findProcs: async () => [] },
    ...extra,
  });
}

function seedActiveRun(env: Env, n: number, phase: Phase) {
  const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: n, issue_title: 't', issue_url: 'u' });
  env.store.setTaskStatus(task.id, 'RUNNING');
  const run = env.store.claimRun(task.id);
  if (phase !== 'CLAIMED') env.store.transition(run.run_id, 'CLAIMED', phase);
  const wt = join(env.dir, `wt-${n}`); mkdirSync(wt, { recursive: true });
  env.store.updateRunFields(run.run_id, { workspace: wt, branch: `agent/issue-${n}` });
  return { task, run: env.store.getRun(run.run_id)! };
}

function stubWorkspace(calls: string[]): GitWorkspace {
  // Every method the VERIFYING→PUBLISHING path touches gets an inert stub —
  // real git must never run in tests. resetHard/fetchBranch are recorded so
  // the resume path can prove it never rewrote the worktree.
  return new Proxy(new GitWorkspace(), {
    get(t, k: string | symbol) {
      if (k === 'resetHard' || k === 'fetchBranch') return async () => { calls.push(String(k)); };
      if (k === 'head') return async () => 'head-new';
      if (k === 'isDirty') return async () => false;
      if (k === 'statusPorcelain') return async () => '';
      if (k === 'aheadCount') return async () => 1;
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? async () => '' : v;
    },
  }) as GitWorkspace;
}

test('shutdown: an in-flight code run suspends — stays active, keeps claim, settles clean', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE, labels: ['agent-ready', 'agent-running'] });
    const { task, run: seeded } = seedActiveRun(env, 1, 'RUNNING');
    const engine = makeEngine(env);
    engine.resumeRun(seeded.run_id);
    assert.ok(await waitFor(() => env.sessions.length === 1));
    assert.ok(await waitFor(() => env.sessions.length > 0), 'coder session never started');
    await env.sessions[0]!.entered;

    const quiet = await engine.shutdown(5_000);

    assert.equal(quiet, true);
    const run = env.store.activeRuns()[0]!;
    assert.ok(run, 'run must stay active');
    assert.ok(RUN_ACTIVE_PHASES.includes(run.phase));
    assert.equal(run.ended_at, null);
    assert.equal(run.cancel_requested, 0);
    assert.notEqual(env.store.getTaskById(task.id)!.status, 'CANCELED');
    assert.ok(!env.tracker.labelsRemoved.some(([, l]) => l === 'agent-running'), 'claim label kept');
    const suspendEvents = env.store.eventsForRun(run.run_id)
      .filter((e) => (e.detail_json ?? '').includes('service_shutdown'));
    assert.equal(suspendEvents.length, 1, 'suspend marker written once');
  } finally { env.done(); }
});

test('shutdown then reconcile: same run resumes with same session binding + resume note once', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { run } = seedActiveRun(env, 1, 'RUNNING');
    const e1 = makeEngine(env);
    (e1 as unknown as { launch(id: string): void }).launch(run.run_id); // first boot: no resume budget spent
    assert.ok(await waitFor(() => env.sessions.length > 0), 'coder session never started');
    await env.sessions[0]!.entered;
    const firstOpts = env.sessionOpts[0]!;
    assert.equal(firstOpts.sessionId, run.run_id);
    assert.ok(firstOpts.sessionDir!.endsWith('pi-session'));
    assert.ok(!env.sessions[0]!.prompts[0]!.startsWith(CODER_RESUME_NOTE), 'first boot: no resume note');

    assert.equal(await e1.shutdown(5_000), true);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RUNNING'); // suspended, still active

    // Simulated restart: fresh engine, real reconcile.
    const e2 = makeEngine(env);
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: e2, isPidAlive: () => false, findProcs: async () => [],
    });
    assert.deepEqual(report.resumed, [run.run_id]);
    assert.ok(await waitFor(() => env.sessions.length > 1), 'resumed session never started');
    await env.sessions[1]!.entered;
    const secondOpts = env.sessionOpts[1]!;
    assert.equal(secondOpts.sessionId, run.run_id);
    assert.equal(secondOpts.sessionDir, firstOpts.sessionDir);
    assert.ok(env.sessions[1]!.prompts[0]!.startsWith(CODER_RESUME_NOTE + '\n\n'), 'resumed turn carries the note');
  } finally { env.done(); }
});

test('shutdown: explicit user cancel still lands CANCELED, reconcile does not revive it', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task, run } = seedActiveRun(env, 1, 'RUNNING');
    const e1 = makeEngine(env);
    e1.resumeRun(run.run_id);
    assert.ok(await waitFor(() => env.sessions.length > 0), 'coder session never started');
    await env.sessions[0]!.entered;
    env.store.requestCancel(run.run_id);
    assert.equal(await e1.shutdown(5_000), true);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'CANCELED');
    const e2 = makeEngine(env);
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: e2, isPidAlive: () => false, findProcs: async () => [],
    });
    assert.equal(report.resumed.length, 0);
    assert.equal(env.sessions.length, 1);
  } finally { env.done(); }
});

test('shutdown: a hanging session.close makes shutdown return false at the deadline', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { run } = seedActiveRun(env, 1, 'RUNNING');
    let markPrompt!: () => void;
    const promptEntered = new Promise<void>((r) => (markPrompt = r));
    const hangClose: CoderSession = {
      pid: 1,
      // Prompt honors the abort (the run suspends); close() never settles —
      // the run's finally keeps inFlight held, so shutdown must report false.
      prompt: (_t, { signal }) => new Promise<CoderTurn>((res) => {
        markPrompt();
        signal?.addEventListener('abort', () => res(abortedTurn()), { once: true });
      }),
      close: () => new Promise(() => {}),
    };
    const engine = makeEngine(env, { openCoderSessionFn: () => hangClose });
    engine.resumeRun(run.run_id);
    await promptEntered;
    const qr = await engine.shutdown(400);
    assert.equal(qr, false);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'RUNNING', 'run suspended, still active');
  } finally { env.done(); }
});

test('shutdown: an in-flight review run cancels to AWAITING_REVIEW, no verdict row', async () => {
  const env = setup();
  try {
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    env.store.setTaskStatus(task.id, 'REVIEWING');
    env.tracker.issues.set(1, { ...ISSUE });
    const run = env.store.claimRun(task.id, { kind: 'review', headSha: 'sha-1' });
    env.store.transition(run.run_id, 'CLAIMED', 'REVIEWING');
    env.store.updateRunFields(run.run_id, { pr_url: 'https://x/pull/9' });
    const engine = makeEngine(env, { runReviewFn: (() => new Promise(() => {})) as never });
    engine.resumeRun(run.run_id);
    await waitFor(() => engine.activeCount() === 1);

    assert.equal(await engine.shutdown(5_000), true);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
    assert.equal(env.store.checksForRun(run.run_id).filter((c) => c.kind === 'review').length, 0);
  } finally { env.done(); }
});

test('shutdown blocks new work: tick and resume are no-ops while stopping', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    const engine = makeEngine(env);
    assert.equal(await engine.shutdown(2_000), true);
    await engine.tick();
    assert.equal(engine.activeCount(), 0);
    assert.equal(env.sessions.length, 0);
    const { run } = seedActiveRun(env, 2, 'RUNNING');
    assert.equal(engine.resumeRun(run.run_id), true); // left active, not launched
    assert.equal(env.store.getRun(run.run_id)!.resume_count, 0, 'no budget spent');
    assert.equal(env.sessions.length, 0);
  } finally { env.done(); }
});

test('resume: a consumed pending_fix restores fix intent — no resetHard, prompt keeps instructions', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { run } = seedActiveRun(env, 1, 'RUNNING');
    env.store.setTaskStatus(run.task_id, 'MERGING', { approved_sha: 'sha-1', approved_by: 'human' });
    env.store.updateRunFields(run.run_id, { pr_url: 'https://x/pull/9' });
    env.store.transition(run.run_id, 'RUNNING', 'RUNNING', {
      kind: 'pending_fix_consumed', head_sha: 'sha-1', title: '自动合并受阻',
      summary: 'conflict', findings: ['f1'],
    });
    const wsCalls: string[] = [];
    const ws = {
      head: async () => 'head-sha', isDirty: async () => false, aheadCount: async () => 0,
      statusPorcelain: async () => '',
      fetchBranch: async () => { wsCalls.push('fetch'); },
      resetHard: async () => { wsCalls.push('reset'); },
    } as unknown as GitWorkspace;
    const engine = makeEngine(env, { workspace: ws });
    assert.equal(engine.resumeRun(run.run_id), true);
    assert.ok(await waitFor(() => env.sessions.length > 0), 'coder session never started');
    await env.sessions[0]!.entered;

    const prompt = env.sessions[0]!.prompts[0]!;
    assert.ok(prompt.startsWith(CODER_RESUME_NOTE + '\n\n'));
    assert.ok(prompt.includes('自动合并受阻') && prompt.includes('conflict'), 'original fix instructions kept');
    assert.ok(!wsCalls.includes('resetHard'), 'resumed run must never resetHard');
    assert.equal(env.store.getRun(run.run_id)!.fix_count, 0, 'fix budget not reset');
  } finally { env.done(); }
});

test('resume: a corrupt pending_fix_consumed event parks the run, never guesses', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task, run } = seedActiveRun(env, 1, 'RUNNING');
    env.store.transition(run.run_id, 'RUNNING', 'RUNNING', {
      kind: 'pending_fix_consumed', head_sha: 42, summary: 's', findings: ['f'],
    } as never);
    const engine = makeEngine(env);
    assert.equal(engine.resumeRun(run.run_id), true);
    assert.ok(await waitFor(() => env.store.getRun(run.run_id)!.phase === 'RECOVERY_REQUIRED'));
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.equal(env.sessions.length, 0, 'no session spawned');
  } finally { env.done(); }
});

test('shutdown: a coder turn that THROWS under an explicit cancel still lands CANCELED', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task, run } = seedActiveRun(env, 1, 'RUNNING');
    let mark!: () => void;
    const entered = new Promise<void>((r) => (mark = r));
    const dying: CoderSession = {
      pid: 1,
      prompt: (_t, { signal }) => new Promise<CoderTurn>((_res, rej) => {
        mark();
        signal?.addEventListener('abort', () => rej(new Error('killed')), { once: true });
      }),
      close: async () => {},
    };
    const e1 = makeEngine(env, { openCoderSessionFn: () => dying });
    e1.resumeRun(run.run_id);
    await entered;
    env.store.requestCancel(run.run_id);
    assert.equal(await e1.shutdown(5_000), true);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.equal(env.store.getTaskById(task.id)!.status, 'CANCELED');
    const e2 = makeEngine(env);
    const report = await reconcile({
      store: env.store, config: env.config, tracker: env.tracker as unknown as GitHubTracker,
      appLog: nullLog, engine: e2, isPidAlive: () => false, findProcs: async () => [],
    });
    assert.equal(report.resumed.length, 0);
  } finally { env.done(); }
});

for (const phase of ['VERIFYING', 'FIXING'] as const) {
  test(`resume at ${phase}: consumed merge repair lands back in MERGING with human approval kept`, async () => {
    const env = setup();
    try {
      env.tracker.issues.set(1, { ...ISSUE });
      const { task, run } = seedActiveRun(env, 1, phase);
      env.store.setTaskStatus(task.id, 'MERGING', { approved_sha: 'sha-old', approved_by: 'human' });
      env.store.updateRunFields(run.run_id, { pr_url: 'https://x/pull/9', fix_count: 1 });
      env.store.transition(run.run_id, phase, phase, {
        kind: 'pending_fix_consumed', head_sha: 'sha-old', title: '自动合并受阻',
        summary: 'conflict', findings: ['f1'],
      });
      const wsCalls: string[] = [];
      const engine = makeEngine(env, { workspace: stubWorkspace(wsCalls) });
      engine.resumeRun(run.run_id);
      assert.ok(await waitFor(() => env.store.getRun(run.run_id)!.ended_at !== null, 300));

      const after = env.store.getRun(run.run_id)!;
      const afterTask = env.store.getTaskById(task.id)!;
      assert.ok(!wsCalls.includes('resetHard'), 'resumed run must never resetHard');
      assert.ok(after.fix_count >= 1, 'fix_count preserved, never reset');
      assert.equal(afterTask.status, 'MERGING', 'merge repair publish must land back in MERGING');
      assert.equal(afterTask.approved_by, 'human', 'human approval source preserved');
      assert.equal(afterTask.approved_sha, 'head-new');
      assert.equal(after.phase, 'COMPLETED');
    } finally { env.done(); }
  });
}

test('resume: FIXING gets the note on its first real turn, not on later turns', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { run } = seedActiveRun(env, 1, 'VERIFYING');
    env.store.updateRunFields(run.run_id, { pr_url: 'https://x/pull/9' });
    let failsLeft = 2; // two FIXING turns: first with note, second without
    const engine = makeEngine(env, {
      workspace: stubWorkspace([]),
      runChecksFn: async () => failsLeft-- > 0
        ? { ok: false, aborted: false, infraError: undefined, failureEvidence: 'test failed', outcomes: [], skipped: [] }
        : okChecks(),
    });
    engine.resumeRun(run.run_id);
    assert.ok(await waitFor(() => env.sessions.length > 0));
    await env.sessions[0]!.entered;
    env.sessions[0]!.release(); // gates are shared — both FIXING turns may proceed
    assert.ok(await waitFor(() => env.sessions[0]!.prompts.length >= 2, 300), 'second turn never ran');
    const [p1, p2] = env.sessions[0]!.prompts;
    assert.ok(p1!.startsWith(CODER_RESUME_NOTE + '\n\n'), 'first resumed turn carries the note');
    assert.ok(!p2!.startsWith(CODER_RESUME_NOTE), 'second turn in same process does not repeat it');
  } finally { env.done(); }
});

test('shutdown mid-claim: tick stuck in getIssue claims nothing new on release', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    let mark!: () => void; let rel!: () => void;
    const gateEntered = new Promise<void>((r) => (mark = r));
    const gate = new Promise<void>((r) => (rel = r));
    const tracker = env.tracker as unknown as GitHubTracker & { getIssue: (n: number) => Promise<unknown> };
    const orig = tracker.getIssue.bind(tracker);
    let released = false;
    (tracker as unknown as { getIssue: unknown }).getIssue = async (repo: string, n: number) => {
      mark();
      if (!released) await gate;
      return orig(repo, n);
    };
    const engine = makeEngine(env);
    const tickP = engine.tick();
    await gateEntered;
    const shutP = engine.shutdown(5_000);
    released = true;
    rel();
    await tickP;
    assert.equal(await shutP, true);
    assert.equal(env.sessions.length, 0, 'no spawn after shutdown');
    // The stopping guard sits before claimRun: no claim happens mid-shutdown
    // and the task waits DISCOVERED for the next boot's dispatch.
    assert.equal(env.store.activeRuns().length, 0, 'no claim made after shutdown');
    assert.equal((env.store.db.prepare('SELECT status FROM tasks').get() as { status: string }).status, 'DISCOVERED');
  } finally { env.done(); }
});

test('session restore failure parks RECOVERY_REQUIRED — no respawn, no cold redo', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task, run } = seedActiveRun(env, 1, 'RUNNING');
    const { SessionRestoreError } = await import('../src/runners/session.js');
    const broken: CoderSession = {
      pid: 1,
      prompt: async () => { throw new SessionRestoreError('pi opened empty conversation'); },
      close: async () => {},
    };
    const engine = makeEngine(env, { openCoderSessionFn: () => broken });
    engine.resumeRun(run.run_id);
    assert.ok(await waitFor(() => env.store.getRun(run.run_id)!.phase === 'RECOVERY_REQUIRED'));
    assert.equal(env.store.getTaskById(task.id)!.status, 'RECOVERY_REQUIRED');
    assert.ok(env.store.getRun(run.run_id)!.reason!.includes('session restore'));
  } finally { env.done(); }
});

test('app wiring: SIGTERM reaches engine.shutdown, never abortRun, then releases', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { existsSync, rmSync } = await import('node:fs');
  const fixtureDir = mkdtempSync(join(process.env.AGENT_CONTROL_TEST_TMP ?? tmpdir(), 'ac-appfx-'));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath,
    ['--import', 'tsx', 'tests/fixtures/app-shutdown-child.mts', fixtureDir], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise<number | null>((res) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); res(null); }, 30_000);
    child.on('exit', (c) => { clearTimeout(t); res(c); });
  });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `fixture produced no RESULT (code ${code}): ${out.slice(-300)} | ${err.slice(-300)}`);
  const result = JSON.parse(line.slice(7)) as { calls: string[] };
  assert.ok(result.calls.includes('tick'));
  assert.ok(result.calls.includes('shutdown'), 'SIGTERM must drive engine.shutdown');
  assert.ok(!result.calls.includes('abortRun'), 'shutdown must not cancel runs');
  // startService released the instance lock before exit.
  assert.equal(existsSync(join(fixtureDir, 'agent-control.lock')), false, 'lock released on exit');
  rmSync(fixtureDir, { recursive: true, force: true });
});

test('cancel+throw releases the agent-running claim via the normal finish path', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { run } = seedActiveRun(env, 1, 'RUNNING');
    let mark!: () => void;
    const entered = new Promise<void>((r) => (mark = r));
    const dying: CoderSession = {
      pid: 1,
      prompt: (_t, { signal }) => new Promise<CoderTurn>((_res, rej) => {
        mark();
        signal?.addEventListener('abort', () => rej(new Error('killed')), { once: true });
      }),
      close: async () => {},
    };
    const e1 = makeEngine(env, { openCoderSessionFn: () => dying });
    e1.resumeRun(run.run_id);
    await entered;
    env.store.requestCancel(run.run_id);
    assert.equal(await e1.shutdown(5_000), true);
    assert.equal(env.store.getRun(run.run_id)!.phase, 'CANCELED');
    assert.ok(
      await waitFor(() => env.tracker.labelsRemoved.some(([n, l]) => n === 1 && l === 'agent-running'), 100),
      'cancel finish must release the agent-running claim',
    );
  } finally { env.done(); }
});

test('shutdown pauses mid-driveMerge: no markPrReady/merge after getPrDetails gate', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    env.store.setTaskStatus(task.id, 'MERGING', { approved_sha: 'head-sha', approved_by: 'review', pr_url: 'https://x/pull/9' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: true });
    (env.tracker as unknown as { headSha: string }).headSha = 'head-sha';
    const tracker = env.tracker as unknown as GitHubTracker & { getPrDetails: (r: string, n: number) => Promise<unknown>; markPrReady: (r: string, n: number) => Promise<void> };
    const origDetails = tracker.getPrDetails.bind(env.tracker as never);
    const ready: number[] = [];
    tracker.markPrReady = async (_r, n) => { ready.push(n); };
    let rel!: () => void;
    const gate = new Promise<void>((r) => (rel = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    (tracker as unknown as { getPrDetails: unknown }).getPrDetails = async (repo: string, n: number) => {
      entered();
      await gate;
      return (origDetails as (r: string, n: number) => Promise<unknown>)(repo, n);
    };
    const engine = makeEngine(env);
    const tickP = engine.tick();
    await enteredP;
    const shutP = engine.shutdown(5_000);
    rel();
    await tickP;
    assert.equal(await shutP, true);
    assert.equal(ready.length, 0, 'no markPrReady after shutdown');
    assert.equal(env.tracker.merged.length, 0, 'no merge after shutdown');
    assert.equal(env.store.getTaskById(task.id)!.status, 'MERGING');
  } finally { env.done(); }
});

test('shutdown pauses mid-human-approval: agent-merge label not consumed', async () => {
  const env = setup();
  try {
    env.tracker.issues.set(1, { ...ISSUE });
    const { task } = env.store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    env.store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/9' });
    env.tracker.prs.set('agent/issue-1', { number: 9, url: 'https://x/pull/9', state: 'OPEN', isDraft: false });
    env.tracker.prLabels.set(9, ['agent-merge']);
    const tracker = env.tracker as unknown as GitHubTracker & { getPrDetails: (r: string, n: number) => Promise<unknown> };
    const origDetails = tracker.getPrDetails.bind(env.tracker as never);
    let rel!: () => void;
    const gate = new Promise<void>((r) => (rel = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    (tracker as unknown as { getPrDetails: unknown }).getPrDetails = async (repo: string, n: number) => {
      entered();
      await gate;
      return (origDetails as (r: string, n: number) => Promise<unknown>)(repo, n);
    };
    const engine = makeEngine(env);
    const tickP = engine.tick();
    await enteredP;
    const shutP = engine.shutdown(5_000);
    rel();
    await tickP;
    assert.equal(await shutP, true);
    assert.deepEqual(env.tracker.prLabels.get(9), ['agent-merge'], 'one-shot approval label not consumed');
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_HUMAN', 'task not advanced to MERGING');
    assert.equal(env.tracker.merged.length, 0);
  } finally { env.done(); }
});
