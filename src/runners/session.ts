import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { killTree, scrubEnvForAgent } from '../proc.js';
import type { AppConfig } from '../types.js';
import { buildRpcArgv, resolvePiInvocation, type PiInvocation } from './pi.js';

const STDERR_TAIL_LIMIT = 8 * 1024;
const ABORT_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_500;

export interface CoderTurn {
  ok: boolean;
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  lastMessage: string | null;
  durationMs: number;
  error?: string;
  stderrTail: string;
}

export interface CoderTurnOpts {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * One coding agent conversation, kept alive across phases so FIXING reuses the
 * context (and self-reasoning) of the turn that produced the failing work.
 */
export interface CoderSession {
  readonly pid: number | null;
  prompt(text: string, opts: CoderTurnOpts): Promise<CoderTurn>;
  close(): Promise<void>;
}

export interface CoderSessionOpts {
  workdir: string;
  agentConfig: AppConfig['agent'];
  model?: string;
  thinking?: string;
  tools?: string[];
  logPath: string;
  lastMessagePath: string;
  onSpawn?: (pid: number | null, identity: string | null) => void;
  invocation?: PiInvocation;
  /** Persistent session binding: resume history survives a host restart.
   *  Must be set as a pair — one without the other throws. Unset keeps the
   *  ephemeral --no-session behaviour. */
  sessionId?: string;
  sessionDir?: string;
}

interface PendingCommand {
  resolve: (resp: RpcResponse) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  resolve: (turn: CoderTurn) => void;
  startedAt: number;
  timedOut: boolean;
  aborted: boolean;
  timer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

interface RpcResponse {
  success?: boolean;
  error?: string;
  data?: unknown;
}

/** RPC framing is LF-only; Unicode line separators inside JSON are not boundaries. */
export function splitRpcLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.charCodeAt(i) !== 10) continue;
    lines.push(buffer.slice(start, i).replace(/\r$/, ''));
    start = i + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/** `data.disposition` of a prompt response; absent on older/foreign responses. */
function rpcDisposition(resp: RpcResponse): string | null {
  const data = resp.data;
  if (!data || typeof data !== 'object') return null;
  const value = (data as { disposition?: unknown }).disposition;
  return typeof value === 'string' ? value : null;
}

function assistantText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as { content?: unknown };
  if (!Array.isArray(msg.content)) return null; // user messages carry a string
  const texts = (msg.content as { type?: string; text?: string }[])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return texts.length ? texts.join('\n') : null;
}

/** The persisted Pi session cannot be loaded safely — never silently replaced. */
export class SessionRestoreError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionRestoreError'; }
}

interface SessionPreflight {
  /** Absolute path of the pre-existing session file, null when dir is empty. */
  file: string | null;
  /** The file already holds conversation entries (user/assistant records). */
  hasConversation: boolean;
}

/**
 * Persistent-session preflight: the dir is per-run. An existing *.jsonl must
 * be a Pi session file whose header id and cwd match this binding — anything
 * else (corrupt head, foreign id/cwd, multiple files) means we cannot prove
 * the history is this run's, so refuse rather than silently forking a new
 * session over unknown files. Empty dir is fine (fresh run or upgraded run).
 * Only the header and the presence of conversation entries are inspected —
 * a truncated tail line Pi can repair is not our business.
 */
