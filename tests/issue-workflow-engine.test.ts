import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/scheduler/engine.js';
import { parseWorkflow, WORKFLOW_LABEL } from '../src/scheduler/issue-workflow.js';
import { setWorkflowStateFromBoard, type WorkflowBoardTracker } from '../src/workflow-board.js';
import type { GitHubTracker } from '../src/tracker/github.js';
import type { AgentCallResult } from '../src/runners/types.js';
import type { CoderSession } from '../src/runners/session.js';
import type { AppConfig } from '../src/types.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown } from './helpers.js';
import type { Store } from '../src/store/sqlite.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const REPO = 'me/sandbox';

function okCoder(): AgentCallResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: 42 };
}

function fakeCoder(): CoderSession {
  return {
    pid: 42,
    async prompt() {
      return { ok: true, aborted: false, timedOut: false, exitCode: 0, lastMessage: null, durationMs: 1, stderrTail: '' };
    },
    async close() {},
  };
}

const worktreeBases: string[] = [];
function fakeWorkspace() {
  return {
    ensureWorktree: async (input: { worktreePath: string; baseBranch: string }) => {
      worktreeBases.push(input.baseBranch);
      return { path: input.worktreePath, created: true };
    },
    isDirty: async () => false,
    dirtyUnder: async () => '',
    head: async () => 'head-sha',
    refSha: async (_repo: string, ref: string) => ref,
    commitAll: async () => false,
    aheadCount: async () => 1,
    diffVsBase: async () => 'diff',
    push: async () => {},
    fetchBranch: async () => {},
    resetHard: async () => {},
    addDetachedWorktree: async (_repo: string, sha: string, path: string) => path,
    removeWorktree: async () => {},
    pruneWorktrees: async () => {},
    deleteLocalBranch: async () => {},
    deleteRemoteBranch: async () => {},
  };
}

type BaseTracker = ReturnType<typeof makeFakeTracker>;

function workflowTracker(base: BaseTracker) {
  const events: { id: number; event: string; label: string | null; actor: string; actorType: string; createdAt: string }[] = [];
  const permissions = new Map<string, string | null>();
  const closedIssues: number[] = [];
  const tracker = Object.assign(base, {
    async listOpenIssues() {
      return [...base.issues.entries()]
        .filter(([, issue]) => issue.state === 'OPEN')
        .map(([number, issue]) => ({
          number, title: issue.title, body: issue.body, labels: [...issue.labels], state: 'OPEN', url: issue.url,
          createdAt: new Date().toISOString(), author: issue.author ?? 'owner', author_association: issue.author_association ?? 'OWNER',
        }));
    },
    async issueLabelEvents() {
      return [...events].sort((a, b) => a.id - b.id);
    },
    async collaboratorPermission(_repo: string, login: string) {
      return permissions.get(login) ?? null;
    },
    async authLogin() { return 'bot-host'; },
    async closeIssue(_repo: string, number: number) {
      closedIssues.push(number);
      const issue = base.issues.get(number);
      if (issue) issue.state = 'CLOSED';
    },
    async setWorkflowState(_repo: string, number: number, label: string, allLabels: readonly string[]) {
      const issue = base.issues.get(number);
      if (!issue) return;
      issue.labels = issue.labels.filter(item => !Object.values(WORKFLOW_LABEL).includes(item) || item === label);
      if (!issue.labels.includes(label)) issue.labels.push(label);
    },
  });
  return { tracker, events, permissions, closedIssues };
}

interface Env {
  dir: string;
  config: AppConfig;
  base: BaseTracker;
  wf: ReturnType<typeof workflowTracker>;
  store: Store;
  engine: Engine;
  done(): void;
}

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wf-engine-'));
  const config = makeConfig(dir);
  config.projects[0]!.workflow_mode = 'github';
  config.projects[0]!.review_mode = 'manual';
  config.projects[0]!.checks = [{ argv: ['x'] }];
  const base = makeFakeTracker();
  const wf = workflowTracker(base);
  const store = makeStore(dir);
  const engine = new Engine({
    store, config, tracker: wf.tracker as unknown as GitHubTracker,
    workspace: fakeWorkspace() as never, appLog: nullLog, installDir: dir,
    openCoderSessionFn: () => fakeCoder(), claimArbitrationMs: 0,
    runChecksFn: async (specs, _workdir, logPathFor) => ({
      ok: true,
      outcomes: specs.map((spec, index) => ({ spec, command: spec.argv.join(' '), exitCode: 0, timedOut: false, tail: 'passed', logPath: logPathFor(index) })),
      skipped: [], failureEvidence: '',
    }),
  });
  return { dir, config, base, wf, store, engine, done: () => teardown(dir, [store]) };
}

