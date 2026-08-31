# 小规开发阶段状态

## 2026-08-31｜WORK 模型语义驱动的局部模板范围

### 阶段状态

- 状态：代码修改、聚焦测试、类型检查、完整构建和真实 Office Surface 浏览器冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`98782a1`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复模板整理把含有少量项目专属信息的整段文字整体标黄、整体变量化的问题。语义判断交给当前接入模型：模型在理解全文后直接引用需要变化、移除或人工判断的最小连续原文；程序不再用关键词或正则脚本替模型分类，只机械验证引用确实存在、重复文字指向明确、范围互不重叠，并把通过验证的精确范围交给字段图、Univer 和物化器。

### 实际修改文件

- `packages/shared/worker-host-tools.ts`
- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-work-docx-template-intake.ts`
- `src/worker/xiaogui-work-docx-template-intake-tool.ts`
- `src/worker/xiaogui-work-docx-template-intake-tool.test.ts`
- `src/main/xiaogui/work-docx-template-intake-worker-tool.ts`
- `src/main/xiaogui/work-docx-template-intake-service.ts`
- `src/main/xiaogui/work-docx-template-intake-service.test.ts`
- `src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.ts`
- `src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.test.ts`
- `src/main/xiaogui/office-surface/docx-univer-projection.test.ts`
- `src/main/xiaogui/work-docx-template-materializer.ts`
- `src/main/xiaogui/work-docx-template-materializer.test.ts`
- `src/main/__tests__/pi-prompt-catalog-effective.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. 模板分析 Prompt 升级为 `template-intake-analysis@1.1.0`：模型可先自由理解全文，只输出真正需要处理的原文片段；未输出内容默认保留，不再要求逐段分类。
2. 模型建议支持 `SELECTION` 和 `WHOLE_FRAGMENT`。通常由模型逐字返回 `selectedText`；只有整块确实需要处理时才允许整块建议。
3. Worker 对模型建议执行机械校验：原文不存在、重复文字未指定出现次序、范围重叠、跨片段局部选择或非法组合都会拒绝，并继续沿用“最多修复一次、之后安全降级”。模型不需要自行计算字符偏移。
4. 主进程候选契约新增 UTF-16 局部范围；同一段可以同时包含多个互不重叠的变量、排除项或待判断项，未被模型选择的前后文字原样保留。
5. 删除了主进程中按“签字、电话、旧项目”等中文关键词替模型进行文本风险分类的规则脚本。非文本对象的 OOXML 结构安全检查仍保留。
6. 字段图和 Univer 投影使用精确范围，同一句相同文字出现两次时可以只标黄模型指定的那一次；高风险文本也能定位到对应片段。
7. 物化器支持同一段内多个局部动作合并执行，例如只把项目名变成字段、只删除日期，而不改动段落其余格式和文字。

### 未完成内容

- 尚未让用户用真实业务文档和当前实际接入模型完成一次端到端人工验收；模型的语义质量仍取决于所选模型能力和文档质量。
- DOCX HTML 兼容降级视图仍保留；本阶段保证 Univer 主视图的精确范围，未扩展旧降级视图的每一种复杂对象局部标注能力。
- 图片、浮动对象、文本框等非纯文本内容仍依照既有结构检测和人工复核，不由本阶段的文本片段协议替代。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 无新增产品架构偏差。仍遵循原文件只读、Agent 结果先进入草稿/工作副本、人工确认后才生成、Univer 单一主视图和保留 DOCX HTML/PDF 降级路径等冻结决定。
- 用户所说的“通过 skill 分析”在本阶段落为小规内部版本化分析 Prompt 与隐藏模板工具能力，而不是新增一个对用户公开的页面或规则引擎；语义决定由接入模型完成。
- 为避免模型输出不可靠偏移，偏移量由程序根据模型逐字引用的原文机械求得。这是数据完整性校验，不参与语义分类。

### 测试命令和测试结果

#### 红灯证据

修改生产实现前，新增用例分别复现：Prompt 仍为 `1.0.0`、同段项目名与日期被返回为整段候选，以及同一锚点的多个局部物化动作触发 `TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT`。这些用例在修复前均失败。

#### 修复后聚焦测试

```powershell
npm run test:unit -- src/worker/xiaogui-work-docx-template-intake-tool.test.ts src/main/xiaogui/work-docx-template-intake-service.test.ts src/main/xiaogui/template-intelligence/template-field-graph-builder-v2.test.ts src/main/xiaogui/work-docx-template-materializer.test.ts src/main/xiaogui/office-surface/docx-univer-projection.test.ts src/main/__tests__/pi-prompt-catalog-effective.test.ts
```

结果：`6 test files passed`，`33 tests passed`，退出码 `0`。覆盖空建议默认保留、重复文本出现次序、选择范围重叠拒绝、同段多变量、精确标黄和局部物化。

