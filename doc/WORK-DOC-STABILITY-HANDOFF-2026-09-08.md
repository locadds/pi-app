# WORK DOC 分析稳定性后续交接

状态：阶段候选，整体 PARTIAL；分析和保存闭环完成，但 DOC 转换表格保真阻塞尚未关闭。未验收、未进入主线、未发布。日期：2026-09-08。

## 基线与范围

- 冻结输入 `c1adfd44514ccea622185a9bee028adcf99dd441`，原 WORK 树不改。
- 唯一施工树 `E:\CodexWorktrees\xiaogui-work-doc-analysis-stability-v2`，分支 `codex/work-doc-analysis-stability-v2-e1`。
- D 盘新树独立依赖安装因 ENOSPC 失败，清理被策略拒绝；跨卷 worktree move 失败后，采用在 E 新建独立分支方案。D 失败现场保留，不称已经清理。
- 仅完善既有 DOC 分析 Prompt，不修改状态机、schema、repair 次数、Pi Harness、Office 默认、CODING、Hub 或安装包配置。最终桌面 owner 另行集成，不制作第二套 NSIS。

## 真实缺口与最小改动

旧安装版报告 `xgti1_ae81de16-d424-4555-b2e5-ce2ca7316f76` 的原始子模型输出和具体错误未保存，因此不能将旧 probe 的缺字段名问题认定为该次失败原因。

本轮用相同合成 DOC 通过真实系统选择器及 intake START 复现首次输出不合格：3 条 VARIABLE 均缺 `suggestedName`。当前精确 repair 收到 `MODEL_SCHEMA_SUGGESTED_NAME_REQUIRED: suggestion[1] kind=VARIABLE` 后，补齐全部 3 项并通过验证，形成 8 候选报告（3 VARIABLE、2 EXCLUDE、3 FIXED）。这证明当前 repair 接线有效，不证明旧二次失败已经复现或关闭。

现有 Prompt 的唯一 JSON 示例是 EXCLUDE，没有展示可变字段的必填名称。最小候选将子模型资源升级到 `1.2.2`，增加可被实际 validator 验证的 VARIABLE 示例，并明确每个 VARIABLE/REPEAT/CONDITIONAL 都必须有非空名称。示例偏向是否导致模型漏填属于待验证推断，不宣称确定因果。schema 与现有一次 repair 完全保留。

复用：沿用锁定 Pi 0.84.1、原生 Skill 发现、已有 intake 子模型/工具与 LibreOffice 转换；不引入新的通用能力或依赖。Skill 不能替代私有子模型已有的输出契约，此次仅完善该资源的说明与示例。

## 本地证据

- 证据根 `E:\CodexTemp\xiaogui-doc-stability-20260908`；`submodel.jsonl` 仅记录限定合成材料的文本与校验错误，不记录模型思考或认证。临时诊断已移除，不进入交付代码。
- DOC 10752 字节，SHA-256 `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898`；E 副本与旧样本一致。
- 模型 `deepseek/deepseek-v4-flash-vision-exp`，沿用现有模型配置，没有固定 Kimi 或使用 OMP。
- 基线真实会话：Pi sessions 的 `--E--CodexTemp-xiaogui-doc-stability-20260908-inputs--/2026-09-08T05-52-00-623Z_01a07f92-c66f-7480-8550-dfb59325d63e.jsonl`。
- E 独立 npm ci 成功，1197 包；Electron 原生模块装配及本树 build（含 Office）成功。
- 固定 LibreOffice 26.2.5 MSI 经 SHA-256 校验后在 E 独立解压，msiexec 退出 0；通过既有 XIAOGUI_LIBREOFFICE_PATH 使用。原准备脚本强制 D 缓存且重建共享解压目录，本轮未运行、未修改，也未借其他树构建产物。
- 模块测试：原 intake 15 项通过；新增示例测试先因无 VARIABLE 示例失败，修改后 intake/Catalog 2 文件 19 项通过。此类测试不是模型稳定性或真实旅程通过的替代。

