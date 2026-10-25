import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../src/store/sqlite.js';
import { loadConfig } from '../src/config.js';
import { newReviewControl, parseReviewControl, reserveFix, reserveReview, retryReview, unresolvedDecisions, validateReviewAssessment } from '../src/verify/review-policy.js';
import { cleanup, tmpDir } from './helpers.js';

test('review policy budgets survive head changes and enforce bounded retry delays', () => {
  const start = newReviewControl('requirement');
  let control = reserveReview(start, 'sha1', 'base1');
  control = reserveFix(control, 2);
  control = retryReview(control, 0);
  assert.equal(control.next_attempt_at, new Date(30_000).toISOString());
  control = reserveReview(control, 'sha2', 'base2');
  assert.equal(control.fix_attempts, 1);
  assert.equal(control.infra_attempts, 1);
  control = retryReview(control, 0);
  assert.equal(control.next_attempt_at, new Date(120_000).toISOString());
  control = retryReview(control, 0);
  assert.equal(control.next_attempt_at, null);
  assert.throws(() => reserveReview(control, 'sha3'), /infrastructure budget/);
  assert.equal(start.rounds, 0);
  assert.throws(() => reserveFix({ ...start, fix_attempts: 2 }, 2), /fix budget/);
  assert.throws(() => reserveReview({ ...start, rounds: 6 }, 'sha'), /round budget/);
});

test('review decision authorization is request, requirement and head scoped', () => {
  const control = newReviewControl('r1');
  control.decisions = [{ type: 'sensitive_authorization', request_id: 'decision1', head_sha: 'sha1', requirement_hash: 'r1', question: 'Expand access?', options: ['approve', 'deny'], impact: 'Access boundary', reason: 'Requires explicit approval' }];
  control.resolutions = [{ request_id: 'decision1', requirement_hash: 'r1', head_sha: 'sha1', selected_option: 'approve', authorization: 'Permit described change', actor: 'human', created_at: new Date(0).toISOString() }];
  assert.deepEqual(unresolvedDecisions(control, 'sha1'), []);
  assert.equal(unresolvedDecisions(control, 'sha2').length, 1);
  assert.equal(unresolvedDecisions({ ...control, requirement_hash: 'r2' }, 'sha1').length, 1);
  assert.equal(unresolvedDecisions({ ...control, resolutions: [{ ...control.resolutions[0]!, selected_option: 'anything' }] }, 'sha1').length, 1);
});

test('review control and assessment reject malformed evidence and missing protocol data', () => {
  assert.equal(parseReviewControl(null), null);
  assert.throws(() => parseReviewControl('{}'));
  assert.throws(() => parseReviewControl({ ...newReviewControl('r'), rounds: -1 }));
  assert.throws(() => parseReviewControl({ ...newReviewControl('r'), next_attempt_at: 'tomorrow' }));
  assert.throws(() => validateReviewAssessment({ protocol_version: 2, summary: 'PASS' }));
  const assessment = { protocol_version: 2, summary: 'Verified', findings: [], verification_requests: [], decision_requests: [], compatibility: { kind: 'additive', evidence: ['Legacy defaults verified'] } };
  assert.equal(validateReviewAssessment(assessment).compatibility.kind, 'additive');
  assert.throws(() => validateReviewAssessment({ ...assessment, verification_requests: [{ claim: 'missing' }] }));
});

test('migration 12 leaves legacy evidence null and persists budgets across restart', () => {
  const dir = tmpDir('review-policy-store-');
  const file = join(dir, 'store.db');
  let store = new Store(file);
  try {
    const task = store.upsertDiscovered({ repo: 'o/r', issue_number: 1, issue_title: 'test', issue_url: 'https://example.test' }).task;
    assert.equal(task.review_control_json, null);
    const run = store.claimRun(task.id);
    store.addCheck({ run_id: run.run_id, kind: 'check', command: 'test', exit_code: 0, verdict: 'PASS' });
    assert.equal(store.checksForRun(run.run_id)[0]?.review_detail_json, null);
    store.db.exec('ALTER TABLE tasks DROP COLUMN review_control_json; ALTER TABLE tasks DROP COLUMN issue_workflow_json; ALTER TABLE check_results DROP COLUMN review_detail_json; DELETE FROM schema_version WHERE version IN (12,13);');
    store.close();
    store = new Store(file);
    assert.equal(store.getReviewControl(task.id), null);
    const control = retryReview(reserveFix(reserveReview(newReviewControl('r'), 'head', 'base'), 2), 0);
    store.saveReviewControl(task.id, control);
    const version = store.getTaskById(task.id)!.updated_at;
    store.saveReviewControl(task.id, control);
    assert.ok(store.getTaskById(task.id)!.updated_at > version);
    store.addCheck({ run_id: run.run_id, kind: 'review', command: 'review', exit_code: 0, verdict: 'PASS', detail_json: '{"protocol_version":2}' });
    assert.equal(store.checksForRun(run.run_id)[1]?.review_detail_json, '{"protocol_version":2}');
    store.close();
    store = new Store(file);
    assert.deepEqual(store.getReviewControl(task.id), control);
    assert.throws(() => store.claimRun(task.id), /active run/);
    const before = store.getTaskById(task.id)!;
    assert.throws(() => store.tx(() => {
      store.saveReviewControl(task.id, reserveReview(control, 'head2', 'base'));
      store.claimRun(task.id, { kind: 'review', headSha: 'head2' });
    }), /active run/);
    assert.deepEqual(store.getReviewControl(task.id), control);
    assert.equal(store.getTaskById(task.id)!.updated_at, before.updated_at);
    store.endRun(run.run_id, 'AWAITING_REVIEW');
    assert.throws(() => store.tx(() => {
      store.claimRun(task.id, { kind: 'review', headSha: 'head2' });
      store.saveReviewControl(task.id, reserveReview(control, 'head2', 'base'));
      throw new Error('crash before commit');
    }), /crash/);
    assert.equal(store.activeRunForTask(task.id), null);
    assert.deepEqual(store.getReviewControl(task.id), control);
    assert.throws(() => store.saveReviewControl(999, control), /not found/);
  } finally { store.close(); cleanup(dir); }
});

test('review config is opt-in and total timeout cannot exceed task budget', () => {
  const dir = tmpDir('review-policy-config-');
  const file = join(dir, 'config.yaml');
  const prefix = `server:\n  database: '${join(dir, 'db').replaceAll('\\', '/')}'\n  worktree_root: '${dir.replaceAll('\\', '/')}'\n  max_task_minutes: 5\nprojects: []\nagent:\n  model: p/m\n`;
  try {
    writeFileSync(file, prefix);
    assert.equal(loadConfig(file).review_policy?.version, 1);
    writeFileSync(file, prefix + 'review_policy:\n  version: 2\n');
    assert.equal(loadConfig(file).review_policy?.timeout_minutes, 5);
    writeFileSync(file, prefix + 'review_policy:\n  version: 3\n');
    assert.throws(() => loadConfig(file), /version/);
  } finally { cleanup(dir); }
});
