import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, makeStore, tmpDir } from './helpers.js';

test('migrations are idempotent and schema_version recorded', () => {
  const dir = tmpDir();
  try {
    const s1 = makeStore(dir);
    s1.close();
    const s2 = makeStore(dir); // reopen same db
    const v = s2.db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number };
    assert.equal(v.v, 11);
    // v4 columns exist with sane defaults
    const runCols = s2.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    assert.ok(runCols.some((c) => c.name === 'kind') && runCols.some((c) => c.name === 'head_sha'));
    const checkCols = s2.db.prepare("PRAGMA table_info(check_results)").all() as { name: string }[];
    assert.ok(checkCols.some((c) => c.name === 'head_sha'));
    const taskCols = s2.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const busy = s2.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.ok(busy.timeout > 0, 'second connections (CLI) must wait instead of failing fast with SQLITE_BUSY');
    assert.ok(taskCols.some((c) => c.name === 'pending_fix') && taskCols.some((c) => c.name === 'merge_attempts') && taskCols.some((c) => c.name === 'approved_sha'));
    assert.ok(taskCols.some((c) => c.name === 'source'));
    s2.close();
  } finally {
    cleanup(dir);
  }
});

test('triage snapshots and process jobs survive store reopen', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    s.cacheTriage('owner/repo', 9, { status: 'human', issue: { number: 9 } });
    s.saveTriageJob('claim-9', { id: 'claim-9', repo: 'owner/repo', number: 9, pid: null });
    assert.deepEqual(s.listTriage(), [{ status: 'human', issue: { number: 9 } }]);
    assert.deepEqual(s.triageJobs(), [{ id: 'claim-9', repo: 'owner/repo', number: 9, pid: null }]);
    s.close();
    const reopened = makeStore(dir);
    assert.equal(reopened.triageJobs().length, 1);
    reopened.dropTriageJob('claim-9');
    reopened.close();
  } finally {
    cleanup(dir);
  }
});

test('triage can remove only an unstarted DISCOVERED task with no run', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const { task: first } = s.upsertDiscovered({ repo: 'a/b', issue_number: 9, issue_title: 't', issue_url: 'u' });
    assert.equal(s.deleteUnstartedTriageTask('a/b', 9), true);
    assert.equal(s.getTaskById(first.id), null);

    const { task: second } = s.upsertDiscovered({ repo: 'a/b', issue_number: 10, issue_title: 't', issue_url: 'u' });
    const run = s.claimRun(second.id);
    assert.equal(s.deleteUnstartedTriageTask('a/b', 10), false);
    assert.equal(s.getTaskById(second.id)?.status, 'DISCOVERED');
    assert.equal(s.runsForTask(second.id).length, 1);
    assert.ok(s.getRun(run.run_id));
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('meta kv round-trips and overwrites', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    assert.equal(s.getMeta('last_error'), null);
    s.setMeta('last_error', 'a');
    s.setMeta('last_error', 'b');
    assert.equal(s.getMeta('last_error'), 'b');
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('claimRun enforces one active run per task', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const { task } = s.upsertDiscovered({ repo: 'a/b', issue_number: 1, issue_title: 't', issue_url: 'u' });
    const r1 = s.claimRun(task.id);
    assert.equal(r1.attempt, 1);
    assert.throws(() => s.claimRun(task.id), /already has active run|UNIQUE/);
    s.endRun(r1.run_id, 'FAILED', 'x');
    const r2 = s.claimRun(task.id);
    assert.equal(r2.attempt, 2);
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('transitions append run_events and update phase', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const { task } = s.upsertDiscovered({ repo: 'a/b', issue_number: 2, issue_title: 't', issue_url: 'u' });
    const run = s.claimRun(task.id);
    s.transition(run.run_id, 'CLAIMED', 'PREPARING');
    s.transition(run.run_id, 'PREPARING', 'RUNNING');
    const events = s.eventsForRun(run.run_id);
    assert.deepEqual(events.map((e) => e.to_phase), ['CLAIMED', 'PREPARING', 'RUNNING']);
    assert.equal(s.getRun(run.run_id)!.phase, 'RUNNING');
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('upsertDiscovered is idempotent', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const a = s.upsertDiscovered({ repo: 'a/b', issue_number: 3, issue_title: 't', issue_url: 'u' });
    const b = s.upsertDiscovered({ repo: 'a/b', issue_number: 3, issue_title: 't', issue_url: 'u' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.task.id, b.task.id);
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('resumeRun clears the recorded child and bumps the budget for an active run', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const { task } = s.upsertDiscovered({ repo: 'a/b', issue_number: 4, issue_title: 't', issue_url: 'u' });
    const run = s.claimRun(task.id);
    s.transition(run.run_id, 'CLAIMED', 'VERIFYING');
    s.updateRunFields(run.run_id, { pid: 99, process_identity: '99:1', workspace: '/wt' });

    s.resumeRun(run.run_id, 'VERIFYING');

    const after = s.getRun(run.run_id)!;
    assert.equal(after.pid, null);
    assert.equal(after.process_identity, null);
    assert.equal(after.resume_count, 1);
    assert.equal(after.phase, 'VERIFYING');
    assert.equal(after.workspace, '/wt'); // site kept for the resumed phase
    const last = s.eventsForRun(run.run_id).at(-1)!;
    assert.equal(last.to_phase, 'VERIFYING');
    assert.match(last.detail_json ?? '', /recovered/);
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('resumeRun refuses a terminal run or a non-active target without touching the row', () => {
  const dir = tmpDir();
  try {
    const s = makeStore(dir);
    const { task } = s.upsertDiscovered({ repo: 'a/b', issue_number: 5, issue_title: 't', issue_url: 'u' });
    const run = s.claimRun(task.id);
    s.transition(run.run_id, 'CLAIMED', 'RUNNING');
    s.updateRunFields(run.run_id, { pid: 9, process_identity: '9:1' });

    assert.throws(() => s.resumeRun(run.run_id, 'COMPLETED'), /cannot resume/);
    const before = { ...s.getRun(run.run_id)! };
    const beforeEvents = s.eventsForRun(run.run_id).length;

    s.endRun(run.run_id, 'FAILED', 'done');
    assert.throws(() => s.resumeRun(run.run_id, 'RUNNING'), /cannot resume/);
    const after = s.getRun(run.run_id)!;
    assert.equal(after.phase, 'FAILED');
    assert.equal(after.pid, 9);
    assert.equal(after.resume_count, 0);
    assert.equal(s.eventsForRun(run.run_id).length, beforeEvents + 1); // only the endRun event
    assert.equal(before.phase, 'RUNNING'); // sanity: the refused target attempt changed nothing earlier
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('intake decisions and protocol version survive reopen while old runs remain protocol zero', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const { task } = store.upsertDiscovered({ repo: 'o/r', issue_number: 1, issue_title: 't', issue_url: 'u' });
    const old = store.claimRun(task.id); assert.equal(old.outcome_protocol, 0); store.endRun(old.run_id, 'BLOCKED');
    const next = store.claimRun(task.id, { outcomeProtocol: 1 }); assert.equal(next.outcome_protocol, 1);
    store.saveIntake('o/r', 1, { kind: 'deferred', version: 3 }); store.close();
    const reopened = makeStore(dir);
    assert.deepEqual(reopened.getIntake('o/r', 1), { kind: 'deferred', version: 3 });
    assert.equal(reopened.getRun(old.run_id)!.outcome_protocol, 0); assert.equal(reopened.getRun(next.run_id)!.outcome_protocol, 1);
    reopened.close();
  } finally { cleanup(dir); }
});
