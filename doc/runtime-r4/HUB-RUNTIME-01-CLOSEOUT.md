# HUB-RUNTIME-01 剩余工作方案

## 2026-09-15｜第2门生产接线（实施回收，待桌面主管定向复验）

### 本批回收与证据边界

- 接续基线为 `c99faaa97f31e09f3a75e2b6b26ff9e0758898ad`；该接纳关联恢复 P2 已获中台 Standards/Spec APPROVE 并关闭。以下历史章节保留当时状态，以本节为当前状态。本批是第2门生产接线候选，尚不是主管代码验收通过。
- Main 默认 worker 与接纳 IPC 复用同一 runtime composition 的可信端口、Application、Saga、项目解析和权威数据库身份。UI 只提交原 assignment、目标引用、已见摘要和稳定 requestId；取消新流程角色/文件清单/重复计划门，并保持已恢复关联的实际状态。普通 CODING 与 FILE_LIST_V1 保持原入口。
- Pi 工作树授权经 worker init、工具注册、每轮 active tools 到 Main begin/settle 全程接通。仅 V2 TaskHub CODING EXECUTE 开放 delete/rename；实际 SDK 文件工具和专业工具执行使用 Main 规范路径。WORK/DESIGN 仅选择原专业工具产物路径，允许受信同路径修正，不获得通用编辑能力。
- 未结算候选验证复用实际 mode verification port：冻结写入、核验前后候选摘要、持久化诊断/receipt 和修正预算；同一存活 Pi 会话最多两轮修正。通过、耗尽、取消或 UNKNOWN 才结算关闭 Worker；旧 runId 重复结束事件不重复消费预算。空变化不能伪造成功，未知不能重放。
- 真实 V2 capture 经 candidate audit、QA/Evidence/TaskChangeSet、ComposerV2 到 READY_FOR_REVIEW；精确绑定 Attempt/candidate/TaskChangeSet，自动选择按所有状态的既有精确批次去重，人工拒绝后不重建相同批次。Review 使用实际 Git diff，DELETE/rename 前后语义保留。V1/V2 gate、ChangeSet、receipt 使用明确联合类型，人工批准按实际版本进入既有 Apply port，共用原 SQLite registry；自动链路无 Apply 调用。
- 生产文件按模块：`packages/shared/{ipc-channels,worker-host-tools,xiaogui-delivery,xiaogui-delivery-ipc}.ts`；`src/main/worker-manager{,-pool}.ts`；`agent-runtime/{pi-adapter,pi-worker-port}.ts`；`coding-extensions/attempt-review-module.ts`；`hub-task/{worker-composition,worker-ipc}.ts`；`task-hub/{attempt-workspace,delivery-ipc,delivery-verification,delivery-workflow,ipc,runtime-composition,sqlite-store,task-candidate-audit,task-verification-coordinator,verification-port}.ts`；Renderer Inbox/Panel/client；worker init、runtime、port types、Attempt tool extension、WORK report tool。路径中 main 小规模块相对 `src/main/xiaogui/`。新增真实 handler 组合测试和 production-wiring-v2 测试，更新对应聚焦测试。没有新增依赖、Agent Loop、数据库或模型配置。
- 原 HANDOFF 下 `production-wiring/25-production-final-integration.log`：最终版本接线后组合用例 **1/1，exit0**。实际组件点击→实际注册 handler→默认 Main 装配工厂→真实接纳/Saga/工作树/PiAdapter→实际 SDK 工具→真实 capture/固定验证/自动 Delivery→真实 review diff；H1 RESULT 一次，prompt 一次、Worker 关闭一次、无 Apply。替身仅离线传输、合成身份及 Worker/model port；不是 Electron、真实 Worker 进程或模型旅程。
- 分层证据：04 adapter 9项、05工具8项、06锁定 SDK 三模式3项；07专业规范路径2项；17存活 WORK/DESIGN 实际 verifier 2项；13前段 Pi/审计/协调器通过、14修复后 Delivery/review 通过；21人工 V2 gate 分派 spy/错误版本/拒绝重放及重复 idle 预算2项。22/23 Node/Web类型、24全部变化TS/TSX lint退出码0，空日志仅表示成功无stdout。UI/IPC证据见同目录 `ui-ipc-*`（工具回执汇总，非原始stdout）。重叠用例不累计为新增数量。
- 自动 Delivery 保存窗口证据仅为已封存候选扫描、回调第一次保存失败后精确重试；不是整个生产链路在途进程崩溃注入。P2 原 SQLite 关联恢复证据复用，未重跑。人工 Apply 的本轮测试只使用 port spy，不重跑已验收引擎或业务 Apply。
- 最后 UI 回收：接受/恢复回调刷新同地址投影；组件挂载期间串行调用既有只读 observe/refresh，自动跟进待审阅，失败/UNKNOWN/取消/已确认 Delivery 状态停止，切换地址或卸载清理 timer。没有自动业务派发。`ui-ipc-08-panel-refresh.log` 为工具回执：Panel 32项、Inbox 6项、Web类型/UI lint/diff-check通过；包含初始无flow→接受→运行→自动READY_FOR_REVIEW及停止跟进验证。这是组件测试，不是窗口点击证明。
- 过程偏差保留：03发现 SDK active tools 漏接已修；09/10 的 H1 失败实际是测试误用 `item.type` 而非 `kind`，曾误判生命周期竞态，临时生产 hooks 已全部撤销，`src/main/xiaogui/index.ts` 无差异；12为非法多 `-t` 命令；13末段旧 media alias 失败由14修复验证；18初始lint失败由19/24清零。不能将这些失败日志计为通过。
- 未完成/下一门：主管第2门定向复验；通过后才安排第3门 Electron/真实模型和真实业务旅程。检查点可信会话登记缺口仍未修；V2 的既有 V1 baseline recovery 入口明确拒绝，不冒充已支持；case-only rename 仍拒绝。没有操作原业务/profile/数据库/安装现场/stash，没有构建、包扫描、业务 Apply、合主线或发布。最终完整 SHA、推送与 UI 最后刷新证据见原 HANDOFF 顶部。

### 已批准方案与实施分工（保留开工记录）

- 基线 `c99faaa97f31e09f3a75e2b6b26ff9e0758898ad`；中台定向复核Standards/Spec APPROVE，接纳关联恢复P2已关闭。既有LOW不扩修。当前HEAD/上游一致、工作树clean，原Sol已停止；接续同一个Sol分批编码，主任务审查集成与文档。automation接口缺失，heartbeat未启用，无后台替代。
- 批次依赖：①Main默认可信接纳装配/IPC及Pi工作树工具授权；②未结算候选验证与最多两轮修正；③V2 candidate audit/verification/自动Delivery；④UI同步开放一次接受入口及分层组合验证。均属原第2门，不新增逐项审批；UI只能在依赖接通后开放。普通CODING独立流程、V1授权不变。
- 编码所有权依批交唯一Sol：worker-composition/worker-ipc及桌面调用契约；agent-runtime/pi-adapter、既有Pi第一方工具/Attempt IPC；task-verification-coordinator/verification-port/candidate audit/delivery-workflow及关联私有存储；最后HubTaskInboxSection及必要任务详情消费点。具体变更清单按实查回收更新，不同时派多个共享模块owner。主任务拥有本方案、DEVELOPMENT_STATUS和HANDOFF。
- 用户随后授权编码任务可自行分配Sol/Luna：在工具批回收后，局部UI/IPC交 `single_accept_ui_ipc`（gpt-5.6-luna/max），仅拥有worker-composition/worker-ipc、共享IPC频道、HubTaskInboxSection/CollaborationHubPanel及相关测试；原Sol保留Pi、验证、Delivery、runtime-composition/task-hub/ipc。冻结getter为getDefaultHubTaskAcceptAndExecuteTrustedPortV2，由Sol从同composition暴露，Luna注入默认worker；不重复创建运行时、不增加负责人或验收门。
- Main默认worker复用同一个Application、orchestrator和project resolver，authorityDatabaseIdentity绑定同一hubDbPath；Renderer只传assignment/可信目标引用/已见摘要/requestId，任务正文与授权在Main重新核验。重复点击/刷新/重启沿原绑定恢复，不新增执行。接纳恢复不投影成任务成功。
- **主管补充1：结算前验证真实接缝。** 为未结算Attempt提供受信候选验证上下文，复用verification port，不提前写SUCCEEDED，不调用会提交最终失败状态的协调流程做中途验证。模型结束但未验证时Main必须最终验证；可修正失败且预算尚余，将诊断送回同一存活Pi会话。通过、两轮预算耗尽、取消或UNKNOWN后才结算释放Worker。验证期间冻结写入，候选变化使旧receipt失效。初始验证之外最多两轮修正，预算持久后再允许副作用；已结算/UNKNOWN不得复活或自动重派。
- **主管补充2：模式能力不扩大。** delete/rename只在该模式既有或本次批准的工具范围开放；WORK/DESIGN取消预报路径，不获得CODING通用编辑能力，复用专业工具并由Main核验Agent选定产物路径。工具实际执行必须使用Main返回规范目标，rename源目标均一致；根外/.git/链接/硬链接/子模块/碰撞拒绝，ASK/PLAN只读及命令外传策略保持，case-only rename继续拒绝。
- 真实capture与已过V2 Composer/Apply复用。补V2 audit/verification/Delivery消费者，对DELETE核前像及后态不存在；rename保持DELETE+CREATE。最终验证PASS后按本任务精确Attempt集合+候选摘要稳定键生成并验证一次Delivery，READY_FOR_REVIEW停止写入，空diff不伪造成功。Apply必须人工确认，不自动调用；不得捞同flow历史成功Attempt替代本次。
- UI保留任务/项目展示，接受、生成草稿、重复正文/文件清单/角色/计划批准合并一次接受并执行；计划只读展示。新流程无隐藏默认角色。装配失败显示明确原因，不落回旧路径。检查点可信会话登记缺口仍单列，仅发现真实执行依赖才报最小必要接缝，不扩重构。
- **主管补充3：合成分层。** 组件事件经实际接纳handler、默认Main装配到Scripted Runtime，传输可替身但授权/业务不得替换；本次Pi工具补无模型的真实Pi工具生命周期检查，验证实际参数与Main规范目标一致。Electron窗口点击/真实模型保留第3门，本轮不启动。三模式只测受影响门，复用成熟本体。
- 聚焦验证：重复点击/关联恢复；无角色文件预报的新会话；四种实际文件效果与边界拒绝；失败修正成功/两轮耗尽/候选receipt失效/UNKNOWN；精确Delivery重复事件及保存失败恢复；H1结果与人工Apply门。只跑受影响测试、Node/Web类型、变化TS lint、diff-check。完成更新两份仓库文档及原HANDOFF，追加提交推送隔离分支，固定SHA停桌面主管第2门验收。禁止原业务/profile/DB/安装现场/stash、模型、Electron、包扫描/构建、业务Apply、主线合并或发布。

