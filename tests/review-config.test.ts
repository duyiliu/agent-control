import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReview } from '../src/verify/review.js';
import { resolvePiInvocation } from '../src/runners/pi.js';
import type { PromptContext } from '../src/scheduler/prompts.js';
import { makeConfig, cleanup, tmpDir } from './helpers.js';

const passed = JSON.stringify({ verdict: 'PASS', summary: 'read-only review complete', findings: [] });

test('configured GPT-6 Luna reviewer model reaches the runner with SHA evidence', async () => {
  const dir = tmpDir('ac-luna-review-config-');
  const originalPath = process.env.PATH;
  try {
    const bin = join(dir, 'bin');
    const cliDir = join(bin, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(bin, 'pi.cmd'), '');
    const argvPath = join(dir, 'captured-argv.json');
    writeFileSync(join(cliDir, 'cli.js'), `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(argvPath)},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(passed)}}]}}));`);
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    const invocation = resolvePiInvocation();
    assert.equal(invocation.prefix[0], join(cliDir, 'cli.js'), 'must use the local fake CLI, not a real model runner');

    const config = makeConfig(dir);
    config.agent.review_model = 'new-api-responses/gpt-6-luna';
    config.agent.reasoning_effort = 'high';
    const ctx: PromptContext = {
      project: config.projects[0]!,
      issue: { number: 7, title: 'probe', body: 'AC: pass', labels: [], state: 'OPEN', url: 'u' },
      branch: 'agent/issue-7', workflowPath: join(dir, 'WORKFLOW.md'), worktreePath: dir,
    };
    let optsSeen = false;
    const out = await runReview(ctx, '提交 SHA: verified-sha', 'small diff', {
      agentConfig: config.agent, timeoutMs: 5000, artifactsDir: join(dir, 'artifacts'), headSha: 'verified-sha',
    }, async (opts, runnerConfig) => {
      optsSeen = true;
      assert.equal(runnerConfig.provider, 'pi');
      assert.equal(runnerConfig.model, 'new-api-responses/gpt-6-luna');
      assert.equal(runnerConfig.reasoning_effort, 'high');
      assert.deepEqual(opts.tools, ['read', 'grep', 'find', 'ls']);
      assert.match(opts.prompt, /本轮待审查提交 SHA：verified-sha/);
      const { runPi } = await import('../src/runners/pi.js');
      const result = await runPi(opts, runnerConfig, invocation);
      return { ...result, exitCode: 0 };
    });
    assert.equal(optsSeen, true);
    assert.equal(out.result.verdict, 'PASS');
    const argv = JSON.parse(await (await import('node:fs/promises')).readFile(argvPath, 'utf8')) as string[];
    assert.equal(argv[argv.indexOf('--model') + 1], 'new-api-responses/gpt-6-luna');
    assert.equal(argv[argv.indexOf('--thinking') + 1], 'high');
  } finally {
    process.env.PATH = originalPath;
    cleanup(dir);
  }
});
