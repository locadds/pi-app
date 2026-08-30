# 小规 Prompt 架构与来源清单

> 路径说明：原规格示例写为 `docs/architecture/`；本仓库 `.gitignore` 明确包含 `docs/`，该目录是不会随源码发布的本地审计区。真实、可跟踪、可发布的架构文档根目录是 `doc/`，所以本清单的唯一权威路径为 `doc/architecture/xiaogui-prompt-inventory.md`；不得在被忽略的 `docs/architecture/` 另建副本形成双真值。

- 契约：`xiaogui.prompt-contract.v1` / `1.0.0`
- 矩阵：`xiaogui.prompt-matrix.v1` / `1.0.0`
- 日期：2026-08-30
- 状态：PR1—PR5 功能候选；阶段线与正式发布仍需独立批准

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

## 四、Runtime Facts

每轮产品 Prompt 都包含独立的 Runtime Facts Layer，最多 600 字，至少说明：

- 当前 Mode 与 Phase；
- 工作区是否可用；
- 项目是否可信；
- 本轮有效 Capability；
- Runtime 实际加载 Tool 数量；
- 未具备能力时不得伪造成功。

小规产品层总预算为 7000 字。预算由离线测试固定，UI 截断不影响完整 SHA-256。

## 五、Session 绑定与一致性

- Context 在 Main 解析后传给 Worker，并在一个 Turn 内冻结。
- 忙碌、等待 Tool 确认或直接确认时禁止切换 Mode/Phase。
- 空闲切换会重建 Worker，并读取真实 Manifest 验证目标 Context；错配或启动失败时回滚。
- 真实 Turn 捕获的 Manifest 是诊断真值；空闲查询不得用重新推算结果覆盖它。
- 完整 Prompt 字符数与 SHA-256 基于未截断正文；高级 UI 只显示产品层正文，不重新计算哈希。
- 模板整理、模板生成或标准 Word 的明确首轮意图只负责激活本轮候选工具，不能形成一次性续接能力。只有对应 `START` / `PREPARE` 工具真实结束、未报错且返回精确的成功结果，Worker 才提交一次性续接能力；未调用、失败、选择取消、复核挂起或普通模型回复均不提交。该能力只供紧随其后的“看起来可以／确认／继续”等短确认消息使用，使用一次即清除。任何新的明确意图、混合任务、模式切换或 Session 重建都会覆盖或清除该能力，不会把全部 `ALLOWED` 恢复成默认。

## 六、轻量模式建议

- 纯本地确定性规则，不调用模型，不增加 `AUTO` 模式。
- 只有高置信度、非混合任务、当前空闲、没有待确认流程且草稿可完整保留时才显示。
- “不要/不用/别换模式”等明确拒绝优先。
- 点击时再次检查状态；切换只复制草稿与附件，不自动发送。
- 用户拒绝后，同一草稿不重复提示；草稿变化后才重新评估。
- 功能仍由 `XIAOGUI_MODE_RECOMMENDATION_ENABLED` 控制。

## 七、旧 DESIGN Prompt 迁移

旧项目中 `<!-- XIAOGUI:DESIGN:BEGIN -->` 标记段不被本包删除。Builder 在内存中去重，并通过 `LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED` 告知用户“仅运行时去重，未修改项目文件”。以后若需要物理清理，必须另立可预览、可回滚的迁移工作包。

## 八、离线验证集

- P01—P06：WORK 解释、模板整理/生成确认门和纯文本任务。
- P07—P08：CODING / WORK 高置信模式建议。
- P09—P10：Tool 缺失与文档注入不改变能力边界。
- P11—P13：PLAN 禁写、CODING 修复链和未知结果措辞。
- P14—P15：混合任务放弃建议、草稿附件保留且不自动发送。
- P16：复用 Worker 从 WORK 切到 CODING 后，Prompt 与 Tool Facts 同时更新。
- Golden、预算、Manifest 哈希和产品层泄漏边界均有聚焦测试。

## 九、禁止项

- 不把 Prompt 当作安全边界替代 Host Gate。
- 不把完整 Prompt、用户 System、项目正文、绝对路径、凭据或令牌发送到 Main/Renderer 诊断界面。
- 不让 Catalog 中“可见”冒充“实际进入本轮 System Context”。
- 不在运行中静默更换 Mode、Phase、Capability 或 Agent。
- 不因旧 DESIGN 标记去重而静默改写用户项目。
