import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { retryTask, OpsError } from '../src/ops.js';
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