#### 类型检查与完整构建

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。主进程、Renderer、Office Viewer 和 Office Gateway 构建成功；只有既有动态导入与 chunk 体积提示。

#### Office Surface 真实浏览器冒烟

```powershell
$env:XIAOGUI_OFFICE_BROWSER_PROFILE='D:\CodexTemp\xiaogui-partial-range-browser-20260831'
npm run smoke:office-browser
```

结果：`ok: true`。验证精确字段范围和黄色标记、正文/表格/页眉/页脚图片解码、Univer 真实挂载、字段更新、保存后重载及零页面/图片控制台错误。

#### Electron 环境门

```powershell
$env:XIAOGUI_OFFICE_SMOKE_USER_DATA='D:\CodexTemp\xiaogui-partial-range-smoke-20260831'
npm run smoke:office
```

结果：退出码 `1`，命中这台主机既有的 `Electron app ready timeout`。该脚本在 Office Viewer 载入前即超时，因此不能作为本阶段功能失败或通过的证据；真实 Office Surface 改由上述浏览器冒烟验证，没有伪装成功。

### 已知风险

1. 不同模型对“最小可变片段”的判断可能不同；程序只保证引用和落位正确，不把模型语义意见当成最终事实，仍须人工复核。
2. 同样文字在一个片段内重复时，模型必须给出第几次出现；否则建议会被拒绝并触发一次修复或安全降级。
3. 模型若漏掉可变内容，该处会按默认规则保留。后续可通过用户自然语言补充或在 Univer 中主动选择，而不应重新引入脚本猜测。
4. Electron 隐藏冒烟的主机就绪超时仍待单独诊断；本阶段没有扩大到 Electron 启动链修复。

### 下一阶段计划

等待人工验收本阶段。验收时使用一份同时含“固定前文 + 项目名 + 日期 + 固定后文”的真实 DOC/DOCX，重点确认只有项目名和日期被标黄、前后正文不变，并尝试在同一段补充一个人工选择。验收通过后再决定是否根据真实模型表现微调分析 Prompt；不得在未观察真实样本前新增关键词脚本或扩大规则体系。

## 2026-08-31｜WORK 普通文档路由与会话续发修复

### 阶段状态

- 状态：代码修改、聚焦测试、完整构建和真实 Electron 窗口冒烟完成，等待人工验收
- 当前分支：`agent/next-phase-prompt-office-v1`
- 修改基线：`0f7d74b`
- 合并与发布：未合并阶段线、未覆盖正式主线、未制作发布包

### 本阶段目标

修复用户单机试用中相互关联的两个 P0/P1 问题：

