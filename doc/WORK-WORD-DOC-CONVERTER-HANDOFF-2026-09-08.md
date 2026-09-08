# WORK Word DOC 主转换交接

状态：施工候选；独立保真对照通过，生产 Adapter 冒烟通过，完整模型旅程待验。未进入主线、未发布。日期：2026-09-08。

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

## 待验

固定新代码 SHA 后，原 DOC→真实 Pi Skill/分析→正式复核→模板/成品→编辑保存关闭重开，核表格、单元格及源摘要；记录实际新会话/模型、截图与输出摘要。旧 `81f3ff3` DOC PARTIAL 不被本轮 PoC 替代，只有新链路真实证据才能更新结论。历史由 LO 生成的报告/草稿没有本轮迁移或复验，验收使用新报告。
