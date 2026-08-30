# 小规 Prompt Inventory 与 PR1 开工记录

- 审计基线：`origin/agent/work-p4-office-surface-test-v1@bbde1cd689ce683d19c85271cb0ba5152eeb4672`
- 审计日期：2026-08-30
- PR 范围：PR1「Prompt Inventory 与契约」
- 行为原则：本 PR 只增加文档、共享契约、声明式矩阵和聚焦测试，不把新契约接入 Session、Worker、Tool 或 UI。

## 规格第 20 节：八项开工信息

### 1. 当前真实 Prompt 组装链路

1. Main 通过 `src/main/worker-manager-pool.ts` fork Worker，`init` 请求只携带 `cwd` 与 `sdkPath`；`newSession` / `loadSession` 请求也没有 Mode、Phase 或 Capability Prompt Context。
2. Worker 在 `src/worker/worker-runtime.ts` 中调用 Pi SDK 0.84.1 的 `createAgentSessionServices`、`createAgentSessionFromServices` 和 `createAgentSessionRuntime`。
3. Pi `DefaultResourceLoader` 发现 SYSTEM、APPEND_SYSTEM、AGENTS/CLAUDE、Skills、Prompt Templates 和 Extensions。Worker 的 `extensionsOverride` 随后向所有 Session 注册 7 个小规隐藏 Tool。
4. Pi `AgentSession._rebuildSystemPrompt()` 从当前实际 Tool 收集 `promptSnippet` 与 `promptGuidelines`，并读取 Resource Loader 的 SYSTEM、APPEND_SYSTEM、Skills 与 Context Files。
5. 未配置 SYSTEM 时，真实 System Context 的顺序是：Pi 内置 Harness（含 Tool Snippet / Guidelines）→ 选中的 APPEND_SYSTEM → `<project_context>` → Skills → 当前工作目录。
6. 配置 SYSTEM 时，Pi 直接以该文件替换内置 Harness，再追加 APPEND_SYSTEM、`<project_context>`、Skills 和当前工作目录。Pi 0.84.1 的这一分支不会加入 Tool Snippet / Guidelines；这是现状，不在 PR1 修复。
7. `.pi/prompts/*.md` 与全局 `prompts/*.md` 是 Slash Prompt 模板，只在用户调用 `/name` 时展开成用户消息，不进入 System Context。
8. Template Intake 的 `MODEL_SYSTEM_PROMPT` 通过独立 `modelRegistry.complete()` 调用进入专用分析模型，不进入主 Agent System Context。

### 2. 所有 Prompt 来源清单

已盘点：Pi 内置 Harness、项目/全局 SYSTEM、项目/全局 APPEND_SYSTEM、AGENTS.override/AGENTS/CLAUDE Context、Skills、项目/全局 Slash Prompt、扩展注册的 Tool Snippet / Guidelines、7 个小规 Worker Tool、外部 DESIGN Prompt 与 6 个 DESIGN Tool、Template Intake 专用模型 System Prompt，以及 Prompt Catalog / Preview 的展示链路。详见下文清单。

### 3. Mode / Phase / Capability / Tool 当前映射

- Mode：WORK / DESIGN / CODING 目前主要是 Main/Renderer Scope 状态；Mode 没有进入 Worker Session 创建请求。
- Phase：ASK / PLAN / EXECUTE 目前是 Main 内存状态。fork Worker 时以 `XIAOGUI_PHASE` 固化；空闲时切换 Phase 会重启当前 Worker。
- Capability：当前不存在统一 Capability Registry，也没有 Session 级 Capability 选择。
- Tool：Worker 的 7 个小规 Tool 对所有模式统一注册。DESIGN 项目还会从项目 `.pi/extensions/xiaogui-design-project/` 加载 6 个 `design_*` Tool。现有 Worker Tool 暴露未按 Mode 或 Phase 过滤。
- 本 PR 新增的矩阵是未来收口的版本化声明，不接入运行时，因此不会改变上述行为。

### 4. DESIGN Prompt 的外部来源和项目写入路径

