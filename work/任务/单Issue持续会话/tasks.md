# 单 Issue 复用 Coder 会话 - 执行队列

> 状态：完成（2026-10-25）
> 设计基线：./design.md
> 代码基线 branch：当前工作分支（开始时已有大量未提交 Review V2 改动）
> 代码基线 commit：c627b5b
> 任务前既有工作区修改：已有 Review V2、UI、schema v12、AGENTS/README 等修改；均属于用户现有工作，必须保留。
> 验证：最终 typecheck、全量测试、UI 类型检查/构建、diff 检查和 sandbox 状态复核均通过

## 任务队列

### T01 Coder 会话跨 Run 恢复

- 状态：done
- 目标：Coder session ID/sessionDir 锚定任务首个 code Run；后续 Review 修复 Run 恢复同一历史。
- 验收：AC01；cwd/session 所有权不匹配时安全停车。
- 验证：session、scheduler、recovery 测试通过。

### T02 Review 延续上轮证据并转 Ready

- 状态：done
- 目标：将宿主记录的上轮 findings 与修复摘要交给新 Reviewer；当前 HEAD/Checks/授权全部有效时把 Draft 标 Ready 并等待人工审阅。
- 验收：AC02、AC03、AC04；不触发 AI 自动合并。
- 验证：prompt、Engine、tracker 测试通过；sandbox #43 → PR #44 Ready。

### T03 修复 SHA 和冲突后验证路径

- 状态：done
- 目标：所有新 HEAD（包括冲突修复）回到最新 SHA checks/review，不沿用旧批准。
- 验收：AC05。
- 验证：Engine v2 merge、legacy merge、SHA 绑定和 shutdown/resume 测试通过。

### T04 验收与对抗审查

- 状态：done
- 目标：完整确定性验证、审查阻塞发现、修复后复验。
- 验收：AC06。
- 验证：当前工作树 `npm run typecheck`、`npm test`（466 tests，464 pass / 2 skip）、`npm run ui:typecheck`、`npm run build`（含 UI + 后端编译）、`git diff --check` 通过。新增测试覆盖 base SHA 固定、缺失 base SHA 停车、manual base 变化、摘要失败/取消回滚 Draft、新 HEAD 重审期间退 Draft。用当前 `GitWorkspace` 在 sandbox 本地实际 fetch PR #44 base/head、精确解析两个 SHA 并生成非空完整 diff。真实 sandbox #43 → PR #44（HEAD `00cc7381fcf567cff332d1144ec864ea52731656`）的宿主 `node --test` 与 Review PASS 均绑定该 HEAD，`human_handoff_ready` 记录 base SHA `bf10155e4695379de826ca326b30a3258f763a1a`；当前 PR 仍为 OPEN/Ready，任务 `AWAITING_HUMAN`，未自动合并。GitHub Actions 当前未报告 PR checks。复核发现计划任务已有运行实例并正在查询 sandbox PR，因此本轮没有另起 scheduler 或新建测试 Issue；以现存 E2E 记录和当前真实 base/head diff 作集成证据。独立实现审查通过，无 Critical/High。

## 阻塞项

- 无