## 2026-09-15｜接纳关联恢复 P2（方案 Standards/Spec APPROVE，返修候选待复验）

- 固定基线 `64553cff62c5542303326cd0d25a7c9306b174ff`；开工本地/上游/live远端一致、clean，保护stash未变。仅修派发后最后接纳保存失败造成的关联丢失；不扩大默认UI、Pi工具、自动修正或自动Delivery，不操作原任务/profile/数据库/安装现场/stash。
- 可信Main接纳Interface新增只读recoverAssociation：按原acceptanceKey、draft/activate幂等回执、精确Saga/Attempt/dispatch记录查关联，核身份/项目/会话/内容/原基线；不能按active flow、最近记录或当前HEAD猜。复用同一数据库，只读证据查询不得调用perform/execute/start/global recover、Worker或prompt。
- NOT_DISPATCHED冻结规则：原接纳证据、完整可读的原权威库和对应阶段记录共同证明未派发。正常早期可尚无draft/activate/Saga，成功的精确空查询须与已保存接纳阶段一致，不因后续记录按顺序尚未产生而一律UNRESOLVED；不可创建空库替代丢失库。已有Attempt且前置证据明确未派发时返回原关联并只续接该Attempt。已进入DISPATCHING或有运行时/派发/终态证据，或无法确认时，只恢复已证实关联，保持实际状态或UNKNOWN，不重派；READY或缺dispatch回执单独均不足。进入续接前再次核验精确阶段，防止使用过期结论。
- 接纳服务对已有同一请求先核身份与正文再恢复，Hub RUNNING/终态不提前拦截只读恢复。找到已执行关联不再execute；关联恢复成功与任务成功分开表达。证据冲突、读取失败、不能证明未派发时停止。
- 私有接纳记录与localPlanDraft同次持久写入，独立表达关联已保存，不伪造STARTED；旧64553cf记录按需兼容，不批迁移。先写候选状态成功，再替换内存；保存失败不返回成功、不留下内存假关联。现有绑定/结果关联查询能消费已核验恢复关联，公共UI/Hub协议/结果投影不改，恢复不产生结果发送副作用。
- 一个gpt-5.6-sol子任务拥有worker-service/state、runtime-composition/execution-orchestrator/sqlite-store及本P2聚焦测试；主任务维护方案、审查、文档和提交推送。优先已有接口与存储，不建平行系统。代码所有权之外的改动先报告；保留其他人编辑。
- 验证同一组参数化覆盖：ACCEPT已成功响应丢失且无后续记录、已有未派发Attempt、DISPATCHING、运行中/成功/失败/取消/UNKNOWN、证据读取失败。核心场景注入最后保存失败，销毁重建服务、独立状态文件和SQLite，恢复同flow/revision/Attempt，Worker/prompt次数不增；恢复关联可由既有查询消费，重复恢复不增记录；身份/内容/关联冲突及再次保存失败拒绝。只跑这组受影响测试、Node类型、变更TS lint和diff-check，不重跑DESIGN/Delivery/Apply/模型/Electron/build/包扫描。
- 交付追加commit/push当前隔离分支，更新本方案、DEVELOPMENT_STATUS及原HANDOFF，交固定SHA与证据停在桌面主管定向复验门。本轮通过仅表示接纳关联可恢复且不重派发，不等于完整一次接纳通过。automation接口仍不可用，15分钟heartbeat未启用/无ID，不旁路替代。

### 本 P2 实施回收

- 实际生产文件5个：`hub-task/worker-service.ts`、`worker-state.ts`、`task-hub/runtime-composition.ts`、`execution-orchestrator.ts`、`sqlite-store.ts`。新增 `acceptance-association-recovery-p2.test.ts`；更新接纳服务测试和 Main seam 测试接口，后者未纳入最终运行。没有新增数据库、依赖或恢复框架。
- 只读查询按原 draft/activate/schedule 回执和授权摘要核对精确 flow/revision/Saga/Attempt；完整性与文件实体证据在数据库初始化之前固定。旧无 stamp 记录须有完整原库证据且文件实体未变。已有 SQLite 派发 journal 作为补充禁止重放证据，未读取 JSONL。
- 关联使用 `ASSOCIATED` 私有阶段及 `ASSOCIATION_RECOVERED` 返回，携带实际 Attempt 状态；UNKNOWN 保持未知。私有关联和 localPlanDraft 一次写入后才发布内存；现有绑定查询可消费恢复的终态关联。首次执行与现有未派发 Attempt 续接复用原路径，执行前再次核验。
- 四组新增回归已通过，覆盖末次保存失败冷恢复、状态矩阵、正常早期/同 Attempt 续接、派发竞态、关联消费、旧记录兼容、冲突及坏库/缺库重建拒绝。最终审查另补已保存 EXECUTION_REQUESTED 到 ASSOCIATED 的终态恢复与冲突回归；精确命令和最终回执见 DEVELOPMENT_STATUS 顶部及包外 HANDOFF。
- 证据为合成 Git 项目、独立状态文件/SQLite和现有 Scripted Runtime。`createOrResume` 计数是合成运行时派发边界，不能称真实 Pi Worker/模型旅程。未重跑成熟 DESIGN、Delivery/Apply；过程误启动后中止与清理拒绝如实保留在交接。
- **关闭状态：实施返修候选，尚待桌面主管代码定向复验，不能声明主管 P2 已关闭。** 默认 UI/IPC/worker 装配、Pi 工具授权消费、V2 verification/Delivery 消费链、最多两轮未结算修正和自动 Delivery 仍未接；检查点可信会话登记缺口仍未修。下一步仅主管定向复验，不自动进入下一门。


## 2026-09-15｜接续批：Main 接纳与真实 capture 候选（待桌面主管验收）

