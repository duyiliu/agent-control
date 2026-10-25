import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, lines, preview, resultText, Transcript } from '../ui/src/transcript.js';

function transcript(max = 600, trimAt = 1200) {
  return new Transcript(max, trimAt);
}

function feed(t: Transcript, events: Record<string, unknown>[]) {
  for (const ev of events) t.feed(JSON.stringify(ev));
}

const delta = (type: string, value: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type, delta: value },
});

test('live log transcript', async (t) => {
  await t.test('thinking deltas fold into one block and close on thinking_end', () => {
    const tr = transcript();
    feed(tr, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant' } },
      delta('thinking_delta', 'We need'),
      delta('thinking_delta', ' to check.'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } },
      delta('thinking_delta', 'Second block.'),
    ]);
    const thinks = tr.entries.filter((e) => e.kind === 'think');
    assert.equal(thinks.length, 2);
    assert.equal(thinks[0]!.text, 'We need to check.');
    assert.equal(thinks[0]!.done, true);
    assert.equal(thinks[1]!.text, 'Second block.');
    assert.equal(thinks[1]!.done, undefined);
  });

  await t.test('text deltas fold and toolcall deltas are ignored', () => {
    const tr = transcript();
    feed(tr, [
      { type: 'message_start', message: { role: 'assistant' } },
      delta('text_delta', 'Done: '),
      delta('text_delta', 'all tests pass.'),
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"command"' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_end' } },
    ]);
    const says = tr.entries.filter((e) => e.kind === 'say');
    assert.equal(says.length, 1);
    assert.equal(says[0]!.text, 'Done: all tests pass.');
    assert.equal(says[0]!.done, true);
  });

  await t.test('tool output replaces with the accumulated stream and keeps the final result', () => {
    const tr = transcript();
    feed(tr, [
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls -la' } },
      { type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'a\n' }] } },
      { type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'a\nb\n' }] } },
    ]);
    let tool = tr.entries.find((e) => e.kind === 'tool')!;
    assert.match(tool.text, /bash/);
    assert.match(tool.text, /ls -la/);
    assert.equal(tool.output, 'a\nb\n', 'partial output is accumulated by pi, not appended by us');

    feed(tr, [
      {
        type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', durationMs: 42,
        result: { content: [{ type: 'text', text: 'a\nb\nc\n' }] },
      },
    ]);
    tool = tr.entries.find((e) => e.kind === 'tool')!;
    assert.equal(tool.output, 'a\nb\nc\n');
    assert.equal(tool.meta, '42ms');
    assert.equal(tool.failed, false);
    assert.equal(tool.done, true);
  });

  await t.test('a failed tool is marked and a missing start still yields one entry', () => {
    const tr = transcript();
    feed(tr, [
      { type: 'tool_execution_end', toolCallId: 'c9', toolName: 'bash', durationMs: 5, isError: true, result: { content: [] } },
    ]);
    const tools = tr.entries.filter((e) => e.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.failed, true);
    assert.equal(tools[0]!.output, undefined);
  });

  await t.test('message_end is a fallback only when no deltas were seen', () => {
    const tr = transcript();
    feed(tr, [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'attached mid-stream' },
            { type: 'text', text: 'summary line' },
          ],
        },
      },
    ]);
    assert.equal(tr.entries.filter((e) => e.kind === 'think')[0]!.text, 'attached mid-stream');
    assert.equal(tr.entries.filter((e) => e.kind === 'say')[0]!.text, 'summary line');

    const withDeltas = transcript();
    feed(withDeltas, [
      { type: 'message_start', message: { role: 'assistant' } },
      delta('text_delta', 'streamed'),
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'streamed' }] } },
    ]);
    assert.equal(withDeltas.entries.filter((e) => e.kind === 'say').length, 1, 'no duplicate from message_end');
  });

  await t.test('turn markers count up and user messages are ignored', () => {
    const tr = transcript();
    feed(tr, [
      { type: 'message_start', message: { role: 'user' } },
      delta('text_delta', 'not assistant'),
      { type: 'turn_start' },
      { type: 'turn_start' },
      { type: 'agent_settled', aborted: true },
    ]);
    assert.equal(tr.entries.filter((e) => e.kind === 'say').length, 0);
    const marks = tr.entries.filter((e) => e.kind === 'mark').map((e) => e.text);
    assert.deepEqual(marks, ['第 1 轮', '第 2 轮', '本轮结束（已中止）']);
  });

  await t.test('the transcript trims to the newest entries', () => {
    const tr = transcript(2, 3);
    feed(tr, [
      { type: 'turn_start' },
      { type: 'turn_start' },
      { type: 'turn_start' },
      { type: 'turn_start' },
    ]);
    assert.equal(tr.entries.length, 2);
    assert.deepEqual(tr.entries.map((e) => e.text), ['第 3 轮', '第 4 轮']);
  });

  await t.test('malformed records are skipped', () => {
    const tr = transcript();
    tr.feed('not json');
    tr.feed('');
    assert.equal(tr.entries.length, 0);
  });

  await t.test('helpers clip by characters and count lines', () => {
    assert.deepEqual(clip('abcdef', 3), { text: 'abc', cut: true });
    assert.deepEqual(clip('abcdef', 0), { text: 'abcdef', cut: false });
    assert.deepEqual(clip('abc', 10), { text: 'abc', cut: false });
    assert.equal(lines('a\nb\nc'), 3);
    assert.equal(lines(''), 1);
    assert.equal(preview({ a: 1 }), '{"a":1}');
    assert.equal(resultText({ content: [{ type: 'text', text: 'x' }, { type: 'image' }] }), 'x');
    assert.equal(resultText(null), '');
  });
});
