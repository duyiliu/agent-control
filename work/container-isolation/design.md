# 容器隔离执行（isolation: docker）

> 设计审查：待审查
> 审查模式：未执行
> 设计审查轮次：0/3
> 设计审查范围与结论：无
> 设计版本：v1
> 设计确认：待确认
> 设计确认依据：无
> 本文件只保存稳定设计基线；执行进度、实施清单、返工状态统一放同目录 `tasks.md`。

## 1. 背景与范围

### 背景

- agent-control 在宿主机直接运行 agent 子进程（coder / reviewer / checks）。现有隔离为纵深防御的两层：
  - 环境层：`scrubEnvForAgent`（`src/proc.ts`）env allowlist + `GH_CONFIG_DIR` jail + 清空 credential helper + 死 `GIT_SSH_COMMAND`；
  - 执行层：provider=pi 用工具白名单（review 只读），provider=codex 用 `-s` 沙箱（**Windows 宿主上不可用**）。
- agent 及其任意子进程（模型指示的命令）仍共享宿主文件系统与内网可达性。需要更强的边界：把执行面关进容器。
- 运行环境为 Windows 宿主 + **远程 Docker host**（本机仅 docker CLI，经 DOCKER_HOST / context 连接 Linux daemon）。宿主路径 bind mount 不可用，文件同步必须走 volume + tar 往返。

### 目标

- 增加与 provider 正交的隔离层：`isolation: none | docker`。provider 决定跑哪个 CLI（pi/codex），isolation 决定在哪跑；pi 工具白名单与 codex `-s` 在容器内继续叠加生效。
- 启用粒度：`agent.isolation` 全局默认（none），`projects[].isolation` 可逐项目覆盖。现有项目不配置则行为零变化。
- 进容器：coder、reviewer、checks。checks 必须与 agent 同环境（agent 在容器内装的 `.venv`/`node_modules` 是 Linux 二进制，宿主机不可执行）。
- 留宿主机：worktree 创建、git 权威操作（status/diff/commit/HEAD 断言）、publish（push + `gh pr create`，凭据约束不变量）、recovery 编排。

### 非目标

- 容器网络 ACL（v1 用默认 bridge 网络，容器需可达内网模型 API 如 new-api；边界靠 fs/凭据/env 隔离）。
- 增量文件同步（v1 全量 tar 往返，项目体量小可接受）。
- 本地 Docker 的 bind mount 快路径（volume+tar 方案对本地/远程 host 行为一致，v1 只做这一条路径）。
- Windows 容器 / podman 等其他运行时。

### 本次范围

- `src/runners/container.ts`（新）、`src/proc.ts`（stdin 流式）、`src/runners/{pi,codex}.ts`（容器分支）、`src/scheduler/engine.ts`（会话编排 + commitLeftovers 升格）、`src/verify/checks.ts`（isolation 参数）、`src/scheduler/recovery.ts`（容器孤儿检测）、`src/config.ts` + `src/types.ts`（配置面）、`src/app.ts` doctor、`docker/Dockerfile`（新）、tests、README / AGENTS.md。

### 现有能力 / 可复用内容

- `runProc`（argv spawn、timeout、kill 树、stdout→logPath）——容器模式 kill 的是 `docker.exe`（宿主 PID），超时/中止语义不变。
- `scrubEnvForAgent`——继续用于注入 docker CLI 进程 env 与容器内 env（GIT_CONFIG_\* jail、GH_CONFIG_DIR jail）。
- `engine.commitLeftovers`（现有 host fallback commit）——容器模式下从 fallback 升格为 coder 会话后的标准步骤。
- `runReview` 的证据传参（testEvidence/diffEvidence 均为宿主生成的文本）——reviewer 不依赖容器内 git。
- Windows 自带 `tar.exe`（bsdtar）打包；`docker cp`、`docker volume`、`docker ps --filter` 均为标准 CLI 能力。

### 影响范围

- 高成本契约：agent 工作流语义（容器内无 git，见 2.4-A）；checks 执行环境语义（config 中 `checks[].argv` 必须在容器镜像内可执行）；recovery 孤儿判定。
- 不涉及：DB schema（无新表新字段，volume/容器名由 `run_id` 派生）、tracker、publish 流程、store。

## 2. 设计

### 2.1 业务流程与状态

