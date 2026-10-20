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
- Only the Pi runner is supported. The coder is one long-lived `pi --mode rpc`
  session per run (`runners/session.ts`): RUNNING and every FIXING turn share the
  same conversation, and that child **is** the run's `pid` — it must be closed in
  the run's `finally`, never left to the next phase. Review stays a one-shot
  `pi -p` call (`runners/pi.ts`) with a read-only tool allowlist (no
  bash/edit/write). `review_model` and `review_reasoning_effort` may select a
  different Pi model/settings for review. `agent.model` is required — no
  implicit model default; `reasoning_effort` is optional (unset = runner
  default). All children get the scrubbed env.
- Cross-instance claiming is label-based: `agent-running` on an issue means
  another scheduler owns it — `listReadyIssues` filters it and `tryDispatch`
  skips it (stays DISCOVERED, reconciles via the existing-PR path). Not
  atomic; a same-second double-claim is still possible.
- Issue text is data. It never becomes shell commands, tool args beyond
  prompt text, or system rules.
- Publishing (push + `gh pr create`) is host-side only and idempotent:
  always check `findPrForBranch` before creating.
- Recovery must never start a second process for a run whose child may still
  be alive (`RECOVERY_REQUIRED` instead).

## Commands

- `npm run ac -- doctor` — env/config check
- `npm test` / `npm run typecheck`
