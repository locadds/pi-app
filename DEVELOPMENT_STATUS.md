# 小规开发阶段状态

## 2026-08-31｜CODING-P1 P1 代码上下文与权限候选

### 阶段状态

- 状态：P1 实现、必要边界复核、聚焦测试、类型检查、完整构建、唯一一条真实 Electron 冒烟和最终双轴审查均已完成；本阶段提交推送后停止并等待人工验收
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`
- P0 固定起点：`ad7564c9d53d48479bf1a384c276290285080fa2`
- 隔离边界：未修改或合并正在施工 WORK 的工作树/分支；未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 让 CODING 模式的 `@` 文件上下文从项目内相对路径形成受控快照，并由 Pi Extension 真正加入当前 Agent turn。
2. Main 依据当前 canonical session scope 解析权威项目根，不信任 Renderer 提供的绝对根目录。
3. 把文件写入、命令和数据外传请求转换为 TaskHub 权威的精确权限意图，提供“允许一次 / 允许本次任务中的相同规则 / 拒绝”。
4. 验证越界、缺少精确目标、UI 超时、拒绝和重启规则恢复均 fail-closed。

### 实际修改文件

- 共享契约：`packages/shared/ipc-channels.ts`、`packages/shared/ipc-contract.ts`、`packages/shared/xiaogui-agent-runtime.ts`、`packages/shared/xiaogui-coding-extension-pack.ts`
- Main 上下文链：`src/main/xiaogui/coding-extensions/context-composition.ts`、`context-ipc.ts`、`context-module.ts`、`context-module.test.ts`、`src/main/ipc/handlers/prompt.ts`、`src/main/ipc/schemas.ts`、`src/main/worker-manager.ts`、`src/main/xiaogui/index.ts`
- Worker / Pi Extension：`src/worker/xiaogui-coding-extensions/context-extension.ts`、`context-extension.test.ts`、`src/worker/handlers/worker-handlers-turn.ts`、`src/worker/worker-port-types.ts`、`src/worker/worker-runtime.ts`
- TaskHub 权限链：`src/main/xiaogui/coding-extensions/permission-module.ts`、`permission-module.test.ts`、`permission-ui-adapter.ts`、`safe-display-metadata.ts`、`safe-display-metadata.test.ts`、`src/main/xiaogui/task-hub/execution-orchestrator.ts`、`execution-orchestrator.test.ts`、`runtime-composition.ts`
- Kimi ACP 精确目标：`src/main/xiaogui/agent-runtime/acp/workspace-policy.ts`、`src/main/xiaogui/agent-runtime/kimi-adapter.ts`、`kimi-adapter.test.ts`
- Renderer 上下文：`src/renderer/src/features/composer/attachments.tsx`、`coding-context-status.ts`、`coding-context-status.test.ts`、`composer.tsx`、`use-composer-file-search.ts`、`use-composer-file-search.test.tsx`、`use-composer-send.ts`、`use-composer-send.test.tsx`
- Renderer 权限：`src/renderer/src/features/extension-ui/coding-permission-dialog.tsx`、`coding-permission-dialog.test.tsx`、`extension-ui-host.tsx`、`src/renderer/src/lib/extension-ui-channel.ts`、`extension-ui-channel.test.ts`、`src/renderer/src/stores/extension-ui-store.ts`、`src/renderer/src/stores/__tests__/extension-ui-store.test.ts`
- Direct Extension UI 与来源封套：`src/main/direct-extension-ui.ts`、`src/main/direct-extension-ui.test.ts`、`src/main/worker-manager-pool.ts`、`src/main/__tests__/worker-manager-extension-ui.test.ts`
- 阶段记录：`DEVELOPMENT_STATUS.md`

### 已完成内容

1. `@` 文件搜索仍只产生项目内相对路径；Renderer 只持有 canonical session address、公开摘要和一次性 `xgctx_*` 令牌，不持有 Main 的项目根或源文件全文。
2. Main 通过 session scope 与 project resolver 解析权威根，拒绝伪造会话、绝对路径、越界路径、目录、二进制和超限内容；公开快照只有相对路径、SHA-256、字节/行数和截断摘要。
3. Renderer 选择 `@` 文件时只记录相对来源；正式发送前才读取最新正文并生成快照。Main 对快照设置 10 分钟主动到期、最多 64 条和总计 8 MiB 的硬上限，绑定同一 canonical CODING 会话并在发送时一次性消费。
4. Worker 的隐藏 Pi Extension 使用稳定 `context` hook，把受控 JSON 作为当前模型调用的临时 custom/user context 返回；不修改 `systemPrompt`，也不把正文追加到 Pi 会话历史。文件内容明确标记为不可信用户资料；符号服务不可用时明确使用受控文本降级，不伪装 LSP 结果。
5. TaskHub 权限意图使用 Runtime 事件中的精确相对路径；所有操作均须至少绑定一个 Attempt manifest 已批准的路径。`COMMAND` 和 `DATA_EGRESS` 还必须携带只在 Main/TaskHub 内部流转的 `sha256:` 动作摘要，展示摘要不能替代权威动作身份。
6. Kimi ACP 的厂商 edit 权限和主机写入权限均携带精确相对目标；工作区策略继续在实际读写时独立校验文件身份、摘要和 Attempt 工作树边界。
7. Main 统一的展示元数据边界会在原始值归一化前拒绝控制字符，并拒绝字符串任意位置的 Windows/UNC/POSIX 绝对路径、`file:` URL、Authorization/Bearer/token 等凭据形态及 URL userinfo；原始命令、凭据、绝对路径和动作摘要均不进入 Renderer 公开契约。
8. Task 级规则按 Attempt + 操作 + 精确路径 + 私有动作摘要持久化；重启后只复用完全相同的规则。UI 不可用或 55/60 秒超时均自动拒绝并清理悬挂对话框。
9. Renderer 权限请求改为 FIFO 队列，并发 Attempt 不再互相覆盖；Direct Extension UI 在超时或窗口发送异常时先清理 pending/listener，再安全失败。
10. Main 给 Worker 转发请求强制覆盖为 `origin: worker`；Renderer 只接受 Main 直发、编号格式与完整 Prompt 契约均通过校验的 `xiaogui-direct` Coding 权限弹窗，Worker 无法冒充权威权限界面。

### 未完成内容

- 尚未接入真实 LSP 服务；当前按冻结规格明确降级为受控文本搜索/上下文，界面显示“符号服务不可用”，不会伪装符号级结果。
- 当前生产 Kimi Adapter 继续禁用终端，因此 `COMMAND` 由版本化契约、TaskHub 和 Scripted 事件测试证明，尚无生产 Kimi 命令执行入口；本阶段没有为验收而放宽终端白名单。
- 当前 Kimi 本机运行时不会主动发起 `DATA_EGRESS` 工具事件；外传目标链已在 TaskHub/Renderer 聚焦测试中验证，但真实云端 Adapter 仍须在后续运行时工作包中接入。
- P2 计划卡、Todo、真实 Diff/验证审阅和 P3 检查点/角色配置未施工。
- 未运行全量测试、未合并、未发布、未制作 Portable。

### 与规格文档存在的偏差

- 没有产品或架构偏差：继续复用 Pi Extension、Renderer Extension UI、TaskHub 和既有 Agent Runtime；未复制 Claude Code 源码，未引入第二套 Agent Loop、权限系统或状态机。
- 规格允许 LSP 不可用时明确降级；本阶段选择 `CONTROLLED_TEXT_FALLBACK`，而不是引入新的 LSP 依赖或伪造符号结果。
- 命令与外传的生产 Adapter 触发尚未开放，这是既有 Kimi 终端禁用和云端运行时未接入的真实边界，已明确记录而非宣称生产可用。
- WORK、DESIGN、Univer Office Surface、DOCX HTML 和 PDF 降级路径均未修改。

### 测试命令和测试结果

#### 聚焦测试

```bat
set TEMP=D:\CodexTemp\xiaogui-coding-p1-evidence\final-tmp
set TMP=D:\CodexTemp\xiaogui-coding-p1-evidence\final-tmp
set NODE_OPTIONS=--max-old-space-size=4096
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-coding-extension-pack.test.ts packages/shared/xiaogui-agent-runtime.test.ts src/worker/xiaogui-coding-extensions/extension-pack.test.ts src/worker/xiaogui-coding-extensions/context-extension.test.ts src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts src/main/xiaogui/coding-extensions/context-module.test.ts src/renderer/src/features/composer/coding-context-status.test.ts src/renderer/src/features/composer/use-composer-file-search.test.tsx src/renderer/src/features/composer/use-composer-send.test.tsx src/main/xiaogui/coding-extensions/permission-module.test.ts src/renderer/src/features/extension-ui/coding-permission-dialog.test.tsx src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/main/xiaogui/agent-runtime/kimi-adapter.test.ts src/main/xiaogui/agent-runtime/runtime-host.test.ts src/main/direct-extension-ui.test.ts src/renderer/src/stores/__tests__/extension-ui-store.test.ts src/renderer/src/lib/extension-ui-channel.test.ts --maxWorkers=1 --reporter=dot
```

结果：`17 test files passed`，`101 tests passed`，退出码 `0`。覆盖权威项目根、发送前读取、全文私有注入、快照容量/主动到期、一次性会话绑定、越界拒绝、精确文件目标、私有动作摘要、安全展示元数据、权限 FIFO、超时清理、规则重启恢复和 Kimi ACP 精确路径。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\focused-tests.log`。

