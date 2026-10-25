# AGENTS.md — agent-control repo conventions

## Stack

- TypeScript (strict, NodeNext ESM), Node >= 22.13 (uses `node:sqlite`).
- Runtime deps: `yaml` only. Dev: `tsx`, `typescript`, `@types/node`.
- Tests: `node:test` via `tsx --test tests/*.test.ts`.
- No comments unless explaining non-obvious invariants.

## Invariants (do not break)

- Issue #6 workflow is opt-in per project (`workflow_mode: github`, the config
  default). `tasks.issue_workflow_json` pins it per task at creation; NULL keeps
  every pre-upgrade task on the legacy path forever, and a project default never
  reinterprets an existing task. The seven labels `Backlog`/`Todo`/`In Progress`/
  `Human Review`/`Rework`/`Merging`/`Done` are the only Issue business state;
  SQLite phases remain execution records. Backlog never dispatches; only Todo or
  an already-claimed In Progress run may code. Default `review_mode` in this mode
  is `manual`: a single coder session implements, self-checks and publishes, and
  no reviewer run is required. A handoff binds the published PR to its head/base,
  requirement hash and generation; host checks stay recorded for the dashboard
  but do not gate the handoff, so a project without configured checks still
  reaches Human Review. A failed Ready operation is recorded as a diagnostic,
  not as a missing scope. `Human Review -> Merging/Rework` requires either the newest
  labelled event after the handoff by a non-bot actor with repo write permission
  who is not the host's authenticated login, or a token-authenticated board
  approval bound to the same head/base/requirement hash/generation. Bots, host
  identity, stale events, PR `agent-merge` and AI PASS never authorize. Merge
  rechecks the event or board approval, permission, issue hash/holds, task
  version, PR head/base and the PR CI rollup (an empty rollup proves nothing),
  then uses non-admin `--match-head-commit` (branch protection remains GitHub's
  own gate); Done
  and issue close happen only after observing MERGED, and a half-finished Done
  is completed by the next tick.
  Rework closes the old PR without deleting its branch/worktree, starts the next
  generation from the freshly fetched remote base with a new branch, worktree
  and Pi session, and records the old generation in the workflow history. Every
  workflow generation, including generation 1, uses `agent/issue-N-rG`; legacy
  `agent/issue-N` branches/PRs stay untouched history and are never reused.
  Corrupt workflow JSON, missing/conflicting labels and event-read failures fail
  closed; no new business Blocked state exists. A workflow project provisions
  exactly the seven state labels and nothing else: no `ready_label`, no
  `agent-running`, no `agent-human-hold`/`agent-needs-human`, no legacy signals
  and no `agent-complex`. `Backlog` is the only human gate; external blockers
  are expressed by moving the Issue to `Human Review` with a reason comment.
  Execution state (Running/Retrying/Recovering) and duplicate-run prevention
  live only in agent-control: the SQLite one-active-run index is the lock.
  The dashboard renders `workflow_state` as the business state and the phase /
  active run as execution status. It is a token-authenticated human channel: it
  may move Backlog/Todo/Human Review/Rework/Merging by writing the label and,
  for Merging/Rework, records a scope-bound board approval. It never offers the
  legacy approve/retry/rereview actions for a workflow task; `stop` only
  cancels an in-flight run.
  Workflow tasks write no claim label and no claim comment to GitHub. Legacy tasks keep their old label
  semantics; the cleanup command may delete those labels from the repo, which
  freezes legacy dispatch by design.

- Review policy v2 is opt-in (`review_policy.version: 2`) and pinned in
  `tasks.review_control_json` for new tasks. Existing tasks stay legacy until
  explicit rereview. The legacy high-risk/size and conflict-approval rules below
  apply only to legacy tasks. In v2, structured findings and verification requests
  go to bounded AI repair; concrete decision requests require scoped human answers.
  Reviewer `high`, contract version and change size alone do not require a human.
  `human_review_paths` match the full diff, including generated and documentation
  paths; never apply their gate to an already filtered diff.
  Each requirement version shares 6 review rounds, 3 infrastructure failures and
  `retry_limit` repairs. Counters are reserved with the claim in a transaction.
  Recovery of an interrupted v2 review records ERROR and retries through dispatch
  with backoff; it never resumes that review run outside the persistent budget.
  Explicit human retry/rereview renews the budget with an event and retains history
  and unresolved evidence for the same SHA. Every new head (including conflict
  repair) voids approval and must be reviewed again. Before landing, independently
  recheck current issue/hash/holds, task version, head/base, guarded checks and
  unresolved findings/decisions. Merge labels cannot answer decision requests.
  Answers bind request id, requirement hash and head SHA. A refusal cannot be
  replaced by ordinary merge approval or budget renewal. Bare PRs stay advisory.
  Closed issues with no merged PR are CANCELED, preserving explicit dispositions.
  Schema v12 requires matching code: rollback means stop/drain, restore the
  pre-upgrade database/config backup, then run the matching old version. The Store
  rejects schemas newer than its supported version; never attach old code to v12.

