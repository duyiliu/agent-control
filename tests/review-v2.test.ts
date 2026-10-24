import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReviewV2 } from '../src/verify/review-v2.js';
import { runReview, ReviewInfraError } from '../src/verify/review.js';
import { buildReviewPrompt, type PromptContext } from '../src/scheduler/prompts.js';
import type { AgentCallResult } from '../src/runners/types.js';
import { tmpDir, cleanup, makeConfig } from './helpers.js';

const assessment = () => ({ protocol_version: 2, summary: '正常、错误、边界、旧调用已核实', findings: [] as object[], verification_requests: [] as object[], decision_requests: [] as object[], compatibility: { kind: 'additive', evidence: ['旧默认调用和新可选参数回归通过'] } });
const ok = (): AgentCallResult => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: null });
function setup() {
  const dir = tmpDir('ac-review-v2-'); const config = makeConfig(dir);
  const ctx: PromptContext = { project: config.projects[0]!, issue: { number: 1, title: 'optional CLI arg', body: 'preserve existing defaults', labels: [], state: 'OPEN', url: 'u' }, branch: 'b', workflowPath: join(dir, 'WORKFLOW.md'), worktreePath: dir };
  return { dir, ctx, deps: { agentConfig: config.agent, artifactsDir: dir, timeoutMs: 10_000, headSha: 'sha-v2', policyVersion: 2 as const } };
}
test('v2 compatible increment passes without old high-risk gate', () => {
  const result = parseReviewV2(JSON.stringify(assessment()));
  assert.equal(result.verdict, 'PASS'); assert.equal(result.risk, 'low');
  assert.equal(result.assessment?.compatibility.kind, 'additive');
});
test('v2 rejects narration, fences, legacy shape, missing fields and ungrounded records', () => {
  const a = assessment();
  for (const output of ['{}', `narration ${JSON.stringify(a)}`, '```json\n' + JSON.stringify(a) + '\n```', JSON.stringify({ verdict: 'PASS', risk: 'low', summary: 'ok', findings: [] }), JSON.stringify({ ...a, compatibility: { kind: 'unchanged', evidence: [] } }), JSON.stringify({ ...a, findings: [{ file: 'a', line: 0, trigger: 'x', impact: 'y', verification: 'z' }] }), JSON.stringify({ ...a, decision_requests: [{ type: 'product_choice', question: 'x', options: ['same', 'same'], impact: 'y', reason: 'z' }] })]) assert.throws(() => parseReviewV2(output));
});
test('v2 findings and concrete evidence gaps block for AI repair, not human risk', () => {
  for (const extra of [
    { findings: [{ file: 'src/cli.js', line: 715, trigger: 'Promise.reject()', impact: 'false CI success', verification: 'assert nonzero exit with concurrency 2' }] },
    { verification_requests: [{ claim: 'non Error rejection is preserved', scenario: 'reject undefined', expected: 'nonzero process exit' }] },
    { compatibility: { kind: 'unknown', evidence: ['legacy caller response not yet checked'] } },
    { compatibility: { kind: 'breaking', evidence: ['removed required field'] } },
  ]) { const r = parseReviewV2(JSON.stringify({ ...assessment(), ...extra })); assert.equal(r.verdict, 'BLOCK'); assert.equal(r.risk, 'low'); }
});
test('v2 concrete authorization has precedence over defect and keeps both', () => {
  const a = assessment(); a.findings.push({ file: 'a', line: 1, trigger: 'input', impact: 'bad output', verification: 'focused test' });
  a.decision_requests.push({ type: 'sensitive_authorization', question: '允许扩大令牌权限吗', options: ['维持权限', '批准扩大'], impact: '写权限扩大', reason: '原需求未批准', file: 'auth.ts', line: 2 });
  const r = parseReviewV2(JSON.stringify(a)); assert.equal(r.verdict, 'HUMAN_REVIEW_REQUIRED'); assert.equal(r.assessment?.findings.length, 1);
});
test('v2 strict protocol retries three times and never recovers narrated PASS', async () => {
  const e = setup(); try {
    let calls = 0;
    await assert.rejects(runReview(e.ctx, 'pass', 'diff', e.deps, async opts => {
      calls++; writeFileSync(opts.lastMessagePath, `narration ${JSON.stringify(assessment())}`); return ok();
    }), ReviewInfraError);
    assert.equal(calls, 3);
  } finally { cleanup(e.dir); }
});
const file = (name: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${'a'.repeat(35_000)}\n+${'b'.repeat(35_000)}\n`;
test('v2 every part contributes findings, evidence and decisions with the same SHA and budget', async () => {
  const e = setup(); try {
    let calls = 0;
    const r = await runReview(e.ctx, 'checks sha-v2', file('a') + file('b'), e.deps, async opts => {
      assert.match(opts.prompt, /sha-v2/); assert.deepEqual(opts.tools, ['read', 'grep', 'find', 'ls']); assert(opts.timeoutMs <= e.deps.timeoutMs);
      const a = assessment();
      if (++calls === 1) { a.findings.push({ file: 'a', line: 1, trigger: 'reject undefined', impact: 'exit 0', verification: 'assert exit 1' }); a.verification_requests.push({ claim: 'cleanup', scenario: 'inflight reject', expected: 'cleanup complete' }); }
      else a.decision_requests.push({ type: 'product_choice', question: '保留哪种默认行为', options: ['A', 'B'], impact: '旧调用', reason: '验收条件相互冲突' });
      writeFileSync(opts.lastMessagePath, JSON.stringify(a)); return ok();
    });
    assert.equal(calls, 2); assert.equal(r.result.verdict, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(r.result.assessment?.findings.length, 1); assert.equal(r.result.assessment?.verification_requests.length, 1); assert.equal(r.result.assessment?.decision_requests.length, 1);
    assert.equal(JSON.parse(readFileSync(r.logPath, 'utf8')).parts.length, 2);
  } finally { cleanup(e.dir); }
});
test('v2 final synthesis cannot erase conservative compatibility evidence from parts', async () => {
  const e = setup(); try {
    let calls = 0;
    const r = await runReview(e.ctx, 'pass', file('a') + file('b'), e.deps, async opts => {
      const a = assessment(); if (++calls === 3) { a.compatibility.kind = 'unchanged'; a.compatibility.evidence = ['整体调用方一致']; }
      writeFileSync(opts.lastMessagePath, JSON.stringify(a)); return ok();
    });
    assert.equal(calls, 3); assert.equal(r.result.verdict, 'PASS'); assert.equal(r.result.assessment?.compatibility.kind, 'additive');
    assert.deepEqual(r.result.assessment?.compatibility.evidence, ['旧默认调用和新可选参数回归通过', '整体调用方一致']);
  } finally { cleanup(e.dir); }
});
test('v2 incomplete diff is execution failure, not code high risk', async () => {
  const e = setup(); try { await assert.rejects(runReview(e.ctx, 'pass', '...[truncated 25 chars]', e.deps, async () => { assert.fail('must not call reviewer'); }), ReviewInfraError); } finally { cleanup(e.dir); }
});
test('v2 cannot accept a late PASS after total budget or convert cancellation into human risk', async () => {
  const e = setup(); try {
    await assert.rejects(runReview(e.ctx, 'pass', 'diff', { ...e.deps, timeoutMs: 1 }, async opts => {
      await new Promise(resolve => setTimeout(resolve, 15)); writeFileSync(opts.lastMessagePath, JSON.stringify(assessment())); return ok();
    }), ReviewInfraError);
    const ctl = new AbortController(); ctl.abort(); let calls = 0;
    await assert.rejects(runReview(e.ctx, 'pass', 'diff', { ...e.deps, signal: ctl.signal }, async () => { calls++; return ok(); }), ReviewInfraError);
    assert.equal(calls, 0);
  } finally { cleanup(e.dir); }
});
test('v2 prompt names meaningful boundary coverage and no shell authority', () => {
  const e = setup(); try {
    const p = buildReviewPrompt(e.ctx, 'checks', 'diff', 'sha', false, 2);
    assert.match(p, /非 Error 拒绝值/); assert.match(p, /契约版本号、文件数\/行数/); assert.match(p, /不得修改文件、运行 shell/); assert.doesNotMatch(p, /risk=high/);
  } finally { cleanup(e.dir); }
});
