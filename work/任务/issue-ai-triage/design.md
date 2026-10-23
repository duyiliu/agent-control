# GitHub Issue AI 分流

> 设计审查：PASS（v5 第 3 轮，Critical/High/Medium/Low 均为 0）  
> 审查模式：independent  
> 设计审查轮次：3/3  
> 设计审查范围与结论：首审与前序修订覆盖发现、共享状态、人工门禁、并发恢复、看板与兼容；第 3 轮增量核对派发路由复核及 active run 收尾，所有阻塞 finding 已闭合。Reviewer：issue_triage_design_review；2026-10-23。  
> 设计版本：v5  
> 设计确认：用户已确认未锁定 HUMAN 自动重评、锁定后显式处理；当前完整 v5 待用户确认，尚未进入实现  
> 本文件只保存稳定设计基线；执行进度见同目录 `tasks.md`。

## 1. 背景与范围

### 背景

当前调度器只通过 `agent-ready` 查询开放 Issue。没有该标签的 Issue 不进入任务表，也就无法由 AI 判断是否适合处理。目标是让配置项目中的开放 Issue 都能被发现，由 AI 做一次只读分流，再按结论接入现有执行链。

### 目标

- 首次启用时分页扫描全部开放 GitHub Issue；后续周期发现新增和内容变化的 Issue。
- AI 判断可执行、需人工、暂缓或跳过。
- 可执行项由宿主添加既有 `agent-ready` 标签，复用现有 Issue → task → run 流程。
- 需人工项添加 `agent-needs-human`；人工锁定使用独立的 `agent-human-hold` 标签；每个已进入分流的 Issue 使用 `agent-triage-managed` 标记状态记录已初始化。
- 每个 Issue 维护一条由 agent-control 编辑更新的机器状态评论，跨实例共享当前输入指纹、决策、代次和待执行标签动作；不发布自由文本 AI 分析评论。
- 暂缓与跳过不增加专用 GitHub 状态标签、不启动 coding task；共享状态保存在一条机器状态评论中。
- 看板提供人工放行、暂缓、恢复分流操作。

### 非目标

- 不自动关闭 Issue 或修改 Issue 正文；不发布自由文本 AI 分析评论。为跨实例幂等，允许创建并原位更新一条机器状态评论，显示当前分流结论/理由并保存同步元数据。
- 不改造现有编码、检查、PR 评审、合并状态机。
- 不把模型建议直接当成 PR 合并批准；所有现有风险闸门继续生效。
- 不支持 Linear 等额外 Tracker。

### 范围

`src/tracker/github.ts`、`src/types.ts`、`src/config.ts`、`src/store/sqlite.ts`、`src/scheduler/engine.ts`、`src/runners/pi.ts` / prompt、`src/ui/api.ts`、`src/ui/server.ts`、`ui/src/App.tsx` 及新增分流视图；同步更新 `AGENTS.md`、README 和配置示例。

## 2. 设计

### 2.1 分流流程与状态

```text
全部开放 Issue（分页）
  ├─ 有活动 run / 非 DISCOVERED task → 交给既有状态机
  ├─ agent-human-hold → 保持人工锁定（优先于 ready，且禁止自动重评）
  ├─ agent-running → 按共享 claim marker 恢复、等待或显示待人工核验
  ├─ agent-triage-managed + agent-ready → 校验路由指纹；过期时撤销 ready 并重评
  ├─ 无 agent-triage-managed 的 agent-ready → 兼容旧人工放行，交给既有调度
  ├─ agent-triage-managed 存在但状态评论缺失 → 人工修复，不自动猜测决策
  ├─ 有效状态评论且内容指纹未变 → 遵从已保存决策/重试标签 outbox
  └─ 首次扫描、未锁定内容已变或人工要求重评 → 只读 AI 分流

`agent-needs-human` 始终阻止 coding dispatch，但未锁定时不阻止内容变化触发 AI 重评。
       ├─ AUTO   → 主机添加 agent-ready → 指纹复核通过后现有调度器创建 task
       ├─ HUMAN  → 记录理由并添加 agent-needs-human
       ├─ DEFER  → 记录暂缓；内容未变前不再调用 AI
       └─ SKIP   → 记录跳过原因；内容未变前不再调用 AI
```

