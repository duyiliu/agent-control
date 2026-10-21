# Agent Control 审查与持续修复优化方案

> 状态：设计提案（仅文档，未实施）  
> 日期：2026-10-20  
> 跟踪：原跟踪 issue #3 已关闭（2026-10-20），本文档为 P0/P1/P2 的权威设计来源；实施时须另立经人工授权的执行 Issue（见 [design-workflow.md](./design-workflow.md) 第 3 节）。修复预算以本文件"单次 run 口径"为准。  
> 范围：`duyiliu/agent-control`，以当前 `main` 的 README、WORKFLOW.md、src/scheduler/engine.ts、src/verify/review.ts、src/scheduler/prompts.ts、src/tracker/github.ts、config.example.yaml 为依据。

## 1. 决策摘要

**保留 PR 前本地测试 + 独立只读 Review + 有界修复的核心设计；分阶段补充 PR 后 CI/外部评论反馈。** 不把内部 Agent 间的结构化审查意见改为 GitHub 评论通信；也不把 Symphony 示例工作流视为调度器必须遵循的规则。

实施顺序：

1. **P0：任何修复后重新运行权威 checks，再 Review**（修正确认的状态机缺口）。
2. **P1：Draft PR 创建后跟踪 CI 结果，并呈现失败证据**；先只读观察，不自动改代码。
3. **P2：可选地处理 PR 外部审查意见及 CI 失败，构成有界的 PR 后修复循环**；保留人工批准/合并和权限边界。

## 2. 当前实现（代码已可见，未在本次评审中执行测试）

主流程：GitHub Issue `agent-ready` → 领取并校验已批准内容哈希 → worktree → Pi/Codex 编码 → `VERIFYING`（宿主执行白名单 checks）→ `REVIEWING`（独立 reviewer 返回 JSON）→ 修复/通过 → `PUBLISHING_PR`（宿主创建 Draft PR）→ `AWAITING_HUMAN` → 人工合并 → `COMPLETED`。

- `REVIEW_SCHEMA`：`PASS | BLOCK | HUMAN_REVIEW_REQUIRED`，附 `summary` 和 `findings: string[]`。
- `BLOCK` 交由编码 Agent 修复；检查失败也可修复，二者共用 `server.retry_limit`（示例值 3）。
- Reviewer 在独立会话运行；Pi 使用只读工具白名单，Codex 使用配置沙箱；Review 前后检查 HEAD 和 worktree 清洁状态。
- PR 当前是内部质量闸门通过后的交付物；`AWAITING_HUMAN` 主要轮询合并/关闭状态，尚没有对 PR review comments 与 CI 的反馈调度。
- 安全边界：子进程凭据与发布权限尽量剥离，但 Windows 下 coder 不一定获得 OS 级隔离；不得将 worktree 等同于沙箱。

**已确认的缺口：** `engine.ts` 中 Review 失败进入 `FIXING` 时 `return_phase=REVIEWING`，`FIXING` 成功后直接回到 `REVIEWING`，没有重新执行 `VERIFYING`。修复可能使已有测试结果失效。

## 3. 目标与非目标

### 目标
- 每个将要 Review 或 Push 的新代码版本都有**对应 HEAD SHA 的通过 checks 证据**。
- 内部审查保持独立、结构化、可追溯，故障停止原因明确。
- PR 后能看到 CI 状态、失败定位和新增外部反馈；后续可选择自动处理。
- 不重复消费同一反馈，不因评论更新或轮询造成无限循环。
- 明确人工关口：不自动合并、不自动扩需求、不自动执行非白名单命令。

### 非目标
- 不改用 Linear；不迁移到 Symphony；不引入新的通用 Agent 框架。
- 不把审查 JSON 强制同步成 GitHub 评论，也不要求每轮内部修复都 Push。
- 不默认开启无人值守自动合并或部署。
- 暂不扩展多机器分布式抢占；现有 GitHub 标签认领非原子，后续单独处理。

## 4. P0：修复后的重新验证（最优先）

### 推荐状态变更

统一规则：**任意 `FIXING` 修改/提交代码成功后，先进入 `VERIFYING`。** `VERIFYING` 通过后再进入 `REVIEWING`，而不是返回原始失败阶段。