最终工程复核只补跑 5 个直接相关文件，没有重复上述 101 项或全量测试：

```bat
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/safe-display-metadata.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts src/main/__tests__/worker-manager-extension-ui.test.ts src/renderer/src/lib/extension-ui-channel.test.ts src/worker/xiaogui-coding-extensions/context-extension.test.ts
```

结果：`5 test files passed`，`29 tests passed`，退出码 `0`。新增覆盖敏感摘要绕过、Worker 来源冒充、Renderer 完整契约校验，以及正文只进入临时 user-context、不进入 systemPrompt。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\boundary-tests.log`。

最终审查只针对新增的 POSIX 绝对路径边界补跑两个直接相关文件：

```bat
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/safe-display-metadata.test.ts src/main/xiaogui/coding-extensions/permission-module.test.ts
```

结果：`2 test files passed`，`21 tests passed`，退出码 `0`；覆盖单段路径以及 `> ; | &` 等 shell 分隔符后的绝对路径。原始日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\sanitizer-final.log`。最终 Standards/Spec 复核结果均为 `APPROVE`，且确认未扩展至 P2、P3 或 WORK。

#### 类型检查、构建与差异检查

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：最终边界修复后的类型检查和完整构建退出码均为 `0`；主进程、Preload、Renderer、Office Viewer、Office Gateway 均构建成功。构建仅保留既有动态导入/大 chunk 提示。最终构建日志：`D:\CodexTemp\xiaogui-coding-p1-evidence\build-final.log`。差异检查在最终暂存前执行。

#### 真实 Electron 冒烟

