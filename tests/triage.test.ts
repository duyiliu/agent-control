import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueTriage } from '../src/triage/service.js';
import { Engine } from '../src/scheduler/engine.js';
import type { GitWorkspace } from '../src/workspace/git.js';
import {
  CLAIM_MARKER, HUMAN_HOLD, MANAGED, NEEDS_HUMAN, RUNNING,
  claimBody, initialState, inputComments, inputHash, parseDecision, readState, stateBody, visibleStatus,
  type IssueComment, type TriageState,
} from '../src/triage/state.js';
import type { IssueData } from '../src/types.js';
import { GitHubTracker, requiredLabelsForProject, TRIAGE_LABELS } from '../src/tracker/github.js';
import type { ProcResult } from '../src/proc.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog } from './helpers.js';

const SHA = 'a'.repeat(40);

function comment(id: number, body: string, author = 'agent-control', createdAt = new Date().toISOString(), authorType = 'User'): IssueComment {
  return { id, body, author, authorType, createdAt, updatedAt: createdAt };
}

test('triage decisions are strict and issue fingerprints ignore only machine markers and bot comments', () => {
  assert.deepEqual(parseDecision('{"decision":"AUTO","reason_code":"clear_in_scope"}'), { decision: 'AUTO', reason_code: 'clear_in_scope' });
  for (const text of [
    '{"decision":"AUTO","reason_code":"clear_in_scope","extra":true}',
    '{"decision":"AUTO","reason_code":"high_risk"}',
    '{"decision":"HUMAN","reason_code":"unknown"}',
  ]) assert.throws(() => parseDecision(text));

  const issue: IssueData = { number: 21, title: 'Need a setting', body: 'Add one setting', labels: [], state: 'OPEN', url: 'https://github.com/o/r/issues/21' };
  const first = inputHash(issue, [comment(1, 'Please keep this option optional', 'alice')], 'agent-control');
  const comments = [
    comment(1, 'Please keep this option optional', 'alice'),
    comment(2, 'Automated reminder', 'some-bot[bot]', new Date().toISOString(), 'Bot'),
  ];
  const hashWithMachineData = inputHash(issue, [
    ...comments,
    comment(3, `${CLAIM_MARKER}\nclaim`, 'agent-control'),
    comment(4, '<!-- agent-control:triage-state:v1 -->\nstate', 'agent-control'),
    comment(5, 'agent-control: 已领取（`host`）', 'agent-control'),
  ], 'agent-control');
  assert.equal(first, hashWithMachineData);
  assert.deepEqual(inputComments([
    comment(1, 'Please keep this option optional', 'alice'),
    comment(2, 'Automated reminder', 'some-bot[bot]', new Date().toISOString(), 'Bot'),
    comment(3, `${CLAIM_MARKER}\nclaim`, 'agent-control'),
    comment(5, 'agent-control: 已领取（`host`）', 'agent-control'),
    comment(6, 'I confirm this requirement.', 'agent-control'),
  ], 'agent-control').map(c => c.id), [1, 6]);
  assert.notEqual(first, inputHash({ ...issue, body: 'Different request' }, [], 'agent-control'));
  assert.equal(visibleStatus({ ...issue, labels: [NEEDS_HUMAN] }, null), 'human');
  assert.equal(visibleStatus({ ...issue, labels: [HUMAN_HOLD] }, null), 'human');
  assert.ok(TRIAGE_LABELS.every(label => !requiredLabelsForProject('agent-ready', false).includes(label)));
  assert.ok(requiredLabelsForProject('agent-ready', true).includes(HUMAN_HOLD));
  assert.ok(!requiredLabelsForProject('agent-ready', true).includes('agent-ready'));
  assert.ok(!requiredLabelsForProject('agent-ready', true).includes(MANAGED));
});

test('GitHub open-issue discovery paginates all pages and filters pull requests', async () => {
  const calls: string[] = [];
  const exec = async (opts: { argv: string[] }): Promise<ProcResult> => {
    const endpoint = opts.argv.find(a => a.startsWith('repos/')) ?? '';
    calls.push(endpoint);
    const page = Number(/(?:\?|&)page=(\d+)/.exec(endpoint)?.[1]);
    const rows = page === 1
      ? Array.from({ length: 50 }, (_, i) => ({ number: i + 1, title: `#${i + 1}`, body: '', labels: [], html_url: `u/${i + 1}`, updated_at: '', created_at: '', ...(i === 3 ? { pull_request: {} } : {}) }))
      : [{ number: 51, title: '#51', body: '', labels: [], html_url: 'u/51', updated_at: '', created_at: '' }];
    return { exitCode: 0, signal: null, timedOut: false, aborted: false, stdoutTail: JSON.stringify(rows), stderrTail: '', stdoutTruncated: false, durationMs: 1 };
  };
  const tracker = new GitHubTracker(exec as never, 'gh');
  const issues = await tracker.listOpenIssues('owner/repo');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /page=1/);
  assert.match(calls[1]!, /page=2/);
  assert.equal(issues.length, 50);
  assert.ok(!issues.some(i => i.number === 4));
  assert.equal(issues.at(-1)?.number, 51);
});


