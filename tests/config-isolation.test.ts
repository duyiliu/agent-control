import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

function writeCfg(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-cfg-'));
  const file = join(dir, 'cfg.yaml');
  writeFileSync(file, yaml.replace(/DIR/g, dir.replace(/\\/g, '/')), 'utf8');
  return file;
}

function rmCfg(file: string) {
  rmSync(join(file, '..'), { recursive: true, force: true });
}

const BASE = `
server:
  database: DIR/db.sqlite
  worktree_root: DIR/wt
projects:
  - repo: me/a
    local_repo: DIR/a
    checks: []
`;

test('config: isolation defaults to none, container optional', () => {
  const file = writeCfg(`${BASE}
agent:
  model: test/model
`);
  try {
    const cfg = loadConfig(file);
    assert.equal(cfg.agent.isolation, 'none');
    assert.equal(cfg.agent.container, undefined);
    assert.equal(cfg.projects[0]!.isolation, undefined);
  } finally {
    rmCfg(file);
  }
});

test('config: project isolation override + container block parsed', () => {
  const file = writeCfg(`${BASE}
agent:
  model: test/model
  isolation: none
  container:
    image: agent-control-dev:latest
    host: tcp://192.168.1.199:2375
    network: bridge
    extra_args: [--memory, 4g]
`);
  try {
    const cfg = loadConfig(file);
    assert.equal(cfg.agent.container?.image, 'agent-control-dev:latest');
    assert.equal(cfg.agent.container?.host, 'tcp://192.168.1.199:2375');
    assert.deepEqual(cfg.agent.container?.extra_args, ['--memory', '4g']);
    assert.equal(cfg.agent.isolation, 'none');
  } finally {
    rmCfg(file);
  }
});

test('config: project-level isolation: docker parses', () => {
  const file = writeCfg(`${BASE.replace('    checks: []', '    checks: []\n    isolation: docker')}
agent:
  model: test/model
  container:
    image: agent-control-dev:latest
`);
  try {
    const cfg = loadConfig(file);
    assert.equal(cfg.projects[0]!.isolation, 'docker');
    assert.equal(cfg.agent.isolation, 'none');
  } finally {
    rmCfg(file);
  }
});

test('config: global docker without container.image is a ConfigError', () => {
  const file = writeCfg(`${BASE}
agent:
  model: test/model
  isolation: docker
`);
  try {
    assert.throws(() => loadConfig(file), (err: unknown) => err instanceof ConfigError && /container\.image/.test(String(err)));
  } finally {
    rmCfg(file);
  }
});

test('config: per-project docker also requires container.image', () => {
  const file = writeCfg(`${BASE.replace('    checks: []', '    checks: []\n    isolation: docker')}
agent:
  model: test/model
`);
  try {
    assert.throws(() => loadConfig(file), (err: unknown) => err instanceof ConfigError && /container\.image/.test(String(err)));
  } finally {
    rmCfg(file);
  }
});

test('config: invalid isolation mode rejected', () => {
  const file = writeCfg(`${BASE}
agent:
  model: test/model
  isolation: kubernetes
`);
  try {
    assert.throws(() => loadConfig(file), ConfigError);
  } finally {
    rmCfg(file);
  }
});
