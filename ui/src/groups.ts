import type { Phase, TaskSummary, WorkflowState } from './api.js';

/** Board columns. The first seven mirror the GitHub Issue labels. */
export type GroupKey = 'backlog' | 'todo' | 'active' | 'human' | 'rework' | 'merging' | 'done' | 'blocked';

export interface BoardColumn {
  key: GroupKey;
  /** Canonical GitHub label; the legacy-only error column has no label. */
  label: string;
  sub: string;
  dot: string;
}

export const COLUMNS: Record<GroupKey, BoardColumn> = {
  backlog: { key: 'backlog', label: 'Backlog', sub: '待办池 · 拖到 Todo 才会派发', dot: 'bg-fg-dim' },
  todo: { key: 'todo', label: 'Todo', sub: '等待调度器领取', dot: 'bg-info' },
  active: { key: 'active', label: 'In Progress', sub: '执行中 · 运行状态只在本机记录', dot: 'bg-ok' },
  human: { key: 'human', label: 'Human Review', sub: '待人工审核 · 拖到 Merging 或 Rework', dot: 'bg-warn' },
  rework: { key: 'rework', label: 'Rework', sub: '完整返工 · 新分支与新 PR', dot: 'bg-warn' },
  merging: { key: 'merging', label: 'Merging', sub: '人工批准后合并', dot: 'bg-ok' },
  done: { key: 'done', label: 'Done', sub: '已合并并关闭 Issue', dot: 'bg-fg-dim' },
  blocked: { key: 'blocked', label: '异常', sub: '状态缺失/冲突或旧流程阻塞', dot: 'bg-danger' },
};

export const WORKFLOW_TEXT: Record<WorkflowState, string> = {
  Backlog: '待办池',
  Todo: '待派发',
  'In Progress': '执行中',
  'Human Review': '待人工审核',
  Rework: '返工',
  Merging: '合并中',
  Done: '已完成',
};

type Tone = 'emerald' | 'sky' | 'zinc' | 'rose' | 'amber';

const ACTIVE: Phase[] = ['CLAIMED', 'PREPARING', 'RUNNING', 'VERIFYING', 'FIXING', 'PUBLISHING_PR'];
/** PR exists and is being reviewed: the run is alive, but coding is done. */
const REVIEW_PHASES: Phase[] = ['REVIEWING'];
/** PR published and waiting for (or in the middle of) its review run. */
const REVIEW_WAIT_PHASES: Phase[] = ['AWAITING_REVIEW'];
const BLOCKED: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'FAILED', 'RECOVERY_REQUIRED'];

export function workflowBucket(state: WorkflowState | null): GroupKey {
  switch (state) {
    case 'Backlog': return 'backlog';
    case 'Todo': return 'todo';
    case 'In Progress': return 'active';
    case 'Human Review': return 'human';
    case 'Rework': return 'rework';
    case 'Merging': return 'merging';
    case 'Done': return 'done';
    default: return 'blocked';
  }
}

/** Legacy tasks keep their phase/intake presentation; they are frozen records. */
function legacyBucket(task: TaskSummary): GroupKey {
  const intake = task.intake;
  if (intake) {
    if (intake.kind === 'skipped') return 'done';
    if (intake.kind === 'deferred') return 'backlog';
    if (intake.kind === 'human' || intake.locked || intake.external_hold || intake.external_needs) return 'human';
    if (intake.error || intake.pending) return 'blocked';
  }
  const phase = task.active_run?.phase ?? task.status;
  if (phase === 'DISCOVERED') return 'todo';
  if (ACTIVE.includes(phase) || REVIEW_PHASES.includes(phase) || REVIEW_WAIT_PHASES.includes(phase)) return 'active';
  if (phase === 'AWAITING_HUMAN') return 'human';
  if (phase === 'MERGING') return 'merging';
  if (phase === 'COMPLETED' || phase === 'CANCELED') return 'done';
  return 'blocked';
}

export function bucketOf(task: TaskSummary): GroupKey {
  if (!task.workflow) return legacyBucket(task);
  // The Issue label is the business state. A local CANCELED status is an
  // execution record (e.g. a human paused In Progress), not "Done".
  if (task.workflow_state) return workflowBucket(task.workflow_state);
  if (task.status === 'COMPLETED' || task.status === 'CANCELED') return 'done';
  return 'blocked';
}

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

const WORKFLOW_TONE: Record<WorkflowState, Tone> = {
  Backlog: 'zinc',
  Todo: 'sky',
  'In Progress': 'emerald',
  'Human Review': 'amber',
  Rework: 'amber',
  Merging: 'emerald',
  Done: 'zinc',
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
export const phaseHex = (p: Phase) => TONE_HEX[PHASE_TONE[p] ?? 'zinc'];
export const phaseTextClass = (p: Phase) => TONE_TEXT[PHASE_TONE[p] ?? 'zinc'];
export const workflowHex = (s: WorkflowState | null) => TONE_HEX[s ? WORKFLOW_TONE[s] ?? 'rose' : 'rose'];
export const workflowTextClass = (s: WorkflowState | null) => TONE_TEXT[s ? WORKFLOW_TONE[s] ?? 'rose' : 'rose'];
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
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