async function tickAndDrain(engine: Engine) {
  await engine.tick();
  for (let i = 0; i < 400 && engine.activeCount() > 0; i++) await sleep(20);
}

function addIssue(env: Env, number: number, labels: string[], body = 'Implement it.\n\nAC: works') {
  env.base.issues.set(number, { title: `Issue ${number}`, body, labels: [...labels], state: 'OPEN', url: `https://x/${number}` });
}

function humanEvent(env: Env, label: string, actor = 'human', permission: string | null = 'write', actorType = 'User') {
  const id = (env.wf.events.at(-1)?.id ?? 0) + 1;
  env.wf.events.push({ id, event: 'labeled', label, actor, actorType, createdAt: new Date(Date.now() + 1000).toISOString() });
  env.wf.permissions.set(actor, permission);
  return id;
}

function setState(env: Env, number: number, state: string) {
  const issue = env.base.issues.get(number)!;
  issue.labels = issue.labels.filter(label => !Object.values(WORKFLOW_LABEL).includes(label));
  issue.labels.push(labelOf(state));
}
const labelOf = (state: string) => WORKFLOW_LABEL[state as keyof typeof WORKFLOW_LABEL];

test('normal delivery: single executor reaches Human Review without any review run', async () => {
  const env = setup();
  try {
    addIssue(env, 1, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 1)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(env.base.prCreated, 1);
    assert.equal(env.store.runsForTask(task.id).filter(run => run.kind === 'review').length, 0);
    assert.equal(env.store.runsForTask(task.id).filter(run => run.kind === 'code').length, 1);
    assert.match(env.store.runsForTask(task.id).find(run => run.kind === 'code')?.branch ?? '', /-r1$/);
    assert.equal(record.observed_state, 'Human Review');
    assert.equal(record.handoff?.pr, 101);
    assert.equal(record.handoff?.head_sha, 'head-sha');
    assert.ok(env.base.issues.get(1)!.labels.includes('Human Review'));
    assert.equal(env.wf.closedIssues.length, 0);
    assert.equal(env.base.merged.length, 0);
  } finally { env.done(); }
});

test('a project without configured checks still hands the PR to Human Review', async () => {
  const env = setup();
  try {
    env.config.projects[0]!.checks = [];
    addIssue(env, 9, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 9)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(env.base.prCreated, 1);
    assert.equal(record.handoff?.pr, 101);
    assert.equal(record.handoff?.pr_url, task.pr_url);
    assert.equal(record.handoff?.head_sha, 'head-sha');
    assert.equal(record.diagnostic, null);
    assert.ok(env.base.issues.get(9)!.labels.includes('Human Review'));
  } finally { env.done(); }
});

test('a task stranded by the removed checks gate is re-bound on reconcile', async () => {
  const env = setup();
  try {
    addIssue(env, 21, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 21)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    record.handoff = null;
    record.diagnostic = '项目未配置可执行的检查命令，无法提供可审查验证证据';
    env.store.saveIssueWorkflow(task.id, JSON.stringify(record));

    await tickAndDrain(env.engine);
    const after = env.store.getTask(REPO, 21)!;
    const rebound = parseWorkflow(after.issue_workflow_json)!;
    assert.equal(after.status, 'AWAITING_HUMAN');
    assert.equal(rebound.handoff?.pr, 101);
    assert.equal(rebound.diagnostic, null);
    assert.equal(env.store.runsForTask(task.id).length, 1, 'rebinding must not start another run');
  } finally { env.done(); }
});

test('a red PR CI rollup blocks landing without voiding the handoff', async () => {
  const env = setup();
  try {
    addIssue(env, 31, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 31)!;
    const prNum = parseWorkflow(task.issue_workflow_json)!.handoff!.pr;
    env.base.prChecks.set(prNum, [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }]);
    humanEvent(env, 'Merging');
    setState(env, 31, 'Merging');
    await tickAndDrain(env.engine);
    const after = env.store.getTask(REPO, 31)!;
    const record = parseWorkflow(after.issue_workflow_json)!;
    assert.equal(after.status, 'AWAITING_HUMAN');
    assert.equal(env.base.merged.length, 0);
    assert.match(record.diagnostic ?? '', /PR CI 未全部通过/);
    assert.equal(record.handoff?.pr, prNum, 'a red CI must not erase the delivery scope');
  } finally { env.done(); }
});

