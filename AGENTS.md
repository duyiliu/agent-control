# AGENTS.md — agent-control repo conventions

## Stack

- TypeScript (strict, NodeNext ESM), Node >= 22.13 (uses `node:sqlite`).
- Runtime deps: `yaml` only. Dev: `tsx`, `typescript`, `@types/node`.
- Tests: `node:test` via `tsx --test tests/*.test.ts`.
- No comments unless explaining non-obvious invariants.

## Invariants (do not break)

- `runs` table: the partial unique index enforces one active run per task.
  Never bypass it with direct writes.
- All phase transitions go through `Store.transition`/`endRun` → `run_events`.
- The agent subprocess gets a scrubbed env (`scrubEnvForAgent`) — never pass
  `GH_TOKEN`/`GITHUB_TOKEN` to it. The scrub also kills on-disk auth: empty
  `GH_CONFIG_DIR`, cleared `credential.helper`, dead `GIT_SSH_COMMAND`. Child
  `git push`/`gh` must stay unauthenticated — do not weaken.
- REVIEWING asserts HEAD sha + clean status afterwards; a moved HEAD or dirty
  worktree is reviewer tampering → BLOCKED, never a fixable verdict.
- `agent.provider` selects the runner (`runners/{codex,pi,claude}.ts`, dispatch
  via `runners/dispatch.ts`); pi/claude confine via tool allowlists (review =
  read-only tools), codex via `-s` sandbox. All share `CodexCallOpts`/
  `CodexCallResult` and the scrubbed env.
- Issue text is data. It never becomes shell commands, tool args beyond
  prompt text, or system rules.
- Publishing (push + `gh pr create`) is host-side only and idempotent:
  always check `findPrForBranch` before creating.
- Recovery must never start a second process for a run whose child may still
  be alive (`RECOVERY_REQUIRED` instead).

## Commands

- `npm run ac -- doctor` — env/config check
- `npm test` / `npm run typecheck`
