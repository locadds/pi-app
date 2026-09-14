# HUB-RUNTIME-01 剩余工作方案

更新：2026-09-14。状态：施工中，未交验。

## 固定现场

- 工作树：`D:/CodexWorktrees/xiaogui-windows-internal-rc-20260908-v1`。
- 分支：`codex/hub-runtime-01-pi-default-v1`；HEAD `a27b4ad9f5641d9e797cfde4296b94ff45206f4f`。
- 9 月 14 日核对：保留修改仍在；本分支尚无上游，远端无同名分支。不得声称已提交或已远端一致。
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

双轴收口：Standards 三项疑点经来源与消费者核对全部撤回。Spec 两项定向关闭：DESIGN 仅暴露 inspect/open 的真实 TypeBox 参数；Delivery 从选中的 Main TaskChangeSet 重解析精确 Attempt，恢复沿用同一解析，不持久化第二份 ID 权威。真实 Adapter 同路径精确选择与缺失拒绝的新用例通过。最终 Node tsc、42 文件 lint、仓库原配置 diff-check 及必要 Electron 构建通过；Web 复用本轮先前通过结果。仍待固定提交、新包及主管交接。跨任务消息接口当前不可用，不以发送尝试冒充交接回执。

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
