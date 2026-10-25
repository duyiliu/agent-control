import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { requiredLabelsForProject } from '../src/tracker/github.js';
import { planLabelSync } from '../src/labels.js';
import { Store } from '../src/store/sqlite.js';
import {
  authorizeHumanEvent, initialState, newWorkflowRecord, parseWorkflow, stateFromLabels,
  type LabelEvent, type WorkflowHandoff,
} from '../src/scheduler/issue-workflow.js';

const handoff = (): WorkflowHandoff => ({
  pr: 7, pr_url: 'https://example/pull/7', head_sha: 'head1', base_sha: 'base1',
  requirement_hash: 'hash1', generation: 1, at: '2026-10-25T10:00:00.000Z',
});

const event = (id: number, label: string, overrides: Partial<LabelEvent> = {}): LabelEvent => ({
  id, event: 'labeled', label, actor: 'human', actorType: 'User', createdAt: '2026-10-25T10:01:00.000Z', ...overrides,
});

test('seven states are mutually exclusive; conflicts are explicit', () => {
  assert.equal(stateFromLabels(['Todo', 'bug']).state, 'Todo');
  assert.deepEqual(stateFromLabels(['Todo', 'Merging']).conflicts, ['Todo', 'Merging']);
  assert.equal(stateFromLabels([]).state, null);
});

test('new issues start in Backlog and only a human moves them out', () => {
  assert.equal(initialState(['agent-ready']), 'Backlog');
  assert.equal(initialState([]), 'Backlog');
  assert.equal(initialState(['Human Review']), 'Human Review');
});

test('human approval binds actor, permission, handoff and head', () => {
  const base = {
    events: [event(5, 'Merging')], target: 'Merging' as const, hostLogin: 'bot-host', permission: 'write',
    handoff: handoff(), requirementHash: 'hash1', pr: 7, headSha: 'head1', baseSha: 'base1', generation: 1,
  };
  assert.equal(authorizeHumanEvent(base).event?.id, 5);
  assert.match(authorizeHumanEvent({ ...base, hostLogin: 'human' }).reason, /宿主/);
  assert.match(authorizeHumanEvent({ ...base, events: [event(5, 'Merging', { actorType: 'Bot' })] }).reason, /人类/);
  assert.match(authorizeHumanEvent({ ...base, permission: null }).reason, /写权限/);
  assert.match(authorizeHumanEvent({ ...base, headSha: 'moved' }).reason, /head/);
  assert.match(authorizeHumanEvent({ ...base, requirementHash: 'changed' }).reason, /需求/);
  assert.match(authorizeHumanEvent({ ...base, generation: 2 }).reason, /代际/);
});

test('an approval must be after the handoff and the newest transition wins', () => {
  const base = {
    target: 'Merging' as const, hostLogin: 'bot-host', permission: 'write', handoff: handoff(),
    requirementHash: 'hash1', pr: 7, headSha: 'head1', baseSha: 'base1', generation: 1,
  };
  const before = event(1, 'Merging', { createdAt: '2026-10-25T09:00:00.000Z' });
  assert.match(authorizeHumanEvent({ ...base, events: [before] }).reason, /交付之后/);
  const unlabeled = event(6, 'Merging', { event: 'unlabeled' });
  assert.match(authorizeHumanEvent({ ...base, events: [event(5, 'Merging'), unlabeled] }).reason, /人工状态事件/);
});

test('legacy is null; corrupt workflow JSON is never reinterpreted', () => {
  assert.equal(parseWorkflow(null), null);
  assert.throws(() => parseWorkflow('{"version":1}'));
  assert.equal(parseWorkflow(JSON.stringify(newWorkflowRecord()))?.generation, 1);
});

test('store pins the workflow at creation and keeps NULL for legacy tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wf-'));
  const store = new Store(join(dir, 'ac.db'));
  try {
    const record = newWorkflowRecord();
    const { task } = store.upsertDiscovered({
      repo: 'me/sandbox', issue_number: 1, issue_title: 't', issue_url: 'u',
      issue_workflow_json: JSON.stringify(record),
    });
    assert.equal(store.getIssueWorkflow(task.id), JSON.stringify(record));
    const legacy = store.upsertDiscovered({ repo: 'me/sandbox', issue_number: 2, issue_title: 't', issue_url: 'u' });
    assert.equal(store.getIssueWorkflow(legacy.task.id), null);
    store.saveIssueWorkflow(legacy.task.id, null);
    assert.equal(store.getIssueWorkflow(legacy.task.id), null);
  } finally {
    store.close();
  }
});

test('config defaults to github/manual and keeps legacy/auto explicit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wf-cfg-'));
  const base = `server:
  database: ${join(dir, 'ac.db').replace(/\\/g, '/')}
  worktree_root: ${join(dir, 'wt').replace(/\\/g, '/')}
projects:
  - repo: me/sandbox
    local_repo: ${dir.replace(/\\/g, '/')}
  - repo: me/legacy
    local_repo: ${dir.replace(/\\/g, '/')}
    workflow_mode: legacy
  - repo: me/review
    local_repo: ${dir.replace(/\\/g, '/')}
    review_mode: auto
agent:
  provider: pi
  model: test/model
`;
  const path = join(dir, 'agent-control.yaml');
  writeFileSync(path, base, 'utf8');
  const config = loadConfig(path);
  assert.equal(config.projects[0]!.workflow_mode, 'github');
  assert.equal(config.projects[0]!.review_mode, 'manual');
  assert.equal(config.projects[1]!.workflow_mode, 'legacy');
  assert.equal(config.projects[1]!.review_mode, 'auto');
  assert.equal(config.projects[2]!.workflow_mode, 'github');
  assert.equal(config.projects[2]!.review_mode, 'auto');
});

test('workflow projects provision exactly the seven state labels', () => {
  for (const triage of [true, false]) {
    const labels = requiredLabelsForProject('agent-ready', triage, true);
    assert.deepEqual(labels, ['Backlog', 'Todo', 'In Progress', 'Human Review', 'Rework', 'Merging', 'Done']);
  }
  assert.equal(requiredLabelsForProject('agent-ready', false, false).length, 8);
});

test('label sync removes only owned legacy labels and creates the workflow set', () => {
  const project = { repo: 'me/sandbox', local_repo: '.', base_branch: 'main', git_remote: 'origin',
    ready_label: 'agent-ready', branch_prefix: 'agent/issue-', checks: [], review_mode: 'manual' as const,
    pr_review: 'manual' as const, workflow_mode: 'github' as const, issue_intake: 'all' as const };
  const existing = ['Backlog', 'agent-ready', 'agent-running', 'agent-human-hold', 'agent-pr', 'agent-blocked', 'agent-merge', 'agent-complex', 'bug'];
  const plan = planLabelSync(project, existing);
  assert.deepEqual(plan.remove.sort(), ['agent-blocked', 'agent-complex', 'agent-human-hold', 'agent-merge', 'agent-pr', 'agent-ready', 'agent-running'].sort());
  assert.ok(plan.create.includes('Todo'));
  assert.ok(!plan.remove.includes('bug'), 'foreign labels are never removed');
});
