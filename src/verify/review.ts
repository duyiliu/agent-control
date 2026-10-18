import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickRunner } from '../runners/dispatch.js';
import { CLAUDE_REVIEW_TOOLS } from '../runners/claude.js';
import { PI_REVIEW_TOOLS } from '../runners/pi.js';
import { REVIEW_SCHEMA, buildReviewPrompt, type PromptContext } from '../scheduler/prompts.js';
import type { AppConfig, ReviewResult } from '../types.js';

/** The review PROCESS failed (exit/timeout/spawn) — not a code verdict. */
export class ReviewInfraError extends Error {}

export interface ReviewDeps {
  agentConfig: AppConfig['agent'];
  timeoutMs: number;
  artifactsDir: string;
  signal?: AbortSignal;
  onSpawn?: (pid: number | null, identity: string | null) => void;
}

/**
 * Independent read-only review session. The verdict must be produced as
 * structured JSON via --output-schema; an unparseable/absent verdict is
 * treated as a non-pass (BLOCK).
 */
export async function runReview(
  ctx: PromptContext,
  testEvidence: string,
  diffEvidence: string,
  deps: ReviewDeps,
): Promise<{ result: ReviewResult; logPath: string }> {
  mkdirSync(deps.artifactsDir, { recursive: true });
  const schemaPath = join(deps.artifactsDir, 'review-schema.json');
  const lastMsgPath = join(deps.artifactsDir, 'review-last-message.txt');
  const logPath = join(deps.artifactsDir, 'review-codex.jsonl');
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA), 'utf8');

  // pi/claude confine the reviewer by tool allowlist (read-only); codex by sandbox.
  // review_provider/review_model may select a different (ideally heterogeneous)
  // runner+model for review than the coder used.
  const agentConfig: AppConfig['agent'] = deps.agentConfig.review_provider
    ? { ...deps.agentConfig, provider: deps.agentConfig.review_provider, model: deps.agentConfig.review_model }
    : deps.agentConfig;
  const runner = pickRunner(agentConfig);
  const reviewTools =
    agentConfig.provider === 'pi' ? PI_REVIEW_TOOLS
    : agentConfig.provider === 'claude' ? CLAUDE_REVIEW_TOOLS
    : undefined;
  const callReview = () =>
    runner(
      {
        workdir: ctx.worktreePath,
        prompt: buildReviewPrompt(ctx, testEvidence, diffEvidence),
        sandbox: agentConfig.review_sandbox,
        timeoutMs: deps.timeoutMs,
        logPath,
        schemaPath,
        lastMessagePath: lastMsgPath,
        tools: reviewTools,
        signal: deps.signal,
        onSpawn: deps.onSpawn,
      },
      agentConfig,
    );

  let proc = await callReview();
  // One retry for transient infra failures (e.g. model-list refresh timeouts).
  if (!proc.aborted && (proc.exitCode !== 0 || proc.timedOut)) {
    await new Promise((r) => setTimeout(r, 10_000));
    proc = await callReview();
  }

  if (proc.aborted) {
    return { result: { verdict: 'BLOCK', summary: 'review aborted (cancelled)', findings: [] }, logPath };
  }
  if (proc.timedOut) {
    throw new ReviewInfraError(`review timed out after ${deps.timeoutMs}ms`);
  }
  if (proc.exitCode !== 0) {
    throw new ReviewInfraError(`review process exited ${proc.exitCode}: ${proc.stderrTail.slice(-2000)}`);
  }
  if (!existsSync(lastMsgPath)) {
    return { result: { verdict: 'BLOCK', summary: 'review produced no structured output', findings: [] }, logPath };
  }
  try {
    const parsed = parseVerdictJson(readFileSync(lastMsgPath, 'utf8')) as {
      verdict?: string;
      summary?: string;
      findings?: string[];
    };
    if (parsed.verdict !== 'PASS' && parsed.verdict !== 'BLOCK' && parsed.verdict !== 'HUMAN_REVIEW_REQUIRED') {
      return { result: { verdict: 'BLOCK', summary: `unparseable verdict: ${String(parsed.verdict)}`, findings: [] }, logPath };
    }
    return {
      result: {
        verdict: parsed.verdict,
        summary: parsed.summary ?? '',
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
      },
      logPath,
    };
  } catch {
    return { result: { verdict: 'BLOCK', summary: 'review output was not valid JSON', findings: [] }, logPath };
  }
}

/**
 * Parse the verdict JSON from the reviewer's last message. codex's
 * --output-schema yields clean JSON; prompt-level runners may wrap it in
 * fences or prose, so strip those before failing as unparseable.
 */
function parseVerdictJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch { /* fall through to object extraction */ }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  return JSON.parse(stripped); // throws with the original-shaped error
}
