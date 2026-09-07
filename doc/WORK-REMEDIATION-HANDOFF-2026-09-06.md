# WORK 单机文档稳定性与验收交接

更新日期：2026-09-07。状态：阶段候选；保存与 DOCX 核心闭环有真实证据，安装/资源门通过，DOC 分析稳定性等仍未关闭。待人工验收，未进入主线、未晋级或发布。

## 固定基线与分工

- 仓库：`https://github.com/locadds/pi-app.git`。
- 基线：`a60041e3bd7a8a3c34b41547da05d42755f7a696`，开工时远端同名候选一致。
- 施工分支：`codex/work-document-stability-v1`。
- 隔离工作树：`D:\CodexWorktrees\xiaogui-work-document-stability-v1`。
- 原候选工作树存在独立 Timeline 修复的未提交改动，本次未触碰。
- WORK 负责 Gateway、Viewer、Office Main 保存接缝；CODING 负责共享能力矩阵与激活；总控负责根构建、资源装配、集成和验收。模块同时施工，统一提交后固定验收 SHA。

## 复用结论

Pi 0.84.1 的 Resource Loader、`additionalSkillPaths`、`setActiveToolsByName` 和原有 Host 工具即可承载能力选择。Skill 无法修复已观察到的 Gateway 写盘失败先推进内存状态，故在现有保存接口内修复提交顺序与并发，未增加通用事务平台。根构建直接复用 `build:office`。

## 验收记录

### 实现与资源基线

- `2eb150884ee3887a4fdb4cb867cd311269f4cedf`：保存一致性、获准 WORK 工具常驻、根启动 Office 构建。
- `92bdc99160cf765f9fb7682f9e77dac62915e50d`：实际构建版冷启动暴露 Renderer 寻址错误，改为从应用根目录解析 `out/renderer/index.html`；保留原 preload 接缝。新增 4 项定位测试通过。
- `e068a2cef4b438e597e4c3d17adbe905f74a7b5f`：子模型 Prompt 1.2.1 明确 WHOLE_FRAGMENT 定位字段省略规则，repair 携带具体错误和本次原始片段。
- `df24b49e16190b50e3864acd58920acd1da0120d`：Terra 补充缺少 `suggestedName` 的建议索引、kind 反馈，不增加 repair 次数、不自动编造字段名、不放松校验。SBOM 由既定脚本刷新到实际 50 个组件。
- 业务代码冻结 SHA：`2817547bff293b44574fd5d064dcb3abef01f8eb`。真实模型暴露 SELECT_TEMPLATE 的 `details.fields` 包含真实 ID，但模型可读 `content` 仅有中文名；最小补充 content 中的真实 ID→名称映射。对应 Worker 测试 4 项通过，最后节点类型检查通过。没有改变 Host 身份或字段校验，也没有添加新 API。
- 最终打包配置 SHA：`ac16d934346d614c6166d6b6d539600e30a15b9a`。仅为 electron-builder 显式登记 GitHub owner/repo，解决隔离工作树不能推断仓库、更新元数据阶段读取 null.provider 的真实失败；业务代码及 asar 不变。后续文档收尾提交不改变验收产物。
- 保存接缝 5 文件 / 15 项通过；相关共享能力 14 文件 / 141 项通过；子模型与 Catalog/Builder 4 文件 / 32 项通过，最后具体字段名反馈测试所在文件 15 项通过。它们是分次有重叠的验证，不相加成总覆盖数。
- `npm run typecheck`、`npm run build`、最终代码 `npx electron-vite build` 和 `git diff --check` 通过。打包契约 Node 测试 10 项通过。
- 产品层加工具兼容规则 6191 字，含协作 6625 字；Runtime Facts 测试最高 216 字。Pi 原生系统上下文另计，不把完整模型请求误称为 7000 字以内。

- LibreOffice：既定脚本从已校验的 D 盘安装包缓存重新装配；`verify-libreoffice-runtime.mjs` 返回 `LIBREOFFICE_PACKAGING_GATE_OK 26.2.5 f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9`。
- 干净依赖：本工作树独立 `npm ci --ignore-scripts`，不使用历史 `node_modules` junction；安装后补运行构建与必要原生装配。
- 无历史 Office 产物下 `npm run predev` 成功；浏览器真实 Office 冒烟的正文/表格/页眉/页脚图片解码与保存重载均通过。实际新 Electron 配置可打开 Office，两项内置 Skill 可发现且可读取。

### 真实窗口与模型证据

只使用无敏感内容的合成样本。证据目录 `D:\CodexTemp\xiaogui-work-acceptance-20260907`，模型 `deepseek/deepseek-v4-flash-vision-exp`，独立新 Electron userData；模型配置使用既有 Pi 配置，不复制或公开凭据。

