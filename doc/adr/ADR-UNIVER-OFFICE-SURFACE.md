# ADR：小规 Univer Office Surface

- 状态：架构验证中，尚未批准进入产品主流程
- 日期：2026-08-30
- 适用分支：`agent/work-p4-univer-office-surface-v1`

## 决定

小规参考 `dsh-univer-office` 的“独立查看器—本机网关—不可变工作副本—后台转换”分层，但不安装 DSH/Cordis、不复制其代码和开发许可证。Office Surface 直接使用正式发布的 Univer 开源 SDK，并通过独立 iframe 与小规主 React 树隔离。

V1 使用插件模式，只注册文档界面需要的包：

```text
@univerjs/core
@univerjs/design
@univerjs/docs
@univerjs/docs-ui
@univerjs/engine-render
@univerjs/ui
```

不得使用会同时拉入表格、协作和 Pro 能力的 `@univerjs/presets` 大型元包。DOCX Exchange、打印、协作和编辑历史在获得正式授权且完成格式回归前不得加入。

## 为什么使用独立 iframe

- Univer 的样式和生命周期不进入小规主 React 树；
- Viewer 可以单独构建、升级、销毁和降级；
- Viewer 只能通过本机 Gateway 获取工作副本，不能得到文件路径、许可证路径和主进程能力；
- Univer 不可用时，现有 `DocxHtmlViewer` 和结构化复核仍可保留。

当前小规生产渲染器使用 `file://`，而严格的跨源 `postMessage` 需要稳定、非透明的父页面来源。首轮不降低来源校验；进入产品联调前应注册可信应用协议，或改用经过审计的 `MessageChannel` 握手。该接缝未解决前，Office Surface 不得接模板主流程。

## 为什么自研本地 Snapshot Worktree

首期只需要单机草稿隔离，不需要提前引入 Univer Pro 协作服务。工作副本使用 `DRAFT → READY → MERGED/DISCARDED` 状态机：系统可以保存草稿，但只有用户可以合并或丢弃；正式版本变化时停止合并。以后可在不改变模板核心契约的情况下替换持久化或协作适配器。

## 为什么使用 utilityProcess

本机 Gateway 需要随机回环端口、会话 Cookie、静态资源和 Snapshot GET/PUT。它与主进程分开运行，崩溃或超时可以独立终止；Renderer 不接触会话令牌。当前验证包只实现 Supervisor，不在应用启动时自动拉起。

## 许可证和格式边界

- 当前六个开源包为 Apache-2.0；未加入任何 Univer Pro 包或许可证。
- DOCX 导入导出属于后续商业授权门，本轮只有合成 `IDocumentData`。
- Univer Snapshot 是编辑工作副本，不是模板语义真值，也不是唯一正式资产。
- 在真实 DOCX 语料回归通过前，不宣称与 Microsoft Word 像素级一致。
- 当前 SDK 依赖 `nanoid@5.1.11`，生产依赖审计存在尚无上游修复版本的高风险告警；阶段线不得据此自动启用 Office Surface。
- 非破坏性字段标记使用 `@univerjs/docs-ui` 顶层公开的 `addCustomDecorationFactory`，底层保存为 `customDecorations`，不会改写正文 `dataStream`。验证版只证明黄色批注下划线、范围和重载保持；产品化仍需封装小规字段 Plugin。

## 被拒绝的方案

1. 直接安装 `dsh-univer-office`：会引入不属于小规的运行框架与许可证边界。
2. 在小规主 React 树中直接注册 Univer：样式、依赖和生命周期耦合过重。
3. 使用 `@univerjs/presets` 元包：验证中实测会拉入未使用的表格、协作和 Pro 依赖。
4. 使用私有命令或内部渲染树做字段标黄：SDK 升级风险不可接受；验证版改用顶层公开的非破坏性装饰工厂。
