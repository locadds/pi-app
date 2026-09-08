# WORK Word DOC 主转换交接

状态：阶段候选；固定样本 Word 转换保真及经重试、人工修正的完整 DOC 旅程有真实证据，待总控/人工验收。首次子模型降级原因未确定，安装包未复验，不宣称全程一次成功或模型稳定率。未进入主线、未发布。日期：2026-09-08。

## 决定与边界

用户经总控确认部署基线为 Windows + 已安装 Microsoft Word，覆盖此前“可选/不强制 Word”方向。固定输入 `81f3ff332b64a4664f12175eda6ee8f4559b742f`；分支 `codex/work-word-doc-converter-v1`，工作树 `E:\CodexWorktrees\xiaogui-work-doc-analysis-stability-v2`。早期创建的 optional 分支已在施工前更名，未交付并行选择模式。

DOC 主转换通过现有 Renderer converter 接缝使用 Word，失败明确返回，不回退已知丢表格的 LibreOffice。原 DOCX/PDF 路径不变；原 LibreOffice 26.2.5.2 代码/资源保留，不试其他版本。不修改 Pi、Univer、模板状态机、确认、权限框架或 Office 默认值，不新增转换器页面，不生成第二套 NSIS。

## 复用核查

已实查 Pi 0.84.1 已安装声明及内置文档 Skill；它们提供调用编排而非 binary DOC→DOCX 保真转换。Pi packages 查询包括 [deword 0.3.3](https://pi.dev/packages/deword)（其 DOC 支持为 MHTML/Web Page）、[pi-read-doc 1.0.4](https://pi.dev/packages/%40everyx/pi-read-doc)（提取为 Markdown）、[bun-docx 0.24.0](https://pi.dev/packages/bun-docx)（DOCX 读写/渲染）。这些说明不构成本例 OLE DOC 无损转换的实证，未安装新依赖。既有 LibreOffice 已有三组真实丢表格反证；本轮复用用户现有 Word 的 COM API，并仅封装既有转换接缝，不新造通用能力。

Word API 依据：[Documents.Open](https://learn.microsoft.com/en-us/office/vba/api/word.documents.open)、[AutomationSecurity](https://learn.microsoft.com/en-us/office/vba/api/word.application.automationsecurity)、[SaveAs2](https://learn.microsoft.com/en-us/office/vba/api/word.saveas2)。本轮不分发 Word 本体，安装包只交付自有 helper。

## 独立 Word 对照

固定合成 DOC 10752 字节，SHA-256 `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898`。证据根仍为 `E:\CodexTemp\xiaogui-doc-stability-20260908`，无上传、无模型调用。

运行 `helpers/word-conversion-poc.ps1`，新建且确认非已有进程的 Word PID 10764；版本 Application 16.0 / Build 16.0.20326 / FileVersion 16.0.20326.20132。设置 AutomationSecurity=3，源 ReadOnly=true，不加入最近文件，另存新的 `word-conversion-poc/converted.docx`。源与输出逐项对照：1 表、2 行、2 列，四单元格分别为“事项/成果/资料整理/形成资料目录”，全部段落（含单元格结束符）相同；源摘要不变。输出 16334 字节，SHA-256 `4158317e285783fae28276104078590028d580af8e1516b30dafbada8dc52932`。只关闭该新实例。

首次脚本在打开源文件前因误读 Application.Hwnd 停止；改为自建空白 Window.Hwnd 后完成上述对照。未据首次失败关闭归属未确认的其他 Word 进程。

## 实现与运行时接缝

- `work-word-private-converter.ts`：独立私有源副本，固定系统 Windows PowerShell 路径，Convert/独立 Cleanup，超时与取消明确失败。保留已有 converter 结构接口名称，不借此大范围重命名。
- `resources/word-converter/convert-doc.ps1`：新建实例，禁宏、源只读、另存；确认 PID 不属于启动前进程后记录 PID/创建时间/程序路径。清理时三项完全匹配才终止该实例，清理失败保留现场并失败，不杀同名用户进程。实例身份取得前的 COM 卡死不按名称清理，仍是需要人工处理的边界。
- Windows PowerShell 5 的直接 SaveAs2 调用在真实冒烟中超时；显式引用参数报 PSObject 类型不匹配。现通过同脚本 C# InvokeMember 传 CLR 参数修正，不新增 PowerShell 7 部署依赖。
- `work-document-review-renderer-composition.ts` 默认装配 Word；开发资源路径与 packaged resources 路径分别验证。`WORD_UNAVAILABLE` 保留到 intake 不可用码，其余失败不显示假成功、不退回 LO。
- `electron-builder.yml` 只增加 Windows `word-converter` extraResources；最终安装包由桌面唯一 owner 集成和验收。appId/profile 与 NSIS 配置未改。

## 当前验证

- Adapter 9 项聚焦测试通过：成功、无组件、失败/无输出、错误白名单、取消/超时后 Cleanup、清理失败保留现场。
- Renderer/装配/用户错误映射 12 项通过；新增 Word 不可用映射测试先红后绿。节点类型检查与 diff check 通过。不相加为完整产品验收。
- 随后复核补齐取消不得转为降级成功、实例创建未登记时清理必须失败保留现场、无输出错误码。取消接缝测试先红后绿；最终4文件22项、节点类型检查及构建通过。真实 Windows PowerShell Cleanup 检查：activation.pending 无owner退出1且保留标记，从未启动实例的空目录退出0。
- `helpers/word-adapter-smoke.mjs` 经真实 Windows PowerShell helper→Word Adapter→Renderer 成功；XML 1 表/2 行/4 单元格，文本保留，私有会话根为空，源不变。诊断输出 `word-adapter-output.docx` 72621 字节，SHA-256 `4c07bcfc7196ec2cd6ce2d918488947cf5edf95cabba29dc8e863df7f197c7a2`。私有诊断副本的阶段标记未进入生产脚本；最终旅程使用无标记资源。

## 固定业务代码与真实旅程

业务 SHA：`c6c7124f2230a699c424ef2fbe640467f2f2d9d7`；后续交接提交只改文档。构建 Main SHA-256 `ef1ca2e1daf1085f8dde0c56f5cc92d1c982b9522382330ecc3c9c9456063f36`，Worker `980f256ffe93306cafbaaa38f7ea33ad4980eda2d5f45edee2fdf4ac444ecdbe`，随包 helper `d4c964f30ef022052216f3728f086fd64807d717bd9033b7f5b0e21c3f8caec3`。

本轮环境均在证据根下：Electron userData=`word-final-user-data`，进程级 PI_CODING_AGENT_DIR=`word-pi-agent`，转换临时根=`word-conversion-private`，Office 工作副本=`word-office-worktrees`，模板库=`word-template-library`，成品=`word-outputs`。没有读取另一桌面任务的异常 profile 或复制其信任/私有令牌；模型配置从此前本任务 E 私有配置复制，实际模型仍 `deepseek/deepseek-v4-flash-vision-exp`。本树仍显式 XIAOGUI_OFFICE_TEST=1，未改变 Office 默认，不冒充桌面 RC 的默认 Office 验收。

会话实际落在 `word-pi-agent/sessions/--E--CodexTemp-xiaogui-doc-stability-20260908-inputs--/2026-09-08T15-00-00-800Z_01a08188-7ca0-7d96-abf8-13b20e3c4752.jsonl`。只摘工具调用/结果，不摘思考正文。

1. 原生 read 实际读取本树内置文档 Skill，intake START 经真实系统选择器选入原锁定 DOC，Word 转换后 report.profile.tableCount=1、pageCount=1。首份报告 `xgti1_184a616a-1636-43db-b45f-cce24f4ba216` 出现 MODEL_UNAVAILABLE，10 候选全 UNRESOLVED；没有将它作为可确认报告或成功闭环。
2. 为定位该新失败，临时合成样本限定的私有观测构建执行一次明确重试；输出首轮 VALID、无 repair、无 providerError，报告 `xgti1_c8722d96-f161-4a5b-af53-4633c8e62dfc` 有 11 候选（4 VARIABLE、7 FIXED），仅 SCAN_COUNT_UNKNOWN。`word-model-diagnostic.jsonl` 保留文本与校验结果，不含思考或认证。它不能解释首次 MODEL_UNAVAILABLE；不将重试值混记成首次成功。随后撤回全部观测，恢复 c6 源码并重建，再继续复核与输出。重试分析使用的是仅加私有观测的构建，不冒称整个旅程从头到尾均无观测。
3. 模型把标签连同值选为变量，并将说明短语建议为变量。通过现有 UPDATE/REOPEN 和实际高级复核逐项处理，说明文字及四个表格单元格保留。最终 REOPEN 草稿 `4a09d69d-0dca-4069-9205-4e85ad2aaeae` 实际点击“完成复核并预览”。最终三个字段为标题“项目名称”、正文“正文项目名称”、日期“编制日期”；正文两个字段仍包含标签，后续显式提供带标签的值，不假称已自动缩为最小值范围。右侧文字选区尝试未生成局部 range，未将其记为成功。
4. 模型 materialize PREPARE，实际只读预览显示 3 个变量、0 个排除项，截图 `word-template-preview.png` 已目视核对。通过实际“生成正式模板”按钮及系统模板库目录选择器保存；没有构造确认令牌。模型随后误说未停留预览，和实际按钮/截图不符，仅记录为表述问题，不认定绕过安全门。
5. 模型 SELECT_TEMPLATE 获取真实字段 ID，再 PREPARE：项目名称=示例项目辛，正文项目名称=项目名称：示例项目辛，编制日期=编制日期：2026年9月8日。系统另存选择后、明确确认前，目标文件不存在；单独“确认”后 CONFIRM 落盘，再“打开文档”触发 OPEN。
6. 实际系统 Word 中只操作精确合成成品，追加保存标记，Save→Close→Open，Saved=true；保留1表2行2列、四个单元格逐项相同，标题/正文/日期标签和值正确，旧“示例项目甲”已无残留。`word-final-reopened.png` 已目视核对，之后只关闭该合成文档。原 DOC 摘要再次核对不变，`word-conversion-private` 无残留会话。

| 成果 | 字节数 / SHA-256 |
|---|---|
| 正式模板 | 14538 / `3f73d0e7343b0eadd120195f0c374d94f62bb94ee71cf92708cb34e8eaf072b9` |
| 成品（生成时） | 14657 / `0d1a9a9ffa9b78b0321a5fdd29a72407918c25725d199d61e2d0f57094da43d4` |
| 成品（编辑保存重开后） | `67627b88d6b269b1e009cbb02768c22342d95bcf57c62e16548ee2567fd17b0d` |
| 原 DOC（复核后不变） | 10752 / `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898` |

截图表格窄并非新变化：原 DOC 两列在 Word 中各宽 11.8 pt，成品读到的两列同为 11.8 pt。没有为了美化测试修改源表或表格宽度，不宣称普遍像素级保真。

## 交付范围与未覆盖项

### 2026-09-09：测试平台夹具修订

对 `8638c6250ef7411840196cfe869365f078fc186a` 的只读审阅发现测试未模拟 Windows，在 Ubuntu 会被生产平台检查提前拒绝。本次仅在 `work-word-private-converter.test.ts` 的 describe 作用域内，每项开始模拟 win32、结束恢复原 process.platform 属性描述符；新增模拟 Linux 时 WORD_UNAVAILABLE 且 runner 零调用的断言，未跳过 Windows 行为测试。

仅运行该文件：1 文件 / 10 项通过，git diff --check 通过。这是本机带平台模拟的聚焦结果，不宣称已执行 Ubuntu CI。生产源码/资源未变，复用上述 c6 构建摘要；未重跑构建、模型、Word 或真实旅程。

修订固定为 `dc3cd29168fcac2b495dd813273a199ec2bc6b46`，已推送且远端一致。2026-09-09 验收主管独立复核两文件 delta：Standards APPROVE 0、Spec APPROVE 0，唯一 P2 关闭。原 c6 产品代码及固定样本限定结论保持不变；唯一桌面 owner 已获通知承接源码、helper 和修后测试，不代表其完整安装包已验收。原用户异常 Office 现场继续冻结，本次收尾不重跑测试、Word、模型或构建。

- 本固定 DOC 的表格丢失由 Word 主转换解决，实际正式输出与保存重开有证据；首次子模型不可用的准确原因仍未知，不声称统计稳定性或无需人工修正。
- 高级复核初次关闭保存了默认 KEEP，后续通过明确 UPDATE/高级复核修正；快捷汇总仍呈现原建议、部分定位不可靠等体验问题未改。不能把聊天 UPDATE 统计当作最终复核动作，最终以实际复核和生成结果为准。
- 历史 LO 报告/草稿没有迁移或复验；不自动将旧 `81f3ff3` 的失败证据改判。新验收使用 Word 转换的新报告。
- Windows+Word部署基线来自本轮明确决定；仅实际验证 Word 16.0.20326.20132，不代表其他版本/位数组合全覆盖。COM 创建身份未确认前的挂起仍可能需要人工处理，保留现场不杀同名进程。
- 随包路径/资源声明及构建已验证；完整安装包由桌面唯一 owner 接明确代码 SHA 和 helper 资源后验收，本任务未制作 NSIS。待其集成/安装包与总控最终批准，未合主线、未发布。
