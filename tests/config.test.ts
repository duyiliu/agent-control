import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig, validateProject } from '../src/config.js';
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

function withCheck(checkLines: string[], run: (path: string) => void) {
  const dir = tmpDir('ac-config-');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    'projects:',
    '  - repo: owner/repo',
    `    local_repo: '${dir.replace(/\\/g, '/')}'`,
    '    checks:',
    ...checkLines,
    'agent:',
    '  model: test/coder',
  ].join('\n'), 'utf8');
  try { run(path); } finally { cleanup(dir); }
}

function withServer(serverLines: string[], run: (path: string) => void) {
  const dir = tmpDir('ac-config-');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    ...serverLines,
    'projects:',
    '  - repo: owner/repo',
    `    local_repo: '${dir.replace(/\\/g, '/')}'`,
    'agent:',
    '  model: test/coder',
  ].join('\n'), 'utf8');
  try { run(path); } finally { cleanup(dir); }
}

test('config: max_resumes defaults to 2', () => {
  withServer([], (path) => {
    assert.equal(loadConfig(path).server.max_resumes, 2);
  });
});

for (const value of [0, 3]) {
  test(`config: max_resumes=${value} is a valid non-negative integer`, () => {
    withServer([`  max_resumes: ${value}`], (path) => {
      assert.equal(loadConfig(path).server.max_resumes, value);
    });
  });
}

for (const [label, value] of [['negative', -1], ['fractional', 2.5], ['string', "'2'"], ['NaN', '.nan']] as const) {
  test(`config: max_resumes rejects ${label} values`, () => {
    withServer([`  max_resumes: ${value}`], (path) => {
      assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /server\.max_resumes must be a non-negative integer/.test(err.message));
    });
  });
}

test('config: an empty projects list is allowed — scheduler idles until the UI adds one', () => {
  const dir = tmpDir('ac-config-');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    'projects: []',
    'agent:',
    '  model: test/coder',
  ].join('\n'), 'utf8');
  try {
    assert.equal(loadConfig(path).projects.length, 0);
  } finally { cleanup(dir); }
});

test('config: issue triage defaults off with a bounded model-call timeout', () => {
  withConfig('  model: test/coder', path => {
    assert.deepEqual(loadConfig(path).projects[0]!.issue_triage, { enabled: false, timeout_seconds: 180 });
  });
});

test('config: enabled triage on a non-loopback UI host requires a token', () => {
  const dir = tmpDir('ac-config-triage-');
  const path = join(dir, 'config.yaml');
  const write = (token = '') => writeFileSync(path, [
    'server:',
    `  database: '${join(dir, 'agent.db').replace(/\\/g, '/')}'`,
    `  worktree_root: '${join(dir, 'worktrees').replace(/\\/g, '/')}'`,
    '  ui:',
    '    host: 0.0.0.0',
    ...(token ? [`    token: ${token}`] : []),
    'projects:',
    '  - repo: owner/repo',
    `    local_repo: '${dir.replace(/\\/g, '/')}'`,
    '    issue_triage:',
    '      enabled: true',
    'agent:',
    '  model: test/coder',
  ].join('\n'), 'utf8');
  try {
    write();
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /server\.ui\.token is required/.test(err.message));
    write("'test-token'");
    assert.equal(loadConfig(path).server.ui.token, 'test-token');
  } finally { cleanup(dir); }
});

test('config: check platforms are parsed and passed through', () => {
  withCheck(['      - argv: [node, --test]', '        platforms: [win32, linux]'], (path) => {
    const config = loadConfig(path);
    assert.deepEqual(config.projects[0]!.checks[0]!.platforms, ['win32', 'linux']);
  });
});

test('config: an unknown check platform is rejected', () => {
  withCheck(['      - argv: [node, --test]', '        platforms: [windows]'], (path) => {
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /unknown platform windows/.test(err.message));
  });
});

test('config: an empty platforms list is rejected', () => {
  withCheck(['      - argv: [node, --test]', '        platforms: []'], (path) => {
    assert.throws(() => loadConfig(path), (err) => err instanceof ConfigError && /platforms must be a non-empty array/.test(err.message));
  });
});

test('config: explicit issue intake overrides the deprecated triage switch', async () => {
  const { acceptsAllIssues } = await import('../src/triage/intake.js');
  const raw = { repo: 'o/r', local_repo: '.', issue_triage: { enabled: true }, issue_intake: 'labeled' };
  assert.equal(acceptsAllIssues(validateProject(raw)), false);
  assert.equal(acceptsAllIssues(validateProject({ ...raw, issue_intake: 'all' })), true);
  assert.throws(() => validateProject({ ...raw, issue_intake: 'random' }), /issue_intake/);
  assert.equal(acceptsAllIssues(validateProject({ repo: 'o/r', local_repo: '.' })), false);
  assert.equal(acceptsAllIssues(validateProject({ repo: 'o/r', local_repo: '.', issue_triage: { enabled: true } })), true);
});
