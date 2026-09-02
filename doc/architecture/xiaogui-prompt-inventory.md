# 小规 Prompt 架构与来源清单

> 路径说明：原规格示例写为 `docs/architecture/`；本仓库 `.gitignore` 明确包含 `docs/`，该目录是不会随源码发布的本地审计区。真实、可跟踪、可发布的架构文档根目录是 `doc/`，所以本清单的唯一权威路径为 `doc/architecture/xiaogui-prompt-inventory.md`；不得在被忽略的 `docs/architecture/` 另建副本形成双真值。

- 契约：`xiaogui.prompt-contract.v1` / `1.0.0`
- 矩阵：`xiaogui.prompt-matrix.v1` / `1.0.0`
- Capability Registry：`xiaogui.capability-registry.v1` / `1.1.0`
- 本轮能力选择器：`xiaogui.turn-capability-selector.v1` / `1.1.0`
- 模板整理子任务 Prompt：`template-intake-analysis` / `1.2.0`
- Runtime Tool 兼容层：`0.84.1-compat.2`
- Runtime Facts Layer：`1.1.0`
- 日期：2026-09-02
- 状态：A1/A2/A3 与 B1/B2/B3/B4/B5（含 DOC 错误码拆分）已于 2026-09-02 人工验收通过，并以普通合并进入正式产品线 `feat/xiaogui-integration`；尚未制作新的正式发布包

## 一、唯一组装链

真实 Session Prompt 只能由 Worker 内的 `xiaoguiPromptBuilderV1` 完成最终组装：

```text
Pi 最终 System Context
  ├─ 用户 SYSTEM / APPEND
  ├─ 项目 AGENTS / CLAUDE Context
  ├─ Skills 与 Pi Runtime 内容
  └─ 当前工作目录等 Pi 上下文

+ 小规产品层
  ├─ Base Layer
  ├─ Mode Layer：WORK / DESIGN / CODING
  ├─ Phase Layer：ASK / PLAN / EXECUTE
  ├─ Capability Layers
  └─ Runtime Facts Layer

+ custom SYSTEM 兼容层（仅在 Pi 未自动加入实际 Tool Guidelines 时）
  ├─ 共享规则（每个规则 ID 只渲染一次）
  └─ 按工具名归组的“何时调用/不调用”与“调用协议”

→ 最终 Prompt
→ 完整字符数与 SHA-256 Manifest
→ Provider 调用
```

组装失败、缺少必需层、上下文错配、工具越过 Mode/Phase/Capability 或预算超限时必须在 Provider 前失败，不使用不完整 Prompt 继续调用模型。

完整 Prompt 正文只存在于 Worker 内存。Main 和 Renderer 只能取得 Manifest，以及用户明确展开高级诊断时的“小规产品层正文”；用户 SYSTEM、项目上下文和完整 Prompt 不跨 Worker 边界。

## 二、Prompt 来源与六类目录

