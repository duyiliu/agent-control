import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickRunner } from '../runners/dispatch.js';
import { PI_REVIEW_TOOLS } from '../runners/pi.js';
import type { ContainerSession } from '../runners/container.js';
import { REVIEW_SCHEMA, buildReviewPrompt, type PromptContext } from '../scheduler/prompts.js';
import type { AppConfig, ReviewResult } from '../types.js';

/** The review PROCESS failed (exit/timeout/spawn) — not a code verdict. */
export class ReviewInfraError extends Error {}

export interface ReviewDeps {
  agentConfig: AppConfig['agent'];
  timeoutMs: number;
  artifactsDir: string;
  /** When set, the reviewer runs inside this read-only container session. */
  session?: ContainerSession;
  signal?: AbortSignal;
  onSpawn?: (pid: number | null, identity: string | null) => void;
}

/**
 * Independent read-only review session. pi confines the reviewer via the
 * read-only tool allowlist (no bash/edit/write) with a prompt-level JSON
 * contract; codex confines via `-s` sandbox and gets hard schema enforcement
 * via --output-schema. An unparseable/absent verdict is a non-pass (BLOCK).
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
  const logPath = join(deps.artifactsDir, 'review-agent.jsonl');
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA), 'utf8');

  // review_provider/review_model may select a different (ideally heterogeneous)
  // runner+model for review than the coder used — decorrelates blind spots.
  const agentConfig: AppConfig['agent'] = {
    ...deps.agentConfig,
    provider: deps.agentConfig.review_provider ?? deps.agentConfig.provider,
    model: deps.agentConfig.review_model ?? deps.agentConfig.model,
    reasoning_effort: deps.agentConfig.review_reasoning_effort ?? deps.agentConfig.reasoning_effort,
  };
  const isPi = agentConfig.provider === 'pi';
  const callReview = () =>
    pickRunner(agentConfig)(
      {
        workdir: ctx.worktreePath,
        prompt: buildReviewPrompt(ctx, testEvidence, diffEvidence),
        sandbox: agentConfig.review_sandbox,
        timeoutMs: deps.timeoutMs,
        logPath,
        schemaPath: isPi ? undefined : schemaPath,
        lastMessagePath: lastMsgPath,
        tools: isPi ? PI_REVIEW_TOOLS : undefined,
        session: deps.session,
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
 * Parse the verdict JSON from the reviewer's last message. The prompt asks
 * for bare JSON, but the model may wrap it in fences or prose — strip those
 * before failing as unparseable.
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
