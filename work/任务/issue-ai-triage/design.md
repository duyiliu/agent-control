# Issue 默认接手与执行内判断

> 设计版本：v7，单执行看板，替代 v5 独立 AI 分流方案
> 设计审查：PASS，v7阶段 2/3；模式：independent；Reviewer：issue_triage_design_review；Critical/High/Medium/Low 均为 0
> 设计确认：用户在单看板修订后回复“处理吧”（2026-10-23），授权实施
> 依据：2026-10-23 用户在“默认接手、取消独立评估、ready 不再作为默认入口”讨论后回复“按照这个来吧”。
> 本文件只保存设计基线；执行记录见 tasks.md。旧 v5 的完成记录只对旧方案有效。

## 1. 目标与范围

程序分页发现配置项目的开放 Issue，符合条件的新 Issue 直接进入任务队列。
同一个长期 Pi 编码会话理解需求，能处理则继续实现；无法推进时说明原因并停下。
移除独立分流模型调用、分流工作树及分流领取/代次/路由指纹协议。
复用 tasks/runs、唯一活动 run、执行领取、凭据隔离、固定 SHA 审查、发布和合并。
仅改变启用自动接手的项目；其他项目保留标签入口。首次扫描包括存量开放 Issue，但保留已有任务及人工处置。
不新增业务 phase，不重写评审/合并，不建设分布式人工操作协议。

## 2. 高成本契约

### 2.1 发现与全部执行 gate

- 新增 issue_intake: all | labeled，缺省 labeled；all 表示本项目开放 Issue 默认可领取。
- 兼容旧 issue_triage.enabled=true 为 all；显式 issue_intake 优先。timeout_seconds 弃用并提示。
- all 模式在发现、准备、运行、验证、发布各处均不要求 agent-ready，不自动添加该标签；labeled 保留 ready_label 原语义。
- agent-human-hold、agent-needs-human、本地暂缓/跳过及待同步操作均阻止新 run。
- agent-running 沿用既有执行领取机制；旧分流 claim 不转为编码所有权。
- UNIQUE(repo, issue_number) 与任务历史防重复：已有完成、失败、取消、BLOCKED 或评审任务不因扫描自动 retry。
- all 的未运行 DISCOVERED 任务启动前取最新标题、正文及人工评论；不沿用人工批准 hash 作为 ready 门槛。
- 领取后固定输入快照，保留既有运行期间内容变化保护；默认入口不能绕过安全检查。
- 扫描不调用模型，不占 Agent 并发槽。

### 2.2 同一次编码会话的结果

不增加评估回合，Agent 在同一工作目录和会话内理解并执行。首次常规编码回合支持提前结束，FIXING/冲突修复不增加分流入口。
最终消息是唯一 JSON 对象：
`{"outcome":"IMPLEMENTED|NEEDS_HUMAN|DEFER|NO_ACTION","reason":"具体原因"}`。
reason 必须非空、有长度上限。IMPLEMENTED 进入现有检查和发布。
其他结果在 commitLeftovers 之前截获，不验证、不发布；宿主保存结构化结果和理由。

非 IMPLEMENTED 必须工作树干净且 HEAD 等于本次回合开始 SHA；否则保留现场，以 BLOCKED 结束并提示“已有改动需人工处理”，不得自动删除或发布。
缺失/非法结果 fail closed 到 BLOCKED，保留现场；exit 0 不代表实现完成。
部署前已有 run 使用持久化的旧协议版本，升级后仅 all 模式新 coding run 使用新契约；labeled 维持旧输出行为，恢复不得猜测协议。

- NEEDS_HUMAN：任务 BLOCKED，在执行看板待人工列显示缺失信息。
- DEFER：任务 BLOCKED，在执行看板暂缓筛选中显示；到期只提醒。
- NO_ACTION：任务 BLOCKED，在执行看板历史筛选中显示，说明无需处理；不自动关闭 GitHub Issue，不伪报代码完成。
- IMPLEMENTED：现有检查、审查、合并闸门全部保留。

人工处置后需显式“继续处理”；仅改 Issue 或评论不解除人工/暂缓/跳过。
继续处理通过现有 retry 创建新 run，不复用结束 run 的活动身份；保留旧现场和历史。all 模式 retry（包括 src/ops.ts）不要求 ready，仍校验 Issue 开放、门禁同步已完成及已有 PR/任务状态；labeled 保留原 ready 校验。显式继续先保存解除处置意图，门禁同步完成后幂等应用 retry；同步失败不提前重排。

### 2.3 状态、人工动作与并发

一个 repo 的 all 入口和人工处置由一个实例管理。其他实例应关闭该 repo 自动接手；保留现有执行 claim 仲裁，但不承诺多个实例共享人工操作的强一致。

SQLite 为本地处置权威，以 repo + issue_number 唯一保存：kind=human|deferred|skipped|null、reason、locked、可选提醒时间、version、updated_at、pending 标签移除动作。
迁移现有 triage_cache，并区分持久化处置与可清理快照；不能因清缓存丢人工状态。
run 结束和处置记录通过同一 Store 事务落地；保留 endRun/transition 及事件不变量。

