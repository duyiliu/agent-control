import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startUiServer } from '../src/ui/server.js';
import { loadConfig } from '../src/config.js';
import { makeConfig, makeFakeTracker, makeStore, nullLog, teardown, tmpDir } from './helpers.js';

function writeSeedConfig(dir: string): string {
  const path = join(dir, 'agent-control.yaml');
  writeFileSync(
    path,
    `# seed config — 注释必须保留
server:
  database: ${dir}/ac.db
  worktree_root: ${dir}/worktrees
  logs_dir: ${dir}/logs
projects:
  # 既有项目
  - repo: me/sandbox
    local_repo: ${dir}/repo
    base_branch: main
agent:
  model: test/model
`,
  );
  return path;
}

function gitRepo(dir: string, origin?: string): string {
  const repo = join(dir, 'clone');
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (origin) {
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo, stdio: 'ignore' });
  }
  return repo;
}

async function post(url: string, body: unknown) {
  const r = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('projects api', async (t) => {
  const dir = tmpDir();
  const configPath = writeSeedConfig(dir);
  const config = loadConfig(configPath);
  const store = makeStore(dir);
  const tracker = makeFakeTracker();
  const checked: string[] = [];
  const provisioned: string[] = [];

  const ui = await startUiServer({
    deps: {
      store, config, tracker, activeCount: () => 0,
      configPath,
      checkRepoExists: async (repo) => { checked.push(repo); },
      resolveRepo: async (repo) => (repo === 'old-org/repo' ? 'me/renamed' : repo),
      provisionRepo: async (repo) => { provisioned.push(repo); return []; },
    },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => {
    ui.close();
    teardown(dir, [store]);
  });

  await t.test('GET /api/projects lists configured projects', async () => {
    const r = await fetch(`${ui.url}/api/projects`);
    assert.equal(r.status, 200);
    const d = (await r.json()) as { projects: { repo: string }[]; editable: boolean; config_path: string };
    assert.equal(d.editable, true);
    assert.equal(d.config_path, configPath);
    assert.deepEqual(d.projects.map((p) => p.repo), ['me/sandbox']);
  });

  await t.test('POST rejects malformed repo and missing paths', async () => {
    let r = await post(ui.url, { repo: 'not-a-repo', local_repo: dir });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /owner\/name/);

    r = await post(ui.url, { repo: 'me/new', local_repo: join(dir, 'nope') });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /不存在/);
  });

  await t.test('POST rejects a duplicate repo (case-insensitive)', async () => {
    const r = await post(ui.url, { repo: 'ME/Sandbox', local_repo: gitRepo(dir) });
    assert.equal(r.status, 409);
  });

  await t.test('POST rejects when origin points at a different repo', async () => {
    const other = join(dir, 'other');
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['init'], { cwd: other, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/other/repo.git'], { cwd: other, stdio: 'ignore' });
    const r = await post(ui.url, { repo: 'me/new', local_repo: other });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /origin 指向 other\/repo/);
  });

  await t.test('POST appends to yaml preserving comments and hot-loads it', async () => {
    const local = gitRepo(join(dir, 'with-origin'), 'https://github.com/me/new.git');
    const r = await post(ui.url, {
      repo: 'me/new',
      local_repo: local,
      review_mode: 'manual',
      checks: [{ argv: ['node', '--test'], timeout_seconds: 300 }],
    });
    assert.equal(r.status, 200);
    assert.match(String(r.body.message), /已添加 me\/new/);
    assert.deepEqual(checked, ['me/new']);
    assert.deepEqual(provisioned, ['me/new']);

    // In-memory config updated in place — same array the engine iterates.
    assert.deepEqual(config.projects.map((p) => p.repo), ['me/sandbox', 'me/new']);
    assert.equal(config.projects[1]!.review_mode, 'manual');

    const text = readFileSync(configPath, 'utf8');
    assert.match(text, /seed config — 注释必须保留/);
    assert.match(text, /既有项目/);
    assert.match(text, /- repo: me\/new/);
    assert.match(text, /argv: \[ ?node, --test ?\]/);
    // The file stays loadable.
    assert.equal(loadConfig(configPath).projects.length, 2);
  });

  await t.test('POST without remote check still validates and warns', async () => {
    const bare = gitRepo(join(dir, 'no-origin'));
    const r = await post(ui.url, { repo: 'me/third', local_repo: bare });
    assert.equal(r.status, 200);
    const warnings = r.body.warnings as string[];
    assert.ok(warnings.some((w) => /origin/.test(w)));
  });

  await t.test('POST honours git_remote and resolves a renamed remote URL', async () => {
    const clone = join(dir, 'lan-clone');
    mkdirSync(clone, { recursive: true });
    execFileSync('git', ['init'], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'http://192.168.1.1/lan/repo.git'], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'github', 'https://github.com/old-org/repo.git'], { cwd: clone, stdio: 'ignore' });
    const r = await post(ui.url, { repo: 'me/renamed', local_repo: clone, git_remote: 'github' });
    assert.equal(r.status, 200);
    assert.ok((r.body.warnings as string[]).some((w) => /重定向/.test(w)));
    assert.match(readFileSync(configPath, 'utf8'), /git_remote: github/);
    assert.equal(config.projects.find((p) => p.repo === 'me/renamed')!.git_remote, 'github');
  });

  await t.test('POST rejects a configured remote that does not exist', async () => {
    const local = gitRepo(join(dir, 'has-origin'), 'https://github.com/me/nope.git');
    const r = await post(ui.url, { repo: 'me/nope', local_repo: local, git_remote: 'github' });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /没有 github remote/);
  });
});

