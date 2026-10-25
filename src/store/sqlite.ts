import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CheckResultRow,
  Phase,
  RunRow,
  TaskRow,
  ReviewControl,
} from '../types.js';
import { RUN_ACTIVE_PHASES } from '../types.js';
import { parseReviewControl } from '../verify/review-policy.js';

const SCHEMA_VERSION = 13;

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
    // WAL still allows only one writer; without a timeout a second connection
    // (e.g. `ac stop` while the service holds a tx) fails with SQLITE_BUSY
    // in under a millisecond instead of waiting.
    this.db.exec('PRAGMA busy_timeout = 5000');
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
    if (current < 4) {
      // v4: review becomes a separately-dispatched run kind; evidence is
      // bound to a commit sha; review-driven fixes travel via pending_fix.
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'code';
          ALTER TABLE runs ADD COLUMN head_sha TEXT;
          ALTER TABLE check_results ADD COLUMN head_sha TEXT;
          ALTER TABLE tasks ADD COLUMN pending_fix TEXT;
        `);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(4, now());
      });
    }
    if (current < 5) {
      // v5: MERGING is a real task status whose host-side merge attempts are
      // bounded and crash-resumable — the counter must persist.
      this.tx(() => {
        this.db.exec('ALTER TABLE tasks ADD COLUMN merge_attempts INTEGER NOT NULL DEFAULT 0');
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(5, now());
      });
    }
    if (current < 6) {
      // v6: review gets its own wait state. AWAITING_REVIEW = PR published,
      // review pending/in flight (Symphony's "Human Review"); AWAITING_MERGE
      // now means strictly "reviewed, waiting for a human to merge".
      // Tasks never reviewed (no verdict row at all) move to AWAITING_REVIEW;
      // tasks with any verdict stay on the human path.
      this.tx(() => {
        this.db.exec(`
          UPDATE tasks SET status = 'AWAITING_REVIEW'
          WHERE status = 'AWAITING_MERGE' AND pr_url IS NOT NULL AND pending_fix IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM check_results c JOIN runs r ON r.run_id = c.run_id
              WHERE r.task_id = tasks.id AND c.kind = 'review'
            )
        `);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(6, now());
      });
    }
    if (current < 7) {
      // v7: AWAITING_MERGE → AWAITING_HUMAN. The state covers human judgement
      // (high-risk PASS / HRR / ERROR / manual review), not only merging —
      // the old name was a misnomer. Historical event rows are rewritten so
      // the UI keeps one vocabulary.
      this.tx(() => {
        this.db.exec(`
          UPDATE tasks SET status = 'AWAITING_HUMAN' WHERE status = 'AWAITING_MERGE';
          UPDATE runs SET phase = 'AWAITING_HUMAN' WHERE phase = 'AWAITING_MERGE';
          UPDATE run_events SET from_phase = 'AWAITING_HUMAN' WHERE from_phase = 'AWAITING_MERGE';
          UPDATE run_events SET to_phase = 'AWAITING_HUMAN' WHERE to_phase = 'AWAITING_MERGE';
        `);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(7, now());
      });
    }
    if (current < 8) {
      // v8: the sha cleared to land is recorded on the task when it enters
      // MERGING. Human approvals can rest on a non-PASS verdict (or none at
      // all in manual mode), so the merge sweep must not infer it.
      this.tx(() => {
        this.db.exec('ALTER TABLE tasks ADD COLUMN approved_sha TEXT; ALTER TABLE tasks ADD COLUMN approved_by TEXT');
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(8, now());
      });
    }
    if (current < 9) {
      // v9: a task can be discovered from a bare PR. GitHub shares one
      // number sequence between issues and PRs, so the unique key still
      // holds; `source` is what tells the two apart.
      this.tx(() => {
        this.db.exec("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'issue'");
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(9, now());
      });
    }
    if (current < 10) {
      this.tx(() => {
        this.db.exec(`
          CREATE TABLE triage_cache (repo TEXT NOT NULL, issue_number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repo, issue_number));
          CREATE TABLE triage_jobs (job_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        `);
        this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(10, now());
      });
    }
    if (current < 11) {
      this.tx(() => {
        this.db.exec(`CREATE TABLE issue_intake (repo TEXT NOT NULL, issue_number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repo, issue_number));
          ALTER TABLE runs ADD COLUMN outcome_protocol INTEGER NOT NULL DEFAULT 0;`);
        this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(11, now());
      });
    }
    if (current < 12) {
      this.tx(() => {
        this.db.exec('ALTER TABLE tasks ADD COLUMN review_control_json TEXT; ALTER TABLE check_results ADD COLUMN review_detail_json TEXT;');
        this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(12, now());
      });
    }
    if (current < 13) {
      // v13: opt-in GitHub issue workflow. NULL keeps every pre-upgrade task
      // on the legacy path; corrupt JSON is never reinterpreted as legacy.
      this.tx(() => {
        this.db.exec('ALTER TABLE tasks ADD COLUMN issue_workflow_json TEXT');
        this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(13, now());
      });
    }

  }

  getIssueWorkflow(taskId: number): string | null {
    const task = this.getTaskById(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task.issue_workflow_json;
  }

  saveIssueWorkflow(taskId: number, json: string | null) {
    const timestamp = now();
    const result = this.db.prepare('UPDATE tasks SET issue_workflow_json=?, updated_at=? WHERE id=?').run(json, timestamp, taskId);
    if (result.changes === 0) throw new Error(`task ${taskId} not found`);
  }

  getReviewControl(taskId: number): ReviewControl | null {
    const task = this.getTaskById(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return parseReviewControl(task.review_control_json);
  }

  saveReviewControl(taskId: number, control: ReviewControl | null) {
    const value = parseReviewControl(control);
    this.tx(() => {
      const task = this.getTaskById(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      const timestamp = new Date(Math.max(Date.now(), Date.parse(task.updated_at) + 1)).toISOString();
      this.db.prepare('UPDATE tasks SET review_control_json=?, updated_at=? WHERE id=?')
        .run(value === null ? null : JSON.stringify(value), timestamp, taskId);
    });
  }

  getIntake<T>(repo: string, number: number): T | null {
    const row = this.db.prepare('SELECT data FROM issue_intake WHERE repo=? AND issue_number=?').get(repo, number) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : null;
  }

  saveIntake(repo: string, number: number, value: unknown) {
    this.db.prepare('INSERT INTO issue_intake VALUES (?, ?, ?) ON CONFLICT(repo, issue_number) DO UPDATE SET data=excluded.data').run(repo, number, JSON.stringify(value));
  }

  setOutcomeProtocol(runId: string, version: number) {
    this.db.prepare('UPDATE runs SET outcome_protocol=? WHERE run_id=?').run(version, runId);
  }

  cacheTriage(repo: string, issue: number, value: unknown) {
    this.db.prepare('INSERT INTO triage_cache VALUES (?, ?, ?) ON CONFLICT(repo, issue_number) DO UPDATE SET data=excluded.data')
      .run(repo, issue, JSON.stringify(value));
  }

  listTriage<T>(): T[] {
    return (this.db.prepare('SELECT data FROM triage_cache').all() as { data: string }[]).map(r => JSON.parse(r.data) as T);
  }

  forgetTriage(repo: string, issue: number) {
    this.db.prepare('DELETE FROM triage_cache WHERE repo=? AND issue_number=?').run(repo, issue);
  }

  saveTriageJob(id: string, value: unknown) {
    this.db.prepare('INSERT INTO triage_jobs VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(value));
  }

  triageJobs<T>(): T[] {
    return (this.db.prepare('SELECT data FROM triage_jobs').all() as { data: string }[]).map(r => JSON.parse(r.data) as T);
  }

  dropTriageJob(id: string) { this.db.prepare('DELETE FROM triage_jobs WHERE job_id=?').run(id); }

  deleteUnstartedTriageTask(repo: string, issue: number): boolean {
    return this.tx(() => {
      const task = this.getTask(repo, issue);
      if (!task || task.source !== 'issue' || task.status !== 'DISCOVERED' || this.runsForTask(task.id).length) return false;
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
      return true;
    });
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
    issue_workflow_json?: string | null;
  }): { task: TaskRow; created: boolean } {
    return this.tx(() => {
      const existing = this.getTask(input.repo, input.issue_number);
      if (existing) return { task: existing, created: false };
      const t = now();
      this.db
        .prepare(
          `INSERT INTO tasks (repo, issue_number, issue_title, issue_url, status, issue_workflow_json, updated_at, created_at)
           VALUES (?, ?, ?, ?, 'DISCOVERED', ?, ?, ?)`,
        )
        .run(input.repo, input.issue_number, input.issue_title, input.issue_url, input.issue_workflow_json ?? null, t, t);
      return { task: this.getTask(input.repo, input.issue_number)!, created: true };
    });
  }

  /**
   * Register a PR that has no issue behind it. The task starts directly in
   * AWAITING_REVIEW: DISCOVERED means "needs coding", and a bare PR must
   * never reach tryDispatch (no ready label, nothing to code against).
   * An existing task for the same number wins untouched — that is either
   * an issue task or a PR already being reviewed.
   */
  upsertPrTask(input: {
    repo: string;
    number: number;
    title: string;
    url: string;
    branch: string;
  }): { task: TaskRow; created: boolean } {
    return this.tx(() => {
      const existing = this.getTask(input.repo, input.number);
      if (existing) return { task: existing, created: false };
      const t = now();
      this.db
        .prepare(
          `INSERT INTO tasks (repo, issue_number, issue_title, issue_url, source, status, branch, pr_url, updated_at, created_at)
           VALUES (?, ?, ?, ?, 'pr', 'AWAITING_REVIEW', ?, ?, ?, ?)`,
        )
        .run(input.repo, input.number, input.title, input.url, input.branch, input.url, t, t);
      return { task: this.getTask(input.repo, input.number)!, created: true };
    });
  }

  getTask(repo: string, issueNumber: number): TaskRow | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE repo = ? AND issue_number = ?')
      .get(repo, issueNumber) as TaskRow | undefined;
    return row ?? null;
  }

  /**
   * Drop every recorded review verdict for a task, so its current head can be
   * judged again. Has no effect on code runs or their check evidence — only
   * the `kind='review'` rows a re-review is meant to replace.
   */
  deleteReviewVerdicts(taskId: number) {
    this.db
      .prepare(
        `DELETE FROM check_results
         WHERE kind = 'review' AND run_id IN (SELECT run_id FROM runs WHERE task_id = ?)`,
      )
      .run(taskId);
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

  setTaskStatus(id: number, status: Phase, fields?: { approved_hash?: string | null; branch?: string | null; pr_url?: string | null; pending_fix?: string | null; merge_attempts?: number; approved_sha?: string | null; approved_by?: 'review' | 'human' | null }) {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: (string | number | null)[] = [status, now()];
    if (fields?.approved_hash !== undefined) { sets.push('approved_hash = ?'); vals.push(fields.approved_hash); }
    if (fields?.branch !== undefined) { sets.push('branch = ?'); vals.push(fields.branch); }
    if (fields?.pr_url !== undefined) { sets.push('pr_url = ?'); vals.push(fields.pr_url); }
    if (fields?.pending_fix !== undefined) { sets.push('pending_fix = ?'); vals.push(fields.pending_fix); }
    if (fields?.merge_attempts !== undefined) { sets.push('merge_attempts = ?'); vals.push(fields.merge_attempts); }
    if (fields?.approved_sha !== undefined) { sets.push('approved_sha = ?'); vals.push(fields.approved_sha); }
    if (fields?.approved_by !== undefined) { sets.push('approved_by = ?'); vals.push(fields.approved_by); }
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

  bumpMergeAttempts(id: number): number {
    this.db.prepare('UPDATE tasks SET merge_attempts = merge_attempts + 1, updated_at = ? WHERE id = ?').run(now(), id);
    return (this.getTaskById(id)?.merge_attempts ?? 0);
  }

  /** Per-attempt fix counter — the budget lives on the run, not the task. */
  bumpRunFixCount(runId: string): number {
    this.db.prepare('UPDATE runs SET fix_count = fix_count + 1 WHERE run_id = ?').run(runId);
    return (this.getRun(runId)?.fix_count ?? 0);
  }

  // ---------- runs ----------

  /** Atomically verify no active run exists and create a new attempt. */
  claimRun(taskId: number, opts?: { kind?: 'code' | 'review'; headSha?: string; outcomeProtocol?: number }): RunRow {
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
          `INSERT INTO runs (run_id, task_id, kind, attempt, phase, head_sha, started_at, heartbeat_at)
           VALUES (?, ?, ?, ?, 'CLAIMED', ?, ?, ?)`,
        )
        .run(runId, taskId, opts?.kind ?? 'code', attempt, opts?.headSha ?? null, t, t);
      if (opts?.outcomeProtocol) this.setOutcomeProtocol(runId, opts.outcomeProtocol);
      this.insertEvent(runId, null, 'CLAIMED', { attempt, kind: opts?.kind ?? 'code', head_sha: opts?.headSha ?? null });
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

  /**
   * Take a crashed run back under control: the recorded child is gone, so the
   * pid is cleared before a new process may claim the run. Shared by boot-time
   * reconciliation and the deferred-resume sweep so both count the budget.
   * Only an active run can be resumed, and only into an active phase —
   * terminal transitions go through endRun.
   */
  resumeRun(runId: string, to: Phase) {
    this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`run ${runId} not found`);
      if (!RUN_ACTIVE_PHASES.includes(run.phase) || !RUN_ACTIVE_PHASES.includes(to)) {
        throw new Error(`run ${runId} cannot resume ${run.phase} -> ${to}`);
      }
      this.db
        .prepare('UPDATE runs SET resume_count = resume_count + 1, pid = NULL, process_identity = NULL WHERE run_id = ?')
        .run(runId);
      this.transition(runId, run.phase, to, { recovered: true });
    });
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
      head_sha: string | null;
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
    head_sha?: string | null;
    detail_json?: string | null;
  }): number {
    if (input.detail_json != null) JSON.parse(input.detail_json);
    const res = this.db
      .prepare(
        `INSERT INTO check_results (run_id, kind, command, exit_code, artifact_path, verdict, head_sha, review_detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.run_id, input.kind, input.command, input.exit_code, input.artifact_path ?? null, input.verdict, input.head_sha ?? null, input.detail_json ?? null, now());
    return Number(res.lastInsertRowid);
  }

  checksForRun(runId: string): CheckResultRow[] {
    return this.db
      .prepare('SELECT * FROM check_results WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as CheckResultRow[];
  }

  /** True when a review verdict row (any verdict) exists for this head sha. */
  hasReviewVerdictForSha(taskId: number, headSha: string): boolean {
    return this.db
      .prepare(
        `SELECT 1 FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'review' AND c.head_sha = ? LIMIT 1`,
      )
      .get(taskId, headSha) !== undefined;
  }

  hasReviewVerdictForScope(taskId: number, headSha: string, baseSha: string | null): boolean {
    const reviews = this.runsForTask(taskId).filter(run => run.kind === 'review');
    return reviews.some(run => {
      if (!this.checksForRun(run.run_id).some(check => check.kind === 'review' && check.head_sha === headSha)) return false;
      const events = this.eventsForRun(run.run_id);
      let hasScopedStart = false;
      for (const event of events.reverse()) {
        try {
          const detail = JSON.parse(event.detail_json ?? 'null') as { kind?: unknown; head_sha?: unknown; base_sha?: unknown } | null;
          if (detail?.kind !== 'review_started') continue;
          hasScopedStart = true;
          if (detail.head_sha !== headSha) continue;
          return (typeof detail.base_sha === 'string' ? detail.base_sha : null) === baseSha;
        } catch { /* unstructured historical events cannot attest the diff base */ }
      }
      return !hasScopedStart && baseSha === null;
    });
  }

  /** The sha of the task's latest review verdict row (any verdict). */
  latestReviewVerdictSha(taskId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT c.head_sha FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'review' AND c.head_sha IS NOT NULL
         ORDER BY c.id DESC LIMIT 1`,
      )
      .get(taskId) as { head_sha: string | null } | undefined;
    return row?.head_sha ?? null;
  }

  /**
   * The sha a MERGING task is cleared to land: the head_sha of the task's
   * latest PASS review verdict. A merge must be pinned to exactly this.
   */
  latestPassReviewSha(taskId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT c.head_sha FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'review' AND c.verdict = 'PASS' AND c.head_sha IS NOT NULL
         ORDER BY c.id DESC LIMIT 1`,
      )
      .get(taskId) as { head_sha: string | null } | undefined;
    return row?.head_sha ?? null;
  }

  /**
   * Check evidence for one head sha across all runs of a task — latest row
   * per command wins. Review runs consume this to build testEvidence.
   */
  checkEvidenceForSha(taskId: number, headSha: string): CheckResultRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'check' AND c.head_sha = ? ORDER BY c.id`,
      )
      .all(taskId, headSha) as unknown as CheckResultRow[];
    return [...new Map(rows.map((c) => [c.command, c])).values()];
  }

  /**
   * Fallback check evidence: the task's latest check row per command across
   * all runs, regardless of head_sha. Used when sha-scoped evidence is absent
   * (legacy rows predate the head_sha column).
   */
  latestCheckEvidence(taskId: number): CheckResultRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM check_results c JOIN runs r ON r.run_id = c.run_id
         WHERE r.task_id = ? AND c.kind = 'check' ORDER BY c.id`,
      )
      .all(taskId) as unknown as CheckResultRow[];
    return [...new Map(rows.map((c) => [c.command, c])).values()];
  }

  /** Workspace of the task's most recent code run (review materialization hint). */
  lastCodeWorkspace(taskId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT workspace FROM runs WHERE task_id = ? AND kind = 'code' AND workspace IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId) as { workspace: string | null } | undefined;
    return row?.workspace ?? null;
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
