import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPiArgv, extractLastMessage, PI_REVIEW_TOOLS, piBesideNode, resolvePiInvocation } from '../src/runners/pi.js';

const piName = process.platform === 'win32' ? 'pi.cmd' : 'pi';

const inv = { argv0: 'node', prefix: ['/x/cli.js'] };

test('buildPiArgv: non-interactive, config-isolated, @file prompt', () => {
  const argv = buildPiArgv(
    { tools: PI_REVIEW_TOOLS, promptPath: 'C:/a/prompt.txt', model: 'new-api/deepseek-v4.1-flash' },
    inv,
  );
  const s = argv.join(' ');
  assert.equal(argv[0], 'node');
  assert.equal(argv[1], '/x/cli.js');
  assert.ok(s.includes('-p'));
  assert.ok(s.includes('--mode json'));
  assert.ok(s.includes('--no-session'));
  assert.ok(s.includes('--no-extensions'));
  assert.ok(s.includes('--no-skills'));
  assert.ok(s.includes('--no-context-files'));
  assert.ok(!s.includes('--no-approve')); // pi 1.3.0 removed the flag; --no-context-files covers the trust prompt
  assert.ok(s.includes(' -- ')); // end option parsing before the @prompt include
  assert.ok(s.includes('--tools read,grep,find,ls'));
  assert.ok(s.includes('--model new-api/deepseek-v4.1-flash'));
  assert.equal(argv[argv.length - 1], '@C:/a/prompt.txt');
});

test('buildPiArgv: default tools cover all built-ins', () => {
  const argv = buildPiArgv({ promptPath: 'p' }, inv);
  const i = argv.indexOf('--tools');
  assert.equal(argv[i + 1], 'read,bash,powershell,edit,write,grep,find,ls');
});

test('extractLastMessage: last assistant text blocks win', () => {
  const jsonl = [
    JSON.stringify({ type: 'session', id: 'x' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'first' }] } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'noise' } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't2' }, { type: 'text', text: '{"verdict":"PASS"}' }] } }),
    JSON.stringify({ type: 'agent_end' }),
  ].join('\n');
  assert.equal(extractLastMessage(jsonl), '{"verdict":"PASS"}');
});

test('resolvePiInvocation: explicit pi_path wins over the PATH lookup', () => {
  // A systemd-only PATH is invisible to an interactive shell, so an explicit
  // path must decide regardless of what PATH says.
  const inv = resolvePiInvocation('/definitely/not/on/path', '/opt/node/bin/pi');
  assert.equal(inv.argv0, '/opt/node/bin/pi');
  assert.deepEqual(inv.prefix, []);
});

test('resolvePiInvocation: empty PATH and empty node dir → unresolved marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-empty-'));
  try {
    const inv = resolvePiInvocation('/definitely/not/on/path', undefined, dir);
    assert.equal(inv.argv0, 'pi'); // the marker doctor reports as FAIL
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePiInvocation: falls back to the runtime node directory', () => {
  // A systemd-only PATH is invisible to an interactive shell; the shim sitting
  // beside the runtime node is the "current user's default install" fallback.
  const dir = mkdtempSync(join(tmpdir(), 'pi-node-'));
  try {
    writeFileSync(join(dir, piName), '#!/bin/sh\n');
    const inv = resolvePiInvocation('/definitely/not/on/path', undefined, dir);
    assert.notEqual(inv.argv0, 'pi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePiInvocation: PATH wins over discovery so it stays overridable', () => {
  // Operators wrap pi with scripts and tests inject shims via PATH, so PATH
  // must keep the ability to override the discovered default.
  const nodeDir = mkdtempSync(join(tmpdir(), 'pi-rank-node-'));
  const pathDir = mkdtempSync(join(tmpdir(), 'pi-rank-path-'));
  try {
    writeFileSync(join(nodeDir, piName), '#!/bin/sh\n');
    writeFileSync(join(pathDir, piName), '#!/bin/sh\n');
    const inv = resolvePiInvocation(pathDir, undefined, nodeDir);
    const parts = [inv.argv0, ...inv.prefix];
    assert.ok(parts.some((s) => s.includes(pathDir)), `expected PATH pi, got ${parts.join(' ')}`);
    assert.ok(!parts.some((s) => s.includes(nodeDir)));
  } finally {
    rmSync(nodeDir, { recursive: true, force: true });
    rmSync(pathDir, { recursive: true, force: true });
  }
});

test('piBesideNode: returns null when the directory has no pi', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-beside-'));
  try {
    assert.equal(piBesideNode(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractLastMessage: no assistant text → null', () => {
  const jsonl = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(extractLastMessage(jsonl), null);
});
