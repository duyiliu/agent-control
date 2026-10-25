# Issue #6：GitHub 七状态研发闭环

> 设计版本：v1；来源：Issue #6 的已确认决策及用户“帮我直接实施吧”（2026-10-25）。
> 用户授权范围：本地实现与测试；不包含部署、修改真实 Issue/PR、提交或推送。
> 本文是稳定契约；执行记录见同目录 tasks.md。

## 目标与兼容边界

GitHub Issue 的互斥状态 Label 是业务状态来源：
`Backlog`、`Todo`、`In Progress`、`Human Review`、`Rework`、`Merging`、`Done`。
SQLite 中既有 Phase 保留为 Execution 的技术阶段，不新增业务 Blocked 状态。
不替换 Pi、不新增模型路由、不删除现有可选 Reviewer、裸 PR 评审和日志能力。

新增项目字段 `workflow_mode: github | legacy`，配置解析默认 github。
github 模式未配置 review_mode 时默认 manual；legacy 默认 auto；显式 auto 仍启用独立评审。
新增任务在创建事务中固定工作流版本；升级前的所有任务保持 legacy，不自动重解释。
已有生产配置、凭据、数据库不在本次写入范围内；显式 legacy 可维持旧项目的新任务行为。
github 项目的历史 legacy 任务仍走原执行路径；不能因项目模式变化接管其活跃进程。
Review policy v2 的预算、证据与具体决策约束在选择 auto review 时继续生效。
七状态任务无论任何 auto_merge 配置或 AI PASS，都不得绕过人工授权。

## 状态与执行

- 未带状态的新 Issue 一律初始化为 Backlog；只有人工改成 Todo 才会调度。
  workflow 模式不使用 ready_label，也不看 issue_intake：Backlog 就是唯一人工门禁。
- Backlog 不调度；仅 Todo 或已领取的 In Progress 内部重试可开始编码。
- 防重复启动只依赖 SQLite 单活跃 run 唯一索引（单实例部署）；不在 GitHub 写
  领取标签或领取评论。跨实例部署不在本设计范围内。
- 编码、自检与有限修复在 In Progress；可选自动评审同属 In Progress，
  不是 Human Review。没有可用检查或执行失败必须记录具体原因。
- 只有宿主验证当前 SHA 的正向检查、干净 worktree、关联 PR、需求 hash 后，
  才保存可审查交付范围并转 Human Review。PR 转 Ready 失败不能伪报成功。
- 外部阻塞、修复预算耗尽、错误状态变更进入 Human Review 并附明确原因；
  缺少合格 PR/检查证据时不能产生可用于合并的交付范围。
- 合法主边：Backlog → Todo → In Progress → Human Review；
  Human Review → Rework → In Progress → Human Review；
  Human Review → Merging → Done。Merging 失败可回 Human Review。
- 人工撤回 Todo/In Progress 后，不再 launch/发布；活跃子进程应中止，
  但必须等其 finally 收尾，不可先释放唯一槽再启动新 run。
- 缺标签或多状态标签均不可据此调度/合并；保留诊断并安全收敛到 Human Review。
  任意跳到 Done 不能代表成功：必须独立核实关联 PR 已合并。
- 关闭 Issue 且无已合并关联 PR 按原约定取消，不写 Done、不重开 Issue。

## 持久化与幂等

Schema v13 增加 tasks 的可空工作流 JSON；null 即 legacy。Store 拒绝未来 schema。
JSON 保存版本、观测状态缓存、代际、已消费事件、交付范围、授权记录、
待完成的宿主标签变更与返工意图、历史 PR/分支/会话引用、诊断信息。
这些都是执行证据/缓存，不能覆盖刚读到的人工新状态；重启先读远端再对账。
所有新状态必须经控制端统一入口校验；标签变更先持久化意图，再写远端，
再确认实际标签。API 失败不得被当作状态已完成；重放相同意图须幂等，
遇到不同的新远端状态则使旧意图失效，不能覆盖人工撤回。
变更原因/证据写入 run_events（已有 run 时）及结构化宿主日志；
无 run 的发现与非法变更也在持久化 JSON 中保留诊断。

## 可核验的人工授权

人工在 Issue 上从 Human Review 改为 Merging 或 Rework。读取分页事件，
同时核对最新 labeled/unlabeled 事件、actor 类型与当前仓库权限。
权限须为 push/write、maintain 或 admin；Bot、未知 actor、无权限、缺事件一律拒绝。
宿主认证身份不能作为这两个动作的批准人，防止宿主自动化自己的标签写入构成授权。
部署应使用独立自动化身份；若宿主和人工共用同一 GitHub 账号，安全地拒绝授权，
需改用独立自动化账号/应用，不能通过配置跳过权限检查。
GitHub 无法识别另一个人类账号的 PAT 背后是否由软件操作；安全边界是受信任身份、
仓库权限、宿主/子进程凭据隔离及一次性事件，不宣称能识别人类的物理点击。