- 接续基线：本地、上游与 live 远端均为 `aaa62c69eebddf653f3c1bdc25423b0cf2515459`；隔离工作树 clean，保护 stash `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61` 保留。交接 HANDOFF 顶部主管 P2 复验已 APPROVE；原实施记录明确停在交接门，本任务接替所有权。旧待复验措辞为历史记录。
- 本批继续第 8 节第 1 门剩余关键接缝，先完成 Main 一次接纳/Saga、明确版本的 Attempt 工作树授权、真实磁盘捕获 V2 到已有 Composer 的组合证据。完成交主管核对后，再进入第 2 门 UI/Main 同步替换、有限验证修正与自动 Delivery 生产默认接线；不以类型或测试夹具输入代替生产捕获。沿用已批准复用调查，不重新安装、研究或运行模型。
- 实查依赖：`hub-task/worker-service.ts` 当前接纳与草稿分离；`execution-orchestrator.ts` 的 WORKSPACE_READY 卡在计划/角色门；`attempt-execution-input.ts` 与 `attempt-workspace.ts` 全部按 grants 冻结；`runtime-composition.ts` 来源 resolver 核验 staged grants；`pi-adapter.ts` 的 settled 回调在 capture 后立即结算；`delivery-workflow.ts` 仍使用 V1 Composer。新分支必须显式隔离旧 FILE_LIST_V1，缺授权不得放行。
- 文件分工：Sol A 负责 `hub-task/worker-service.ts`、`worker-state.ts` 及相关聚焦测试的一次接纳持久步骤；Sol B 负责 `task-hub/attempt-workspace.ts`、`attempt-execution-input.ts` 及相关聚焦测试的工作树授权/真实 capture；后续集成 Sol 负责 `execution-orchestrator.ts`、`runtime-composition.ts` 的 Main 窄端口与 Saga 接线及组合验证。根任务负责接口决定、审查、两份状态文档、提交推送；不得跨所有权覆盖编辑。
- 完成判据：可信任务版本/身份/目标绑定；重复接纳不重复 ACCEPT/flow/Attempt/派发；UNKNOWN/已结算不重派；PROJECT 原字节及 DERIVED 登记来源不降级；无预填路径的真实新增/修改/删除/rename 产生 V2 净效果并进入已有 Delivery；根外/.git/链接/碰撞拒绝；旧 V1 不扩大权限。只跑变化对应的合成 Git/私有临时 SQLite 聚焦用例、类型、定向 lint 与 diff-check，旧 P2 和未受影响已过用例不重跑。
- 下一门依赖单列：Pi 未结算验证最多两轮需接在 settle 之前；自动 Delivery 需精确 Attempt/候选摘要稳定键及 V2 消费链；新 UI 不能先显示可执行却仍走旧门。检查点可信会话登记缺口仍未修，新接纳使用专属 Attempt Worker，不通过旧角色冷装载聊天 Worker。
- 接线纠偏：禁止本轮真实模型验证，不等于产品V2应永久停PREPARED。新Main接口不挂默认UI/IPC，但其显式授权分支继续复用原Saga dispatch；组合测试用现有Scripted Adapter显式装配，禁止新增模型配置或为后续另造resume审批门。无受控rename工具回执时capture只输出真实DELETE+CREATE，不按同字节猜rename关联。
- 当前工具未提供 Codex task 协调/automation 接口，无法实时查询原任务或设置 heartbeat；使用明确落盘交接门，不搭后台轮询。禁止业务现场、profile、数据库、节点、stash 操作；不安装/模型/业务 Apply/合主线/发布。
- 用户人工转交新规范已接收：有活动子任务时仅维护一个15分钟增量heartbeat，无变化安静、完成回执及时回收、阶段交付或明确暂停后停用。此次再查仍无automation接口，实际未启用且无ID；不旁路替代。子任务实际均指定gpt-5.6-sol，沿原所有权接续。主会话系统仅标识GPT-6，未暴露精确模型ID/切换接口，不能声称已核验Astra或已切换。

### 本批回收结果与下一门

- 实际修改7个生产文件：`hub-task/worker-service.ts`、`worker-state.ts`；`task-hub/application.ts`、`attempt-execution-input.ts`、`attempt-workspace.ts`、`execution-orchestrator.ts`、`runtime-composition.ts`。测试为新增 `worker-accept-execute-v2.test.ts`、`single-accept-main-seam.test.ts` 及已有 input/workspace 两测试文件的定向增量；另更新本方案与 DEVELOPMENT_STATUS，共13文件，无依赖/Hub/网页契约变更。
- Main 新 `acceptAndExecuteV2` 只接受assignment/address/已见版本/requestId，重下载比对实际正文摘要、身份和目标；接纳阶段持久化，成功结果与旧生命周期所需localPlanDraft同次写入。并发与恢复不重复ACCEPT，旧计划冲突拒绝。Saga单独保存V2授权，精确UNKNOWN/终态提前回执；显式V2沿已有dispatch，跳过旧计划/角色门，不伪造角色或人工批准。
- Attempt 使用Main登记实体授权及自动基线清单；PROJECT保原字节、DERIVED读不可变blob，来源失败不回退。独立 `captureTaskPatchV2` 扫描真实净变化（含ignored新文件），三种效果及rename净DELETE+CREATE进入已有ComposerV2。旧V1入口不变；同项目调度token只是并发互斥投影，不作为文件授权。
- 组合证据是**显式装配现有Scripted Adapter的合成链**：真实worker服务→可信Main port→真实Saga/Application/来源resolver/工作树→Scripted Adapter磁盘操作→真实capture→ComposerV2。TaskChangeSet的QA/evidence外壳由测试构造，未经过完整生产verification；未生成手工TASK_PATCH_V2。UNKNOWN在合成私有Saga内注入，验证精确重放不新增Saga，不冒称在途进程崩溃恢复。
- 已回收：接纳层分次聚焦通过；input 5项；workspace V2 2项；旧V1计划/角色直接回归2项；最终组合1项。Node/Web类型与全部变化TS定向lint通过。原日志/精确命令及缺日志说明见DEVELOPMENT_STATUS；不重复旧P2、旧Apply或成熟本体。
- **未完成／下一门**：默认worker composition/IPC/UI尚未挂新入口；Pi实际工具仍需消费工作树级授权，V2 candidate audit/verification/Delivery workflow消费链、最多两轮未结算修正及自动Delivery尚未接。WORK/DESIGN/CODING真实模型旅程、安装包、Hub联合旅程及真实业务Apply均未验证。检查点可信会话地址缺口仍未修；case-only rename本候选明确拒绝，未实现其Apply语义。
- 过程纠偏：曾把禁止真实模型验证误做成V2永久PREPARED返回，已删除，产品不新增resume审批门；曾误加按相同字节推断rename metadata断言，已撤回，不修改捕获语义。两次超范围旧套件中止，以及早期组合失败/中止不算通过，细节见状态记录。
- Standards自查：本批限定Main接缝未发现剩余独立阻断；Spec自查：此候选有合成证据，**不等于完整一次接受并执行或整个生产流程通过**。本批追加提交推送后停在桌面主管验收门，由主管决定下一门；不自动开启默认入口、模型或业务。

## 2026-09-15｜首切片P2定向返修：V1有序同路径链

- 主管拒收6e08e7e：共享integration路径去重误伤V1的MODIFY→MODIFY、CREATE→MODIFY，两个直接相关既有case失败。本次仅修此回归，既有LOW不扩修，其他新流程接线不开始。
- 沿当前干净HEAD `6e08e7e76db86491389b8afa8369c913a7a06bbd`，先更新本方案再交Sol接续。区分V1有序操作序列和V2最终净文件效果；只将重复净路径拒绝限定于V2，保留所有版本路径校验及V1逐步摘要/存在状态检查，不放宽全部冲突。
- 验证只复跑主管指定两个既有case，并补V2重复净效果仍拒绝的必要case；必要Node类型、变更文件lint/diff-check。不重跑21项/增量2项/无关工作树套件，不操作原现场。
- 回交一个追加返修SHA及短证据，等待桌面主管复验。不安装/模型/Electron，不重派任务、不业务Apply、不合主线。

实施结果：Sol仅将入口重复路径检查限定V2并补1个V2负例；V1逐步摘要/存在状态检查未动。指定两个V1既有case通过（2/5跳过），新增V2负例通过（1/2跳过），Node类型、两文件lint和diff-check通过。根owner已复核最小差异与日志，准确命令见DEVELOPMENT_STATUS顶部；本次不扩修原21+2及其他接缝。当前只待桌面主管定向复验，不代表完整首批或一次接纳生产流程完成。

## 2026-09-14｜TaskHub 一次“接受并执行”整改方案（2026-09-15已批准，先做关键接缝验证）

### 2026-09-15 首批执行口径

- 主管已确认本方案：一次接纳覆盖正常主链；不恢复角色/逐文件/中间批准，不新增整套项目快照；rename按DELETE+CREATE，最多两轮未结算修正；检查点缺口单列不扩修。
- 当前HEAD仍133d1a5、原两份方案改动保留，stash未变。先交Luna/max编码合成验证所需的最小契约与既有Module增量；根owner同时审查调用图和整理证据。生产UI、Hub/网页、默认接纳入口及原业务均不改。
- 本批验证重点：工作树授权与真实捕获、DELETE+CREATE双端的Delivery/Apply预检和失败恢复、现有未结算执行/验证接缝的适用性。必须区分真实调用和测试替身，未接生产的部分不能宣称一次点击已完成。
- 测试仅用全新合成Git/SQLite/目标目录。原失败Attempt、工作树、profile、DB、节点和stash不动；不跑外部模型/Electron，不安装/发布，不业务Apply。只运行新接缝必要用例与受影响检查，不复测成熟工具本体。
- 本批完成提交阶段证据后停下交主管核对，再推进生产接线。若现有Seam仍有具体缺口，明确报告，不用大规模重构或假结果补齐。

### 首个可回收切片：Delivery／Apply文件效果（不等于首批全部完成）

