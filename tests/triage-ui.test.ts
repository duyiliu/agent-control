import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyIntake } from '../src/triage/intake.js';
import { startUiServer } from '../src/ui/server.js';
import { IssueTriage, type TriageAction } from '../src/triage/service.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown, tmpDir } from './helpers.js';

test('triage API lists the queue and protects actions with the configured UI token', async (t) => {
  const dir = tmpDir('ac-triage-ui-');
  const config = makeConfig(dir);
  config.server.ui = { enabled: true, host: '127.0.0.1', port: 0, token: 'triage-token' };
  config.projects[0]!.issue_triage = { enabled: true, timeout_seconds: 180 };
  const store = makeStore(dir);
  let actionCall: unknown[] | null = null;
  const triage = {
    list: () => [{ repo: 'me/sandbox', status: 'human', issue: { number: 12 } }],
    action: async (repo: string, number: number, action: TriageAction, params: unknown) => { actionCall = [repo, number, action, params]; return emptyIntake(); },
  } as unknown as IssueTriage;
  const ui = await startUiServer({
    deps: { store, config, tracker: makeFakeTracker(), activeCount: () => 0, triage },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => { ui.close(); teardown(dir, [store]); });

  const unauthorized = await fetch(`${ui.url}/api/triage`);
  assert.equal(unauthorized.status, 401);
  const headers = { authorization: 'Bearer triage-token', 'content-type': 'application/json' };
  const listed = await fetch(`${ui.url}/api/triage`, { headers });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    issues: [{ repo: 'me/sandbox', status: 'human', issue: { number: 12 } }],
    projects: [{ repo: 'me/sandbox', enabled: true }],
  });

  const denied = await fetch(`${ui.url}/api/triage/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'me/sandbox', number: 12, action: 'approve' }) });
  assert.equal(denied.status, 401);
  const action = await fetch(`${ui.url}/api/triage/actions`, { method: 'POST', headers, body: JSON.stringify({ repo: 'me/sandbox', number: 12, action: 'approve' }) });
  assert.equal(action.status, 200);
  assert.deepEqual(actionCall, ['me/sandbox', 12, 'approve', { expected_version: undefined, defer_until: undefined, claim_id: undefined, confirm_owner_exited: undefined }]);
});

test('unified task API carries disposition and actions return immediately saved versions', async t => {
  const dir = tmpDir('ac-unified-ui-'); const config = makeConfig(dir);
  config.projects[0]!.issue_intake = 'all'; config.server.ui.token = 'test-token';
  const store = makeStore(dir); const fake = makeFakeTracker();
  fake.issues.set(8, { title: 'Need details', body: '', labels: [], state: 'OPEN', url: 'https://github.com/me/sandbox/issues/8' });
  const tracker = Object.assign(fake, { listOpenIssues: async () => [{ number: 8, ...fake.issues.get(8)! }], issueComments: async () => [], authLogin: async () => 'test' });
  const triage = new IssueTriage({ config, store, tracker: tracker as never, workspace: {} as never, appLog: nullLog });
  await triage.scan();
  const ui = await startUiServer({ deps: { store, config, tracker, activeCount: () => 0, triage }, host: '127.0.0.1', port: 0, appLog: nullLog });
  t.after(async () => { await triage.shutdown(); ui.close(); teardown(dir, [store]); });
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  const action = async (name: string, version: number) => {
    const r = await fetch(`${ui.url}/api/triage/actions`, { method: 'POST', headers, body: JSON.stringify({ repo: 'me/sandbox', number: 8, action: name, expected_version: version }) });
    return { status: r.status, body: await r.json() as any };
  };
  const locked = await action('lock', 1); assert.equal(locked.status, 200); assert.equal(locked.body.state.locked, true);
  const stale = await action('defer', 1); assert.equal(stale.status, 409); assert.equal(stale.body.state.version, locked.body.state.version);
  const unlocked = await action('unlock', locked.body.state.version); assert.equal(unlocked.status, 200);
  const repeated = await action('unlock', locked.body.state.version); assert.equal(repeated.status, 200); assert.equal(repeated.body.state.locked, false);
  const cards = await (await fetch(`${ui.url}/api/tasks`, { headers })).json() as any;
  assert.equal(cards.tasks.length, 1); assert.equal(cards.tasks[0].intake.locked, false);
  assert.equal(fake.labelsAdded.length, 0);
});