1. `92bdc99` 上原生 `read` 读取内置文档 Skill、资料读取、intake START 均实际调用。标准自然语言“把刚才的内容输出为 Word”触发 PREPARE；回复“继续”没有新工具调用且目标文件不存在；回复“确认”后 CONFIRM 成功另存 `outputs/合成项目复验报告.docx`（8957 字节，SHA-256 `55d942c98c62067e7f85dd3e88d228a1ca95f4b47aea437c369afb719d88d390`）。该证据不是最终版本完整模板旅程的替代。
2. `e068a2c` 长中文名 DOC（10752 字节，SHA-256 `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898`）通过私有 LibreOffice 转换并生成只读报告，没有转换失败码。但子模型遗漏字段名，经一次 repair 后降级；促成本轮 Terra 的精确反馈修复。
3. `df24b49` 上从系统选择器选入 DOCX，真实 Skill read + intake START 返回 11 候选（3 VARIABLE、8 FIXED）、2 条页数/扫描数未知提示，没有 MODEL_OUTPUT_INVALID。报告 `xgti1_e38b6643-14d2-4185-bafb-7eee2d75796a`。UI 合并为项目名称、编制日期两个业务字段，0 待确认问题。
4. 实际打开复核、把项目名称试填为“示例项目乙”、同步全文两处、保存工作副本、关闭保存草稿、重新打开后两处仍为乙。`final-reopen-saved.png` 已目视核对，磁盘工作副本 `b1ffa7158e7b9130dd45a0bf89d13753aba8a359bf5143f0b4b0f9326f16f07e.json` 正文一致。原 DOCX SHA-256 仍为 `4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55`，未覆盖来源。
5. 通过真实“确认字段草稿”按钮完成报告确认，模型 materialize PREPARE 打开修改后模板预览；实际查看占位符后点击“生成正式模板”，再选择隔离模板库。正式模板成功落盘：8973 字节，SHA-256 `cba55d7965c3e5df1a55ae18177e6fe13aeb456f295eb03e047d1d9216438ad3`。模板名沿用系统自动名称，不是模型承诺的自定义名称；用户测试明确接受自动名称后继续。没有跳过预览按钮或私有令牌。
6. `2817547` 上复验受影响的 SELECT_TEMPLATE→PREPARE。JSONL 中模型原样使用返回的两个真实字段 ID，为“示例项目丙 / 2026年9月8日”准备成品；“继续”无 CONFIRM、目标文件不存在，单独“确认”后 CONFIRM 成功生成 `outputs/示例项目丙成品报告.docx`（8993 字节，生成 SHA-256 `4c9b5a84120a62e3f2f560cc3a7634391307bf9064397e8574f1b501c5366b20`）。随后自然语言“打开文档”触发工具 OPEN，实际启动 Word 并打开该文件。
7. 在这个实际打开的 Word 文档中通过 COM 限定精确文件追加“单机保存复验：修改后已保存。”，Save→Close→Open 后正文与该标记均保留，Tables.Count=1、Saved=true。重开截图 `word-output-reopened.png` 已目视核对。编辑后 SHA-256 `ea2e1f94c3a521094f9abd114fbbdec63044349e076329d865e4299fa98251ec`。Office 网关的内部工作副本保存与系统 Word 的成品保存分别验证，不混称同一个保存实现。
8. 同一固定代码下 `xiaogui_read_pdf` 读取合成 PDF 并只在回复中形成报告，未调用模板物化或 Word 生成；SHA-256 `55b79fff7ccd4eedb8787c3146e505bc684b3326eb6e1d3ae242930c54508c04`、1 页、originalInputUnchanged=true。将合成 DOCX 复制成 `.pdf` 的错误样本后，真实选择器选入返回 INPUT_INVALID、“所选文件不是受支持的 PDF”，模型按要求停止，没有文件生成。

固定代码的高级诊断：WORK / EXECUTE / projectTrusted=true，4 项 WORK capability、8 个工具（含 Pi read），产品层正文 2138 字、Facts 192 字，独立 intake 子模型正文不进入产品层。Manifest 完整请求 SHA 为 `fbf38e4fa65cf046b69c8197f766e1b870db778043ea177c02f0edcaa3e08570`，按该 SHA 读取受限产品预览未报 stale；完整 Pi 请求正文遵守既有隐私边界，不导出到 Renderer。两项内置 Skill `complete/enabled/effective=true`、diagnostics 为空。

合成会话 JSONL（只摘录工具调用/结果，不保存模型思考正文）：

