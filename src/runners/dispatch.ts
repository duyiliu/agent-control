import type { AppConfig } from '../types.js';
import { runCodex } from './codex.js';
import { runPi } from './pi.js';
import type { AgentCallOpts, AgentCallResult } from './types.js';

export type AgentRunner = (opts: AgentCallOpts, cfg: AppConfig['agent']) => Promise<AgentCallResult>;

export function pickRunner(cfg: AppConfig['agent']): AgentRunner {
  return cfg.provider === 'codex' ? runCodex : runPi;
}