function verifySessionDir(sessionDir: string, sessionId: string, workdir: string): SessionPreflight {
  mkdirSync(sessionDir, { recursive: true });
  const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return { file: null, hasConversation: false };
  if (files.length > 1) {
    throw new SessionRestoreError(`pi session dir ${sessionDir} holds ${files.length} session files; expected at most one`);
  }
  const filePath = join(sessionDir, files[0]!);
  const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
  let header: { type?: unknown; id?: unknown; cwd?: unknown } | null;
  try { header = JSON.parse(lines[0] ?? '') as typeof header; } catch {
    throw new SessionRestoreError(`pi session file ${files[0]} has an unreadable header; refusing to reuse`);
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new SessionRestoreError(`pi session file ${files[0]} has a malformed header; refusing to reuse`);
  }
  if (header.type !== 'session' || header.id !== sessionId) {
    throw new SessionRestoreError(`pi session file ${files[0]} does not belong to session ${sessionId}; refusing to reuse`);
  }
  if (typeof header.cwd !== 'string' || resolve(header.cwd) !== resolve(workdir)) {
    throw new SessionRestoreError(`pi session file ${files[0]} was opened in ${String(header.cwd)} not ${workdir}; refusing to reuse`);
  }
  const hasConversation = lines.slice(1).some((l) => {
    try {
      const e = JSON.parse(l) as { type?: unknown; role?: unknown; message?: { role?: unknown } };
      return e.role === 'user' || e.role === 'assistant' || e.message?.role === 'user' || e.message?.role === 'assistant' || e.type === 'message';
    } catch { return false; } // a torn tail line is Pi's to repair, not a rejection reason
  });
  return { file: filePath, hasConversation };
}