| 目录分类 | 真实来源 | 运行语义 | 可编辑性 |
|---|---|---|---|
| 产品 System Layers | 小规 Base / Mode / Phase / Runtime Facts | 由代码按当前 Session Context 组装 | 不可编辑 |
| 用户 System / Append | 项目或全局 `SYSTEM.md`、`APPEND_SYSTEM.md` | 由 Pi 选择并进入 System Context | 用户可编辑 |
| 项目上下文 | `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 等 | 由 Pi 作为项目上下文加载 | 用户可编辑 |
| Slash Prompt 模板 | 项目或全局 `prompts/*.md` | 调用时展开为用户消息，不是 System Prompt | 用户可编辑 |
| Tool / Capability Guidelines | 版本化 Capability Registry 与实际 Tool 定义 | 只对当前真实加载工具生效 | 产品代码只读 |
| 专用 Subtask Prompts | 如 `template-intake-analysis` | 只进入对应临时模型调用 | 产品代码只读 |

代码内置只读项使用 `xiaogui://` 虚拟资源，不伪装为本地文件，也不能保存。

Tool Prompt 定义以 `sharedRuleIds`、`usage.when/whenNot`、`protocol.sequence/output`
为结构化真值；Pi 0.84.1 仍消费由同一结构派生的扁平 `promptGuidelines`，工具注册接口没有
变化。共享规则当前固定为“系统选择器代替索要路径”“不泄漏内部运行细节”“成果另存且不
覆盖来源”三类。Runtime 与 Prompt Catalog 使用同一归组方式；标准报告工具登记 schema
合法的最小 PREPARE 示例，模板 Word 工具只示范先 `SELECT_TEMPLATE`、再原样使用返回的
真实 `fieldId`，不提供可被照抄的伪字段编号。

### 专用模板整理子任务

`template-intake-analysis@1.2.0` 只进入普通成品文档模板整理的临时模型调用，不进入
`xiaoguiPromptBuilderV1` 产品 System Prompt 或 Effective Prompt Manifest。它只允许输出
`SIGNATURE`、`SEAL`、`CONTACT_INFORMATION`、`OLD_PROJECT_DRAWING`、
`SCANNED_ATTACHMENT`、`FLOATING_OBJECT`、`TEXT_BOX`、`OTHER` 八种
`riskFlags`；无对应风险时必须输出空数组。运行时类型、Worker/Main 严格校验、系统 Prompt
和一次性 repair 提示均复用 `TEMPLATE_INTAKE_RISK_FLAGS_V1`，不得各自维护枚举副本。

## 三、Mode、Phase、Capability 与 Tool

### Mode

- `WORK`：日常资料、报告、模板整理与生成。
- `DESIGN`：规划设计分析；旧项目 DESIGN 标记段只在运行时去重，不静默修改项目文件。
- `CODING`：代码、测试、构建与受控交付。

旧会话优先使用已保存的 Session / Project Scope；无映射时兼容归入 `WORK`，不迁移历史数据库。

### Phase

- `ASK`：只解释、澄清和读取，不形成持久成果。
- `PLAN`：只分析和制定方案，不实施写入。
- `EXECUTE`：允许可逆草稿和经人工确认的持久操作。

新会话默认进入 `EXECUTE`，不强制先经历 `ASK`。用户明确选择问答或计划时才进入
`ASK` / `PLAN`；安全边界继续由最终 Tool Schema、权限、受控工作区、验证和人工交付门
强制，不能依赖“先问一次”代替。

ResourceLoader 可以注册当前模式允许的候选工具，但“已注册”不等于“本轮可调用”。每条用户消息到达 Worker 后，版本化本地选择器先根据结构化 Context、`DEFAULT` 和原始用户输入生成冻结的 Turn Context；随后 Agent Session 通过 `setActiveToolsByName()` 激活 `Mode ∩ Phase ∩ Capability ∩ Runtime` 的最终集合。`ASK`、`PLAN` 的 Provider Tool Schema 只保留 `read` 和已明确登记为只读的 `xiaogui_read_pdf`，不含 `bash/edit/write` 或 `design_*`。

### Capability

当前登记：

- `collaboration.execution`
- `work.file-organize`
- `work.report-docx`
- `work.template-intake`
- `work.template-generation`
- `design.analysis`
- `coding.workspace`

只有 `DEFAULT` 自动激活。`ALLOWED`、复杂任务、显式导出等非默认能力必须来自结构化 Context，或来自本轮原始用户输入的版本化本地确定性规则。普通文档整理、自有模板生成、标准 Word、纯文字和协作任务具有互斥或明确的选择规则；混合、跨模式或证据不足时放弃高风险预激活。能力缺少所需 Runtime Tool 时不进入 Manifest，也不得声称已执行。

WORK 首页“整理普通文档”快捷入口使用以下固定消息，其中显示文件名只放在完整能力触发句之后：

```text
请使用普通文档模板整理能力，把普通成品文档整理成可复用模板。我刚选择的文件是“${fileDisplayName}”。请立即开始只读分析并生成模板整理报告，不要再次让我选择文件；原文档不得修改。
```

该顺序保证长中文 `.doc` 文件名不会占用本地选择规则的触发跨度。选择器 `1.1.0` 继续保留既有最多 24 字跨度和用户同义词，不通过放宽正则增加误命中；长 `.docx` 由扩展名规则继续作为非回归路径。Renderer 只取得显示文件名，绝对路径仍留在 Main 私有交接中。

## 四、WORK 文档术语

- **普通成品文档**：尚未整理为小规正式模板的 DOC/DOCX 来源。
- **模板整理**：只读识别候选项并交给人工复核的过程。
- **模板整理报告**：模板整理的唯一中间成果名称；“只读”“已确认”只描述状态。
- **候选内容**：模板整理报告内部的条目，不作为报告名称。
- **正式模板**：由已确认模板整理报告生成并另存的模板。
- **成品文档**：按正式模板生成的最终输出。

WORK 首页入口标题继续使用“整理普通文档”，本地能力选择器继续接受既有用户同义词；这两处
面向用户的兼容表达不产生第二套领域对象名称。

## 五、Runtime Facts

每轮产品 Prompt 都包含独立的 Runtime Facts Layer，最多 600 字，至少说明：

- 当前 Mode 与 Phase；
- 工作区是否可用；
- 项目是否可信；
- 本轮有效 Capability；
- 未具备能力时不得伪造成功。

Runtime Facts 不重复工具数量或工具名；真实 `toolNames` 和数量信息继续保存在 Effective
Prompt Manifest。小规产品层总预算为 7000 字。预算由离线测试固定，UI 截断不影响完整
SHA-256。

## 六、Session 绑定与一致性

- Context 在 Main 解析后传给 Worker，并在一个 Turn 内冻结。
- 忙碌、等待 Tool 确认或直接确认时禁止切换 Mode/Phase。
- 空闲切换会重建 Worker，并读取真实 Manifest 验证目标 Context；错配或启动失败时回滚。
- 真实 Turn 捕获的 Manifest 是诊断真值；空闲查询不得用重新推算结果覆盖它。
- 完整 Prompt 字符数与 SHA-256 基于未截断正文；高级 UI 只显示产品层正文，不重新计算哈希。
- 模板整理、模板生成或标准 Word 的明确首轮意图只负责激活本轮候选工具，不能形成一次性续接能力。只有对应 `START` / `PREPARE` 工具真实结束、未报错且返回精确的成功结果，Worker 才提交一次性续接能力；未调用、失败、选择取消、复核挂起或普通模型回复均不提交。该能力只供紧随其后的封闭式短确认消息使用，使用一次即清除。任何新的明确意图、混合任务、模式切换或 Session 重建都会覆盖或清除该能力，不会把全部 `ALLOWED` 恢复成默认。
- 短确认按 `NFKC → 去首尾空白 → 合并空格 → 去末尾句号/问号/感叹号` 规范化，规范化后最多 24 字，并完整匹配：`看起来可以`、`可以`、`可以生成`、`可以生成了`、`确认`、`确认生成`、`生成吧`、`继续`、`没问题`、`就这样`、`保存`、`开始复核`、`复核`、`打开复核卡`。`好`／`好的` 只允许作为通过逗号或空格分隔的礼貌前缀；否定、暂缓、附加修改和其他新意图不能消费 sticky。
- PREPARE 类工具成功后统一引导“如确认继续，请单独回复‘确认’”；模板整理 START 成功后引导单独回复“复核”或“打开复核卡”。正式模板物化仍以小规内置预览按钮和主进程私有确认令牌为主，聊天确认只保留为后备路径。

## 七、轻量模式建议（当前停用）

- 2026-09-01 产品决定：当前版本不做意图识别或模式推荐，模式只由用户显式选择。
- 推荐算法与既有回归测试暂时保留为研究证据，但生产构建没有环境变量入口，界面不会展示推荐或自动切换。

- 纯本地确定性规则，不调用模型，不增加 `AUTO` 模式。
- 只有高置信度、非混合任务、当前空闲、没有待确认流程且草稿可完整保留时才显示。
- “不要/不用/别换模式”等明确拒绝优先。
- 点击时再次检查状态；切换只复制草稿与附件，不自动发送。
- 用户拒绝后，同一草稿不重复提示；草稿变化后才重新评估。
- `XIAOGUI_MODE_RECOMMENDATION_ENABLED` 固定为 `false`；如未来重启研究，必须另立工作包并重新验收。

## 八、旧 DESIGN Prompt 迁移

旧项目中 `<!-- XIAOGUI:DESIGN:BEGIN -->` 标记段不被本包删除。Builder 在内存中去重，并通过 `LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED` 告知用户“仅运行时去重，未修改项目文件”。以后若需要物理清理，必须另立可预览、可回滚的迁移工作包。

## 九、离线验证集

- P01—P06：WORK 解释、模板整理/生成确认门和纯文本任务。
- P07—P08：CODING / WORK 高置信模式建议。
- P09—P10：Tool 缺失与文档注入不改变能力边界。
- P11—P13：PLAN 禁写、CODING 修复链和未知结果措辞。
- P14—P15：混合任务放弃建议、草稿附件保留且不自动发送。
- P16：复用 Worker 从 WORK 切到 CODING 后，Prompt 与 Tool Facts 同时更新。
- Golden、预算、Manifest 哈希和产品层泄漏边界均有聚焦测试。

## 十、CODING 默认角色 Prompt 与兼容迁移

研究、实现、审阅三个内置默认角色均使用五个固定段落：`目标`、`允许`、`禁止`、
`输出契约`、`验证与批准`。研究角色只读定位实现、来源和证据，并区分事实、推断与未知；
实现角色只在批准任务、文件范围和独立工作树内修改，报告真实修改、验证与残余风险；审阅
角色只读审查真实 diff 和验证证据，按严重度给出位置、影响和复现方式，没有发现问题时仍
报告未覆盖风险。三个角色都不得绕过或替代人工批准。

既有 `profileId`、用户可见名称与摘要、工具白名单、数据库表结构和 Attempt 快照结构保持
不变。初始化在事务内执行显式的旧默认到新默认迁移：缺失行插入新默认；只有
`profile_digest` 精确等于上一版内置默认 digest 的存量行才更新；用户修改过的默认角色和
自定义角色一律保留。迁移幂等，第二次启动不改 `updated_at`；既有 Attempt 继续使用冻结的
旧快照，新 Attempt 使用新 digest；`resetDefault` 恢复新默认。Prompt 正文仍只通过显式的
私有编辑/快照接缝读取，不进入列表摘要或普通 IPC 响应。

## 十一、旧版 DOC 转换错误边界

Renderer 的 `LEGACY_DOC_CONVERSION_UNAVAILABLE` 与 `LEGACY_DOC_CONVERSION_FAILED` 现在分别
映射为 intake 公开错误码 `TEMPLATE_INTAKE_CONVERSION_UNAVAILABLE` 与
`TEMPLATE_INTAKE_CONVERSION_FAILED`。前者明确表示转换运行时未安装或未装配；后者表示组件
已可用、但当前文档转换失败。两类用户文案和 Service/Host 公共接缝均有聚焦回归。转换器、
模板状态机和 DOCX 降级路径未修改。

## 十二、禁止项

- 不把 Prompt 当作安全边界替代 Host Gate。
- 不把完整 Prompt、用户 System、项目正文、绝对路径、凭据或令牌发送到 Main/Renderer 诊断界面。
- 不让 Catalog 中“可见”冒充“实际进入本轮 System Context”。
- 不在运行中静默更换 Mode、Phase、Capability 或 Agent。
- 不因旧 DESIGN 标记去重而静默改写用户项目。