- 没有 `agent-triage-managed` 的既有 `agent-ready` 继续按兼容路径直接进入现有流程；分流管理过的 Issue 必须有匹配的路由来源、代次和内容指纹，单独手工添加 `agent-ready` 不构成对旧 AI 决策的人工放行。看板人工放行会先把路由来源写为 `human` 并绑定当前指纹，再写入该标签。
- `agent-needs-human` 表示“编码开始前需要人工判断”。AI 判为 HUMAN 时默认未锁定，Issue 内容变化会自动重评；人工锁定需添加 `agent-human-hold`，该 GitHub 标签是所有实例共享的权威信号。锁定后内容变化不触发自动重评；人工放行、暂缓或显式重新评估会按对应动作清除锁定。
- 暂缓与跳过不是 task 状态。暂缓可选提醒时间；到期只回到分流收件箱，不自动放行。任何未人工锁定的 AI 分流结果（含 HUMAN）的 Issue 内容变化都会触发重评；重评期间保留 `agent-needs-human` 门禁。新决策持久化后，HUMAN 继续保留门禁；AUTO/DEFER/SKIP 通过 outbox 清理旧门禁后再应用新路由。人工也可显式要求重新评估或放行。
- 人工确认/暂缓、AI 结果、模型失败等分流记录不进入 `tasks` / `runs`；AI AUTO 或人工明确放行后才进入现有任务状态机。`Store.claimRun` 是本轮执行领取点；领取后的 Issue 新修改不回溯取消既有 run，运行使用领取前最后复核通过的输入快照。
- 用户可见分流状态仅为“待 AI 分流、待人工核对、暂缓”；人工锁定是待人工状态上的保护标记，不增加状态列。AI 自动通过的项转入执行看板，跳过项不进入主视图。模型调用中的 PID、重试次数属于技术元数据，不新增业务状态列。

### 2.2 AI 与输入契约

- AI 使用 Pi one-shot 调用和只读工具白名单（`read/grep/find/ls`），输入包含 Issue 标题、正文、相关人工评论、仓库可信约定，以及从配置远端获取并固定的 base SHA 对应代码现场。共享机器状态评论不是 AI 输入。
- Issue 内容明确作为数据，不是系统指令；AI 无 GitHub 写工具，不接触 GitHub 凭据。
- 只接受严格 JSON：`{"decision":"AUTO|HUMAN|DEFER|SKIP","reason_code":"..."}`。原因码限定为 `clear_in_scope`、`unclear_requirements`、`out_of_scope`、`duplicate_or_resolved`、`high_risk`、`needs_human_context`、`not_actionable`、`temporary_wait`、`model_unavailable`、`invalid_output`、`human_requested`。字段缺失、额外字段、非法值、截断或模型错误都不放行，有限重试后转 HUMAN 并使用对应固定码。
- AUTO 仅在需求清楚、属于项目范围、没有明显重复/已解决线索且风险可控时成立。含糊、影响范围较大、代码现场无法确认、权限/认证/密钥、数据迁移/删除、公共契约或构建/依赖变更一律 HUMAN。
- 保存决策时绑定 Issue 输入指纹与 base SHA；指纹包含标题、正文和非 bot 人工评论，不包含标签，避免系统加标签触发重评。评论必须分页读取并携带 author login/type；忽略 bot 与 `agent-control` claim/state marker。AI 只输出固定原因码，不生成自由文本解释；看板把原因码映射为固定中文说明。base SHA 是判断证据，不单独作为重评触发器；用户可手动要求重评。

### 2.3 持久化、幂等与并发

