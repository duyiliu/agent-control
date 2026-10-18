import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiArgv, extractLastMessage, PI_REVIEW_TOOLS } from '../src/runners/pi.js';
import { buildClaudeArgv, extractResult, CLAUDE_REVIEW_TOOLS } from '../src/runners/claude.js';

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
  assert.ok(s.includes('--no-approve'));
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

test('extractLastMessage: no assistant text → null', () => {
  const jsonl = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(extractLastMessage(jsonl), null);
});

const claudeInv = { argv0: 'C:/bin/claude.exe', prefix: [] };

test('buildClaudeArgv: stream-json, mcp-off, read-only tools, schema', () => {
  const argv = buildClaudeArgv(
    { tools: CLAUDE_REVIEW_TOOLS, model: 'deepseek-v4.1-flash', settingsPath: 'C:/s/settings.json', schemaJson: '{"type":"object"}' },
    claudeInv,
  );
  const s = argv.join(' ');
  assert.equal(argv[0], 'C:/bin/claude.exe');
  assert.ok(s.includes('-p'));
  assert.ok(s.includes('--output-format stream-json'));
  assert.ok(s.includes('--strict-mcp-config'));
  assert.ok(s.includes('--dangerously-skip-permissions'));
  assert.ok(s.includes('--tools Read,Grep,Glob,LS'));
  assert.ok(s.includes('--model deepseek-v4.1-flash'));
  assert.ok(s.includes('--settings C:/s/settings.json'));
  assert.ok(s.includes('--json-schema'));
  assert.equal(argv[argv.length - 1], '--');
});

test('extractResult: structured_output wins over result text', () => {
  const log = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: '{"verdict":"PASS"}', structured_output: { verdict: 'PASS' } }),
  ].join('\n');
  assert.equal(extractResult(log), '{"verdict":"PASS"}');
});

test('extractResult: plain result text; nothing → null', () => {
  assert.equal(extractResult(JSON.stringify({ type: 'result', result: 'hello' })), 'hello');
  assert.equal(extractResult('{"type":"system"}'), null);
});
