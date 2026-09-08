# LibreOffice DOC 导入固定候选研究

日期：2026-09-08。范围：官方资料只读研究；本研究未下载或执行运行时、未上传样本、未修改生产代码。采用 research 技能，由独立研究 Agent 编写本文件；实际转换由主 Agent 另行记录。

## 结论

核查的固定维护版本为 **LibreOffice 26.2.6.3 Windows x86-64**。官方归档与校验文本已实读，但没有找到直接匹配本例的修复依据，因此不将它选定为修复候选，不下载或试装。仅比当前 26.2.5.2 更新、属于同一维护线且可追溯，不足以支持升级解决本例。

**本轮没有找到可直接匹配当前 DOC 表格丢失的修复。** 更强的限定证据是官方只读 GitHub 镜像中，两版本 `sw/source/filter/ww8` 的 Git tree SHA 完全相同：`b4d0847b67e4d86eeef63754edbe53cd9651c735`。因此该候选没有此目录内的源代码变化；共享代码或构建差异仍需实测，不能由目录相同推断运行结果必然相同。一次差分可以检验“换到下一维护构建是否改变本样本结果”，但没有理由承诺成功。

## 固定发布与校验来源

| 项目 | 官方事实 |
|---|---|
| 完整候选 | `26.2.6.3`，Windows x86-64 |
| MSI 文件 | `LibreOffice_26.2.6.3_Win_x86-64.msi` |
| 文件大小 | `373252096` bytes（mirrorlist） |
| SHA-256 | `f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660` |
| 归档目录时间 | `03-Sep-2026 20:36`（页面未声明时区，不转换为本地时间） |

官方入口及本轮访问结果：

- [精确归档目录](https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/)：HTTP 200，列出该 MSI、签名和 Details。
- [精确 MSI 官方 URL](https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi)：本轮仅从官方目录确认链接，未下载二进制。
- [SHA-256 文本](https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi.sha256)：HTTP 200，返回上表摘要与完整文件名。
- [官方 mirrorlist](https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi.mirrorlist)：HTTP 200，大小和摘要与校验文本一致。其内部校验链接使用 testing 路径；执行时应保存实际来源和本地摘要，不以三段 stable 别名代替固定构建。
- [TDF 发布公告](https://blog.documentfoundation.org/blog/2026/09/04/libreoffice-26-2-6/)：2026-09-04 发布 26.2.6 维护更新并提供 Windows 下载，链接 RC1/RC2 修复列表。公告本身不能证明本样本已修复。

## 修复记录与查证边界

[官方镜像仓库](https://github.com/LibreOffice/core) 自述为 LibreOffice core 只读镜像，指向官方 Gerrit。通过其公开 API 查询：

- [固定版本比较](https://github.com/LibreOffice/core/compare/libreoffice-26.2.5.2...libreoffice-26.2.6.3)：返回 149 个提交，base `cd7284b4cbbfeb507e630c1aac019f4157393acb`，head `8221e31b3ac356a1623c672912a3d2b492f7e3d1`。提交说明筛选 `ww8 / doc import / table import / binary word` 未命中。该检索只是筛选，不等于全面语义审计。
- [旧版本 filter 目录 API](https://api.github.com/repos/LibreOffice/core/contents/sw/source/filter?ref=libreoffice-26.2.5.2) 与 [候选 filter 目录 API](https://api.github.com/repos/LibreOffice/core/contents/sw/source/filter?ref=libreoffice-26.2.6.3)：其中 ww8 子目录均为前述同一 tree SHA。compare 的文件列表恰好 300 项，存在截断限制，故“WW8 无目录差异”使用这两个目录对象佐证，而非依靠截断列表。
- [RC1](https://wiki.documentfoundation.org/Releases/26.2.6/RC1)、[RC2](https://wiki.documentfoundation.org/Releases/26.2.6/RC2) 与 [官方 Git WW8 比较入口](https://git.libreoffice.org/core/+log/libreoffice-26.2.5.2..libreoffice-26.2.6.3/sw/source/filter/ww8?format=JSON) 本轮遭遇 Anubis 挑战/拒绝，未获得正文，不将其列为已读修复清单。

主 Agent 的本轮独立样本检查：Word 只读 `Tables.Count=1`，正文 `StoryType=1`，`NestingLevel=1`，2 行 2 列，脚注与尾注均 0。因此脚注内表格相关的 [bug 95804](https://bugs.documentfoundation.org/show_bug.cgi?id=95804) 不能直接认定同因；本研究没有重新查询或推断该 bug 当前状态。另一个“Writer tables converted to plain text”线索涉及剪贴板 ASCII 导出/tdf#144576，亦不匹配当前文件导入链路（此排除依据来自主 Agent 的独立研究，不作为已定位根因）。

本地既有失败证据来源：[WORK DOC 交接](WORK-DOC-STABILITY-HANDOFF-2026-09-08.md)。现有 26.2.5.2 自动识别→DOCX、自动识别→ODT、显式 Word 97→DOCX 三组都丢失表格，且源文件未变。研究不扩展为新过滤器枚举或替换生产依赖。

## 保留的差分方案（未执行，当前不推进）

以下仅保留研究时形成的可复现步骤。总控已依据上述反证决定不因维护版本更新而下载或试装；只有后续取得新的直接相关证据并重新确定候选时，才重评此方案。

1. 主 Agent 在 E 任务目录取得上述固定 MSI，校验字节数及 SHA-256；不匹配则停止使用该包并记录实值。独立解压后记录 `soffice.com` 的实际 `--version`、文件版本和摘要；运行时必须确认为 `26.2.6.3`。保留旧 26.2.5.2 及现有证据。
2. 使用原固定 DOC：10752 bytes，SHA-256 `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898`。转换前后各核一次摘要，不修改或另造样本。新 profile 与输出目录均在 E 私有任务目录；运行时取得后仅进行一次离线、无模型转换。
3. 沿用已经失败的自动识别→DOCX 命令，只改变绝对可执行文件为候选，profile/outdir 为新目录：

```text
<26.2.6.3绝对路径>/program/soffice.com -env:UserInstallation=file:///E:/CodexTemp/xiaogui-doc-stability-20260908/lo-26.2.6.3-profile --headless --nologo --nofirststartwizard --convert-to "docx:Office Open XML Text" --outdir E:/CodexTemp/xiaogui-doc-stability-20260908/lo-26.2.6.3-comparison <同一固定DOC绝对路径>
```

4. 保存实际命令、版本、退出码、stdout/stderr、输出 SHA-256；使用 XML 命名空间解析 `word/document.xml` 中表格/行/单元格结构，核对与源的 1 表、2 行、2 列及单元格文字对应。如沿用 Word 只读取证，再记录实际表格计数，关闭时不保存。退出 0 或仅文字保留均不足以通过。
5. 若仍为 0 表，记录该单次版本差分失败，停止继续试版本/过滤器，维持 DOC PARTIAL。若结构与文字保留，只能判此离线转换样本通过；生产版本是否更换及后续真实 intake/复核/模板/保存旅程仍由主 Agent/总控按既定范围处理。本研究没有授权或执行生产依赖切换、合并或发布。

## A 路线阶段结论

本轮未找到直接匹配修复的可信候选，A 路线研究收尾，不盲试其他版本。现生产装配基线仍为 LibreOffice 26.2.5（程序版本 26.2.5.2）。`42dda559` 的 DOC PARTIAL 与 `7ffbc22` 的 Prompt 小改动通过范围不变。后续 B 路线涉及 Word 安装与许可条件，待总控取得用户答复；本研究不实现、不默认启用，也不在等待期间重复模型调用。
