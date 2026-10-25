import { acceptsAllIssues } from './triage/intake.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store/sqlite.js';
import { Engine } from './scheduler/engine.js';
import { reconcile } from './scheduler/recovery.js';
import { GitHubTracker, requiredLabelsForProject } from './tracker/github.js';
import { GitWorkspace } from './workspace/git.js';
import { AppLog } from './telemetry/logging.js';
import { pidAlive, processStartedAt, runProc, which } from './proc.js';
import { resolvePiInvocation } from './runners/pi.js';
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
  /** Where the running config came from — the UI writes project additions
   *  back to it. Undefined only when a config was fabricated in-process. */
  configPath?: string;
  store: Store;
  engine: Engine;
  lock: InstanceLock;
  tracker: GitHubTracker;
}

export function createApp(config: AppConfig, configPath?: string): App {
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
  return { config, configPath, store, engine, lock, tracker };
}

export async function startService(app: App): Promise<void> {
  const { config, store, engine, lock, tracker } = app;
  await lock.acquire();
  const appLog = new AppLog(config.server.logs_dir);
  appLog.event('service_start', { pid: process.pid });
  appLog.event('review_policy', { version: config.review_policy?.version ?? 1,
    size_thresholds: config.review_policy?.version === 2 ? 'planning_only' : 'human_gate',
    legacy_tasks: 'preserved_until_explicit_rereview' });

  // UI failure (e.g. port taken) must never take the scheduler down.
  let ui: UiServer | null = null;
  if (config.server.ui.enabled) {
    try {
      ui = await startUiServer({
        deps: {
          store, config, tracker, activeCount: () => engine.activeCount(),
          configPath: app.configPath,
          triage: engine.triage,
          checkRepoExists: (repo) => tracker.checkRepoExists(repo),
          resolveRepo: (repo) => tracker.resolveRepo(repo),
          provisionRepo: (repo, readyLabel, triageEnabled, workflow) => provisionLabels(tracker, repo, readyLabel, triageEnabled, workflow),
        },
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

  const cancelTimer = setInterval(() => engine.sweepCancels(), config.server.cancel_poll_seconds * 1000);
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

  // Signal handlers must exist before the first dispatch tick — a shutdown
  // arriving mid-dispatch is a suspend, never a cancel. `timer` is assigned
  // after `await tick()`, so it is a let declared before the handler.
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    appLog.event('service_stop', { sig });
    ui?.close();
    if (timer) clearInterval(timer);
    clearInterval(cancelTimer);
    // Coding runs suspend (stay active with their persisted Pi session) and
    // are resumed by the next boot's reconcile; this only waits — bounded —
    // for each run's finally/session.close. A run that cannot settle inside
    // the budget is left to the restart's PID/orphan checks: never write
    // CANCELED, never clear a pid we cannot prove dead.
    const quiet = await engine.shutdown(10_000);
    if (!quiet) appLog.event('shutdown_incomplete', { active: engine.activeCount() });
    lock.release();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows never delivers SIGTERM (no CTRL_SHUTDOWN mapping), so a scheduled
  // task stop kills the process outright. SIGBREAK is the only graceful entry
  // point there; without it the lock self-heals only after its heartbeat
  // expires (see InstanceLock.holderState).
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  }

  await tick();
  if (!stopping) timer = setInterval(tick, tickMs);
}

/** Best-effort label provisioning for a UI-added project; returns warnings. */
async function provisionLabels(tracker: GitHubTracker, repo: string, readyLabel: string, triageEnabled: boolean, workflow = false): Promise<string[]> {
  const warnings: string[] = [];
  const wanted = requiredLabelsForProject(readyLabel, triageEnabled, workflow);
  let missing: string[];
  try {
    missing = (await tracker.ensureLabels(repo, wanted)).missing;
  } catch (err) {
    return [`标签检查失败：${String(err).slice(0, 120)}`];
  }
  for (const name of missing) {
    try {
      await tracker.createLabel(repo, name);
    } catch (err) {
      warnings.push(`标签 ${name} 创建失败：${String(err).slice(0, 120)}`);
    }
  }
  return warnings;
}

// ---------------- doctor ----------------

export interface DoctorItem { name: string; status: 'PASS' | 'FAIL' | 'UNVERIFIED'; detail: string }

export async function runDoctor(config: AppConfig | null, configError?: string): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  // node:sqlite shipped without a build flag only from 22.13; 22.5-22.12
  // would fail at import, so the minor matters as much as the major.
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);
  items.push(nodeOk
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

  // Resolve npm .cmd shims explicitly; spawn cannot invoke them directly on Windows.
  const inv = resolvePiInvocation(process.env.PATH ?? '', config?.agent.pi_path);
  const runnerArgv = (args: string[]) => [inv.argv0, ...inv.prefix, ...args];
  if (inv.argv0 === 'pi') {
    items.push({ name: 'pi', status: 'FAIL', detail: 'not on PATH — set agent.pi_path to an absolute path' });
    items.push({ name: 'pi-invocation', status: 'FAIL', detail: 'unresolved' });
  } else {
    const v = await runProc({ argv: runnerArgv(['--version']), timeoutMs: 20_000 });
    items.push(v.exitCode === 0
      ? { name: 'pi', status: 'PASS', detail: `${inv.argv0 === process.execPath ? 'node ' + inv.prefix[0] : inv.argv0} — ${v.stdoutTail.trim().split('\n')[0]}` }
      : { name: 'pi', status: 'FAIL', detail: v.stderrTail.trim().slice(0, 200) });
    items.push({ name: 'pi-invocation', status: 'PASS', detail: runnerArgv(['-p', '…']).join(' ') });
    const piCfg = join(homedir(), '.pi', 'agent', 'models.json');
    items.push(existsSync(piCfg)
      ? { name: 'pi-models', status: 'PASS', detail: `${piCfg}${config?.agent.review_model ? ` (review: ${config.agent.review_model})` : ''}` }
      : { name: 'pi-models', status: 'FAIL', detail: `${piCfg} missing — pi providers/models are file-configured` });
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
      const labels = await tracker.ensureLabels(p.repo, requiredLabelsForProject(p.ready_label, acceptsAllIssues(p), p.workflow_mode === 'github'));
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
