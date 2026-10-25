# Issue #6 执行记录

- 代码基线：main，4e44c6c。
- 初始工作区：ui/src/HistoryList.tsx 已修改；.qoder/ 未跟踪，均保留。
- 来源：Issue #6，用户要求直接实施；设计基线 design.md v1。
- 设计自查：same-context，已核对状态源、授权、返工、迁移、恢复边界。
- 实现审查：未执行。
- 环境验收：本地 typecheck/build/test 已执行；未部署、未写真实 GitHub。

| 任务 | 状态 | 验收覆盖 | 验证 |
|---|---|---|---|
| T01 持久化、配置、标签/事件与权限能力 | done | AC01/03/07 | schema13、config 默认值、Store 往返、事件授权单测通过 |
| T02 七状态对账、领取、交付与人工合并 | done（核心） | AC01/02/03/04/06 | 代码实现；补：triage 不再越权、BLOCKED/stop 收敛 Human Review、合并前重读 Issue+CAS、领取仲裁 fail-closed/同主机 |
| T03 完整返工、代际会话与重启恢复 | done（核心） | AC05/06 | 返工/代际分支/新会话实现；补：rework 意图崩溃后可续跑，不重复加代际 |
| T04 UI 状态映射、旧操作防绕过、文档 | done | AC07/08 | 看板按七状态分组（待我处理/执行中/Backlog/历史），卡片分离业务状态与本地执行状态，详情展示代际/需求哈希/诊断；工作流任务可在看板直接改 Backlog/Todo/Human Review/Rework/Merging，合并/返工授权绑定 head/base/需求哈希/代际；隐藏 legacy intake 与批准/重试/重评审；项目页暴露 workflow_mode；README/AGENTS 更新 |
| T05 集成验证与对抗式审查 | done | AC01-08 | 引擎实验 15 类（交付/返工/返工崩溃续跑/合并失败/冲突/重启补齐/非法跳转/Backlog/宿主·Bot/无权限/过期事件拒绝/离开 Human Review 清空范围/legacy 冻结/看板批准合并/看板返工）+ 看板映射与动作 8 项；全量 517 项通过 |

实现与测试执行交由辅助执行上下文；设计、授权边界、提示词及最终审查由主上下文负责。
临时测试输出统一放 D:/workspace/LifeOS/.tmp/，不得写入知识库根目录。

最终清理：删除最后一条 legacy 裸 PR 任务（`agent-control-sandbox` PR#44）及其 2 个 review run，备份 `D:\agent-control-data\backups\legacy-pr-cleanup-2026-10-25T08-16-33-501Z.db`。当前库为 60 个 workflow 任务、0 个 legacy 任务，全部在 Backlog；旧标签/旧 intake 表已清空。