人工动作直接落库，不获取分流 claim，不调用 AI：
- 继续处理：清除本地阻塞/锁；已有可重试任务走现有 retry。已完成/合并任务拒绝隐式重跑。
- 暂缓或锁定：只允许尚未运行或已结束任务；活动 run 返回冲突，使用既有“停止任务”。
- 解除锁定：只清 locked，保留其他阻塞；重复解锁成功且无副作用，不能因为 busy 再加锁。

动作携带 expected_version；旧版本返回冲突及最新卡片，相同目标已达成的重试返回成功。
响应表示本地持久化完成，包含新卡片/version。前端显示处理中、立即应用响应，再刷新；旧轮询不能覆盖较新版本。

GitHub 外部 hold/needs-human 标签继续否决入口。明确继续/解锁若需移除远端标签，先落库记录 pending，后台幂等同步；成功前不派发，显示同步中/失败原因。
只重试最新 version 的动作，重试不得反转操作或创建重复任务。不自动生成新的正向放行标签。
GitHub 评论只作可选审计通知，失败不撤销已持久化结果。暂缓/跳过不再依赖机器评论做事务。

### 2.4 看板与接口

执行看板展示排队、运行、检查、评审等既有状态。
删除独立 Issue 分流页面和导航。所有已发现 Issue 均创建唯一 task，同一执行看板展示排队、运行、待人工；暂缓/跳过在同看板筛选或收起区查看，无待评估/评估中。任务卡与详情展示处置原因、锁定及继续/暂缓/锁定操作；不得重复生成第二张卡。
展示具体理由、锁定及同步反馈，不新增技术状态列。
保留 /api/triage 和 /api/triage/actions 的鉴权与项目范围。
approve/reevaluate/recover 映射为明确继续，文案统一，不再启动独立评估。
迁移异常卡提供恢复入口；旧 claim 需先在 GitHub 核验 owner 并明确解除，恢复动作校验本机旧进程安全且无未释放 claim，不能清编码 claim。

### 2.5 迁移与运行时切换

- additive migration，保留旧缓存、jobs 和历史；不删除原始数据。
- 旧任务不自动 retry；正在编码、评审、合并的任务继续按旧记录运行。
- 旧分流进程按 PID + identity + deadline 核验；不确定则隔离，不启动第二份。未确认退出前不让对应 Issue 进入新领取；旧模型结果不得继续写 ready。
- 首次 all 扫描分页读取可信旧状态，导入 HUMAN/DEFER/SKIP/人工锁定；AUTO 及无门禁项可排队。
- 评论分页失败、重复/损坏/作者不可信、pending_action 或未释放 claim 均保留人工核验，不默认为新 Issue。
- 按 repo + issue 幂等导入；迁移异常也创建唯一 BLOCKED task 卡承载人工核验/恢复，只暂停派发，恢复后复用同一 task；本地状态存在后不再让旧评论覆盖它。
- 旧 MANAGED/ready 可留审计，不新增 managed 标签；存量暂缓/跳过不会因为升级重跑。
- 重启前核实活动 run 和旧分流进程，用计划任务管理；不停止身份不明的进程。
- 启用前展示待领取数量；代码完成、构建、运行时启用分开报告。真实切换不借测试批量启动业务 Issue。
- 切换前备份 DB/config；回滚须恢复一致的切换前数据与配置，不能只回退代码。

## 3. 验收

| ID | 可观察结果 | 验证与通过标准 |
|---|---|---|
| AC01 | 无 ready 默认排队 | all 多页含 PR 列表只注册 Issue，扫描零模型调用 |
| AC02 | 项目隔离 | labeled 仍需 ready，未配置项目不扫描 |
| AC03 | 不重复启动 | 多 tick/重启/完成/失败/人工状态不增加 run |
| AC04 | 人工门禁有效 | hold/needs/defer/skip 阻止启动，解锁不清其他阻塞 |
| AC05 | 同会话判断执行 | IMPLEMENTED 进入检查，其他结果无 push/PR |
| AC06 | 非法输出安全结束 | 非法 JSON/带修改的非执行结果 BLOCKED 并保留现场 |
| AC07 | 动作可靠 | 重复解锁无重锁，旧版本冲突，慢 GitHub 不丢本地动作 |
| AC08 | 旧数据安全 | DEFER/SKIP/HUMAN/损坏/pending/claim/活 PID 不被误启动 |
| AC09 | 安全能力保持 | 凭据隔离、唯一 run、旧会话恢复、SHA 审查和合并 gate 保持 |
| AC10 | 界面一致 | 无独立评估状态；响应立即更新，旧轮询不覆盖 |
| AC11 | all 贯穿全部 gate | 无 ready 能进入检查发布；门禁和输入漂移保护有效 |

按此前端到端测试授权，实施后执行对应单测、类型检查、构建与安全 API 验收。真实 approve 可能自动合并，使用隔离 fixture，不在业务 Issue 制造测试 PR。
浏览器不可用时如实记录未覆盖 UI 点击验收。

## 4. 确认项

阻塞业务未知：无。单实例入口权威、人工后显式继续及存量迁移是本版具体落地契约。
非阻塞：实施时核实浏览器验收环境。