- Luna完成V2文件效果合同与初始合成case；Sol按新分工接续跨模块收口。V1/V2保留不同合同/digest，Apply共用审批/基线门、写事务、inspect及rollback收据流程，Delivery integration共用同一个Git工作树构建过程，Composer复用既有依赖校验。未新建表、工作区管理器或事务框架，生产默认仍为V1。
- 实际只新增DELETE无后像、CREATE有后像及rename双端关联；DELETE不是空文件。合成TASK_PATCH_V2是夹具输入，**不是生产captureTaskPatch产生**。本切片尚无Main工作树级授权、接受按钮、角色门取消、两轮修正、自动Delivery或原业务证据。
- 初始Luna3项结果保留；Sol补为5类实际Git/SQLite场景：rename组合和人工授权后应用成功、源字节漂移拒绝、目标被占用拒绝、删除后创建前注错恢复、两效果完成后注错恢复。最后一项再打开SQLite只证明已保存receipt回放，不冒称在途崩溃恢复。两项文件前置冲突测试注入clean Git snapshot，以单独验证逐文件前像/目标不存在检查；成功及回滚case使用真实Git snapshot。
- 21项共享实现组合通过，Node/Web类型与定向lint通过，准确命令、最终增量及版本隔离结果见DEVELOPMENT_STATUS。原始日志在 `D:/CodexTemp/hub-runtime-01-single-accept-spike-20260915`，早期失败不覆盖。未经主管核对不进入生产接线，不能以此结果代替整个新产品流程验收。
- 下一切片仍在原方案内：受信Main一次接纳和工作树授权→真实capture的合成链、结算前验证反馈与两轮上限、自动Delivery的精确Attempt/幂等恢复。case-only rename和真正写入中断的恢复尚未覆盖；检查点登记缺口仍单列。本切片不安装、不模型/Electron、不操作原现场、不业务Apply。

### 0. 新产品定义与固定现场

本节是用户最新决定，取代下文历史方案中强制角色绑定、逐文件预授权、反复批准计划和手动发起Delivery的产品要求；历史记录保留，不作为新流程的施工指令。

**实施约束补充：非必要不重构，优先现有轮子。** 下列接口名称用于解释必须改变的行为，不是要求另建同名系统。直接复用已有Pi Loop/工具扩展、TaskHub Saga、Main权限核验、Git工作树、验证、Delivery与Apply实现；只对本次真实不兼容字段做版本化，不全仓改名/搬目录/抽通用层，不为本轮LOW重复代码做重构。不批量重写V1；可复用的函数、持久化与事务原地接续。新文件操作仅补现有工具缺的delete/rename动作，不能扩成文件管理平台；修正预算保存在既有记录，不能建设通用重试框架。若现有接口已经能表达某步骤，直接调用，不为方案中一个名词新增Module。

查看任务与明确的目标项目 → 用户一次“接受并执行” → 小规准备独立Attempt工作树、按任务修改、验证并自动生成Delivery → 用户审阅真实Diff和验证结果 → 人工确认Apply。

- 实查HEAD仍为 `133d1a5cd0f8dce736b280f87b08f9e2f5a40d23`，分支 `codex/hub-runtime-01-pi-default-v1`，开工检查工作树干净；最近源码/运行包为 `d8ff33029ab0c123aad956630ba401579b7bac2f`。本轮只有方案文档改动，不提交产品代码。
- stash仍为 `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61`，其他保护stash不动。本次不读取或修改业务profile/数据库，不重试既有失败Attempt，不Apply、不合主线、不发布。
- 对WORK/DESIGN/CODING采用相同任务接纳与交付流程；继续使用各模式原有能力，不借此扩大DESIGN功能、解除阶段只读、放开Bash或外传。普通CODING直接修改用户项目的另一条产品链不变。

### 1. 当前生产链实查与复用依据

| 现有Module / 文件 | 已确认的事实 | 必须调整的Seam |
| --- | --- | --- |
| `src/main/xiaogui/hub-task/worker-service.ts` | `decideAssignment`与`createPlanDraft`分开；后者核验当前身份、已接受assignment、下载内容摘要，以assignment生成确定性requestId和本地flow绑定；`toPlanDraft`已能沿用任务说明/验收要求 | 复用该可信入口组合一次接纳，不让Renderer提供替代任务正文或伪造授权 |
| `task-hub/execution-orchestrator.ts` | `startOnce`先解析逐文件授权，Saga保存prompt/grants；WORKSPACE_READY等待Attempt plan批准及角色可执行；已有恢复、未知结果、派发幂等处理 | 同一一次授权驱动内部计划和执行；替换逐文件输入与角色前置，不旁挂第二套执行器 |
| `coding-extensions/attempt-ipc.ts`、`runtime-composition.ts` | approve路径直接返回ROLE_BINDING_REQUIRED；角色还供执行gate、Runtime request和verification读取 | 新流程UI、IPC、Main执行/验证均不再要求角色；不是仅隐藏CodingRoleCard |
| `agent-runtime/pi-adapter.ts`及`pi-worker-port.ts` | 当前工具前置逐条匹配manifest grants；只放行read/edit/write；固定WORK报告还要求恰好一个预授权CREATE目标；终态持久化后回收Worker | 以Attempt工作树授权替换路径清单；工具结果保持精确记录，不能由模型声称成功 |
| `attempt-workspace.ts`、`attempt-execution-input.ts` | manifest按文件冻结；capture拒绝删除/重命名；d8ff330已完成Main来源、原始字节/derived blob、恢复绑定 | 来源权威保留，逐文件授权与基线完整性分离；扩展真实变更捕获 |
| `delivery-composer.ts`、`delivery-integration-worktree.ts`、`change-apply.ts` | 当前只支持CREATE/MODIFY，删除被拒；Apply已有前镜像、冲突、回滚/恢复路径 | DELETE及重命名的两端变化要贯通Artifact、Delivery、人工Apply与恢复，不能只扩工具 |
| `delivery-workflow.ts` | `selectTasks`已组合结果和验证；`approveGate`关联最终人工应用；已有稳定请求与结果恢复 | 自动调用既有选择/生成Seam，不能自动调用approveGate/Apply |

以上task-hub / coding-extensions / agent-runtime相对路径均在 `src/main/xiaogui/` 下。Renderer对应 `src/renderer/src/xiaogui/components/CollaborationHubPanel.tsx`、`CodingRoleCard.tsx`、`CodingAttemptPlanCard.tsx`，及现有Hub inbox接纳入口。

复用顺序：Pi固定0.84.1原生Agent Loop、ResourceLoader、read/edit/write及工具生命周期继续使用；本地 `dist/core/tools/index.d.ts` 已实查，没有原生delete/rename文件工具。原生bash不能作为免确认删除/重命名的通道。既有第一方Tool Adapter必须补最小受控文件操作，走同一Main/Worker窄通道与文件操作串行队列，不复制Loop或建立通用文件平台。

Pi Skill/插件调查沿用本文件既有固定来源和验证记录：第一方工作文档Skill、internal-comms，以及已审pi-package-manager0.2.1/pi-sandbox0.6.6。它们不持有Main assignment/授权/Delivery权威；不重新安装、升级或重复已过探针。本轮没有新插件选型，只复用既有TaskHub并变更已获用户确认的授权语义。最小文件操作接缝在首批合成Spike验证后才替换生产工具路径。

### 2. 用户确认的取消、合并与保留

| 环节 | 新行为 |
| --- | --- |
| 看任务、选目标项目 | 保留；按钮旁明确项目和“改动只在任务工作树，Apply前不改原项目” |
| 接受任务、批准草稿、重复任务输入、填写新增/修改文件清单、确认执行批次、批准执行计划 | 合并成一次“接受并执行”；已有计划成为只读进度/审计，不再逐步阻塞用户 |
| 研究/实现/审阅分类、“使用此角色” | 从TaskHub新执行必经链移除；不创建隐形默认角色冒充已绑定 |
| 正常工作树文件读写、新建、删除、重命名 | 在任务工作树授权内自动执行并审计，不逐文件弹框 |
| Bash、外传、需要更换目标项目/扩大授权 | 沿用已有权限规则；不能因一次接纳变成任意命令自动通过 |
| 手动选择任务发起Delivery | 当前任务结果验证合格后自动生成，仅选本次精确Attempt/ChangeSet |
| 审阅Diff/验证、Apply | 保留人工最终确认及原项目冲突检查；绝不自动调用Apply |

用户点击时目标未明确、任务内容版本已变或接纳身份失效：不启动执行，提示具体原因；不是增加一轮常规确认。取消仅停止尚未执行的操作，已发生副作用按已有语义记录，不声称一键回滚所有命令。

### 3. 一次授权与Main契约调整

在现有Hub worker-service/IPC与execution-orchestrator扩展一个版本化接纳请求（暂名 `acceptAndExecute V2`），不是新增审批Module。Renderer只送assignment标识、Main已解析的目标项目引用、看到的任务版本摘要和幂等requestId；Main重新下载/核验任务身份、内容、当前接纳状态，沿用统一模型配置并冻结执行选择。

复用现有assignment→flow绑定、task_execution_sagas、Attempt工作区lease及私有输入记录，增加必要的版本化授权字段：授权方式、assignment/任务内容摘要、目标项目身份、基线来源绑定、操作范围、初始接纳requestId。不得把原grants数组换成无约束 `*`，不得由Renderer/模型生成受信工作树根或授权摘要。

一次用户接纳签发 `ATTEMPT_WORKTREE` 文件授权；旧记录仍为 `FILE_LIST_V1`。新契约使用明确的判别类型，不给V1字段改义或将缺字段默认为全项目。Main每一步验证绑定仍一致，后续计划/工作树/验证/Delivery只能消费该授权，不能因按钮文案产生权限。

计划创建/内部批准须绑定同一接纳授权及任务版本，不伪造多次人工批准历史。替换新流程的draft/Attempt plan待批条件为内部准备完成状态；ASK/PLAN的工具只读限制保持。开始执行时由已授权任务推进到EXECUTE，不要求用户手动改阶段。老界面保留历史只读记录，不混用旧approve接口静默扩大权限。

