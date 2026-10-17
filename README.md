# agent-control

个人 AI 研发调度中心 MVP：人在 GitHub Issue 上加 `agent-ready` 标签后，常驻调度器自动完成

```
领取 → git worktree 隔离 → codex exec 实现 → 受信测试 → 独立只读 Review →
有界修复(≤3) → push + Draft PR → 等待人工合并
```

设计来源：`LifeOS/work/agent-control-mvp-design.md`（借鉴 OpenAI Symphony 控制面）。

## 快速开始

```powershell
cd agent-control
npm install
copy config.example.yaml agent-control.yaml   # 编辑其中的 repo/路径
npm run ac -- doctor                          # 环境检查
npm run ac -- start                           # 启动常驻调度
```

其他命令：`status`（任务一览）、`runs <issue>`（时间线+证据）、`stop <issue>`（一个轮询周期内安全取消）、`retry <issue>`（人工重批后重排队）。

## 安全边界（MVP）

- 只接入可信测试仓库；Issue 正文只作数据，不会变成 shell 命令（测试命令只能来自仓库配置白名单）。
- 编码子进程被剥离 `GH_TOKEN`/`GITHUB_TOKEN` 等 GitHub 凭据（Windows 上 gh keyring 凭据仍对本机进程可用 —— 这是已记录的平台限制，所以只跑可信 Issue）。
- push / 建 PR 由宿主调度器执行，编码子进程无发布权限；所有 PR 均为 Draft，合并永远是人工操作。
- 审批内容哈希快照（SHA-256）：批准后 Issue 被改动 → `BLOCKED_APPROVAL_CHANGED`，需人工 `retry` 重批。
- 重启先对账：子进程可能存活 → `RECOVERY_REQUIRED`（绝不重复执行）；确认已死 → 按已存相位幂等续行。

## 状态机

`DISCOVERED → CLAIMED → PREPARING → RUNNING → VERIFYING ↔ FIXING → REVIEWING ↔ FIXING → PUBLISHING_PR → AWAITING_MERGE → COMPLETED`；任意运行相位可落入 `BLOCKED / FAILED / CANCELED / RECOVERY_REQUIRED`。所有迁移写入 `run_events`，测试与 Review 证据写入 `check_results`。

## 与设计的偏差（已记录）

- 宿主 Windows 原生（非 WSL2）；单实例用心跳锁文件而非 flock。
- SQLite 用 `node:sqlite`（Node ≥22.13 内置）替代 better-sqlite3。
- Codex 调用解析 `@openai/codex/bin/codex.js` 后 `node` 直调；prompt 走 stdin。

## 开发

```powershell
npm test            # node:test 全套（34 用例，含真实 git worktree）
npm run typecheck   # tsc --noEmit
npm run build       # → dist/
```