- 每个 scheduler tick 完整分页枚举配置 repo 的开放 Issue 并过滤 PR；不使用水位游标。列表分页失败时不推进未见 Issue 的状态，评论分页失败时不推进该 Issue 的共享状态；下个 tick 从头重扫。评论需带 author login/type；输入指纹含标题、正文和非 bot 人工评论，排除 bot、claim marker 与机器状态评论。
- GitHub 为跨实例共享状态源：每个 Issue 最多一条 agent-control 机器状态评论，由 host 创建后原位编辑。评论只写固定模板、决策与原因码，不包含 AI 自由文本；字段包括版本、`generation`、决策输入指纹、base SHA、模型、决策时间、defer deadline、`route_source`、`route_input_hash`、`route_generation`、pending action 和有界决策历史。`route_source` 仅为 `ai`、`human` 或空值；路由指纹绑定这次 `agent-ready` 的授权输入。作者必须匹配当前 `gh auth` 用户；重复、作者不符或格式错误时 fail closed 到人工核验。SQLite additive migration 保存该评论解析结果、历史缓存、人工锁标签缓存、PID/身份、调用 deadline、claim ID 与日志路径；本地状态不能覆盖较新的远端 generation。
- 首次写状态评论时同时添加 `agent-triage-managed`。若该标签存在但状态评论缺失，Issue 进入人工核验，不会被当作新 Issue 再次 AI 分流；看板提供“恢复状态并重新评估”动作，成功 claim 后创建新的状态评论并标注历史不完整。若评论存在但标签缺失则幂等补齐标签。看板重置通过新 generation 清空 `decision_input_hash` 并撤销 route 字段、保留最后 decision 作为后续 outbox 的 `previous_decision` 和保留全部历史，不删除状态评论；扫描器据空指纹重新评估。取得 claim 前复核 Issue 开放且无 task、`agent-ready`、`agent-running`、`agent-human-hold`；赢得 claim 后再次读取 Issue、marker、task 和标签，确认仍无 task/ready/hold、`agent-running` 由本次 claim 持有且 marker generation 未变化，否则不写 reset 并只释放自己的 claim。若用户在 GitHub 外部同时删除状态评论和 marker 标签，只有同样无 task/ready/running/hold 时才视为重置，此操作会丢失远端共享历史。冲突时 task/ready/claim/hold 优先，扫描器不得据缺失 marker 绕过它们。
- DEFER/SKIP 即使没有 GitHub 标签，也由共享状态评论中的决策和内容指纹抑制其他实例重复调用；任何实例发现内容指纹变化后都可竞争一次 claim，更新后的共享 generation 令其他实例跳过。看板历史读取该共享记录，不因服务切换丢失。
- 远端已有 `agent-needs-human` 但没有有效状态评论时，按人工核验项展示，不自动清标签或派发。人工锁定由 `agent-human-hold` 表示，GitHub 标签是跨实例权威状态；锁定期间不因内容变化重评，AI/outbox 不得清除。看板锁定/解锁通过 GitHub 添加/移除该标签。`agent-needs-human` 只挡编码；只有 `agent-human-hold` 会挡自动重评。
- 所有改变共享分流状态的操作（开始 AI 轮次、提交模型决策、人工放行/暂缓/重评）都先用 `agent-running` 与唯一 claim marker 取得该 Issue 的跨实例 claim，再增加 `generation` 并更新机器状态评论。模型启动时记录 generation；完成时重读评论并要求 generation 与 claim ID 未变，否则丢弃结果。人工动作使旧 generation 失效；旧模型结果和旧 outbox 永远不能覆盖较新状态。
- 人工动作与在途 AI 并发时，人工操作先添加 `agent-human-hold` 作为全局保护，再等待/竞争 claim；没有取得 claim 前不更新决策状态。取得 claim 后先把新 generation、目标决策和完整 pending action 写入共享 marker，再执行标签动作。人工暂缓固定顺序为：持久化 DEFER 与 pending action，移除 `agent-needs-human`，最后移除 `agent-human-hold`，两项成功后清空 pending action；任何步骤失败都保留 pending action，若移除 hold 这一步尚未成功则 hold 继续保护。若 hold 已移除但 marker 清除失败，DEFER 已持久化、ready 不存在，pending action 可安全重试；绝不添加 `agent-ready`。人工放行和重新评估也只在明确用户动作下清锁。人工放行在加 ready 前将 `route_source=human`、当前 `route_input_hash` 和 `route_generation` 写入 marker。
- 每种 AI 结论都通过 outbox 路由：AUTO 添加 `agent-ready`；HUMAN 添加 `agent-needs-human`；DEFER/SKIP 不添加 ready，并在旧决策为 HUMAN 时清除由该决策产生的 `agent-needs-human`。outbox 保存 `generation`、决策输入指纹、`previous_generation/previous_decision`、动作类型及路由指纹。只有值与共享记录一致、无 `agent-human-hold`、无 task 冲突，且旧 needs-human 确认由 `previous_decision=HUMAN` 产生时，才可清除该标签；每次标签写入前重读 Issue 与共享状态。人工 hold 只能由持有 claim 的明确人工动作清除。
- `agent-triage-managed` Issue 的 ready 路由在发现和派发两处校验：AI AUTO 必须满足 `route_source=ai`、`decision=AUTO`、route generation 与 marker generation 相同，且 `route_input_hash` 等于重新分页计算的当前 Issue 指纹；看板人工放行使用 `route_source=human`、当前 `route_input_hash` 和匹配的 generation，原 `decision` 保留为历史判断，不要求其为 AUTO。任何非空 pending action、`agent-needs-human`/`agent-human-hold` 门禁、过期指纹、代次或路由来源不匹配都会阻止建 task/领取 run。无 marker 的旧人工 ready 保持兼容。
- 指纹过期时先取得分流 claim，递增 generation 并将撤销 ready 写入 pending action，再清除分流管理的 ready；pending action 清空后用最新内容启动重评。已由竞争窗口创建但仍为 `DISCOVERED` 且没有 run 的临时 task 保持不派发，若重评不是 AUTO 则经受限 Store 操作清理该未运行占位，操作必须在事务内断言 task 仍为 DISCOVERED 且不存在任何 run；后续 AUTO 可复用尚未清理的占位。
- `tryDispatch` 完成依赖和已有 PR 检查后，在 `Store.claimRun` 之前最后重新读取 Issue、完整评论和共享 marker，复核 generation、route fingerprint、pending action 及人工门禁。失败或读取不完整时不调用 `claimRun`，不添加执行 claim、不启动子进程，task 保持 DISCOVERED 并回到分流协调。校验通过后才按既有顺序 `claimRun → GitHub 执行 claim 仲裁 → launch`；本轮 coder 使用该次校验对应的固定 Issue/评论快照，快照与路由指纹写入 run artifacts。执行领取后发生的 Issue 修改交给既有任务生命周期处理，不再属于领取前重评分支。`claimRun` 之后的失败仍必须通过 `endRun`/`Store.transition` 收尾并写 run_events，不允许仅移除标签后遗留 active run。
- claim 的正常生命周期覆盖 AI 调用、决策提交和该 generation 的 outbox。所有终态（AUTO/HUMAN/DEFER/SKIP/模型失败转人工）在结果与 pending action 已远端持久化且子进程退出后都必须结束本轮 claim；无待动作或 outbox 失败可重试时都释放 `agent-running`，供任一实例重新 claim 并幂等重试。若 `agent-ready` 已写入但 pending action 尚未清空，发现和派发 gate 必须阻止它进入 task/run；这使释放 claim 不会提前派发。释放前重读 Issue 和 marker，确认唯一 claim ID 仍属于本实例且 pending action 已可靠持久化；无法证明 owner、Issue 或 marker 状态时不移除 `agent-running`，交由人工核验。claim comment 保留作审计，不作为活跃锁。
- 跨实例认领复用 `agent-running` label 和 claim comment，但分流使用包含唯一 claim ID 的新 marker，每个实例（包括同 hostname）都参与仲裁，不能复用会忽略同 hostname 竞争者的旧 helper。领取者先添加 label、再写 marker，等待 settle window 后完整读取近期 claim marker；按 GitHub comment 的创建时间及 ID 决定唯一赢家。评论读取失败、marker 冲突、赢家不确定或 label 在仲裁期间消失时必须停止，不运行模型、不写 ready；不得套用现有“同 host claim 当作旧 ghost”的宽松分支。输家不得移除赢家的 label。无法证明自己仍是赢家时不得释放 label；这可能留下需要人工核验的 claim，但不会冒险并行分流。看板提供“确认 owner 已退出后解除认领并重评”操作，动作前校验无 task、远端 Issue 仍有 running 标签，且要求人工确认旧进程已退出；不自动超时抢占。不得另增 `agent-triaging` 标签。
- scanner 遇到 `agent-running` 时，若本机 DB 有匹配的分流 claim，则恢复/监视该调用；否则从共享状态评论与近期 marker 判断 owner，无法确认时显示待人工核验。看板提供“确认 owner 已退出后解除认领并重评”动作；提交时重读 Issue 与 marker，要求 claim ID 仍相同、无 `agent-human-hold`、无 task 且远端仍有 running 标签，再要求人工确认旧进程已退出。若有 `agent-ready`，仅当它属于有效的 triage marker 且其 pending action 会让派发 gate 保持关闭时才可释放；无 marker 或路由冲突的 ready 必须先人工处理。清理未知 claim 后，下个 tick 由任一实例 claim 并重试 pending action；不自动超时抢占，无法识别 triage claim ID 时不提供自动清理动作。
- graceful shutdown 中止分流进程并有界等待；确认子进程退出后按上述 marker 持久化条件释放自己拥有的 claim，并重排未完成的 pending action。每次 launch 前先持久化 PID、进程创建时间/identity、工作目录、调用 deadline 和日志路径。启动恢复时核验 PID 与进程身份：匹配且仍存活且未超 deadline 时保留 claim、逐 tick 检查，不重复启动；匹配且已超 deadline 时先终止该进程树，再轮询确认退出，确认后释放 claim 并安全重排；终止失败则继续隔离并显示人工核验。身份已不匹配或进程已退出则视为原调用结束，丢弃未提交结果并安全重排；身份无法判定时不启动第二份、不释放 claim，显示人工核验并保留日志/PID 证据。重排前及人工重评前都必须确认旧进程不再存活。

