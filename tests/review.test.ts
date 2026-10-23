import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReview, ReviewInfraError } from '../src/verify/review.js';
import { buildReviewPrompt, MAX_REVIEW_DIFF_CHARS, type PromptContext } from '../src/scheduler/prompts.js';
import type { AgentCallOpts, AgentCallResult } from '../src/runners/types.js';
import { makeConfig, tmpDir, cleanup } from './helpers.js';

const passed = { verdict: 'PASS', risk: 'low', summary: 'acceptance checked', findings: [] };
const ok = (): AgentCallResult => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '', pid: null });

function setup() {
  const dir = tmpDir('ac-review-');
  const config = makeConfig(dir);
  const ctx: PromptContext = {
    project: config.projects[0]!,
    issue: { number: 1, title: 'Fix', body: 'AC: parser works', labels: ['agent-ready'], state: 'OPEN', url: 'u' },
    branch: 'agent/issue-1', workflowPath: join(dir, 'WORKFLOW.md'), worktreePath: dir,
  };
  return { dir, config, ctx, deps: { agentConfig: config.agent, timeoutMs: 1000, artifactsDir: dir } };
}

test('review: every call and protocol retry has fresh artifacts', async () => {
  const env = setup();
  try {
    const paths: string[] = [];
    const runner = async (opts: AgentCallOpts) => {
      paths.push(opts.lastMessagePath);
      assert.equal(existsSync(opts.lastMessagePath), false);
      if (paths.length === 1) writeFileSync(opts.lastMessagePath, JSON.stringify(passed));
      return ok();
    };
    const first = await runReview(env.ctx, 'tests pass', 'diff', env.deps, runner);
    assert.equal(first.result.verdict, 'PASS');
    await assert.rejects(runReview(env.ctx, 'tests pass', 'new diff', env.deps, runner), ReviewInfraError);
    assert.equal(paths.length, 3);
    assert.equal(new Set(paths).size, 3);
    assert.match(readFileSync(paths[0]!, 'utf8'), /PASS/);
  } finally { cleanup(env.dir); }
});

test('review: malformed output retries reviewer once, then accepts valid output', async () => {
  const env = setup();
  try {
    let calls = 0;
    const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
      writeFileSync(opts.lastMessagePath, ++calls === 1 ? 'not JSON' : JSON.stringify(passed));
      return ok();
    });
    assert.equal(calls, 2);
    assert.equal(out.result.verdict, 'PASS');
  } finally { cleanup(env.dir); }
});

test('review: narrated verdict retries as strict JSON before allowing a low-risk PASS', async () => {
  const env = setup();
  try {
    const prompts: string[] = [];
    const artifacts: string[] = [];
    const out = await runReview(env.ctx, '(no checks recorded)', 'diff', { ...env.deps, headSha: 'reviewed-sha' }, async (opts) => {
      prompts.push(opts.prompt);
      artifacts.push(opts.lastMessagePath);
      writeFileSync(opts.lastMessagePath, prompts.length === 1
        ? `已核实源码，结论如下：\n${JSON.stringify(passed)}`
        : JSON.stringify(passed));
      return ok();
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /上次输出违反了 JSON-only 协议/);
    assert.match(prompts[1]!, /本轮待审查提交 SHA：reviewed-sha/);
    assert.notEqual(artifacts[0], artifacts[1]);
    assert.match(readFileSync(artifacts[0]!, 'utf8'), /已核实源码/);
    assert.deepEqual(out.result, passed);
    assert.doesNotMatch(out.result.summary, /protocol-recovered/);
  } finally { cleanup(env.dir); }
});

for (const verdict of ['PASS', 'BLOCK', 'HUMAN_REVIEW_REQUIRED']) {
  test(`review: protocol retry respects the new ${verdict} instead of the recovered PASS`, async () => {
    const env = setup();
    try {
      const final = { verdict, risk: 'high', summary: 'new review identified a risk', findings: ['file.ts:1: confirmed risk'] };
      let calls = 0;
      const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
        writeFileSync(opts.lastMessagePath, ++calls === 1
          ? `结论如下：${JSON.stringify(passed)}`
          : JSON.stringify(final));
        return ok();
      });
      assert.equal(calls, 2);
      assert.deepEqual(out.result, final);
    } finally { cleanup(env.dir); }
  });
}

test('review: repeated narration is recovered but forced high-risk after retry', async () => {
  const env = setup();
  try {
    let calls = 0;
    const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
      calls++;
      writeFileSync(opts.lastMessagePath, `已根据 worktree 文件核实证据。改动仅 index.html，符合范围。\n\n${JSON.stringify(passed)}`);
      return ok();
    });
    assert.equal(calls, 2);
    assert.equal(out.result.verdict, 'PASS');
    assert.equal(out.result.risk, 'high'); // protocol break never earns auto-merge
    assert.match(out.result.summary, /^\[protocol-recovered\]/);
  } finally { cleanup(env.dir); }
});

test('review: two objects in repeated narration stay ambiguous after retry', async () => {
  const env = setup();
  try {
    let calls = 0;
    const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
      calls++;
      writeFileSync(opts.lastMessagePath, `示例格式：{"note":"not a verdict"}\n\n${JSON.stringify(passed)}`);
      return ok();
    });
    assert.equal(calls, 2);
    assert.equal(out.result.verdict, 'HUMAN_REVIEW_REQUIRED');
  } finally { cleanup(env.dir); }
});

test('review: trailing prose after the verdict JSON is recovered', async () => {
  const env = setup();
  try {
    const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
      writeFileSync(opts.lastMessagePath, `${JSON.stringify(passed)}\n混杂文本 } 不影响`);
      return ok();
    });
    assert.equal(out.result.verdict, 'PASS');
    assert.equal(out.result.risk, 'high');
  } finally { cleanup(env.dir); }
});