1. “整理普通文档”选择文件后必须稳定进入普通文档模板整理工具，不能误走通用资料扫描；
2. 候选报告生成后必须显示“开始复核”，点击直接打开复核界面，同时输入框仍允许继续发送自然语言；
3. Worker 退出或应用重新加载会话后，不得因为 Pi 会话头中的旧工作目录触发 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`；
4. 避免一次约 9 MiB 的旧 DOC 被错误路由为对当前目录的大范围扫描，造成超大工具结果、上下文压缩和看似卡顿的分段输出。

### 实际修改文件

- `packages/shared/xiaogui-prompt-capabilities.ts`
- `packages/shared/xiaogui-prompt-capabilities.test.ts`
- `src/main/worker-manager.ts`
- `src/main/__tests__/worker-manager-session-isolation.test.ts`
- `src/main/ipc/handlers/session.ts`
- `src/main/ipc/handlers/session-preview-invalidation.test.ts`
- `src/main/xiaogui/index.ts`
- `src/main/xiaogui/index.test.ts`
- `src/main/xiaogui/ipc-handlers.ts`
- `src/main/xiaogui/work-docx-template-intake-composition.ts`
- `src/main/xiaogui/work-materials-worker-tool.ts`
- `src/main/xiaogui/work-materials-worker-tool.test.ts`
- `src/renderer/src/xiaogui/components/WorkHomeView.tsx`
- `src/renderer/src/xiaogui/components/WorkHomeView.test.tsx`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

1. “整理普通文档”快捷入口的自动提示明确包含“整理成可复用模板”，Capability 推断会选择 `work.template-intake`，不再只暴露通用资料工具。
2. 模板整理装配记录当前尚未消费的已选文档；存在该交接时，通用资料工具的无路径调用会明确拒绝并要求改用模板整理工具，防止模型扫描整个当前目录。用户明确提供路径时，通用资料读取行为保持不变。
3. WorkerManager 新增仅主进程持有的可信会话工作区提示。会话重载时按“存活 Worker → 沙盒绑定 → 可信提示 → Pi 旧会话头”解析工作目录，不再把进程启动目录误当成用户会话目录。
4. 新建、打开、待绑定、Fork/Clone、删除和直接打开复核等接缝统一使用该解析结果；执行尝试和会话身份仍保持原有失败关闭规则。
5. 候选报告的按钮仍只由真实 `xiaogui_work_docx_template_intake` 成功工具事件生成，不从模型自然语言伪造。真实历史报告显示“开始复核”，点击直接打开 Univer 文档复核界面。
6. 真实旧会话在 Worker 已退出、Pi 会话头仍含旧 cwd 的条件下继续发送文字，模型正常回复“文字发送已恢复”，未再出现 `XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH`。

### 未完成内容

- 本阶段没有改写模型供应商的增量流协议。此前“一卡一卡”的主要可复现原因是错误路由后扫描了大量目录内容并触发上下文压缩；修复后的新文档流程仍需用户用真实 DOC/DOCX 再观察供应商侧流式体感。
- 老式 `.doc` 仍需要既有 DOC→DOCX 转换能力；本阶段修复的是入口路由和会话续发，不扩大旧 DOC 格式还原范围。
- 没有替用户在原生选择器中选取新的真实业务文件，因此“新选择一个 DOC/DOCX → 新报告 → 复核”的最终业务内容质量仍由人工试用验收。
- 未运行全量测试、未制作 Portable、未合并阶段线或正式主线。

### 与规格文档存在的偏差

- 无新增架构偏差。仍遵循“真实工具事件驱动结构化控件”“Agent 修改只进入草稿/工作副本”“不删除 DOCX HTML/PDF 降级路径”的冻结决定。
- 本阶段只在存在尚未消费的模板整理文档时阻止通用资料工具的无路径扫描；这不是恢复已由用户撤销的通用 WORK 目录边界。显式相对路径和绝对路径仍可使用。
- 未修改 Pi 上游基础 `SYSTEM.md`；只修正小规 Capability/工具路由和主进程可信会话绑定。

### 测试命令和测试结果

#### 聚焦测试

```powershell
$env:XIAOGUI_TEST_TEMP='D:\CodexTemp\xiaogui-test-temp'
npm run test:unit -- packages/shared/xiaogui-prompt-capabilities.test.ts src/renderer/src/xiaogui/components/WorkHomeView.test.tsx src/main/xiaogui/work-materials-worker-tool.test.ts src/main/xiaogui/index.test.ts src/main/xiaogui/work-docx-template-intake-service.test.ts src/main/__tests__/worker-manager-session-isolation.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts src/main/xiaogui/ipc-handlers-scope-lookup.test.ts
```

结果：`8 test files passed`，`70 tests passed`，退出码 `0`。其中包含“Worker 退出后忽略旧 Pi cwd 并沿可信用户工作区 Fork”的回归测试。

#### 类型检查与完整构建

```powershell
npm run typecheck
npm run build
```

结果：两项退出码均为 `0`。主进程、Renderer、Office Viewer 和 Office Gateway 全部构建成功；只有既有动态导入与 chunk 体积提示。

#### Electron 真实窗口冒烟

- 以 `D:\AppData\Roaming1` 为隔离用户数据启动当前开发分支，CDP 端口 `9333`。
- 打开一个曾经会因旧工作目录报错的历史会话，发送“只回复‘文字发送已恢复’”；用户消息成功入会话，约 10 秒后收到模型回复“文字发送已恢复”，控制台无新的 Session Context mismatch。
- 打开含真实模板整理成功工具事件的历史报告，界面显示“开始复核”；点击后直接打开“模板草稿复核”及 Univer 文档工作表面，没有把“复核”写入输入框。

### 已知风险

1. Pi 会话文件头的 cwd 仍可能是进程启动目录；当前以主进程可信绑定覆盖它。若未来会话从未经过新建、打开或项目绑定入口，仍会回退到旧头信息并按原规则失败关闭。
2. 用户点击“整理普通文档”后若取消选择，不会留下模板交接标识，也不会触发通用扫描，行为保持安全取消。
3. 约 9 MiB 的 DOC 文件本身不是本次 1,668 文件扫描的原因；若文档内部含大量媒体或转换后极大，后续解析仍可能受既有资源上限约束并明确警告。
4. Univer 仍是 OOXML 原结构导入单机试验，不代表 Word 像素级保真或正式 DOCX Exchange。

### 下一阶段计划

等待人工验收本阶段。建议按以下顺序复测：

1. 点击“整理普通文档”并选择一个 DOCX，确认不再扫描整个目录；
2. 报告出现后直接点“开始复核”；
3. 关闭复核或返回对话后继续发送一句自然语言，确认不再“发送失败”；
4. 观察一次正常规模文档的增量输出体感，再决定是否另立供应商流式传输专项。

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
