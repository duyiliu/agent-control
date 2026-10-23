import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiCoderSession, SessionRestoreError, splitRpcLines } from '../src/runners/session.js';
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
    if (cmd.type === 'get_state') {
      send({ id: cmd.id, type: 'response', success: true, data: { sessionId: process.env.AC_FAKE_SID ?? 'ephemeral', sessionFile: process.env.AC_FAKE_SFILE ?? 'mem.jsonl' } });
      continue;
    }
    if (cmd.type === 'get_messages') {
      send({ id: cmd.id, type: 'response', success: true, data: { messages: [] } });
      continue;
    }
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

test('session: persistent binding passes --session-id/--session-dir, no --no-session', async () => {
  const env = fakePiEnv();
  const sessionDir = join(env.dir, 'pi-session');
  const logPath = join(env.dir, 'agent.jsonl');
  const session = new PiCoderSession({
    workdir: env.dir, agentConfig: env.agentConfig, logPath,
    lastMessagePath: join(env.dir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [env.fake] },
    sessionId: 'run-x', sessionDir,
  });
  try {
    await session.close(); // flushes the argv banner into the log
    const head = readFileSync(logPath, 'utf8').split('\n').find((l) => l.includes('--mode'));
    assert.ok(head!.includes('--session-id run-x') && head!.includes(`--session-dir ${sessionDir}`));
    assert.ok(!head!.includes('--no-session'));
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('session: one-sided binding and foreign/corrupt session files are refused', async () => {
  const env = fakePiEnv();
  try {
    const mk = (sessionDir: string) => new PiCoderSession({
      workdir: env.dir, agentConfig: env.agentConfig,
      logPath: join(sessionDir, 'a.jsonl'), lastMessagePath: join(sessionDir, 'l.txt'),
      invocation: { argv0: process.execPath, prefix: [env.fake] },
      sessionId: 'r1', sessionDir,
    });
    assert.throws(() => new PiCoderSession({
      workdir: env.dir, agentConfig: env.agentConfig,
      logPath: join(env.dir, 'a.jsonl'), lastMessagePath: join(env.dir, 'l.txt'),
      invocation: { argv0: process.execPath, prefix: [env.fake] }, sessionId: 'r1',
    }), /together/);

    const header = (id: string, cwd: string) => JSON.stringify({ type: 'session', id, cwd }) + '\n';
    const write = (dir: string, body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 's.jsonl'), body); };

    const wrongId = join(env.dir, 's1'); write(wrongId, header('other', env.dir));
    assert.throws(() => mk(wrongId), /does not belong/);
    const wrongCwd = join(env.dir, 's2'); write(wrongCwd, header('r1', 'C:/elsewhere'));
    assert.throws(() => mk(wrongCwd), /was opened in/);
    const corrupt = join(env.dir, 's3'); write(corrupt, 'not-json\n');
    assert.throws(() => mk(corrupt), /unreadable header/);
    const multi = join(env.dir, 's4'); write(multi, header('r1', env.dir));
    writeFileSync(join(multi, 's2.jsonl'), header('r1', env.dir));
    assert.throws(() => mk(multi), /session files/);

    const good = join(env.dir, 's5'); write(good, header('r1', env.dir));
    const ok = mk(good); // matching header → accepted, does not throw
    await ok.close();
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// Fake pi that persists history to <sessionDir>/<id>.jsonl and serves
// get_state/get_messages like real pi --mode rpc.
const FAKE_PI_PERSIST = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const sid = arg('--session-id');
const sdir = arg('--session-dir');
const file = sdir && sid ? join(sdir, sid + '.jsonl') : null;
let ctl = {};
try { ctl = JSON.parse(readFileSync(join(sdir, 'ac-fake-ctl.json'), 'utf8')); } catch {}
let messages = [];
if (file && existsSync(file)) {
  for (const l of readFileSync(file, 'utf8').split('\\n')) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); if (e.role) messages.push(e); } catch { /* torn tail */ }
  }
} else if (file) {
  mkdirSync(sdir, { recursive: true });
  appendFileSync(file, JSON.stringify({ type: 'session', id: sid, cwd: process.cwd() }) + '\\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
send({ type: 'agent_start' });
process.stdin.on('end', () => process.exit(0));
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'get_state') {
      const respond = () => send({ id: cmd.id, type: 'response', success: true,
        data: { sessionId: ctl.sessionId ?? sid, sessionFile: ctl.sessionFile ?? file } });
      if (ctl.delayMs) { void sleep(ctl.delayMs).then(respond); } else { respond(); }
    } else if (cmd.type === 'get_messages') {
      const list = ctl.emptyMessages ? [] : messages;
      try { writeFileSync(join(sdir, 'ac-fake-loaded.json'), JSON.stringify({ count: list.length })); } catch {}
      send({ id: cmd.id, type: 'response', success: true, data: { messages: list } });
    } else if (cmd.type === 'prompt') {
      send({ id: cmd.id, type: 'response', success: true, data: { disposition: 'started' } });
      messages.push({ role: 'user', content: cmd.message });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'echo:' + cmd.message }] });
      if (file) {
        appendFileSync(file, JSON.stringify({ role: 'user', content: cmd.message }) + '\\n');
        appendFileSync(file, JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'echo:' + cmd.message }] }) + '\\n');
      }
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + cmd.message }] } });
      send({ type: 'agent_settled', aborted: false });
    }
  }
});
`;

function mkBoundSession(dir: string, agentConfig: ReturnType<typeof fakePiEnv>['agentConfig'], fake: string, sessionId: string, sessionDir: string, logPath: string) {
  return new PiCoderSession({
    workdir: dir, agentConfig,
    logPath, lastMessagePath: join(sessionDir, 'last.txt'),
    invocation: { argv0: process.execPath, prefix: [fake] },
    sessionId, sessionDir,
  });
}

test('session: persistent binding — second process reopens the same history', async () => {
  const env = fakePiEnv();
  const workdir = mkdtempSync(join(tmpdir(), 'ac-sesswd-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ac-sessdir-'));
  try {
    writeFileSync(join(env.dir, 'fake-persist.mjs'), FAKE_PI_PERSIST, 'utf8');
    const fake = join(env.dir, 'fake-persist.mjs');
    assert.ok(existsSync(fake), 'fake persist script written');
    const s1 = mkBoundSession(workdir, env.agentConfig, fake, 'run-a', sdir, join(env.dir, 'a1.jsonl'));
    const t1 = await s1.prompt('hello', { timeoutMs: 5000 });
    assert.ok(t1.ok);
    await s1.close();

    const s2 = mkBoundSession(workdir, env.agentConfig, fake, 'run-a', sdir, join(env.dir, 'a2.jsonl'));
    const t2 = await s2.prompt('again', { timeoutMs: 5000 });
    assert.ok(t2.ok);
    await s2.close();
    // the second process loaded the first turn's history via get_messages —
    // the marker file records what pi actually returned, not just file bytes
    const loaded = JSON.parse(readFileSync(join(sdir, 'ac-fake-loaded.json'), 'utf8')) as { count: number };
    assert.ok(loaded.count >= 2, 'second process must see the first turn in get_messages');
    const hist = readFileSync(join(sdir, 'run-a.jsonl'), 'utf8');
    assert.ok(hist.includes('hello') && hist.includes('again'));

    const sdir2 = mkdtempSync(join(tmpdir(), 'ac-sessdir2-'));
    const other = mkBoundSession(workdir, env.agentConfig, fake, 'run-b', sdir2, join(env.dir, 'b.jsonl'));
    const t3 = await other.prompt('fresh', { timeoutMs: 5000 });
    assert.ok(t3.ok);
    await other.close();
    rmSync(sdir2, { recursive: true, force: true });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
    rmSync(env.dir, { recursive: true, force: true });
  }
});


function mkPersistEnv() {
  const env = fakePiEnv();
  writeFileSync(join(env.dir, 'fake-persist.mjs'), FAKE_PI_PERSIST, 'utf8');
  const workdir = mkdtempSync(join(tmpdir(), 'ac-sesswd-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ac-sessdir-'));
  return { env, fake: join(env.dir, 'fake-persist.mjs'), workdir, sdir };
}

function boundSession(e: ReturnType<typeof mkPersistEnv>, sessionId: string) {
  return new PiCoderSession({
    workdir: e.workdir, agentConfig: e.env.agentConfig,
    logPath: join(e.env.dir, 'a.jsonl'), lastMessagePath: join(e.env.dir, 'l.txt'),
    invocation: { argv0: process.execPath, prefix: [e.fake] },
    sessionId, sessionDir: e.sdir,
  });
}

test('session: abort during a delayed get_state returns aborted — prompt never sent', async () => {
  const e = mkPersistEnv();
  try {
    writeFileSync(join(e.sdir, 'ac-fake-ctl.json'), JSON.stringify({ delayMs: 300 }));
    const s = boundSession(e, 'run-x');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const turn = await s.prompt('hi', { timeoutMs: 5000, signal: ctl.signal });
    assert.equal(turn.aborted, true, 'abort during handshake must abort the turn');
    assert.equal(turn.ok, false);
    await new Promise((r) => setTimeout(r, 400)); // let the delayed probe land
    const file = join(e.sdir, 'run-x.jsonl');
    const hist = existsSync(file) ? readFileSync(file, 'utf8') : '';
    assert.ok(!hist.includes('"role":"user"'), 'no prompt was sent to pi');
    await s.close();
  } finally {
    rmSync(e.workdir, { recursive: true, force: true });
    rmSync(e.sdir, { recursive: true, force: true });
    rmSync(e.env.dir, { recursive: true, force: true });
  }
});

test('session: handshake rejections are cached — every prompt rejects, zero prompts reach pi', async () => {
  const e = mkPersistEnv();
  try {
    // get_state reports a different session id than the binding asks for
    writeFileSync(join(e.sdir, 'ac-fake-ctl.json'), JSON.stringify({ sessionId: 'not-run-x' }));
    const s = boundSession(e, 'run-x');
    await assert.rejects(() => s.prompt('one', { timeoutMs: 5000 }), SessionRestoreError);
    await assert.rejects(() => s.prompt('two', { timeoutMs: 5000 }), SessionRestoreError);
    const hist = existsSync(join(e.sdir, 'run-x.jsonl')) ? readFileSync(join(e.sdir, 'run-x.jsonl'), 'utf8') : '';
    assert.ok(!hist.includes('"role":"user"'), 'pi must never receive a prompt');
    await s.close();

    // path-prefix attack: sessionFile under a sibling "sessionDir-foreign"
    const e2 = mkPersistEnv();
    writeFileSync(join(e2.sdir, 'ac-fake-ctl.json'), JSON.stringify({ sessionFile: join(e2.sdir + '-foreign', 'x.jsonl') }));
    const s2 = boundSession(e2, 'run-x');
    await assert.rejects(() => s2.prompt('one', { timeoutMs: 5000 }), /outside/);
    await s2.close();
    rmSync(e2.workdir, { recursive: true, force: true });
    rmSync(e2.sdir, { recursive: true, force: true });
    rmSync(e2.env.dir, { recursive: true, force: true });
  } finally {
    rmSync(e.workdir, { recursive: true, force: true });
    rmSync(e.sdir, { recursive: true, force: true });
    rmSync(e.env.dir, { recursive: true, force: true });
  }
});

test('session: torn tail line is tolerated when pi still loads the history', async () => {
  const e = mkPersistEnv();
  try {
    writeFileSync(join(e.sdir, 'run-x.jsonl'),
      JSON.stringify({ type: 'session', id: 'run-x', cwd: e.workdir }) + '\n'
      + JSON.stringify({ role: 'user', content: 'prior' }) + '\n'
      + '{"role":"assistant","content":[{"type":"text"'); // truncated line pi tolerates
    const s = boundSession(e, 'run-x');
    const t = await s.prompt('go', { timeoutMs: 5000 });
    assert.ok(t.ok);
    await s.close();
  } finally {
    rmSync(e.workdir, { recursive: true, force: true });
    rmSync(e.sdir, { recursive: true, force: true });
    rmSync(e.env.dir, { recursive: true, force: true });
  }
});
