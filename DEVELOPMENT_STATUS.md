# 小规开发阶段状态

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