test('rework: verified human event starts generation 2 from a new branch and session', async () => {
  const env = setup();
  try {
    addIssue(env, 2, ['Todo']);
    await tickAndDrain(env.engine);
    const first = env.store.getTask(REPO, 2)!;
    const oldPr = first.pr_url!;
    humanEvent(env, 'Rework');
    setState(env, 2, 'Rework');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 2)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(record.generation, 2);
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0]!.pr_url, oldPr);
    assert.equal(env.base.prStates.get(101), 'CLOSED');
    assert.equal(env.base.prCreated, 2);
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.match(task.branch ?? '', /-r2$/);
    assert.ok(worktreeBases.includes('origin/main'), 'rework must branch from the fetched remote base');
    assert.equal(record.handoff?.pr, 102);
    assert.equal(record.observed_state, 'Human Review');
    assert.equal(env.store.runsForTask(task.id).filter(run => run.kind === 'code').length, 2);
  } finally { env.done(); }
});

test('merge failure keeps Merging, does not close the issue or mark Done', async () => {
  const env = setup();
  try {
    addIssue(env, 3, ['Todo']);
    await tickAndDrain(env.engine);
    humanEvent(env, 'Merging');
    setState(env, 3, 'Merging');
    env.base.mergeErrors.set(101, new Error('protected branch: review required'));
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 3)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(task.status, 'MERGING');
    assert.match(record.diagnostic ?? '', /合并失败/);
    assert.equal(env.wf.closedIssues.length, 0);
    assert.equal(env.base.issues.get(3)!.state, 'OPEN');
    assert.ok(env.base.issues.get(3)!.labels.includes('Merging'));
  } finally { env.done(); }
});

test('restart recovery: an already merged PR completes Done exactly once without re-merging', async () => {
  const env = setup();
  try {
    addIssue(env, 4, ['Todo']);
    await tickAndDrain(env.engine);
    humanEvent(env, 'Merging');
    setState(env, 4, 'Merging');
    env.base.prStates.set(101, 'MERGED');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 4)!;
    assert.equal(task.status, 'COMPLETED');
    assert.equal(parseWorkflow(task.issue_workflow_json)!.observed_state, 'Done');
    assert.deepEqual(env.wf.closedIssues, [4]);
    assert.equal(env.base.merged.length, 0);
    await tickAndDrain(env.engine);
    assert.deepEqual(env.wf.closedIssues, [4]);
  } finally { env.done(); }
});

test('landing: a "Closes #N" merge auto-closes the Issue but Done still lands and pending drains', async () => {
  const env = setup();
  try {
    addIssue(env, 6, ['Todo']);
    await tickAndDrain(env.engine);
    humanEvent(env, 'Merging');
    setState(env, 6, 'Merging');
    const mergePr = env.wf.tracker.mergePr;
    env.wf.tracker.mergePr = async (repo: string, n: number, sha: string) => {
      await mergePr(repo, n, sha);
      env.base.issues.get(6)!.state = 'CLOSED';
    };
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 6)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(task.status, 'COMPLETED');
    assert.equal(record.observed_state, 'Done');
    assert.equal(record.pending_label, null);
    assert.equal(env.base.issues.get(6)!.state, 'CLOSED');
    assert.ok(env.base.issues.get(6)!.labels.includes('Done'));
    await tickAndDrain(env.engine);
    assert.equal(parseWorkflow(env.store.getTask(REPO, 6)!.issue_workflow_json)!.pending_label, null);
  } finally { env.done(); }
});

