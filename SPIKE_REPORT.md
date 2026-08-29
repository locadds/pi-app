# 小规 Univer Office Surface 架构验证报告

日期：2026-08-30
结论：**条件不通过。保留独立验证分支，不接模板主流程，不合入阶段线。**

## 已完成

- 独立 Viewer 工程，可创建中文合成文档并调用公开 Facade 读取、保存 Snapshot。
- 通过公开 `addCustomDecorationFactory` 为合成字段添加黄色批注下划线；正文不变，保存重载后标记仍存在。
- 插件模式装配，不使用 `@univerjs/presets` 大型元包，不含 Pro 包。
- 回环随机端口 Gateway：`/health`、受 Cookie 保护的 Viewer、Snapshot GET/PUT、过期版本冲突。
- utilityProcess Supervisor：私有令牌、HttpOnly/Strict Cookie、启动超时、关闭和 Cookie 清理。
- Renderer iframe 容器：加载、握手、错误、重载、销毁；尚未接模板主流程。
- 不可变工作副本状态机：create、saveHead、ready、reopen、merge、discard、trunkDiverged。
- `OFF / UNIVER_EXPERIMENTAL / UNIVER_PREFERRED` 能力开关契约；默认 `OFF`。

## SDK 与依赖

统一版本：`0.25.1`。

```text
@univerjs/core
@univerjs/design
@univerjs/docs
@univerjs/docs-ui
@univerjs/engine-render
@univerjs/ui
rxjs 7.8.2
```

全部为开源 Core 路径；未安装或复制 Univer Pro 许可证。

首次误用大型元包时，`@univerjs` 安装内容约 131.52 MiB，生产审计 95 个高风险项。改为插件模式后，`@univerjs` 安装内容降到约 31.58 MiB；当前生产审计为 8 个高风险、1 个中风险，其中 Univer 高风险链路来自 `@univerjs/core → nanoid@5.1.11`，npm 当前未给出可用修复版本。没有执行 `npm audit fix` 或强制升级。

## 构建体积

- Viewer：7,447,474 字节（约 7.10 MiB），80 个文件。
- Viewer 主脚本：约 2.79 MiB，gzip 后约 0.86 MiB。
- Viewer 样式：约 76.7 KiB，gzip 后约 11.8 KiB。
- Gateway 主入口与共享块：约 9 KiB。

Viewer 体积中包含 Univer 文档排版引擎生成的多语言断词资源。首轮不修改第三方内部加载器；进入 Phase 1 前需要确认官方是否有关闭未用语言包的公开配置。

## 验证结果

| 项目 | 结果 | 说明 |
|---|---|---|
| 领域状态机 | 通过 | 4 组测试；系统不能合并或丢弃，过期基线会阻断 |
| Gateway | 通过 | 会话 Cookie、读取、保存、冲突和静态 Viewer 共 1 组测试 |
| 类型检查 | 通过 | Web 与 Node 两套 TypeScript 检查 |
| 独立构建 | 通过 | Viewer 与 Gateway 均成功构建 |
| Snapshot 保存/重载 | 条件通过 | Edge 151 无界面冒烟完成“载入—保存—重载”；Electron Viewer 闭环未完成 |
| 浏览器内存参考 | 已记录 | 单文档无界面冒烟的 JS Heap 约 22.54 MiB；不是 Electron 总进程内存 |
| Electron 43 启动 | 未通过 | 本机隐藏冒烟等待 `app.whenReady()` 20 秒超时；未据此修改产品设置 |
| 中文输入法 | 未验证 | 需要可见窗口人工输入，不用自动化结果冒充 |
| 反复创建/销毁 | 未验证 | 等 Electron 启动门解决后测试 |
| 非破坏性字段装饰 | 通过 | 使用 `@univerjs/docs-ui` 顶层公开的 `addCustomDecorationFactory`；浏览器冒烟同时核对正文、范围、标记及保存重载，未调用私有命令 |
| DOCX 导入导出 | 不在本轮 | 需要 Univer Pro Exchange 正式授权和内网服务 |

## 阻断项

1. 当前生产 Renderer 使用 `file://` 透明来源，无法同时满足严格父来源校验和普通 iframe `postMessage`；需要可信应用协议或经过审计的 `MessageChannel` 握手。
2. Electron 43 在本机验证进程中未在 20 秒内进入 ready；需要单独诊断，不能用延长等待掩盖。
3. Univer 0.25.1 的 `nanoid` 审计告警没有上游可用修复。
4. 中文输入法、内存、反复销毁和真实窗口稳定性尚无证据。

## 下一 PR 的精确范围

只允许继续一个 `P4-OFFICE-SPIKE-B` 验证包：

1. 解决 Electron 验证进程启动并记录 Viewer/Renderer 内存；
2. 人工验证中文输入法、保存、重载、连续创建销毁 20 次；
3. 将已验证的公开字段装饰能力封装为小规字段 Plugin，并补充点击、激活和批量清理行为；
4. 决定可信应用协议或 `MessageChannel`，完成严格握手；
5. 向 Univer 上游确认多语言断词资源裁剪和 `nanoid` 修复计划。

上述门禁通过前，现有 `DocxHtmlViewer`、模板资产化 V2 和高级候选复核保持不变。