```text
RUNNING → VERIFYING ──pass──→ REVIEWING ──PASS──→ PUBLISHING_PR
             │                     │
           fail                  BLOCK
             └─────────┬───────────┘
                       ▼
                    FIXING
                       │
                       └────────→ VERIFYING
```

- 适用：checks 失败、Review BLOCK、发布前未提交改动修复（发布前还应验证新 HEAD）。
- `retry_limit` 是**任务级总修复次数上限**，保留默认 3；Review 进程基础设施重试与代码修复预算分别记录。
- 每次 checks 记录 `head_sha`、配置命令及退出状态；Review 绑定同一个 `head_sha` 和 diff。若 HEAD 在检查与发布之间变化，则重新检查或阻断。
- `HUMAN_REVIEW_REQUIRED` 不自动修复，直接转人工。
- 对于中断恢复，重新计算当前 HEAD 并核对证据；不得以旧 SHA 的 PASS 放行新版本。

### 关键测试

1. Review 返回 BLOCK → FIXING 提交修改 → `VERIFYING` 再运行 → `REVIEWING`；断言调用顺序和次数。
2. Review 修复导致 checks 失败 → 再进入 FIXING，直到通过或耗尽总预算。
3. 修复预算耗尽后为 BLOCKED，携带最后一次 checks/review 证据，不建 PR。
4. 修复后 HEAD 与最近通过检查的 SHA 不同 → 不允许发布。
5. 停止、超时、崩溃恢复不重复运行仍存活的子进程。

**验收：** 任意已创建 Draft PR 的最新提交都能追溯到同 SHA 的通过 checks 和 Review 结论；执行 `npm test`、`npm run typecheck` 均通过。

## 5. P1：PR 后 CI 可观测闭环（只读）

在 `AWAITING_HUMAN` 增加可选子状态/字段，例如 `ci_status`（PENDING/PASS/FAIL/UNKNOWN），不必立即新增复杂顶层 Phase。调度器通过宿主 `gh pr checks` 或 GitHub Checks/Statuses API 读取：

- PR 编号、`head_sha`、check name、结论、链接、时间；
- 明确区分 pending / failed / cancelled / timed out / skipped / unknown；
- PR 最新 SHA 改变时使旧检查结果失效；
- 在 Web UI / `runs` 展示 CI 证据；错误时退避重试且不误报 PASS；
- 仅告警/记录，不自动复跑 agent，也不自动关闭 PR。

**验收：** 用隔离 sandbox 仓库模拟成功、失败、长期 pending、GitHub API 暂时失败和人工 Push 新 SHA；所有状态正确显示，且不发生自动代码修改。

## 6. P2：可选的 PR 外部反馈修复循环

### 输入与判定

只接入**已获准的仓库/PR**，读取：
- CI 失败的检查摘要、链接及受信配置允许的日志；
- PR review comments（行级评论）、review 状态、普通 discussion comments；
- 人工批准/请求修改状态。

评论不天然可信。先归类为：`ACTIONABLE_FIX`、`QUESTION`、`SCOPE_CHANGE`、`SECURITY_OR_POLICY`、`NON_ACTIONABLE`；仅对于已批准范围内、有证据的确定性缺陷允许自动修复。需求扩张、权限变动、删除数据、架构决策进入人工确认。

### 去重与有界性

- CI key：`repo + pr + head_sha + check_run_id/名称 + conclusion`；
- 评论 key：`repo + pr + comment_id + updated_at + commit/position`；
- 记录 `first_seen`、`last_seen`、`handled_sha`、处理结果；同步时不要丢弃 unresolved feedback。
- 同一个失败 SHA 的已处理反馈不重复触发；**只有新的实质反馈或新的 SHA 的失败**才能进入下一轮。
- PR 后循环配置独立预算（建议默认禁用，启用时如最多 2 轮）；同时设时间和 token/费用上限。预算耗尽或反馈冲突即 `NEEDS_ATTENTION`。
- 明确排除机器人自己的重复评论、纯状态通知及已被后续提交修复的旧行级意见。

### 推荐状态流

