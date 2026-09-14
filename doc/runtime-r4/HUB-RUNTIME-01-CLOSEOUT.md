# HUB-RUNTIME-01 剩余工作方案

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
