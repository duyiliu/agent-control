import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, type EngineDeps } from '../src/scheduler/engine.js';
import type { GitWorkspace } from '../src/workspace/git.js';
import { approvalHash, type GitHubTracker } from '../src/tracker/github.js';
import { newReviewControl } from '../src/verify/review-policy.js';
import { ReviewInfraError } from '../src/verify/review.js';
import type { ReviewAssessment } from '../src/types.js';
import { makeConfig, makeStore, makeFakeTracker, nullLog, tmpDir, teardown } from './helpers.js';

// These fixtures exercise the real Engine and temporary SQLite, with canned model,
// check, Git and tracker seams. They never contact services or a real repository.
const REPO = 'me/sandbox';
const SHA = 'head-sha';
const issue = { number: 40, title: 'add optional vars', body: 'Preserve old defaults; validate optional vars.', labels: ['agent-ready'], state: 'OPEN', url: 'https://example.test/40' };
const assessment = (): ReviewAssessment => ({ protocol_version: 2, summary: 'Normal/error/boundary/legacy defaults checked', findings: [], verification_requests: [], decision_requests: [], compatibility: { kind: 'additive', evidence: ['Old default invocation and new optional argument verified'] } });
const patch = (path = 'src/cli.js', count = 1) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${count} @@\n-old\n${'+new\n'.repeat(count)}`;
function boot(options: { assessment?: ReviewAssessment; failReview?: boolean; protected?: string[]; bare?: boolean; diff?: string; previousFix?: boolean; emptyChecks?: boolean } = {}) {
  const dir = tmpDir('ac-review-engine-v2-');
  const config = makeConfig(dir, { review_policy: { version: 2, timeout_minutes: 10 } });
  config.approvals.auto_merge.enabled = true;
  config.projects[0]!.human_review_paths = options.protected;
  if (options.emptyChecks) config.projects[0]!.checks = [];
  config.projects[0]!.pr_review = 'auto';
  const tracker = makeFakeTracker(); tracker.issues.set(40, { ...issue, labels: [...issue.labels] });
  const getDetails = (tracker as unknown as GitHubTracker).getPrDetails.bind(tracker);
  (tracker as unknown as GitHubTracker).getPrDetails = async (repo, n) => ({ ...await getDetails(repo, n), baseSha: 'base-sha' });
  const store = makeStore(dir); const site = join(dir, 'site'); mkdirSync(site);
  const task = options.bare ? store.upsertPrTask({ repo: REPO, number: 40, title: 'external', url: 'https://example.test/pull/40', branch: 'feature/ext' }).task
    : store.upsertDiscovered({ repo: REPO, issue_number: 40, issue_title: issue.title, issue_url: issue.url }).task;
  if (!options.bare) {
    const code = store.claimRun(task.id); store.updateRunFields(code.run_id, { workspace: site }); store.endRun(code.run_id, 'AWAITING_REVIEW');
    if (options.previousFix) store.transition(code.run_id, 'AWAITING_REVIEW', 'AWAITING_REVIEW', {
      kind: 'pending_fix_consumed', head_sha: 'older-sha', title: 'Review BLOCK', summary: 'fixed the rejected input path', findings: ['src/cli.js: unhandled plugin rejection returns success'],
    });
    store.setApprovedHash(task.id, approvalHash(issue));
  }
  store.setTaskStatus(task.id, 'AWAITING_REVIEW', { pr_url: 'https://example.test/pull/40', branch: options.bare ? 'feature/ext' : 'agent/issue-40' });
  if (!options.bare) tracker.prs.set('agent/issue-40', { number: 40, url: 'https://example.test/pull/40', state: 'OPEN', isDraft: true });
  store.saveReviewControl(task.id, newReviewControl(approvalHash(issue)));
  const calls = { reviews: 0, checks: 0, coder: 0 };
  const workspace = {
    head: async () => SHA, refSha: async () => 'base-sha', isDirty: async () => false,
    diffVsBase: async () => options.diff ?? patch(), fetchBranch: async () => {}, removeWorktree: async () => {},
    addDetachedWorktree: async (_repo: string, _sha: string, path: string) => { mkdirSync(path, { recursive: true }); return path; },
    deleteLocalBranch: async () => {}, deleteRemoteBranch: async () => {},
  } as unknown as GitWorkspace;
  const deps: EngineDeps = {
    store, config, tracker: tracker as unknown as GitHubTracker, workspace, appLog: nullLog, installDir: dir, claimArbitrationMs: 0,
    openCoderSessionFn: () => { calls.coder++; throw new Error('unexpected coder launch'); },
    runChecksFn: async (specs, _cwd, artifact) => {
      calls.checks++;
      return { ok: true, skipped: [], failureEvidence: '', outcomes: specs.map((spec, i) => {
        const logPath = artifact(i); writeFileSync(logPath, 'focused tests passed');
        return { spec, command: spec.argv.join(' '), exitCode: 0, timedOut: false, tail: 'focused tests passed', logPath };
      }) };
    },
    runReviewFn: async (_ctx, _tests, _diff, reviewDeps) => {
      calls.reviews++; assert.equal(reviewDeps.policyVersion, 2); assert.equal(reviewDeps.headSha, SHA);
      if (options.previousFix) assert.match(reviewDeps.previousReviewContext ?? '', /unhandled plugin rejection/);
      if (options.failReview) throw new ReviewInfraError('model unavailable');
      return { result: { verdict: 'PASS', risk: 'high', summary: 'canned model assessment', findings: [], assessment: options.assessment ?? assessment() }, logPath: join(dir, 'model.jsonl') };
    },
  };
  let engine = new Engine(deps);
  return { dir, config, store, tracker, task, calls, get engine() { return engine; }, restart() { engine = new Engine(deps); }, done() { teardown(dir, [store]); } };
}
async function tick(e: ReturnType<typeof boot>) {
  await e.engine.tick();
  for (let i = 0; i < 200 && e.engine.activeCount(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(e.engine.activeCount(), 0, 'run must finish');
}

test('v2 engine #40 compatible additive change hands a Ready PR to a human without auto-merging', async () => {
  const e = boot({ diff: patch('src/cli.js', 409) }); try {
    await tick(e); assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    assert.equal(e.store.getTaskById(e.task.id)?.approved_sha, null); assert.equal(e.tracker.prs.get('agent/issue-40')?.isDraft, false);
    assert.ok(e.tracker.prComments.some(([, body]) => body.includes('AI 已完成，待人工审查') && body.includes(SHA)));
    assert.equal(e.calls.reviews, 1); assert.equal(e.calls.checks, 1);
    assert.equal(e.store.getReviewControl(e.task.id)?.rounds, 1); assert.equal(e.tracker.merged.length, 0);
  } finally { e.done(); }
});
test('v2 reviewer receives host-recorded findings and repair summary in a new stateless review', async () => {
  const e = boot({ previousFix: true }); try {
    await tick(e);
    assert.equal(e.calls.reviews, 1);
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
  } finally { e.done(); }
});
test('v2 review PASS with no applicable host checks keeps the PR in Draft', async () => {
  const e = boot({ emptyChecks: true }); try {
    await tick(e);
    const run = e.store.runsForTask(e.task.id).at(-1)!;
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    assert.equal(e.tracker.prs.get('agent/issue-40')?.isDraft, true);
    assert.match(run.reason ?? '', /零项检查不能证明验证通过/);
    assert.equal(e.tracker.merged.length, 0);
  } finally { e.done(); }
});
test('v2 handoff failure leaves the PR Draft and records an actionable reason', async () => {
  const e = boot(); try {
    (e.tracker as unknown as GitHubTracker).markPrReady = async () => { throw new Error('GitHub unavailable'); };
    await tick(e);
    const run = e.store.runsForTask(e.task.id).at(-1)!;
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    assert.equal(e.tracker.prs.get('agent/issue-40')?.isDraft, true);
    assert.match(run.reason ?? '', /PR 无法安全转 Ready/);
  } finally { e.done(); }
});
for (const mode of ['finding', 'verification'] as const) test(`v2 engine ${mode} queues AI repair and consumes shared fix budget`, async () => {
  const a = assessment();
  if (mode === 'finding') a.findings.push({ file: 'src/cli.js', line: 715, trigger: 'Promise.reject()', impact: 'exit 0 produces false CI success', verification: 'assert nonzero exit for concurrency=2' });
  else a.verification_requests.push({ claim: 'legacy defaults unchanged', scenario: 'old invocation with no overrides', expected: 'same result and exit status' });
  const e = boot({ assessment: a }); try {
    await tick(e); const t = e.store.getTaskById(e.task.id)!;
    assert.equal(t.status, 'DISCOVERED'); assert.ok(t.pending_fix); assert.match(t.pending_fix, mode === 'finding' ? /Promise.reject/ : /legacy defaults/);
    assert.equal(e.store.getReviewControl(t.id)?.fix_attempts, 1); assert.equal(t.fix_rounds, 1); assert.equal(e.calls.coder, 0);
  } finally { e.done(); }
});
test('v2 engine real product choice requests human decision with SHA and stable request id', async () => {
  const a = assessment(); a.decision_requests.push({ type: 'product_choice', question: 'Which incompatible default wins?', options: ['Keep existing', 'Adopt new'], impact: 'Old callers change behavior', reason: 'Acceptance requirements conflict', file: 'src/cli.js', line: 1 });
  const e = boot({ assessment: a }); try {
    await tick(e); assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    const d = e.store.getReviewControl(e.task.id)!.decisions[0]!; assert.equal(d.head_sha, SHA); assert.ok(d.request_id); assert.equal(d.requirement_hash, approvalHash(issue));
    assert.equal(e.store.getTaskById(e.task.id)?.pending_fix, null);
  } finally { e.done(); }
});
test('v2 engine ERROR schedules retry and same-SHA ERROR does not strand a due retry', async () => {
  const e = boot({ failReview: true }); try {
    await tick(e); assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_REVIEW');
    const c = e.store.getReviewControl(e.task.id)!; assert.equal(c.infra_attempts, 1); assert.ok(c.next_attempt_at && Date.parse(c.next_attempt_at) > Date.now());
    await tick(e); assert.equal(e.calls.reviews, 1);
    e.store.saveReviewControl(e.task.id, { ...c, next_attempt_at: new Date(0).toISOString() });
    e.restart(); await tick(e); assert.equal(e.calls.reviews, 2); assert.equal(e.store.getReviewControl(e.task.id)?.infra_attempts, 2);
    assert.equal(e.store.getReviewControl(e.task.id)?.rounds, 2);
    const rows = e.store.runsForTask(e.task.id).flatMap(r => e.store.checksForRun(r.run_id));
    assert.equal(rows.filter(r => r.kind === 'review' && r.verdict === 'ERROR').length, 2);
  } finally { e.done(); }
});
test('v2 engine total review budget survives a new Engine and prevents seventh round', async () => {
  const e = boot(); try {
    e.store.saveReviewControl(e.task.id, { ...newReviewControl(approvalHash(issue)), rounds: 6, fix_attempts: 2 });
    e.restart(); await tick(e); assert.equal(e.store.getTaskById(e.task.id)?.status, 'BLOCKED'); assert.equal(e.calls.reviews, 0);
    assert.equal(e.store.getReviewControl(e.task.id)?.rounds, 6); assert.equal(e.store.getReviewControl(e.task.id)?.fix_attempts, 2);
  } finally { e.done(); }
});
test('v2 engine persistent infrastructure failure stops after three attempts, without a human code verdict', async () => {
  const e = boot({ failReview: true }); try {
    for (let i = 1; i <= 3; i++) {
      await tick(e); const c = e.store.getReviewControl(e.task.id)!;
      assert.equal(c.infra_attempts, i);
      if (i < 3) { assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_REVIEW'); e.store.saveReviewControl(e.task.id, { ...c, next_attempt_at: new Date(0).toISOString() }); e.restart(); }
    }
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'BLOCKED'); assert.equal(e.store.getReviewControl(e.task.id)?.next_attempt_at, null);
    e.restart(); await tick(e); assert.equal(e.calls.reviews, 3);
    assert.equal(e.tracker.labelsAdded.some(([, label]) => label === 'agent-high-risk'), false);
  } finally { e.done(); }
});
test('v2 engine findings after shared repair budget exhaustion stop without queuing another fix', async () => {
  const a = assessment(); a.findings.push({ file: 'src/cli.js', line: 1, trigger: 'invalid input', impact: 'false success', verification: 'assert failure exit' });
  const e = boot({ assessment: a }); try {
    e.store.saveReviewControl(e.task.id, { ...newReviewControl(approvalHash(issue)), fix_attempts: e.config.server.retry_limit });
    await tick(e); const t = e.store.getTaskById(e.task.id)!;
    assert.equal(t.status, 'BLOCKED'); assert.equal(t.pending_fix, null); assert.equal(e.store.getReviewControl(t.id)?.fix_attempts, e.config.server.retry_limit);
  } finally { e.done(); }
});
test('v2 engine explicit protected paths are decisions despite reviewer PASS', async () => {
  const e = boot({ protected: ['src/**'] }); try {
    await tick(e); assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    assert.equal(e.store.getReviewControl(e.task.id)?.decisions[0]?.type, 'configured_hold'); assert.equal(e.calls.coder, 0);
  } finally { e.done(); }
});

for (const path of ['dist/index.js', 'docs/guide.md']) test(`v2 protected ${path} stays a human gate even when excluded from reviewer diff`, async () => {
  const e = boot({ protected: [path], diff: patch(path) }); try {
    await tick(e);
    assert.equal(e.store.getTaskById(e.task.id)?.status, 'AWAITING_HUMAN');
    assert.equal(e.store.getReviewControl(e.task.id)?.decisions[0]?.file, path);
  } finally { e.done(); }
});
test('v2 bare PR review remains advisory and never executes checks, repair or merge', async () => {
  const a = assessment(); a.findings.push({ file: 'src/cli.js', line: 1, trigger: 'input', impact: 'incorrect output', verification: 'focused assertion' });
  const e = boot({ bare: true, assessment: a }); try {
    await tick(e); const t = e.store.getTaskById(e.task.id)!;
    assert.equal(t.status, 'BLOCKED'); assert.equal(t.pending_fix, null); assert.equal(e.calls.checks, 0); assert.equal(e.calls.coder, 0); assert.equal(e.tracker.merged.length, 0);
  } finally { e.done(); }
});
test('v2 externally closed issue cancels pending work and retry, preserving explicit deferral', async () => {
  for (const deferred of [false, true]) {
    const e = boot(); try {
      e.tracker.issues.get(40)!.state = 'CLOSED';
      e.store.setTaskStatus(e.task.id, 'BLOCKED', { pending_fix: JSON.stringify({ head_sha: SHA, summary: 'old error', findings: ['old'] }) });
      e.store.saveReviewControl(e.task.id, { ...newReviewControl(approvalHash(issue)), next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
      if (deferred) e.store.saveIntake(REPO, 40, { kind: 'deferred', imported: true });
      await tick(e); const t = e.store.getTaskById(e.task.id)!;
      assert.equal(t.status, deferred ? 'BLOCKED' : 'CANCELED');
      if (!deferred) { assert.equal(t.pending_fix, null); assert.equal(e.store.getReviewControl(t.id)?.next_attempt_at, null); }
      assert.equal(e.calls.reviews, 0);
    } finally { e.done(); }
  }
});
