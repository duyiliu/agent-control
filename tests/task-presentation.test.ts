import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPayload, tasksPayload } from '../src/ui/api.js';
import { emptyIntake } from '../src/triage/intake.js';
import { isDeferredDue, localDateTime } from '../ui/src/deferred.js';
import { makeConfig, makeStore, teardown, tmpDir } from './helpers.js';

test('cards distinguish protocol recovery from business risk and preserve risk details', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha' });
    store.transition(run.run_id, 'CLAIMED', 'REVIEWING', { kind: 'review_completed', summary: '[protocol-recovered] checks look good' });
    store.endRun(run.run_id, 'AWAITING_HUMAN', 'review PASS but high risk: reviewer marked risk=high');
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/1' });
    const detail = taskPayload(store, task.id, config)!;
    assert.match(detail.task.attention!.summary, /评审未能可靠完成/);
    assert.equal(detail.task.actions!.rereview, true);
    assert.equal(detail.task.actions!.approve_merge, true);
    assert.equal(tasksPayload(store, config).tasks[0]!.attention!.summary, detail.task.attention!.summary);
    store.setTaskStatus(task.id, 'BLOCKED');
    assert.doesNotMatch(taskPayload(store, task.id, config)!.task.attention!.detail, /protocol-recovered/);
  } finally { teardown(dir, [store]); }
});

test('external and local holds are parked locks with explicit provenance, not human decisions', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 2, issue_title: 't', issue_url: 'u' });
    store.saveIntake('me/sandbox', 2, { ...emptyIntake(), locked: true, external_hold: true });
    store.setTaskStatus(task.id, 'BLOCKED');
    const external = taskPayload(store, task.id, config)!.task;
    assert.equal(external.attention!.kind, 'hold');
    assert.match(external.attention!.summary, /agent-human-hold/);
    assert.match(external.attention!.detail, /agent-human-hold/);
    assert.equal(external.attention!.decisions, undefined);
    store.saveIntake('me/sandbox', 2, { ...emptyIntake(), locked: true });
    const local = taskPayload(store, task.id, config)!.task;
    assert.equal(local.attention!.kind, 'hold');
    assert.match(local.attention!.detail, /本地人工锁定/);
    store.saveIntake('me/sandbox', 2, { ...emptyIntake(), external_needs: true });
    const needs = taskPayload(store, task.id, config)!.task;
    assert.equal(needs.attention!.kind, 'decision');
    assert.match(needs.attention!.detail, /agent-needs-human/);
    store.saveIntake('me/sandbox', 2, { ...emptyIntake(), kind: 'human', reason: '旧分流判定' });
    const human = taskPayload(store, task.id, config)!.task;
    assert.equal(human.attention!.kind, 'decision');
    assert.match(human.attention!.detail, /旧分流判定/);
  } finally { teardown(dir, [store]); }
});

test('blocked cards distinguish repair-budget exhaustion from generic blockage', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 3, issue_title: 't', issue_url: 'u' });
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha' });
    store.endRun(run.run_id, 'BLOCKED', 'review repair budget or state exhausted: Error: review fix budget exhausted');
    store.setTaskStatus(task.id, 'BLOCKED');
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.attention!.kind, 'execution_error');
    assert.equal(view.attention!.summary, '自动修复预算已耗尽');
  } finally { teardown(dir, [store]); }
});

test('deferred reminders distinguish before/at/after deadline without mutating holds', () => {
  const due = Date.parse('2026-10-24T08:00:00Z');
  const state = { ...emptyIntake(), kind: 'deferred' as const, defer_until: new Date(due).toISOString(), locked: true };
  assert.equal(isDeferredDue(state, due - 1), false);
  assert.equal(isDeferredDue(state, due), true);
  assert.equal(isDeferredDue(state, due + 1), true);
  assert.equal(state.locked, true);
  assert.equal(state.kind, 'deferred');
  assert.equal(isDeferredDue({ ...state, defer_until: 'bad' }, due), false);
  assert.equal(isDeferredDue({ ...state, kind: null }, due), false);
  assert.equal(isDeferredDue({ ...state, defer_until: null }, due), false);
  const local = localDateTime(state.defer_until);
  assert.equal(new Date(local).getTime(), due);
});

test('independent PR exposes review conclusions even when its run is COMPLETED', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertPrTask({ repo: 'me/sandbox', number: 7, title: 'external', url: 'https://x/pull/7', branch: 'feature' });
    const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha' });
    store.transition(run.run_id, 'CLAIMED', 'REVIEWING', { kind: 'review_completed', summary: '需要人工确认接口契约' });
    store.endRun(run.run_id, 'COMPLETED', 'external PR review HUMAN_REVIEW_REQUIRED');
    store.setTaskStatus(task.id, 'AWAITING_HUMAN');
    const view = taskPayload(store, task.id, config)!.task;
    assert.match(view.attention!.detail, /需要人工确认接口契约/);
    assert.equal(view.actions!.approve_merge, false);
  } finally { teardown(dir, [store]); }
});