function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-intake-'));
  const config = makeConfig(dir); config.projects[0]!.issue_intake = 'all';
  const store = makeStore(dir);
  const fake = makeFakeTracker();
  fake.issues.set(8, { title: 'Issue 8', body: 'request', labels: [], state: 'OPEN', url: 'https://github.com/me/sandbox/issues/8' });
  let comments: IssueComment[] = [];
  let modelCalls = 0;
  const tracker = Object.assign(fake, {
    listOpenIssues: async () => [...fake.issues.entries()].map(([number, issue]) => ({ number, ...issue })),
    issueComments: async () => structuredClone(comments), authLogin: async () => 'agent-control',
    createIssueComment: async () => { throw new Error('must not create triage claim'); },
    editIssueComment: async () => { throw new Error('must not edit triage state'); },
  });
  const triage = new IssueTriage({ config, store, tracker, workspace: {} as never, appLog: nullLog,
    runModel: async () => { modelCalls++; throw new Error('must not evaluate separately'); } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, store, fake, tracker, triage, setComments: (v: IssueComment[]) => comments = v, modelCalls: () => modelCalls };
}

test('all intake queues unlabeled issues once without a model or triage claims', async t => {
  const f = setup(t); await f.triage.scan(); await f.triage.scan();
  const task = f.store.getTask('me/sandbox', 8)!;
  assert.equal(task.status, 'DISCOVERED'); assert.equal(f.store.listTasks().length, 1);
  assert.equal(f.modelCalls(), 0); assert.equal(f.triage.activeCount(), 0);
  assert.equal(f.fake.labelsAdded.length, 0);
  assert.ok(await f.triage.authorize(f.config.projects[0]!, (await f.tracker.getIssue('me/sandbox', 8))!));
  f.store.setTaskStatus(task.id, 'COMPLETED'); await f.triage.scan();
  assert.equal(f.store.getTaskById(task.id)!.status, 'COMPLETED');
});

test('legacy deferred and skipped decisions become unique blocked cards and stay parked after edits', async t => {
  const f = setup(t); const old = initialState('old'); old.decision = 'DEFER'; old.reason_code = 'temporary_wait';
  f.setComments([comment(1, stateBody(old))]); await f.triage.scan();
  assert.equal(f.triage.state('me/sandbox', 8)?.kind, 'deferred');
  assert.equal(f.store.getTask('me/sandbox', 8)?.status, 'BLOCKED');
  f.fake.issues.get(8)!.body = 'new content'; await f.triage.scan();
  assert.equal(f.triage.state('me/sandbox', 8)?.kind, 'deferred'); assert.equal(f.store.listTasks().length, 1);
});

test('missing or untrusted legacy state is a visible blocked quarantine card', async t => {
  const f = setup(t); f.fake.issues.get(8)!.labels = [MANAGED]; await f.triage.scan();
  assert.equal(f.triage.state('me/sandbox', 8)?.imported, false);
  assert.equal(f.store.getTask('me/sandbox', 8)?.status, 'BLOCKED');
  assert.equal(await f.triage.authorize(f.config.projects[0]!, (await f.tracker.getIssue('me/sandbox', 8))!), null);
});

test('lock and repeated unlock are local, versioned, and never re-lock', async t => {
  const f = setup(t); await f.triage.scan();
  const locked = await f.triage.action('me/sandbox', 8, 'lock', { expected_version: 1 });
  assert.equal(locked.locked, true);
  await assert.rejects(f.triage.action('me/sandbox', 8, 'defer', { expected_version: 1 }), /状态已变化/);
  const unlocked = await f.triage.action('me/sandbox', 8, 'unlock', { expected_version: locked.version });
  const duplicate = await f.triage.action('me/sandbox', 8, 'unlock', { expected_version: locked.version });
  assert.equal(duplicate.version, unlocked.version); assert.equal(duplicate.locked, false);
  await f.triage.shutdown(); assert.equal(f.triage.state('me/sandbox', 8)?.locked, false);
  assert.equal(f.fake.labelsAdded.some(([, label]) => label === HUMAN_HOLD), false);
});

