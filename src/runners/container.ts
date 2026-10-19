import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProc, scrubEnvForAgent, which, type ProcResult } from '../proc.js';
import type { AppConfig, ContainerConfig, ProjectConfig } from '../types.js';

export class ContainerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
  }
}

export function resolveIsolation(
  project: ProjectConfig | undefined,
  agent: AppConfig['agent'],
): 'none' | 'docker' {
  return project?.isolation ?? agent.isolation ?? 'none';
}

/** Directory names never uploaded from the worktree (host-only or platform-specific build output). */
export const SYNC_EXCLUDES = ['.git', '.venv', 'node_modules', 'target', '__pycache__'];

export function tarExcludeArgs(): string[] {
  return SYNC_EXCLUDES.map((e) => `--exclude=${e}`);
}

/** Worktree paths synced up on session open — the baseline the container mutates. */
export function hostTarBin(): string {
  if (process.platform === 'win32') {
    const bsdtar = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(bsdtar)) return bsdtar;
  }
  return 'tar';
}

export function containerNameFor(runId: string, seq: number): string {
  return `ac-run-${runId}-${seq}`;
}

export const CACHE_VOLUME = 'ac-cache';

export function volumeNamesFor(runId: string): { worktree: string; artifacts: string } {
  return { worktree: `ac-wt-${runId}`, artifacts: `ac-ac-${runId}` };
}

export function strayNameFilterFor(runId: string): string {
  return `^ac-run-${runId}`;
}

/** './a/b' -> 'a/b'; directory entries (trailing '/') -> null. */
export function normalizeTarEntry(entry: string): string | null {
  let e = entry.trim().replace(/\\/g, '/');
  if (e === '.' || e === './') return null;
  if (e.startsWith('./')) e = e.slice(2);
  if (e.endsWith('/')) return null;
  return e || null;
}

/** Relative paths (slash-separated) present locally but absent remotely must be deleted. */
export function computeLocalDeletions(localFiles: string[], remoteFiles: Set<string>): string[] {
  return localFiles.filter((f) => !remoteFiles.has(f));
}

/** Walk a directory into relative slash-separated file paths, skipping SYNC_EXCLUDES components. */
export function listLocalFiles(root: string, skipExcluded = true): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skipExcluded && SYNC_EXCLUDES.includes(name)) continue;
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, relPath);
      else out.push(relPath);
    }
  };
  walk(root, '');
  return out;
}

export interface SessionOpts {
  runId: string;
  /** Host worktree — authoritative source of truth, mutated only host-side. */
  worktreePath: string;
  /** Host artifacts dir; prompt files are staged here before push. */
  artifactsDir: string;
  agent: AppConfig['agent'];
  syncTimeoutMs?: number;
}

export interface SessionRunOpts {
  stdinData?: string;
  timeoutMs: number;
  logPath?: string;
  stdoutFilePath?: string;
  signal?: AbortSignal;
  /** Host PID of the docker CLI process (the liveness anchor on the host side). */
  onSpawn?: (pid: number | null) => void;
}

const DEFAULT_SYNC_TIMEOUT_MS = 120_000;

/** Regular config files under a runner's auth dir; sockets/logs/caches stay behind. */
function listAuthFiles(base: string): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (/\.(sock|log|pid)$/.test(name)) continue;
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      try {
        if (statSync(full).isDirectory()) walk(full, relPath);
        else out.push(relPath);
      } catch {
        /* unreadable entry — skip */
      }
    }
  };
  walk(base, '');
  return out;
}

/**
 * One container execution session: volume pair (worktree copy + artifacts) +
 * tar round-trip. Host worktree stays authoritative; container mutations only
 * become real after a successful syncDown. Volumes are session-scoped and
 * always torn down; ac-cache persists across sessions for dependency caches.
 */