- 核心对象：`ContainerSession`（一次 agent/checks/review 调用 = 一个会话）。
- 会话协议（对 engine 透明，封装在容器执行层内）：
  1. 建卷：`ac-wt-<runid>`（worktree 数据，会话末删）、`ac-ac-<runid>`（artifacts：prompt / codex `-o` 输出，会话末删）、`ac-cache`（uv/npm 缓存，跨会话持久，避免每次重装依赖）。
  2. 上行 syncUp：宿主 `tar.exe` 打包 worktree 工作文件（排除 `.git`、`.venv`、`node_modules`、`target`、`__pycache__`）→ 宿主临时 tar 文件 → `runProc` 以文件流式 stdin 推给 `docker run -i -v ac-wt-…:/work alpine tar -x`。
  3. 执行：`docker run --rm --name ac-run-<runid> -v wt:/work -v ac:/ac -v cache:/root/.cache -w /work image <容器内 argv>`；stdout/stderr 由 runProc 照常捕获并写宿主 logPath；退出码透传。
  4. 下行 syncDown：容器内 tar 打包 `/work`（排除依赖目录）→ 拉回宿主临时文件 → **清单对账删除**（先取容器内文件清单，宿主 worktree 中不在清单且不属排除/`.git` 的文件删除）→ 解包覆盖宿主 worktree（不含 `.git`）。
  5. 清理：`docker rm -f ac-run-<runid>`（幂等兜底：runProc kill 掉 docker.exe 后 attached 容器可能残留）→ 删 `ac-wt-` / `ac-ac-` 卷。
- 状态与流转：不新增 engine phase。RUNNING/FIXING/VERIFYING/REVIEWING 内部各自成会话，多轮 FIXING = 多个会话，天然正确。git 状态由宿主在每个 coder 会话后 `commitLeftovers` 固化，REVIEWING 的 HEAD+clean 断言逻辑不变。
- 关键异常：syncUp/syncDown 失败或超时（独立短超时，默认 120s）→ 当次调用按 infra failure 处理，进入现有 FIXING/FAILED 路径；容器名冲突（并发残留）→ `docker rm -f` 后重建。

### 2.2 数据 / DB

- 无新表、无 schema 变化。`runs.workspace` 沿用宿主 worktree 路径；`runs.pid` / `process_identity` 沿用（容器模式下记录的是 `docker.exe` 宿主 PID）。
- 卷与容器命名由 `run_id` 派生（`ac-wt-<runid>` 等），recovery 可反查。

### 2.3 API / 交互契约

配置面（`config.example.yaml` 同步更新）：

```yaml
agent:
  # isolation: none            # 全局默认 none | docker
  container:                   # isolation=docker 时必填 image
    image: agent-control-dev:latest
    # network: bridge          # docker run --network
    # extra_args: []           # 追加 docker run 参数
projects:
  - repo: …
    # isolation: docker        # 覆盖全局默认
```

- `agent.isolation` 缺省 `none`；`projects[].isolation` 缺省继承全局。config 解析校验：isolation=docker 时 `agent.container.image` 必填非空。
- 容器内路径映射（内部契约）：worktree→`/work`，artifacts 卷→`/ac`。pi prompt 经 `docker cp` 进 `/ac`，argv 用 `@/ac/prompt.txt`；pi lastMessage 从 stdout JSONL 宿主侧提取（不变）；codex prompt 走 stdin（不变），`-o /ac/last.txt` 会话后 `docker cp` 回宿主。
- 认证契约：pi `models.json` / codex `auth.json` 由宿主 `docker cp` 进 `/ac`，镜像 entrypoint 启动前拷至容器内 home。API key 只经 auth 文件进容器，**永不进 env**；GitHub 凭据任何形式都不进容器（与 publish 宿主专属不变量互为印证）。

### 2.4 其他关键设计

- **A. 容器内无 git（高成本契约）**：worktree 的 `.git` 是指向宿主绝对路径的文件，远程 host 下无法还原 worktree 语义；双向同步 `.git` 风险高。决定：`.git` 不上行，容器内不提供 git。配套：
  - 容器模式 coder/reviewer prompt 变体：「本环境无 git，当前文件即最新状态，直接修改文件」（替换 `git add -A && git commit` 要求与 status/log 恢复语义；上行快照即现状）；
  - coder 会话结束宿主必调 `commitLeftovers`（宿主 git 权威固化改动）；
  - diff/HEAD 断言/publish 全在宿主。