test('slow GitHub synchronization returns a saved action and never clears other blockers on unlock', async t => {
  const f = setup(t); await f.triage.scan();
  const deferred = await f.triage.action('me/sandbox', 8, 'defer', { expected_version: 1 });
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const original = f.tracker.getIssue; f.tracker.getIssue = async (...args) => { await gate; return original(...args); };
  const state = await f.triage.action('me/sandbox', 8, 'approve', { expected_version: deferred.version });
  assert.ok(state.pending); assert.ok(f.triage.state('me/sandbox', 8)?.pending);
  release(); await f.triage.shutdown();
});

test('old active jobs remain quarantined without spawning another model', async t => {
  const f = setup(t); f.store.saveTriageJob('old', { id: 'old', repo: 'me/sandbox', number: 8, pid: 123 });
  await f.triage.scan(); assert.equal(f.triage.state('me/sandbox', 8)?.imported, false);
  assert.equal(f.modelCalls(), 0); assert.equal(f.store.triageJobs().length, 1);
});

test('agent result JSON is strict', async () => {
  const { parseOutcome, acceptsAllIssues } = await import('../src/triage/intake.js');
  assert.equal(parseOutcome('{"outcome":"NEEDS_HUMAN","reason":"missing acceptance criteria"}').outcome, 'NEEDS_HUMAN');
  for (const text of ['ok', '{"outcome":"IMPLEMENTED","reason":""}', '{"outcome":"AUTO","reason":"x"}', '{"outcome":"IMPLEMENTED","reason":"x","extra":1}']) assert.throws(() => parseOutcome(text));
  const p = makeConfig('.').projects[0]!; p.issue_triage = { enabled: true, timeout_seconds: 180 };
  assert.ok(acceptsAllIssues(p)); p.issue_intake = 'labeled'; assert.equal(acceptsAllIssues(p), false);
});

test('continue synchronizes human labels then retries without agent-ready, duplicate clicks add no runs', async t => {
  const f = setup(t); f.fake.issues.get(8)!.labels = [HUMAN_HOLD, NEEDS_HUMAN]; await f.triage.scan();
  const first = f.triage.state('me/sandbox', 8)!;
  assert.equal(first.kind, 'human');
  const resumed = await f.triage.action('me/sandbox', 8, 'approve', { expected_version: first.version });
  for (let n = 0; n < 50 && f.triage.state('me/sandbox', 8)?.pending; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.triage.state('me/sandbox', 8)?.error, null);
  assert.equal(f.store.getTask('me/sandbox', 8)?.status, 'DISCOVERED');
  assert.deepEqual(f.fake.issues.get(8)?.labels, []);
  assert.equal(f.store.runsForTask(f.store.getTask('me/sandbox', 8)!.id).length, 0);
  const duplicate = await f.triage.action('me/sandbox', 8, 'approve', { expected_version: first.version });
  assert.equal(duplicate.version, resumed.version);
  await f.triage.shutdown();
});

test('unlock preserves deferred disposition and stale requests cannot change it', async t => {
  const f = setup(t); await f.triage.scan();
  const deferred = await f.triage.action('me/sandbox', 8, 'defer', { expected_version: 1 });
  const locked = await f.triage.action('me/sandbox', 8, 'lock', { expected_version: deferred.version });
  const unlocked = await f.triage.action('me/sandbox', 8, 'unlock', { expected_version: locked.version });
  assert.equal(unlocked.kind, 'deferred'); assert.equal(unlocked.locked, false);
  await f.triage.shutdown(); assert.equal(f.store.getTask('me/sandbox', 8)?.status, 'BLOCKED');
});

test('a newer human lock cancels an older queued resume even when synchronization is slow', async t => {
  const f = setup(t); await f.triage.scan();
  const deferred = await f.triage.action('me/sandbox', 8, 'defer', { expected_version: 1 });
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const original = f.tracker.getIssue; f.tracker.getIssue = async (...args) => { await gate; return original(...args); };
  const resumed = await f.triage.action('me/sandbox', 8, 'approve', { expected_version: deferred.version });
  const locked = await f.triage.action('me/sandbox', 8, 'lock', { expected_version: resumed.version });
  assert.equal(locked.pending, null); release();
  for (let n = 0; n < 5; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.triage.state('me/sandbox', 8)?.locked, true);
  assert.equal(f.triage.state('me/sandbox', 8)?.pending, null);
  assert.equal(f.store.getTask('me/sandbox', 8)?.status, 'BLOCKED'); await f.triage.shutdown();
});