- 标准 Word 证据：Pi sessions 下 `--D--CodexTemp-xiaogui-work-acceptance-20260907-inputs--/2026-09-07T11-01-14-155Z_01a07b87-852b-7919-bd92-38e5d33ad831.jsonl`。
- 固定代码模板旅程：同目录 `2026-09-07T11-25-48-136Z_01a07b9e-02e8-748f-b2bc-5c8d632774b3.jsonl`。

### 共享 Sandbox 异常交接（不在本轮另造修复）

`e068a2c`、上述新 userData，19:16 本轮新建 Sandbox `efa67d3c`，重启前 Skill/read_materials/intake 均可运行；19:21 冷重启点击该临时对话后一直加载，Main 返回：

```text
ipc:session.setPendingBind -> trusted_session_not_listed
TrustedSessionAccessModuleV1.open -> resolveTrustedSessionScope
Renderer: [ProjectSidebar] open sandbox failed
```

合成 JSONL 位于 Pi sessions 下 `--D--CodexTemp-xiaogui-work-acceptance-20260907-user-data-sandbox-workspaces-efa67d3c--/2026-09-07T11-16-13-968Z_01a07b95-4010-7de0-9bf8-b37b7d65f66c.jsonl`。文件名/Sandbox metadata 会话 ID 为 `01a07b95-4010-7de0-9bf8-b37b7d65f66c`，CODING 侧读到 JSONL 头 ID 为 `01a07b95-40ab-7294-85f6-e2669e304807`；是否既有 UI/Pi 别名待共享接缝核对，未手改 JSONL 或重绑。重新原生选择 inputs 后正常项目历史会话可打开。双方约定由 CODING 统一追可信发现与 setPendingBind 顺序，Main gate 不放宽。

复核按钮“首次点击无响应”的早期观察未确证业务缺陷：后续读到正确 historySessionFile，并通过同一真实 DOM 按钮成功打开；此前自动化坐标点击未触发其 OPENING 状态。通知弹窗还会改变 CDP 默认目标，后续固定主窗口 t1；没有为猜测修改 Renderer。

仍存在的体验限制：模型曾将 READ_FAILED 的 0 字节占位误说成空文件、将短表/已读完一页的末尾误说成截断；在主进程完成用户按钮确认后又误说“可能直接保存”；也曾在回复中复述内部字段编号。工具真实结果与文件未越过确认门，但不把这些表述问题称为已修复。Univer 对本合成表格报列宽提示、画面表格很小；系统 Word 中表格内容与结构正常，未更改 Univer。

### 安装包观察

首次 `npm run package:win:prebuilt` 完成 SBOM、LibreOffice 装配校验、Electron 原生模块装配；因后续真实故障修复更新代码，主动停止旧版本打包，不作为最终证据。最终代码重新 `electron-vite build`，同一依赖已完成 Electron 43 rebuild，使用既定 builder 加 `--config.npmRebuild=false` 避免重建正在使用的同一原生模块，未跳过资源校验。

打包长耗时位于 `computeNodeModuleFileSets` 的逐包文件遍历，不是 hoist：duplicate dependency summary 在 collector/hoist 已返回后才打印。48 个直接生产依赖约 105799 文件 / 571MB，node_modules 无 ReparsePoint；未为速度修改第三方依赖或打包过滤。

最终命令 `node node_modules/electron-builder/cli.js --win --publish never --config.npmRebuild=false` 完整退出 0。最终 `app-update.yml` 为 github / locadds / pi-app，自动检查更新仍默认关闭；没有上传 Release。生成产物：

| 文件（本工作树 dist 下） | 字节数 | SHA-256 |
|---|---:|---|
| 小规 Agent-Setup-0.3.0-rc.1-x64.exe | 557949636 | `9f9c2c71b4a3d044817678ac5821be10abad72d8306b223d5ede8bfac0ac4ad9` |
| 小规 Agent-Portable-0.3.0-rc.1-x64.exe | 557704885 | `0d7b7ea25aa5676297bfab3fcafbee17091812df40cf40f9a8e9d05126ef6b4e` |

asar 中 Worker、Main、Renderer index、Gateway index 与当前 out 逐项 SHA 一致。完整 asar SHA-256 为 `0fdb36124313427bac2df7e36c00f63f24242f70635dae3c9e76a36f1033e84d`，更新仓库元数据前后相同。随包 internal-comms 与 xiaogui-work-documents 的 Skill 正文分别为 `c5c061ab25b33fab2358a9be53a5cc0d528ec7c3e8a29285a041ffc95d0d8947`、`cf2426b546d02982b9d5e04297b7d05ea23d9014c0b70f442c1b2edd9a523568`，与源文件一致。随包 soffice.com 使用独立用户目录实际转换 DOC→DOCX 成功（退出 0、6494 字节；有 Python prefix 非致命提示）。

