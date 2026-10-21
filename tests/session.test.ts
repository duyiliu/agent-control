import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiCoderSession, splitRpcLines } from '../src/runners/session.js';
import { makeConfig } from './helpers.js';

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FAKE_PI = `
import { writeFileSync } from 'node:fs';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ type: 'agent_start' });
process.stdin.on('end', () => {
  try { writeFileSync('close-marker.txt', 'eof'); } catch {}
  process.exit(0);
});
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'prompt') {
      if (cmd.message.includes('HANDLED')) {
        send({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
        continue;
      }
      send({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      if (cmd.message.includes('HANG')) continue;
      if (cmd.message.includes('DIE')) { process.exit(3); }
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + cmd.message }] } });
      send({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
    } else if (cmd.type === 'abort') {
      send({ id: cmd.id, type: 'response', command: 'abort', success: true });
      send({ type: 'agent_settled', aborted: true });
    }
  }
});
`;

function fakePiEnv(prefix = 'ac-session-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const fake = join(dir, 'fake-pi.mjs');
  writeFileSync(fake, FAKE_PI, 'utf8');
  const config = makeConfig(dir);
  return { dir, fake, agentConfig: config.agent };
}

test('splitRpcLines: LF only, CR stripped, U+2028 kept inside the record', () => {
  const { lines, rest } = splitRpcLines('{"a":1}\r\n{"b":"x\u2028y"}\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":"x\u2028y"}']);
  assert.equal(rest, '{"c"');
});

test('session: prompt returns the assistant text and writes the log', async () => {
  const env = fakePiEnv();
  const logPath = join(env.dir, 'agent.jsonl');
  const lastPath = join(env.dir, 'last.txt');
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath,
    lastMessagePath: lastPath,
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    assert.ok(session.pid);
    const turn = await session.prompt('hello', { timeoutMs: 10_000 });
    assert.equal(turn.ok, true);
    assert.equal(turn.lastMessage, 'echo:hello');
    assert.equal(readFileSync(lastPath, 'utf8'), 'echo:hello');

    // Same process, second turn — the conversation is reused, not respawned.
    const pid = session.pid;
    const again = await session.prompt('again', { timeoutMs: 10_000 });
    assert.equal(again.ok, true);
    assert.equal(again.lastMessage, 'echo:again');
    assert.equal(session.pid, pid);
    // The turn settles on the child's event, which can arrive before the log
    // WriteStream has flushed — wait for the record instead of racing it.
    await waitFor(() => readFileSync(logPath, 'utf8').includes('echo:again'));
    assert.match(readFileSync(logPath, 'utf8'), /echo:again/);
  } finally {
    await session.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: timeout aborts the turn instead of hanging', async () => {
  const env = fakePiEnv();
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath: join(env.dir, 'agent.jsonl'),
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    const turn = await session.prompt('HANG forever', { timeoutMs: 250 });
    assert.equal(turn.ok, false);
    assert.equal(turn.timedOut, true);
    assert.equal(turn.aborted, false);
  } finally {
    await session.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: signal abort is reported as aborted, not timeout', async () => {
  const env = fakePiEnv();
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath: join(env.dir, 'agent.jsonl'),
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort('test'), 100);
    const turn = await session.prompt('HANG forever', { timeoutMs: 10_000, signal: ctl.signal });
    assert.equal(turn.ok, false);
    assert.equal(turn.aborted, true);
    assert.equal(turn.timedOut, false);
  } finally {
    await session.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: a handled prompt settles without waiting for agent_settled', async () => {
  const env = fakePiEnv();
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath: join(env.dir, 'agent.jsonl'),
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    const turn = await session.prompt('HANDLED by an input handler', { timeoutMs: 2_000 });
    assert.equal(turn.ok, false);
    assert.equal(turn.timedOut, false);
    assert.match(turn.error ?? '', /handled/);
  } finally {
    await session.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: close shuts down on stdin EOF instead of killing the child', async () => {
  const env = fakePiEnv();
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath: join(env.dir, 'agent.jsonl'),
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    await session.close();
    assert.equal(readFileSync(join(env.dir, 'close-marker.txt'), 'utf8'), 'eof');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: child death fails the turn instead of hanging', async () => {
  const env = fakePiEnv();
  const session = new PiCoderSession({
    workdir: env.dir,
    agentConfig: env.agentConfig,
    logPath: join(env.dir, 'agent.jsonl'),
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
  });
  try {
    const turn = await session.prompt('DIE now', { timeoutMs: 10_000 });
    assert.equal(turn.ok, false);
    assert.match(turn.error ?? '', /session exited/);
  } finally {
    await session.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