- 源：`${XIAOGUI_REPO}/src/design/context/DESIGN_SYSTEM.md`。
- 部署入口：`src/main/xiaogui/design-extension-deploy.ts`。
- 目标：`<project>/.pi/APPEND_SYSTEM.md` 中的 `<!-- XIAOGUI:DESIGN:BEGIN -->` / `<!-- XIAOGUI:DESIGN:END -->` 标记段。
- 触发：项目 Scope 首次标记为 DESIGN，以及已标记 DESIGN 项目的 Worker ensure/switch。
- 版本现状：源文件没有显式 Prompt 版本；部署清单 schema v2 记录源内容 SHA-256。审计样本来自外部仓库提交 `2d7e98f`，源内容 SHA-256 为 `2be9d53745ed9da39fa0827bf0a7f9c1c4e6c7369ad734ba40b696166df08651`。
- 失效条件：未配置 `XIAOGUI_REPO` 且没有可定位该源的发布资源时，部署跳过；现有项目标记段不会被本 PR 删除。

### 5. Worker 复用与 Session Context 风险

- 同 cwd 的空闲 Worker 可以从一个 Session 复用到另一个 Session；`loadSession` 只携带 Session 文件与叶节点，不携带 Mode / Phase / Capability。
- Mode 变化不会重建 Agent Session，也没有绑定到当前 Turn；旧的项目扩展和 Prompt 资源可能继续决定实际内容。
- Phase 只在进程 fork 时读取。切换 Phase 的重启只在 Worker 无活动 Turn 时发生；Phase 不属于 Session 文件或 Session RPC。
- `XIAOGUI_PHASE_GUARD` 默认关闭，且只保护外部 DESIGN Extension 的 `design_*` Tool；它不约束 Worker 内置 Tool 或 Pi 原生 Tool。
- Prompt Preview 最多返回 12000 字符。隔离 Preview 关闭 Extensions、Prompt Templates 与 Themes；因此不能证明真实 Tool Guidelines 已进入 Session。

### 6. 拟修改文件列表

- `docs/architecture/xiaogui-prompt-inventory.md`
- `packages/shared/xiaogui-prompt-contract.ts`
- `packages/shared/xiaogui-prompt-contract.test.ts`
- `packages/shared/xiaogui-prompt-matrix.ts`
- `packages/shared/xiaogui-prompt-matrix.test.ts`
- `src/worker/xiaogui-tool-guidelines-baseline.test.ts`

### 7. 向后兼容方案

- 只新增文件，不修改 Worker Session 创建、Tool Definition、Prompt Preview、Prompt Catalog、Composer、Office Surface、语音、TaskHub 状态机或数据库。
- 新契约和矩阵不被生产代码导入；现有 Prompt 内容、Tool 名称、注册顺序、确认门和项目文件部署行为保持不变。
- Contract/Manifest 只共享版本、枚举、标识和摘要，不携带绝对路径、凭据、项目正文或完整 Prompt 正文。
- 不新增 AUTO，不迁移旧 DESIGN 标记段，不改变用户可编辑资源。

### 8. 测试计划

- 聚焦运行共享 Prompt Contract 测试。
- 聚焦运行 Mode / Phase / Capability / Tool 矩阵完整性测试。
- 聚焦运行当前 7 个 Worker Tool Guidelines 基线测试。
- 在合理时间内运行 `npm run typecheck`，随后检查 `git diff --check`、变更文件范围和禁止项。
- 不运行全量测试、Lint、Build、Office 构建或打包；不访问在线模型。

## Prompt 来源与真实 System Context

### Pi Harness、SYSTEM 与 APPEND_SYSTEM

| 来源 | 发现与优先级 | 是否进入真实 System Context | 版本 | 所有者 | 用户可编辑 |
|---|---|---:|---|---|---:|
| Pi 内置 Harness | 没有可用 SYSTEM 时使用 | 是 | `@earendil-works/pi-coding-agent@0.84.1` | Pi SDK | 否 |
| 项目 SYSTEM | 可信项目的 `<cwd>/.pi/SYSTEM.md`；优先于全局 | 是，且替换内置 Harness | 文件内无版本 | 项目用户 | 是 |
| 全局 SYSTEM | `<agentDir>/SYSTEM.md`；仅在项目 SYSTEM 未生效时使用 | 是，且替换内置 Harness | 文件内无版本 | 本机用户 | 是 |
| 项目 APPEND_SYSTEM | 可信项目的 `<cwd>/.pi/APPEND_SYSTEM.md`；优先于全局 | 是 | 文件内无版本 | 项目用户 | 是 |
| 全局 APPEND_SYSTEM | `<agentDir>/APPEND_SYSTEM.md`；仅在项目 APPEND_SYSTEM 未生效时使用 | 是 | 文件内无版本 | 本机用户 | 是 |
| DESIGN 产品 Prompt | 外部源部署到项目 APPEND_SYSTEM 标记段 | 目标文件被 Resource Loader 选中时进入 | 源文件无显式版本；部署 manifest 记录 SHA-256 | 小规 DESIGN 仓库 | 源由开发维护；项目副本可编辑但会被幂等更新 |

