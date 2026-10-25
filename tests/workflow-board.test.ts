import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, workflowBucket } from '../ui/src/groups.js';
import { newWorkflowRecord } from '../src/scheduler/issue-workflow.js';
import { taskActions, workflowRecordOf } from '../src/ui/task-state.js';
import { taskPayload, tasksPayload } from '../src/ui/api.js';
import { setWorkflowStateFromBoard, type WorkflowBoardTracker } from '../src/workflow-board.js';
import type { TaskSummary } from '../ui/src/api.js';
import { makeConfig, makeStore, teardown, tmpDir } from './helpers.js';

function summary(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    workflow: true,
    workflow_state: 'Todo',
    workflow_reason: null,
    workflow_generation: 1,
    workflow_handoff: false,
    id: 1, repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u',
    source: 'issue', status: 'DISCOVERED', pr_url: null, fix_rounds: 0,
    updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    active_run: null, last_run: null,
    ...overrides,
  };
}

test('board buckets follow the seven GitHub states and legacy phases', () => {
  assert.equal(workflowBucket('Backlog'), 'backlog');
  assert.equal(workflowBucket('Todo'), 'todo');
  assert.equal(workflowBucket('In Progress'), 'active');
  assert.equal(workflowBucket('Human Review'), 'human');
  assert.equal(workflowBucket('Rework'), 'rework');
  assert.equal(workflowBucket('Merging'), 'merging');
  assert.equal(workflowBucket('Done'), 'done');
  assert.equal(workflowBucket(null), 'blocked');
  assert.equal(bucketOf(summary({ workflow_state: 'Human Review' })), 'human');
  assert.equal(bucketOf(summary({ status: 'COMPLETED', workflow_state: 'Done' })), 'done');
  assert.equal(bucketOf(summary({ status: 'CANCELED', workflow_state: 'In Progress' })), 'active');
  assert.equal(bucketOf(summary({ workflow: false, status: 'AWAITING_HUMAN' })), 'human');
  assert.equal(bucketOf(summary({ workflow: false, status: 'RUNNING', active_run: { run_id: 'r', attempt: 1, phase: 'RUNNING', started_at: 'x' } })), 'active');
  assert.equal(bucketOf(summary({ workflow: false, status: 'BLOCKED' })), 'blocked');
});

test('workflow presentation keeps business state separate from execution actions', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Human Review';
    record.generation = 2;
    record.diagnostic = 'PR 无法转为 Ready';
    record.handoff = { pr: 11, pr_url: 'https://x/pull/11', head_sha: 'sha', base_sha: 'base', requirement_hash: 'h', generation: 2, at: new Date().toISOString() };
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 11, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/11' });
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.workflow, true);
    assert.equal(view.workflow_state, 'Human Review');
    assert.equal(view.workflow_generation, 2);
    assert.equal(view.actions!.approve_merge, false);
    assert.equal(view.actions!.retry, false);
    assert.equal(view.actions!.rereview, false);
    assert.equal(view.attention!.kind, 'execution_error');
    assert.match(view.attention!.detail, /PR 无法转为 Ready/);
    assert.match(view.attention!.next_step, /Rework/);
    assert.equal(tasksPayload(store, config).tasks[0]!.workflow_state, 'Human Review');
  } finally { teardown(dir, [store]); }
});

test('workflow Human Review without a diagnostic points at the GitHub merge gate', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Human Review';
    record.handoff = { pr: 12, pr_url: 'https://x/pull/12', head_sha: 'sha', base_sha: 'base', requirement_hash: 'h', generation: 1, at: new Date().toISOString() };
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 12, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/12' });
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.attention!.kind, 'approval');
    assert.match(view.attention!.next_step, /批准合并/);
    assert.match(view.attention!.next_step, /返工/);
  } finally { teardown(dir, [store]); }
});

test('Human Review without a PR is not presented as mergeable evidence', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Human Review';
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 15, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN');
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.attention!.kind, 'execution_error');
    assert.match(view.attention!.summary, /还没有可审查的 PR/);
    assert.match(view.attention!.next_step, /Todo/);
  } finally { teardown(dir, [store]); }
});

