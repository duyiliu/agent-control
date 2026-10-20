import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CheckResultRow,
  Phase,
  RunRow,
  TaskRow,
} from '../types.js';
import { RUN_ACTIVE_PHASES } from '../types.js';

const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL DEFAULT '',
  issue_url TEXT NOT NULL DEFAULT '',
  approved_hash TEXT,
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  branch TEXT,
  pr_url TEXT,
  fix_rounds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo, issue_number)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL,
  return_phase TEXT,
  resume_count INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  process_identity TEXT,
  workspace TEXT,
  branch TEXT,
  pr_url TEXT,
  reason TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  ended_at TEXT
);

-- One active run per task, enforced by SQLite, not by convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active
  ON runs(task_id)
  WHERE phase IN ('CLAIMED','PREPARING','RUNNING','VERIFYING','FIXING','REVIEWING','PUBLISHING_PR');

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_phase TEXT,
  to_phase TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  artifact_path TEXT,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_checks_run ON check_results(run_id);
`;

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)',
    );
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema v${current} is newer than supported v${SCHEMA_VERSION}`);
    }
    if (current < 1) {
      this.tx(() => {
        this.db.exec(DDL);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(1, now());
      });
    }
    if (current < 2) {
      // v2: per-run fix budget (fix rounds must not accumulate across attempts).
      this.tx(() => {
        this.db.exec('ALTER TABLE runs ADD COLUMN fix_count INTEGER NOT NULL DEFAULT 0');
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(2, now());
      });
    }
    if (current < 3) {
      // v3: kv meta store (last internal error surfaced via `status`).
      this.tx(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(3, now());
      });
    }
  }

  private txDepth = 0;
  private savepointSeq = 0;

  /** Reentrant transaction: nested calls become SAVEPOINTs. */
  tx<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.db.exec('BEGIN IMMEDIATE');
      this.txDepth++;
      try {
        const out = fn();
        this.db.exec('COMMIT');
        return out;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* rolled back */ }
        throw err;
      } finally {
        this.txDepth--;
      }
    }
    const sp = `sp_${++this.savepointSeq}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec(`RELEASE ${sp}`);
      return out;
    } catch (err) {
      try { this.db.exec(`ROLLBACK TO ${sp}`); this.db.exec(`RELEASE ${sp}`); } catch { /* noop */ }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ---------- tasks ----------

  upsertDiscovered(input: {
    repo: string;
    issue_number: number;
    issue_title: string;
    issue_url: string;
  }): { task: TaskRow; created: boolean } {
    return this.tx(() => {
      const existing = this.getTask(input.repo, input.issue_number);
      if (existing) return { task: existing, created: false };
      const t = now();
      this.db
        .prepare(
          `INSERT INTO tasks (repo, issue_number, issue_title, issue_url, status, updated_at, created_at)
           VALUES (?, ?, ?, ?, 'DISCOVERED', ?, ?)`,
        )
        .run(input.repo, input.issue_number, input.issue_title, input.issue_url, t, t);
      return { task: this.getTask(input.repo, input.issue_number)!, created: true };
    });
  }

  getTask(repo: string, issueNumber: number): TaskRow | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE repo = ? AND issue_number = ?')
      .get(repo, issueNumber) as TaskRow | undefined;
    return row ?? null;
  }

  getTaskById(id: number): TaskRow | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined) ?? null;
  }

  listTasks(status?: Phase): TaskRow[] {
    if (status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id')
        .all(status) as unknown as TaskRow[];
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as unknown as TaskRow[];
  }

  setTaskStatus(id: number, status: Phase, fields?: { approved_hash?: string | null; branch?: string | null; pr_url?: string | null }) {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: (string | number | null)[] = [status, now()];
    if (fields?.approved_hash !== undefined) { sets.push('approved_hash = ?'); vals.push(fields.approved_hash); }
    if (fields?.branch !== undefined) { sets.push('branch = ?'); vals.push(fields.branch); }
    if (fields?.pr_url !== undefined) { sets.push('pr_url = ?'); vals.push(fields.pr_url); }
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  setApprovedHash(id: number, hash: string) {
    this.db.prepare('UPDATE tasks SET approved_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), id);
  }

  bumpFixRounds(id: number): number {
    this.db.prepare('UPDATE tasks SET fix_rounds = fix_rounds + 1, updated_at = ? WHERE id = ?').run(now(), id);
    return (this.getTaskById(id)?.fix_rounds ?? 0);
  }

  /** Per-attempt fix counter — the budget lives on the run, not the task. */
  bumpRunFixCount(runId: string): number {
    this.db.prepare('UPDATE runs SET fix_count = fix_count + 1 WHERE run_id = ?').run(runId);
    return (this.getRun(runId)?.fix_count ?? 0);
  }

  // ---------- runs ----------

  /** Atomically verify no active run exists and create a new attempt. */
  claimRun(taskId: number): RunRow {
    return this.tx(() => {
      const active = this.activeRunForTask(taskId);
      if (active) throw new Error(`task ${taskId} already has active run ${active.run_id}`);
      const attempt =
        ((this.db
          .prepare('SELECT MAX(attempt) AS m FROM runs WHERE task_id = ?')
          .get(taskId) as { m: number | null } | undefined)?.m ?? 0) + 1;
      const runId = randomUUID();
      const t = now();
      this.db
        .prepare(
          `INSERT INTO runs (run_id, task_id, attempt, phase, started_at, heartbeat_at)
           VALUES (?, ?, ?, 'CLAIMED', ?, ?)`,
        )
        .run(runId, taskId, attempt, t, t);
      this.insertEvent(runId, null, 'CLAIMED', { attempt });
      return this.getRun(runId)!;
    });
  }

  getRun(runId: string): RunRow | null {
    return (this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined) ?? null;
  }

  getRunById(id: number): RunRow | null {
    return (this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
  }

  runsForTask(taskId: number): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id')
      .all(taskId) as unknown as RunRow[];
  }

  activeRunForTask(taskId: number): RunRow | null {
    const placeholders = RUN_ACTIVE_PHASES.map(() => '?').join(',');
    return (
      (this.db
        .prepare(`SELECT * FROM runs WHERE task_id = ? AND phase IN (${placeholders})`)
        .get(taskId, ...RUN_ACTIVE_PHASES) as RunRow | undefined) ?? null
    );
  }

  activeRuns(): RunRow[] {
    const placeholders = RUN_ACTIVE_PHASES.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM runs WHERE phase IN (${placeholders}) ORDER BY id`)
      .all(...RUN_ACTIVE_PHASES) as unknown as RunRow[];
  }

  runsWithCancelRequested(): RunRow[] {
    const placeholders = RUN_ACTIVE_PHASES.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE cancel_requested = 1 AND phase IN (${placeholders})`,
      )
      .all(...RUN_ACTIVE_PHASES) as unknown as RunRow[];
  }

  requestCancel(runId: string) {
    this.db.prepare('UPDATE runs SET cancel_requested = 1 WHERE run_id = ?').run(runId);
  }

  transition(runId: string, from: Phase | null, to: Phase, detail?: unknown) {
    this.tx(() => {
      const t = now();
      this.db
        .prepare('UPDATE runs SET phase = ?, heartbeat_at = ? WHERE run_id = ?')
        .run(to, t, runId);
      this.insertEvent(runId, from, to, detail);
    });
  }

  heartbeat(runId: string) {
    this.db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(now(), runId);
  }

  updateRunFields(
    runId: string,
    fields: Partial<{
      pid: number | null;
      process_identity: string | null;
      workspace: string | null;
      branch: string | null;
      pr_url: string | null;
      resume_count: number;
      fix_count: number;
    }>,
  ) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    if (sets.length === 0) return;
    vals.push(runId);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...vals);
  }

  endRun(runId: string, finalPhase: Phase, reason?: string) {
    this.tx(() => {
      const t = now();
      this.db
        .prepare('UPDATE runs SET phase = ?, ended_at = ?, heartbeat_at = ?, reason = ? WHERE run_id = ?')
        .run(finalPhase, t, t, reason ?? null, runId);
      this.insertEvent(runId, null, finalPhase, reason ? { reason } : undefined);
    });
  }

  private insertEvent(runId: string, from: Phase | null, to: Phase, detail?: unknown) {
    this.db
      .prepare('INSERT INTO run_events (run_id, at, from_phase, to_phase, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(runId, now(), from, to, detail !== undefined ? JSON.stringify(detail) : null);
  }

  eventsForRun(runId: string) {
    return this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as {
      id: number;
      run_id: string;
      at: string;
      from_phase: string | null;
      to_phase: string;
      detail_json: string | null;
    }[];
  }

  // ---------- check_results ----------

  addCheck(input: {
    run_id: string;
    kind: string;
    command: string;
    exit_code: number | null;
    artifact_path?: string;
    verdict: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO check_results (run_id, kind, command, exit_code, artifact_path, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.run_id, input.kind, input.command, input.exit_code, input.artifact_path ?? null, input.verdict, now());
    return Number(res.lastInsertRowid);
  }

  checksForRun(runId: string): CheckResultRow[] {
    return this.db
      .prepare('SELECT * FROM check_results WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as CheckResultRow[];
  }

  /** True when any attempt for this task recorded a passing review. */
  hasReviewPass(taskId: number): boolean {
    return this.db
      .prepare(
        `SELECT 1 FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'review' AND c.verdict = 'PASS' LIMIT 1`,
      )
      .get(taskId) !== undefined;
  }

  // ---------- meta ----------

  setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}