export class ContainerSession {
  readonly artifactsDir: string;
  private readonly cfg: ContainerConfig;
  private readonly envDeny: string[];
  private readonly runId: string;
  private readonly worktreePath: string;
  private readonly syncTimeoutMs: number;
  private readonly volumes: { worktree: string; artifacts: string };
  private readonly dockerBin: string;
  private seq = 0;
  private lastContainer: string | null = null;
  private closed = false;

  private constructor(opts: SessionOpts, dockerBin: string) {
    if (!opts.agent.container?.image) {
      throw new ContainerError('agent.container.image is not configured');
    }
    this.runId = opts.runId;
    this.worktreePath = opts.worktreePath;
    this.artifactsDir = opts.artifactsDir;
    this.cfg = opts.agent.container;
    this.envDeny = opts.agent.env_deny;
    this.syncTimeoutMs = opts.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.volumes = volumeNamesFor(opts.runId);
    this.dockerBin = dockerBin;
  }

  private dockerEnv(): NodeJS.ProcessEnv {
    const env = scrubEnvForAgent(process.env, this.envDeny);
    if (this.cfg.host) env.DOCKER_HOST = this.cfg.host;
    return env;
  }

  private async docker(
    args: string[],
    extra: {
      stdinData?: string;
      stdinFilePath?: string;
      stdoutFilePath?: string;
      timeoutMs?: number;
      logPath?: string;
    } = {},
  ): Promise<ProcResult> {
    return runProc({
      argv: [this.dockerBin, ...args],
      env: this.dockerEnv(),
      timeoutMs: extra.timeoutMs ?? this.syncTimeoutMs,
      stdinData: extra.stdinData,
      stdinFilePath: extra.stdinFilePath,
      stdoutFilePath: extra.stdoutFilePath,
      logPath: extra.logPath,
      streamStdoutToLog: false,
    });
  }

  /** Create volumes, syncUp the worktree, stage runner auth files into /ac. */
  static async open(opts: SessionOpts, dockerBin?: string): Promise<ContainerSession> {
    const bin = dockerBin ?? which('docker') ?? 'docker';
    const s = new ContainerSession(opts, bin);
    for (const vol of [s.volumes.worktree, s.volumes.artifacts, CACHE_VOLUME]) {
      const res = await s.docker(['volume', 'create', vol]);
      if (res.exitCode !== 0) {
        throw new ContainerError(`docker volume create ${vol} failed`, res.stderrTail.slice(-2000));
      }
    }
    await s.syncUp();
    await s.stageAuth();
    return s;
  }

  /** tar the host worktree (minus excludes) and unpack it into the worktree volume. */
  private async syncUp(): Promise<void> {
    const tmpTar = join(tmpdir(), `ac-up-${this.runId}-${Date.now()}.tar`);
    try {
      const pack = await runProc({
        argv: [hostTarBin(), '-cf', tmpTar, ...tarExcludeArgs(), '-C', this.worktreePath, '.'],
        timeoutMs: this.syncTimeoutMs,
        streamStdoutToLog: false,
      });
      if (pack.exitCode !== 0) {
        throw new ContainerError('host tar (upload pack) failed', pack.stderrTail.slice(-2000));
      }
      const unpack = await this.docker(
        ['run', '--rm', '-i', '-v', `${this.volumes.worktree}:/work`, this.cfg.image, 'tar', '-xpf', '-', '-C', '/work'],
        { stdinFilePath: tmpTar },
      );
      if (unpack.exitCode !== 0) {
        throw new ContainerError('container unpack (upload) failed', unpack.stderrTail.slice(-2000));
      }
    } finally {
      rmSync(tmpTar, { force: true });
    }
  }