## 固定代码上的真实闭环

代码 SHA：`7ffbc22bc2023c4df7d56a1500ef4bad041c7187`。后续仅补交接文档，不改变已测代码。本树重建、节点类型检查、diff 检查通过；总控对固定代码 Standards/Spec 均 CLEAR，成立发现 0，不代替业务验收。

隔离环境准确边界：Electron userData 为 `E:\CodexTemp\xiaogui-doc-stability-20260908\final-user-data`，测试进程显式设置 `PI_CODING_AGENT_DIR=E:\CodexTemp\xiaogui-doc-stability-20260908\user-data\pi-agent`。必要模型配置/认证私下复制至该目录，未打印或提交，未改全局环境。Worker 实际写出新 JSONL 到此 E 目录下 sessions，Main 项目会话 UI 正常展示该新会话。它不是桌面 RC 的 test-profile。Pi 仍原生发现用户全局 `.agents/skills`（只读），本次实际 read 的内置 Skill 来自 E 施工树。

早期基线诊断确实写入 C 默认 Pi sessions，不能称为日常 Pi 数据完全未写；该合成记录保留，不为掩盖而删除。最终旅程单独使用 E Pi 目录，文件名 `2026-09-08T09-54-54-807Z_01a08071-28d7-7a87-9c7a-87d68078151f.jsonl`，位于 `sessions/--E--CodexTemp-xiaogui-doc-stability-20260908-inputs--/`。

1. 模型实际 `read` 内置 `xiaogui-work-documents/SKILL.md`，再调用 intake START，系统选择器选入固定 DOC。报告 `xgti1_6744f8ed-9209-4e16-bec5-2430bfb52377`：8 候选（3 VARIABLE、2 EXCLUDE、3 FIXED），仅 `PAGE_COUNT_UNKNOWN`、`SCAN_COUNT_UNKNOWN`，没有模型无效或转换失败。最终无诊断接口不暴露初次/repair 次数，记为不可观测；不拿基线“一次失败+一次修复成功”代替此值。
2. 在真实复核界面将项目名称试填为“示例项目戊”，同步两处、保存工作副本、关闭并保存草稿、重新打开。正文保留戊，磁盘快照 `office-worktrees/b930c2170845e71e73d35d1231f10cc901afdfefa3a0241924f7cd6ecc16d558.json` 一致。`doc-saved-reopen-home.png` 已目视核对；首次 `doc-saved-reopen.png` 处于空白滚动位置，不作正文通过证据。侧栏试填输入重置为原样本，正文修改仍保留，不混称输入框也持久化。
3. 在待确认区实际确认移除两处合成说明，然后点击“确认字段草稿”。模型 materialize PREPARE，真实预览显示两个字段占位符及两处排除；点击“生成正式模板”，在系统选择器选择本轮 E 模板库。`doc-template-preview.png` 已目视核对。
4. 模型 SELECT_TEMPLATE 读取真实 fieldId，再 PREPARE“示例项目己 / 2026年9月8日”。系统另存位置选择后，明确确认之前目标文件不存在；单独回复“确认”后 CONFIRM 生成 `outputs/DOC链路验收成品.docx`，后续“打开文档”触发真实 OPEN。
5. 在实际系统 Word 中仅操作该精确合成文件，追加“单机保存复验：修改后已保存。”，Save→Close→Open 后标记和原有正文保留、Saved=true。`doc-word-reopened.png` 已目视核对；取证后仅关闭该合成成品。原 DOC 摘要再次核对不变。

