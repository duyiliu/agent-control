import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pickRunner } from '../runners/dispatch.js';
import { PI_REVIEW_TOOLS } from '../runners/pi.js';
import type { AgentCallOpts, AgentCallResult } from '../runners/types.js';
import { REVIEW_SCHEMA, buildReviewPrompt, MAX_REVIEW_DIFF_CHARS, type PromptContext } from '../scheduler/prompts.js';
import type { AppConfig, ReviewResult } from '../types.js';

export class ReviewInfraError extends Error {
  constructor(message: string, readonly logPath?: string) { super(message); }
}

export interface ReviewDeps {
  agentConfig: AppConfig['agent'];
  timeoutMs: number;
  artifactsDir: string;
  signal?: AbortSignal;
  onSpawn?: (pid: number | null, identity: string | null) => void;
  headSha?: string;
}

type ReviewRunner = (opts: AgentCallOpts, config: AppConfig['agent']) => Promise<AgentCallResult>;

/** Output/protocol failures retry the reviewer, never the code being reviewed. */
export async function runReview(
  ctx: PromptContext,
  testEvidence: string,
  diffEvidence: string,
  deps: ReviewDeps,
  runner: ReviewRunner = (opts, config) => pickRunner(config)(opts, config),
): Promise<{ result: ReviewResult; logPath: string }> {
  mkdirSync(deps.artifactsDir, { recursive: true });
  const schemaPath = join(deps.artifactsDir, 'review-schema.json');
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA), 'utf8');
  const agentConfig: AppConfig['agent'] = {
    ...deps.agentConfig,
    provider: deps.agentConfig.review_provider ?? deps.agentConfig.provider,
    model: deps.agentConfig.review_model ?? deps.agentConfig.model,
    reasoning_effort: deps.agentConfig.review_reasoning_effort ?? deps.agentConfig.reasoning_effort,
  };
  const isPi = agentConfig.provider === 'pi';
  const cancelled = (logPath: string) => ({
    result: { verdict: 'HUMAN_REVIEW_REQUIRED', summary: 'review cancelled', findings: [] } as ReviewResult,
    logPath,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomUUID();
    const logPath = join(deps.artifactsDir, `review-agent-${id}.jsonl`);
    const lastMessagePath = join(deps.artifactsDir, `review-last-${id}.txt`);
    if (deps.signal?.aborted) return cancelled(logPath);
    if (diffEvidence.length > MAX_REVIEW_DIFF_CHARS || /\.\.\.\[truncated \d+ (?:chars|bytes)\]/.test(diffEvidence)) {
      const result: ReviewResult = { verdict: 'HUMAN_REVIEW_REQUIRED', summary: 'review diff is incomplete or too large; narrow the task or review manually', findings: [] };
      writeFileSync(logPath, JSON.stringify({ result }) + '\n', 'utf8');
      return { result, logPath };
    }
    const proc = await runner({
      workdir: ctx.worktreePath,
      prompt: buildReviewPrompt(ctx, testEvidence, diffEvidence, deps.headSha),
      sandbox: agentConfig.review_sandbox,
      timeoutMs: deps.timeoutMs,
      logPath,
      schemaPath: isPi ? undefined : schemaPath,
      lastMessagePath,
      tools: isPi ? PI_REVIEW_TOOLS : undefined,
      signal: deps.signal,
      onSpawn: deps.onSpawn,
    }, agentConfig);
    if (proc.aborted || deps.signal?.aborted) return cancelled(logPath);

    let failure: string;
    if (proc.timedOut || proc.exitCode !== 0) {
      failure = proc.timedOut
        ? `review timed out after ${deps.timeoutMs}ms`
        : `review process exited ${proc.exitCode}: ${proc.stderrTail.slice(-2000)}`;
      if (attempt === 0) {
        await sleep(10_000, undefined, { signal: deps.signal }).catch((err: unknown) => {
          if (!deps.signal?.aborted) throw err;
        });
        continue;
      }
    } else {
      try {
        if (!existsSync(lastMessagePath)) throw new Error('review produced no structured output');
        return { result: parseReviewResult(readFileSync(lastMessagePath, 'utf8')), logPath };
      } catch (err) {
        failure = `invalid review output: ${String(err)}`;
      }
    }
    if (attempt === 1) throw new ReviewInfraError(failure, logPath);
  }
  throw new ReviewInfraError('review did not complete');
}

function parseReviewResult(text: string): ReviewResult {
  const value = parseVerdictJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !['verdict', 'summary', 'findings'].includes(key))
    || typeof obj.verdict !== 'string' || !['PASS', 'BLOCK', 'HUMAN_REVIEW_REQUIRED'].includes(obj.verdict)
    || typeof obj.summary !== 'string' || !obj.summary.trim()
    || !Array.isArray(obj.findings) || obj.findings.some((finding) => typeof finding !== 'string' || !finding.trim())) {
    throw new Error('expected verdict, nonempty summary and string findings');
  }
  return { verdict: obj.verdict as ReviewResult['verdict'], summary: obj.summary, findings: obj.findings as string[] };
}

function parseVerdictJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch { /* invalid protocol output */ }
  throw new Error('review must contain a single JSON object');
}
