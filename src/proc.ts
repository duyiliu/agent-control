import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
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
  /** Bytes of stdout kept for the tail. Default 64 KiB; raise for large diffs. */
  stdoutLimit?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: string;
  stdoutTruncated?: boolean;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit = TAIL_LIMIT) {}
  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.limit) this.truncated = true;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks[0]!.length;
      this.chunks.shift();
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).subarray(-this.limit).toString('utf8');
  }
}

/**
 * Spawn a process with an argument array (no shell), capture output tails,
 * stream full output to logPath, enforce timeout, support abort.
 */
export function runProc(opts: RunProcOpts): Promise<ProcResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: null, timedOut: false, aborted: true, durationMs: 0, stdoutTail: '', stderrTail: '' });
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = new TailBuffer(opts.stdoutLimit);
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
        spawnError: String(err),
      });
      return;
    }
    opts.onSpawn?.(child.pid ?? null);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | undefined;
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
        ...(spawnError ? { spawnError } : {}),
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
      });
    };

    const killChild = (sig: NodeJS.Signals) => {
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
      // Windows: child.kill only terminates the direct process. Kill the
      // whole tree so grandchildren spawned by the agent cannot linger.
      if (process.platform === 'win32' && child.pid != null) taskkillTree(child.pid);
      // Escalate if still alive after grace period.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        if (process.platform === 'win32' && child.pid != null) taskkillTree(child.pid);
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
      spawnError = String(err);
      stderr.push(Buffer.from(`\nspawn error: ${String(err)}\n`));
    });
    child.on('close', (code, signal) => finish(code, signal));
    if (opts.signal?.aborted) onAbort();

    if (opts.stdinData !== undefined) {
      child.stdin!.write(opts.stdinData);
    }
    child.stdin!.end();
  });
}

/**
 * Minimal environment passed to the agent child. An allowlist is the
 * boundary: ambient secrets (CI tokens, cloud creds, arbitrary *_KEY) must
 * never reach a process that executes model-chosen commands. Proxy vars are
 * allowed because the agent may need them to reach the provider; pi auth is
 * file-based (~/.pi/agent/models.json) and needs no env.
 */
const AGENT_ENV_ALLOW = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PUBLIC', 'ALLUSERSPROFILE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'TEMP', 'TMP', 'TMPDIR', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'PSMODULEPATH', 'POWERSHELL_EXE',
  'HOME', 'SHELL', 'TERM', 'USER', 'LOGNAME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
];

/** Shared empty dir used as GH_CONFIG_DIR — gh then finds no authenticated host. */
let ghJail: string | null = null;
function ghJailDir(): string {
  if (!ghJail) {
    ghJail = join(tmpdir(), 'agent-control-gh-jail');
    try { mkdirSync(ghJail, { recursive: true }); } catch { /* missing dir works too */ }
  }
  return ghJail;
}

/**
 * Build the agent environment: allowlist only, minus `extraDeny`. Never
 * inherits GitHub tokens or other ambient secrets. Beyond env vars, on-disk
 * credentials are cut off too: gh points at an empty config dir, git's
 * credential helper is cleared, ssh is dead-ended, and auth lookups cannot
 * prompt — so `git push`/`gh` fail unauthenticated instead of merely being
 * prohibited by prompt text.
 */
