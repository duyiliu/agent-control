import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only JSONL event log per run. SQLite holds state; these files hold
 * narrative detail (prompt sizes, outputs, subprocess references). Values
 * written here must already be free of secrets.
 */
export class RunLog {
  readonly path: string;
  constructor(logsDir: string, runId: string) {
    mkdirSync(logsDir, { recursive: true });
    this.path = join(logsDir, `run-${runId}.jsonl`);
  }
  event(type: string, data?: Record<string, unknown>) {
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...data });
    appendFileSync(this.path, line + '\n');
  }
}

export class AppLog {
  readonly path: string;
  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.path = join(logsDir, 'agent-control.jsonl');
  }
  event(type: string, data?: Record<string, unknown>) {
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...data });
    appendFileSync(this.path, line + '\n');
  }
}