export class PiCoderSession implements CoderSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: WriteStream;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private pending = new Map<string, PendingCommand>();
  private turn: ActiveTurn | null = null;
  private lastText: string | null = null;
  private stderrTail = '';
  private seq = 0;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private readonly preflight: SessionPreflight | null;
  // Cached forever once kicked off: a rejected handshake rejects every later
  // prompt identically — never retried into a silent cold session.
  private handshake: Promise<void> | null = null;

  constructor(private readonly opts: CoderSessionOpts) {
    if ((opts.sessionId == null) !== (opts.sessionDir == null)) {
      throw new SessionRestoreError('CoderSessionOpts.sessionId and sessionDir must be set together');
    }
    this.preflight = opts.sessionDir != null
      ? verifySessionDir(opts.sessionDir, opts.sessionId!, opts.workdir)
      : null;
    const inv = opts.invocation ?? resolvePiInvocation(process.env.PATH ?? '', opts.agentConfig.pi_path);
    const argv = buildRpcArgv(
      { tools: opts.tools, model: opts.model, thinking: opts.thinking, sessionId: opts.sessionId, sessionDir: opts.sessionDir },
      inv,
    );
    const env = scrubEnvForAgent(process.env, opts.agentConfig.env_deny);
    env.PI_OFFLINE = '1';
    env.PI_TELEMETRY = '0';

    mkdirSync(dirname(opts.logPath), { recursive: true });
    this.log = createWriteStream(opts.logPath, { flags: 'w' });
    this.log.on('error', () => { /* disk full / closed early: never crash the scheduler */ });
    this.log.write(`\n===== ${new Date().toISOString()} $ ${argv.join(' ')} (rpc)\n`);

    this.child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.workdir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    opts.onSpawn?.(this.child.pid ?? null, this.child.pid != null ? `${this.child.pid}:${Date.now()}` : null);

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.log.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });
    this.child.on('error', (err) => this.onExit(null, String(err)));
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    this.child.stdin.on('error', () => { /* child died; exit handler owns the state */ });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  async prompt(text: string, turnOpts: CoderTurnOpts): Promise<CoderTurn> {
    if (this.turn) throw new Error('coder session already has a turn in flight');
    if (this.exitInfo) {
      return this.deadTurn(`session exited (${this.exitInfo.code ?? this.exitInfo.signal ?? 'unknown'})`);
    }
    if (turnOpts.signal?.aborted) return this.deadTurn('aborted before prompt', true);

    if (this.preflight) {
      this.handshake ??= this.verifyPersistentSession();
      const handshake = this.handshake;
      if (turnOpts.signal) {
        // Abort during the (possibly slow) handshake must surface now, not
        // after a 30s get_state wait — the read-only probes just finish on
        // their own / are torn down by close().
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<'aborted'>((res) => {
          abortListener = () => res('aborted');
          turnOpts.signal!.addEventListener('abort', abortListener, { once: true });
        });
        let outcome: 'ok' | 'aborted';
        try {
          outcome = await Promise.race([handshake.then(() => 'ok' as const), aborted]);
        } finally {
          turnOpts.signal.removeEventListener('abort', abortListener!);
        }
        if (outcome === 'aborted') return this.deadTurn('aborted before prompt', true);
      } else {
        await handshake;
      }
      // Anything settled while the handshake was in flight still means: do
      // not send the prompt.
      if (turnOpts.signal?.aborted) return this.deadTurn('aborted before prompt', true);
      const exit = this.exitInfo as { code: number | null; signal: string | null } | null;
      if (exit) {
        return this.deadTurn(`session exited (${exit.code ?? exit.signal ?? 'unknown'})`);
      }
    }

    const turn = this.beginTurn();
    const settled = new Promise<CoderTurn>((resolve) => { turn.resolve = resolve; });
    const onAbort = () => this.abortTurn(turn, { aborted: true });
    turnOpts.signal?.addEventListener('abort', onAbort, { once: true });
    turn.timer = setTimeout(() => this.abortTurn(turn, { timedOut: true }), turnOpts.timeoutMs);

    try {
      const resp = await this.send({ type: 'prompt', message: text });
      if (resp.success === false) {
        this.endTurn(turn, { error: `prompt rejected: ${resp.error ?? 'unknown'}` });
      } else if (rpcDisposition(resp) === 'handled') {
        // No run was started for this prompt, so agent_settled will never
        // arrive — settle now instead of stalling until the turn timeout.
        this.endTurn(turn, { error: 'prompt was handled without starting a run' });
      }
      return await settled;
    } finally {
      turnOpts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (!this.exitInfo) {
      if (this.turn) this.send({ type: 'abort' }).catch(() => { /* exiting anyway */ });
      // Orderly shutdown is stdin EOF: pi disposes its runtime and exits on its
      // own. Only escalate to a tree kill when the child ignores the close.
      try { this.child.stdin.end(); } catch { /* already gone */ }
      await this.waitExit(CLOSE_GRACE_MS);
      if (!this.exitInfo && this.child.pid != null) {
        killTree(this.child.pid);
        await this.waitExit(CLOSE_GRACE_MS);
      }
    }
    this.log.end();
  }

  /**
   * One-time proof that pi opened THE bound session before the first prompt
   * is sent: get_state must name our id and a file inside our sessionDir
   * (the pre-existing file when there was one — pi silently creates a new
   * file with the same id when it cannot find the old one), and a dir that
   * already held conversation must come back with non-empty history.
   */
  private async verifyPersistentSession() {
    const { sessionId, sessionDir } = this.opts;
    const state = await this.send({ type: 'get_state' });
    if (state.success === false) {
      throw new SessionRestoreError(`pi get_state failed: ${state.error ?? 'unknown'}`);
    }
    const data = (state.data ?? {}) as { sessionId?: unknown; sessionFile?: unknown };
    if (data.sessionId !== sessionId) {
      throw new SessionRestoreError(`pi opened session ${String(data.sessionId)}; expected ${sessionId}`);
    }
    const sessionFile = typeof data.sessionFile === 'string' ? data.sessionFile : '';
    const rel = sessionFile ? relative(resolve(sessionDir!), resolve(sessionFile)) : '';
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SessionRestoreError(`pi session file ${sessionFile || '(none)'} is outside ${sessionDir}`);
    }
    if (this.preflight!.file && resolve(sessionFile) !== resolve(this.preflight!.file)) {
      throw new SessionRestoreError(`pi opened ${sessionFile} but the persisted file is ${this.preflight!.file}`);
    }
    if (this.preflight!.hasConversation) {
      const msgs = await this.send({ type: 'get_messages' });
      if (msgs.success === false) {
        throw new SessionRestoreError(`pi get_messages failed: ${msgs.error ?? 'unknown'}`);
      }
      const list = (msgs.data as { messages?: unknown } | undefined)?.messages;
      if (!Array.isArray(list) || list.length === 0) {
        throw new SessionRestoreError(`pi loaded an empty conversation from ${this.preflight!.file}`);
      }
    }
  }

  private beginTurn(): ActiveTurn {
    const turn: ActiveTurn = {
      resolve: () => {},
      startedAt: Date.now(),
      timedOut: false,
      aborted: false,
      timer: null,
      killTimer: null,
    };
    this.turn = turn;
    this.lastText = null; // lastMessage must describe this turn, not the previous one
    return turn;
  }

  private abortTurn(turn: ActiveTurn, why: { aborted?: boolean; timedOut?: boolean }) {
    if (this.turn !== turn) return;
    turn.aborted = turn.aborted || why.aborted === true;
    turn.timedOut = turn.timedOut || why.timedOut === true;
    this.send({ type: 'abort' }).catch(() => { /* handled by exit path */ });
    if (!turn.killTimer) {
      turn.killTimer = setTimeout(() => {
        if (this.turn === turn && this.child.pid != null) killTree(this.child.pid);
      }, ABORT_GRACE_MS);
    }
  }

  private endTurn(turn: ActiveTurn, extra: { error?: string; aborted?: boolean } = {}) {
    if (this.turn !== turn) return;
    this.turn = null;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.killTimer) clearTimeout(turn.killTimer);
    if (this.lastText !== null) {
      try { writeFileSync(this.opts.lastMessagePath, this.lastText, 'utf8'); } catch { /* best effort */ }
    }
    turn.resolve({
      ok: !turn.aborted && !turn.timedOut && !extra.error,
      // A settle triggered by our own timeout is a timeout, not a user cancel.
      aborted: turn.aborted || (extra.aborted === true && !turn.timedOut),
      timedOut: turn.timedOut,
      exitCode: null,
      lastMessage: this.lastText,
      durationMs: Date.now() - turn.startedAt,
      ...(extra.error ? { error: extra.error } : {}),
      stderrTail: this.stderrTail,
    });
  }

  private deadTurn(error: string, aborted = false): CoderTurn {
    return {
      ok: false, aborted, timedOut: false,
      exitCode: this.exitInfo?.code ?? null,
      lastMessage: this.lastText, durationMs: 0, error, stderrTail: this.stderrTail,
    };
  }

  private onStdout(chunk: Buffer) {
    this.log.write(chunk);
    this.buffer += this.decoder.write(chunk);
    const { lines, rest } = splitRpcLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: { type?: string; id?: string; success?: boolean; error?: string; message?: unknown; aborted?: boolean };
      try { ev = JSON.parse(line) as typeof ev; } catch { continue; }
      try {
        this.dispatch(ev);
      } catch { /* a malformed record must never take the scheduler down */ }
    }
  }

  private dispatch(ev: { type?: string; id?: string; success?: boolean; error?: string; message?: unknown; aborted?: boolean }) {
    if (ev.type === 'response' && ev.id) {
      const pending = this.pending.get(ev.id);
      if (pending) {
        this.pending.delete(ev.id);
        clearTimeout(pending.timer);
        pending.resolve(ev);
      }
      return;
    }
    if (ev.type === 'message_end') {
      const message = ev.message as { role?: string } | undefined;
      if (message?.role !== 'assistant') return;
      const text = assistantText(ev.message);
      if (text !== null) this.lastText = text;
      return;
    }
    if (ev.type === 'agent_settled' && this.turn) {
      this.endTurn(this.turn, { aborted: ev.aborted === true });
    }
  }

  private onExit(code: number | null, error?: string | null) {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal: error ?? null };
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error: error ?? 'session exited' });
    }
    this.pending.clear();
    if (this.turn) {
      this.endTurn(this.turn, { error: error ?? `session exited (${code ?? 'unknown'})` });
    }
  }

  private write(record: unknown) {
    if (this.exitInfo) throw new Error('session exited');
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private send(record: Record<string, unknown>): Promise<RpcResponse> {
    const id = `req-${++this.seq}`;
    return new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, error: 'command timeout' });
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      try {
        this.write({ id, ...record });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ success: false, error: String(err) });
      }
    });
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
  }
}

export function openPiCoderSession(opts: CoderSessionOpts): CoderSession {
  return new PiCoderSession(opts);
}