- 只执行一条桌面冒烟：`node D:\CodexTemp\xiaogui-coding-p1-evidence\p1-electron-turn-smoke.mjs`，退出码 `0`；没有另增 E2E 测试文件。
- 本机临时 OpenAI-compatible 模型桩收到且只收到一次真实 Electron Main → Worker → Pi Extension 发出的 Agent 请求；请求中包含 `src/answer.ts` 的当前正文和受控上下文标记，并确认正文位于 user-role context、systemPrompt 不含正文。
- Main IPC 公开快照不含源文本和项目绝对根；结构化证据只保存布尔检查、相对路径、SHA-256 和字节数，不保存请求正文。
- 真实 Renderer 先拒绝一份 `origin: worker` 的伪造 Coding 权限请求，再显示 Main 直发的权限对话框；界面精确展示 `src/answer.ts` 和三个冻结决定，并实际点击完成“允许一次”。
- 结构化证据：`D:\CodexTemp\xiaogui-coding-p1-evidence\p1-electron-smoke.json`。
- 可见证据：`D:\CodexTemp\xiaogui-coding-p1-evidence\p1-permission-dialog.png`。

### 已知风险

1. 快照在正式发送前才生成并立即消费；若进程在两步之间异常中断，未消费快照仍会在 10 分钟后主动删除，并受 64 条/8 MiB 总量硬上限保护。
2. 单次上下文总量上限 1 MiB、最多 20 个来源；大文件会明确标记截断，不能视为已读取全文。
3. 当前快照正文使用 UTF-8 文本回退；包含 NUL 的二进制会拒绝，但其他非 UTF-8 文本可能出现替换字符，后续 LSP/编码探测接入前不得声称语义完整。
4. Permission Task Rule 持久化在本机 TaskHub SQLite，仅绑定 Attempt、精确路径和私有动作摘要；没有新增账号或多人身份语义。
5. 当前生产 Kimi 仍未开放终端，云端 Adapter 也未接入外传事件，因此 `COMMAND` / `DATA_EGRESS` 的真实生产触发仍是后续运行时工作包边界。
6. 唯一 Electron 冒烟使用本机模型桩验证传输与 UI 接缝，不代表任一真实云模型的生成质量或语义能力。

### 下一阶段计划

本阶段双审和提交推送完成后停止，等待人工验收。人工验收通过后才进入 P2：只读计划阶段、计划卡修改/批准、Attempt 内 Todo、真实工作树 Diff 与验证证据；不提前施工 P3。

## 2026-08-31｜CODING-P1 P0 六个受控扩展契约与三接缝 Spike

### 阶段状态

- 状态：P0 契约、接缝 Spike、聚焦验证和双轴只读审查完成，等待人工验收
- 独立工作树：`D:\CodexWorktrees\xiaogui-coding-extension-pack-v1`
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`
- 冻结基线：`planning-agent/agent/next-phase-prompt-office-v1@0f7d74bbe1e8e41aa3294f0d7f0cc9a919f2c937`
- 隔离边界：未修改正在施工 WORK 的工作树或分支；未合并阶段线、未发布、未制作 Portable

### 本阶段目标

1. 冻结 `XiaoguiCodingExtensionPackV1` 的六个受控 Coding Module manifest。
2. 冻结 Pi Extension、TaskHub、Renderer Extension UI 三条接缝使用的版本化窄契约。
3. 用进程内 Scripted Adapter 证明 `Pi Extension → TaskHub → Renderer` 的注册事件可以确定性往返。
4. 保证 P0 不注册生产工具、不启用生产模块、不改变现有 CODING、WORK 或 TaskHub 状态机。

### 实际修改文件

- `packages/shared/index.ts`
- `packages/shared/xiaogui-coding-extension-pack.ts`
- `packages/shared/xiaogui-coding-extension-pack.test.ts`
- `src/worker/xiaogui-coding-extensions/extension-pack.ts`
- `src/worker/xiaogui-coding-extensions/extension-pack.test.ts`
- `src/main/xiaogui/task-hub/coding-extension-seam-bridge.ts`
- `src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增 `CodingExtensionManifestV1`，冻结代码上下文与符号、权限、计划、Diff 审阅、Git 检查点、角色配置六个 Module 的编号、中文名称、能力与三条必需接缝。
2. 六个 Module 均固定为仅允许 `CODING`、`defaultEnabled: false`；P0 Pi Factory 只发出 `MODULE_REGISTERED`，不注册 hook 或工具。
3. 新增上下文、权限意图、计划草稿、审阅证据、检查点与角色配置六组共享 V1 契约，以及注册事件、TaskHub 回执、Renderer 投影和往返回执。
4. 注册事件运行时校验采用冻结 manifest 和精确字段集合；伪造能力、未知字段及夹带绝对路径会在进入 TaskHub 前失败关闭。
5. 新增单一 `dispatch` 接缝桥：TaskHub 必须先接受事件，Renderer 才能收到只含扩展编号、中文名称、序号和就绪状态的窄投影。
6. 用六个隐藏 Pi Module、Scripted TaskHub Port 和 Scripted Renderer Port 完成一次进程内往返，证明事件顺序、投影和回执一致。
7. 完成 Standards 与规格符合性两路只读审查；代码实现无 blocker，阶段收口要求已落实到本记录、独立提交和独立分支推送。

### 未完成内容

- P1 的 `@` 文件/符号上下文、LSP 降级、命令/写入/路径/外传权限对话框尚未施工。
- 六个 Module 尚未装配进生产 `worker-runtime`，也没有任何生产工具、Renderer 控件或 TaskHub 持久化行为。
- P2 的计划卡、Todo、真实工作树 Diff 和验证审阅尚未施工。
- P3 的检查点恢复、角色编辑及真实 Electron 联合旅程尚未施工。
- P0 没有可见生产 UI，因而本阶段以进程内三接缝 Scripted 往返作为冒烟证据；没有伪装成生产 Electron 功能已接通。
- 未运行全量测试、未合并阶段线、未覆盖 WORK 主线、未发布或制作 Portable。