```text
AWAITING_HUMAN
   ├─ CI pending / 无新增反馈 → 保持等待
   ├─ CI PASS + 外部 review 满足策略 → 等人工 merge
   ├─ 新可执行反馈 → PR_FEEDBACK_FIXING
   │                    → 本地修复 → VERIFYING → REVIEWING
   │                    → 宿主 push 原 PR 分支 → 重新追踪新 SHA
   └─ 范围变更/高风险/超预算 → NEEDS_ATTENTION（人工）
```

P2 应在 PR 已存在的情况下，**复用同一分支和 PR**，不要无意创建重复 PR。宿主侧执行 Push；保持编码子进程无法操作 GitHub 的约束。

关于处理 Review 的“完成”：区分 **机器人已处理意见** 与 **GitHub 上的人类审批已通过**；Agent 回复或代码变化不代表人类已经批准。默认合并仍严格人工操作。

### 验收

- 一条新的、明确可修复评论触发一次修复，并在新 SHA 上重新运行内部 checks/review、CI；
- 同一评论轮询十次不出现十次修复；更改内容/新增反馈可重新触发；
- 失败 CI 经一次修复后恢复成功，停留待人工合并；
- 请求变更、危险操作、互相冲突意见、预算耗尽均暂停并展示证据；
- 人工关闭/合并 PR 后立即停止相关循环并执行原有幂等对账。

## 7. 相关代码位置和最小实施切片

| 切片 | 建议文件 | 说明 |
|---|---|---|
| P0 状态机 | `src/scheduler/engine.ts`, `src/store/sqlite.ts`, `tests/scheduler.test.ts` | 修后统一重测、保存 SHA 关联、恢复幂等 |
| P0 证据契约 | `src/verify/checks.ts`, `src/verify/review.ts`, `src/types.ts` | 检查/审查证据绑定 HEAD |
| P1 CI 数据源 | `src/tracker/github.ts`, `src/scheduler/engine.ts` | 只读 PR checks + SHA 刷新 |
| P1 展示 | `src/ui/api.ts`, `ui/src/DetailDrawer.tsx`, `tests/ui.test.ts` | 状态及证据可见 |
| P2 反馈存储 | `src/store/sqlite.ts`, `src/tracker/github.ts` | 外部反馈游标、去重、审查意见分类 |
| P2 修复调度 | `src/scheduler/engine.ts`, `src/scheduler/prompts.ts`, `src/publish/pr.ts` | 复用 worktree、重测、再审、宿主 push |
| P2 回归 | `tests/scheduler.test.ts`, `tests/recovery.test.ts` | 重复反馈、并发、超额、重启、撤销批准 |

优先在已有结构内加最少状态，除非 P2 的恢复语义迫使引入新的持久 Phase。新增配置默认关闭以保持兼容。

## 8. 风险与待决事项

1. **安全：** 外部 PR 评论与 CI 日志是不可信输入，不得直接成为 shell 命令或高优先级系统指令；仅允许宿主运行预配置检查命令。
2. **Windows 隔离：** 现有环境清理不足以代替进程隔离；如需接第三方 Issue/PR，应另立低权限账户或容器隔离专项。
3. **成本：** PR 后每次 Push 都可能触发额外 Review/CI；使用新反馈去重、预算和指数退避。
4. **竞态：** 人工正在审查、更新分支或撤销授权时，不得由自动 Agent 强行覆盖提交。
5. **未确定：** 是否对 CI FAIL 启用自动修复、是否允许机器人直接回复评论、是否要求 GitHub 审批通过；先维持只读/人工合并的默认策略。
6. **独立问题：** 多实例 Issue 标签认领不是原子操作，暂不纳入本次迭代。

## 9. 建议落地顺序

- **迭代 A（必须）：** P0 修后重测 + HEAD 证据一致性 + 回归测试。
- **迭代 B（推荐）：** P1 PR CI 只读监控及 UI 展示。
- **迭代 C（按需）：** P2 评论/CI 自动修复，先在 `agent-control-sandbox` 隔离验证。
- **始终保留：** 人工批准需求、人工合并、修复上限、日志与可恢复状态机。

本文件仅提出设计与验收标准；不代表上述增强功能已实现或经过实测。
