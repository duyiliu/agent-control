# agent-control

个人 AI 研发调度中心 MVP：人在 GitHub Issue 上加 `agent-ready` 标签后，常驻调度器自动完成

```
领取 → git worktree 隔离 → agent 实现(pi|codex) → 受信测试 → 独立只读 Review →
有界修复(≤3) → push + Draft PR → 等待人工合并
```

设计来源：`LifeOS/work/agent-control-mvp-design.md`（借鉴 OpenAI Symphony 控制面）。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| Node ≥ 22.13 | 用了内置 `node:sqlite`，低于此版本起不来 |
| git + GitHub CLI | `gh auth login` 完成认证——发布 PR、探测合并全靠它，跑在宿主侧 |
| agent runner 二选一 | **pi**：`npm i -g @earendil-works/pi-coding-agent` + `~/.pi/agent/models.json`（见下）；**codex**：`npm i -g @openai/codex` + `codex login` |
| pi 模型配置 | 仅 `provider: pi` 时需要：`~/.pi/agent/models.json` 里配 provider/model（见下） |
| 托管仓标签 | `agent-ready`、`agent-running`、`agent-blocked`、`agent-pr` 需预先存在——doctor **只验不建**：<br>`gh label create agent-ready -R <owner>/<repo>`（四个都建） |

`~/.pi/agent/models.json` 最小形态（OpenAI 兼容网关示例）：

```json
{
  "providers": {
    "new-api": {
      "name": "new-api",
      "baseUrl": "http://<网关地址>:3002/v1",
      "api": "openai-completions",
      "apiKey": "<key>",
      "models": [
        { "id": "deepseek-v4.1-flash", "contextWindow": 1000000, "maxTokens": 8192 },
        { "id": "GLM-5.3-Flash", "contextWindow": 1000000, "maxTokens": 8192 }
      ]
    }
  }
}
```

`agent-control.yaml` 里的 `agent.model` 以 `<provider名>/<模型id>` 引用（如 `new-api/deepseek-v4.1-flash`），**必填——缺失直接拒绝启动**；`agent.reasoning_effort` 是可选思考级别（off→max，映射到 pi `--thinking` / codex `model_reasoning_effort`），不配则用 runner 默认。用 `provider: codex` 时 `model` 变成 codex 的 `-m` 值，`sandbox`/`review_sandbox` 生效；reviewer 可用 `review_provider`/`review_model`/`review_reasoning_effort` 独立覆盖。

## 快速开始

```powershell
cd agent-control
npm install
copy config.example.yaml agent-control.yaml   # 编辑其中的 repo/路径
npm run ac -- doctor                          # 环境检查
npm run ac -- start                           # 启动常驻调度
```

其他命令：`status`（任务一览）、`runs <issue>`（时间线+证据）、`stop <issue>`（一个轮询周期内安全取消）、`retry <issue>`（人工重批后重排队）。

## 常驻服务（Windows 计划任务）

前台验证通过后注册计划任务，登录即自启：

```powershell
schtasks /create /tn agent-control /sc onlogon /f /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"<repo>\agent-control-service.ps1\""
schtasks /run /tn agent-control     # 立即拉起，不必等下次登录
schtasks /end /tn agent-control     # 停止
schtasks /delete /tn agent-control  # 卸载
```

- `agent-control-service.ps1` 只做两件事：`cd` 到仓库根、把 `npm run ac -- start` 的输出追加到 `<数据目录>\logs\service.out.log`。脚本里的日志目录按本机约定写死，数据目录不同的环境先改它。
- 单实例由 `agent-control.lock` 心跳锁保证：旧进程死透后新实例自动接管；两个实例同时存在时后到者直接退出。
- 边界：onlogon 触发只保证"登录后起来"，**不管崩溃自愈**——进程异常退出当次不会自动拉起，救急就 `schtasks /run`。需要真自愈再上 NSSM 或给任务配 restart-on-failure。

## 使用流程

一条主线：**提 issue → 打 `agent-ready` → 等 Draft PR → 人审合并**。