### 与规格文档存在的偏差

- 无产品或架构决策偏差：实现继续复用 Pi Extension、Renderer Extension UI 和 TaskHub 三条冻结接缝，没有复制 Claude Code 源码，也没有引入第二套 Agent Loop、权限系统或任务状态机。
- P0 只证明契约和进程内 Scripted 往返，没有提前装配生产 runtime 或呈现 Renderer UI；这符合“先契约和 Spike，再替换生产功能”的阶段边界。
- 本阶段未修改 WORK、DESIGN、Univer Office Surface、DOCX HTML 或 PDF 降级路径。

### 测试命令和测试结果

#### TDD 与聚焦测试

新增契约、Pi 注册器、三接缝往返和绝对路径夹带防护均先观察到目标失败，再补最小实现至通过。

```powershell
.\node_modules\.bin\vitest.cmd run packages/shared/xiaogui-coding-extension-pack.test.ts src/worker/xiaogui-coding-extensions/extension-pack.test.ts src/main/xiaogui/task-hub/coding-extension-seam-bridge.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/direct-extension-ui.test.ts --reporter=dot
```

结果：`5 test files passed`，`15 tests passed`，退出码 `0`。其中包含现有 Scripted Runtime composition 和 Direct Extension UI 接缝回归。

#### 类型检查、构建和差异检查

```powershell
npm run typecheck
npm run build
git diff --cached --check
```

结果：三项退出码均为 `0`。主进程、Preload、Renderer、Office Viewer 和 Office Gateway 构建成功；仅有既有 chunk 体积提示，没有新增构建失败。

#### 基线债务复核

```powershell
.\node_modules\.bin\vitest.cmd run src/worker/xiaogui-prompt/session-extension.test.ts
```

结果：该既有 WORK 测试在本独立分支和未改动的基线 WORK 工作树均为 `2 failed / 4 passed`，失败原因是旧断言仍期望 `enabledCapabilities: ['work.file-organize']`，而当前基线返回空数组。P0 未修改 Prompt/WORK 文件，不在本包放宽或改写该测试。

### 已知风险

1. 当前三接缝桥是契约 Spike，没有持久化、重启恢复或生产 Renderer 生命周期，不能视为 P1-P3 已完成。
2. `CodingRoleProfileV1.systemPrompt` 已被冻结为契约字段；未来落地时必须作为本机私有配置处理，不得进入公开 TaskHub/Renderer 事件。
3. 六个 Module 后续接入生产时必须继续保持 TaskHub 为 Attempt、权限、工作树、验证和恢复的唯一权威。
4. 基线存在一项与本包无关的 WORK Prompt 测试债务，后续应由 WORK 主线单独修正，不能在 Coding 分支混改。
5. 构建复用 D 盘既有 `node_modules` Junction，未执行 `npm install` 或 `npm ci`；依赖内容由当前冻结基线提供。

### 下一阶段计划

本阶段结束后停止施工并等待人工或审查 Agent 验收。只有 P0 验收通过后，才在同一独立 Coding 分支进入 P1：

1. 实现项目范围内的 `@` 文件/符号上下文和明确 LSP 降级；
2. 接入命令、写入、路径与数据外传权限意图；
3. 复用现有 Extension UI 做“允许一次 / 允许本次任务中的相同规则 / 拒绝”；
4. 验证拒绝、超时、越界及重启恢复后，再提交独立 P1 验收点。

## 2026-08-31｜WORK 全类型资料读取与路径边界调整

### 阶段状态

- 状态：代码修改、聚焦验证、完整构建和真实窗口冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`7e97304`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

根据用户验收反馈，修正“整理资料”仍只是有界目录清单、Agent 只能读取少数格式的问题：

1. 用户点击“整理资料”后仍先打开原生文件夹选择器；
2. Agent 获得通用资料读取工具，对目录中的所有文件建立总账；
3. 普通文本和常见办公文档尽量提取正文，不支持语义读取的二进制仍进入总账并明确标为“仅元数据”；
4. 按用户明确决定，通用 WORK 资料读取不再受“只能访问已选文件夹”的路径边界限制，并允许把绝对路径提供给模型、聊天回复和工具结果；
5. 不把任意二进制“进入总账”伪装成已经理解其正文。

### 实际修改文件

- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-prompt-capabilities.test.ts`
- `packages/shared/xiaogui-prompt-matrix.ts`
- `packages/shared/xiaogui-prompt-matrix.test.ts`
- `packages/shared/xiaogui-work-materials.ts`
- `src/main/xiaogui/index.ts`
- `src/main/xiaogui/index.test.ts`
- `src/main/xiaogui/work-docx-template-intake-parser.ts`
- `src/main/xiaogui/work-materials-composition.ts`
- `src/main/xiaogui/work-materials-service.ts`
- `src/main/xiaogui/work-materials-service.test.ts`
- `src/main/xiaogui/work-materials-worker-tool.ts`
- `src/main/xiaogui/worker-host-tool-router.ts`
- `src/main/xiaogui/worker-host-tool-router.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `src/worker/handlers/worker-handlers-turn.test.ts`
- `src/worker/worker-host-tool-channel.ts`
- `src/worker/xiaogui-prompt/behavior-fixtures.test.ts`
- `src/worker/xiaogui-prompt/builder.test.ts`
- `src/worker/xiaogui-tool-guidelines-baseline.test.ts`
- `src/worker/xiaogui-work-materials-tool.ts`
- `src/worker/xiaogui-work-materials-tool.test.ts`
- `src/worker/xiaogui-worker-tools.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 新增版本化 Worker→Main 能力 `xiaogui.work.materials.v1` 和隐藏工具 `xiaogui_work_read_materials`，只在 WORK 对应能力下暴露。
2. 工具可接收当前目录、相对路径或任意绝对路径；目录递归扫描，文件类型不再使用 DOCX/PDF 白名单过滤。
3. 文本类文件直接读取；DOCX、PPTX、XLSX、ODT、ODP、ODS、PDF、RTF、EPUB 复用 `officeparser/slim` 提取文本；其他格式仍返回绝对路径、扩展名、大小和“仅元数据”状态。
4. 所有读取失败、过大、截断、不支持语义解析、符号链接和解析异常都会作为逐文件警告返回，不静默漏项或伪装成功。
5. “整理资料”不再先在 Renderer 生成 200 项、4 层的清单，而是选择目录后直接让 Agent 调用通用资料工具；三个入口顺序继续保持“整理资料、整理普通文档、按模板生成”。
6. Prompt Capability、Tool Guidelines 和行为基线已同步实际工具能力，避免模型再次声称只有单文件/PDF 能力。
7. `officeparser/slim` 从主进程静态加载改为按需动态加载：主进程主包由约 5.10 MB 降到约 1.54 MB，解析器进入独立约 3.56 MB chunk，减少应用冷启动时无关办公解析代码加载。
8. 未修改 Pi 上游基础 `SYSTEM.md`；本阶段只更新小规叠加的 Capability、工具说明和模式行为层。

### 未完成内容

- “全部类型”表示所有文件都会进入总账，不表示小规已经拥有 CAD、视频、音频、压缩包、数据库或任意专有二进制的语义解析器；这些格式首期为元数据级。
- 仍保留资源安全上限：最多 2,500 个文件、1,000 个目录节点、16 层、单文件 20 MiB、单文件正文 100,000 字符、总正文 500,000 字符；超限会明确警告。
- 新建会话首条消息仍承担 Worker、Pi 会话壳、工具注册和模型连接冷启动。真实窗口本轮显示“思考了 8 秒”；后台预热尚未实施。
- 真实窗口中发现：在新会话首条消息被用户中止后，直接在同一会话重试可能出现 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`。新建会话可正常工作；该问题登记为下一独立修复项。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 用户明确撤销了通用 WORK 资料能力中的两项旧约束：“只能访问用户选择的文件夹”和“不向模型/会话/公开工具结果暴露绝对路径”。本阶段按该新决定实施，并在长期总控中记录为对旧约束的局部取代。
- 该取代只适用于通用 WORK 资料读取，不改动模板资产、Univer 工作副本、模板库、Office 临时令牌和原文件不可变等已有专用契约。
- 未改变《Prompt 架构、模式边界与轻量智能推荐规格》的模式分层；只把 `work.file-organize` 的 Capability 与真实工具能力对齐。

### 测试命令和测试结果