test('a PR without a handoff binding is a recoverable, not a mergeable, state', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Human Review';
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 16, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/16' });
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.attention!.kind, 'recovery');
    assert.match(view.attention!.summary, /交付范围尚未绑定/);
    assert.equal(view.workflow_handoff, false);
  } finally { teardown(dir, [store]); }
});

test('a corrupt workflow record fails closed instead of looking legacy', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 13, issue_title: 't', issue_url: 'u',
      issue_workflow_json: '{not json',
    });
    assert.equal(workflowRecordOf(task).corrupt, true);
    assert.deepEqual(taskActions(task, true, null, config), { stop: true, retry: false, rereview: false, approve_merge: false });
    const view = taskPayload(store, task.id, config)!.task;
    assert.equal(view.workflow, true);
    assert.equal(view.workflow_state, null);
    assert.equal(view.attention!.kind, 'execution_error');
    assert.match(view.attention!.summary, /损坏/);
    assert.equal(bucketOf(tasksPayload(store, config).tasks[0]!), 'blocked');
  } finally { teardown(dir, [store]); }
});

test('legacy tasks keep their panel actions', () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 14, issue_title: 't', issue_url: 'u' });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/14' });
    const current = store.getTaskById(task.id)!;
    assert.equal(taskActions(current, false, null, config).approve_merge, true);
    assert.equal(taskPayload(store, task.id, config)!.retryable, false);
  } finally { teardown(dir, [store]); }
});

function boardTracker(initialLabels: string[], pr: { state: 'OPEN' | 'MERGED' | 'CLOSED'; headSha: string; baseSha: string }) {
  let labels = [...initialLabels];
  const tracker: WorkflowBoardTracker = {
    async getIssue() {
      return { number: 30, title: 't', body: '', labels: [...labels], state: 'OPEN', url: 'u' };
    },
    async getPrDetails() {
      return { state: pr.state, headSha: pr.headSha, baseSha: pr.baseSha, url: 'https://x/pull/30' };
    },
    async setWorkflowState(_repo, _number, label) {
      labels = labels.filter(item => !['Backlog', 'Todo', 'In Progress', 'Human Review', 'Rework', 'Merging', 'Done'].includes(item));
      labels.push(label);
    },
  };
  return { tracker, labels: () => labels };
}

test('board state change writes the label and updates the cached state', async () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Backlog';
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 30, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    const board = boardTracker(['Backlog'], { state: 'OPEN', headSha: 'sha', baseSha: 'base' });
    const message = await setWorkflowStateFromBoard(store, config, board.tracker, task, 'Todo', task.updated_at);
    assert.match(message, /Todo/);
    assert.deepEqual(board.labels(), ['Todo']);
    const after = store.getTaskById(task.id)!;
    const updated = workflowRecordOf(after).record!;
    assert.equal(updated.observed_state, 'Todo');
    assert.equal(updated.pending_label, null);
  } finally { teardown(dir, [store]); }
});

test('board merge approval is rejected when the PR head moved', async () => {
  const dir = tmpDir(); const store = makeStore(dir); const config = makeConfig(dir);
  try {
    const record = newWorkflowRecord();
    record.observed_state = 'Human Review';
    record.handoff = { pr: 30, pr_url: 'https://x/pull/30', head_sha: 'old-head', base_sha: 'base', requirement_hash: 'hash', generation: 1, at: new Date().toISOString() };
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 30, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/30' });
    const board = boardTracker(['Human Review'], { state: 'OPEN', headSha: 'new-head', baseSha: 'base' });
    await assert.rejects(
      () => setWorkflowStateFromBoard(store, config, board.tracker, store.getTaskById(task.id)!, 'Merging', store.getTaskById(task.id)!.updated_at),
      /PR head\/base/,
    );
    assert.deepEqual(board.labels(), ['Human Review']);
    assert.equal(workflowRecordOf(store.getTaskById(task.id)!).record!.board_approval, null);
  } finally { teardown(dir, [store]); }
});
