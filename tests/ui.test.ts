import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startUiServer } from '../src/ui/server.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown, tmpDir } from './helpers.js';

test('web ui', async (t) => {
  const dir = tmpDir();
  const config = makeConfig(dir);
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  mkdirLogs(config.server.logs_dir);

  const evilTitle = '<script>alert(1)</script> fix login';
  const { task } = store.upsertDiscovered({
    repo: 'me/sandbox', issue_number: 42, issue_title: evilTitle,
    issue_url: 'https://github.com/me/sandbox/issues/42',
  });
  const run = store.claimRun(task.id);
  store.transition(run.run_id, 'CLAIMED', 'RUNNING');
  store.setTaskStatus(task.id, 'RUNNING');
  store.addCheck({
    run_id: run.run_id, kind: 'test', command: 'npm test', exit_code: 1,
    artifact_path: join(config.server.logs_dir, 'check-test.log'), verdict: 'FAIL',
  });
  writeFileSync(join(config.server.logs_dir, 'check-test.log'), 'boom\nline2');
  writeFileSync(join(config.server.logs_dir, `run-${run.run_id}.jsonl`), '{"at":"2026-01-01T00:00:00Z","type":"phase"}\nnot json\n');

  const { task: blocked } = store.upsertDiscovered({
    repo: 'me/sandbox', issue_number: 43, issue_title: 'blocked one',
    issue_url: 'https://github.com/me/sandbox/issues/43',
  });
  store.setTaskStatus(blocked.id, 'BLOCKED');
  tracker.issues.set(43, { title: 'blocked one', body: 'do it', labels: ['agent-ready'], state: 'OPEN', url: 'u' });

  const ui = await startUiServer({
    deps: { store, config, tracker, activeCount: () => 0 },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => {
    ui.close();
    teardown(dir, [store]);
  });

  await t.test('GET /api/tasks lists seeded tasks with run info', async () => {
    const d = await fetchJson(`${ui.url}/api/tasks`);
    const t42 = d.tasks.find((x: { issue_number: number }) => x.issue_number === 42);
    assert.equal(t42.status, 'RUNNING');
    assert.equal(t42.active_run.attempt, 1);
    assert.equal(t42.active_run.phase, 'RUNNING');
  });

  await t.test('GET /api/tasks/:id returns events and checks', async () => {
    const d = await fetchJson(`${ui.url}/api/tasks/${task.id}`);
    assert.equal(d.task.issue_number, 42);
    assert.equal(d.runs.length, 1);
    assert.ok(d.runs[0].events.some((e: { to_phase: string }) => e.to_phase === 'RUNNING'));
    assert.equal(d.runs[0].checks[0].verdict, 'FAIL');
    assert.equal(d.retryable, false);
  });

  await t.test('GET /api/health exposes process state', async () => {
    const d = await fetchJson(`${ui.url}/api/health`);
    assert.equal(d.pid, process.pid);
    assert.equal(d.active_runs.length, 1);
  });

  await t.test('GET /api/artifact serves text inside logs_dir', async () => {
    const r = await fetch(`${ui.url}/api/artifact?path=${encodeURIComponent(join(config.server.logs_dir, 'check-test.log'))}`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.kind, 'text');
    assert.match(d.content, /boom/);
  });

  await t.test('GET /api/artifact parses jsonl line by line', async () => {
    const r = await fetch(`${ui.url}/api/artifact?path=${encodeURIComponent(`run-${run.run_id}.jsonl`)}`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.kind, 'jsonl');
    assert.equal(d.lines.length, 2);
    assert.equal(d.lines[0].type, 'phase');
    assert.deepEqual(d.lines[1], { unparsed: 'not json' });
  });

  await t.test('GET /api/artifact rejects traversal and outside paths', async () => {
    const rel = await fetch(`${ui.url}/api/artifact?path=${encodeURIComponent('../../secret.log')}`);
    assert.equal(rel.status, 403);
    const abs = await fetch(`${ui.url}/api/artifact?path=${encodeURIComponent(resolve(dir, '..', 'evil.log'))}`);
    assert.equal(abs.status, 403);
    const missing = await fetch(`${ui.url}/api/artifact?path=${encodeURIComponent('nope.log')}`);
    assert.equal(missing.status, 404);
  });

  await t.test('GET / serves the SPA shell', async () => {
    const r = await fetch(ui.url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const body = await r.text();
    assert.ok(body.includes('<div id="root">') || body.includes('not built'), 'index shell or not-built hint');
  });

  await t.test('GET /task/:404 and /api/tasks/:404', async () => {
    assert.equal((await fetch(`${ui.url}/task/999`)).status, 404);
    assert.equal((await fetch(`${ui.url}/api/tasks/999`)).status, 404);
  });

  await t.test('POST stop sets cancel_requested on the active run', async () => {
    const r = await fetch(`${ui.url}/api/tasks/${task.id}/stop`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(store.runsWithCancelRequested().length, 1);
  });

  await t.test('POST retry rejects non-retryable status', async () => {
    const r = await fetch(`${ui.url}/api/tasks/${task.id}/retry`, { method: 'POST' });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.match(d.error, /not retryable/);
  });

  await t.test('POST retry re-queues a blocked task via the tracker', async () => {
    const r = await fetch(`${ui.url}/api/tasks/${blocked.id}/retry`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(store.getTaskById(blocked.id)!.status, 'DISCOVERED');
    assert.ok(store.getTaskById(blocked.id)!.approved_hash);
    assert.deepEqual(tracker.labelsRemoved.at(-1), [43, 'agent-blocked']);
  });

  await t.test('unknown api route is 404 json', async () => {
    const r = await fetch(`${ui.url}/api/nope`);
    assert.equal(r.status, 404);
    const d = await r.json();
    assert.match(d.error, /no route/);
  });
});

function mkdirLogs(dir: string) {
  mkdirSync(dir, { recursive: true });
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  assert.equal(r.status, 200);
  return r.json();
}