  /**
   * Stage runner auth files into /ac; the image entrypoint moves them into
   * home. Whitelisted files only — runner home dirs contain runtime sockets,
   * logs and caches the container must not need.
   */
  private async stageAuth(): Promise<void> {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const stages: { base: string; files: string[]; dest: string }[] = [
      { base: join(home, '.pi', 'agent'), files: listAuthFiles(join(home, '.pi', 'agent')), dest: 'pi-auth' },
      {
        base: join(home, '.codex'),
        files: ['auth.json', 'config.toml'].filter((f) => existsSync(join(home, '.codex', f))),
        dest: 'codex-auth',
      },
    ];
    for (const st of stages) {
      if (st.files.length === 0) continue;
      const tmpTar = join(tmpdir(), `ac-auth-${this.runId}-${st.dest}-${Date.now()}.tar`);
      try {
        const pack = await runProc({
          argv: [hostTarBin(), '-cf', tmpTar, '-C', st.base, ...st.files],
          timeoutMs: this.syncTimeoutMs,
          streamStdoutToLog: false,
        });
        if (pack.exitCode !== 0) {
          throw new ContainerError(`host tar (auth ${st.dest}) failed`, pack.stderrTail.slice(-2000));
        }
        const unpack = await this.docker(
          [
            'run', '--rm', '-i', '-v', `${this.volumes.artifacts}:/ac`, this.cfg.image,
            'sh', '-c', `mkdir -p /ac/${st.dest} && tar -xpf - -C /ac/${st.dest}`,
          ],
          { stdinFilePath: tmpTar },
        );
        if (unpack.exitCode !== 0) {
          throw new ContainerError(`auth staging (${st.dest}) failed`, unpack.stderrTail.slice(-2000));
        }
      } finally {
        rmSync(tmpTar, { force: true });
      }
    }
  }

  /** Push one host file into the artifacts volume (e.g. pi @prompt include). */
  async pushFile(containerPath: string, hostPath: string): Promise<void> {
    const res = await this.docker(
      [
        'run', '--rm', '-i', '-v', `${this.volumes.artifacts}:/ac`, this.cfg.image,
        'sh', '-c', `mkdir -p "$(dirname '/ac/${containerPath}')" && cat > '/ac/${containerPath}'`,
      ],
      { stdinFilePath: hostPath },
    );
    if (res.exitCode !== 0) {
      throw new ContainerError(`push ${containerPath} failed`, res.stderrTail.slice(-2000));
    }
  }

  /** Pull one file from the artifacts volume to a host path (e.g. codex -o output). */
  async pullArtifact(containerPath: string, hostPath: string): Promise<boolean> {
    const res = await this.docker(
      ['run', '--rm', '-v', `${this.volumes.artifacts}:/ac`, this.cfg.image, 'cat', `/ac/${containerPath}`],
      { stdoutFilePath: hostPath },
    );
    if (res.exitCode !== 0) return false;
    return existsSync(hostPath);
  }

