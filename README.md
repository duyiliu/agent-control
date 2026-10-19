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
| agent runner 二选一 | **pi**：`npm i -g @earendil-works/pi-coding-agent` + `~/.pi/agent/models.json`（见下）；**codex**：`npm i -g @openai/codex` + `codex login`。装完跑 `pi --version` / `codex --version` 确认在 PATH 上——npm 全局前缀不在 PATH 时 shim 会装到别处 |
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

## Web 管理界面

`start` 起的调度器内嵌一个 **Linear 风格看板**（`ui/` 独立前端项目：Vite + React + Tailwind，构建产物由调度器的 node:http 静态服务）：

```
http://127.0.0.1:8788     # 端口以 agent-control.yaml 的 server.ui.port 为准（默认 8787）
```

- **五列看板**：Queued → In Progress（7 个活跃相位聚合，卡片显示具体阶段）→ Awaiting Merge → Done → Needs Attention（BLOCKED/FAILED/RECOVERY/CANCELED）。卡片带 repo#issue、相位徽章、实时运行时长、PR 链接；5 秒自动刷新。
- **详情抽屉**：点卡片右侧滑出——相位时间线（`run_events`）、checks 结果（`check_results`）、修复轮次；artifact（测试日志、review 结论、diff.patch、`run-*.jsonl`）点击弹窗查看，`.jsonl` 逐行解析成事件流——服务端强制路径必须落在 `logs_dir` 内，穿越访问返回 403。
- **操作**：Stop（= `stop`，一个轮询周期内安全取消）/ Retry（= `retry`，以当前 Issue 正文重新审批入队），均有确认弹窗。
- 顶栏健康条：pid / uptime / in-flight / last_error 警示。

开发与构建：

```powershell
npm run ui:dev     # Vite dev server（/api 代理到 8788），改前端热更新
npm run ui:build   # tsc + vite build → ui/dist（调度器服务的静态产物）
```

改前端后需 `ui:build` 并重启调度器生效。UI 启动失败（如端口被占）只记警告，调度不受影响；`stop`/`retry` 与 CLI 走同一 Store 写路径，两者可混用。

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
- 编码/审查子进程的环境是**白名单**：只继承 PATH/用户目录/代理等最小集合，`GH_TOKEN` 及任何 `*_KEY`/`SECRET` 一律不传递。磁盘凭据也被切断（2026-10-19 实测验证）：`GH_CONFIG_DIR` 指向空 jail 目录 → 子进程 `gh` 报未登录（exit 1）；`credential.helper` 清空 + 终端提示禁用 → `git` 取凭据失败（exit 128）；SSH 被 `GIT_SSH_COMMAND` 死结。**残余敞口**：gh 凭据实为 Windows 凭据管理器（keyring）条目（如 `gh:github.com:<user>`），同用户进程可枚举并调用 CredRead API 读取——绕过常规 gh/git 路径需要诱导 agent 主动编写 keyring 读取代码，属平台限制（已实证）。运行隔离按 provider 分：pi 无沙箱、reviewer 靠**只读工具白名单**（read/grep/find/ls）；codex 用 `-s` 沙箱档位（Windows 上其沙箱会导致子进程 spawn 失败，故默认 `danger-full-access`）。无论哪种，Review 后宿主都校验 worktree 必须干净、HEAD 未动——被改动即 BLOCKED。**注意**：编码 agent 实际拥有当前用户级权限（含文件系统完整读写），prompt 禁令只是约定而非强制边界——因此本工具只应处理你本人撰写并确认可信的 Issue。加固此残余敞口的轻量方向见"设计取舍"：低权限专用账户 + ACL。
- push / 建 PR 由宿主调度器执行，编码子进程无发布权限；所有 PR 均为 Draft，合并永远是人工操作。
- 审批内容哈希快照（SHA-256）：批准后 Issue 被改动 → `BLOCKED_APPROVAL_CHANGED`，需人工 `retry` 重批。
- 重启先对账：子进程可能存活 → `RECOVERY_REQUIRED`（绝不重复执行）；确认已死 → 按已存相位幂等续行。

## 设计取舍（隔离路线）

- **容器隔离为备选**（2026-10-19 决定）：设计基线与实现草案存在（分支 `container-isolation` / draft PR #1），但在"只跑本人 Issue + 人工合并"的纪律下成本收益不成立——远程 Docker host（199）无公网出口、依赖需 vendor、跨机时延与资源占用高。保留为**未来接入非本人撰写任务源时的开关**。
- **轻量加固方向**（未实施）：专用低权限 Windows 账户跑 agent 子进程——DPAPI 按用户隔离可封住上述 keyring 敞口，ACL 限制文件系统；纯系统原生机制、零运行时开销。可叠加按账户的出站防火墙规则防数据外传。

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
