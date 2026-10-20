# Review 独立任务化 - 执行队列

> 状态：完成
> 设计基线：./design.md（v2.2，已确认）
> 代码基线 branch：main
> 代码基线 commit：3aa0dca
> 任务前既有工作区修改：README.md / config.example.yaml / src/config.ts / src/proc.ts / src/types.ts / src/ui/server.ts / tests/ui.test.ts（UI token 认证 + PowerShell 解析修复，与本任务共存，不回退）
> 实现审查：完成（PASS）
> 实现审查模式：independent（subagent_explore）
> 实现审查轮次：3/3（R1 FAIL 1C/2H/9M → R2 FAIL 1H/1M → R3 PASS）
> Reviewer：subagent_explore（独立上下文，同一 agent 增量复审 agent_id=9e3d3bd8）
> 环境验收：未执行（需真实 GitHub PR + pi review 实跑；确定性证据已齐）
> 最后核验：完成

## 完成闸门

- [x] 有 design 时所有 AC 均被 Task / 最终核验覆盖
- [x] 所有实现 / 返工任务完成
- [x] 本次已授权交付边界内的关键确定性验证通过
- [x] 对抗式实现审查 PASS（或按风险分层经用户同意跳过并记录依据）
- [x] Critical / High finding = 0
- [x] 待环境验收项与证据层级已列明；本次目标要求的实测未完成时不宣称整体完成

## 验收覆盖

| AC | 覆盖任务 | 验证状态 |
|---|---|---|
| AC01 编码 run 不进 REVIEWING | T03 | 已验证（scheduler 测试断言 code run 发布即终） |
| AC02 auto 派发评审 run | T04 | 已验证（BLOCK/修复回路测试覆盖 dispatchReviews） |
| AC03 manual 不派发 | T02+T04 | 已验证（review-config 测试） |
| AC04 PASS 低风险自动合并 | T04 | 已验证（auto_merge enabled → COMPLETED + merged） |
| AC05 PASS 高风险转人工 | T04 | 已验证（risk path 测试） |
| AC06 BLOCK 派生修复 run | T03+T04 | 已验证（4-run 链路测试：code+review+fix+review） |
| AC07 BLOCK 终局 BLOCKED | T04 | 已验证（budget 耗尽/无 findings） |
| AC08 同 sha 幂等 | T04 | 已验证（verdict 行存在即不重派） |
| AC09 schema v4 迁移 | T01 | 已验证（store 迁移测试） |
| AC10 评审 run 恢复+kind 路由 | T05 | 已验证（recovery 测试） |
| AC11 评审期人工合并/关闭 | T04 | 已验证（MERGED mid-review → COMPLETED） |
| AC12 存量 REVIEWING code run 兼容 | T05 | 已验证（recovery 测试迁 VERIFYING） |
| AC13 PUBLISHING_PR 恢复新语义 | T05 | 已验证（recovery 测试 AWAITING_MERGE） |
| AC14 修复 run 同 sha 死端 | T03 | 已验证（no new commits → BLOCKED） |
| AC15 head moved 竞态 | T04 | 已验证（mid-review moved → run CANCELED + task AWAITING_MERGE + 新 sha 重派） |
| AC16 崩溃补 ERROR 行 | T04 | 已验证（crash catch + hasReviewVerdictForSha 守卫） |
| AC17 取消语义 | T04 | 已验证（aborted 先于结论行；物化/diff catch 亦查） |
| AC18 typecheck+npm test | T06 | 已验证（tsc 零错；146/146） |
| AC19 stop 不粘 | T04 | 已验证（cancel_requested → task CANCELED 无结论行） |
| AC20 pending_fix 派发边界 | T03 | 已验证（OPEN+pending_fix 不早退；各清零点） |
| AC21 评审 run gate 终局 | T04 | 已验证（gate 先于 head 检查，gate 相直落） |

## 任务队列

### T01 数据层：schema v4 + 类型 + store 方法

- 状态：done
- 验证证据：typecheck 零错；store.test 断言 v4 列存在
- 依赖：无
- 对应验收：AC09
- 目标：`runs.kind` / `runs.head_sha` / `check_results.head_sha` / `tasks.pending_fix` 四列迁移；`RunKind` 类型；`claimRun({kind,headSha})`；`addCheck` 增 `head_sha`；`setTaskStatus` 支持 `pending_fix`；新查询（按 sha 查 review 行、按 (task,sha) 聚合 check 证据）；删除 `hasReviewPass`。
- 验收标准：v3 库升级到 v4 后新列存在、存量行默认值正确、唯一索引语义不变。
- 验证方式：迁移测试 + typecheck。