- `runs` table: the partial unique index enforces one active run per task.
  Never bypass it with direct writes.
- All phase transitions go through `Store.transition`/`endRun` → `run_events`.
- The agent subprocess gets a scrubbed env (`scrubEnvForAgent`) — never pass
  `GH_TOKEN`/`GITHUB_TOKEN` to it. The scrub also kills on-disk auth: empty
  `GH_CONFIG_DIR`, cleared `credential.helper`, dead `GIT_SSH_COMMAND`. Child
  `git push`/`gh` must stay unauthenticated — do not weaken.
- Reviews are separate runs (`runs.kind='review'`) pinned to the PR head and
  base sha. The host fetches the base and builds the full diff against that
  exact base commit; a missing base sha is a human path. A moved base invalidates
  the prior review even when the PR head is unchanged.
  An auto-review project (`review_mode: auto`, the default) publishes into
  `AWAITING_REVIEW` (Human Review: PR open, review pending) and `dispatchReviews`
  claims one review run per head/base scope from that state; `AWAITING_HUMAN` means the PR
  is ready for human review or needs the stated human intervention. `review_mode: manual` spends no
  reviewer run: the PR publishes straight into AWAITING_HUMAN. Switching a
  project to manual also parks any in-flight MERGING task. A moved head or base
  returns auto-review tasks to AWAITING_REVIEW and Draft so the current scope is
  reviewed; manual-review tasks stay in AWAITING_HUMAN. A shutdown-cancelled
  review round returns the task to AWAITING_REVIEW; a verdict-based human outcome stays in AWAITING_HUMAN. The review site is a
  materialization of that sha (coding worktree reuse or a detached worktree);
  HEAD sha + clean status is asserted afterwards — a moved HEAD or dirty site
  is reviewer tampering → ERROR verdict + human path, never a fixable verdict.
  A verdict row (`check_results.head_sha`) suppresses re-dispatch for that sha;
  head-moved/cancelled rounds write no row so a new sha can be reviewed.
  `retryTask` drops the task's review verdict rows — without that, a task
  whose branch already has an OPEN PR re-enters `AWAITING_REVIEW` with an
  unchanged head and the sha idempotency strands it forever (it shows as
  "reviewing" and can never move). `dispatchReviews` parks such a stranded
  task in `BLOCKED` (retryable) instead of leaving it looking alive.
  AI PASS lands in one of two places. After validating current Issue
  authorization, human holds, cancellation, PR HEAD/base and non-empty passing
  SHA-bound host Checks, the host marks the Draft PR Ready and posts a handoff
  summary. With `approvals.auto_merge.enabled`, a v2 task then checks
  eligibility — no unresolved decisions (answered ones do not block), no
  findings/verification requests, no breaking/unknown compatibility, no
  guarded paths, no intake vetoes, `source='issue'`, and source-code diff
  under `max_files`/`max_lines` — and a qualifying PASS enters `MERGING`
  with `approved_by='review'`; everything else waits in AWAITING_HUMAN for a
  human `agent-merge` label, which records `approved_by='human'`. Missing
  checks or failed Ready operations leave the PR Draft with an actionable
  reason. `driveMerge` accepts either `approved_by`, rechecks Issue, task
  version, PR head/base, review decisions and guarded checks, then uses
  `--match-head-commit`.
  If an explicitly human-approved merge conflicts, `tasks.pending_fix` may queue
  a repair using the existing shared fix budget. The host fetches
  `<git_remote>/<base_branch>` because the child cannot authenticate; it clears
  the old approval and sends the repaired new HEAD back through Checks and Review.
  The human must approve that new reviewed SHA separately. `stopTask` on MERGING
  returns the task to the human merge path.
  A human approves an AWAITING_HUMAN task by adding the `agent-merge` PR
  label: the sweep consumes it one-shot (removes it before the transition),
  records `approved_sha`/`approved_by='human'`, and moves the task to
  MERGING pinned to the last reviewed sha — a head that moved past it voids
  the approval instead. In manual mode there is no verdict sha; the approval
  pins the current head at consumption time. `driveMerge` accepts
  `approved_by='human'` or `'review'` (the auto-merge path above).
