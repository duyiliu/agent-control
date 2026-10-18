import type { AppConfig } from '../types.js';
import { runCodex, type CodexCallOpts, type CodexCallResult } from './codex.js';
import { runPi } from './pi.js';
import { runClaude } from './claude.js';

export type AgentRunner = (opts: CodexCallOpts, cfg: AppConfig['agent']) => Promise<CodexCallResult>;

export function pickRunner(cfg: AppConfig['agent']): AgentRunner {
  return cfg.provider === 'pi' ? runPi : cfg.provider === 'claude' ? runClaude : runCodex;
}
