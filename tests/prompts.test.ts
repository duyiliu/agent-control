import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoderPrompt, buildFixPrompt, type PromptContext } from '../src/scheduler/prompts.js';
import type { IssueData, ProjectConfig } from '../src/types.js';

const project: ProjectConfig = {
  repo: 'me/r',
  local_repo: '.',
  base_branch: 'main',
  ready_label: 'agent-ready',
  branch_prefix: 'agent/issue-',
  checks: [],
};

const issue: IssueData = {
  number: 7,
  title: 't',
  body: 'b',
  labels: [],
  state: 'OPEN',
  url: 'u',
};

function ctx(containerized?: boolean): PromptContext {
  return { project, issue, branch: 'agent/issue-7', workflowPath: 'nonexistent-WORKFLOW.md', worktreePath: 'nonexistent', containerized };
}

test('coder prompt (host): requires commit, keeps git recovery hints', () => {
  const p = buildCoderPrompt(ctx());
  assert.ok(p.includes('git add -A && git commit'));
  assert.ok(!p.includes('本环境没有 git'));
  const resumed = buildCoderPrompt(ctx(), true);
  assert.ok(resumed.includes('`git status` / `git log`'));
  const resumedC = buildCoderPrompt(ctx(true), true);
  assert.ok(resumedC.includes('已是最新状态'));
  assert.ok(!resumedC.includes('`git status`'));
});

test('coder prompt (container): no git at all, files are the latest state', () => {
  const p = buildCoderPrompt(ctx(true));
  assert.ok(p.includes('本环境没有 git'));
  assert.ok(!p.includes('git add -A'));
  assert.ok(!p.includes('`git status`'));
  assert.ok(p.includes('调度器会在宿主侧统一提交'));
});

test('fix prompt (container): minimal fix without git commands', () => {
  const host = buildFixPrompt(ctx(), 'evidence');
  assert.ok(host.includes('git add -A && git commit'));
  const c = buildFixPrompt(ctx(true), 'evidence');
  assert.ok(c.includes('本环境没有 git'));
  assert.ok(!c.includes('git add -A'));
});
