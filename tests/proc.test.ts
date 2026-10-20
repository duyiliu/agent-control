import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidAlive, runProc, scrubEnvForAgent, which } from '../src/proc.js';
import { parseWorktreeList } from '../src/workspace/git.js';
import { approvalHash } from '../src/tracker/github.js';
import { parseDependsOn } from '../src/scheduler/engine.js';

test('runProc captures output and exit code', async () => {
  const res = await runProc({
    argv: [process.execPath, '-e', 'console.log("hello-out"); console.error("oops-err")'],
    timeoutMs: 10_000,
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdoutTail, /hello-out/);
  assert.match(res.stderrTail, /oops-err/);
});

test('runProc kills on timeout', async () => {
  const res = await runProc({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 400,
  });
  assert.equal(res.timedOut, true);
  assert.ok(res.durationMs < 15_000, `took ${res.durationMs}ms`);
});

test('runProc abort signal kills child', async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const res = await runProc({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 30_000,
    signal: ctl.signal,
  });
  assert.equal(res.aborted, true);
});

test('runProc: already aborted signal never spawns a process', async () => {
  const ctl = new AbortController(); ctl.abort();
  let spawned = false;
  const res = await runProc({ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1000,
    signal: ctl.signal, onSpawn: () => { spawned = true; } });
  assert.equal(res.aborted, true);
  assert.equal(spawned, false);
});

test('runProc reports spawn failure separately from command exit', async () => {
  const res = await runProc({ argv: ['agent-control-nonexistent-test-executable'], timeoutMs: 1000 });
  assert.ok(res.spawnError);
  assert.notEqual(res.exitCode, 0);
});

test('runProc marks captured output that exceeds the tail limit', async () => {
  const res = await runProc({ argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(100000))'], timeoutMs: 1000 });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdoutTruncated, true);
  assert.ok(res.stdoutTail.length <= 64 * 1024);
});

test('runProc stdinData is piped and stdin closed', async () => {
  const res = await runProc({
    argv: [process.execPath, '-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("got:"+d))'],
    stdinData: 'payload-123',
    timeoutMs: 10_000,
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdoutTail, /got:payload-123/);
});

test('scrubEnvForAgent: allowlist only — ambient secrets never pass', () => {
  const env = {
    PATH: '/x',
    USERPROFILE: '/u/me',
    GH_TOKEN: 't1',
    GITHUB_TOKEN: 't2',
    CUSTOM: 'v',
    SECRET_KEY: 's',
    AWS_SECRET_ACCESS_KEY: 'aws',
  };
  const out = scrubEnvForAgent(env, ['CUSTOM']);
  assert.equal(out.PATH, '/x');
  assert.equal(out.USERPROFILE, '/u/me');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SECRET_KEY', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM']) {
    assert.equal(out[k], undefined, k);
  }
  // Credential jail: on-disk gh/git auth must be dead in the child.
  assert.equal(out.GH_CONFIG_DIR, join(tmpdir(), 'agent-control-gh-jail'));
  assert.equal(out.GIT_CONFIG_COUNT, '1');
  assert.equal(out.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(out.GIT_CONFIG_VALUE_0, '');
  assert.equal(out.GIT_TERMINAL_PROMPT, '0');
  assert.equal(out.GCM_INTERACTIVE, 'never');
  assert.equal(out.GIT_SSH_COMMAND, 'exit 1');
});

test('which finds node on this machine', () => {
  assert.ok(which('node') !== null);
});

test('pidAlive detects own pid and dead pid', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22), false); // implausible pid
});

test('parseWorktreeList parses porcelain output', () => {
  const text = [
    'worktree C:/repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/wt',
    'HEAD def456',
    'branch refs/heads/agent/issue-1',
    '',
  ].join('\n');
  const list = parseWorktreeList(text);
  assert.equal(list.length, 2);
  assert.equal(list[1]!.branch, 'refs/heads/agent/issue-1');
});

test('approvalHash stable across CRLF and changes on edit', () => {
  const base = { title: 'Fix bug', body: 'Steps:\r\n1. do x\r\n2. do y' };
  const lf = { title: 'Fix bug', body: 'Steps:\n1. do x\n2. do y' };
  const edited = { title: 'Fix bug', body: 'Steps:\n1. do x\n2. do z' };
  assert.equal(approvalHash(base), approvalHash(lf));
  assert.notEqual(approvalHash(base), approvalHash(edited));
  const retitled = { title: 'Fix bug!', body: lf.body };
  assert.notEqual(approvalHash(base), approvalHash(retitled));
});

test('parseDependsOn extracts issue refs', () => {
  assert.deepEqual(parseDependsOn('Depends-On: #12\nalso depends-on: #7'), [12, 7]);
  assert.deepEqual(parseDependsOn('依赖：#3'), [3]);
  assert.deepEqual(parseDependsOn('no deps'), []);
});