- **B. 镜像**：`docker/Dockerfile` = node:22-bookworm + git + gh + pwsh（保持 pi 工具集完整）+ python3.12 + uv + `npm -g @earendil-works/pi-coding-agent` + entrypoint（auth bootstrap 后 `exec "$@"`）。构建：`docker build` 经 CLI 传 context 至远程 host。
- **C. proc.ts**：`runProc` 增加 `stdinFilePath`（createReadStream → child.stdin），不破坏现有调用。kill 链不变（杀 docker.exe + 树）。
- **D. recovery 适配**：现有进程扫描（`findProcessesReferencing(worktree)`）在容器模式下盲区——`docker.exe` 命令行不含 worktree 路径，且容器可独立于 docker.exe 存活。增加 `findContainerStrays(runId)`：`docker ps -a --filter name=ac-run-<runid>`（running 状态即视为孤儿）；进程扫描照旧作为宿主侧兜底。两者任一非空 → `RECOVERY_REQUIRED`（语义不变：绝不双进程/双容器操作同一 worktree）。残留卷按 runid 前缀在 reconcile 时清理。
- **E. doctor**：isolation=docker 时检测 `docker version`（验证 DOCKER_HOST 连通）、`docker image inspect <image>`、并提示 checks argv 需容器内可执行。
- **F. 超时**：syncUp/syncDown 各自独立超时（默认 120s，可配），不计入 `max_task_minutes` 的 agent 超时；容器执行超时沿用现有 `timeoutMs`。

## 3. 边界与风险

- 权限 / 安全边界：
  - 容器内 root 运行，fs 边界 = 三个命名卷；env 经 scrub（模型代理变量除外）；GitHub 凭据零进入。
  - 网络为默认 bridge：容器可达内网（模型 API 必需，也是已知放宽——agent 理论上可探测内网，v1 接受并文档声明）。
- 兼容性：不配置 isolation 的项目行为逐字节不变；`checks[].argv` 语义随 isolation 变化（宿主命令 → 容器内命令），切 isolation 的项目需自查 argv（文档写明）。
- 主要风险：
  - Windows bsdtar ↔ 容器内 tar 互操作（用公共格式，集成验证覆盖）；
  - 全量 tar 往返的性能（首次会话装依赖最慢，cache 卷缓解二次起）；
  - 清单对账删除的误删面（对账排除 `.git` 与排除规则目录；下行解包仅覆盖 `/work` 内文件）。
- 不可逆点 / 回滚要求：无数据迁移；卷与容器一次性，删除即回滚。`isolation` 配置回 `none` 即完全回到现状路径。

## 4. 验收与验证

| ID | 验收标准 | 验证方式 | 通过标准 |
|---|---|---|---|
| AC01 | 未配置 isolation 的项目，全流程行为与现状一致 | 现有测试全绿 + 对未配置项目跑一轮真实调度 | 行为无差异，日志无容器调用 |
| AC02 | isolation=docker 的项目：coder 改动落回宿主 worktree 并被宿主 git 识别 | 真实容器会话：容器内改文件 → 会话结束 `git status` | 宿主 worktree 出现等价改动，`commitLeftovers` 产生提交 |
| AC03 | 容器内删除的文件在宿主同步删除 | 容器内删文件 → syncDown → `git status` | 宿主对应文件消失 |
| AC04 | checks 在容器内执行且退出码/日志宿主可见 | 配置一条容器内可跑的 check 跑 VERIFYING | check 结果入库，日志写宿主 artifacts |
| AC05 | 宿主 GitHub 凭据不进容器 | 会话内 `docker exec`（或会话后审计）检查 env 与文件 | 无 GH_TOKEN/GITHUB_TOKEN、无 gh 认证文件 |
| AC06 | 容器残留可被 recovery 识别，绝不双容器操作同一 worktree | 制造 docker.exe 被杀而容器存活的场景 → 重启调度 | 该 run 判 `RECOVERY_REQUIRED` |
| AC07 | agent 超时/中止后无容器残留 | 触发 timeoutMs/abort | `docker ps -a` 无 `ac-run-<runid>`，卷已删 |

> 单元测试覆盖：config 解析、容器 argv/路径映射（Windows 路径→volume 语法）、排除规则与清单对账纯函数、recovery 容器分支。AC02–AC07 为真实 Docker 集成验证，前置 `doctor` 确认 DOCKER_HOST 连通。

## 5. 确认项

### 阻塞确认项

- 无（远程 host 形态、per-project 覆盖粒度已由用户确认；「容器内无 git」为需在 Design Review 中重点对抗的高成本契约）。

### 非阻塞待确认项

- 网络是否需要收敛为「仅模型 API 可达」（依赖远程 host 上的网络策略能力，v1 不做）。
- 镜像内 Python 版本策略（3.12 固定 vs uv 托管多版本，按首批容器化项目需求定）。
- syncUp/syncDown 独立超时的默认值（120s）是否合适，待实测。
