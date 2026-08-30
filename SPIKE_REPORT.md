# 小规 Univer 文档工作表面阶段结论

日期：2026-08-30
结论：**单机试用接缝通过；阶段线合并与正式发布尚未批准。**

## 已完成

- 独立 Univer Viewer、本机 Gateway、不可变工作副本和 MessageChannel 接缝。
- Main 持有随机 Gateway 会话令牌并代理快照读写；普通 Renderer 与 Viewer 不接触令牌，`file://` 父页通过已校验的 `MessagePort` 和窄 IPC 完成受控访问。
- DOCX 正文、基础表格、页眉页脚和常见栅格图片的结构投影。
- 正文、表格单元格、页眉和页脚图片资源的浏览器解码与保存重载冒烟。
- 字段标黄与双向定位；Viewer 不可用时自动进入只读回退视图。
- 不支持对象和复杂表格样式的结构化可见降级清单。
- 同一工作副本并发门、损坏快照失败门和发布打包前置构建接缝。
- `file://` 父页嵌入鉴权冒烟：iframe 直接访问返回 401，经 Main 代理成功，浏览器 Cookie 数量为 0。

## 固定边界

- 仅使用 Univer 0.25.1 开源 Core/Docs/Drawing 包；无 Pro、DOCX Exchange、协作、打印和编辑历史。
- 不使用 `@univerjs/presets`。
- 不修改原 DOCX，不把 Univer Snapshot 当作正式模板语义真值。
- 不宣称 Microsoft Word 像素级一致。
- 默认功能开关保持 `OFF`；`npm run dev:office-test` 才启用单机试用。

## 进入下一门前

1. 用户用真实院内 DOCX 检查图片、表格、标黄、滚动和恢复体验。
2. 对所有未显示对象确认界面存在明确提示。
3. 评估 Univer 依赖中的 `nanoid@5.1.11` 供应链告警。
4. 另立阶段线合并和正式发布审查；本报告不授予该权限。