消费点必须一起迁移：worker-service/worker-ipc、任务执行共享契约及IPC validator、execution-orchestrator/Saga、attempt-execution-input、runtime-composition的角色provider/gate与权限策略、attempt-ipc、Pi request校验/工具门、verification角色前置、Renderer角色/计划/范围/交付按钮。仅删除旧角色门而留下其中任一路径不算完成。

不新增Hub服务端审批状态。默认复用现有ACCEPT、downloadAssignment及执行/结果回执协议；若任务版本摘要或一次接纳回执在现有Hub契约无法表达，必须将最小字段差异交桌面主管与中台主管对接，未经确认不改Hub/网页。Hub ACCEPT与本机启动不是一个分布式事务：现有私有绑定持久记录已完成步骤；故障恢复只对确定未执行步骤做幂等续接，不重复ACCEPT、建flow或派发。

### 4. 从逐文件授权到工作树内授权

授权对象是Main创建并登记的**当前Attempt工作树实体**，绑定task/Attempt、commit/tree、来源记录、项目身份和策略摘要。原项目仅用于基线读取和最后Apply，不成为Agent文件工具写入目录。来源继续执行d8ff330规则：PROJECT取已核验原始字节；DERIVED取登记不可变输入，不按HEAD/parent猜、不在失败时换来源。

取消用户填写文件清单，但不取消Main基线账本：准备时从受信Git树自动建立原始字节/存在状态的私有基线清单与摘要，属于完整性证据，不是让用户或模型预报将改哪些文件。明确只包含当前基线受控普通文件；未跟踪/忽略文件不自动复制，所需缺失材料按任务明确报缺，不把用户机器其他内容搬进工作树。原项目dirty时沿用现有基线冲突规则，不擅自清理或换HEAD。

工具允许工作树内任意合法相对路径；仍拒绝根外路径、任意层级.git、symlink/junction穿越、硬链接多实体写入及子模块穿透。创建检查最近真实父目录；delete/rename核验源与目标，两端都在同一受信工作树，目标已存在默认冲突而不是覆盖。调用前后核验实体/前摘要，按既有toolCallId/requestDigest幂等与修改串行执行，未知结果不重放。

Pi原生read/edit/write不更换；delete/rename通过同一第一方文件工具Adapter增加窄操作，不经shell偷渡，也不新增文件管理框架。目录操作限定为逐项受控普通文件；不支持的链接/特殊文件/子模块变化必须失败列明，不悄悄遗漏。命令执行仍服从现有规则；当前TaskHub不支持的命令继续拒绝，工作树cwd本身不是OS沙箱。

captureTaskPatch扫描整个受信工作树实际净变化（含新建未跟踪文件），与Main基线账本比对，不依赖模型列举。空diff不伪造成果。对非授权实体变化、Git元数据或无法可靠表述的变化拒绝形成可Apply交付。

### 5. 删除／重命名到Diff、Delivery、Apply

- 在现有TaskPatch/ChangeSet/Delivery文件Artifact引入版本化的存在状态：CREATE无前像、MODIFY有前后像、DELETE有前像且后态不存在。相应摘要、parser、校验器和Renderer一起迁移，旧V1内容继续可读，禁止把DELETE变成空文件。
- 重命名的权威文件效果采用**DELETE旧路径＋CREATE新路径**同一变更组（带源/目标关系展示）；避免单独建一套重命名事务。工具操作回执给出rename关系，实际两端字节与存在状态必须验证。Git相似度检测只影响显示标签，不能授权或决定文件操作。rename后编辑仍按真实新内容生成Diff。
- `delivery-composer`、`delivery-integration-worktree`从同一基线按有序结果应用三种净文件效果；两个路径碰撞、大小写歧义或缺少必要祖先输入时报冲突。依赖任务只消费已验证登记的派生基线，不将失败修复产物冒充已验证祖先。
- `change-apply`复用既有预检/日志/恢复结构：修改及删除前必须匹配原项目当前前摘要，新建/rename目标必须不存在；任何冲突停止且保留用户改动。执行失败时按现有事务语义恢复已改文件，删除恢复原字节；结果无法确认则UNKNOWN，不自动重试。跨文件恢复不得丢弃rename任一端；case-only rename的Windows执行顺序必须单独Spike验证。
- Apply批准绑定精确Delivery摘要、验证receipt及本次Attempt；批次变化后原批准失效。新流程自动生成Delivery不等于批准Apply。

### 6. 自动执行 → 验证 → Delivery与停点

复用execution-orchestrator、原Pi Adapter/Loop、task-verification-coordinator、runtime outcome monitor、delivery-workflow及hub-execution-lifecycle。Main根据一次接纳沿用任务正文/验收要求，内部生成计划、按既有DAG调度，工作树准备成功后自动执行；并行仍服从当前槽位/依赖约束，不新建调度器。

验证必须调用原有按模式verification port，记录真实命令/工具结果、退出状态及候选摘要。模型完成陈述不触发成功。WORK/DESIGN产物路径由Agent在受信工作树内决定，原固定“用户预报唯一CREATE路径”适配改为Main核验实际产物并登记；不扩大原有文档/设计能力。删除/重命名不能被现有“每路径必须有新文件artifact”检查误判或漏验。

**有限修正方案，待主管批准：** Pi执行未结算前，通过同一工具接缝返回既有verification port的失败诊断给原Pi Loop，自主修正后再验证；建议最多2轮修正，计数持久在现有Attempt私有runtime记录，不新增重试状态机/配置UI。每次验证绑定实际候选摘要。最后TaskHub仍独立核验确切成果；摘要未变的同一次验证可复用真实receipt，修改后必须重新验证。当前Pi Adapter终态会关闭Worker，故不能先写SUCCEEDED再复活同一Attempt来修。已结算失败/UNKNOWN不在本自动修正窗口内。

最终真实验证PASS且无未解决阻断时，由Main以稳定键（任务/精确Attempt集合＋候选摘要）调用现有Delivery选择/生成Seam，自动生成一次Delivery及Delivery验证。不得扫描同flow历史所有成功Attempt充数，不把部分任务成功伪装为整任务完成。正常流走到READY_FOR_REVIEW后停止写入，用户只看Diff和结果，再决定Apply。

失败停点：任务身份/项目/基线/链接冲突在执行前停止；权限超出、必需信息缺失时才询问；有限修正耗尽或最终verification失败保留失败证据；Delivery构造/验证失败不给成功/Apply入口；中断及OUTCOME_UNKNOWN只对账，不自动重发prompt或原任务。已确定完成的捕获/验证/Delivery步骤可依既有幂等记录恢复，不等同重新执行模型。

### 7. 旧任务及检查点缺口

旧任务、角色配置/快照、FILE_LIST_V1授权、失败Attempt及日志原样保留。旧授权不能升级成新工作树授权；没有V2一次接纳记录就不自动恢复执行。用户日后主动执行旧任务时需一次明确的新接纳、创建新Attempt并关联历史，而非改写旧FAILED/UNKNOWN状态；当前两条失败业务Attempt不作为施工试验对象。旧角色数据只作历史兼容，不再决定新TaskHub能否执行或使用哪个模型。

检查点会话地址登记缺口**仍未修复**：此前诊断显示新会话canonical scope已存在而检查点私有地址记录缺失，角色预检借该登记找Worker。目前新TaskHub运行已有专属Pi Attempt Worker及其SQLite恢复，不应为执行绕回普通聊天Worker。

本次不要求修整套检查点登记/恢复：新流程不再通过角色预检冷装载聊天Worker，人工检查点也不是一次接纳→Delivery→Apply的前置。必要修改仅为移除该执行依赖并如实保留/显示历史检查点不可用状态，不能写“问题已修复”；结果恢复使用既有精确Attempt运行时记录。若首批调用图核对发现自动执行或结果恢复仍真实依赖该地址表，应在原可信Main登记Seam补最小接线并先报主管，不能旁建登记表或借隐藏错误解决。

### 8. 最小验证与分段交付

本轮只读实查并出方案，未跑测试、模型或新复现。批准后代码和脚本统一交 `gpt-5.6-luna/max`，根owner审查、必要验证、固定提交与交付；不复跑未受影响的原代码验收门。

1. **契约/合成Spike候选**：使用同一生产Seam、全新合成Git/SQLite验证V2接纳与来源、工作树授权、DELETE/rename到capture/Delivery/Apply（含冲突/恢复）。确认Pi文件操作/验证反馈接缝可实现；生产默认未替换。固定证据后交主管，不以只有类型/按钮算通过。
2. **生产接线候选**：同步替换UI与Main确认/角色/文件门，接自动验证与Delivery；一条无外部模型的Scripted Runtime真实工作树组合旅程覆盖一次点击到READY_FOR_REVIEW，Apply仅在测试夹具中显式确认。工作流应覆盖WORK/DESIGN/CODING既有能力的受影响门，不重复各成熟工具本体套件。
3. **主管批准后的真实用户门**：新合成业务、统一用户模型、真实Electron单次接纳→修改/新增/删除/rename→验证→自动Delivery；Apply由用户决定，现有失败现场不重试。安装包、真实模型、Hub联合旅程本轮均未覆盖，后续须单独授权。

