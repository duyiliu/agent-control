# Issue 默认接手 - 执行队列

## v7 单看板收敛阶段（2026-10-23）

- 状态：done（v7 设计与实现审查 PASS，本地切换与安全验收完成；下文 v5 完成记录仅作历史）
- 用户方向：所有新 Issue 默认进入执行，同一 Agent 判断与实现，all 模式不需要 agent-ready。
- 当前基线：main / a93996fb4dc7f9e2e666f73eb603d62f27117d82；已有 v5 未提交代码及 .qoder/ 保留。
- V7-T01：done，AC01-04/08/11；程序发现、配置兼容、全部 gate、存量迁移和去重。
- V7-T02：done，AC05-06/09；编码结果契约、非实现安全结束、旧 run 恢复兼容。
- V7-T03：done，AC04/07/10；本地持久化人工动作、版本保护、门禁同步及看板收敛。
- V7-T04：done，AC01-11；已授权验证、独立实现审查与环境验收记录。
- 实现已接通：all 默认队列、同会话 outcome、schema11、人工操作版本/同步、单执行看板。
- 验证：350 tests，348 通过、2 跳过、0 失败；typecheck/build 通过；独立实现审查 PASS（第 1/3 轮；Critical/High=0）。
- 真实只读迁移预演：数据库副本导入 3 deferred / 1 skipped 为唯一 BLOCKED task，已完成任务未重排，没有新可执行项。
- 运行时：计划任务重启完成，PID 43972；lock PID/heartbeat、health 200、无鉴权 health 401、ui_start/reconcile_done 均核对。
- scenario-test 配置已改为 issue_intake: all；3 暂缓（#12/#10/#8）、1 无需处理（#20）均保留，已完成任务未重跑，无活动 run。
- 真实安全 API 验收：#8 锁定 6ms、解锁 5ms、重复解锁 2ms，最终 deferred/unlocked/pending=null，无新编码 run；恢复原业务处置。
- Served UI 资源与本地构建字节一致，独立分流导航已移除；浏览器技能文件在当前环境不存在，未执行实际浏览器点击验收。
- 切换前数据库与配置备份：agent-control-data/backups/intake-v7-1792763016286。
- 实现审查非阻塞 Medium：sync 清 pending 后、retryTask 落库前若进程崩溃，可能丢失自动继续意图；任务保持 BLOCKED，人工再次点击继续可恢复。已记录，未宣称此边界已解决。
- Git 交付：按用户授权提交并推送；最终提交及远端校验结果以交付回复为准。

## v5 历史实施记录

> 状态：done（实现、复审与本地启用完成）<br>
> 设计基线：./design.md<br>
> 代码基线 branch：main<br>
> 代码基线 commit：`a93996fb4dc7f9e2e666f73eb603d62f27117d82`<br>
> 任务前既有工作区修改：仅未跟踪的 .qoder/，保留原样<br>
> 实现审查：PASS（无 Critical/High）<br>
> 实现审查模式：independent<br>
> 实现审查轮次：2/3<br>
> Reviewer：issue_triage_impl_review；2026-10-23<br>
> 环境验收：计划任务重启成功，lock PID 与服务 PID 一致；health/API 返回 200；看板出现 6 个 scenario-test Issue 卡片。Issue 21 首轮 AUTO 并进入编码 run；其余 5 项待并发槽释放后继续评估，尚无真实 HUMAN 判定<br>
> 最后核验：`npm test` 334 通过/2 跳过/0 失败；typecheck、build、diff-check 通过；实现 Review PASS；真实 HUMAN 卡片流程由自动化用例覆盖

## 完成闸门

- [x] 所有 AC 均被实现任务覆盖
- [x] 所有任务完成
- [x] 授权范围内确定性验证通过
- [x] 对抗式实现审查 PASS
- [x] Critical / High finding = 0
- [x] 未执行的真实 GitHub / 多实例验收如实标注

