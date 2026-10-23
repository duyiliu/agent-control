import { createHash } from 'node:crypto';
import type { IssueData } from '../types.js';

export const MANAGED = 'agent-triage-managed';
export const NEEDS_HUMAN = 'agent-needs-human';
export const HUMAN_HOLD = 'agent-human-hold';
export const RUNNING = 'agent-running';
export const STATE_MARKER = '<!-- agent-control:triage-state:v1 -->';
export const CLAIM_MARKER = '<!-- agent-control:triage-claim:v1 -->';
export const REASONS = {
  clear_in_scope: '需求明确且属于项目范围',
  unclear_requirements: '需求或验收标准不明确',
  out_of_scope: '超出项目处理范围',
  duplicate_or_resolved: '可能重复或已经解决',
  high_risk: '涉及较高风险，需要人工确认',
  needs_human_context: '缺少需要人工补充的上下文',
  not_actionable: '当前没有可执行的开发事项',
  temporary_wait: '等待条件成熟后处理',
  model_unavailable: 'AI 分流暂不可用，需要人工核对',
  invalid_output: 'AI 返回格式不符合约定',
  human_requested: '由人工指定处理方式',
} as const;
export type ReasonCode = keyof typeof REASONS;
export type Decision = 'AUTO' | 'HUMAN' | 'DEFER' | 'SKIP';
export interface IssueComment {
  id: number;
  body: string;
  author: string;
  authorType: string;
  createdAt: string;
  updatedAt: string;
}
export interface HistoryEntry {
  generation: number;
  decision: Decision;
  reason_code: ReasonCode;
  at: string;
  input_hash: string | null;
}
export interface PendingAction {
  kind: 'AUTO' | 'HUMAN' | 'DEFER' | 'SKIP' | 'APPROVE' | 'REEVALUATE' | 'WITHDRAW';
  remove_needs: boolean;
  clear_hold: boolean;
}
export interface TriageState {
  version: 1;
  generation: number;
  claim_id: string;
  decision: Decision | null;
  reason_code: ReasonCode;
  input_hash: string | null;
  base_sha: string | null;
  model: string | null;
  at: string;
  defer_until: string | null;
  route_source: 'ai' | 'human' | null;
  route_input_hash: string | null;
  route_generation: number | null;
  previous_decision: Decision | null;
  previous_generation: number | null;
  pending_action: PendingAction | null;
  history: HistoryEntry[];
  history_incomplete: boolean;
}
export interface ClaimState { id: string; owner: string; released: boolean }
export interface TriageItem {
  repo: string;
  issue: IssueData;
  status: 'pending' | 'evaluating' | 'human' | 'deferred' | 'skipped' | 'routed';
  state: TriageState | null;
  comment_id: number | null;
  locked: boolean;
  error: string | null;
  claim_id: string | null;
  observed_at: string;
}
export interface TriageJob {
  id: string;
  repo: string;
  number: number;
  claim_comment: number;
  pid: number | null;
  process_identity: string | null;
  workspace: string;
  deadline: number;
  generation: number;
  input_hash: string;
  log_path: string;
}

