import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveMergeTask, rereviewTask, resolveReviewDecision, retryTask } from '../src/ops.js';
import { approvalHash } from '../src/tracker/github.js';
import { newReviewControl } from '../src/verify/review-policy.js';
import { startUiServer } from '../src/ui/server.js';
import { taskAttention } from '../src/ui/task-state.js';
import { makeConfig, makeFakeTracker, makeStore, teardown, tmpDir } from './helpers.js';

function setup() {
  const dir = tmpDir('ac-decision-'), store = makeStore(dir), config = makeConfig(dir), tracker = makeFakeTracker();
  tracker.issues.set(1, { title: 't', body: 'approved', state: 'OPEN', labels: ['agent-ready'], url: 'u' });
  const hash = approvalHash(tracker.issues.get(1)!);
  const { task } = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u' });
  const run = store.claimRun(task.id, { kind: 'review', headSha: 'sha' });
  store.endRun(run.run_id, 'AWAITING_HUMAN', 'decision required');
  store.setTaskStatus(task.id, 'AWAITING_HUMAN', { pr_url: 'https://x/pull/42', approved_hash: hash });
  const control = newReviewControl(hash);
  control.head_sha = 'sha';
  control.decisions = ['first', 'second'].map(request_id => ({ request_id, head_sha: 'sha', type: 'sensitive_authorization', question: '允许扩展权限吗？', options: ['同意指定范围', '维持原权限'], impact: '认证边界', reason: '原需求未授权' }));
  store.saveReviewControl(task.id, control);
  const params = () => ({ expected_updated_at: store.getTaskById(task.id)!.updated_at, decision_version: hash, head_sha: 'sha', selected_option: '维持原权限', authorization: '维持现有权限，不扩大访问范围' });
  return { store, config, tracker, task, run, params, done: () => teardown(dir, [store]) };
}

test('specific decisions are append-only and only the final answer requeues review', async () => {
  const e = setup();
  try {
    e.tracker.getPrHeadSha = async () => 'sha';
    await resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', e.params());
    assert.equal(e.store.getTaskById(e.task.id)!.status, 'AWAITING_HUMAN');
    assert.equal(e.store.getReviewControl(e.task.id)!.resolutions.length, 1);
    await assert.rejects(approveMergeTask(e.store, e.tracker, e.store.getTaskById(e.task.id)!), /未解决决策/);
    await resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'second', e.params());
    assert.equal(e.store.getTaskById(e.task.id)!.status, 'AWAITING_REVIEW');
    assert.equal(e.store.getReviewControl(e.task.id)!.resolutions.length, 2);
    assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});

