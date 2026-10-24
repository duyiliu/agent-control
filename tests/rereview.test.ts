import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveMergeTask, rereviewTask } from '../src/ops.js';
import { approvalHash } from '../src/tracker/github.js';
import { emptyIntake } from '../src/triage/intake.js';
import { taskPayload } from '../src/ui/api.js';
import { startUiServer } from '../src/ui/server.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown, tmpDir } from './helpers.js';

function setup(source: 'issue' | 'pr' = 'issue') {
  const dir = tmpDir('ac-rereview-'); const store = makeStore(dir); const config = makeConfig(dir); const tracker = makeFakeTracker();
  tracker.issues.set(1, { title: 't', body: 'approved', state: 'OPEN', labels: ['agent-ready'], url: 'u' });
  const task = source === 'pr'
    ? store.upsertPrTask({ repo: 'me/sandbox', number: 1, title: 't', url: 'https://x/pull/42', branch: 'feature' }).task
    : store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' }).task;
  const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha' });
  store.endRun(run.run_id, 'AWAITING_HUMAN', 'review PASS but high risk: reviewer marked risk=high');
  store.addCheck({ run_id: run.run_id, kind: 'review', command: 'review', verdict: 'PASS', exit_code: null, head_sha: 'sha' });
  store.addCheck({ run_id: run.run_id, kind: 'check', command: 'npm test', verdict: 'PASS', exit_code: 0, head_sha: 'sha' });
  store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/42', approved_sha: 'sha', approved_by: 'human', approved_hash: approvalHash(tracker.issues.get(1)!) });
  tracker.prLabels.set(42, ['agent-merge']);
  return { dir, store, config, tracker, run, get task() { return store.getTaskById(task.id)!; }, done: () => teardown(dir, [store]) };
}

test('rereview preserves code/check evidence, withdraws approval, and only requeues review', async () => {
  const e = setup();
  try {
    await rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at);
    assert.equal(e.task.status, 'AWAITING_REVIEW');
    assert.equal(e.task.approved_sha, null);
    assert.equal(e.task.approved_by, null);
    assert.equal(e.store.runsForTask(e.task.id).length, 1);
    assert.equal(e.store.hasReviewVerdictForSha(e.task.id, 'sha'), false);
    assert.equal(e.store.checkEvidenceForSha(e.task.id, 'sha')[0]!.verdict, 'PASS');
    assert.ok(e.store.eventsForRun(e.run.run_id).some(r => r.detail_json?.includes('review_requeued')));
    assert.deepEqual(e.tracker.prLabels.get(42), []);
    assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});

for (const state of ['CLOSED', 'MERGED'] as const) test(`rereview refuses ${state} PR without deleting evidence`, async () => {
  const e = setup();
  try {
    e.tracker.prStates.set(42, state);
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at), /已关闭、已合并/);
    assert.equal(e.store.hasReviewVerdictForSha(e.task.id, 'sha'), true);
    assert.equal(e.task.status, 'AWAITING_HUMAN');
  } finally { e.done(); }
});

test('rereview refuses manual mode, stale versions, changed requirements and external ownership', async () => {
  const e = setup();
  try {
    e.config.projects[0]!.review_mode = 'manual';
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at), /人工评审/);
    e.config.projects[0]!.review_mode = 'auto';
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, 'old'), /状态已变化/);
    e.tracker.issues.get(1)!.body = 'changed';
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at), /内容已变化/);
    e.tracker.issues.get(1)!.body = 'approved';
    e.tracker.issues.get(1)!.labels.push('agent-running');
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at), /其他运行持有/);
    e.tracker.issues.get(1)!.labels = ['agent-ready'];
    e.store.saveIntake('me/sandbox', 1, { ...emptyIntake(), locked: true });
    await assert.rejects(rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at), /人工门禁/);
    assert.equal(e.store.hasReviewVerdictForSha(e.task.id, 'sha'), true);
  } finally { e.done(); }
});

test('rereview compares state again after remote calls and concurrent requests cannot both queue', async () => {
  const e = setup();
  try {
    const task = e.task;
    const results = await Promise.allSettled([1, 2].map(() => rereviewTask(e.store, e.config, e.tracker, task, task.updated_at)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal(e.store.runsForTask(task.id).length, 1);
  } finally { e.done(); }
});

test('independent PR exposes rereview but never merge approval', async () => {
  const e = setup('pr');
  try {
    e.config.projects[0]!.review_mode = 'manual';
    const detail = taskPayload(e.store, e.task.id, e.config)!;
    assert.equal(detail.task.actions!.approve_merge, false);
    assert.equal(detail.task.actions!.rereview, true);
    await rereviewTask(e.store, e.config, e.tracker, e.task, e.task.updated_at);
    assert.equal(e.task.source, 'pr');
    assert.equal(e.task.status, 'AWAITING_REVIEW');
  } finally { e.done(); }
});

for (const first of ['approve', 'rereview'] as const) test(`approval and rereview serialize with ${first} first`, async () => {
  const e = setup();
  try {
    const task = e.task;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (first === 'approve') {
      const add = e.tracker.addPrLabel.bind(e.tracker);
      e.tracker.addPrLabel = async (...args) => { entered(); await gate; await add(...args); };
      const approval = approveMergeTask(e.store, e.tracker, task, task.updated_at);
      await started;
      const review = rereviewTask(e.store, e.config, e.tracker, task, task.updated_at);
      release();
      await Promise.all([approval, review]);
    } else {
      const remove = e.tracker.removePrLabel.bind(e.tracker);
      e.tracker.removePrLabel = async (...args) => { entered(); await gate; await remove(...args); };
      const review = rereviewTask(e.store, e.config, e.tracker, task, task.updated_at);
      await started;
      const approval = approveMergeTask(e.store, e.tracker, task, task.updated_at);
      const rejected = assert.rejects(approval, /AWAITING_REVIEW/);
      release();
      await Promise.all([review, rejected]);
    }
    assert.equal(e.task.status, 'AWAITING_REVIEW');
    assert.deepEqual(e.tracker.prLabels.get(42), []);
  } finally { e.done(); }
});

test('approval withdraws its label if state changes during the remote write', async () => {
  const e = setup();
  try {
    const add = e.tracker.addPrLabel.bind(e.tracker);
    e.tracker.addPrLabel = async (...args) => { await add(...args); e.store.setTaskStatus(e.task.id, 'AWAITING_REVIEW'); };
    await assert.rejects(approveMergeTask(e.store, e.tracker, e.task), /已撤销旧批准/);
    assert.deepEqual(e.tracker.prLabels.get(42), []);
  } finally { e.done(); }
});

test('rereview HTTP requires authentication and a current version', async () => {
  const e = setup();
  e.config.server.ui.token = 'operator-token';
  const ui = await startUiServer({ deps: { store: e.store, config: e.config, tracker: e.tracker, activeCount: () => 0 }, host: '127.0.0.1', port: 0 });
  try {
    const url = `${ui.url}/api/tasks/${e.task.id}/rereview`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ expected_updated_at: 'old' })).status, 400);
    const approve = `${ui.url}/api/tasks/${e.task.id}/approve-merge`;
    assert.equal((await fetch(approve, { method: 'POST', headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' }, body: JSON.stringify({ expected_updated_at: 'old' }) })).status, 400);
    assert.equal((await post({ expected_updated_at: e.task.updated_at })).status, 200);
    assert.equal(e.task.status, 'AWAITING_REVIEW');
  } finally { ui.close(); e.done(); }
});