const decisions: unknown[] = ['AUTO', 'HUMAN', 'DEFER', 'SKIP'];
const actions: unknown[] = [...decisions, 'APPROVE', 'REEVALUATE', 'WITHDRAW'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function markerJson(body: string, marker: string): unknown {
  const match = /^\s*```json\s*\n([^]*?)\n```/.exec(body.slice(marker.length));
  if (!match) throw new Error('分流状态格式损坏，需要人工恢复');
  return JSON.parse(match[1]!);
}

export function readState(comments: IssueComment[], login: string): { state: TriageState | null; id: number | null } {
  const rows = comments.filter(c => c.body.startsWith(STATE_MARKER));
  if (rows.length > 1 || rows.some(c => c.author !== login)) throw new Error('分流状态评论重复或作者不可信');
  if (!rows.length) return { state: null, id: null };
  const v = markerJson(rows[0]!.body, STATE_MARKER);
  if (!record(v) || v.version !== 1 || !int(v.generation) || v.generation < 1 || typeof v.claim_id !== 'string'
    || !(v.decision === null || decisions.includes(v.decision)) || !Object.hasOwn(REASONS, String(v.reason_code))
    || !hash(v.input_hash) || !hash(v.route_input_hash) || !date(v.at)
    || !(v.base_sha === null || typeof v.base_sha === 'string' && /^[a-f0-9]{40,64}$/.test(v.base_sha))
    || !(v.model === null || typeof v.model === 'string') || !(v.defer_until === null || date(v.defer_until))
    || ![null, 'ai', 'human'].includes(v.route_source as null | string)
    || !(v.route_generation === null || int(v.route_generation))
    || !(v.previous_decision === null || decisions.includes(v.previous_decision))
    || !(v.previous_generation === null || int(v.previous_generation))
    || typeof v.history_incomplete !== 'boolean' || !Array.isArray(v.history) || v.history.length > 10
    || v.history.some(h => !record(h) || !int(h.generation) || !decisions.includes(h.decision) || !Object.hasOwn(REASONS, String(h.reason_code)) || !date(h.at) || !hash(h.input_hash))
    || !(v.pending_action === null || record(v.pending_action) && actions.includes(v.pending_action.kind)
      && typeof v.pending_action.remove_needs === 'boolean' && typeof v.pending_action.clear_hold === 'boolean')) {
    throw new Error('分流状态字段损坏，需要人工恢复');
  }
  return { state: v as unknown as TriageState, id: rows[0]!.id };
}

export function stateBody(state: TriageState): string {
  return `${STATE_MARKER}\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n\nagent-control Issue 分流：${state.decision ?? '待评估'} · ${REASONS[state.reason_code]}`;
}

export function claimBody(claim: ClaimState): string {
  return `${CLAIM_MARKER}\n\`\`\`json\n${JSON.stringify(claim)}\n\`\`\``;
}

export function readClaims(comments: IssueComment[], login: string): (ClaimState & { comment_id: number; created_at: string })[] {
  return readClaimMarkers(comments, login).filter(c => !c.released);
}

export function readClaimMarkers(comments: IssueComment[], login: string): (ClaimState & { comment_id: number; created_at: string })[] {
  return comments.filter(c => c.body.startsWith(CLAIM_MARKER)).map(c => {
    if (c.author !== login) throw new Error('分流认领评论作者不可信');
    const v = markerJson(c.body, CLAIM_MARKER);
    if (!record(v) || typeof v.id !== 'string' || typeof v.owner !== 'string' || typeof v.released !== 'boolean') throw new Error('分流认领格式损坏');
    return { id: v.id, owner: v.owner, released: v.released, comment_id: c.id, created_at: c.createdAt };
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.comment_id - b.comment_id);
}

export function inputComments(comments: IssueComment[], login: string): IssueComment[] {
  return comments.filter(c => c.authorType !== 'Bot' && !(c.author === login && (
    c.body.startsWith('agent-control:') || c.body.startsWith(STATE_MARKER) || c.body.startsWith(CLAIM_MARKER)
  )))
    .sort((a, b) => a.id - b.id);
}

export function inputHash(issue: IssueData, comments: IssueComment[], login: string): string {
  const human = inputComments(comments, login).map(c => ({ id: c.id, author: c.author, body: c.body.replace(/\r\n/g, '\n') }));
  return createHash('sha256').update(JSON.stringify({ title: issue.title, body: issue.body.replace(/\r\n/g, '\n'), comments: human })).digest('hex');
}

export function parseDecision(text: string): { decision: Decision; reason_code: ReasonCode } {
  const v: unknown = JSON.parse(text);
  if (!record(v) || Object.keys(v).sort().join(',') !== 'decision,reason_code' || !decisions.includes(v.decision)
    || !Object.hasOwn(REASONS, String(v.reason_code)) || v.decision === 'AUTO' && v.reason_code !== 'clear_in_scope') throw new Error('invalid_output');
  return v as unknown as { decision: Decision; reason_code: ReasonCode };
}

export function initialState(claim: string): TriageState {
  return { version: 1, generation: 1, claim_id: claim, decision: null, reason_code: 'human_requested', input_hash: null,
    base_sha: null, model: null, at: new Date().toISOString(), defer_until: null, route_source: null,
    route_input_hash: null, route_generation: null, previous_decision: null, previous_generation: null,
    pending_action: null, history: [], history_incomplete: false };
}

export function nextState(previous: TriageState, claim: string, recordHistory = true): TriageState {
  const history = [...previous.history];
  if (recordHistory && previous.decision) history.push({ generation: previous.generation, decision: previous.decision, reason_code: previous.reason_code, at: previous.at, input_hash: previous.input_hash });
  return { ...previous, generation: previous.generation + 1, claim_id: claim,
    previous_decision: previous.decision, previous_generation: previous.generation,
    route_source: null, route_input_hash: null, route_generation: null, history: history.slice(-10), at: new Date().toISOString() };
}

export function visibleStatus(issue: IssueData, state: TriageState | null, now = Date.now()): TriageItem['status'] {
  if (issue.labels.includes(HUMAN_HOLD) || issue.labels.includes(NEEDS_HUMAN) || state?.decision === 'HUMAN' && state.route_source !== 'human') return 'human';
  if (state?.pending_action || !state?.input_hash) return 'pending';
  if (state.decision === 'DEFER') return state.defer_until && Date.parse(state.defer_until) <= now ? 'pending' : 'deferred';
  if (state.decision === 'SKIP') return 'skipped';
  return state.decision === 'AUTO' ? 'pending' : 'human';
}