test('stale SHA, requirements, options, credentials and concurrent state changes reject answers', async () => {
  const e = setup();
  try {
    e.tracker.getPrHeadSha = async () => 'moved';
    await assert.rejects(resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', e.params()), /提交已变化/);
    e.tracker.getPrHeadSha = async () => 'sha';
    await assert.rejects(resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', { ...e.params(), selected_option: '全部放行' }), /选项/);
    await assert.rejects(resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', { ...e.params(), authorization: 'token=secretvalue' }), /令牌/);
    e.tracker.issues.get(1)!.body = 'changed';
    await assert.rejects(resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', e.params()), /内容已变化/);
    e.tracker.issues.get(1)!.body = 'approved';
    e.tracker.getPrHeadSha = async () => { e.store.setTaskStatus(e.task.id, 'CANCELED'); return 'sha'; };
    await assert.rejects(resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', e.params()), /状态已变化/);
    assert.equal(e.store.getReviewControl(e.task.id)!.resolutions.length, 0);
  } finally { e.done(); }
});

test('manual decisions remain in human approval path and cannot trigger a reviewer run', async () => {
  const e = setup();
  try {
    e.config.projects[0]!.review_mode = 'manual';
    e.tracker.getPrHeadSha = async () => 'sha';
    for (const id of ['first', 'second']) await resolveReviewDecision(e.store, e.config, e.tracker, e.task, id, e.params());
    assert.equal(e.store.getTaskById(e.task.id)!.status, 'AWAITING_HUMAN');
    assert.equal(e.store.runsForTask(e.task.id).length, 1);
  } finally { e.done(); }
});

test('decision, execution recovery and advisory presentations are distinct', () => {
  const e = setup();
  try {
    const task = e.store.getTaskById(e.task.id)!;
    assert.equal(taskAttention(task, undefined, null)?.kind, 'decision');
    assert.equal(taskAttention({ ...task, review_control_json: null, status: 'FAILED' }, undefined, null)?.kind, 'execution_error');
    assert.equal(taskAttention({ ...task, review_control_json: null, status: 'RECOVERY_REQUIRED' }, undefined, null)?.kind, 'recovery');
    assert.equal(taskAttention({ ...task, review_control_json: null, source: 'pr' }, undefined, null)?.kind, 'advisory');
  } finally { e.done(); }
});

test('explicit v2 rereview preserves legacy verdict history and records budget renewal', async () => {
  const e = setup();
  try {
    e.config.review_policy = { version: 2 };
    const c = e.store.getReviewControl(e.task.id)!;
    c.rounds = 6; c.infra_attempts = 2;
    c.assessment = { protocol_version: 2, summary: 'Known defect', findings: [{ file: 'src/cli.js', line: 1, trigger: 'Promise.reject()', impact: 'false success', verification: 'assert nonzero exit' }], verification_requests: [], decision_requests: [], compatibility: { kind: 'unchanged', evidence: [] } };
    e.store.saveReviewControl(e.task.id, c);
    e.store.addCheck({ run_id: e.run.run_id, kind: 'review', command: 'review', verdict: 'PASS', exit_code: null, head_sha: 'sha' });
    await rereviewTask(e.store, e.config, e.tracker, e.store.getTaskById(e.task.id)!, e.params().expected_updated_at);
    assert.equal(e.store.hasReviewVerdictForSha(e.task.id, 'sha'), true);
    assert.equal(e.store.getReviewControl(e.task.id)!.rounds, 0);
    assert.deepEqual(e.store.getReviewControl(e.task.id)?.assessment, c.assessment);
    assert.equal(e.store.getReviewControl(e.task.id)?.head_sha, 'sha');
  } finally { e.done(); }
});

test('v2 retry renews exhausted budgets without deleting verdict history or rejected decisions', async () => {
  const e = setup(); try {
    const c = e.store.getReviewControl(e.task.id)!;
    c.rounds = 6; c.infra_attempts = 3; c.fix_attempts = 3;
    c.decisions[0]!.options = ['批准当前提交', '拒绝当前提交'];
    c.resolutions.push({ request_id: 'first', requirement_hash: c.requirement_hash, head_sha: 'sha', selected_option: '拒绝当前提交', authorization: '不允许扩展权限', actor: 'human', created_at: new Date().toISOString() });
    e.store.saveReviewControl(e.task.id, c);
    e.store.addCheck({ run_id: e.run.run_id, kind: 'review', command: 'review', verdict: 'ERROR', exit_code: null, head_sha: 'sha' });
    e.store.setTaskStatus(e.task.id, 'BLOCKED');
    await retryTask(e.store, e.config, e.tracker, e.store.getTaskById(e.task.id)!, { findProcs: async () => [] });
    const renewed = e.store.getReviewControl(e.task.id)!;
    assert.equal(renewed.rounds, 0); assert.equal(renewed.infra_attempts, 0); assert.equal(renewed.fix_attempts, 0);
    assert.deepEqual(renewed.resolutions, c.resolutions);
    assert.equal(e.store.hasReviewVerdictForSha(e.task.id, 'sha'), true);
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_REVIEW');
    await assert.rejects(approveMergeTask(e.store, e.tracker, e.store.getTaskById(e.task.id)!), /状态|决策|授权/);
  } finally { e.done(); }
});

test('decision HTTP endpoint requires authentication and all scoped fields', async () => {
  const e = setup();
  e.config.server.ui.token = 'operator-token';
  e.tracker.getPrHeadSha = async () => 'sha';
  const ui = await startUiServer({ deps: { store: e.store, config: e.config, tracker: e.tracker, activeCount: () => 0 }, host: '127.0.0.1', port: 0 });
  try {
    const url = `${ui.url}/api/tasks/${e.task.id}/decisions/first/resolve`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ ...e.params(), decision_version: 'stale' })).status, 400);
    assert.equal((await post(e.params())).status, 200);
    assert.equal((await post(e.params())).status, 400);
    assert.equal(e.store.getReviewControl(e.task.id)!.resolutions.length, 1);
  } finally { ui.close(); e.done(); }
});

test('rejecting a non-product authorization blocks the current SHA and cannot be approved', async () => {
  const e = setup();
  try {
    e.tracker.getPrHeadSha = async () => 'sha';
    const control = e.store.getReviewControl(e.task.id)!;
    control.decisions = [{ ...control.decisions[0]!, options: ['批准当前提交', '拒绝当前提交'] }];
    e.store.saveReviewControl(e.task.id, control);
    await resolveReviewDecision(e.store, e.config, e.tracker, e.task, 'first', { ...e.params(), selected_option: '拒绝当前提交', authorization: '不同意扩大权限，需修改实现' });
    assert.equal(e.store.getTaskById(e.task.id)!.status, 'BLOCKED');
    assert.equal(taskAttention(e.store.getTaskById(e.task.id)!, undefined, null)?.kind, 'decision');
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN');
    await assert.rejects(approveMergeTask(e.store, e.tracker, e.store.getTaskById(e.task.id)!), /授权已被拒绝/);
    e.config.review_policy = { version: 2 };
    await rereviewTask(e.store, e.config, e.tracker, e.store.getTaskById(e.task.id)!, e.params().expected_updated_at);
    assert.equal(e.store.getReviewControl(e.task.id)!.resolutions[0]!.selected_option, '拒绝当前提交');
    assert.equal(e.store.getReviewControl(e.task.id)!.decisions.length, 1);
    assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});
