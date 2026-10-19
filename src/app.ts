import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store/sqlite.js';
import { Engine } from './scheduler/engine.js';
import { reconcile } from './scheduler/recovery.js';
import { GitHubTracker } from './tracker/github.js';
import { GitWorkspace } from './workspace/git.js';
import { AppLog } from './telemetry/logging.js';
import { pidAlive, processStartedAt, runProc, which } from './proc.js';
import { resolvePiInvocation } from './runners/pi.js';
import { resolveCodexInvocation } from './runners/codex.js';
import { startUiServer, type UiServer } from './ui/server.js';
import type { AppConfig } from './types.js';

/**
 * Single-instance file lock. Contents: {pid, started_ms, heartbeat_at}.
 * A fresh heartbeat + live PID means another scheduler owns the lock.
 * A stale heartbeat is NOT proof of death on its own: the holder may be a
 * paused/stalled process. Steal only when the recorded PID is dead or was
 * reused by an unrelated process (start-time mismatch). Otherwise refuse.
 */
export class InstanceLock {
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private held = false;
  private readonly startedMs = Date.now() - Math.floor(process.uptime() * 1000);

  constructor(databasePath: string) {
    this.file = join(dirname(databasePath), 'agent-control.lock');
  }

  async acquire(staleAfterMs = 45_000): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.file, this.payload(), { flag: 'wx' });
        this.held = true;
        this.timer = setInterval(() => {
          try { writeFileSync(this.file, this.payload()); } catch { /* lost */ }
        }, Math.max(5_000, staleAfterMs / 3));
        this.timer.unref();
        return;
      } catch {
        const verdict = await this.holderState(staleAfterMs);
        if (verdict === 'alive') {
          const holder = safeRead(this.file);
          throw new Error(
            `another agent-control instance holds the lock (pid=${holder?.pid ?? '?'}, heartbeat=${holder?.heartbeat_at ?? '?'}). Stop it first or delete ${this.file} if it is stale.`,
          );
        }
        rmSync(this.file, { force: true });
      }
    }
    throw new Error(`failed to acquire instance lock ${this.file}`);
  }

  private payload(): string {
    return JSON.stringify({
      pid: process.pid,
      started_ms: this.startedMs,
      heartbeat_at: new Date().toISOString(),
    });
  }

  /**
   * 'alive' → another instance owns the lock (never steal from a live
   * holder). 'stale' → holder is dead or the pid was reused; safe to steal.
   * When liveness cannot be proven, answer 'alive' (conservative).
   */
  private async holderState(staleAfterMs: number): Promise<'alive' | 'stale'> {
    const holder = safeRead(this.file);
    if (!holder?.pid) return 'stale';
    if (!pidAlive(holder.pid)) return 'stale';
    const hb = Date.parse(holder.heartbeat_at ?? '');
    if (Number.isFinite(hb) && Date.now() - hb < staleAfterMs) return 'alive';
    // Stale heartbeat but the pid is alive: paused/frozen holder, or an
    // unrelated process that reused the pid. Only a start-time match proves
    // it is really the lock holder.
    if (typeof holder.started_ms !== 'number') return 'alive';
    const actual = await processStartedAt(holder.pid);
    if (actual == null) return 'alive';
    return Math.abs(actual - holder.started_ms) < 10_000 ? 'alive' : 'stale';
  }

  release() {
    if (this.timer) clearInterval(this.timer);
    if (this.held) rmSync(this.file, { force: true });
    this.held = false;
  }
}

function safeRead(file: string): { pid?: number; heartbeat_at?: string; started_ms?: number } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface App {
  config: AppConfig;
  store: Store;
  engine: Engine;
  lock: InstanceLock;
  tracker: GitHubTracker;
}

export function createApp(config: AppConfig): App {
  const store = new Store(config.server.database);
  const appLog = new AppLog(config.server.logs_dir);
  const tracker = new GitHubTracker();
  const workspace = new GitWorkspace();
  // src/app.ts (tsx) or dist/app.js (built) → repo/install root is one level up.
  const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const engine = new Engine({
    store, config, tracker, workspace, appLog, installDir,
  });
  const lock = new InstanceLock(config.server.database);
  return { config, store, engine, lock, tracker };
}

