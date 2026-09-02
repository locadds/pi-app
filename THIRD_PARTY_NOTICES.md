# 第三方组件说明

完整生产依赖清单及版本见仓库根目录的 `sbom.cdx.json`。本文件记录经过单独准入审查、需要说明运行边界的组件。

## Anthropic internal-comms Skill（commit 53048666）

- 来源：https://github.com/anthropics/skills/tree/53048666b05b4799081517d00e09e0a2dd688678/skills/internal-comms
- 固定版本：上游 commit `53048666b05b4799081517d00e09e0a2dd688678`；小规保留该目录内容及随附 `LICENSE.txt`，仅清理一处不影响语义的行尾空格以通过仓库差异检查。
- 许可证：Apache License 2.0。
- 用途：通过 Pi 原生 Skill Loader 为内部状态汇报、项目更新、FAQ、简报和事件说明提供写作流程与格式参考。
- 运行边界：该 Skill 只是提示与示例资源，不新增工具、网络权限、账号连接器或自动发送能力；只能使用当前会话本来可见且已受控的工具。
- 装配：随安装包复制到 `resources/pi-skills/internal-comms`，由 Pi 的 `additionalSkillPaths` 原生接缝发现，不使用小规自建 Skill 注册表。

## LibreOffice 26.2.5 Windows x64

- 来源：https://download.documentfoundation.org/libreoffice/stable/26.2.5/win/x86_64/
- 安装包：`LibreOffice_26.2.5_Win_x86-64.msi`
- 固定 SHA-256：`f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9`
- 许可证：MPL 2.0；官方发行包中的第三方许可证与说明随运行时一并装配。
- 用途：仅在本机无界面、独立用户配置目录中把通过基础检查的旧版 DOC 转为内部 DOCX。DOCX 复核和模板预览不再转 PDF。
- 装配：二进制不进入 Git。Windows 阶段封版时由 `scripts/prepare-libreoffice-runtime.mjs` 下载到 D 盘缓存、校验官方摘要，再加入安装包；对应固定版本源码获取地址为 https://download.documentfoundation.org/libreoffice/src/26.2.5/ 。
- 运行边界：转换设固定超时，可中止并终止进程树；不用于 DOCX 复核、模板预览或普通 PDF 阅读。

## cfb 1.2.2

- 来源：https://github.com/SheetJS/js-cfb
- 许可证：Apache-2.0，许可证原文随 npm 包发布。
- 用途：只读识别旧版 DOC 的复合文件结构；含 VBA、ActiveX、嵌入对象、加密或异常结构时拒绝处理。
- 运行边界：不把文档路径、原始二进制、原始 OOXML 或全文写入模型会话与公开工具结果。

## docx-preview 0.4.0

- 来源：https://github.com/VolodymyrBaydalka/docxjs
- 许可证：Apache-2.0，许可证原文随 npm 包发布。
- 用途：在小规内只读渲染通过安全门的 DOCX 展示副本，用于模板复核、修改后预览和本机模板库预览。
- 运行边界：只读取主进程通过短期文档令牌签发的临时 DOCX 字节；不读取本机路径，不启用外部 HTML、批注、修订或实验接口。页面数量仅作为 HTML 近似视图，不冒充 Word 实际分页。

## Univer Docs SDK 0.25.1（单机试用分支）

- 来源：https://github.com/dream-num/univer
- 许可证：Apache-2.0；各 npm 包内保留许可证原文。
- 直接包：`@univerjs/core`、`@univerjs/design`、`@univerjs/docs`、`@univerjs/docs-drawing`、`@univerjs/docs-drawing-ui`、`@univerjs/docs-ui`、`@univerjs/drawing`、`@univerjs/drawing-ui`、`@univerjs/engine-render`、`@univerjs/ui`。
- 用途：构建与小规主 React 树隔离的文档工作表面，显示安全解析后的 DOCX 正文、基础表格、页眉页脚和常见栅格图片，并保存本机工作副本。
- 运行边界：默认功能开关为 `OFF`；单机试用脚本显式启用。未安装 Univer Pro、DOCX Exchange、协作、打印或编辑历史能力；不宣称与 Microsoft Word 像素级一致。
- 隔离边界：Gateway 会话令牌和授权 Cookie 只存在于 Main 与本机 Gateway。Viewer 通过已校验的 `MessagePort` 向父 Renderer 发起窄请求，再由受控 IPC 交给 Main 代理访问；普通 Renderer、Viewer JavaScript、URL 和消息体均不接触令牌。无法等价映射的对象进入可见降级清单。
- 供应链边界：使用插件模式，不依赖 `@univerjs/presets` 大型元包。0.25.1 当前经 `@univerjs/core` 依赖存在 `nanoid@5.1.11` 审计告警且 npm 未提供可用修复，故只允许留在独立验证分支，不能据此批准生产装配。

## officeparser 7.8.0

- 来源：https://github.com/harshankur/officeParser
- 作者：Harsh Ankur
- 许可证：MIT
- 用途：在小规 WORK 模式中，从已通过本地 JSZip 安全门的 DOCX `Buffer` 提取正文、标题、普通表格、页眉和页脚语义。
- 打包方式：使用官方 `officeparser/slim` 入口编入 Electron 主进程；npm 包仅作为精确锁版的构建依赖，成品不携带其完整 npm PDF/OCR 依赖目录。官方浏览器精简单文件仍内含 PDF.js 等解析代码，实际包体门记录的成品增量约为 3.66 MB。
- 运行边界：只调用 DOCX 解析；固定关闭 OCR 与附件提取，不调用 PDF 解析和生成能力。DOCX 结构、位置、浮动对象、文本框与媒体仍以小规现有 JSZip 检查结果为准。

`officeparser/slim` 中的 OCR 实现已替换为不可调用的禁用桩；其预编译单文件所含第三方组件和许可证以 npm 包内 `dist/sbom.cdx.json` 为准，其中包括 MIT 许可的 `@xmldom/xmldom`、`fflate`、`file-type`，以及 Apache-2.0 许可的 `pdfjs-dist`。小规固定传入 `fileType: 'docx'`，不会进入 PDF 或 OCR 分支。

MIT 许可证原文随 npm 包发布于 `officeparser/LICENSE`；版权声明为 `Copyright (c) 2019 Harsh Ankur`。

## docxtemplater 3.69.3 与 PizZip 3.2.0

- 来源：https://github.com/open-xml-templating/docxtemplater 与 https://github.com/open-xml-templating/pizzip
- 许可证：均选择 MIT 许可路径；发布包内保留各自许可证文本。
- 用途：只在小规 WORK 高级 Word 生成链中展开已经由小规内容控件明确标注的重复块、布尔条件块和普通字段。
- 运行边界：输入必须先通过现有 JSZip DOCX 安全门；不启用表达式解析器、收费模块、脚本、OCR、PDF 或附件提取，也不让该组件读取本地路径。
- 小规适配边界：小规只把 `xiaogui.repeat:*` 和 `xiaogui.conditional:*` 翻译为基础区段语义；生成后移除结构外壳，并再次通过 JSZip 安全门。

直接运行依赖包括 MIT 许可的 `@xmldom/xmldom@0.9.12`，以及同时保留 MIT 与 zlib 许可声明的 `pako@2.2.0`。E 盘 Electron 43 依赖门及一次目录包实测通过，实际目录包增量为 3,735,987 B（约 3.56 MiB）。