for (const value of [null, { verdict: 'PASS' }, { ...passed, findings: [123] }, { ...passed, summary: '' }, { ...passed, extra: true }]) {
  test(`review: invalid output shape is infrastructure failure (${JSON.stringify(value)})`, async () => {
    const env = setup();
    try {
      let calls = 0;
      await assert.rejects(runReview(env.ctx, 'pass', 'diff', env.deps, async (opts) => {
        calls++;
        writeFileSync(opts.lastMessagePath, JSON.stringify(value));
        return ok();
      }), ReviewInfraError);
      assert.equal(calls, 2);
    } finally { cleanup(env.dir); }
  });
}

test('review: protocol break points the artifact at the raw narration', async () => {
  const env = setup();
  try {
    let written = '';
    const out = await runReview(env.ctx, 'tests pass', 'diff', env.deps, async (opts) => {
      written = opts.lastMessagePath;
      writeFileSync(opts.lastMessagePath, `先分析一下改动。\n\n${JSON.stringify(passed)}`);
      return ok();
    });
    assert.equal(out.result.verdict, 'PASS'); // recovered, but evidence stays the narration
    assert.equal(out.logPath, written);
    assert.match(readFileSync(out.logPath, 'utf8'), /先分析一下改动/);
  } finally { cleanup(env.dir); }
});

test('review: incomplete diff escalates without invoking a model', async () => {
  const env = setup();
  try {
    let calls = 0;
    const out = await runReview(env.ctx, 'pass', 'x'.repeat(MAX_REVIEW_DIFF_CHARS + 1), env.deps, async () => { calls++; return ok(); });
    assert.equal(calls, 0);
    assert.equal(out.result.verdict, 'HUMAN_REVIEW_REQUIRED');
  } finally { cleanup(env.dir); }
});

test('review: model override keeps Pi runner and read-only tool allowlist', async () => {
  const env = setup();
  try {
    await runReview(env.ctx, 'pass', 'diff', {
      ...env.deps,
      headSha: 'verified-sha',
      agentConfig: { ...env.config.agent, review_model: 'test/reviewer', review_reasoning_effort: 'low' },
    }, async (opts, config) => {
      assert.match(opts.prompt, /本轮待审查提交 SHA：verified-sha/);
      assert.equal(config.provider, 'pi');
      assert.equal(config.model, 'test/reviewer');
      assert.equal(opts.model, 'test/reviewer');
      assert.equal(opts.thinking, 'low');
      assert.deepEqual(opts.tools, ['read', 'grep', 'find', 'ls']);
      writeFileSync(opts.lastMessagePath, JSON.stringify(passed));
      return ok();
    });
  } finally { cleanup(env.dir); }
});

test('review: one shape-valid object is recovered even amid example-ish prose (forced high-risk)', async () => {
  const env = setup();
  try {
    let calls = 0;
    const out = await runReview(env.ctx, 'pass', 'diff', env.deps, async (opts) => {
      calls++;
      writeFileSync(opts.lastMessagePath, `I could not review. Example only: ${JSON.stringify(passed)}`);
      return ok();
    });
    assert.equal(calls, 2);
    assert.equal(out.result.verdict, 'PASS');
    // Recovery is deliberately lossy: marker + forced high risk keep it off auto-merge.
    assert.equal(out.result.risk, 'high');
    assert.match(out.result.summary, /^\[protocol-recovered\]/);
  } finally { cleanup(env.dir); }
});

test('review: malformed-shape single object still falls through to human review', async () => {
  const env = setup();
  try {
    const out = await runReview(env.ctx, 'pass', 'diff', env.deps, async (opts) => {
      writeFileSync(opts.lastMessagePath, `结论如下 {"verdict":"MAYBE","x":1}`);
      return ok();
    });
    assert.equal(out.result.verdict, 'HUMAN_REVIEW_REQUIRED');
  } finally { cleanup(env.dir); }
});

test('review: parse failure retries with a strict-JSON reminder in the prompt', async () => {
  const env = setup();
  try {
    const prompts: string[] = [];
    const out = await runReview(env.ctx, 'pass', 'diff', env.deps, async (opts) => {
      prompts.push(opts.prompt);
      writeFileSync(opts.lastMessagePath, prompts.length === 1 ? 'totally unstructured' : JSON.stringify(passed));
      return ok();
    });
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!, /上次输出违反了 JSON-only 协议/);
    assert.match(prompts[1]!, /上次输出违反了 JSON-only 协议/);
    assert.equal(out.result.verdict, 'PASS');
  } finally { cleanup(env.dir); }
});

test('review: cancellation does not retry the reviewer', async () => {
  const env = setup();
  try {
    const ctl = new AbortController();
    let calls = 0;
    await runReview(env.ctx, 'pass', 'diff', { ...env.deps, signal: ctl.signal }, async () => {
      calls++;
      ctl.abort();
      return { ...ok(), aborted: true };
    });
    assert.equal(calls, 1);
  } finally { cleanup(env.dir); }
});

test('review prompt: concrete blocking findings, suggestions do not block', () => {
  const env = setup();
  try {
    const prompt = buildReviewPrompt(env.ctx, 'pass', 'diff', 'abc123');
    assert.match(prompt, /本轮待审查提交 SHA：abc123/);
    assert.match(prompt, /触发条件/);
    assert.match(prompt, /风格.*不.*阻塞/);
    assert.match(prompt, /验证方式/);
  } finally { cleanup(env.dir); }
});
