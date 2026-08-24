# 第三方组件说明

完整生产依赖清单及版本见仓库根目录的 `sbom.cdx.json`。本文件记录经过单独准入审查、需要说明运行边界的组件。

## officeparser 7.8.0

- 来源：https://github.com/harshankur/officeParser
- 作者：Harsh Ankur
- 许可证：MIT
- 用途：在小规 WORK 模式中，从已通过本地 JSZip 安全门的 DOCX `Buffer` 提取正文、标题、普通表格、页眉和页脚语义。
- 打包方式：使用官方 `officeparser/slim` 入口编入 Electron 主进程；npm 包仅作为精确锁版的构建依赖，成品不携带其完整 npm PDF/OCR 依赖目录。官方浏览器精简单文件仍内含 PDF.js 等解析代码，实际包体门记录的成品增量约为 3.66 MB。
- 运行边界：只调用 DOCX 解析；固定关闭 OCR 与附件提取，不调用 PDF 解析和生成能力。DOCX 结构、位置、浮动对象、文本框与媒体仍以小规现有 JSZip 检查结果为准。

`officeparser/slim` 中的 OCR 实现已替换为不可调用的禁用桩；其预编译单文件所含第三方组件和许可证以 npm 包内 `dist/sbom.cdx.json` 为准，其中包括 MIT 许可的 `@xmldom/xmldom`、`fflate`、`file-type`，以及 Apache-2.0 许可的 `pdfjs-dist`。小规固定传入 `fileType: 'docx'`，不会进入 PDF 或 OCR 分支。

MIT 许可证原文随 npm 包发布于 `officeparser/LICENSE`；版权声明为 `Copyright (c) 2019 Harsh Ankur`。
