# 第三方组件说明

完整生产依赖清单及版本见仓库根目录的 `sbom.cdx.json`。本文件记录经过单独准入审查、需要说明运行边界的组件。

## LibreOffice 26.2.5 Windows x64

- 来源：https://download.documentfoundation.org/libreoffice/stable/26.2.5/win/x86_64/
- 安装包：`LibreOffice_26.2.5_Win_x86-64.msi`
- 固定 SHA-256：`f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9`
- 许可证：MPL 2.0；官方发行包中的第三方许可证与说明随运行时一并装配。
- 用途：仅在本机无界面、独立用户配置目录中把通过基础检查的 DOC/DOCX 转为内部 DOCX 或预览 PDF。
- 装配：二进制不进入 Git。Windows 阶段封版时由 `scripts/prepare-libreoffice-runtime.mjs` 下载到 D 盘缓存、校验官方摘要，再加入安装包；对应固定版本源码获取地址为 https://download.documentfoundation.org/libreoffice/src/26.2.5/ 。
- 运行边界：转换设固定超时，可中止并终止进程树；生成的 PDF 只是小规自己的本机预览中间件，不承担外部 PDF 文件安全检测。

## cfb 1.2.2 与 pdfjs-dist 6.1.200

- 来源：https://github.com/SheetJS/js-cfb 与 https://github.com/mozilla/pdf.js
- 许可证：均为 Apache-2.0，许可证原文随 npm 包发布。
- 用途：`cfb` 只读识别旧版 DOC 的复合文件结构；`pdfjs-dist` 只渲染小规由 LibreOffice 生成的本机预览 PDF 并建立文字位置映射。
- 运行边界：不把文档路径、PDF 字节、原始 OOXML 或全文写入模型会话与公开工具结果；Renderer 只能通过短期页面令牌读取当前预览。

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