export async function startService(app: App): Promise<void> {
  const { config, store, engine, lock, tracker } = app;
  await lock.acquire();
  const appLog = new AppLog(config.server.logs_dir);
  appLog.event('service_start', { pid: process.pid });

  // UI failure (e.g. port taken) must never take the scheduler down.
  let ui: UiServer | null = null;
  if (config.server.ui.enabled) {
    try {
      ui = await startUiServer({
        deps: { store, config, tracker, activeCount: () => engine.activeCount() },
        host: config.server.ui.host,
        port: config.server.ui.port,
        appLog,
      });
      console.log(`web ui: ${ui.url}`);
      appLog.event('ui_start', { url: ui.url });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      console.warn(`web ui failed to start (scheduler continues): ${msg}`);
      appLog.event('ui_start_failed', { error: msg.slice(0, 300) });
    }
  }

  // Reconcile BEFORE any dispatch.
  const report = await reconcile({
    store, config, tracker, appLog, engine,
  });
  appLog.event('recovery_report', { ...report });

  const tickMs = config.server.poll_interval_seconds * 1000;
  const tick = () =>
    engine.tick().catch((err) => {
      appLog.event('tick_error', { error: String(err) });
      try {
        store.setMeta('last_error', JSON.stringify({
          at: new Date().toISOString(), kind: 'tick_error', error: String(err).slice(0, 400),
        }));
      } catch { /* db closed */ }
    });
  await tick();
  const timer = setInterval(tick, tickMs);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    appLog.event('service_stop', { sig });
    ui?.close();
    clearInterval(timer);
    for (const run of store.activeRuns()) engine.abortRun(run.run_id, 'service shutdown');
    // Give in-flight runs a moment to land in CANCELED.
    await new Promise((r) => setTimeout(r, 3_000));
    lock.release();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ---------------- doctor ----------------

export interface DoctorItem { name: string; status: 'PASS' | 'FAIL' | 'UNVERIFIED'; detail: string }

export async function runDoctor(config: AppConfig | null, configError?: string): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  items.push(nodeMajor >= 22
    ? { name: 'node', status: 'PASS', detail: `v${process.versions.node}` }
    : { name: 'node', status: 'FAIL', detail: `v${process.versions.node} — need >=22.13 (node:sqlite)` });

  for (const tool of ['git', 'gh']) {
    const p = which(tool);
    if (!p) { items.push({ name: tool, status: 'FAIL', detail: 'not on PATH' }); continue; }
    const res = await runProc({ argv: [tool, '--version'], timeoutMs: 15_000 });
    items.push(res.exitCode === 0
      ? { name: tool, status: 'PASS', detail: `${p} — ${res.stdoutTail.trim().split('\n')[0]}` }
      : { name: tool, status: 'FAIL', detail: `${p} exists but --version failed` });
  }

  // The configured runner is probed through its resolved invocation (npm
  // .cmd shims cannot be spawned without a shell on Windows — false FAIL).
  const runner = config?.agent.provider ?? 'pi';
  const inv = runner === 'codex' ? resolveCodexInvocation() : resolvePiInvocation();
  const runnerArgv = (args: string[]) => [inv.argv0, ...inv.prefix, ...args];
  if (inv.argv0 === runner) {
    items.push({ name: runner, status: 'FAIL', detail: 'not on PATH' });
    items.push({ name: `${runner}-invocation`, status: 'FAIL', detail: 'unresolved' });
    if (runner === 'codex') items.push({ name: 'codex-auth', status: 'FAIL', detail: 'codex not on PATH' });
  } else if (runner === 'pi') {
    const v = await runProc({ argv: runnerArgv(['--version']), timeoutMs: 20_000 });
    items.push(v.exitCode === 0
      ? { name: 'pi', status: 'PASS', detail: `${inv.argv0 === process.execPath ? 'node ' + inv.prefix[0] : inv.argv0} — ${v.stdoutTail.trim().split('\n')[0]}` }
      : { name: 'pi', status: 'FAIL', detail: v.stderrTail.trim().slice(0, 200) });
    items.push({ name: 'pi-invocation', status: 'PASS', detail: runnerArgv(['-p', '…']).join(' ') });
    const piCfg = join(process.env.USERPROFILE ?? '', '.pi', 'agent', 'models.json');
    items.push(existsSync(piCfg)
      ? { name: 'pi-models', status: 'PASS', detail: `${piCfg}${config?.agent.review_model ? ` (review: ${config.agent.review_model})` : ''}` }
      : { name: 'pi-models', status: 'FAIL', detail: `${piCfg} missing — pi providers/models are file-configured` });
  } else {
    const v = await runProc({ argv: runnerArgv(['--version']), timeoutMs: 20_000 });
    items.push(v.exitCode === 0
      ? { name: 'codex', status: 'PASS', detail: `${inv.argv0 === process.execPath ? 'node ' + inv.prefix[0] : inv.argv0} — ${v.stdoutTail.trim().split('\n')[0]}` }
      : { name: 'codex', status: 'FAIL', detail: v.stderrTail.trim().slice(0, 200) });
    items.push({ name: 'codex-invocation', status: 'PASS', detail: runnerArgv(['exec', '…']).join(' ') });
    const codexAuth = await runProc({ argv: runnerArgv(['login', 'status']), timeoutMs: 20_000 });
    items.push(codexAuth.exitCode === 0
      ? { name: 'codex-auth', status: 'PASS', detail: codexAuth.stdoutTail.trim().slice(0, 120) }
      : { name: 'codex-auth', status: 'FAIL', detail: codexAuth.stderrTail.trim().slice(0, 200) });
  }

  // Review may run on a different runner (review_provider). Probe it too so a
  // broken review path is visible before a run burns a cycle on it.
  const reviewRunner = config?.agent.review_provider;
  if (reviewRunner && reviewRunner !== runner) {
    const rInv = reviewRunner === 'codex' ? resolveCodexInvocation() : resolvePiInvocation();
    if (rInv.argv0 === reviewRunner) {
      items.push({ name: `review-${reviewRunner}`, status: 'FAIL', detail: 'not on PATH' });
    } else {
      const v = await runProc({ argv: [rInv.argv0, ...rInv.prefix, '--version'], timeoutMs: 20_000 });
      items.push(v.exitCode === 0
        ? { name: `review-${reviewRunner}`, status: 'PASS', detail: `${config!.agent.review_model ?? 'default model'} — ${v.stdoutTail.trim().split('\n')[0]}` }
        : { name: `review-${reviewRunner}`, status: 'FAIL', detail: v.stderrTail.trim().slice(0, 200) });
    }
  }

  const ghAuth = await runProc({ argv: ['gh', 'auth', 'status'], timeoutMs: 20_000 });
  items.push(ghAuth.exitCode === 0
    ? { name: 'gh-auth', status: 'PASS', detail: 'authenticated' }
    : { name: 'gh-auth', status: 'FAIL', detail: ghAuth.stderrTail.trim().slice(0, 200) });

  if (!config) {
    items.push({ name: 'config', status: 'FAIL', detail: configError ?? 'not loaded' });
    return items;
  }
  items.push({ name: 'config', status: 'PASS', detail: `${config.projects.length} project(s)` });

  const tracker = new GitHubTracker();
  for (const p of config.projects) {
    const ok = existsSync(join(p.local_repo, '.git'));
    items.push(ok
      ? { name: `project:${p.repo}`, status: 'PASS', detail: `local repo ${p.local_repo}` }
      : { name: `project:${p.repo}`, status: 'FAIL', detail: `${p.local_repo} is not a git repo` });
    try {
      const labels = await tracker.ensureLabels(p.repo, ['agent-ready', 'agent-running', 'agent-blocked', 'agent-pr']);
      items.push(labels.ok
        ? { name: `labels:${p.repo}`, status: 'PASS', detail: 'required labels exist' }
        : { name: `labels:${p.repo}`, status: 'UNVERIFIED', detail: `missing: ${labels.missing.join(', ')}` });
    } catch (err) {
      items.push({ name: `labels:${p.repo}`, status: 'UNVERIFIED', detail: `gh label list failed: ${String(err).slice(0, 120)}` });
    }
  }

  for (const dir of [config.server.worktree_root, dirname(config.server.database), config.server.logs_dir]) {
    try {
      mkdirSync(dir, { recursive: true });
      items.push({ name: `dir:${dir}`, status: 'PASS', detail: 'writable' });
    } catch (err) {
      items.push({ name: `dir:${dir}`, status: 'FAIL', detail: String(err).slice(0, 120) });
    }
  }
  return items;
}