#### 聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP='D:\CodexTemp\xiaogui-test-temp'
npm run test:unit -- <12 个 WORK 资料、Prompt、Worker、Router、首页和模板解析相关测试文件>
```

结果：`12 test files passed`，`69 tests passed`，退出码 `0`。

#### 类型检查、构建与差异检查

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：三项退出码均为 `0`。完整主构建、Renderer、Office Viewer 和 Office Gateway 构建成功；只有既有 chunk 体积与动态导入提示，没有新增构建失败。

#### Electron 真实窗口冒烟

- 使用 D 盘隔离目录 `D:\CodexTemp\xiaogui-work-materials-stage\mixed-folder`，内含 JSON 文本与 PNG 图片。
- 在全新 WORK 会话要求读取该绝对路径；模型实际调用 `xiaogui_work_read_materials`，首轮界面显示“思考了 8 秒”。
- JSON 返回 `CONTENT_EXTRACTED`、绝对路径和正文摘要；PNG 返回 `METADATA_ONLY`、绝对路径、类型、大小及 `FORMAT_NOT_SEMANTICALLY_SUPPORTED`，没有假装理解图片内容。
- 成功证据：`D:\CodexTemp\xiaogui-work-materials-stage\materials-tool-success.png`；首页证据：`D:\CodexTemp\xiaogui-work-materials-stage\work-home-all-materials.png`。证据不提交仓库。

### 已知风险

1. 用户已允许把绝对路径放入模型输入、聊天和工具结果，路径中可能包含人员名、项目名或内部目录结构；这是已接受的新产品边界，不再由产品自动隐藏。
2. 任意路径读取扩大了模型可请求的本机资料范围；当前仍需要模型主动调用工具，且受文件数量、深度、体积和字符预算限制，但不再有选定目录边界。
3. 不支持格式只有元数据，用户若要求内容级理解仍需后续专用解析器或转换能力。
4. 首句冷启动尚未优化；建议下一阶段做“主界面可见后异步预热 Worker/Pi 会话壳”，不得阻塞界面、不得提前调用模型或消耗额度。
5. 开发环境仍有与本阶段无关的可选 `better-sqlite3` 原生绑定警告，不影响本次通用资料工具成功运行。

### 下一阶段计划

等待人工验收本阶段。验收通过后优先单独处理：

1. 主界面显示后的轻量后台预热，并对比预热前后首句耗时；
2. 新会话首条消息被中止后重试的 Session Context 不匹配；
3. 再按真实业务需要逐项补充 CAD、表格高级结构、图片 OCR、压缩包等专用解析器，不把“全类型总账”误写为“全格式正文理解”。

## 2026-08-31｜WORK 三个快捷入口受控选择修复

### 阶段状态

- 状态：代码修改、聚焦测试和真实窗口接缝验证完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`157447b`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

把 WORK 首页三个快捷项从“只向输入框填写一句提示词”改为可测试的受控入口，并保持最终顺序：

```text
整理资料 → 整理普通文档 → 按模板生成
```

目标交互为：

1. `整理资料`：打开原生文件夹选择器，取得受控的相对目录清单后自动进入会话；
2. `整理普通文档`：打开原生 DOC/DOCX 选择器，源文件路径只留在主进程，随后自动启动既有只读模板分析；
3. `按模板生成`：打开本机历史模板库，选择模板或版本后自动进入既有生成会话。

### 实际修改文件

- `packages/shared/ipc-channels.ts`
- `src/main/xiaogui/ipc-handlers.ts`
- `src/main/xiaogui/work-docx-template-intake-composition.ts`
- `src/main/xiaogui/work-docx-template-intake-service.ts`
- `src/main/xiaogui/work-docx-template-intake-service.test.ts`
- `src/renderer/src/features/composer/composer.tsx`
- `src/renderer/src/lib/composer-quick-submit.ts`
- `src/renderer/src/lib/composer-quick-submit.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `src/renderer/src/xiaogui/components/TemplateLibraryView.tsx`
- `src/renderer/src/xiaogui/components/TemplateLibraryView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 三个快捷项不再调用旧的 `setComposerPrefill`：文件夹和文档先完成原生选择，历史模板先进入模板库。
2. 文件夹入口复用已有 `workspace.fs.listDir` 安全边界，递归生成相对目录清单：最多 200 项、40 个目录、4 层，并跳过 `.git` 与 `node_modules` 深入遍历。
3. 文件夹的绝对根路径不写入自动发送的提示词；Agent 后续只按已激活工作区中的相对路径读取资料。
4. 新增主进程专用的普通文档选择通道。Renderer 只收到显示文件名；源路径以项目不透明编号临时暂存 15 分钟，并由下一次模板整理 `START` 一次性消费。
5. 模板整理服务允许消费只有源路径的直接选择交接；原有带 SHA-256 的旧模板生成交接仍继续校验摘要，行为不变。
6. 本机模板库的“使用最新版”和“使用此版本”改为选择后自动发送无路径请求；提示词只包含模板名称和版本号，不包含内部编号或资产路径。
7. 新增 Composer 内部快速提交事件，程序化填入后直接走现有 `sendCurrent` 正式发送链，不复制第二套会话发送逻辑。
8. 真实 Electron 窗口已确认三个按钮顺序正确，并分别验证：
   - `整理资料` 打开标题为“选择项目目录”的 Windows 原生对话框；
   - `整理普通文档` 打开标题为“选择要整理的普通成品 Word”的 Windows 原生对话框；
   - `按模板生成` 进入“本机模板库”页面。

### 未完成内容

- 本轮没有改造左下角通用“添加文件”附件通道；其绝对路径序列化问题仍是独立待办。三个首页快捷入口已经绕开该旧通道。
- 自动识别任意上传文件并在 PDF、DOC、DOCX 等能力间统一路由仍属于后续 P1，不由本轮 DOC/DOCX 专用入口代替。
- 本机尚未配置模板库目录，因此真实窗口只验证到历史模板选择页面；模板版本选择后的自动发送由组件测试覆盖，仍需用户用自己的模板库完成最终验收。
- 为避免擅自把真实业务文档交给模型，自动化没有替用户选中真实 DOC/DOCX；选择后的完整分析结果留给人工验收。
- 未运行全量测试、未制作 Portable、未合并或发布。

### 与规格文档存在的偏差

- 保持自然语言为主入口；三个快捷项只承担用户已经确认的必要选择和启动动作，没有新增独立业务状态机。
- 普通文档仍复用模板资产化规格中的只读分析、人工复核、原文件不可变和既有降级路径；没有修改 Univer、DOCX HTML 或 PDF 降级实现。
- Prompt 架构、模式边界和轻量推荐契约没有变化；快速入口发送的仍是普通 WORK 用户消息。
- 本轮没有解决通用附件路径令牌化，已明确登记为差距，没有伪装为完成。

### 测试命令和测试结果

#### 红灯证据

```powershell
node node_modules\vitest\vitest.mjs run src\renderer\src\xiaogui\components\WorkHomeView.test.tsx src\renderer\src\xiaogui\components\TemplateLibraryView.test.tsx --reporter=verbose --pool=threads
```

生产实现前结果：`2 test files failed`；失败原因为受控快速提交模块尚不存在，证明新交互断言先于实现生效。

#### 修复后聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP_ROOT='D:\CodexTemp'
node node_modules\vitest\vitest.mjs run src\renderer\src\lib\composer-quick-submit.test.ts src\renderer\src\xiaogui\components\WorkHomeView.test.tsx src\renderer\src\xiaogui\components\TemplateLibraryView.test.tsx src\main\xiaogui\work-docx-template-intake-service.test.ts --reporter=verbose --pool=threads
```

结果：`4 test files passed`，`13 tests passed`，退出码 `0`。

#### 类型检查

```powershell
npm run typecheck
```

结果：Web 与 Node 两段 TypeScript 检查均通过，退出码 `0`。

#### Electron 构建与真实窗口验证

```powershell
node node_modules\electron-vite\bin\electron-vite.js dev --remoteDebuggingPort 9333
```