### 2.4 看板与 API

- 顶部增加“执行看板 / Issue 分流”视图切换与待人工数量；项目筛选沿用现有仓库筛选。
- 分流视图展示 Issue、AI 结论/理由、仓库、创建/更新时间、决策时 base SHA；待人工和暂缓分组显示；历史区读取共享状态评论中的过去 SKIP 及被新内容覆盖的决策，不把历史项放入当前待办。
- 操作：打开 GitHub Issue、锁定/解除人工锁定（添加/移除 `agent-human-hold`）、人工放行（取得 claim 后先持久化 `route_source=human` 和当前输入指纹，再显式清锁、移除 needs-human 并添加 `agent-ready`）、暂缓（可选 deadline，持有 claim 更新共享状态，清理标签但不放行）、重新评估（持有 claim 增加 generation，清理人工门禁后排入 AI）、在无 task/ready/running/hold 时重置状态、确认旧进程退出后按 claim ID 清理未知认领。
- 新增共享分流快照只读 API 和受保护的放行/暂缓/重评/锁定动作 API；repo 必须属于当前配置项目，issue 必须仍可读取。Issue 上仅维护一条 agent-control 状态评论并原位编辑；UI 历史读取其决策摘要。启用分流时，UI 若监听非 loopback 必须配置 token，否则启动配置校验失败；写 API 在 handler 层拒绝无 token 的远程请求。
- 新增 `agent-needs-human`、`agent-human-hold` 与 `agent-triage-managed` 三个标签；项目标签 provisioning 与 `doctor` 一并检查/创建。共享状态评论、marker 标签与锁定标签为跨实例权威，本地 SQLite 仅缓存与恢复。

