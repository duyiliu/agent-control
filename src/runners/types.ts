import type { ProcResult } from '../proc.js';

export interface AgentCallOpts {
  workdir: string;
  prompt: string;
  timeoutMs: number;
  logPath?: string;
  lastMessagePath: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  signal?: AbortSignal;
  onSpawn?: (pid: number | null, identity: string | null) => void;
}

export interface AgentCallResult extends ProcResult {
  pid: number | null;
}