test('closed reconcile drains a wedged pending label on a completed workflow task', async () => {
  const env = setup();
  try {
    env.config.review_policy = { version: 2 };
    addIssue(env, 7, ['Todo']);
    await tickAndDrain(env.engine);
    humanEvent(env, 'Merging');
    setState(env, 7, 'Merging');
    await tickAndDrain(env.engine);
    // Simulate the pre-fix wedge: merge landed, issue closed, pending stuck.
    const task = env.store.getTask(REPO, 7)!;
    const record = parseWorkflow(task.issue_workflow_json)!;
    record.observed_state = 'Merging'; record.pending_label = 'Done';
    env.store.saveIssueWorkflow(task.id, JSON.stringify(record));
    env.base.issues.get(7)!.labels = ['Merging'];
    await tickAndDrain(env.engine);
    const after = parseWorkflow(env.store.getTask(REPO, 7)!.issue_workflow_json)!;
    assert.equal(after.observed_state, 'Done');
    assert.equal(after.pending_label, null);
    assert.deepEqual(env.base.issues.get(7)!.labels, ['Done']);
  } finally { env.done(); }
});

test('illegal transitions: Done without a merged PR is repaired, conflicts are not dispatched', async () => {
  const env = setup();
  try {
    addIssue(env, 5, ['Done']);
    await tickAndDrain(env.engine);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 5)!;
    assert.notEqual(task.status, 'COMPLETED');
    assert.ok(env.base.issues.get(5)!.labels.includes('Human Review'));
    assert.equal(env.base.prCreated, 0);

    addIssue(env, 6, ['Todo', 'Merging']);
    await tickAndDrain(env.engine);
    const conflicted = env.store.getTask(REPO, 6)!;
    assert.equal(env.store.runsForTask(conflicted.id).length, 0);
    assert.ok(env.base.issues.get(6)!.labels.includes('Backlog'));
  } finally { env.done(); }
});

test('Backlog is never claimed', async () => {
  const env = setup();
  try {
    addIssue(env, 7, []);
    await tickAndDrain(env.engine);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 7)!;
    assert.equal(env.store.runsForTask(task.id).length, 0);
    assert.equal(task.status, 'DISCOVERED');
    assert.ok(env.base.issues.get(7)!.labels.includes('Backlog'));
  } finally { env.done(); }
});

test('the host automation identity cannot authorize its own Merging transition', async () => {
  const env = setup();
  try {
    addIssue(env, 8, ['Todo']);
    await tickAndDrain(env.engine);
    humanEvent(env, 'Merging', 'bot-host', 'admin');
    setState(env, 8, 'Merging');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 8)!;
    assert.equal(env.base.merged.length, 0);
    assert.equal(env.wf.closedIssues.length, 0);
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.ok(env.base.issues.get(8)!.labels.includes('Human Review'));
    assert.match(parseWorkflow(task.issue_workflow_json)!.diagnostic ?? '', /宿主/);
  } finally { env.done(); }
});

test('rework resumes a persisted intent after a crash without a second event or generation', async () => {
  const env = setup();
  try {
    addIssue(env, 9, ['Todo']);
    await tickAndDrain(env.engine);
    const first = env.store.getTask(REPO, 9)!;
    const record = parseWorkflow(first.issue_workflow_json)!;
    record.rework = { event_id: 999, actor: 'human', from_generation: 1 };
    record.history.push({ generation: 1, pr_url: first.pr_url, branch: first.branch, head_sha: record.handoff?.head_sha ?? null, closed_at: new Date().toISOString(), reason: 'Rework by human' });
    record.generation = 2;
    record.handoff = null; record.approval = null;
    env.store.saveIssueWorkflow(first.id, JSON.stringify(record));
    setState(env, 9, 'Rework');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 9)!;
    const after = parseWorkflow(task.issue_workflow_json)!;
    assert.equal(after.generation, 2);
    assert.equal(after.history.length, 1);
    assert.equal(env.base.prCreated, 2);
    assert.equal(env.base.prStates.get(101), 'CLOSED');
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.match(task.branch ?? '', /-r2$/);
  } finally { env.done(); }
});

test('bot and permissionless actors cannot authorize Merging', async () => {
  for (const [actor, permission, actorType, reason] of [
    ['robot', 'write', 'Bot', /人类/],
    ['stranger', null, 'User', /写权限/],
  ] as const) {
    const env = setup();
    try {
      addIssue(env, 10, ['Todo']);
      await tickAndDrain(env.engine);
      humanEvent(env, 'Merging', actor, permission, actorType);
      setState(env, 10, 'Merging');
      await tickAndDrain(env.engine);
      const task = env.store.getTask(REPO, 10)!;
      assert.equal(env.base.merged.length, 0);
      assert.equal(task.status, 'AWAITING_HUMAN');
      assert.ok(env.base.issues.get(10)!.labels.includes('Human Review'));
      assert.match(parseWorkflow(task.issue_workflow_json)!.diagnostic ?? '', reason);
    } finally { env.done(); }
  }
});