export function scrubEnvForAgent(
  env: NodeJS.ProcessEnv,
  extraDeny: string[] = [],
): NodeJS.ProcessEnv {
  const allow = new Set(AGENT_ENV_ALLOW);
  const deny = new Set(extraDeny.map((k) => k.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if (!allow.has(key) || deny.has(key)) continue;
    out[k] = v;
  }
  out.GH_CONFIG_DIR = ghJailDir();
  out.GIT_CONFIG_COUNT = '1';
  out.GIT_CONFIG_KEY_0 = 'credential.helper';
  out.GIT_CONFIG_VALUE_0 = '';
  out.GIT_TERMINAL_PROMPT = '0';
  out.GCM_INTERACTIVE = 'never';
  out.GIT_SSH_COMMAND = 'exit 1';
  return out;
}

/** Kill a Windows process tree (best effort, fire and forget). */
export function killTree(pid: number) {
  if (process.platform === 'win32') { taskkillTree(pid); return; }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
}

function taskkillTree(pid: number) {
  try {
    const t = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    t.on('error', () => {});
    t.unref();
  } catch {
    /* noop */
  }
}

/**
 * Resolve a PowerShell binary that can actually be spawned. A bare
 * 'pwsh.exe' PATH lookup hits the App Execution Alias stub under
 * WindowsApps first, and spawning that reparse point from a scheduled-task
 * / non-interactive context fails with EPERM — so skip alias stubs and
 * fall back to the always-present Windows PowerShell.
 */
let psBin: string | null = null;
function resolvePowerShell(): string {
  if (psBin) return psBin;
  const env = process.env.POWERSHELL_EXE;
  if (env) return (psBin = env);
  const candidates = [
    which('pwsh.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ];
  for (const c of candidates) {
    if (!c || c.includes('WindowsApps')) continue;
    if (existsSync(c)) return (psBin = c);
  }
  return (psBin = 'powershell.exe');
}

/**
 * PIDs of live processes whose command line contains `needle` (typically a
 * worktree path). Used at recovery to detect orphaned agent processes.
 * Returns null when the scan itself fails — callers must treat that as
 * "cannot prove clean".
 */
export async function findProcessesReferencing(needle: string): Promise<number[] | null> {
  if (process.platform === 'win32') {
    const ps = resolvePowerShell();
    const esc = needle.replace(/'/g, "''");
    const res = await runProc({
      argv: [
        ps,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Exclude $PID: the scanner's own command line contains the needle.
        `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${esc}*' }).ProcessId -join ','`,
      ],
      timeoutMs: 20_000,
    });
    if (res.exitCode !== 0) {
      console.error(
        `findProcessesReferencing scan failed: exit=${res.exitCode} spawn=${res.spawnError ?? '-'} ` +
          `stderr=${res.stderrTail.trim().slice(0, 300)}`,
      );
      return null;
    }
    const out = res.stdoutTail.trim();
    if (!out) return [];
    return out.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }
  const res = await runProc({ argv: ['pgrep', '-f', needle], timeoutMs: 10_000 });
  if (res.exitCode == null || res.exitCode > 1) return null;
  return res.stdoutTail
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export interface ProcessSafetyDeps {
  isPidAlive?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => Promise<number | null>;
  findProcs?: (needle: string) => Promise<number[] | null>;
}

export async function runProcessRisk(
  run: { pid: number | null; process_identity: string | null; workspace: string | null },
  deps: ProcessSafetyDeps = {},
): Promise<string | null> {
  if (run.pid && (deps.isPidAlive ?? pidAlive)(run.pid)) {
    const [pid, start] = (run.process_identity ?? '').split(':');
    const expected = Number(start);
    const actual = await (deps.processStartedAt ?? processStartedAt)(run.pid).catch(() => null);
    if (Number(pid) !== run.pid || !start || !Number.isFinite(expected) || actual === null || Math.abs(actual - expected) < 10_000) {
      return 'child process may still be alive; refusing duplicate';
    }
  }
  if (run.workspace && existsSync(run.workspace)) {
    const pids = await (deps.findProcs ?? findProcessesReferencing)(run.workspace).catch(() => null);
    if (pids === null) return 'cannot verify no orphaned processes on worktree';
    const strays = pids.filter((pid) => pid !== process.pid);
    if (strays.length) return `orphaned process(es) on worktree: ${strays.join(', ')}`;
  }
  return null;
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
    const ps = resolvePowerShell();
    const res = await runProc({
      argv: [
        ps,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // StartTime is a LOCAL DateTime; normalize to UTC before converting
        // ticks -> unix ms (a raw .Ticks read is off by the TZ offset).
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
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
