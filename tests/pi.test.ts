import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiArgv, extractLastMessage, PI_REVIEW_TOOLS } from '../src/runners/pi.js';

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
  assert.ok(s.includes('--no-approve')); // 1.3: ignore project-local files, never prompt
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

test('extractLastMessage: no assistant text → null', () => {
  const jsonl = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(extractLastMessage(jsonl), null);
});