### 安装版新配置复验

安装命令：NSIS `/S /currentuser /D=D:\CodexTemp\xiaogui-work-acceptance-20260907\installed-app`。首次安装和最终安装器替换均退出 0；测试前未发现已登记的小规安装。使用新的 `installed-user-data`、独立 `installed-office-worktrees` 和 `installed-template-library`；模型认证仍用既有 Pi 配置，不复制凭据。Office 显式使用既有 `XIAOGUI_OFFICE_TEST=1`，未修改产品默认 OFF。

首次安装业务验收与最终产物的 asar 逐字节相同；最终安装器覆盖后又核对更新配置、asar、Skill，并冷启动及打开库内模板预览。资源来自 installed-app/resources，不是工作树的历史 Office 产物。两项 Skill complete/effective=true，真实模型 read 的路径也来自随包 Skill。保存与产物证据：

- 新配置实际 DOCX START 返回 11 候选（3 VARIABLE、6 FIXED、2 EXCLUDE），原文不变；打开 Office 复核，项目名称试填“示例项目丁”，保存、关闭草稿、重开后仍保留。工作副本 `d65f6ccff09afa21f3368abcd1f328711bb64aa5615f8905a28ab5705cf99685.json`，截图 `installed-docx-saved-reopen.png` 已目视检查。
- 字段及排除项在真实界面确认后进入模板预览，通过实际按钮保存到隔离库；模板 SHA `bf7aeabceb29249a6dbd37bb4d6fa7002a45e8f1f0cf3c379cff80c7e5936697`、8827 字节。早期预览截图处于载入期，不计作视觉通过；最终安装器替换后，等待只读 ready，再打开库预览确认可渲染，截图 `final-installed-library-preview.png`。窄侧栏预览及表格宽度仍有布局限制。
- 真实 SELECT_TEMPLATE→PREPARE→用户“确认”→CONFIRM→OPEN，生成 `outputs/安装版成品报告.docx`，8854 字节，生成 SHA `a423d3498753c35026c5dc86ab1e380fc5d598a6780b9f23da181038438577d9`。系统 Word 打开后，在精确测试文件内追加保存标记、保存、关闭、重开成功，Table.Count=1、Saved=true，编辑后 SHA `a48dfe2b634777d43a5e5fe2238cace514ba7041802fed481c3af2c53ac7ad8b`。截图 `installed-word-output-reopened.png` 已目视核对。
- 安装版合成会话：Pi sessions 的 inputs 目录下 `2026-09-07T11-58-26-826Z_01a07bbb-e60a-703a-b967-fa15a5c4557e.jsonl`。DOCX 报告 `xgti1_a09a11d2-1b31-4d08-b0c3-173319a20900`。

未关闭：同一安装版 DOC 转换成功并生成只读报告，但子模型一次 repair 后 MODEL_OUTPUT_INVALID，7 候选全部 UNRESOLVED；界面正确阻止直接确认字段草稿。报告 `xgti1_ae81de16-d424-4555-b2e5-ce2ca7316f76`。只读同七片段探针一次即 COMPLETE（5 建议），未复现失败，未据此继续改源码或把实际降级改判为通过。需要下一轮先取得实际失败的结构错误码，区分输出波动与确定性缺陷。完整功能验收因此不是全部通过；Portable 仅完成构建与摘要，未单独运行其解压启动路径。

Terra 对 `a60041e..2817547` 只读审查未发现可成立的 P1/P2；没有重跑已绿套件。更广的 CODING C-01 新候选由其总控另行集成，本 WORK 分支未擅自合入其拒绝显示修复或主线。

## 当前模块状态

| 项目 | 状态 | 后续 |
|---|---|---|
| W-01 保存一致性 | PASS（模块及真实编辑重开） | 人工验收 |
| W-02 自然语言文档流程 | DOCX 核心闭环 PASS；DOC 分析稳定性未关闭 | 保留实际降级与体验限制，待人工验收 |
| W-03 首次启动资源 | PASS（独立依赖/新配置/安装后本地资源） | 默认 Office 模式未晋级 |
| 完整安装包 | 构建/NSIS 安装/资源/DOCX 链路通过；整体功能验收 PARTIAL | DOC 分析降级待查；Portable 未独立启动；不发布 |

完成里程碑以保存可靠和固定版本真实文档闭环证据为准。安装包单独验收，人工批准后晋级。
