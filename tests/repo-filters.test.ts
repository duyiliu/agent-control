import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoCounts } from '../ui/src/repo-filters.js';

test('repo-filters: configured projects show as zero with no tasks', () => {
  const counts = buildRepoCounts([], ['duyiliu/ac-dev-sandbox', 'duyiliu/scenario-test']);
  assert.deepEqual(
    [...counts.entries()].sort(),
    [
      ['duyiliu/ac-dev-sandbox', 0],
      ['duyiliu/scenario-test', 0],
    ],
  );
});

test('repo-filters: same repo in config and tasks counts once', () => {
  const tasks = [{ repo: 'owner/a' }, { repo: 'owner/a' }, { repo: 'owner/a' }];
  const counts = buildRepoCounts(tasks, ['owner/a']);
  assert.equal(counts.size, 1);
  assert.equal(counts.get('owner/a'), 3);
});

test('repo-filters: historic repo without config stays listed', () => {
  const counts = buildRepoCounts([{ repo: 'old/repo' }], ['owner/a']);
  assert.equal(counts.get('old/repo'), 1);
  assert.equal(counts.get('owner/a'), 0);
  assert.equal(counts.size, 2);
});

test('repo-filters: duplicate config entries neither reset nor double-count', () => {
  const withTasks = buildRepoCounts([{ repo: 'owner/a' }, { repo: 'owner/a' }], ['owner/a', 'owner/a']);
  assert.equal(withTasks.size, 1);
  assert.equal(withTasks.get('owner/a'), 2);
  const empty = buildRepoCounts([], ['owner/a', 'owner/a']);
  assert.equal(empty.size, 1);
  assert.equal(empty.get('owner/a'), 0);
});

test('repo-filters: empty inputs give an empty map', () => {
  assert.equal(buildRepoCounts([], []).size, 0);
});

test('repo-filters: input arrays are not mutated', () => {
  const tasks = [{ repo: 'owner/a' }];
  const repos = ['owner/a', 'owner/b'];
  buildRepoCounts(tasks, repos);
  assert.deepEqual(tasks, [{ repo: 'owner/a' }]);
  assert.deepEqual(repos, ['owner/a', 'owner/b']);
});
