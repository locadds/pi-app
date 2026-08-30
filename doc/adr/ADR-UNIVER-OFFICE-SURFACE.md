# ADR：小规 Univer 文档工作表面

- 状态：单机试用接缝已批准；尚未批准合入阶段线或作为正式发布能力
- 日期：2026-08-30
- 适用分支：`agent/next-phase-prompt-office-v1`

## 决定

小规采用以下单机文档工作链：

```text
安全解析后的 DOCX
→ 小规 OOXML 结构投影
→ 独立 Univer Viewer
→ 本机 Gateway 工作副本
→ 用户复核、保存或返回修改
```

用户只看到一个“文档工作表面”，不提供“Univer / 原版式兼容视图”切换。启用试用开关时以 Univer 为主视图；Viewer 未启用、启动失败或运行异常时，应用自动回退到只读 `docx-preview`，保留标黄、定位和选择能力，不显示第二套入口。

## 允许的开源 SDK

固定使用 Univer `0.25.1` 的十个开源包：

```text
@univerjs/core
@univerjs/design
@univerjs/docs
@univerjs/docs-drawing
@univerjs/docs-drawing-ui
@univerjs/docs-ui
@univerjs/drawing
@univerjs/drawing-ui
@univerjs/engine-render
@univerjs/ui
```

新增的四个绘图包是显示正文、表格单元格、页眉和页脚图片的必要组成，并不等同于引入 Univer Pro。禁止使用 `@univerjs/presets` 元包，也不得加入 DOCX Exchange、云协作、打印、编辑历史或任何 Pro 包，除非另立授权和格式回归门。

## 隔离与授权边界

- Viewer 在独立 iframe 中运行，样式和生命周期不进入小规主 React 树。
- Gateway 由 `utilityProcess` 启动，只监听随机的 `127.0.0.1` 端口。
- Gateway 会话令牌与授权 Cookie 只保留在 Main 和 `utilityProcess` Gateway 之间；不写入 Electron 浏览器会话、URL、Renderer 状态或 MessagePort。
- 主页面与 iframe 使用一次性 `channelNonce` 和转移后的 `MessageChannel` 通信。Viewer 只发送版本化的快照读写请求，父 Renderer 通过窄 IPC 交给 Main 代理；文档路径、主进程能力和凭据不进入消息协议。
- 同一工作副本编号不能并发打开；持久快照损坏时明确失败，不以空白新文档覆盖旧记录。

## DOCX 映射边界

- 当前可映射正文、基础段落样式、基础表格、页眉页脚和常见栅格图片。
- 页眉页脚按末节 `sectPr` 与 `document.xml.rels` 绑定；多节无法在当前 Univer 文档模型中等价表达时，只绑定末节并显示人工复核提示。
- 表格复杂边框、斜线边框、主题色和图案底纹无法等价显示时必须显式提示。
- PNG、JPEG、GIF、BMP、WebP 可进入绘图资源；VML 位置、旋转、翻转和可靠裁剪做有限映射。
- EMF、WMF、TIFF、组合图形、OLE、复杂环绕或无法解析的对象必须进入结构化降级清单，不得静默丢失或冒充成功。
- `mc:AlternateContent` 只选择一个可用分支，避免 Choice 与 Fallback 重复导入。
- 该 HTML/Canvas 工作表面不宣称与 Microsoft Word 像素级一致，也不负责正式 DOCX 导出。

## 许可证与供应链边界

- 上述十个 Univer 开源包均按各发布包中的 Apache-2.0 许可证使用。
- 当前 SDK 依赖 `nanoid@5.1.11`，生产依赖审计仍有尚无可用上游修复的高风险告警；这不阻止隔离的单机试用，但阻止自动批准正式生产装配。
- `docx-preview` 仅作为不可见的故障回退，不作为用户可选的第二种界面。

## 进入阶段线前仍需满足

1. 用户完成本分支的单机试用并确认图片、表格、标黄、保存和恢复体验。
2. 对目标院内文档样本记录可显示项与明确降级项，禁止无提示缺失。
3. 单独决定供应链告警的接受、隔离或升级策略。
4. 另立阶段线合并审查；本 ADR 不等于正式发布批准。

## 被拒绝的方案

1. 直接复制其他应用的 Office 运行框架或开发许可证。
2. 在小规主 React 树中注册 Univer。
3. 使用 `@univerjs/presets` 一次拉入未批准能力。
4. 把网关令牌交给 Renderer 或 iframe JavaScript。
5. 无提示地丢弃无法还原的图片、表格样式或复杂对象。
6. 依赖 `file://` 父页中的跨站 Cookie 让 iframe 直接读取 Gateway。