必测集合按变化选最小场景，不按新增文件全跑：

- 新任务一次点击贯通、重复点击/进程重启不多建flow/Attempt或重复派发；旧缺授权不自动启动。
- 无角色记录、无预填文件、未发聊天消息的新会话仍能进入授权执行；ASK/PLAN写入拒绝，命令/外传原策略不放宽。
- Main原始任务与目标绑定，Renderer伪造任务正文/授权范围或项目切换拒绝；LF/autocrlf及DERIVED来源门仅复跑受新授权账本影响的原项。
- 同一实际旅程新增/修改/删除/重命名均进入精确Diff；escape/.git/symlink/junction/hardlink、目标碰撞拒绝；原项目Apply前不变。
- capture→Delivery→人工Apply的前后字节/存在状态、rename双端、原项目冲突及中途中断恢复；V1历史可读但不变权限。
- 失败验证回馈修正、预算用尽停止、未知结果不重放；自动Delivery精确Attempt/receipt绑定且重复完成事件不多生成、不自动Apply。
- 只对变化TS执行类型/定向lint/diff-check，必要构建；不跑无关全量测试，不复测Pi/Office成熟本体。

各候选更新本方案和DEVELOPMENT_STATUS的实际文件、命令/结果、风险/未覆盖项，提交当前隔离分支后等待主管验收。Hub/网页必要契约差异只由桌面主管对接中台，不越级派发。

### 9. 送审结论与待定事项

用户产品选择已明确，无需再次确认角色、文件清单或确认次数。需要桌面主管确认的是本方案的实施口径：V2授权与旧记录隔离、rename以DELETE+CREATE贯通、最多2轮未结算修正预算、检查点缺口暂不扩修及分段证据门。它们是本次方案门，不要求用户日常操作增加按钮。

目前未证明Pi验证反馈/文件操作与全链V2契约的运行结果；不能写成已完成。若Spike暴露现有Seam不足，应具体报告差距，不能偷偷降为“只支持CREATE/MODIFY”或恢复逐文件审批。计划审查前不编码、不安装、不业务执行。

## 2026-09-14｜已批准源码 d8ff330 的安装候选交付

- 桌面与中台已批准源码 `d8ff33029ab0c123aad956630ba401579b7bac2f`，Standards/Spec 无阻断，既有 LOW 不扩修。开工核对该 HEAD、当前隔离分支、干净工作树和保护 stash `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61` 不变。
- 本轮只构建、NSIS x64 打包和内容核对。复用上一轮 `terminal-release-20260914` 的 builder/resource-audit/verify-package 三个脚本原字节，不复制启动脚本，不编码新脚本；如确需改脚本再交 Luna/max。使用已有 E 盘 builder 缓存、BCJ 与固定 DESIGN/Office/Pi 资源，不升级依赖。
- 新输出独立放 `E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/checkout-bytes-package-d8ff330-20260914`；保留旧9c安装包及全部业务现场。必要 electron-vite build 后以固定 SHA 核对 ASAR/out、固定资源和安装器摘要，源码在此期间不变；不重复已过测试。
- 完成后在现有阶段记录写入安装器路径、大小、SHA-256、ASAR摘要及内容报告；仅提交推送文档，区分源码 SHA 与记录 SHA，再停在桌面主管核包门。
- 不安装或启动新包，不改协议关联，不检查或恢复用户改动后的现场，不调用模型、不重试任务、不 Apply、不合主线。真实业务由用户稍后安排。

### 本次交付结果

- 必要构建、NSIS打包与内容核对均退出0，实际7zip使用 `-mf=BCJ`，未升级依赖或改脚本。新安装器 **570629303字节**，SHA-256 `88e988c5522cf4a8cc0329be906aaff1b16b70ad159b7e2c4ebc9065134248a3`；ASAR SHA-256 `6d7dbf7badbaca6a90b5e505a44578de6e612ca0821ebab44ac5522c885afc33`。
- 完整安装器位于新目录 `dist/小规 Agent 院内候选-Setup-0.3.0-rc.2-x64.exe`；`package-verification.json` 的源码固定为 `d8ff33029ab0c123aad956630ba401579b7bac2f`，198个out文件、40个固定DESIGN文件及既有全部随包资源一致。精确路径、资源数量和命令见 `DEVELOPMENT_STATUS.md` 最新条。
- 最后只追加两份阶段文档并推送；记录SHA另列在集中HANDOFF，不能作为本包源码SHA。旧9c包和原现场不动，无功能/脚本改动、无额外测试，无安装/启动/模型/业务/Apply证据。停在桌面主管核包门。

## 2026-09-14｜主管已批准的接续：Main 基线来源透传（已实施，待主管复验）

- 沿用 `f6b53b178ba39510ca360b61e7ac87150d40682d` 与现有6个文件的保留改动，不另开功能阶段、不撤销已完成字节修复。
- Luna/max 接续全部代码、脚本及定向测试；根 owner 只更新方案/记录、审查、验证、提交推送。本次准许在既有 Main 准备适配、基线记录及必要私有接口补齐来源，除已改两个工作树模块外，只改来源绑定和对应恢复/测试实际需要的消费者。
- 来源必须从 Main 已登记的 task_execution_baselines / derived_execution_baselines 核验，绑定当前 Attempt/task、commit/tree、授权 grants 摘要和派生记录。Renderer/模型传参、HEAD差异、parent形状、commit文案和无依据的布尔开关均不能签发来源。
- 原项目来源严格检查原项目原始字节及漂移；派生来源使用已登记不可变输入核验精确授权字节。prepare、capture、Delivery 必须一致，不在不匹配时换来源求通过。
- 使用既有私有记录冻结来源和绑定；恢复重新核验 Main 证据且沿用原来源。旧记录只有精确匹配的 Main 证据才能补齐，缺失/冲突停止，不默认PROJECT或DERIVED。不建状态机、平行数据库，不改变普通CODING、TaskHub、Delivery/人工Apply产品边界。
- 新验证限定：原失败 A→C 派生基线链、缺来源/绑定冲突拒绝、恢复来源不被重解释，以及被此接缝影响的LF/漂移/捕获→Delivery回归；必要类型、定向lint、diff-check。复用其他已通过结果，不跑模型/Electron/原业务/无关全量测试。新日志保存原修复证据目录下 source-binding 子目录，不覆盖既有日志。
- 完成后追加提交并推送原隔离分支，交固定SHA及证据给桌面主管后停止。严禁重试原 xhba_17649067-201c-458a-b007-3d8bdef64906；原失败记录、工作树、项目、profile、DB、节点、stash不动，不prune/reset、不改角色模型、不Apply、不合主线。

### 接续收口结果

- Luna/max 已补齐 Main resolver、现有 SQLite 记录查询和 lease 来源绑定。来源由真实 Attempt/flow/task baseline、staged grants 与派生缓存共同核验，不从 HEAD 差异、提交形状或调用方声明签发。PROJECT 精确读取源文件；DERIVED 精确读取登记 commit blob。恢复重新核对原绑定，旧缺来源记录只在精确 Main 证据下补齐，不默认或改释来源。
- prepare/capture 使用同一来源；Delivery 从原基线与有序已验证结果逐步核验。已修合法 MODIFY→MODIFY 和 CREATE→MODIFY 的前置字节语义，后续 MODIFY 以此前结果为准，不用原项目缺失/旧字节替代。旧成果及原业务现场仍保留。
- 新 Main 三例3/3、新 CREATE→MODIFY 1/1、受影响调度夹具1/1、CREATE expansion 1/1、错绑定/缺证据恢复2/2通过。其余本轮受影响13/13、既有派生6/6和5个workspace单项的已过委派终端结果复用，不重跑。完整命令、文件清单、真实Git/SQLite与夹具边界见 `DEVELOPMENT_STATUS.md` 的“来源接缝收口”。
- 仅4个生产文件、6个测试文件和2个既有文档。额外两个integration文件只迁移测试构造来源，不运行OMP。没有来源平台、平行DB或新状态机，没有改普通CODING、TaskHub/Delivery/Apply产品边界。
- Standards：无规范阻断，1项LOW局部helper重复观察；Spec：当前授权范围无未关闭阻断，仍待桌面主管复验。新测试类型/lint错误按原分工仅由Luna修正，最终检查记录及未覆盖门见状态文档。此前失败日志不删除，不以合成证据冒充恢复原日志/原任务。
- 下一门仅桌面主管定向复验；本次不构建安装包，不跑模型、Electron、原Attempt、重派发、Apply或主线合并。推送本次单一追加提交后停止。

## 2026-09-14｜已批准：checkout 授权字节一致性最小返修