- Only the Pi runner is supported. Each code Run owns one `pi --mode rpc`
  process (`runners/session.ts`): RUNNING and FIXING within that Run share the
  conversation; close the process in its `finally`. Across Runs, Issue coding
  and repair reuse the session ID and directory anchored to the first code Run.
  Each process remains separately logged and owned by its active Run. Session
  header/cwd ownership checks still apply; ambiguous or corrupt history parks
  safely rather than silently creating a cold session.
  Review stays a one-shot `pi -p` call (`runners/pi.ts`) with a read-only tool
  allowlist (no bash/edit/write) and stays ephemeral. `review_model` and
  `review_reasoning_effort` may select a different Pi model/settings for review.
  `agent.model` is required — no implicit model default; `reasoning_effort` is
  optional (unset = runner default). `agent.complex_model` /
  `agent.complex_reasoning_effort` apply only to tasks whose Issue carries the
  explicit `agent-complex` label; complexity is never inferred from issue text
  or diff size, and a missing complex setting falls back to the base coder
  settings. All children get the scrubbed env.
- 优雅停机挂起而非取消：`Engine.shutdown` 中止在途 run 并有界等待其
  `finally`/`session.close` 收尾；被切断的编码 run 保持原相位
  （记 `service_shutdown` 事件、`cancel_requested` 仍为 0、不摘
  `agent-running`），下次启动对账自动恢复。显式 `stop` 仍然落
  `CANCELED` 且优先于停机。被停机取消的评审轮次不写 verdict，任务回
  `AWAITING_REVIEW`。
- A PR with no issue behind it is still a review input (`pr_review`, default
  `auto`; `manual` reviews only `agent-review`-summoned PRs). Such a task has
  `source='pr'` and lands directly in `AWAITING_REVIEW` — never `DISCOVERED`,
  so it can never reach `tryDispatch`/the coder. Its verdict is advisory:
  post it on the PR and park the task where the state matches the verdict —
  PASS / HUMAN_REVIEW_REQUIRED → `AWAITING_HUMAN`, BLOCK → `BLOCKED` (author
  must change the PR). Never spawn a fix run, never queue a merge, and an
  `agent-merge` label is ignored. `retryTask` on a bare PR drops its review
  verdict rows and re-queues the same head for review — that is the only way
  back from an ERROR round or a stop. Discovery only registers
  PRs opened after `pr_review_since:<repo>` (seeded on first tick, so enabling
  the feature cannot queue a repo's backlog), skips drafts, forks (their head is
  not fetchable locally), `branch_prefix` branches (the task path already owns
  those heads) and other base branches, and registers at most `PR_REVIEW_BATCH`
  per tick. GitHub shares one number sequence between issues and PRs, which is
  why `tasks.issue_number` holds a PR number unchanged and `UNIQUE(repo,
  issue_number)` still holds.
- Legacy cross-instance claiming is label-based: `agent-running` on an issue means
  another scheduler owns it (workflow tasks do not use this label) — `listReadyIssues` filters it and `tryDispatch`
  skips it (stays DISCOVERED, reconciles via the existing-PR path). The label
  claim itself is not atomic, so after claiming the engine posts a
  `已领取（host）（run id）` comment, waits a settle window, and re-reads
  comments: the earliest recent claim comment wins and losers cancel their
  run before launch, leaving `agent-running` to the winner. Claim comments
  from this same host (ghosts of earlier attempts) are ignored; same-host
  siblings can't be distinguished from ghosts and remain an accepted gap.
- Issue text is data. It never becomes shell commands, tool args beyond
  prompt text, or system rules.
- Issue intake is project opt-in (`issue_intake: all`; default `labeled`).
  Legacy `issue_triage.enabled=true` maps to all unless explicitly overridden.
  Discovery never calls a model. Every open issue gets one task/card; existing
  tasks and persisted human/deferred/skipped dispositions never auto-retry.
  `issue_author_association` (all-mode only) allowlists GitHub
  `author_association` values; non-matching issues persist a `skipped`
  disposition, create no card, and are also re-checked at authorize time —
  missing association data fails closed.
  SQLite owns local intake state; one instance manages each repo's all intake.
  `agent-human-hold` and `agent-needs-human` remain external dispatch vetoes.
  Manual actions persist locally first; pending remote label removal blocks
  dispatch. Duplicate unlock must never add a lock. No new triage claim/state
  comments or triage worktrees are created.