| 产物 | 字节/摘要 |
|---|---|
| 正式模板 | 6282 字节；SHA-256 `55eed3b989c66cf3bc7777361e2698ed0ae885515497741af5e323afb4a94d5f` |
| 成品（生成时） | 6685 字节；SHA-256 `9f68ae7a8703a58d8fe20f1556b4f090dbc538f541e9cfacaf94a58105889750` |
| 成品（Word 编辑并重开后） | SHA-256 `6492fb8a57b138f000b28f602f75edf08b22934ac6e269d9525edcfed6fe8487` |
| 最终构建 Worker | SHA-256 `980f256ffe93306cafbaaa38f7ea33ad4980eda2d5f45edee2fdf4ac444ecdbe` |
| 最终构建 Main | SHA-256 `7da81774b9ee446acad71bf09cf154c8bb309423d059e911138af8a0fb8ea6f3` |

## 新发现的 DOC 转换保真阻塞

原合成 DOC 用 Word 独立只读打开，Tables.Count=1；最早 intake 报告 profile.tableCount=0，最终成品 Word Tables.Count=0，表格文字连成普通正文。不能将上述保存 PASS 当作内容结构保真 PASS。

不调用 Pi/模型/Univer，使用同一已校验 LibreOffice 26.2.5，独立 profile 执行：

```powershell
soffice.com -env:UserInstallation=file:///E:/CodexTemp/xiaogui-doc-stability-20260908/lo-compare-profile --headless --nologo --nofirststartwizard --convert-to 'docx:Office Open XML Text' --outdir E:/CodexTemp/xiaogui-doc-stability-20260908/lo-readonly-comparison <固定合成DOC>
```

命令退出 0；输出 `word/document.xml` 中 `<w:tbl>` 计数为 0，仍含“形成资料目录”。对照 DOCX SHA-256 `d2e1464fe2c71e6eb6a4dc4dcbfec50fd53190028795be2012d2426e0ce3e378`。表格结构在既定 LO 转换环节已经丢失，不归因于本次 Prompt、模型、模板状态机或保存修改。没有擅自新增 Word COM 生产转换路径、替换运行时版本或修改 Univer；需总控明确后续转换保真处置范围。

后续无模型接缝定位（不修改原样本）：

- 实际程序 FileVersion/ProductVersion 均 `26.2.5.2`，CompanyName 为 The Document Foundation；输入头 `d0cf11e0a1b11ae1`，CFB 含 WordDocument、1Table 等真实 DOC 流，不是伪装扩展名。
- 同一输入和独立 profile 改为 `--convert-to odt`，退出 0，`content.xml` 的 `<table:table>` 为 0，文字保留。这使问题收敛到读取 DOC 的阶段，而不是仅 DOCX 导出。
- 按 [LibreOffice 官方过滤器表](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html)，增加 `--infilter=MS Word 97`，另存到 `lo-explicit-filter`；退出 0，DOCX `<w:tbl>` 仍为 0。显式指定输入过滤器未解决，未将无效参数写入生产代码。
- 当前已试自动识别→DOCX、自动识别→ODT、显式 Word 97→DOCX，均丢表格。没有证据证明简单参数修复可行；并非声称穷尽所有上游设置。下一步若试不同 LibreOffice 版本/上游修复，需要固定新供应链候选并重新验收；若用 Word COM，则引入已安装且许可可用的 Microsoft Word 产品条件，不能静默替换现有无该依赖的路径。两者均未实施，交总控决定。

## 结论与未覆盖项

- 分析输出 Prompt 最小改进及此固定 DOC 的实际确认/输出/保存重开旅程有证据；不确定旧安装版二次失败的唯一原因，也不声称统计意义的模型稳定率。
- DOC 表格保真失败，整体仍 PARTIAL，不交付为“DOC 已完善”，不关闭 DOC 入口或以 DOCX 通过替代。
- Office 仍仅通过既有 XIAOGUI_OFFICE_TEST=1 测试，未修改默认值；桌面 RC 默认/集成/安装包由唯一 owner 处理。本轮未做安装包或平台无关回归。
- D 失败安装残留和 C 合成诊断保留；E 样本、隔离配置、日志及截图用于后续复验，不提交私有材料或凭据。已撤回全部临时源码观测，未新增生产日志接口。
