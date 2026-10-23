import type { ProjectConfig } from '../types.js';

export const acceptsAllIssues = (p: ProjectConfig) => p.issue_intake === 'all'
  || p.issue_intake === undefined && p.issue_triage?.enabled === true;

export interface IntakeState {
  kind: 'human' | 'deferred' | 'skipped' | null;
  reason: string;
  locked: boolean;
  defer_until: string | null;
  version: number;
  updated_at: string;
  pending: { remove: string[]; retry: boolean } | null;
  error: string | null;
  imported: boolean;
  external_hold?: boolean;
  external_needs?: boolean;
}

export const emptyIntake = (): IntakeState => ({ kind: null, reason: '', locked: false,
  defer_until: null, version: 1, updated_at: new Date().toISOString(), pending: null, error: null, imported: true });

export function parseOutcome(text: string | null): { outcome: 'IMPLEMENTED' | 'NEEDS_HUMAN' | 'DEFER' | 'NO_ACTION'; reason: string } {
  const value: unknown = JSON.parse(text ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 结果必须是 JSON 对象');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'outcome,reason'
    || !['IMPLEMENTED', 'NEEDS_HUMAN', 'DEFER', 'NO_ACTION'].includes(String(row.outcome))
    || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 4000) throw new Error('Agent 结果不符合 outcome/reason 契约');
  return row as ReturnType<typeof parseOutcome>;
}
