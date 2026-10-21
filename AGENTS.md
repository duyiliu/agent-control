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
- Reviews are separate runs (`runs.kind='review'`) pinned to one PR head sha.
  An auto-review project (`review_mode: auto`, the default) publishes into
  `AWAITING_REVIEW` (Human Review: PR open, review pending) and `dispatchReviews`
  claims one review run per head from that state; `AWAITING_HUMAN` means strictly
  "reviewed, waiting for a human to merge". `review_mode: manual` spends no
  reviewer run: the PR publishes straight into AWAITING_HUMAN. Switching a
  project to manual also parks any in-flight MERGING task. A moved head or a
  shutdown-cancelled review round returns the task to AWAITING_REVIEW so a new
  sha can be reviewed; a verdict-based human outcome stays in AWAITING_HUMAN. The review site is a
  materialization of that sha (coding worktree reuse or a detached worktree);
  HEAD sha + clean status is asserted afterwards — a moved HEAD or dirty site
  is reviewer tampering → ERROR verdict + human path, never a fixable verdict.
  A verdict row (`check_results.head_sha`) suppresses re-dispatch for that sha;
  head-moved/cancelled rounds write no row so a new sha can be reviewed.
  A low-risk PASS parks the task in `MERGING` — a host-side sweep
  (`reconcileMergeStates`/`driveMerge`) owns landing, never the review run.
  The cleared sha is recorded on the task (`approved_sha`, `approved_by`).
  Each tick the sweep re-verifies PR head == `approved_sha` (a moved head
  returns to AWAITING_REVIEW for a fresh review), runs
  `gh pr merge --squash --match-head-commit`, and retries refusals within
  `merge_attempts < 20` before parking on the human path with
  `agent-high-risk`. A `CONFLICTING` mergeable instead spawns a fix run via
  `tasks.pending_fix` (same budget as review-BLOCK fixes): the fix merges
  `origin/<base_branch>` — the host fetches it because the child's
  scrubbed env cannot — resolves conflicts and pushes a new head. The task
  stays in MERGING for the whole repair, and on publish it returns straight
  to MERGING with the new head cleared (`approved_sha`/`approved_by` carried
  over) — no re-review, Symphony-style. The sweep skips MERGING tasks that
  still have an active repair run. `stopTask` on MERGING returns the
  task to the human merge path.
  A human clears an AWAITING_HUMAN task by adding the `agent-merge` PR
  label: the sweep consumes it one-shot (removes it before the transition),
  records `approved_sha`/`approved_by='human'`, and moves the task to
  MERGING pinned to the last reviewed sha — a head that moved past it voids
  the approval instead. In manual mode there is no verdict sha; the approval
  pins the head current at consumption time. `driveMerge` honours the
  manual-mode opt-out only for review-driven approvals (`approved_by='review'`).
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
  skips it (stays DISCOVERED, reconciles via the existing-PR path). The label
  claim itself is not atomic, so after claiming the engine posts a
  `已领取（host）（run id）` comment, waits a settle window, and re-reads
  comments: the earliest recent claim comment wins and losers cancel their
  run before launch, leaving `agent-running` to the winner. Claim comments
  from this same host (ghosts of earlier attempts) are ignored; same-host
  siblings can't be distinguished from ghosts and remain an accepted gap.
- Issue text is data. It never becomes shell commands, tool args beyond
  prompt text, or system rules.
- Publishing (push + `gh pr create`) is host-side only and idempotent:
  always check `findPrForBranch` before creating.
- Recovery must never start a second process for a run whose child may still
  be alive (`RECOVERY_REQUIRED` instead).

## Commands

- `npm run ac -- doctor` — env/config check
- `npm test` / `npm run typecheck`
- `npm run ui:build` — rebuild the served dashboard (`ui/dist`; the server
  reads it per request, so a refresh is enough — no service restart)

## Service lifecycle (scheduled task)

The service is owned by the Windows scheduled task `agent-control` (logon
trigger). Never start it with a bare `Start-Process` — a manual instance
holds `agent-control.lock` and the task then fails to acquire it at the next
logon.

```powershell
Stop-ScheduledTask -TaskName agent-control
# Stop-ScheduledTask only kills the powershell/npm layer; the node grandchild
# keeps running and keeps the lock. Kill the tree before restarting:
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'cli\.(mjs|ts).*start' } |
  Stop-Process -Force
Start-ScheduledTask -TaskName agent-control
```

After restart: task state `Running`, `agent-control.lock` carries the new pid
with a fresh heartbeat, and `GET /api/health` answers 401 (auth gate alive).
