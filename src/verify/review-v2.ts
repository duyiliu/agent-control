import type { ReviewResult } from '../types.js';
import type { ReviewAssessment } from './review-policy.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 8000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const line = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 10_000_000;
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const list = (value: unknown, check: (item: unknown) => boolean) => Array.isArray(value) && value.length <= 200 && value.every(check);

export function parseReviewV2(output: string): ReviewResult {
  const value: unknown = JSON.parse(output.trim());
  if (!record(value) || !keys(value, ['protocol_version', 'summary', 'findings', 'verification_requests', 'decision_requests', 'compatibility'])
    || value.protocol_version !== 2 || !text(value.summary)
    || !list(value.findings, f => record(f) && keys(f, ['file', 'line', 'trigger', 'impact', 'verification']) && text(f.file, 2000) && line(f.line) && text(f.trigger) && text(f.impact) && text(f.verification))
    || !list(value.verification_requests, r => record(r) && keys(r, ['claim', 'scenario', 'expected']) && text(r.claim) && text(r.scenario) && text(r.expected))
    || !list(value.decision_requests, r => record(r) && keys(r, ['type', 'question', 'options', 'impact', 'reason'], ['file', 'line'])
      && typeof r.type === 'string' && ['product_choice', 'breaking_change', 'sensitive_authorization', 'configured_hold'].includes(r.type)
      && text(r.question) && Array.isArray(r.options) && r.options.length >= 2 && r.options.length <= 10 && r.options.every(o => text(o, 2000))
      && new Set(r.options).size === r.options.length && text(r.impact) && text(r.reason)
      && (r.file === undefined || text(r.file, 2000)) && (r.line === undefined || (r.file !== undefined && line(r.line))))
    || !record(value.compatibility) || !keys(value.compatibility, ['kind', 'evidence'])
    || typeof value.compatibility.kind !== 'string' || !['unchanged', 'additive', 'breaking', 'unknown'].includes(value.compatibility.kind)
    || !Array.isArray(value.compatibility.evidence) || !list(value.compatibility.evidence, e => text(e)) || value.compatibility.evidence.length === 0) {
    throw new Error('expected complete review protocol v2 with concrete findings, verification requests, decisions and compatibility evidence');
  }
  return assessmentResult(value as unknown as ReviewAssessment);
}

export function assessmentResult(assessment: ReviewAssessment): ReviewResult {
  const verdict = assessment.decision_requests.length ? 'HUMAN_REVIEW_REQUIRED'
    : assessment.findings.length || assessment.verification_requests.length || ['unknown', 'breaking'].includes(assessment.compatibility.kind) ? 'BLOCK' : 'PASS';
  return { verdict, risk: 'low', summary: assessment.summary,
    findings: assessment.findings.map(f => `${f.file}:${f.line}: ${f.trigger}; ${f.impact}; 验证: ${f.verification}`), assessment };
}

export function mergeReviewAssessments(results: ReviewResult[]): ReviewResult {
  const assessments = results.map(r => r.assessment);
  if (assessments.some(a => !a)) throw new Error('missing v2 part assessment');
  const all = assessments as ReviewAssessment[];
  const unique = <T>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
  const kinds = all.map(a => a.compatibility.kind);
  const kind = kinds.includes('breaking') ? 'breaking' : kinds.includes('unknown') ? 'unknown' : kinds.includes('additive') ? 'additive' : 'unchanged';
  return assessmentResult({ protocol_version: 2, summary: all.map((a, i) => `评审 ${i + 1}: ${a.summary}`).join('\n'),
    findings: unique(all.flatMap(a => a.findings)), verification_requests: unique(all.flatMap(a => a.verification_requests)),
    decision_requests: unique(all.flatMap(a => a.decision_requests)), compatibility: { kind, evidence: unique(all.flatMap(a => a.compatibility.evidence)) } });
}