- Main、Preload 构建成功，Renderer 服务启动成功。
- 首次热更新保留了旧主进程白名单，真实窗口捕获到 `IPC channel not allowed`；重启开发应用后新 Main/Preload 生效，错误不再出现。
- 通过 `agent-browser` 连接 9333 CDP 检查真实 Electron 页面；当前环境未提供 Browser plugin，因此没有使用该插件。
- Windows 顶层窗口实查到“选择项目目录”和“选择要整理的普通成品 Word”两个 `#32770` 原生对话框。
- 历史模板按钮实查进入“本机模板库”。
- 可见截图：`D:\CodexTemp\xiaogui-work-quick-actions-evidence\work-quick-actions.png`（不提交仓库）。

### 已知风险

1. 文件夹清单是有界清单；超过 200 项、40 个目录或 4 层时不会继续展开，后续需要增加明确的“清单未完全展开”提示。
2. 同一项目在 15 分钟内由多个窗口同时选择不同文档时，当前项目级临时交接以最后一次选择为准；单窗口正常使用不受影响。
3. 快速入口仍依赖当前 WORK 模型正确调用既有模板整理工具；源文件接缝已建立，但模型和真实业务文档质量需人工验收。
4. 开发环境仍存在与本阶段无关的可选 `better-sqlite3` 索引原生绑定警告，不影响三个入口或模板私有存储的既有降级行为。

### 下一阶段计划

等待用户在当前已打开的小规窗口完成三条旅程验收。若发现问题，只修本阶段入口接缝；验收通过前不进入统一附件令牌化、PDF/DOC 自动路由或其他功能阶段。

## 2026-08-31｜WORK 首页快捷项顺序调整

### 阶段状态

- 状态：人工验收未通过；仅完成顺序，三项业务入口当时无法选择文件或历史模板。后续修复见上方“WORK 三个快捷入口受控选择修复”阶段
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`72ee27a`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

根据用户最终确认，把 WORK 首页三个快捷项的显示顺序固定为：

```text
整理资料 → 整理普通文档 → 按模板生成
```

本阶段只调整显示顺序，不把尚未完成的文件夹选择、文档选择和模板库联动伪装为已完成。

### 实际修改文件

- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 将“整理普通文档”移动到中间位置。
2. 将“按模板生成”移动到最右位置。
3. 新增按 DOM 实际顺序核对三个快捷项的回归断言，防止后续再次换位。
4. 在正在运行的小规 Electron 窗口中确认真实顺序正确；点击中间项后，输入框填入“整理普通文档”的对应提示词，未出现控制台错误。

### 未完成内容

- 三个快捷项目前仍沿用“填写提示词”的旧实现；用户要求的原生文件夹选择、原生文件选择和历史模板选择尚未在本阶段施工。
- 通用附件发送时的绝对路径展示与会话接缝问题不属于本次纯顺序调整，仍需独立修复。
- 未运行全量测试、未制作 Portable、未合并或发布。

### 与规格文档存在的偏差

- 本次顺序调整未改变模板资产、Univer Office Surface、Prompt 分层或模式边界等冻结决策。
- 现有“快捷项只填写提示词”的实现与用户新确认的直接选择器交互存在已知差距；本阶段明确保留并登记，没有宣称已经完成三条业务旅程。

### 测试命令和测试结果

#### 红灯证据

```powershell
node node_modules\vitest\vitest.mjs run src\renderer\src\xiaogui\components\WorkHomeView.test.tsx --reporter=verbose --pool=threads
```

修改生产顺序前结果：`1 failed | 3 passed`；失败差异明确显示旧顺序为“整理资料、按模板生成、整理普通文档”。

#### 修复后聚焦测试

同一命令修复后结果：`1 test file passed`，`4 tests passed`。

#### Electron 可见检查

- 环境：`http://localhost:5173/`，窗口标题“小规 Agent”，通过现有 Playwright 连接 `9333` CDP；未安装新依赖。
- 页面结果：三个按钮的实际无障碍名称依次为“整理资料、整理普通文档、按模板生成”。
- 交互结果：点击“整理普通文档”后，编辑区出现对应提示词；捕获到的相关 console error/page error 为 `0`。
- 框架错误遮罩数量：`0`。
- 截图证据：`D:\CodexTemp\xiaogui-work-shortcuts-order-20260831.png`（不提交仓库）。

### 已知风险

1. 本次只证明显示顺序与快捷项原有填词行为正确，不代表三个快捷项的最终业务交互已经实现。
2. 真实目录整理仍缺少受控的目录清单能力；不能让模型依赖任意终端命令替代产品能力。
3. 历史模板选择应复用本机模板库并保持路径、内部编号不进入公开会话，后续契约需先冻结。

### 下一阶段计划

等待人工验收本阶段。验收通过后，按用户已经确认的交互分别冻结并实现：

1. “整理资料”直接打开文件夹选择器并通过受控目录清单交给 Agent；
2. “整理普通文档”直接打开文件选择器，按真实类型自动路由并开始分析；
3. “按模板生成”直接打开历史模板选择界面，选择后进入生成流程；
4. 通用附件改用不暴露绝对路径的私有令牌通道，并单独修复发送接缝。

## 2026-08-31｜后续待修复 P1：WORK 文档类型识别与能力路由

### 登记状态

- 优先级：P1
- 状态：已登记，按用户要求暂不施工；先继续测试其他能力
- 关联现象：点击“整理普通文档”后，在尚未完成统一文件选择的情况下，模型反问用户是否选择 PDF，并错误声称当前只能选择 PDF
- 影响判断：上一阶段已经修复“三个预设入口无法发送”，但完整的 WORK 文档入口旅程尚未通过产品验收

### 预期产品行为