Pi 0.84.1 的真实选择规则是“项目优先，否则全局”，SYSTEM 和 APPEND_SYSTEM 都不是项目与全局同时拼接。Prompt Catalog 当前可能同时列出项目和全局 APPEND_SYSTEM；列表展示不等于两者都生效。

### AGENTS / CLAUDE Context 与 Skills

| 来源 | 发现规则 | 是否进入真实 System Context | 版本 | 所有者 | 用户可编辑 |
|---|---|---:|---|---|---:|
| 全局 Context | `<agentDir>` 中首个 `AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD` | 是，位于 `<project_context>` | 文件内无统一版本 | 本机用户 | 是 |
| 祖先链 Context | 从 cwd 到文件系统根，每级只取上述优先顺序中的首个文件；父级先于子级 | 是，位于 `<project_context>` | 文件内无统一版本 | 项目用户 | 是 |
| Skills | Resource Loader 的有效 Skill 列表 | 有 `read` Tool 时进入 Skills 段 | 各 Skill 自管 | 用户、项目或 Package | 视来源而定 |

Prompt Catalog 的本地 Context 扫描当前没有包含 `AGENTS.override.md`，而真实 Pi Resource Loader 包含；这会造成 Catalog 与 Session 的可见来源差异。

### Slash Prompt 与 Catalog 资源

| 来源 | 运行语义 | 是否进入真实 System Context | 版本 | 所有者 | 用户可编辑 |
|---|---|---:|---|---|---:|
| `<cwd>/.pi/prompts/*.md` | 项目 Slash Prompt 模板；调用 `/name` 后扩展为用户消息 | 否 | 文件内无统一版本 | 项目用户 | 是 |
| `<agentDir>/prompts/*.md` | 全局 Slash Prompt 模板；调用 `/name` 后扩展为用户消息 | 否 | 文件内无统一版本 | 本机用户 | 是 |
| Package / Extension `prompts/` 资源 | Prompt Catalog 发现项；是否注册命令由 Package / Extension 自己决定 | Catalog 项本身否 | Package 自管 | Package 作者 | 视安装方式而定 |
| Prompt Catalog | Main 汇总文件扫描、实时 Worker Template 和最多 12000 字符的 System Preview | 不属于 Prompt 来源 | 当前应用提交 | 小规桌面端 | 否 |

### Tool Snippet / Guidelines

Tool 的 `description` 进入模型 Tool Schema；`promptSnippet` 与 `promptGuidelines` 由 Pi Session 从当前实际 Tool 收集。没有自定义 SYSTEM 时，它们进入 Pi 内置 Harness；配置任一生效 SYSTEM 后，Pi 0.84.1 的 customPrompt 分支不会加入它们。