## 验收覆盖

| AC | 覆盖任务 / 最终核验 | 验证状态 |
|---|---|---|
| AC01-AC04, AC08, AC11-AC12 | T01, T04 | 分页、状态、路由及持久化用例通过；Review PASS |
| AC05-AC09 | T02, T04 | API 鉴权、写动作和看板构建通过；Review PASS |
| AC10 | T03, T04 | 默认关闭、远程 UI token、migration 和启用开关标签用例通过；Review PASS |

## 任务队列

### T01 发现、分流持久化与安全执行

- 状态：done
- 依赖：无
- 对应验收：AC01-AC04、AC08、AC11-AC12
- 目标：为开放 Issue 扫描、差异分流队列、只读 Pi 判定、标签路由和安全恢复建立后端主链路。
- 验收标准：分页不遗漏；决策幂等；AI 只读；AUTO/HUMAN/DEFER/SKIP 路由符合设计；进程和跨实例恢复 fail closed。
- 验证方式：`npm run typecheck`、`npm test`，含 Issue 分页、严格输出、HUMAN→AUTO→HUMAN 指纹重评、过期路由阻断、悬挂 claim 清理与 Store 持久化用例。
- 验证证据：最终 `npm run typecheck` 通过；`npm test` 334 项通过、2 项跳过、0 失败。

### T02 API 与分流看板

- 状态：done
- 依赖：T01
- 对应验收：AC05-AC09
- 目标：提供分流列表、鉴权写动作和独立 Issue 分流视图。
- 验收标准：人审与暂缓可见；放行/暂缓/重评动作受配置 repo 与状态约束；自动通过项转入原执行看板。
- 验证方式：UI TypeScript 检查、生产构建、triage API token 鉴权与写动作测试。
- 验证证据：`npm --prefix ui run typecheck`、`npm --prefix ui run build` 通过；`tests/triage-ui.test.ts` 通过。

### T03 配置、标签与运维文档

- 状态：done
- 依赖：T01
- 对应验收：AC10
- 目标：增加项目级启用项，设置兼容默认值，接入 `agent-needs-human` provisioning/doctor，并更新配置说明与仓库不变量。
- 验收标准：旧配置默认不启动分流；显式启用后 doctor 可识别标签；执行边界文档与实现一致。
- 验证方式：配置解析与文档/不变量核对。
- 验证证据：`tests/config.test.ts` 覆盖旧配置默认关闭和非 loopback UI token 要求；`tests/store.test.ts` 覆盖 v10 migration、分流快照/进程 job 与未启动 task 清理。

### T04 集成自查与交付审查

- 状态：done
- 依赖：T02, T03
- 对应验收：AC01-AC12
- 目标：核对代码 diff、AC 覆盖、并发/恢复/外部标签一致性及兼容性。
- 验收标准：无 Critical/High；所有未执行验证和边界明确。
- 验证方式：独立只读对抗式审查；必要时集中修复并增量复审。
- 验证证据：独立实现审查 PASS；Critical/High=0。三项 finding 已修复并覆盖测试。计划任务重启后 health/API 返回 200，分流看板实际列出 6 个开放 Issue；Issue 21 完成 AUTO 路由并启动编码 run，5 项仍待队列处理。尚未观察到真实 HUMAN 判定，多实例故障注入未执行。残余 Low：手工从配置移除仍有持久化 triage job 的项目时，恢复逻辑会保留并发占用；项目移除当前不受 UI 支持。

## 阻塞项

- 无阻塞项。设计 v5 与实现审查均 PASS；实现、确定性验证、本地服务启用与看板 API 验收完成。AI 自动处理队列仍按并发限制继续运行。

## 恢复说明

- 先检查当前 Git 状态与任务前既有修改，不回退或覆盖其他工作。
- 从第一个真实可执行的 pending 任务开始；设计高成本契约变化须先回到 task-design。
