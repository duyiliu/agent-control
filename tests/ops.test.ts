import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { approveMergeTask, requestDrain, resumeDispatch, retryTask, waitForDrain, OpsError } from '../src/ops.js';
import { makeConfig, makeStore, makeFakeTracker, tmpDir, teardown } from './helpers.js';

function setup() {
  const dir = tmpDir('ac-retry-'); const store = makeStore(dir); const config = makeConfig(dir); const tracker = makeFakeTracker();
  tracker.issues.set(1, { title: 't', body: 'b', labels: ['agent-ready'], state: 'OPEN', url: 'u' });
  const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
  const run = store.claimRun(task.id); const wt = join(dir, 'wt'); mkdirSync(wt);
  store.updateRunFields(run.run_id, { pid: 123, process_identity: '123:100000', workspace: wt });
  store.endRun(run.run_id, 'RECOVERY_REQUIRED', 'child may live'); store.setTaskStatus(task.id, 'RECOVERY_REQUIRED');
  return { dir, store, config, tracker, task: store.getTaskById(task.id)! };
}

test('approve-merge: only AWAITING_HUMAN tasks can be approved', async () => {
  const env = setup();
  try {
    await assert.rejects(approveMergeTask(env.store, env.tracker, env.task), OpsError);
    assert.deepEqual([...(env.tracker.prLabels.get(1) ?? [])], []);
  } finally { teardown(env.dir, [env.store]); }
});

test('approve-merge: adds the agent-merge label to the task PR', async () => {
  const dir = tmpDir('ac-approve-');
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  try {
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 9, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/42' });
    const msg = await approveMergeTask(store, tracker, store.getTaskById(task.id)!);
    assert.match(msg, /agent-merge/);
    assert.deepEqual(tracker.prLabels.get(42), ['agent-merge']);
    assert.equal(store.getTaskById(task.id)!.status, 'AWAITING_HUMAN'); // the sweep owns the transition
  } finally { teardown(dir, [store]); }
});

test('retry: refuses a live child without changing approval or labels', async () => {
  const env = setup();
  try {
    await assert.rejects(retryTask(env.store, env.config, env.tracker, env.task, {
      isPidAlive: () => true, processStartedAt: async () => 100000,
    }), OpsError);
    assert.equal(env.store.getTaskById(env.task.id)!.status, 'RECOVERY_REQUIRED');
    assert.deepEqual(env.tracker.labelsRemoved, []);
  } finally { teardown(env.dir, [env.store]); }
});

for (const pids of [null, [9876]]) {
  test(`retry: refuses unresolved orphan scan (${JSON.stringify(pids)})`, async () => {
    const env = setup();
    try {
      await assert.rejects(retryTask(env.store, env.config, env.tracker, env.task, {
        isPidAlive: () => false, findProcs: async () => pids,
      }), OpsError);
      assert.equal(env.store.getTaskById(env.task.id)!.status, 'RECOVERY_REQUIRED');
    } finally { teardown(env.dir, [env.store]); }
  });
}

test('retry: does not claim a task still labelled as running elsewhere', async () => {
  const env = setup();
  try {
    env.tracker.issues.get(1)!.labels.push('agent-running');
    await assert.rejects(retryTask(env.store, env.config, env.tracker, env.task, {
      isPidAlive: () => false, findProcs: async () => [],
    }), /agent-running/);
    assert.equal(env.store.getTaskById(env.task.id)!.status, 'RECOVERY_REQUIRED');
  } finally { teardown(env.dir, [env.store]); }
});

test('retry: rechecks task state after asynchronous tracker reads', async () => {
  const env = setup();
  try {
    const getIssue = env.tracker.getIssue.bind(env.tracker);
    env.tracker.getIssue = async (repo, issue) => {
      env.store.setTaskStatus(env.task.id, 'COMPLETED');
      return getIssue(repo, issue);
    };
    await assert.rejects(retryTask(env.store, env.config, env.tracker, env.task, {
      isPidAlive: () => false, findProcs: async () => [],
    }), /任务已变化/);
    assert.equal(env.store.getTaskById(env.task.id)!.status, 'COMPLETED');
  } finally { teardown(env.dir, [env.store]); }
});

test('retry: dead child and clean orphan scan can requeue', async () => {
  const env = setup();
  try {
    await retryTask(env.store, env.config, env.tracker, env.task, { isPidAlive: () => false, findProcs: async () => [] });
    assert.equal(env.store.getTaskById(env.task.id)!.status, 'DISCOVERED');
  } finally { teardown(env.dir, [env.store]); }
});

test('drain: request + matching ack resolves the wait', async () => {
  const dir = tmpDir('ac-drain-'); const store = makeStore(dir);
  try {
    const id = requestDrain(store);
    assert.equal(store.getMeta('drain_requested'), id);
    assert.equal(store.getMeta('drain_ack'), '');
    const waiter = waitForDrain(store, id, 2000, 10);
    store.setMeta('drain_ack', id);
    await waiter;
  } finally { teardown(dir, [store]); }
});

test('drain: a stale ack or idle-looking db never satisfies the wait', async () => {
  const dir = tmpDir('ac-drain-'); const store = makeStore(dir);
  try {
    const id = requestDrain(store);
    store.setMeta('drain_ack', 'older-request-nonce');
    await assert.rejects(waitForDrain(store, id, 200, 10), /超时/);
    // The timeout keeps the pause — never silently unpauses.
    assert.equal(store.getMeta('drain_requested'), id);
  } finally { teardown(dir, [store]); }
});

test('drain: a replaced request fails the old waiter', async () => {
  const dir = tmpDir('ac-drain-'); const store = makeStore(dir);
  try {
    const first = requestDrain(store);
    requestDrain(store);
    await assert.rejects(waitForDrain(store, first, 2000, 10), /替换/);
  } finally { teardown(dir, [store]); }
});

test('drain: undrain cancels a pending wait and clears both keys', async () => {
  const dir = tmpDir('ac-drain-'); const store = makeStore(dir);
  try {
    const id = requestDrain(store);
    const waiter = waitForDrain(store, id, 2000, 10);
    resumeDispatch(store);
    await assert.rejects(waiter, /取消/);
    assert.equal(store.getMeta('drain_requested'), '');
    assert.equal(store.getMeta('drain_ack'), '');
  } finally { teardown(dir, [store]); }
});

test('retry: drops review verdicts so an unchanged PR head is judged again', async () => {
  const env = setup();
  try {
    const run = env.store.claimRun(env.task.id, { kind: 'review', headSha: 'sha-a' });
    env.store.endRun(run.run_id, 'BLOCKED', 'block');
    env.store.addCheck({
      run_id: run.run_id, kind: 'review', command: 'agent (review)',
      exit_code: null, verdict: 'BLOCK', head_sha: 'sha-a',
    });
    assert.equal(env.store.hasReviewVerdictForSha(env.task.id, 'sha-a'), true);

    await retryTask(env.store, env.config, env.tracker, env.task, { isPidAlive: () => false, findProcs: async () => [] });

    // Without this the task would requeue into AWAITING_REVIEW and the sha
    // idempotency would skip the unchanged head forever.
    assert.equal(env.store.hasReviewVerdictForSha(env.task.id, 'sha-a'), false);
    assert.equal(env.store.getTaskById(env.task.id)!.status, 'DISCOVERED');
  } finally { teardown(env.dir, [env.store]); }
});