1. 用户已经上传或选择文件时，由主进程结合扩展名、MIME 与文件头识别类型，不再反问用户文件是不是 PDF。
2. PDF 自动进入 PDF 阅读/分析能力；DOC/DOCX 自动进入普通成品文档整理能力。
3. 用户尚未选择文件时，打开统一文档选择器；选择后再按真实类型路由。
4. 仅在格式不支持、文件损坏、加密或类型确实无法判断时向用户询问。
5. Effective Prompt Manifest、Capability 注册表、实际 Tool 列表和界面文案必须一致，不得让模型虚构“只加载了 PDF 选择器”等能力事实。

### 后续施工边界

- 检查附件元数据与文件头识别、统一选择器、Capability/Tool 暴露和 Prompt Manifest 一致性。
- 不借本问题修改模板领域状态机、Univer 文档工作表面、DESIGN、CODING 或 TaskHub。
- 先做契约与真实工具清单 Spike，再实施最小修复；完成后按独立阶段提交测试证据并等待人工验收。

### 后续验收要点

- 已选 PDF：不询问格式，直接进入 PDF 路由。
- 已选 DOC/DOCX：不询问格式，直接进入模板整理路由。
- 未选文件：打开统一选择器，选择后自动路由。
- 不支持或无法判断：明确说明原因并再询问用户。
- 三个预设入口的模型答复不得与本机实际工具能力矛盾。

## 2026-08-30｜WORK 三个预设入口发送失败热修

### 阶段状态

- 状态：代码修改与自测完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`5bda1ca`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复 WORK 首页三个预设入口在新临时对话中填入提示词后，发送流程因历史会话列表中的旧记录触发 `cwd_not_trusted` 而整体中断的问题。

本阶段只修复共用的“新会话首条消息发送”接缝，不改变三个预设提示词、WORK 能力边界、模板状态机、Univer 文档表面或 Prompt 分层架构。

### 实际修改文件

- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/session-preview-authorization.test.ts`
- `src/renderer/src/lib/new-session.ts`
- `src/renderer/src/lib/new-session.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 会话列表改为逐条授权：某条旧会话、损坏会话或不可信会话校验失败时，仅隐藏该行，不再使整个会话列表失败。
2. 旧记录被隔离时只记录错误类别，不记录本机绝对路径。
3. 新会话创建后的侧栏刷新改为非阻断操作：刷新失败时沿用当前本地列表并加入新会话，不再阻断首条消息发送。
4. 新增两条回归用例，分别覆盖：
   - 单条不可信历史记录不影响其余会话列表；
   - `session.list` 失败不影响新会话首条消息继续发送。
5. 在真实 Electron 窗口逐一验证三个预设入口：
   - `整理资料`：提示词成功发送并收到模型回复；
   - `按模板生成`：提示词成功发送并收到模型回复；
   - `整理普通文档`：提示词成功发送并收到模型回复。

### 未完成内容

- 未验证三个入口后续的完整文件选择、模板分析、复核和正式生成旅程；这些不是本次“发送失败”热修范围。
- 未迁移或自动修复磁盘上的旧会话头信息；不可信旧记录目前采取安全隐藏。
- 未修复模型对本机工具能力的错误描述，例如模板入口回复中可能声称“当前只加载了 PDF 选择器”。该问题需作为下一独立阶段处理。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 本阶段没有改变《模板资产化产品改造规格》的字段图、异常驱动复核、原文件不可变和人工确认规则。
- 本阶段没有改变《Univer Office Surface 开发实施规格》的 DocumentSurface、OOXML 真值、降级路径和依赖边界。
- 本阶段没有改变《Prompt 架构、模式边界与轻量智能推荐规格》的 WORK/ASK/PLAN/EXECUTE、Capability、Tool 和模式推荐规则。
- 实际代码与规格目标无新增偏差；“模板入口的模型工具能力描述不准确”是既有未完成项，已列入风险，不在本热修中静默扩展。

### 测试命令和测试结果

#### 红灯证据

```powershell
npm exec vitest -- run src/renderer/src/lib/new-session.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts --reporter=verbose
```

修改前结果：`2 failed | 11 passed`。两项失败均复现 `cwd_not_trusted` 阻断发送/列表的原始问题。

#### 修复后聚焦测试

同一命令修复后结果：`2 test files passed`，`13 tests passed`。

#### 类型检查

```powershell
npm run typecheck
```

结果：退出码 `0`。

#### Electron 构建与真实窗口冒烟

```powershell
node node_modules\electron-vite\bin\electron-vite.js dev --remoteDebuggingPort 9333
```

结果：Main 和 Preload 构建成功，Renderer 开发服务启动成功。真实窗口依次发送三个预设提示词，Worker 均收到 `prompt`，界面均显示模型回复，未出现 `Send failed`。截图证据保存在 D 盘临时验证目录，不提交仓库。

### 已知风险

1. 不可信旧会话记录仍在磁盘中，只是被列表安全隔离；以后若需要恢复这些记录，应另立迁移工作包。
2. 模板类预设入口的模型回复与实际 Tool 暴露可能不一致，可能降低用户对功能的判断；需单独核对 Effective Prompt Manifest、Capability 和实际 Tool 列表。
3. 本次只证明预设提示词能够成功发送并获得回复，不代表后续模板全流程已经验收。
4. 开发环境仍存在与本阶段无关的可选 SQLite 索引原生绑定警告，不影响本次发送链路。

### 下一阶段计划

等待人工验收本阶段。通过后再单独建立“WORK 预设提示词与实际工具能力一致性”阶段，先用真实 Prompt Manifest 和 Tool 列表做 Spike，再决定是否修改提示词或运行时能力装配；未经批准不进入下一阶段。