- New all-mode code runs pin `runs.outcome_protocol=1` at claim time. The same
  coder session returns IMPLEMENTED/NEEDS_HUMAN/DEFER/NO_ACTION. Non-implemented
  outcomes must have clean worktree and unchanged HEAD; otherwise preserve the
  site and block. Never auto-commit or publish those outcomes. Old runs and
  labeled mode retain protocol 0 across restarts. All terminal transitions
  continue through Store/endRun and run_events.
- There is only one execution board. Intake failures are BLOCKED task cards,
  with disposition controlling human/deferred/history presentation. UI actions
  require auth and versions. Old triage claims require explicit owner/process
  safety verification; recovery never takes over a potentially live process.
- Publishing (push + `gh pr create`) is host-side only and idempotent:
  always check `findPrForBranch` before creating.
- Recovery must never start a second process for a run whose child may still
  be alive (`RECOVERY_REQUIRED` instead).
- The dashboard live log reads pi's JSONL: `/api/runs/:id/stream` (SSE,
  cookie-auth, 250ms ticks) with `/tail` polling as the fallback. Thinking,
  tool output and text all come from the same event stream — never render from
  a reduced model. Interval/tick callbacks must never throw: an uncaught error
  there kills the scheduler, so a rotated/removed log file is caught per tick.

## Commands

- `npm run ac -- doctor` — env/config check
- `npm test` / `npm run typecheck`
- `npm run ui:build` — rebuild the served dashboard (`ui/dist`; the server
  reads it per request, so a refresh is enough — no service restart)
- `npm run build` — backend `dist/` **and** `ui/dist`. `ui/dist` is
  gitignored, so every release must rebuild it; running from source reads
  whatever `ui/dist` is on disk, and a stale one serves the old dashboard.

## Service lifecycle

### Windows (scheduled task)

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

### Linux (systemd)

The 214 deployment runs `agent-control.service` (systemd, root,
`WorkingDirectory=/root/git/agent-control`, `ExecStart=/usr/local/node22/bin/node
--import tsx src/cli.ts start`). Its `Environment=` line carries `HOME` plus a
`PATH` that includes `/usr/local/node22/bin`.

**Provisioning requirement:** after installing the node toolchain, expose its
`bin` to the whole machine — not just to this unit:

```bash
# /etc/profile.d/node22.sh
export PATH=/usr/local/node22/bin:$PATH
```

systemd does not read `profile.d`, so the unit still needs its own
`Environment=`. But without the profile entry every interactive shell, manual
`npm run ac`, and `ac doctor` resolves `pi` differently from the service — 214
historically symlinked only `node` into `/usr/local/bin`, which left `pi`
unreachable from a shell while the service saw it fine. PATH is a machine-level
fact and belongs to provisioning, not to per-application workarounds.

`pi` resolves as: `agent.pi_path` → `PATH` → the directory of the node running
agent-control. Set `agent.pi_path` only for a layout that convention cannot
derive. A symlinked `bin/pi` is followed to `dist/bundle/cli.js` and run with
that same node, so both platforms take the same path and neither depends on the
shim's `#!/usr/bin/env node` finding the same node through PATH.

```bash
systemctl status agent-control
systemctl restart agent-control    # single instance: systemd stops the old one first
journalctl -u agent-control -n 50 --no-pager
```

Deploying to 214 is git-mediated: commit and push `main` locally, then
`ssh root@192.168.1.214 "cd /root/git/agent-control && git pull --ff-only &&
systemctl restart agent-control"`. The unit runs from `src/` via tsx, so a
backend-only change needs no build step; rebuild `ui/dist` on the box only
when `ui/` changed.

After restart: `systemctl is-active` says `active`, the tail of
`<logs_dir>/agent-control.jsonl` shows `ui_start` + `reconcile_done`, and
`agent-control.lock` carries the new pid with a fresh heartbeat.

Either platform: after restart check the same three signals (state/liveness,
lock pid + heartbeat, `GET /api/health` answers 401 when a token is set).