| Tool 或工具族 | 代码来源 | 当前注册范围 | System Context 条件 | 显式版本 | 所有者 |
|---|---|---|---|---|---|
| `xiaogui_create_collaboration_plan` | `src/worker/xiaogui-collaboration-tool.ts` | 所有 Worker Session | Tool 有效且没有自定义 SYSTEM | 无 | 小规桌面端 |
| `xiaogui_read_pdf` | `src/worker/xiaogui-work-document-snapshot-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `xiaogui_work_report_docx` | `src/worker/xiaogui-work-report-docx-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `xiaogui_work_docx` | `src/worker/xiaogui-work-docx-template-data-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `xiaogui_work_docx_template_intake` | `src/worker/xiaogui-work-docx-template-intake-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `xiaogui_work_docx_template_materialize` | `src/worker/xiaogui-work-docx-template-materialize-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `xiaogui_work_docx_advanced_generation` | `src/worker/xiaogui-work-docx-advanced-generation-tool.ts` | 所有 Worker Session | 同上 | 无 | 小规桌面端 |
| `design_project` / `design_document` / `design_data` / `design_cad` / `design_gis` / `design_spatial` | `${XIAOGUI_REPO}/src/design/design-extension/index.ts`，部署到项目 Extension | 已部署并被 Resource Loader 加载的项目 | Tool 有效且没有自定义 SYSTEM | 外部源文件无 Prompt 版本 | 小规 DESIGN 仓库 |
| Pi 原生 Tool | Pi SDK | 当前 SDK 默认 Tool 集 | 没有自定义 SYSTEM | Pi SDK 版本 | Pi SDK |

`src/worker/xiaogui-work-docx-tool.ts` 还保留一个同名 `xiaogui_work_docx` 的旧 Definition，但 `worker-runtime.ts` 没有注册它，因此它的 Guidelines 当前不进入真实 Session。

### Subtask Model Prompt

| Prompt | 调用路径 | 是否进入主 Agent System Context | 版本 | 输入/输出与保护 | 所有者 | 用户可编辑 |
|---|---|---:|---|---|---|---:|
| Template Intake `MODEL_SYSTEM_PROMPT` | `src/worker/xiaogui-work-docx-template-intake-tool.ts` → `modelRegistry.complete()` | 否；只进入专用分析调用 | 无显式 Prompt 版本 | 输入为别名化片段；严格 JSON；校验 fragment id 与覆盖；最多一次修复；截断或无效输出安全降级 | 小规桌面端 | 否 |
| TaskHub / Agent Runtime `prompt` | 任务私有输入交给 Codex/Kimi Adapter | 否；属于子任务用户输入，不是本文件所定义的 System Prompt | 各执行契约自管 | 由 TaskHub 安全与执行契约控制 | 小规桌面端 | 间接来自任务 |

## 当前 Mode / Phase / Capability / Tool 状态

### Mode

| Mode | 当前 Main 状态 | 当前 Worker Prompt / Tool 差异 |
|---|---|---|
| WORK | Scope 与当前模式可记录 | 没有专属 Mode Prompt；看到统一注册的 7 个小规 Tool |
| DESIGN | Scope 可触发外部 DESIGN Prompt、Extension、Skills 与 Adapter 部署 | 没有 Session 级 Mode Context；项目部署成功后额外看到 6 个 `design_*` Tool |
| CODING | Scope 与当前模式可记录 | 没有专属 Mode Prompt；看到统一注册的 7 个小规 Tool |

### Phase

| Phase | 当前状态 | 代码级效果 |
|---|---|---|
| ASK | Main 默认内存值 | 只通过 `XIAOGUI_PHASE` 传给新 Worker；默认关闭的 DESIGN Phase Guard 可读取 |
| PLAN | Main 内存值 | 同上；没有主 Agent Phase Prompt 或通用 Tool Gate |
| EXECUTE | Main 内存值 | 同上；不等于现有确认门被取消 |

### Capability

当前没有统一 Capability ID、Registry 或选择器。`packages/shared/xiaogui-prompt-matrix.ts` 将首次登记规格中的 7 个 Capability、Mode 可用性、Phase 全局语义和 Tool 归属，但 PR1 不执行该矩阵。

## Preview 与真实 Session 的差异

- Live Preview 来自 `session.systemPrompt.slice(0, 12000)`，包含真实 Session 已组装内容但被截断。
- 无 Live Worker 时，隔离 Preview 使用 `noExtensions: true`、`noPromptTemplates: true`、`noThemes: true`，因此不包含扩展 Tool Snippet / Guidelines。
- Preview 没有完整字符数或完整 SHA-256，也没有 Layer Manifest。
- Prompt Catalog 将 Preview 当成只读资源展示，但 Catalog 的来源扫描并不等价于 Resource Loader 的最终优先级。

这些差异属于 PR2/PR4，不在 PR1 修复。

## PR1 后仍保留的已知缺口

- 没有唯一 Prompt Builder、Layer Registry 或 Effective Prompt Manifest。
- Mode / Phase / Capability 尚未绑定真实 Session 生命周期。
- 矩阵尚未过滤 Tool，也未对 ASK / PLAN 建立通用 Host Gate。
- Tool Guidelines 仍分散在 Tool 文件；PR1 只建立现状基线，单一来源迁移留给 PR3。
- Template Intake 专用 System Prompt 仍未显式版本化；迁移与引用留给 PR3。
- Prompt Catalog / Preview 尚未与真实完整 Prompt 使用同一诊断产物。
- 旧 DESIGN 标记段继续保留，不做去重迁移或删除。
- 不包含 Mode Recommendation，也没有 AUTO。
