import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import type { GitWorkspace } from '../src/workspace/git.js';
import { approvalHash, type GitHubTracker } from '../src/tracker/github.js';
import { newReviewControl } from '../src/verify/review-policy.js';
import type { ProjectConfig, ReviewAssessment, TaskRow } from '../src/types.js';
import { makeConfig, makeStore, makeFakeTracker, nullLog, tmpDir, teardown } from './helpers.js';

const repo = 'me/sandbox';
const head = 'head-sha';
const base = 'base-sha';
const issue = { number: 40, title: 'Compatible optional argument', body: 'Preserve defaults', state: 'OPEN', labels: ['agent-ready'], url: 'https://example.test/issues/40' };
const pass = (): ReviewAssessment => ({ protocol_version: 2, summary: 'Verified normal, error, boundaries and legacy defaults', findings: [], verification_requests: [], decision_requests: [], compatibility: { kind: 'additive', evidence: ['Legacy calls and optional argument verified'] } });
type MergeMethods = {
  driveMerge(task: TaskRow, project: ProjectConfig, pr: number): Promise<void>;
  maybeHumanMergeApproval(task: TaskRow, project: ProjectConfig, pr: number): Promise<void>;
};

function setup(options: { manual?: boolean; bare?: boolean; checks?: 'PASS' | 'FAIL' | 'missing' | 'unguarded'; approvedBy?: 'review' | 'human' | null } = {}) {
  const dir = tmpDir('ac-merge-v2-');
  const config = makeConfig(dir, { review_policy: { version: 2 } });
  config.approvals.auto_merge.enabled = true;
  const project = config.projects[0]!;
  if (options.manual) project.review_mode = 'manual';
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  tracker.issues.set(40, { ...issue, labels: [...issue.labels] });
  let baseSha = base;
  const original = (tracker as unknown as GitHubTracker).getPrDetails.bind(tracker);
  (tracker as unknown as GitHubTracker).getPrDetails = async (r, n) => ({ ...await original(r, n), baseSha });
  const task = options.bare ? store.upsertPrTask({ repo, number: 40, title: issue.title, url: issue.url, branch: 'feature/external' }).task
    : store.upsertDiscovered({ repo, issue_number: 40, issue_title: issue.title, issue_url: issue.url }).task;
  const site = join(dir, 'site'); mkdirSync(site);
  const run = store.claimRun(task.id);
  store.updateRunFields(run.run_id, { workspace: site, head_sha: head });
  if (options.checks !== 'missing') {
    const verdict = options.checks === 'FAIL' ? 'FAIL' : 'PASS';
    store.addCheck({ run_id: run.run_id, kind: 'check', command: project.checks[0]!.argv.join(' '), verdict, exit_code: verdict === 'PASS' ? 0 : 1, head_sha: head });
    if (options.checks !== 'unguarded') store.transition(run.run_id, 'CLAIMED', 'VERIFYING', { kind: 'checks_completed', head_sha: head, head_sha_after: head, worktree_clean: true, ok: verdict === 'PASS' });
  }
  store.endRun(run.run_id, 'COMPLETED');
  const reviewRun = store.claimRun(task.id, { kind: 'review', headSha: head });
  store.transition(reviewRun.run_id, 'CLAIMED', 'REVIEWING');
  store.transition(reviewRun.run_id, 'REVIEWING', 'REVIEWING', { kind: 'review_started', head_sha: head, base_sha: base });
  store.addCheck({ run_id: reviewRun.run_id, kind: 'review', command: 'review', verdict: 'PASS', exit_code: null, head_sha: head });
  store.endRun(reviewRun.run_id, 'COMPLETED');
  store.setApprovedHash(task.id, approvalHash(issue));
  const control = { ...newReviewControl(approvalHash(issue)), head_sha: head, base_sha: base, rounds: 1, ...(!options.manual ? { assessment: pass() } : {}) };
  store.saveReviewControl(task.id, control);
  store.setTaskStatus(task.id, 'MERGING', { approved_sha: head, approved_by: options.manual ? 'human' : options.approvedBy === undefined ? 'review' : options.approvedBy, branch: 'agent/issue-40', pr_url: 'https://example.test/pull/40' });
  if (!options.bare) tracker.prs.set('agent/issue-40', { number: 40, url: 'https://example.test/pull/40', state: 'OPEN', isDraft: false });
  let patch = '';
  const workspace = { head: async () => head, isDirty: async () => false, diffVsBase: async () => patch,
    removeWorktree: async () => {}, deleteLocalBranch: async () => {}, deleteRemoteBranch: async () => {} } as unknown as GitWorkspace;
  const engine = new Engine({ store, config, tracker: tracker as unknown as GitHubTracker, workspace, appLog: nullLog, installDir: dir });
  const methods = engine as unknown as MergeMethods;
  return { store, tracker, project, config, control, task, methods,
    setBase(value: string) { baseSha = value; },
    setDiff(value: string) { patch = value; },
    current() { return store.getTaskById(task.id)!; },
    drive() { return methods.driveMerge(store.getTaskById(task.id)!, project, 40); },
    approve() { return methods.maybeHumanMergeApproval(store.getTaskById(task.id)!, project, 40); },
    done() { teardown(dir, [store]); } };
}