交付时保存 PR 编号、head/base SHA、需求 hash、事件游标和交付时间。
只消费交付之后的新事件；授权绑定事件 ID、actor、Issue、需求 hash、PR 和 head/base。
不能把旧标签、PR agent-merge 标签、UI 宿主代写、预算续期或 AI PASS 当人工授权。
Scope 改动、拒绝决策、未解决 findings/verification/decisions、hold 都使授权无效。
合并调用前再次读取 Issue/授权事件/权限、当前任务版本、PR head/base 和检查状态；
所有已存在 CI 检查须完成且成功（允许 skipped/neutral 的明确终态），
无 CI 时明确报告，仅使用正向宿主检查证据，不把“未配置”算通过。
使用非 admin、非绕过保护的 `gh pr merge --match-head-commit`；
GitHub 负责最终分支保护与 required review 校验。
调用成功还必须读到 MERGED；随后才写 Done 并关闭 Issue。半完成时重启补齐，
不得重合并或误关 Issue。Done/关闭失败在后续 tick 恢复。

## 完整返工

只允许 Human Review 的有效人工 Rework 事件发起；普通测试失败不触发返工。
先核验旧进程已退出，将返工事件、下一代际、旧 PR/分支/会话引用持久化。
关闭旧的 OPEN PR（不删分支、不删 worktree、不丢未提交成果），同事件重复处理不重复代际。
读取最新 Issue 与人工评论作为数据快照，更新需求 hash，清除旧批准和 review control。
新分支 `${branch_prefix}${issue_number}-r${generation}`，新工作目录带相同代际。
宿主 fetch 指定 git_remote 的最新 base_branch，并固定该提交为新分支起点。
新一代必须使用新的 Pi 会话；同一代的自修复/重启继续复用本代首个编码 run。
创建/更新 PR 仍通过现有宿主 publishDraftPr 和 findPrForBranch；不复用旧 PR。

## UI 与操作

API 增加可选 workflow_state/workflow_reason；保留原 status 兼容旧客户端。
既有看板将七状态显示在任务卡和详情，不新建 Issue 管理页，不新增业务 Blocked 列。
七状态任务的 approve/retry/rereview 等旧写入口不能绕开状态源或人工事件验证；
提示用户在 GitHub Issue 操作。stop 保留安全中止能力，不伪造 Done。
保护已有 ui/src/HistoryList.tsx 用户修改，不触碰 .qoder/。

## 迁移与回滚

升级前停机或 drain，备份数据库（含 WAL 的一致性备份）及配置。
不批量改历史 Issue；新任务按上文渐进初始化。历史 legacy 任务无损继续。
先在隔离仓库验收再部署。回滚须停机并恢复升级前数据库/配置，再运行匹配旧代码；
禁止旧代码打开 v13 数据库。已写入的七状态标签需人工决定保留或迁回，不自动删除。

## 验收

| ID | 可观察结果 | 验证 |
|---|---|---|
| AC01 | 七状态互斥，Backlog 不执行，Todo 不重复领取 | 单测与伪 tracker 集成测试，含多标签、读取失败、同主机竞争 |
| AC02 | 默认无 Reviewer 仍完成编码、自检、PR、Human Review | 完整假会话执行，断言无 review run、正向 SHA 证据、Ready |
| AC03 | AI/旧标签/机器人/无权限/过期事件均不能授权 | 事件、权限、scope、hold 负向测试 |
| AC04 | 人工授权后安全合并，确认 MERGED 才 Done/关 Issue | 合并正常、失败、head/base/需求变化、CI/保护拒绝测试 |
| AC05 | 人工 Rework 新代际、新会话、新主干、新 PR且历史可追溯 | 完整返工、重复事件、半完成重启测试 |
| AC06 | 重启/异常收敛，不重复进程、不覆盖人工撤回、不丢成果 | outbox/恢复/停机回归及进程安全测试 |
| AC07 | 旧任务/裸 PR/可选 Review 兼容，UI 展示状态源 | migration、既有回归与 API/展示测试 |
| AC08 | 文档明确边界及回滚，不包含真实环境副作用 | 人工 diff 审查；运行时验收另行授权 |

验证限制：不运行 build/编译；允许 node:test/tsx 测试与 `tsc --noEmit` 类型检查。
不调用真实 GitHub 写 API，不启停当前服务。真实 GitHub/CI/保护规则验收标记待执行。
