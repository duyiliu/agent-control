import type { ProcResult } from '../proc.js';
import type { AppConfig } from '../types.js';
import type { ContainerSession } from './container.js';

/**
 * Shared call contract for agent runners. Providers take the fields they use:
 * `sandbox`/`schemaPath` are codex-only; `tools` is pi-only (codex confines
 * via `-s` instead). Extra fields are ignored by runners that don't need them.
 * `session` selects container-isolated execution: when set, the runner runs
 * its argv inside the session container and `workdir` is the mapped /work.
 */
export interface AgentCallOpts {
  workdir: string;
  prompt: string;
  timeoutMs: number;
  logPath?: string;
  lastMessagePath: string;
  model?: string;
  /** codex only: `-s` confinement level. */
  sandbox?: AppConfig['agent']['sandbox'];
  /** codex only: `--output-schema` file for structured final output. */
  schemaPath?: string;
  /** pi only: tool allowlist — its confinement primitive. */
  tools?: string[];
  /** When set, execute inside this container session instead of on the host. */
  session?: ContainerSession;
  signal?: AbortSignal;
  /** Called with the child PID and a pid:startMs identity token at spawn. */
  onSpawn?: (pid: number | null, identity: string | null) => void;
}

export interface AgentCallResult extends ProcResult {
  pid: number | null;
}