test('v2 AI review pass is not merge authorization without an approval marker', async () => {
  const e = setup({ approvedBy: null }); try { await e.drive(); assert.deepEqual(e.tracker.merged, []); assert.equal(e.current().status, 'AWAITING_HUMAN'); assert.equal(e.current().approved_by, null); } finally { e.done(); }
});

test('a moved PR base returns a Ready handoff to Draft and queues a fresh review without a merge label', async () => {
  const e = setup(); try {
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN', { approved_sha: null, approved_by: null });
    e.setBase('new-base');
    await e.approve();
    assert.equal(e.current().status, 'AWAITING_REVIEW');
    assert.equal(e.current().approved_sha, null);
    assert.equal(e.current().approved_by, null);
    assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});

for (const changed of ['head', 'base'] as const) test(`v2 ${changed} movement cannot inherit the old merge approval`, async () => {
  const e = setup({ approvedBy: 'human' }); try {
    if (changed === 'head') e.tracker.headSha = 'new-head'; else e.setBase('new-base');
    await e.drive(); assert.deepEqual(e.tracker.merged, []); assert.equal(e.current().status, 'AWAITING_REVIEW');
    assert.equal(e.current().approved_sha, null); assert.equal(e.current().approved_by, null);
  } finally { e.done(); }
});

for (const check of ['FAIL', 'missing', 'unguarded'] as const) test(`v2 merge refuses ${check} check evidence`, async () => {
  const e = setup({ checks: check, approvedBy: 'human' }); try { await e.drive(); assert.deepEqual(e.tracker.merged, []); } finally { e.done(); }
});

for (const obstacle of ['finding', 'verification', 'unknown', 'no-assessment', 'decision', 'denied'] as const) test(`v2 ${obstacle} cannot be bypassed by direct merge or agent-merge`, async () => {
  const e = setup({ approvedBy: 'human' }); try {
    const c = e.store.getReviewControl(e.task.id)!;
    if (obstacle === 'finding') c.assessment!.findings.push({ file: 'src/cli.js', line: 1, trigger: 'Promise.reject()', impact: 'false successful exit', verification: 'assert nonzero exit' });
    if (obstacle === 'verification') c.assessment!.verification_requests.push({ claim: 'defaults unchanged', scenario: 'legacy call', expected: 'same output' });
    if (obstacle === 'unknown') c.assessment!.compatibility.kind = 'unknown';
    if (obstacle === 'no-assessment') delete c.assessment;
    if (obstacle === 'decision' || obstacle === 'denied') {
      c.decisions.push({ request_id: 'sensitive-1', requirement_hash: c.requirement_hash, head_sha: head, type: 'sensitive_authorization', question: 'Permit access expansion?', options: ['批准当前提交', '拒绝当前提交'], impact: 'Access boundary', reason: 'Needs explicit authorization' });
      if (obstacle === 'denied') c.resolutions.push({ request_id: 'sensitive-1', requirement_hash: c.requirement_hash, head_sha: head, selected_option: '拒绝当前提交', authorization: 'Do not expand access', actor: 'human', created_at: new Date().toISOString() });
    }
    e.store.saveReviewControl(e.task.id, c);
    await e.drive(); assert.deepEqual(e.tracker.merged, []);
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN'); e.tracker.prLabels.set(40, ['agent-merge']);
    await e.approve(); assert.notEqual(e.current().status, 'MERGING'); assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});

for (const external of ['closed', 'hold', 'needs-human', 'hash-drift', 'version-drift'] as const) test(`v2 ${external} prevents landing`, async () => {
  const e = setup({ approvedBy: 'human' }); try {
    const i = e.tracker.issues.get(40)!;
    if (external === 'closed') i.state = 'CLOSED';
    if (external === 'hold') i.labels.push('agent-human-hold');
    if (external === 'needs-human') i.labels.push('agent-needs-human');
    if (external === 'hash-drift') i.body += ' changed requirement';
    if (external === 'version-drift') {
      const original = (e.tracker as unknown as GitHubTracker).getIssue.bind(e.tracker);
      (e.tracker as unknown as GitHubTracker).getIssue = async (r, n) => { const result = await original(r, n); e.store.setTaskStatus(e.task.id, 'CANCELED'); return result; };
    }
    await e.drive(); assert.deepEqual(e.tracker.merged, []);
    if (external === 'closed' || external === 'version-drift') assert.equal(e.current().status, 'CANCELED');
    if (external === 'hash-drift') assert.equal(e.current().status, 'BLOCKED_APPROVAL_CHANGED');
  } finally { e.done(); }
});

test('v2 manual review permits human merge approval with guarded checks and no model assessment', async () => {
  const e = setup({ manual: true }); try {
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN', { approved_sha: null, approved_by: null });
    e.tracker.prLabels.set(40, ['agent-merge']);
    await e.approve(); assert.equal(e.current().status, 'MERGING'); assert.equal(e.current().approved_by, 'human');
    await e.drive(); assert.deepEqual(e.tracker.merged, [40]);
  } finally { e.done(); }
});

test('v2 bare PR never lands even with approval fields and agent-merge', async () => {
  const e = setup({ bare: true }); try {
    await e.drive(); assert.deepEqual(e.tracker.merged, []);
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN'); e.tracker.prLabels.set(40, ['agent-merge']);
    await e.approve(); assert.notEqual(e.current().status, 'MERGING');
  } finally { e.done(); }
});

test('v2 conflict queues repair without carrying an old merge approval to the new head', async () => {
  const e = setup({ approvedBy: 'human' }); try {
    e.tracker.mergeable.set(40, 'CONFLICTING'); await e.drive();
    assert.deepEqual(e.tracker.merged, []); assert.equal(e.current().status, 'DISCOVERED'); assert.ok(e.current().pending_fix);
    assert.equal(e.store.getReviewControl(e.task.id)?.fix_attempts, 1);
    assert.equal(e.current().approved_sha, null); assert.equal(e.current().approved_by, null);
    e.tracker.headSha = 'repaired-head';
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN'); e.tracker.prLabels.set(40, ['agent-merge']); await e.approve();
    assert.deepEqual(e.tracker.merged, []); assert.equal(e.current().status, 'AWAITING_REVIEW');
  } finally { e.done(); }
});

for (const manual of [false, true]) test(`v2 protected generated file cannot bypass ${manual ? 'manual' : 'auto'} merge approval`, async () => {
  const e = setup({ manual, approvedBy: 'human' }); try {
    e.project.human_review_paths = ['dist/**'];
    e.setDiff('diff --git a/dist/index.js b/dist/index.js\n--- a/dist/index.js\n+++ b/dist/index.js\n@@ -1 +1 @@\n-old\n+new\n');
    await e.drive();
    assert.deepEqual(e.tracker.merged, []);
    assert.equal(e.current().status, 'AWAITING_HUMAN');
    assert.equal(e.store.getReviewControl(e.task.id)?.decisions[0]?.file, 'dist/index.js');
  } finally { e.done(); }
});

test('v2 merge rechecks local version after marking PR ready', async () => {
  const e = setup({ approvedBy: 'human' }); try {
    (e.tracker as unknown as GitHubTracker).markPrReady = async () => { e.store.setTaskStatus(e.task.id, 'CANCELED'); };
    await e.drive(); assert.deepEqual(e.tracker.merged, []); assert.equal(e.current().status, 'CANCELED');
  } finally { e.done(); }
});

test('v2 consuming merge label cannot overwrite a concurrent decision update', async () => {
  const e = setup(); try {
    e.store.setTaskStatus(e.task.id, 'AWAITING_HUMAN'); e.tracker.prLabels.set(40, ['agent-merge']);
    (e.tracker as unknown as GitHubTracker).removePrLabel = async () => {
      e.store.saveReviewControl(e.task.id, { ...e.store.getReviewControl(e.task.id)!, next_attempt_at: new Date().toISOString() });
    };
    await e.approve(); assert.equal(e.current().status, 'AWAITING_HUMAN'); assert.deepEqual(e.tracker.merged, []);
  } finally { e.done(); }
});