### T02 配置与外部面：projects[].review + 标签覆盖 + getPrDetails + doctor

- 状态：done
- 验证证据：typecheck 零错；config.example/agent-control.yaml/doctor 标签已更新
- 依赖：T01
- 对应验收：AC03（配置侧）
- 目标：`projects[].review: 'auto'|'manual'`（默认 auto）；issue 标签 `agent-review-manual`/`agent-review-auto` 双向覆盖（manual 优先）；有效策略解析函数；`tracker.getPrDetails`（state/headRefOid/labels/isDraft）；doctor 标签列表追加；config.example.yaml + agent-control.yaml 更新。
- 验收标准：配置解析正确、标签覆盖生效、非法值拒绝。
- 验证方式：config 单测 + typecheck。

### T03 编码 run 收敛：删 REVIEWING + pending_fix 全链路 + 同 sha 死端

- 状态：done
- 验证证据：npm test 140 全绿（AC1/AC5 等重写后断言新链路）
- 依赖：T01
- 对应验收：AC01、AC06（修复侧）、AC14、AC20
- 目标：删 runTask 的 REVIEWING case（code run 落到 REVIEWING 时迁 VERIFYING 兼容）；PUBLISHING_PR → AWAITING_MERGE 终局；tryDispatch 中 pending_fix 非空时仅跳过 OPEN 早退（CLOSED/MERGED 判定保留）；PREPARING 按 pending_fix 强制 RUNNING；RUNNING 消费 pending_fix（fix prompt、快照进 run_events、保留被审 sha、清空列）；发布时 verifiedHead==被审 sha → BLOCKED；ops.ts retry/stop/discover 清 pending_fix。
- 验收标准：编码 run 事件链无 REVIEWING；pending_fix 任务走 RUNNING 修复路径；同 sha 死端 BLOCKED。
- 验证方式：scheduler 单测 + typecheck。

### T04 评审任务：dispatchReviews + runReviewTask + 物化 + 终局表

- 状态：done
- 验证证据：npm test 全绿（BLOCK/ERROR/HRR/物化/同 sha 幂等用例）
- 依赖：T02、T03
- 对应验收：AC02–AC05、AC07、AC08、AC11、AC15–AC17、AC19、AC21
- 目标：tick 末步 dispatchReviews（策略/活跃/标签/结论行五重判定 + 并发名额 + 单事务 claim+字段+task REVIEWING）；runReviewTask（getPrState 守卫、gate、head-moved 放弃、sha 物化现场（worktree 复用或 fetch+detached）、runReview 调用、aborted 先判、结论行、终局五元组 finishReview、agent-reviewing finally 摘除）；autoMerge/assessRisk/riskComment/testEvidenceFor 平移；崩溃 catch 按 kind 补 ERROR 行；GitWorkspace 增 fetch/detached worktree 助手。
- 验收标准：终局表各行五元组正确；同 sha 幂等；head moved 不写行；cancel_requested 与 signal abort 终局不同；标签无泄漏路径。
- 验证方式：scheduler/review 单测 + typecheck。

### T05 恢复路由：kind 分派 + PUBLISHING_PR 重写 + 摘签

- 状态：done
- 验证证据：recovery.test 全绿（PUBLISHING_PR 新语义 + review run 恢复用例）
- 依赖：T04
- 对应验收：AC10、AC12、AC13
- 目标：recovery 按 run.kind 分派（review→resumeReviewTask 幂等、REVIEWING/CLAIMED 均可；code+REVIEWING→迁 VERIFYING）；PUBLISHING_PR 分支改为"PR 存在+授权 ok→AWAITING_MERGE"，删 reviewed 判定；markRecoveryRequired 对 kind=review 摘 agent-reviewing；评审 run 恢复不要求 workspace 仍在（可再物化）。
- 验收标准：恢复不再把 run 送进无 case 相位；评审 run 恢复语义与运行时一致。
- 验证方式：recovery 测试 + typecheck。

