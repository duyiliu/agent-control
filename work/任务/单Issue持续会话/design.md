# 单 Issue 复用 Coder 会话与人工评审交接

> 来源：GitHub #5 精简版（2026-10-24T15:22:58Z）。
> 执行授权：用户明确要求开始实现该版本；不包含解除 Issue 人工锁、部署或修改生产任务。
> 设计基线：按 GitHub #5 最终精简版；实施审查：通过（2026-10-25，无 Critical/High）。

## 目标

Issue 任务用首个编码 Run 的 Pi session ID 和 artifacts 目录固定 Coder 历史。后续修复 Run 启动时恢复该 session，正常结束仍关闭当前 Pi 进程，每个 Run 保留自己的状态、日志、PID 与恢复次数。单 Task 活跃 Run 唯一约束继续生效。

Reviewer 继续每轮新建 `pi -p --no-session`，只读独立。复审仍读当前 Issue、完整有效 Diff、当前 HEAD 对应 Checks；宿主从既有 `pending_fix_consumed` 审计事件附加最近一次 Review findings 和修复摘要。新 SHA 仍完整重审，不沿用旧 PASS。

Checks 与 Review PASS 后，宿主核对 Issue 授权、锁、取消、PR HEAD 和当前 Checks；适用 Checks 必须至少一项且全部通过。随后把当前 SHA 对应 Draft PR 转成 Ready，发布交接摘要，任务留在 AWAITING_HUMAN。AI 结论不触发自动合并；人工显式合并路径按现有规则执行。检查/Review 未完成或发生基础设施错误时保留 Draft，带原因交人。

每轮 Review 都先读取 PR 当前 base SHA，刷新并确认该 commit 在本地可用，再以该精确 SHA 生成完整 diff；无法取得 base SHA 时不调用 Reviewer，转人工。Base 改变会让旧评审和批准失效：自动 Review 模式退回 Draft 并重审；manual 模式保持人工接管并清除旧的 `agent-merge` 与 host approval。Ready 转换后发布摘要前再次检查取消、授权、PR HEAD/base 和 Draft 状态；取消或摘要失败时尽力退回 Draft，不记录成功交接。

任何修复（包括合并冲突修复）产生新 HEAD 后，旧批准失效，必须重新执行适用 Checks 和 Review。Reviewer 现场只读，不改变既有模型权限、网络隔离与凭据清理边界。

## 复用与兼容

- 不增加配置项、顶层状态、数据库表或统一预算。复用现有 `retry_limit`、`pending_fix`、Run/Event、Checks 与 task 状态。
- Coder 逻辑会话锚定任务的首个 code Run：会话 ID 取首个 Run ID，session 目录取该 Run artifacts。历史任务也可恢复此首轮 session。既有 session 归属/cwd 预检失败时保留现场并按 RECOVERY_REQUIRED 停车。
- Reviewer 输入中的上一轮信息来自宿主写入的 `pending_fix_consumed`，不是模型自述或外部 Issue 指令。
- 继续兼容外部裸 PR 的 advisory 审查，不自动修复或合并。
- 不迁移 SQLite schema，不修改现有 review policy v2 的 decision、budget 与 SHA gate 约定。

## 验收

| ID | 验收结果 | 验证方式 |
|---|---|---|
| AC01 | Review BLOCK 后新编码 Run 恢复首个 Coder session，且 Run 进程正确关闭、事件日志独立 | session 与 Engine 测试 |
| AC02 | 后续 Reviewer 仍是隔离的一次性只读调用，并能读到必要的旧 findings/修复摘要 | prompt、review 测试 |
| AC03 | PASS 后仅在最新 SHA、Issue 授权和非空通过 Checks 满足时转 Ready，并等待人审而不因 AI PASS 自动合并 | Engine、tracker 测试 |
| AC04 | READY 调用失败或其间 HEAD/授权改变时不报告正常交付，Draft 尽量恢复并清楚说明原因 | Engine 故障测试 |
| AC05 | 冲突修复后的新 SHA 回到适用 Checks/Review；旧批准不能沿用 | merge/SHA 测试 |
| AC06 | TypeScript、全套 npm test、UI 构建通过；隔离 sandbox 可用时报告真实端到端结果 | CI 本地命令与 sandbox |
