import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeLocalDeletions,
  containerNameFor,
  findContainerStrays,
  listLocalFiles,
  normalizeTarEntry,
  resolveIsolation,
  strayNameFilterFor,
  tarExcludeArgs,
  volumeNamesFor,
  type SessionOpts,
} from '../src/runners/container.js';
import { filterToolsForContainer } from '../src/runners/pi.js';
import { runProc } from '../src/proc.js';
import type { AppConfig, ProjectConfig } from '../src/types.js';

const agentCfg = (over: Partial<AppConfig['agent']> = {}): AppConfig['agent'] => ({
  provider: 'pi',
  model: 'test/model',
  sandbox: 'danger-full-access',
  review_sandbox: 'danger-full-access',
  env_deny: [],
  isolation: 'none',
  ...over,
});

const project = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  repo: 'me/r',
  local_repo: '.',
  base_branch: 'main',
  ready_label: 'agent-ready',
  branch_prefix: 'agent/issue-',
  checks: [],
  ...over,
});

test('resolveIsolation: project override wins over global default', () => {
  assert.equal(resolveIsolation(undefined, agentCfg({ isolation: 'docker' })), 'docker');
  assert.equal(resolveIsolation(project({ isolation: 'none' }), agentCfg({ isolation: 'docker' })), 'none');
  assert.equal(resolveIsolation(project({ isolation: 'docker' }), agentCfg()), 'docker');
  assert.equal(resolveIsolation(project(), agentCfg()), 'none');
});

test('tarExcludeArgs cover .git and dependency dirs', () => {
  const args = tarExcludeArgs();
  for (const dir of ['.git', '.venv', 'node_modules', 'target', '__pycache__']) {
    assert.ok(args.includes(`--exclude=${dir}`));
  }
});

test('normalizeTarEntry: strips ./ prefix, drops dir entries', () => {
  assert.equal(normalizeTarEntry('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeTarEntry('src/a.ts'), 'src/a.ts');
  assert.equal(normalizeTarEntry('./'), null);
  assert.equal(normalizeTarEntry('.'), null);
  assert.equal(normalizeTarEntry('src/'), null);
  assert.equal(normalizeTarEntry(''), null);
});

test('computeLocalDeletions: local-only files must go', () => {
  const remote = new Set(['keep.ts', 'sub/a.ts']);
  const del = computeLocalDeletions(['keep.ts', 'sub/a.ts', 'removed.ts', 'sub/gone.ts'], remote);
  assert.deepEqual(del.sort(), ['removed.ts', 'sub/gone.ts']);
});

test('listLocalFiles: skips excluded components, slash-separated relative paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-list-'));
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'src', 'sub'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'x');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(root, 'README.md'), 'x');
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'src', 'sub', 'b.ts'), 'x');
    assert.deepEqual(listLocalFiles(root).sort(), [
      'README.md',
      'src/a.ts',
      'src/sub/b.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('naming: container/volume/stray-filter derive from runId', () => {
  assert.equal(containerNameFor('r-1', 3), 'ac-run-r-1-3');
  assert.deepEqual(volumeNamesFor('r-1'), { worktree: 'ac-wt-r-1', artifacts: 'ac-ac-r-1' });
  assert.equal(strayNameFilterFor('r-1'), '^ac-run-r-1');
});

test('findContainerStrays: only running containers count; daemon failure -> null', async () => {
  const fakeOk = (o: any) => Promise.resolve({
    exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1,
    stdoutTail: 'ac-run-x-1\tUp 2 minutes\nac-run-x-0\tExited (0) 3 minutes ago\nac-run-x-2\tCreated\n',
    stderrTail: '',
  }) as any;
  const up = await findContainerStrays('x', { exec: fakeOk as typeof runProc });
  assert.deepEqual(up, ['ac-run-x-1']);

  const fakeFail = (o: any) => Promise.resolve({
    exitCode: 1, signal: null, timedOut: false, aborted: false, durationMs: 1,
    stdoutTail: '', stderrTail: 'cannot connect',
  }) as any;
  assert.equal(await findContainerStrays('x', { exec: fakeFail as typeof runProc }), null);
});

test('filterToolsForContainer: default set loses powershell; explicit lists keep everything else', () => {
  assert.equal(filterToolsForContainer().includes('powershell'), false);
  assert.equal(filterToolsForContainer().includes('bash'), true);
  assert.deepEqual(filterToolsForContainer(['read', 'grep', 'find', 'ls']), ['read', 'grep', 'find', 'ls']);
});

test('ContainerSession.open requires container.image in agent config', async () => {
  const opts: SessionOpts = {
    runId: 'r-img',
    worktreePath: '.',
    artifactsDir: '.',
    agent: agentCfg({ isolation: 'docker', container: undefined }),
  };
  await assert.rejects(() => import('../src/runners/container.js').then((m) => m.ContainerSession.open(opts)), /image/);
});
