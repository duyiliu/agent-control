import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../src/verify/checks.js';
import type { ProcResult } from '../src/proc.js';
import { tmpDir, cleanup } from './helpers.js';
import { join } from 'node:path';

const ok = (): ProcResult => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, stdoutTail: '', stderrTail: '' });

for (const failure of [
  { spawnError: 'ENOENT', exitCode: -4058 },
  { timedOut: true, exitCode: 1 },
  { signal: 'SIGTERM', exitCode: null },
]) {
  test(`checks: process failure is not a code verdict (${JSON.stringify(failure)})`, async () => {
    const summary = await runChecks([{ argv: ['node', '-v'] }], '.', () => 'log', async () => ({ ...ok(), ...failure }));
    assert.equal(summary.ok, false);
    assert.ok(summary.infraError);
  });
}

test('checks: ordinary nonzero exit remains fixable', async () => {
  const summary = await runChecks([{ argv: ['node', '-v'] }], '.', () => 'log', async () => ({ ...ok(), exitCode: 1, stderrTail: 'assertion failed' }));
  assert.equal(summary.ok, false);
  assert.equal(summary.infraError, undefined);
  assert.match(summary.failureEvidence, /assertion failed/);
});

test('checks: cancellation propagates and prevents subsequent commands', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const summary = await runChecks([{ argv: ['node'] }, { argv: ['node'] }], '.', () => 'log', async (opts) => {
    calls++;
    assert.equal(opts.signal, ctl.signal);
    ctl.abort();
    return { ...ok(), aborted: true };
  }, ctl.signal);
  assert.equal(calls, 1);
  assert.equal(summary.aborted, true);
  assert.equal(summary.ok, false);
});

test('checks: a check that cannot run on this host is skipped, not failed', async () => {
  const other: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32';
  let calls = 0;
  const summary = await runChecks(
    [{ argv: ['node', '-v'], platforms: [other] }],
    '.', () => 'log',
    async () => { calls++; return ok(); },
  );
  assert.equal(calls, 0);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.outcomes, []);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0]!.command, 'node -v');
  assert.match(summary.skipped[0]!.reason, new RegExp(other));
});

test('checks: a supported check still runs beside a skipped one', async () => {
  const other: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32';
  const seen: number[] = [];
  const summary = await runChecks(
    [
      { argv: ['node', '-v'], platforms: [other] },
      { argv: ['node', '-v'], platforms: [process.platform] },
    ],
    '.', (i) => { seen.push(i); return `log-${i}`; },
    async () => ok(),
  );
  assert.equal(summary.outcomes.length, 1);
  assert.equal(summary.skipped.length, 1);
  // The surviving check keeps its original index so log names stay stable.
  assert.deepEqual(seen, [1]);
  assert.equal(summary.outcomes[0]!.logPath, 'log-1');
});

test('checks: trusted npm launcher runs without inheriting host credentials', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpDir('ac-check-npm-');
  try {
    const summary = await runChecks([{ argv: ['npm', '--version'], timeout_seconds: 15 }], dir, () => join(dir, 'npm.log'));
    assert.equal(summary.ok, true, summary.failureEvidence);
    assert.match(summary.outcomes[0]!.tail, /\d+\.\d+\.\d+/);
  } finally { cleanup(dir); }
});

test('checks: all subprocesses keep credential jail and report their PID', async () => {
  let pid: number | null = null;
  await runChecks([{ argv: ['node'] }], '.', () => 'log', async (opts) => {
    assert.equal(opts.env?.GH_TOKEN, undefined);
    assert.equal(opts.env?.GITHUB_TOKEN, undefined);
    assert.equal(opts.env?.GIT_CONFIG_VALUE_0, '');
    assert.ok(opts.env?.GH_CONFIG_DIR);
    opts.onSpawn?.(123);
    return ok();
  }, undefined, (value) => { pid = value; });
  assert.equal(pid, 123);
});