### T06 证据聚合 + UI/文档 + 全量验证

- 状态：done
- 验证证据：`npx tsc --noEmit` 零错；`npm test` 140/140 通过；AGENTS.md/README/config 已同步
- 依赖：T04、T05
- 对应验收：AC18
- 目标：`callChecks` 写 head_sha；`buildPrBody` 评审行措辞；`RunDetail.kind` 透出；ops/cli/ui 相关断言更新；AGENTS.md 不变量改写（评审 run 主语）、README 流程、docs 同步；既有测试断言重写（REVIEWING 相关）;全量 `npm test` + `npm run typecheck`。
- 验收标准：typecheck 零错、测试全绿、文档与代码一致。
- 验证方式：npm test + typecheck + 文档自查。

## 审查记录与返工

### Round 1（FAIL：1C / 2H / 9M / 10L）
- **C1** `finishReview` 同相位落 run+task → head moved/signal abort 把 task 错误置 CANCELED。修：增 `taskPhase` 参数 + `cancelTaskPhase(runId)`。
- **H1** `cleanupMerged` 用了最后 run 的 workspace（可能是临时评审现场），漏清编码 worktree/分支。修：`store.lastCodeWorkspace()`。
- **H2** BLOCK→pending_fix 无 CAS，可覆盖带外取消/合并。修：tx 内重读 status+cancel_requested。
- M1–M9 同批修复：crash ERROR 行双写守卫、双分支 fetch、stale site 预清、abort 先于结论行、pending_fix 各清零点、MERGED 守卫补 task_completed、launch 先于日志。
- L1/L10：recovery 摘签 pr_url 回退、恢复补 branch 字段。

### Round 2（FAIL：1H / 1M，H2 修复引入回归）
- **N1(H)** `spawned=false`（窗口内取消）把 task 滞留 REVIEWING 且无救援。修：tx 内 cancelled → `setTaskStatus(CANCELED)`。
- **N2(M)** head-moved 两处字面 `AWAITING_MERGE` 丢失取消意图。修：改 `cancelTaskPhase`。
- N3–N6(L)：preflight 失败补日志；物化/diff catch 补 abort 检查；review-sites 复用改精确 resolve 比较；tryDispatch 漂移分支补 `pending_fix:null`。
- N7(信息)：gate 前取 head 的时序偏差——有界（sha 绑定 + merge 前复核），接受不改。

### Round 3（PASS）
- 全项复核通过，无引入性回归。残留：R3-1(Low) abort 检查与结论行间固有微窗口竞态（有界：verdict sha-诚实、task 落正常等待态）；R3-2(信息) 非归一化 worktree_root 下精确比较 false-negative → 仅临时目录泄漏。

## 新增测试（返工补充）

- AC15 head-moved 双 run + 新 sha 重派 PASS、AC19 cancel_requested 取消、AC14 同 sha 死端、AC04 auto-merge 实合、AC11 mid-review MERGED、AC08 同 sha 幂等；fakeWorkspace 补 fetchBranch/addDetachedWorktree 存根。

## 最终验证证据

- `npx tsc --noEmit`：0 错。
- `npm test`：146 通过 / 0 失败。
- 未执行：真实环境端到端（需活 GitHub repo + pi 实跑）——属环境验收层，非本次确定性验证范围。

## 交付后范围调整（v2.3）

- 用户决策（2026-10-21）：评审不要 auto/manual 配置，全部默认自动评审。
- 已移除：`projects[].review` 配置项（config.ts 见到该键直接 fail 并提示迁移）、`agent-review-auto`/`agent-review-manual` 标签与覆盖逻辑（reviewModeFor + dispatchReviews 中 getIssue 判定）、doctor 标签清单两项。
- `ReviewMode` 类型与 `ProjectConfig.review` 字段删除；AC1 测试改为断言 code+review 两个 run。
- 对外"人工评审"出口 = PASS 高风险 / HRR / ERROR / BLOCK 预算尽 → AWAITING_MERGE + 人工合并。

## 阻塞项

- 无

## 恢复说明

- 新会话先读项目规则、design.md（v2.2）、本文件和 Git 状态；工作区既有未提交改动（UI token / PowerShell 修复）不是本任务产出，不回退。
- 不信任旧 in_progress，先核对真实代码。
