import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCheckPlan } from '../src/verify/discovery.js';
import { runChecks } from '../src/verify/checks.js';
import { cleanup, tmpDir } from './helpers.js';

test('explicit checks override automatic discovery even for invalid package JSON', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), 'bad');
    const checks = [{ argv: ['node', '--test'], platforms: ['linux' as const] }];
    assert.deepEqual(resolveCheckPlan(checks, dir), { checks, source: 'configured' });
  } finally { cleanup(dir); }
});

test('configured checks bootstrap in a fresh materialization when a spec is provided', () => {
  const dir = tmpDir();
  try {
    const checks = [{ argv: ['npm', 'run', 'check'] }];
    const spec = { argv: ['npm', 'ci'], timeout_seconds: 600 };
    assert.deepEqual(resolveCheckPlan(checks, dir, spec), { checks, source: 'configured' });
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    assert.deepEqual(resolveCheckPlan(checks, dir, spec), { checks: [spec, ...checks], source: 'configured', bootstrap: true });
    mkdirSync(join(dir, 'node_modules'));
    assert.deepEqual(resolveCheckPlan(checks, dir, spec), { checks, source: 'configured' });
  } finally { cleanup(dir); }
});

test('automatic checks use fixed script names and bootstrap only a fresh locked npm workspace', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'test runner', typecheck: 'tsc', compile: 'bundle', build: 'release', deploy: 'publish' } }));
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    assert.deepEqual(resolveCheckPlan([], dir).checks.map(c => c.argv), [['npm', 'ci'], ['npm', 'run', 'test'], ['npm', 'run', 'typecheck'], ['npm', 'run', 'compile']]);
    mkdirSync(join(dir, 'node_modules'));
    assert.equal(resolveCheckPlan([], dir).bootstrap, false);
    assert.deepEqual(resolveCheckPlan([], dir).checks.map(c => c.argv.at(-1)), ['test', 'typecheck', 'compile']);
  } finally { cleanup(dir); }
});

test('combined check script avoids duplicate test/build runs and arbitrary scripts are ignored', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'build and test', test: 'tests', build: 'build', publish: 'release' } }));
    assert.deepEqual(resolveCheckPlan([], dir).checks.map(c => c.argv), [['npm', 'run', 'check']]);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { deploy: 'release', postinstall: 'setup' } }));
    assert.deepEqual(resolveCheckPlan([], dir), { checks: [], source: 'none' });
    writeFileSync(join(dir, 'package.json'), 'invalid-secret-content');
    const plan = resolveCheckPlan([], dir);
    assert.ok(plan.error);
    assert.doesNotMatch(plan.error!, /invalid-secret-content/);
  } finally { cleanup(dir); }
});

test('a repository without test configuration is not a failed check', () => {
  const dir = tmpDir();
  try { assert.deepEqual(resolveCheckPlan([], dir), { checks: [], source: 'none' }); }
  finally { cleanup(dir); }
});

test('host executes discovered npm scripts and records real success and failure logs', async () => {
  const dir = tmpDir('ac-discovery-run-');
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'test executed\')"', typecheck: 'node -e "console.error(\'check failed\'); process.exit(1)"' } }));
    const plan = resolveCheckPlan([], dir);
    const result = await runChecks(plan.checks, dir, i => join(dir, `check-${i}.log`));
    assert.equal(result.ok, false);
    assert.equal(result.outcomes.length, 2);
    assert.match(result.outcomes[0]!.tail, /test executed/);
    assert.equal(result.outcomes[0]!.exitCode, 0);
    assert.equal(result.outcomes[1]!.exitCode, 1);
    assert.match(result.failureEvidence, /check failed/);
  } finally { cleanup(dir); }
});
