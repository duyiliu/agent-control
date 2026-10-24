import type { Phase } from './api';

export type GroupKey = 'queued' | 'active' | 'reviewing' | 'merging' | 'human' | 'done' | 'blocked';

const ACTIVE: Phase[] = ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'FIXING', 'PUBLISHING_PR'];
/** PR exists and is being reviewed: the run is alive, but coding is done. */
const REVIEW_PHASES: Phase[] = ['REVIEWING'];
/** PR published and waiting for (or in the middle of) its review run. */
const REVIEW_WAIT_PHASES: Phase[] = ['AWAITING_REVIEW'];
const BLOCKED: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'];

export function groupOf(status: Phase): GroupKey {
  if (ACTIVE.includes(status)) return 'active';
  if (REVIEW_PHASES.includes(status) || REVIEW_WAIT_PHASES.includes(status)) return 'reviewing';
  if (status === 'MERGING') return 'merging';
  if (status === 'AWAITING_HUMAN') return 'human';
  if (status === 'COMPLETED' || status === 'CANCELED') return 'done';
  if (BLOCKED.includes(status)) return 'blocked';
  return 'queued';
}

export const GROUPS: { key: GroupKey; label: string; dot: string }[] = [
  { key: 'queued', label: '等待派发', dot: 'bg-fg-dim' },
  { key: 'active', label: '执行中', dot: 'bg-ok' },
  { key: 'reviewing', label: '评审中', dot: 'bg-info' },
  { key: 'merging', label: '合并中', dot: 'bg-ok' },
  { key: 'human', label: '待人工处理', dot: 'bg-warn' },
  { key: 'done', label: '已完成', dot: 'bg-fg-dim' },
  { key: 'blocked', label: '异常需介入', dot: 'bg-danger' },
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
  AWAITING_REVIEW: 'sky',
  AWAITING_HUMAN: 'sky',
  MERGING: 'emerald',
  COMPLETED: 'zinc',
  BLOCKED: 'rose',
  BLOCKED_APPROVAL_CHANGED: 'rose',
  FAILED: 'rose',
  CANCELED: 'zinc',
  RECOVERY_REQUIRED: 'amber',
};

const TONE_HEX: Record<Tone, string> = {
  emerald: 'var(--color-ok)',
  sky: 'var(--color-info)',
  zinc: 'var(--color-fg-dim)',
  rose: 'var(--color-danger)',
  amber: 'var(--color-warn)',
};

const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-ok',
  sky: 'text-info',
  zinc: 'text-fg-muted',
  rose: 'text-danger',
  amber: 'text-warn',
};

/** Human labels — the raw enum stays in the API/DB, the UI speaks Chinese. */
const PHASE_LABEL: Record<Phase, string> = {
  DISCOVERED: '等待派发',
  CLAIMED: '已领取',
  PREPARING: '准备中',
  RUNNING: '执行中',
  VERIFYING: '校验中',
  REVIEWING: '评审中',
  FIXING: '修复中',
  PUBLISHING_PR: '创建 PR',
  AWAITING_REVIEW: '等待评审',
  AWAITING_HUMAN: '待人工处理',
  MERGING: '合并中',
  COMPLETED: '已完成',
  BLOCKED: '已阻塞',
  BLOCKED_APPROVAL_CHANGED: '批准已变更',
  FAILED: '失败',
  CANCELED: '已取消',
  RECOVERY_REQUIRED: '需恢复',
};

export const phaseLabel = (p: Phase | string) => PHASE_LABEL[p as Phase] ?? p;
export const phaseHex = (p: Phase) => TONE_HEX[PHASE_TONE[p]];
export const phaseTextClass = (p: Phase) => TONE_TEXT[PHASE_TONE[p]];
/** Any phase where a live process is still working (coding or reviewing). */
export const isActivePhase = (p: Phase) => ACTIVE.includes(p) || REVIEW_PHASES.includes(p);
export const isBlockedGroup = (p: Phase) => BLOCKED.includes(p);

export function fmtDur(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function fmtTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—';
}
