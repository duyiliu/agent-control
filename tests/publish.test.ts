import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishDraftPr, PublishError } from '../src/publish/pr.js';
import type { GitWorkspace } from '../src/workspace/git.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import { makeConfig } from './helpers.js';

function setup() {
  let dirty = false;
  let head = 'reviewed-sha';
  const calls: string[] = [];
  const workspace = {
    isDirty: async () => dirty, head: async () => head, aheadCount: async () => 1,
    commitAll: async () => { calls.push('commit'); return true; }, push: async () => { calls.push('push'); },
  } as unknown as GitWorkspace;
  const tracker = {
    findPrForBranch: async () => null,
    createDraftPr: async () => { calls.push('create'); return { number: 1, url: 'u', state: 'OPEN', isDraft: true }; },
  } as unknown as GitHubTracker;
  const input = {
    project: makeConfig('.').projects[0]!, worktreePath: '.', branch: 'agent/issue-1',
    issue: { number: 1, title: 'Fix', body: 'AC', labels: [], state: 'OPEN', url: 'u' },
    prBody: 'body', workspace, tracker, expectedHead: 'reviewed-sha',
  };
  return { calls, input, setDirty: () => { dirty = true; }, changeHead: () => { head = 'unreviewed-sha'; } };
}

test('publish: refuses dirty work without committing or pushing it', async () => {
  const env = setup(); env.setDirty();
  await assert.rejects(publishDraftPr(env.input), (err: unknown) => err instanceof PublishError && err.reason === 'uncommitted_changes');
  assert.deepEqual(env.calls, []);
});

test('publish: refuses a changed reviewed HEAD', async () => {
  const env = setup(); env.changeHead();
  await assert.rejects(publishDraftPr(env.input), (err: unknown) => err instanceof PublishError && err.reason === 'head_changed');
  assert.deepEqual(env.calls, []);
});

test('publish: side effects only start after checking reviewed content', async () => {
  const env = setup();
  await publishDraftPr(env.input);
  assert.deepEqual(env.calls, ['push', 'create']);
});

test('publish: detects changes while awaiting tracker response before push', async () => {
  const env = setup();
  env.input.tracker.findPrForBranch = async () => { env.changeHead(); return null; };
  await assert.rejects(publishDraftPr(env.input), PublishError);
  assert.deepEqual(env.calls, []);
});
