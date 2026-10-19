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
- `agent.provider` selects the runner (`runners/{pi,codex}.ts`, dispatch via
  `runners/dispatch.ts`): pi confines via tool allowlist (review = read-only
  tools, no bash/edit/write), codex via `-s` sandbox. `review_provider`/
  `review_model` may run the reviewer on a different (heterogeneous)
  runner+model. `agent.model` is required — no implicit model default;
  `reasoning_effort` is optional (unset = runner default). Shared call
  shape `AgentCallOpts`/`AgentCallResult`; all children get the scrubbed env.
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
- Container isolation (`isolation: docker`, `runners/container.ts`): the host
  worktree stays the single source of truth — `.git` is never uploaded, the
  container only ever mutates the volume copy, and changes become real only
  via syncDown + host-side `commitLeftovers`. Runner auth reaches the
  container as whitelisted files (pi: `~/.pi/agent` regular files; codex:
  `auth.json`+`config.toml`) moved into home by the image entrypoint — model
  keys travel by file, never env; GitHub credentials never enter at all.
  Session volumes/containers are run-scoped and always torn down
  (`ac-wt-*/ac-ac-*` removed; only `ac-cache` persists). Container-isolated
  recovery adds `findContainerStrays` — a dead docker.exe does not imply a
  dead container.

## Commands

- `npm run ac -- doctor` — env/config check (also probes docker/image when any project uses `isolation: docker`)
- `npm test` / `npm run typecheck`
- `AC_SMOKE_HOST=tcp://<daemon>:2375 npx tsx tests/integration/container.smoke.ts` — real-daemon container smoke (needs the image from `docker/Dockerfile`)