test('projects api appends in block style to an empty `projects: []`', async (t) => {
  const dir = tmpDir();
  const configPath = join(dir, 'agent-control.yaml');
  writeFileSync(
    configPath,
    `server:
  database: ${dir}/ac.db
  worktree_root: ${dir}/worktrees
  logs_dir: ${dir}/logs
projects: []
agent:
  model: test/model
`,
  );
  const config = loadConfig(configPath);
  const store = makeStore(dir);
  const ui = await startUiServer({
    deps: {
      store, config, tracker: makeFakeTracker(), activeCount: () => 0,
      configPath,
      checkRepoExists: async () => {},
    },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => {
    ui.close();
    teardown(dir, [store]);
  });

  const r = await post(ui.url, { repo: 'me/first', local_repo: gitRepo(dir) });
  assert.equal(r.status, 200);
  const text = readFileSync(configPath, 'utf8');
  assert.match(text, /projects:\n {2}- repo: me\/first\n {4}local_repo:/);
  assert.doesNotMatch(text, /projects:\s*\[/);
});

test('projects api without configPath is read-only', async (t) => {
  const dir = tmpDir();
  const config = makeConfig(dir);
  const store = makeStore(dir);
  const ui = await startUiServer({
    deps: { store, config, tracker: makeFakeTracker(), activeCount: () => 0 },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => {
    ui.close();
    teardown(dir, [store]);
  });

  const g = await fetch(`${ui.url}/api/projects`);
  assert.equal((await g.json() as { editable: boolean }).editable, false);
  const r = await post(ui.url, { repo: 'me/x', local_repo: dir });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /配置文件路径未知/);
});

test('projects api remote validation failure blocks the write', async (t) => {
  const dir = tmpDir();
  const configPath = writeSeedConfig(dir);
  const config = loadConfig(configPath);
  const store = makeStore(dir);
  const before = readFileSync(configPath, 'utf8');

  const ui = await startUiServer({
    deps: {
      store, config, tracker: makeFakeTracker(), activeCount: () => 0,
      configPath,
      checkRepoExists: async () => { throw new Error('repo not found'); },
    },
    host: '127.0.0.1', port: 0, appLog: nullLog,
  });
  t.after(() => {
    ui.close();
    teardown(dir, [store]);
  });

  const r = await post(ui.url, { repo: 'me/ghost', local_repo: gitRepo(dir) });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /repo not found/);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(config.projects.length, 1);
  assert.ok(existsSync(configPath));
});
