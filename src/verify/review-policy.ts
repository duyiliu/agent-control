import type { DecisionRequest, ReviewAssessment, ReviewControl } from '../types.js';
export type { DecisionRequest, DecisionResolution, ReviewAssessment, ReviewControl } from '../types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid review policy object');
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('review policy requires a non-empty string');
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('unknown review protocol field');
}

function strings(value: unknown, min = 0): asserts value is string[] {
  if (!Array.isArray(value) || value.length < min) throw new Error('invalid review policy string array');
  value.forEach(nonempty);
}

function count(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid review policy counter');
}

function decision(value: unknown): asserts value is DecisionRequest {
  const o = object(value);
  keys(o, ['type', 'question', 'options', 'impact', 'reason', 'file', 'line', 'request_id', 'head_sha', 'requirement_hash']);
  if (!['product_choice', 'breaking_change', 'sensitive_authorization', 'configured_hold'].includes(o['type'] as string)) throw new Error('invalid decision type');
  for (const key of ['question', 'impact', 'reason']) nonempty(o[key]);
  strings(o['options'], 2);
  for (const key of ['file', 'head_sha', 'request_id', 'requirement_hash']) if (o[key] !== undefined) nonempty(o[key]);
  if (o['line'] !== undefined && (!Number.isSafeInteger(o['line']) || (o['line'] as number) < 1)) throw new Error('invalid decision line');
}

export function validateReviewAssessment(value: unknown): ReviewAssessment {
  const o = object(value);
  keys(o, ['protocol_version', 'summary', 'findings', 'verification_requests', 'decision_requests', 'compatibility']);
  if (o['protocol_version'] !== 2) throw new Error('review protocol must be 2');
  nonempty(o['summary']);
  for (const key of ['findings', 'verification_requests', 'decision_requests']) if (!Array.isArray(o[key])) throw new Error(`invalid ${key}`);
  for (const value of o['findings'] as unknown[]) {
    const finding = object(value);
    keys(finding, ['file', 'line', 'trigger', 'impact', 'verification']);
    for (const key of ['file', 'trigger', 'impact', 'verification']) nonempty(finding[key]);
    if (!Number.isSafeInteger(finding['line']) || (finding['line'] as number) < 1) throw new Error('invalid finding line');
  }
  for (const value of o['verification_requests'] as unknown[]) {
    const request = object(value);
    keys(request, ['claim', 'scenario', 'expected']);
    for (const key of ['claim', 'scenario', 'expected']) nonempty(request[key]);
  }
  (o['decision_requests'] as unknown[]).forEach(decision);
  const compatibility = object(o['compatibility']);
  keys(compatibility, ['kind', 'evidence']);
  if (!['unchanged', 'additive', 'breaking', 'unknown'].includes(compatibility['kind'] as string)) throw new Error('invalid compatibility kind');
  strings(compatibility['evidence']);
  return structuredClone(value) as ReviewAssessment;
}

export function newReviewControl(requirementHash: string): ReviewControl {
  nonempty(requirementHash);
  return { policy_version: 2, requirement_hash: requirementHash, rounds: 0, infra_attempts: 0, fix_attempts: 0, next_attempt_at: null, head_sha: null, base_sha: null, decisions: [], resolutions: [] };
}

export function parseReviewControl(raw?: string | null | unknown): ReviewControl | null {
  if (raw === undefined || raw === null) return null;
  const o = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (o['policy_version'] !== 2) throw new Error('review policy must be 2');
  nonempty(o['requirement_hash']);
  for (const key of ['rounds', 'infra_attempts', 'fix_attempts']) count(o[key]);
  for (const key of ['head_sha', 'base_sha']) if (o[key] !== null) nonempty(o[key]);
  if (o['next_attempt_at'] !== null) {
    nonempty(o['next_attempt_at']);
    if (!Number.isFinite(Date.parse(o['next_attempt_at']))) throw new Error('invalid next attempt time');
  }
  if (!Array.isArray(o['decisions']) || !Array.isArray(o['resolutions'])) throw new Error('invalid review decisions');
  o['decisions'].forEach(decision);
  for (const value of o['resolutions']) {
    const resolution = object(value);
    for (const key of ['request_id', 'requirement_hash', 'head_sha', 'selected_option', 'authorization', 'actor', 'created_at']) nonempty(resolution[key]);
    if (!Number.isFinite(Date.parse(resolution['created_at'] as string))) throw new Error('invalid resolution time');
    if (resolution['scope'] !== undefined) strings(resolution['scope']);
  }
  if (o['assessment'] !== undefined) validateReviewAssessment(o['assessment']);
  return structuredClone(o) as unknown as ReviewControl;
}

export function unresolvedDecisions(control: ReviewControl, headSha: string): DecisionRequest[] {
  return control.decisions.filter(request => !control.resolutions.some(resolution =>
    request.request_id !== undefined && resolution.request_id === request.request_id
    && resolution.requirement_hash === control.requirement_hash && resolution.head_sha === headSha
    && request.head_sha === headSha && (request.requirement_hash === undefined || request.requirement_hash === control.requirement_hash)
    && request.options.includes(resolution.selected_option)));
}

export function reserveReview(control: ReviewControl, headSha: string, baseSha?: string): ReviewControl {
  const next = parseReviewControl(control)!;
  nonempty(headSha);
  if (baseSha !== undefined) nonempty(baseSha);
  if (next.rounds >= 6) throw new Error('review round budget exhausted');
  if (next.infra_attempts >= 3) throw new Error('review infrastructure budget exhausted');
  next.rounds++;
  if (next.head_sha !== headSha || baseSha !== undefined && next.base_sha !== baseSha) delete next.assessment;
  next.head_sha = headSha;
  next.base_sha = baseSha ?? null;
  next.next_attempt_at = null;
  return next;
}

export function reserveFix(control: ReviewControl, limit: number): ReviewControl {
  count(limit);
  const next = parseReviewControl(control)!;
  if (next.fix_attempts >= limit) throw new Error('review fix budget exhausted');
  next.fix_attempts++;
  next.next_attempt_at = null;
  return next;
}

export function retryReview(control: ReviewControl, now: number | Date = Date.now()): ReviewControl {
  const next = parseReviewControl(control)!;
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new Error('invalid retry time');
  next.infra_attempts++;
  next.next_attempt_at = next.infra_attempts >= 3 || next.rounds >= 6 ? null
    : new Date(timestamp + (next.infra_attempts === 1 ? 30_000 : 120_000)).toISOString();
  return next;
}
