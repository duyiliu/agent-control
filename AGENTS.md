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
  `retryTask` drops the task's review verdict rows — without that, a task
  whose branch already has an OPEN PR re-enters `AWAITING_REVIEW` with an
  unchanged head and the sha idempotency strands it forever (it shows as
  "reviewing" and can never move). `dispatchReviews` parks such a stranded
  task in `BLOCKED` (retryable) instead of leaving it looking alive.
  A low-risk PASS parks the task in `MERGING` — a host-side sweep
  (`reconcileMergeStates`/`driveMerge`) owns landing, never the review run.
  "Low-risk" is measured on the source change only: `max_files`/`max_lines`
  count `code` paths, and generated output (`dist/**`, `*.generated.*`) and
  docs are excluded from both the risk gate and the reviewer diff (the diff
  carries an explicit "已省略 N 个生成物文件" header). That exclusion is only
  safe because `projects[].verify_build` (global fallback
  `approvals.auto_merge.verify_build`), when configured, rebuilds the approved
  head before landing and refuses the merge if the generated paths drift from
  the commit. The rebuild site is the coding worktree when it still sits on
  the approved sha; otherwise the sha is materialized detached and
  `verify_bootstrap` (e.g. `npm ci`) installs deps first — every failure mode
  (no site, build failure, drift) goes to the human path, never merges blind.
  Reviewer `risk=high` and sensitive paths remain hard human gates.
  The cleared sha is recorded on the task (`approved_sha`, `approved_by`).
  Each tick the sweep re-verifies PR head == `approved_sha` (a moved head
  returns to AWAITING_REVIEW for a fresh review), runs
  `gh pr merge --squash --match-head-commit`, and retries refusals within
  `merge_attempts < 20` before parking on the human path with
  `agent-high-risk`. A `CONFLICTING` mergeable instead spawns a fix run via
  `tasks.pending_fix` (same budget as review-BLOCK fixes): the fix merges
  `<git_remote>/<base_branch>` — the host fetches it because the child's
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
  the run's `finally`, never left to the next phase. 按 run 持久化：绑定
  `--session-id <run_id>` 与 `--session-dir <run artifacts>/pi-session`，
  服务重启后由启动对账重开同一份历史；会话目录只认与该 run id、工作目录
  匹配的 session 头，外来或歧义文件一律拒绝复用。
  Review stays a one-shot `pi -p` call (`runners/pi.ts`) with a read-only tool
  allowlist (no bash/edit/write) and stays ephemeral. `review_model` and
  `review_reasoning_effort` may select a different Pi model/settings for review.
  `agent.model` is required — no implicit model default; `reasoning_effort` is
  optional (unset = runner default). All children get the scrubbed env.
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
- Issue intake is project opt-in (`issue_intake: all`; default `labeled`).
  Legacy `issue_triage.enabled=true` maps to all unless explicitly overridden.
  Discovery never calls a model. Every open issue gets one task/card; existing
  tasks and persisted human/deferred/skipped dispositions never auto-retry.
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