- 基线 `f6b53b178ba39510ca360b61e7ac87150d40682d`，当前隔离分支不变。主管已接收两组合成复现：true 创建 exit 0 后摘要拒绝，false 准备成功；不是恢复原业务 Git 日志。
- 复用已只读实查的 J1 `b12a4b5b098a5d88d947864edf5f4e32f661c796` 中原始字节保持实现与定向测试，局部适配，不整包 cherry-pick。当前故障在 Pi 调度之前，复用既有 Main 准备/捕获/Delivery 模块，不新增 Skill、插件、换行框架或重跑已完成复用调查。
- Luna/max 负责全部脚本、产品代码及测试编码；根 owner 只更新方案/记录、审查、运行必要验证和提交推送。授权文件限定 attempt-workspace.ts、delivery-integration-worktree.ts 及其对应测试；不带入旧 J1 Hub、UI、终态协调或 Apply 变更。
- 严格核验权威原项目实体、HEAD/tree、clean、批准路径及原始摘要，再向受控工作树放入相同字节，复验字节及 Git clean。已准备或含任务成果的工作树不覆盖；恢复不得以播种掩盖任何成果/漂移。captureTaskPatch 和 Delivery 使用同一授权原字节基线；不宽松归一化，不修改原项目或全局 autocrlf。
- 必要验证：LF + local autocrlf=true 的 prepare→capture→Delivery 贯通；原内容漂移拒绝；已有成果不覆盖。复用既有定向回归及 Node typecheck、增量 ESLint、diff-check，不跑无关测试、模型、Electron 或打包。新结果存独立 checkout-bytes-fix-20260914 证据目录，不覆盖原复现。
- 完成后追加提交推送当前分支，回交固定 SHA 和简短证据给桌面主管，停止等待复验。原 Attempt、失败工作树、profile、DB、节点和 stash 均保留；不重派、不 Apply、不合主线。

### 实施交接

**历史阻断，现已由本页顶部批准的来源接缝关闭。** 以下保留发现时的情况：原始字节6项验证闭合后，新增消费者审查发现既有派生基线回归失败。Main 的 TaskExecutionBaselineRecordV1 已保存 ancestor/derivation 字段，但准备请求未传递来源。不能直接将旧 J1 的 `HEAD === baseRevision` 用于合法 derived commit，也不能根据 HEAD 差异/单父提交猜来源。

- Luna/max 完成两个生产模块及两个测试文件，根 owner 审查并验证。只局部复用 J1 原始字节保持逻辑，未带入 Hub/UI/终态协调/Apply。
- 最终6个目标验证按5项通过＋单个夹具修正后1项通过闭合，精确命令/早期失败/证据限制见 DEVELOPMENT_STATUS.md 最新条；没有重复其余已通过测试。Node typecheck、增量lint及diff-check通过。
- 成果保护采取 fail-closed：prepared重放不播种；未完成MODIFY工作树不自动重播种；已有Delivery根不删除。不要把此候选视作授权恢复既有失败任务。
- 当时停点为桌面主管确认接缝补充；现已获批准并实施，按本页顶部收口结果回交。未打新包、未恢复原任务、未合主线，旧复现目录与原现场保持不变。

## 主管 P2 返修方案：Attempt 终态 Worker 回收

- 基线：`07f3d97012acc30deec1792d9dbb7bf204d7c808`，当前隔离分支不变。主管 Standards 已通过；只处理终态专属 Pi Worker 积累这一项 Spec P2。旧代码/安装包记录保留，不代表本次返修已通过。
- 编码交 `gpt-5.6-luna/max`，所有权限定 `pi-adapter.ts` 及既有生命周期测试。先持久化结果，再通过已有 Worker port `close()` → `WorkerManager.stop()` 幂等回收对应 Worker，并解除 Adapter 的活动引用；SQLite 结果/事件/产物继续用于验证与恢复。重复终态、主动 shutdown、启动失败和 Worker exit 的交错只能关闭本任务，不重复派发。持久化失败不能被回收流程伪装成成功或丢掉 UNKNOWN 语义。
- 复用门：已实查 `pi-worker-port.ts` 的现有关闭实现，直接使用已批准的生命周期接口。Skill/插件无权管理 Main 持有的专属 Worker；本轮不新增能力、不升级 Pi，不重跑上一轮复用调查。
- 只补终态回收、重复结算、其他 Worker 隔离、关闭后从 SQLite 恢复不重派发的必要断言；必要 Node 类型、变更文件 lint/diff-check。DESIGN 参数、Delivery 精确 Attempt 绑定、模式验证及原业务已通过项不改、不重复测试。
- 根 owner 复核增量，追加提交并推送；使用已有构建/NSIS/BCJ和固定资源，在新目录制作对应候选，原包原地保留。仅包内容核对，不安装、不启动，不改协议、配置、Hub、原任务或 stash。完成后停在桌面主管复验门，由主管转中台；不合主线、不执行 Apply。

返修源码已由指定 Luna/max 完成：先持久化、单 live 共享 closing Promise、结束后移除对应活动引用、shutdown 等待在途结算及创建后关 SQLite。冷恢复只读已存结果，不重启 Worker/重发 prompt。新增 4 类断言，最终整文件 9/9（带入 5 个旧断言，包括 1 个已过 Delivery 来源断言；不再重复）；Node 类型、两文件 lint、diff-check、必要构建退出 0。准确命令与日志见 DEVELOPMENT_STATUS 顶部。根 owner 本次增量 Standards/Spec 自查均无未解决问题，新包内容核对通过，停在主管复验门。

### 当前返修候选

- 代码 SHA：`9c4042b8c796ee98a6c1213b18da44130c110a2f`，当前分支已推送。后续交接提交只改文档。
- 新 NSIS：`E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/terminal-release-20260914/dist/小规 Agent 院内候选-Setup-0.3.0-rc.2-x64.exe`，570624890 字节，SHA-256 `06a4e5643c157ba8284aa972b80c0c3f511eb1b3050a5b6121d9bf8701ba12f6`。
- ASAR：`3315de88ae7244bc01c4e52ecd8de7dadeec7b37e5dfa65dba602aee906f50a6`；新包 198 个 out 文件、40 个固定 DESIGN 文件及原资源一致，报告在新目录 `package-verification.json`。
- 原 NSIS 工具缓存与 BCJ 参数复用，只有新输出目录；`package-build.log`、`package-7zip-command.json`、`package-verify.log` 留作证据。没有安装/启动、新协议关联、模型或业务执行。旧候选 e28c4bd1 保留。

在代码固定点执行的本次包命令（工作目录为当前工作树）：

```powershell
$evidence='E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/terminal-release-20260914'
$env:ELECTRON_BUILDER_CACHE='E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/closeout-20260914/builder-cache'
$env:ELECTRON_BUILDER_7Z_FILTER='BCJ'
$env:TEMP="$evidence/temp"
$env:TMP=$env:TEMP
node node_modules/electron-builder/out/cli/cli.js --config "$evidence/builder.cjs" --win nsis --x64 --publish never
node "$evidence/verify-package.cjs" --fixed-sha 9c4042b8c796ee98a6c1213b18da44130c110a2f
```

更新：2026-09-14。状态：代码与安装包内容候选完成，待桌面主管复验；新包实际启动未执行。

## 初次候选交接结果（07f3d97，旧包保留）

- 代码：`f5cf8cffb0ba4332aef2fc3e8b1836fa43d27983`，`codex/hub-runtime-01-pi-default-v1`，已推送 `xiaogui`，本地/上游/live 远端一致。后续仅文档交接提交，不改变本包源码。
- NSIS：`E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/closeout-20260914/dist/小规 Agent 院内候选-Setup-0.3.0-rc.2-x64.exe`；570624454 字节；SHA-256 `e28c4bd19ef0d0ac2760c1325d02fda062c22f441d1e37417ad33bed6465fb4c`。
- ASAR：`6b7b06738c8de0e6c556f0360fc4eaf0cb0579299c0d6bece1b7ced4a353013a`；实际核对 198 个 out 文件、固定 DESIGN 40 文件、LibreOffice 19488 文件及其余原资源一致。证据根为上述 `closeout-20260914`，报告 `package-verification.json`。
- Standards：本轮最终 0 项；Spec：原两项代码缺口已定向关闭。此前真实 Pi/native 工具与真实产物、Main 权限/验证/Delivery/恢复证据按下文分层复用；不是三模式外部模型/两机业务旅程证明。
- 未覆盖：新包实际启动、NSIS 实际安装、模型、原 H1/Apply。既有 Main 启动会注册 `xiaogui://`，独立 user-data-dir 不隔离系统协议关联；为保留旧验收入口，未启动新包，也不注入 shim/改 Main。由主管安排不影响原入口的启动环境后补该门。
- 回交只发桌面主管 `01a065e1-4b51-7ba1-ae49-d42b0b1e0ee4`，再由其转中台；当前动态消息工具不可用，知识库进度保留完整索引，未确认主管收到。未合并、未发布，旧现场和保护 stash 未动。

### 打包复核命令

以下命令在代码固定点 f5cf8cff、当前工作树执行；文档提交后的 HEAD 不冒充包源码。外部脚本与原始日志均留在集中证据目录，不把私有资源上传公共仓库。

```powershell
$evidence='E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/closeout-20260914'
$env:ELECTRON_BUILDER_7Z_FILTER='BCJ'
$env:ELECTRON_BUILDER_CACHE="$evidence/builder-cache"
$env:TEMP="$evidence/temp"
$env:TMP=$env:TEMP
node node_modules/electron-builder/out/cli/cli.js --config "$evidence/builder.cjs" --prepackaged "$evidence/dist/win-unpacked" --win nsis --x64 --publish never
node "$evidence/verify-package.cjs" --fixed-sha f5cf8cffb0ba4332aef2fc3e8b1836fa43d27983
```

