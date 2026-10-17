import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const TAIL_LIMIT = 64 * 1024;

export interface RunProcOpts {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinData?: string;
  timeoutMs: number;
  logPath?: string;
  signal?: AbortSignal;
  /** Called synchronously right after a successful spawn. */
  onSpawn?: (pid: number | null) => void;
  /** Also append structured stdout (JSONL) to logPath. Default true. */
  streamStdoutToLog?: boolean;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > TAIL_LIMIT && this.chunks.length > 1) {
      this.size -= this.chunks[0]!.length;
      this.chunks.shift();
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).subarray(-TAIL_LIMIT).toString('utf8');
  }
}

/**
 * Spawn a process with an argument array (no shell), capture output tails,
 * stream full output to logPath, enforce timeout, support abort.
 */
export function runProc(opts: RunProcOpts): Promise<ProcResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let log: WriteStream | null = null;
    if (opts.logPath) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      log = createWriteStream(opts.logPath, { flags: 'a' });
      log.write(`\n===== ${new Date().toISOString()} $ ${opts.argv.join(' ')}\n`);
    }

    let child;
    try {
      child = spawn(opts.argv[0]!, opts.argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log?.end();
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        stdoutTail: '',
        stderrTail: `spawn failed: ${String(err)}`,
      });
      return;
    }
    opts.onSpawn?.(child.pid ?? null);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      log?.end();
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdoutTail: stdout.text(),
        stderrTail: stderr.text(),
      });
    };

    const killChild = (sig: NodeJS.Signals) => {
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
      // Escalate if still alive after grace period.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }, 5000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killChild('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.on('data', (c: Buffer) => {
      stdout.push(c);
      if (log && opts.streamStdoutToLog !== false) log.write(c);
    });
    child.stderr!.on('data', (c: Buffer) => {
      stderr.push(c);
      log?.write(c);
    });
    child.on('error', (err) => {
      stderr.push(Buffer.from(`\nspawn error: ${String(err)}\n`));
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (opts.stdinData !== undefined) {
      child.stdin!.write(opts.stdinData);
    }
    child.stdin!.end();
  });
}

const DEFAULT_ENV_DENY = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/**
 * Build an environment for the coding/review agent that strips GitHub
 * credentials and operator-defined secrets. The agent authenticates to the
 * model provider via its own login; it must never inherit repo write tokens.
 */
export function scrubEnvForAgent(
  env: NodeJS.ProcessEnv,
  extraDeny: string[] = [],
): NodeJS.ProcessEnv {
  const deny = new Set([...DEFAULT_ENV_DENY, ...extraDeny]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (deny.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

/** Locate a command on PATH (Windows-aware PATHEXT handling). */
export function which(command: string, envPath = process.env.PATH ?? ''): string | null {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, command + (isWin && !command.toUpperCase().endsWith(ext) ? ext : ''));
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Query a process's start time (for PID-reuse-safe liveness checks). */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const ps = process.env.POWERSHELL_EXE ?? 'powershell.exe';
    const res = await runProc({
      argv: [
        ps,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
      ],
      timeoutMs: 15_000,
    });
    if (res.exitCode !== 0) return null;
    const ticks = Number(res.stdoutTail.trim());
    if (!Number.isFinite(ticks) || ticks <= 0) return null;
    // .NET ticks (100ns since 0001-01-01 UTC) -> unix ms
    return Math.floor(ticks / 10_000 - 62_135_596_800_000);
  }
  const res = await runProc({
    argv: ['ps', '-o', 'lstart=', '-p', String(pid)],
    timeoutMs: 10_000,
  });
  if (res.exitCode !== 0) return null;
  const t = Date.parse(res.stdoutTail.trim());
  return Number.isFinite(t) ? t : null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
