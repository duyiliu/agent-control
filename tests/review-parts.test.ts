import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewParts, MAX_REVIEW_PARTS } from '../src/verify/review-parts.js';
import { runReview, ReviewInfraError } from '../src/verify/review.js';
import { MAX_REVIEW_DIFF_CHARS, type PromptContext } from '../src/scheduler/prompts.js';
import type { AgentCallResult } from '../src/runners/types.js';
import { tmpDir, cleanup, makeConfig } from './helpers.js';

const passed = { verdict: 'PASS' as const, risk: 'low' as const, summary: 'checked', findings: [] };
const ok = (): AgentCallResult => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: null });
const file = (name: string, size = 70_000) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${'a'.repeat(size / 2)}\n+${'b'.repeat(size / 2)}\n`;
const diff = file('a.ts') + file('b.ts');

function setup() {
  const dir = tmpDir('ac-parts-');
  const config = makeConfig(dir);
  const ctx: PromptContext = { project: config.projects[0]!, issue: { number: 1, title: 't', body: 'acceptance', labels: [], state: 'OPEN', url: 'u' }, branch: 'b', workflowPath: join(dir, 'WORKFLOW.md'), worktreePath: dir };
  return { dir, ctx, deps: { agentConfig: config.agent, artifactsDir: dir, timeoutMs: 10_000, headSha: 'pinned-head' } };
}

test('parts preserve all bytes and file boundaries, including stat and omission headers', () => {
  const original = '已省略 2 个生成物文件\n## STAT\nstat\n## DIFF\n' + diff;
  const parts = reviewParts(original)!;
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), original);
  assert(parts.every(p => p.length <= MAX_REVIEW_DIFF_CHARS));
});

test('large file splits only at complete hunks and repeats file headers', () => {
  const header = 'diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n';
  const hunks = [1, 2, 3].map(i => `@@ -${i} +${i} @@\n+${String(i).repeat(60_000)}\n`);
  const parts = reviewParts(header + hunks.join(''))!;
  assert.equal(parts.length, 3);
  for (let i = 0; i < parts.length; i++) assert.equal(parts[i], header + hunks[i]);
});

test('incomplete data, oversized single hunk, and excess parts are refused', () => {
  assert.equal(reviewParts(diff + '...[truncated 25 chars]'), null);
  assert.equal(reviewParts(file('huge.ts', 130_000)), null);
  assert.equal(reviewParts(Array.from({ length: MAX_REVIEW_PARTS + 1 }, (_, i) => file(`${i}.ts`)).join('')), null);
});

test('large review runs every part then cross-file review with pinned sha and readonly tools', async () => {
  const e = setup();
  try {
    const prompts: string[] = [];
    const out = await runReview(e.ctx, 'tests PASS for pinned-head', diff, e.deps, async opts => {
      prompts.push(opts.prompt);
      assert.match(opts.prompt, /pinned-head/);
      assert.deepEqual(opts.tools, ['read', 'grep', 'find', 'ls']);
      writeFileSync(opts.lastMessagePath, JSON.stringify(passed)); return ok();
    });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0]!, /分段评审 1\/2/);
    assert.match(prompts[1]!, /分段评审 2\/2/);
    assert.match(prompts[2]!, /跨文件汇总评审/);
    assert.match(prompts[2]!, /a\.ts/);
    assert.match(prompts[2]!, /b\.ts/);
    assert.deepEqual(out.result, passed);
    const report = JSON.parse(readFileSync(out.logPath, 'utf8'));
    assert.equal(report.head_sha, 'pinned-head');
    assert.equal(report.parts.length, 3);
    assert.equal(readFileSync(report.diff_path, 'utf8'), diff);
  } finally { cleanup(e.dir); }
});

for (const result of [
  { ...passed, verdict: 'BLOCK' as const, summary: 'confirmed bug', findings: ['a.ts:1: invalid result for input X'] },
  { ...passed, verdict: 'HUMAN_REVIEW_REQUIRED' as const, risk: 'high' as const },
  { ...passed, risk: 'high' as const },
]) test(`part ${result.verdict}/${result.risk} cannot be overridden by later PASS`, async () => {
  const e = setup();
  try {
    let calls = 0;
    const out = await runReview(e.ctx, 'pass', diff, e.deps, async opts => {
      writeFileSync(opts.lastMessagePath, JSON.stringify(++calls === 1 ? result : passed)); return ok();
    });
    assert.equal(calls, 2);
    assert.equal(out.result.verdict, result.verdict);
    assert.equal(out.result.risk, result.risk);
    assert.deepEqual(out.result.findings, result.findings);
  } finally { cleanup(e.dir); }
});

test('cross-file review can block otherwise passing parts', async () => {
  const e = setup();
  try {
    let calls = 0;
    const out = await runReview(e.ctx, 'pass', diff, e.deps, async opts => {
      writeFileSync(opts.lastMessagePath, JSON.stringify(++calls === 3 ? { ...passed, verdict: 'BLOCK', findings: ['b.ts:1: caller incompatible with a.ts'], summary: 'cross-file regression' } : passed)); return ok();
    });
    assert.equal(out.result.verdict, 'BLOCK');
  } finally { cleanup(e.dir); }
});

test('segmented review cancellation stops before dispatching another part', async () => {
  const e = setup(); const ctl = new AbortController();
  try {
    let calls = 0;
    await runReview(e.ctx, 'pass', diff, { ...e.deps, signal: ctl.signal }, async () => { calls++; ctl.abort(); return { ...ok(), aborted: true }; });
    assert.equal(calls, 1);
  } finally { cleanup(e.dir); }
});

for (const risk of ['low', 'high'] as const) test(`last formatting retry accepts a fresh ${risk} verdict`, async () => {
  const e = setup();
  try {
    let calls = 0;
    const out = await runReview(e.ctx, 'pass', 'diff', e.deps, async opts => {
      if (++calls === 3) assert.match(opts.prompt, /已连续两轮未满足输出协议/);
      writeFileSync(opts.lastMessagePath, calls < 3 ? `narration ${JSON.stringify(passed)}` : JSON.stringify({ ...passed, risk })); return ok();
    });
    assert.equal(calls, 3);
    assert.equal(out.result.risk, risk);
    assert.doesNotMatch(out.result.summary, /protocol-recovered/);
  } finally { cleanup(e.dir); }
});

test('all formatting attempts share the original time budget', async () => {
  const e = setup();
  try {
    let calls = 0;
    await assert.rejects(runReview(e.ctx, 'pass', 'diff', { ...e.deps, timeoutMs: 5 }, async opts => {
      calls++;
      writeFileSync(opts.logPath!, 'review started\n');
      await new Promise(resolve => setTimeout(resolve, 15));
      writeFileSync(opts.lastMessagePath, `narration ${JSON.stringify(passed)}`);
      return ok();
    }), (error: unknown) => {
      assert(error instanceof ReviewInfraError);
      assert.match(error.message, /time budget exhausted/);
      assert(error.logPath && existsSync(error.logPath));
      return true;
    });
    assert.equal(calls, 1);
  } finally { cleanup(e.dir); }
});

test('part failure never produces a passing aggregate', async () => {
  const e = setup();
  try {
    let calls = 0;
    await assert.rejects(runReview(e.ctx, 'pass', diff, e.deps, async opts => {
      if (++calls === 1) writeFileSync(opts.lastMessagePath, JSON.stringify(passed));
      return ok();
    }), ReviewInfraError);
  } finally { cleanup(e.dir); }
});