### 2.5 失败与兼容

- GitHub Issue/评论分页失败时不推进共享快照；所有启用分流的主机必须使用同一 GitHub 服务账号，状态评论作者不符、重复或解析失败时不调用 AI，显示人工核验。状态评论写入或标签写入失败时保留共享 pending action；pending action 可验证持久化且 coding dispatch 会阻止任何待办路由后，释放本轮 claim 供任一实例重新 claim 并幂等重试。`agent-ready` 的远端存在是派发提交点，共享状态评论先于该写入持久化；所有 triage-managed ready 在 pending action 清空且路由指纹有效前都不得进入 task/run。
- 分流按项目显式启用，新增 `projects[].issue_triage.enabled`，缺省 `false` 以避免服务升级后对旧项目突然回填派发。显式启用时才开始扫描开放 Issue。
- 旧数据库通过版本化增量迁移升级；旧任务、run 和现有标签语义不变。

## 3. 边界与风险

- AI AUTO 是开始编码的授权，不是合并授权；现有 checks、只读 PR review、风险与合并闸门不变。
- LLM 自报低风险不是唯一依据；提示词采用保守分类，未知、冲突、现场不可得均 fail closed 到 HUMAN。
- 跨实例依赖失败关闭的 GitHub label/comment claim 仲裁与一条可编辑共享状态评论；评论读取/写入失败时不运行模型、不做本地单方面 AUTO 派发。身份不明时保留 claim 并人工核验，不按时间自动抢占。
- 读取 repo 代码必须在精确远端 base SHA 的干净 detached worktree 中进行，完成后断言 SHA/clean 状态并清理；不得把用户本地 dirty worktree 当 AI 证据。
- 不自动留下自由文本 AI 分析评论、不自动关闭或替用户决定合并；每个 Issue 仅有一条 host 维护的机器状态评论，更新结论时原位编辑，另有 claim arbitration comments。
- `agent-human-hold` 优先于所有 AI/outbox 结果；只有明确的人工放行、暂缓或重新评估动作能清除它。冲突状态永远不触发 coding dispatch。

