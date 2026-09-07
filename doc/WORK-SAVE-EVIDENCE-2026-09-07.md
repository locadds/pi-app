# WORK 保存可靠性修复证据

- 施工基线：`a60041e3bd7a8a3c34b41547da05d42755f7a696`。
- 工作树：`D:\CodexWorktrees\xiaogui-work-document-stability-v1`。
- 状态：模块修复、聚焦测试及真实窗口保存重开已完成；集成与安装版证据见 `WORK-REMEDIATION-HANDOFF-2026-09-06.md`，不是发布结论。

## 缺陷与修复

`src/office-gateway/server.ts` 原来先更新内存快照和 SHA，再写临时文件与 rename。写入或替换失败会导致内存推进、磁盘停留旧版，重试出现假冲突。现在同一 gateway 内的保存排队，在队列内检查预期 SHA，构建候选、成功替换磁盘文件后才同步提交快照与 SHA。GET 在落盘期间看到完整旧版。每次临时文件名含随机 UUID、以 `wx` 新建，失败时清理；单次失败不会阻塞后续队列。

`src/office-viewer/app.tsx` 原来在保存前设置 `suppressDirty`，失败不会恢复，保存期间的新编辑也会被忽略。现在保存不抑制编辑事件，以编辑修订号判断完成的保存是否包含最新内容。失败保留编辑、未保存状态与旧预期版本；错误在编辑器中展示，重试成功清除错误。已载入后的操作错误不再发送会让外层盖住编辑器的致命 `VIEWER_ERROR`；字段更新失败返回原有失败结果。`gateway-client.ts` 将同一 Viewer 的并行自动/手动保存排队，候选快照在入队时复制，发送时使用前一成功版本。

## 所有权与复用边界

实际生产入口是 `src/main/index.ts` 的 `requestSingleInstanceLock()`、`office-surface/ipc.ts` 调用的单例 supervisor、每个文档一个 utility process。原 supervisor 按实例保存 key，且 close 调用时先释放 key、之后才等待子进程退出，存在旧进程仍能写盘时重开的窗口。

本次沿用现有 supervisor 所有权控制，将锁定范围改为主进程内规范化的持久化文件路径，覆盖多个 supervisor 实例，并仅在 utility process 的 exit 事件后释放。不同 persistenceRoot 的相同 key 不互相阻塞。fork 失败立即释放；启动失败发出 kill 后保持占用至 exit。没有新建跨主机锁、数据平台或通用事务框架。独立应用主动配置同一外部共享目录不属于目前单机入口契约。

复用依据：已阅读根 AGENTS 与 `ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md`；现有 Pi Resource Loader 和 `resources/pi-skills/xiaogui-work-documents/SKILL.md` 负责能力发现与文档工具流程，不拥有 Office 内存版本、私有工作副本文件或 Viewer 状态。批准计划明确要求修复这一现有 Office 接缝，本次不引入新的能力或依赖，保留 Pi、Skill、IPC、保存请求和冲突响应结构。

## 验证记录

已完成无第三方依赖的实际服务器冒烟：

```text
node --experimental-transform-types docs/audit/work-save-native-smoke.mjs
Node v25.8.1 — PASS
write failure: old memory/disk/head retained, temp removed, same-head retry passed
rename failure: old memory/disk/head retained, temp removed, same-head retry passed
in-flight GET old version; concurrent same-head writes = 200 / 409; disk matches winner
close/reopen restored last successful snapshot and SHA
```

同一脚本针对基线 `a60041e` 导出的原始 server 执行时稳定红灯：部分写入失败之后 GET 已返回 `title: write` 和新 SHA，预期仍为 `synthetic initial` 与旧 SHA；该基线临时导出文件已删除。冒烟使用实际回环 HTTP 和临时目录，通过 Node 内置 fs 的受控故障钩子制造部分写入及替换失败，结束后删除临时文档。

隔离 `npm ci --ignore-scripts` 装配完成后，运行：

```text
node node_modules/vitest/vitest.mjs run src/office-gateway/server.test.ts src/office-gateway/save-reliability.test.ts src/office-viewer/core/gateway-client.test.ts src/office-viewer/app-save.test.tsx src/main/xiaogui/office-surface/gateway-supervisor.test.ts --reporter=verbose
Test Files  5 passed (5)
Tests       15 passed (15)
```

`git diff --check` 所属修改无空白错误。类型检查与集成构建由总控统一执行。Node 25/Vitest 打印的 `--localstorage-file` 无效路径警告未导致上述测试失败。

新增或扩充的聚焦场景：

- 真实 HTTP + 文件系统：部分写入失败、rename 失败、临时文件清理、同版本重试、保存途中读取、同版本竞争、关闭重开恢复。
- supervisor：跨实例同路径互斥、关闭至退出期间互斥、不同目录独立、崩溃退出释放、fork 失败后重试。
- Viewer client：失败保持旧 SHA，恢复后可重试；自动/手动请求序列与入队快照冻结；真实冲突继续提示。
- Viewer React 组件（Univer/网关外部边界 mock）：失败后继续输入和重试，保存进行时继续输入不能被旧请求标记为已保存。

总控已补真实 Univer 编辑、自然语言 DOCX 闭环与安装版保存重开记录，统一见 `WORK-REMEDIATION-HANDOFF-2026-09-06.md`。上述组件测试不代替真实验收，DOC 子模型降级等未关闭项也在该交接中单列。
