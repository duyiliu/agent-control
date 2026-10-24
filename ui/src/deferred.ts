import type { IntakeState } from './api.js';

export function isDeferredDue(state: IntakeState | null | undefined, now = Date.now()): boolean {
  if (state?.kind !== 'deferred' || !state.defer_until) return false;
  const at = Date.parse(state.defer_until);
  return Number.isFinite(at) && at <= now;
}

export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