test('an event before the handoff cannot authorize Merging', async () => {
  const env = setup();
  try {
    addIssue(env, 11, ['Todo']);
    env.wf.events.push({ id: 1, event: 'labeled', label: 'Merging', actor: 'human', actorType: 'User', createdAt: '2020-01-01T00:00:00.000Z' });
    env.wf.permissions.set('human', 'write');
    await tickAndDrain(env.engine);
    setState(env, 11, 'Merging');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 11)!;
    assert.equal(env.base.merged.length, 0);
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.match(parseWorkflow(task.issue_workflow_json)!.diagnostic ?? '', /交付之后/);
  } finally { env.done(); }
});

test('leaving Human Review voids the reviewed handoff scope', async () => {
  const env = setup();
  try {
    addIssue(env, 12, ['Todo']);
    await tickAndDrain(env.engine);
    setState(env, 12, 'Todo');
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 12)!;
    assert.equal(parseWorkflow(task.issue_workflow_json)!.handoff, null);
  } finally { env.done(); }
});

test('a github workflow project never dispatches a legacy task', async () => {
  const env = setup();
  try {
    addIssue(env, 90, []);
    const { task } = env.store.upsertDiscovered({ repo: REPO, issue_number: 90, issue_title: 'legacy', issue_url: 'https://x/90' });
    await tickAndDrain(env.engine);
    assert.equal(env.store.getTaskById(task.id)!.status, 'DISCOVERED');
    assert.equal(env.store.runsForTask(task.id).length, 0);
    assert.equal(env.store.getTaskById(task.id)!.issue_workflow_json, null);
  } finally { env.done(); }
});

test('a github workflow project never reviews a legacy AWAITING_REVIEW task', async () => {
  const env = setup();
  try {
    addIssue(env, 91, []);
    const { task } = env.store.upsertDiscovered({ repo: REPO, issue_number: 91, issue_title: 'legacy', issue_url: 'https://x/91' });
    env.store.setTaskStatus(task.id, 'AWAITING_REVIEW', { pr_url: 'https://x/pull/91' });
    await tickAndDrain(env.engine);
    assert.equal(env.store.runsForTask(task.id).length, 0);
    assert.equal(env.store.getTaskById(task.id)!.status, 'AWAITING_REVIEW');
  } finally { env.done(); }
});

test('board approval merges Human Review without a GitHub human event', async () => {
  const env = setup();
  try {
    addIssue(env, 20, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 20)!;
    assert.equal(task.status, 'AWAITING_HUMAN');
    assert.equal(env.base.merged.length, 0);
    await setWorkflowStateFromBoard(
      env.store, env.config, env.wf.tracker as unknown as WorkflowBoardTracker,
      task, 'Merging', task.updated_at,
    );
    await tickAndDrain(env.engine);
    const after = env.store.getTask(REPO, 20)!;
    assert.equal(after.status, 'COMPLETED');
    assert.deepEqual(env.base.merged, [101]);
    assert.equal(parseWorkflow(after.issue_workflow_json)!.approval?.source, 'board');
    assert.ok(env.wf.closedIssues.includes(20));
  } finally { env.done(); }
});

test('board rework starts generation 2 without a GitHub human event', async () => {
  const env = setup();
  try {
    addIssue(env, 21, ['Todo']);
    await tickAndDrain(env.engine);
    const task = env.store.getTask(REPO, 21)!;
    await setWorkflowStateFromBoard(
      env.store, env.config, env.wf.tracker as unknown as WorkflowBoardTracker,
      task, 'Rework', task.updated_at,
    );
    await tickAndDrain(env.engine);
    const after = env.store.getTask(REPO, 21)!;
    const record = parseWorkflow(after.issue_workflow_json)!;
    assert.equal(record.generation, 2);
    assert.equal(record.rework, null);
    assert.equal(after.status, 'AWAITING_HUMAN');
    assert.match(after.branch ?? '', /-r2$/);
    assert.equal(env.base.prCreated, 2);
    assert.equal(env.base.prStates.get(101), 'CLOSED');
  } finally { env.done(); }
});
