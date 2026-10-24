# 人工评审规则重设计执行

设计：design.md v1，独立审查 PASS。用户以“实施”明确确认本版本。
代码基线：main；开始时存在先前会话的 UI/评审/操作等未提交改动，全部保留。

| 任务 | AC | 依赖 | 验收/验证 | 状态 |
|---|---|---|---|---|
| T1 策略 v2、预算与证据持久化 | AC01/02/08/13/14 | 无 | 迁移、策略、CAS、预算回归 | completed |
| T2 结构化评审与分段汇总 | AC03/04/05/07/15 | T1 接口 | 协议、分段不丢请求、只读边界测试 | completed |
| T3 决策回答、批准边界与界面分类 | AC06/12/16 | T1 接口 | 操作版本/SHA/授权测试、UI 构建 | completed |
| T4 调度补证/修复/恢复与合并校验 | AC01-09/11/12/15 | T1/T2/T3 | 案例回放、调度与失败路径测试 | completed |
| T5 外部关闭对账、文档与兼容 | AC10/11/13/14 | T1/T4 | 关闭/未知/人工处置测试、启动约束 | completed |
| T6 集成验证与实现审查 | AC01-16 | T1-T5 | 全套测试、typecheck、UI 构建、对抗审查 | completed |

## 验证与实施审查

2026-10-24 最终回归：`npm test` 456 项，454 PASS / 2 SKIP / 0 FAIL，详见 test-results.log；`npm run typecheck`、`npm run build`、`git diff --check` 通过。构建包含前后端类型检查和 ui/dist 重建。

| 验收 | 实现与证据 |
|---|---|
| AC01/02 | review-engine-v2：兼容增量、legacy wrapper high、409 行不形成规模人工门禁；review-v2：超容量归 infra |
| AC03/04/05 | review-engine-v2：具体 finding、verification 派生修复并消耗共享预算、缺适用检查先补跑；review-v2：分段请求合并和汇总不覆盖 |
| AC06/12/16 | review-decisions、review-merge-v2：保护路径、逐项回答、拒绝、过期版本/SHA/需求、并发状态变化、标签不能替代授权或技术校验 |
| AC07/08 | review-policy、review-engine-v2、recovery：ERROR 同 SHA 可重试、30/120 秒退避、第三次耗尽、重启计数保留、可能存活 PID 不恢复 |
| AC09 | review-merge-v2：head/base 移动、冲突修复清批准、新 SHA 重评；实际 merge 前再次核验本地版本 |
| AC10/11 | review-engine-v2、pr-review、既有 intake 测试：外部关闭清 pending/retry，暂缓保留；裸 PR 不执行 checks/编码/合并 |
| AC13 | review-policy/store：schema12 可空迁移、Store 拒绝高版本库；review-decisions：人工重评升级保留历史和同 SHA 未闭合证据；启动日志说明策略语义 |
| AC14 | review-report：按非 sandbox Issue 任务去重，legacy 单列，续期不计首次闭合，历史预算保留到事件统计 |
| AC15 | review-v2 及既有 runner/env/publish 测试：readonly 工具、scrubbed env 与宿主发布边界不变 |

## 实施审查记录

第 1 轮 independent，原 reviewer 报告 2 High 后额度耗尽：

- R01：保护路径在过滤 diff 后匹配会漏掉 dist/docs，manual 合并路径也需核验。已改为完整 diff，并在宿主合并前独立检查；新增生成物/文档及 auto/manual 回归，PASS。
- R02：崩溃恢复直接 resume v2 review 会绕过持久化轮次时限。已改为确认旧进程死亡后记录 ERROR、消费 infra 预算并退避重排；可能存活的进程仍保持 RECOVERY_REQUIRED。新增 0/1/2 次历史失败和活进程用例，PASS。

第 2 轮 same-context 增量复审，PASS，Critical=0 / High=0。原 reviewer 因配额不可用，按 task-execution 的 implementation-review-lifecycle.md 降级，未宣称独立复审通过。增量范围包括 R01/R02、预算续期保留同 SHA finding/拒绝记录、PR 新任务策略钉住、冲突批准失效、标签消费及 mark-ready 后版本检查。没有扩大到重新设计既有授权契约。

## 本机运行态验收

- 确认旧服务无活动 run 后排空，drain request/ack 一致；停止计划任务和经命令行核验的锁 PID 32884。
- 升级前用 SQLite VACUUM INTO 备份 schema11 数据库及配置到 `C:/Users/zhangqianfeng/git/agent-control-data/backups/review-v2-20261024-2300/`；备份含私有配置，不放入仓库。
- 本机配置启用 review_policy.version=2；通过既有 Windows 计划任务启动，锁 PID 7252，heartbeat 持续更新。
- 2026-10-24 22:55 启动日志：review_policy version=2、size_thresholds=planning_only、ui_start、reconcile_done；schema12；未鉴权 health=401，鉴权 GET tasks=200。已 undrain，drain_requested/ack 均清空。
- 现场自动对账：scenario-test#26 与 project-runner#82 已变 CANCELED，清除 pending/error；project-runner#56 仍 deferred，未恢复。
- 浏览器桌面 1440×1000 与手机 390×844：无 pageerror、无移动端横向溢出；截图 board-desktop.png / board-mobile.png。执行看板保持卡片及全部状态空列，执行受阻独立入口。
- 历史评审不自动改判，没有主动重评历史 PR、提交/推送代码或部署 214。当前非 sandbox v2 样本数为 0，统计率为 null，不能声称实际人工介入率已下降；新任务的真实模型闭环及长期比例待后续自然样本观察。fixture 回放不等于真实模型运行。
