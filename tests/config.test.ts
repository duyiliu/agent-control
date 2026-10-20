import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';
import { cleanup, tmpDir } from './helpers.js';

function withConfig(agent: string, run: (path: string) => void) {
  const dir = tmpDir('ac-config-');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    'projects:',
    '  - repo: owner/repo',
    `    local_repo: '${dir.replace(/\\/g, '/')}'`,
    'agent:',
    agent,
  ].join('\n'), 'utf8');
  try { run(path); } finally { cleanup(dir); }
}

test('config: Pi is the only runner and review model override is supported', () => {
  withConfig('  provider: pi\n  model: test/coder\n  review_model: test/reviewer\n  review_reasoning_effort: low', (path) => {
    const config = loadConfig(path);
    assert.equal(config.agent.provider, 'pi');
    assert.equal(config.agent.model, 'test/coder');
    assert.equal(config.agent.review_model, 'test/reviewer');
    assert.equal(config.agent.review_reasoning_effort, 'low');
  });
});

test('config: legacy Codex runner is rejected with migration guidance', () => {
  withConfig('  provider: codex\n  model: gpt-5', (path) => {
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /Codex support has been removed/.test(err.message));
  });
});

test('config: cross-runner review setting is rejected with Pi-only guidance', () => {
  withConfig('  model: test/coder\n  review_provider: codex', (path) => {
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /review_provider is no longer supported/.test(err.message));
  });
});

test('config: legacy sandbox settings are rejected instead of ignored', () => {
  withConfig('  model: test/coder\n  sandbox: danger-full-access', (path) => {
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /legacy sandbox settings are no longer supported/.test(err.message));
  });
});