## 4. 验收与验证

| ID | 验收标准 | 验证方式 | 通过标准 |
|---|---|---|---|
| AC01 | 每个扫描周期完整分页枚举开放 Issue，正确排除 PR；Issue、人工评论、共享状态评论分页失败可在后续周期补扫 | tracker 分页验证 | 稳定列表中的每个 Issue/人工评论和唯一状态 marker 都可观察，失败周期不推进快照 |
| AC02 | 仅新建/输入变化或人工重评的 Issue 调用 AI；所有实例遵从共享 decision hash/generation | 持久化/调度验证 | 同指纹跨实例只分流一次；未锁定 HUMAN 内容变化会重评，锁定项不自动重评 |
| AC03 | AI 在精确远端 SHA 代码现场只读运行，输出严格四态结构 | runner/现场校验 | dirty、SHA 漂移、非法输出、错误均不 AUTO |
| AC04 | AUTO 决策与 generation 先写共享状态评论，再由任一 host 按 outbox 更新标签；人工锁定优先 | FakeTracker 集成验证 | 旧 generation 不可覆盖人工动作；所有实例遵守 `agent-human-hold`；human/ready 冲突时禁止派发，checks/review 不变 |
| AC05 | HUMAN 加 `agent-needs-human` 并显示理由，不启动 coding run | tracker/API/UI 验证 | 人工列表可见，任务表无对应 coding task |
| AC06 | DEFER 到期/内容变化/人工恢复行为符合契约；到期本身不自动派发 | 时间与状态验证 | 只重现分流收件箱，不生成 task |
| AC07 | SKIP 及未变化的 DEFER 不重复消耗模型调用；HUMAN 内容变化自动重评、转 DEFER 清除 human 标签；SKIP 历史可查 | 幂等验证 | 同输入无重复调用；标签失败可重试；内容变化或显式重评恢复 |
| AC08 | 模型/GitHub/服务中断可安全恢复，不能双启或丢弃失败证据 | 恢复/身份故障注入 | 活子进程不重启；超时存活进程可安全终止；死进程可重排；身份不确定转人工 |
| AC09 | 看板显示待 AI/人工/暂缓与共享历史，执行受保护动作及 claim ID 清理 | UI/API 验证 | 暂缓会让旧 generation 失效且不写 ready；未知 claim 的 ID、ready、hold、task 校验失败时拒绝；远程无 token 写请求被拒绝 |
| AC10 | `doctor` / label provisioning 支持新增标签，旧配置与 DB 可兼容 | config/migration 检查 | 旧服务行为不变，显式启用后检查/创建三个分流标签 |
| AC11 | 所有实例共享同一 issue decision marker，人工动作/AI 结果按 generation CAS 序列化 | 并发与重启核对 | 同 hash 不重复调用；旧调用/outbox 不能覆盖较新的人工决定；marker 唯一且作者可信 |
| AC12 | AI 或 dashboard 放行后的 `agent-ready` 绑定输入指纹，发现和领取执行前阻止已观察到的过期路由 | 输入变化竞态验证 | 最终复核在 claimRun 前，失败不创建 run；通过后固定 coder 输入快照；未运行占位不被误派，重评非 AUTO 时安全清理；无 marker 的既有人工 ready 保持兼容 |

## 5. 确认项

### 阻塞确认项

- 无未决业务规则。用户已确认人工门禁规则：未锁定的 HUMAN 内容变化自动重评；锁定后需显式放行或重新评估。当前完整设计待总体确认，包含每 Issue 一条可编辑机器状态评论、managed marker 标签及固定原因码这一外部可见行为。

### 非阻塞待确认项

- `issue_triage.enabled` 的项目级配置可在实现时按现有默认兼容规则收敛；当前设计默认 `false`，仅显式启用后回填。
- 暂缓提醒时间默认为空（直到内容变化或人工恢复），UI 可提供日期选择；日期到期只进入收件箱，不自动执行。

## 6. 前序设计审查归档

### 第三轮阻塞 finding（High）

