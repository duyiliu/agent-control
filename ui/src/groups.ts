import type { Phase } from './api';

export type GroupKey = 'queued' | 'active' | 'awaiting' | 'done' | 'blocked';

const ACTIVE: Phase[] = ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'FIXING', 'REVIEWING', 'PUBLISHING_PR'];
const BLOCKED: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELED'];

export function groupOf(status: Phase): GroupKey {
  if (ACTIVE.includes(status)) return 'active';
  if (status === 'AWAITING_MERGE') return 'awaiting';
  if (status === 'COMPLETED') return 'done';
  if (BLOCKED.includes(status)) return 'blocked';
  return 'queued';
}

export const GROUPS: { key: GroupKey; label: string; dot: string }[] = [
  { key: 'queued', label: 'Queued', dot: 'bg-zinc-400' },
  { key: 'active', label: 'In Progress', dot: 'bg-emerald-400' },
  { key: 'awaiting', label: 'Awaiting Merge', dot: 'bg-sky-400' },
  { key: 'done', label: 'Done', dot: 'bg-zinc-500' },
  { key: 'blocked', label: 'Needs Attention', dot: 'bg-rose-400' },
];

type Tone = 'emerald' | 'sky' | 'zinc' | 'rose' | 'amber';

const PHASE_TONE: Record<Phase, Tone> = {
  DISCOVERED: 'zinc',
  CLAIMED: 'emerald',
  PREPARING: 'emerald',
  RUNNING: 'emerald',
  VERIFYING: 'emerald',
  FIXING: 'emerald',
  REVIEWING: 'emerald',
  PUBLISHING_PR: 'emerald',
  AWAITING_MERGE: 'sky',
  COMPLETED: 'zinc',
  BLOCKED: 'rose',
  BLOCKED_APPROVAL_CHANGED: 'rose',
  FAILED: 'rose',
  CANCELED: 'zinc',
  RECOVERY_REQUIRED: 'amber',
};

const TONE_HEX: Record<Tone, string> = {
  emerald: '#34d399',
  sky: '#38bdf8',
  zinc: '#71717a',
  rose: '#fb7185',
  amber: '#fbbf24',
};

const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-300',
  sky: 'text-sky-300',
  zinc: 'text-zinc-400',
  rose: 'text-rose-300',
  amber: 'text-amber-300',
};

/** Human labels — the raw enum stays in the API/DB, the UI speaks Linear. */
const PHASE_LABEL: Record<Phase, string> = {
  DISCOVERED: 'Queued',
  CLAIMED: 'Claimed',
  PREPARING: 'Preparing',
  RUNNING: 'Running',
  VERIFYING: 'Verifying',
  REVIEWING: 'Reviewing',
  FIXING: 'Fixing',
  PUBLISHING_PR: 'Publishing PR',
  AWAITING_MERGE: 'Awaiting merge',
  COMPLETED: 'Completed',
  BLOCKED: 'Blocked',
  BLOCKED_APPROVAL_CHANGED: 'Approval changed',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  RECOVERY_REQUIRED: 'Recovery needed',
};

export const phaseLabel = (p: Phase) => PHASE_LABEL[p] ?? p;
export const phaseHex = (p: Phase) => TONE_HEX[PHASE_TONE[p]];
export const phaseTextClass = (p: Phase) => TONE_TEXT[PHASE_TONE[p]];
export const isActivePhase = (p: Phase) => ACTIVE.includes(p);
export const isBlockedGroup = (p: Phase) => BLOCKED.includes(p);

export function fmtDur(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function fmtTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—';
}