1. **下任务**：在托管仓提 issue，正文写清背景 / 范围 / 验收标准 / 测试命令 / 依赖，打 `agent-ready` 标签。无标签的 issue 永远不会被执行。标签打上瞬间正文会被哈希快照——**打标签后再改内容 → `BLOCKED_APPROVAL_CHANGED`**，需 `retry` 重批。
2. **看执行**：下个轮询周期自动领取，全程无干预。围观：
   ```powershell
   npm run ac -- status        # 所有任务当前相位
   npm run ac -- runs <issue>  # 单任务事件时间线 + 证据路径
   ```
   原始证据在 `<数据目录>\logs\`：`agent-control.jsonl` 事件流 + 每轮 artifacts（agent 事件、测试日志、review 结论、diff.patch）。
3. **收口**：checks + review 全过 → 自动出 Draft PR + `agent-pr` 标签。GitHub 上打开 PR → Ready for review → 审完 Merge。调度器检测到 merged → `COMPLETED` → 自动删 worktree/分支。
4. **异常**：

   | 情况 | 表现 | 处理 |
   |---|---|---|
   | checks/review 修复预算耗尽 | issue 收到 `BLOCKED` 评论 | 看 `runs <issue>` 证据，人工处理或 `retry` |
   | 审批后正文被改 | `BLOCKED_APPROVAL_CHANGED` | `npm run ac -- retry <issue>` 重批 |
   | 中途叫停 | — | `npm run ac -- stop <issue>` |
   | 服务崩溃 | `RECOVERY_REQUIRED` 评论 | 确认子进程已死后 `retry` |

## 安全边界（MVP）

- 只接入可信测试仓库；Issue 正文只作数据，不会变成 shell 命令（测试命令只能来自仓库配置白名单）。注意：Issue 正文仍是**不可信输入**——提示词里的"数据边界"只是约定而非强制边界。环境白名单只限制传入子进程的环境变量；worktree 是工作目录约定，不构成文件访问隔离。恶意 Issue 最坏能诱导 agent 在 worktree 里写坏代码——坏代码由检查、独立 review 与人工合并拦截。不要对非本人撰写/未确认可信的 Issue 启用本工具。
- 编码/审查子进程的环境是**白名单**：只继承 PATH/用户目录/代理等最小集合，`GH_TOKEN` 及任何 `*_KEY`/`SECRET` 一律不传递（Windows 上 gh keyring 凭据仍对本机进程可见 —— 已记录的平台限制，所以只跑可信 Issue）。运行隔离按 provider 分：pi 无沙箱、reviewer 靠**只读工具白名单**（read/grep/find/ls）；codex 用 `-s` 沙箱档位（Windows 上其沙箱会导致子进程 spawn 失败，故默认 `danger-full-access`）。无论哪种，Review 后宿主都校验 worktree 必须干净、HEAD 未动——被改动即 BLOCKED。**注意**：编码 agent 实际拥有当前用户级权限，prompt 禁令只是约定而非强制边界——因此本工具只应处理你本人撰写并确认可信的 Issue。
- push / 建 PR 由宿主调度器执行，编码子进程无发布权限；所有 PR 均为 Draft，合并永远是人工操作。
- 审批内容哈希快照（SHA-256）：批准后 Issue 被改动 → `BLOCKED_APPROVAL_CHANGED`，需人工 `retry` 重批。
- 重启先对账：子进程可能存活 → `RECOVERY_REQUIRED`（绝不重复执行）；确认已死 → 按已存相位幂等续行。

## 状态机

`DISCOVERED → CLAIMED → PREPARING → RUNNING → VERIFYING ↔ FIXING → REVIEWING ↔ FIXING → PUBLISHING_PR → AWAITING_MERGE → COMPLETED`；任意运行相位可落入 `BLOCKED / FAILED / CANCELED / RECOVERY_REQUIRED`。所有迁移写入 `run_events`，测试与 Review 证据写入 `check_results`。

## 与设计的偏差（已记录）

- 宿主 Windows 原生（非 WSL2）；单实例用心跳锁文件而非 flock。
- SQLite 用 `node:sqlite`（Node ≥22.13 内置）替代 better-sqlite3。
- agent 运行面支持 `provider: pi | codex`（`agent.provider` 选择，`review_provider` 可异构）；pi 经 `~/.pi/agent/models.json` 走任意 OpenAI 兼容网关。

## 开发

```powershell
npm test            # node:test 全套（34 用例，含真实 git worktree）
npm run typecheck   # tsc --noEmit
npm run build       # → dist/
```