- 场景：Issue 已由 AI 判为 HUMAN，系统添加 `agent-needs-human`。Issue 内容变化后自动重评；如果新结果为 AUTO，而人工希望继续保留门禁，同名标签已存在，系统无法判断它代表旧 AI 决策还是人工锁定。outbox 可能移除标签并添加 `agent-ready`。
- 影响：可能绕过人工门禁，违反 HUMAN 路径的决策边界。
- 审查证据：第三轮 independent Design Review；Reviewer 指向当时 v1 第 2.1、2.3 节及快照未记录标签来源/人工锁定字段。该 finding 先由 v2 `manual_hold` 契约处理，后因跨实例 SQLite 不共享，在 v3 改为远端权威标签。

### 非阻塞 finding（Medium）

- 未知 claim 的清理操作需提交时复核 claim ID、无 `agent-ready` 和 task；已并入 v2/v3 第 2.3 节。

### v2 首轮审查 findings

- High：只写本机 `manual_hold` 无法阻止其他主机自动解除人工门禁。v3 改用共享 GitHub `agent-human-hold` 标签作为权威状态。
- Medium：人工锁定后转 DEFER 的 outbox 冲突。v3 明确由用户动作持久化目标并专用清理两个 hold 标签，不会写 `agent-ready`。

### v3 首轮审查 findings

- High：DEFER/SKIP 只在本地 SQLite，其他实例会重跑或覆盖。v4 以每 Issue 机器状态评论共享 decision/input hash/history，并把它作为幂等权威。
- High：人工动作缺少 decision generation CAS。v4 要求所有改状态操作按 claim 串行、递增 generation，旧模型结果与 outbox 失效。
- Medium：流程图未列出人工 hold 优先 ready；已在 v4 流程图前置 hold gate。
- Medium：清除旧 HUMAN 标签许可不精确；v4 outbox 核对 previous decision/generation、输入指纹、hold、task 与 ready。

### v4 首轮审查 findings

- High：状态评论丢失时 DEFER/SKIP 共享抑制会消失。v5 用 `agent-triage-managed` 识别已初始化记录；marker 标签仍在但评论缺失时转人工修复，不重新自动分流。
- High：公开状态评论含 AI 自由文本理由，与“不发布 AI 分析评论”冲突。v5 改为固定 `reason_code` 并映射固定中文说明，不写自由文本。
- Medium：流程图混淆 `agent-needs-human` 与 `agent-human-hold`；v5 明确只有 hold 阻止自动重评，needs-human 只挡编码。
- Medium：DEFER/SKIP 的共享记录位置措辞不清；v5 明确不加专用状态标签，但状态由 agent-control 维护于机器状态评论。

### v5 首轮审查 findings

- High：没有定义 AUTO/DEFER/SKIP 终态后的 `agent-running` 正常释放与 pending action 重试，可能永久阻止既有 ready 调度。v5 第 2 轮明确 outbox 与 claim 生命周期、ready 写入前后的释放门槛及 owner 核验。
- High：AI 写入 `agent-ready` 后 Issue 内容可能在 task 创建/派发前变化，导致旧需求进入 coding。v5 第 2 轮增加 `route_source`、路由代次/指纹，并在发现及 `tryDispatch` 前双重校验。
- Medium：删除状态评论和 managed marker 的 reset 与 ready/task 快速路径有优先级冲突。v5 第 2 轮限定 UI reset 前置条件，并声明冲突时 task/ready/claim/hold 优先。
- Medium：锁定 HUMAN 转 DEFER 的步骤顺序前后矛盾。v5 第 2 轮固定先持久化 DEFER 与 pending action，再清 needs-human，最后清 hold；任一步失败都不放行。

### v5 第二轮审查 findings

- High：最终路由复核放在执行 claim 后，但现有 `Store.claimRun` 已创建 active run，仅释放 GitHub 标签会遗留唯一索引占位。第 3 轮将最后复核移到 `claimRun` 前，失败不创建 run；通过后固定本轮输入快照，后续失败仍走 `endRun`/`Store.transition`。

v5 第 3 轮增量复审 PASS，Critical/High/Medium/Low 均为 0。最终路由校验在 claimRun 前、失败不建 run、授权输入快照及通用 run 收尾规则已闭合。审查仅为只读设计核对，未运行测试。当前等待用户确认完整 v5，尚未进入实现。