  /**
   * Run one argv inside the session container (cwd=/work). Kill/timeout kills
   * the docker CLI; the attached container is force-removed afterwards so no
   * orphan can keep mutating the volume.
   */
  async run(containerArgv: string[], opts: SessionRunOpts): Promise<ProcResult> {
    if (this.closed) throw new ContainerError('session already closed');
    const name = containerNameFor(this.runId, ++this.seq);
    this.lastContainer = name;
    const argv = [
      'run', '--rm', '--name', name,
      '-v', `${this.volumes.worktree}:/work`,
      '-v', `${this.volumes.artifacts}:/ac`,
      '-v', `${CACHE_VOLUME}:/root/.cache`,
      '-w', '/work',
      ...(this.cfg.network ? ['--network', this.cfg.network] : []),
      ...this.cfg.extra_args,
      this.cfg.image,
      ...containerArgv,
    ];
    const res = await runProc({
      argv: [this.dockerBin, ...argv],
      env: this.dockerEnv(),
      stdinData: opts.stdinData,
      timeoutMs: opts.timeoutMs,
      logPath: opts.logPath,
      stdoutFilePath: opts.stdoutFilePath,
      signal: opts.signal,
      onSpawn: opts.onSpawn,
      streamStdoutToLog: true,
    });
    await this.docker(['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => undefined);
    return res;
  }

  /**
   * syncDown (optional) then tear down. syncBack=true reconciles deletions
   * first, then unpacks the container's /work over the host worktree. The
   * .git directory and excluded dirs on the host are never touched.
   */
  async close(opts: { syncBack?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (opts.syncBack) await this.syncDown();
    } finally {
      await this.teardown();
    }
  }

  /** Force-dispose without syncing — error/cancel paths. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.teardown();
  }

  private async syncDown(): Promise<void> {
    const tmpTar = join(tmpdir(), `ac-down-${this.runId}-${Date.now()}.tar`);
    const tmpList = `${tmpTar}.list`;
    try {
      const pull = await this.docker(
        [
          'run', '--rm', '-v', `${this.volumes.worktree}:/work`, this.cfg.image,
          'tar', '-cf', '-', '-C', '/work', ...tarExcludeArgs(), '.',
        ],
        { stdoutFilePath: tmpTar },
      );
      if (pull.exitCode !== 0) {
        throw new ContainerError('container tar (download pack) failed', pull.stderrTail.slice(-2000));
      }
      if (!existsSync(tmpTar)) {
        throw new ContainerError('download produced no archive');
      }
      const list = await this.docker(
        ['run', '--rm', '-v', `${this.volumes.worktree}:/work`, this.cfg.image, 'find', '/work', '-type', 'f'],
        { stdoutFilePath: tmpList },
      );
      if (list.exitCode !== 0) {
        throw new ContainerError('container find (download list) failed', list.stderrTail.slice(-2000));
      }
      const remoteSet = new Set(
        readFileSync(tmpList, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => normalizeTarEntry(l.startsWith('/work/') ? l.slice('/work/'.length) : l))
          .filter((e): e is string => e !== null),
      );
      const locals = listLocalFiles(this.worktreePath);
      for (const rel of computeLocalDeletions(locals, remoteSet)) {
        rmSync(join(this.worktreePath, ...rel.split('/')), { force: true });
      }
      const unpack = await runProc({
        argv: [hostTarBin(), '-xpf', tmpTar, '-C', this.worktreePath],
        timeoutMs: this.syncTimeoutMs,
        streamStdoutToLog: false,
      });
      if (unpack.exitCode !== 0) {
        throw new ContainerError('host tar (download unpack) failed', unpack.stderrTail.slice(-2000));
      }
    } finally {
      rmSync(tmpTar, { force: true });
      rmSync(tmpList, { force: true });
    }
  }

  private async teardown(): Promise<void> {
    if (this.lastContainer) {
      await this.docker(['rm', '-f', this.lastContainer], { timeoutMs: 30_000 }).catch(() => undefined);
      this.lastContainer = null;
    }
    for (const vol of [this.volumes.worktree, this.volumes.artifacts]) {
      // --rm container cleanup is async on the daemon: an immediate volume rm
      // can race "in use". Retry briefly instead of leaking the volume.
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await this.docker(['volume', 'rm', '-f', vol], { timeoutMs: 60_000 }).catch(() => null);
        if (res?.exitCode === 0) break;
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  }
}

/**
 * Live containers belonging to a run (docker.exe death does not imply container
 * death). null = scan failed — callers must treat that as "cannot prove clean".
 */
export async function findContainerStrays(
  runId: string,
  opts: { host?: string; exec?: typeof runProc; dockerBin?: string } = {},
): Promise<string[] | null> {
  const env = { ...process.env };
  if (opts.host) env.DOCKER_HOST = opts.host;
  const res = await (opts.exec ?? runProc)({
    argv: [
      opts.dockerBin ?? which('docker') ?? 'docker',
      'ps', '-a', '--filter', `name=${strayNameFilterFor(runId)}`,
      '--format', '{{.Names}}\t{{.Status}}',
    ],
    env,
    timeoutMs: 30_000,
    streamStdoutToLog: false,
  });
  if (res.exitCode !== 0) return null;
  return res.stdoutTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^Up\b/i.test(l.split('\t')[1] ?? ''))
    .map((l) => l.split('\t')[0]!);
}