首次完整打包已生成程序目录，只在 NSIS 工具缓存解包处失败；旧 C 缓存带 EFS，未删除。后续使用上述原 `--prepackaged` 入口续做，避免再编译/复制依赖；NSIS 与内容核对退出码均 0。启动脚本保留但本轮未运行。

## 固定现场

- 工作树：`D:/CodexWorktrees/xiaogui-windows-internal-rc-20260908-v1`。
- 分支：`codex/hub-runtime-01-pi-default-v1`；HEAD `a27b4ad9f5641d9e797cfde4296b94ff45206f4f`。
- 9 月 14 日接续时：保留修改仍在，当时本分支尚无上游、远端无同名分支；随后已按顶部固定代码提交并推送。此项仅保留开工事实。
- 保护 stash `a6ba3bb91fa5fc68aeb42d7f64897e4b1e862c61` 不变。
- 原 4511 安装、96a103 安装器、H1 任务/样例/profile、Hub 及私有仓库现场不动。

## 不再重开的问题

TaskHub 只使用既有 WORK/DESIGN/CODING Harness 和统一模型配置，Pi SDK 固定 0.84.1。Main canonicalScope、已批准计划、Attempt、验证和恢复保持模式绑定；Hub DIRECT/POOL 不是业务模式。普通 CODING 直接写项目与 TaskHub 工作树/Delivery/人工 Apply 继续分离。

WORK 本次仅新建标准 DOCX 报告；DESIGN 仅固定私有来源的 `design_project inspect/open` 项目概览；CODING 仅授权范围内 read/edit/write。不得扩 Bash、外传、其他 Runtime/选择 UI、完整 DESIGN、HUB-INBOX-01 或 HUB-COPY-01。

## 剩余施工与归属

1. **Luna/max：执行与结果收口。** 接续 `pi-adapter.ts`、相应生命周期及 WORK/DESIGN 同链测试。先修当前生命周期测试两处类型错误，再完成真实产物 → 对应模式验证 → Delivery。补齐 WORK/DESIGN 已结算结果恢复、摘要漂移拒绝及未知结果不重放的缺失证据；优先扩已有测试，不增基础设施。只修实际失败的直接消费者。
2. **Luna/max：固定资源与默认装配。** 接续 `design-runtime-source.ts`、`config.ts` 和其必要测试。验证固定 manifest、实际 Python 模块目录一致、未列资源拒绝、默认复用已有 LibreOffice Python。不得将私有源码提交公共仓库，也不安装或下载新 Python/依赖。提供原 `extraResources` 的最小内候选配置片段和可复核内容清单。
3. **根 owner：统一检查、审查、交付。** 整理已通过证据；运行修复后的类型检查、变更文件 lint/diff-check、必要构建。按 Standards/Spec 分别审查本轮固定差异，不以模型自述代替工具/文件/结果证据；仅处理本范围阻断。
4. **根 owner：固定 SHA 与可安装候选。** 代码定型后提交并推送当前分支；在新的私有 E 盘目录使用原 Electron/NSIS/BCJ 配置生成 x64 安装器，原包不覆盖，不制作 Portable、不安装替换日常程序。核对新 ASAR 与该 SHA 构建一致、固定 DESIGN 文件与 manifest、默认 Python 落点及最短无模型启动/资源装载。只交付院内候选，不发布公共 Release。
5. **回交与停止。** 更新 `DEVELOPMENT_STATUS.md`、集中私有证据及既有知识库进度。交桌面主管固定 SHA、安装器 SHA256/大小、准确命令/结果/限制，再由中台复核；不自行启动原 H1 任务或 Apply，不合并主线。

## 证据复用与新增门

### 复用来源

- 实际锁定包 `@earendil-works/pi-coding-agent@0.84.1`（本地 package.json 确認 MIT）：使用公开的 SessionManager、AgentSessionRuntime、createAgentSessionServices、createAgentSessionFromServices、discoverAndLoadExtensions 和 native read/edit/write。9 月 10 日真实 SDK 生产 factory 三模式启动证据验证了注册及 active tools，不是以包名判断可用；不升级包或复制 Loop。
- 当前内置 `xiaogui-work-documents`（第一方，a27 基线）、`internal-comms`（anthropics/skills@53048666b05b4799081517d00e09e0a2dd688678，Apache-2.0）继续使用原 ResourceLoader；本轮只读确认原文件/用途，未修改 Skill。它们负责意图/写作指引，不能签发 Main Attempt 文件权限或冻结 Delivery 结果。
- 已审 pi.dev 候选 `pi-package-manager@0.2.1`、`pi-sandbox@0.6.6` 的版本/来源/只加载与平台结论保留在 [既有复用调查](OMP-ACP-P1D-A-QA.md#pi-原生skill-与插件优先门)。本轮不重新安装或重复其冒烟：包管理命令不提供 TaskHub 私有授权/结果接口，sandbox 候选未提供本 Windows 目标的该接线。此引用仅复用候选事实，不继承旧 OMP 产品路线。
- WORK 直接复用原 `work-report-docx-service` 的规范化/生成器与注册工具；DESIGN 复用获批私有 2d7 Extension 和 Python `design.project`，经已有 sidecar bridge 调用。Main 的新增 Adapter 只衔接现有 TaskHub 权限、结果与 Pi 工具生命周期；没有新的市场、会话权威、任务调度器或通用文件路由。

9 月 10 日已有：真实 Pi SDK 生产 Worker factory 三模式启动/注册表/active tools 3/3；权限通道与 sidecar 34 项；Adapter 生命周期 4 项；应用 41 项；生产组合 9 项。相关日志在 `E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910`，部分旧结果为工具输出，不能伪称全部有独立日志。发生后续源改动的受影响断言才补跑；未变的 Word、Office、C2/H1、外部模型及整套测试不重复。

9 月 14 日新增通过：两处类型夹具修正后统一 typecheck 通过；42 文件定向 lint 通过；三个模式冻结断言通过（其余 41 跳过）；固定资源/config 7 项通过。WORK/DESIGN 真实产物至 Delivery 组合 2/2 通过；在同用例增加关闭重建、恢复后模式/Attempt/Delivery 不变及 prompt 仍只执行一次，2/2 通过。后者由子 Agent 工具输出证明，不伪称已有独立日志。

双轴收口：Standards 三项疑点经来源与消费者核对全部撤回。Spec 两项定向关闭：DESIGN 仅暴露 inspect/open 的真实 TypeBox 参数；Delivery 从选中的 Main TaskChangeSet 重解析精确 Attempt，恢复沿用同一解析，不持久化第二份 ID 权威。真实 Adapter 同路径精确选择与缺失拒绝的新用例通过。最终 Node tsc、42 文件 lint、仓库原配置 diff-check 及必要 Electron 构建通过；Web 复用本轮先前通过结果。代码与新包已固定，具体摘要见顶部；仍待主管复验与无副作用启动安排。跨任务消息接口当前不可用，不以发送尝试冒充交接回执。

### 本轮最小增量命令

在本工作树执行，测试使用现有 Node 依赖，无模型调用：

```powershell
node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/application.test.ts -t 'refuses to reinterpret' --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/main/xiaogui/config.test.ts src/main/xiaogui/design-runtime-source.test.ts --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/pi-mode-production-composition.test.ts --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/delivery-workflow.test.ts -t 'same-path Delivery' --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/main/xiaogui/task-hub/delivery-verification.test.ts --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/worker/handlers/taskhub-pi-sdk-bootstrap.test.ts -t DESIGN --maxWorkers=1 --fileParallelism=false
node node_modules/vitest/vitest.mjs run src/main/xiaogui/agent-runtime/pi-adapter-lifecycle.test.ts -t 'selects Delivery artifacts by exact source Attempt' --maxWorkers=1 --fileParallelism=false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/electron-vite/bin/electron-vite.js build
```

对应测试已回收结果为 3、7、2、1、4、1、1 项通过；类型与构建均退出 0。这些数字是各组结果，不把重复运行同用例加成总通过数。后续仅当相关代码又变化或出现新失败时重跑对应组。提交后可用固定基线 `a27b4ad9f5641d9e797cfde4296b94ff45206f4f` 选取 TS/TSX 增量执行 ESLint，避免干净工作树选中零文件。

验证分层如实记录：真实 SDK/工具和真实文件产物；Main 权限/工作树/验证/Delivery 组合；恢复与模式负例；构建包与无模型启动。进程替身的确定性组合不称为真实外部模型旅程。新三模式自然语言/外部模型及原任务人工联用仍由两主管恢复验收后完成。

DESIGN 固定私有源 commit `2d7e98ffe88a1ec7afff34fcb327d49c35b6e625`；manifest SHA256 `6aa06c44d490b0b49b9acef729f2ffa630b9d06c7e866cc7963a82331e784648`。只从已批准私有导出装入内部安装包，公共仓库保留定位/校验代码和脱敏结论。
