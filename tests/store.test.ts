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
    assert.equal(v.v, 1);
    s2.close();
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
