# DEVELOPMENT STATUS

更新时间：2026-09-02
阶段：`TASKHUB-H1-4B` — Worker 签名送达回执的上传、ACK 与离线补传
状态：阶段候选。首次独立审查发现 ACK 错指后续回执的阻断项，已补正并完成本地复跑；尚待重新独立验收，未合并正式主线、未发布。

## 本阶段目标

在不改变本机 TaskHub DAG、运行时选择、工作树或人工批准门的前提下，把 H1-3 已持久化的签名 `TaskDeliveryReceiptV1` 接入 Hub 的 H1-4B Worker 回执端点：离线时保留，联网后按序上传，只有获得匹配且 `verified: true` 的 ACK 才移出本地队列。

## 仓库与基线

- 桌面仓库：`https://github.com/locadds/pi-planning-agent.git`
- 隔离工作树：`D:\CodexWorktrees\xiaogui-taskhub-h1-receipt-sync-v1`
- 功能分支：`agent/taskhub-h1-receipt-sync-v1`
- 施工基点：`agent/taskhub-h1-receipt-v1@1e0626a1bf70422fe13cba0ec9d666ffaa957168`（H1-4A 人工验收状态记录）
- 对接 Hub 独立检查点：`codex/taskhub-h1-4b-receipt-api-v1@770c0a781f22a527eddd8a1c2aeb7caff09dced0`
- Hub 接口：`POST /api/v2/taskhub/worker/receipts`，成功体为 `{ data: ReceiptAckV1 }`；同时要求 Hub bearer token 与 `x-xiaogui-node-token`。

## 实际修改文件

| 范围 | 文件 |
| --- | --- |
| HTTP 回执 Adapter | `src/main/xiaogui/hub-task/http-task-worker-port.ts`、`http-task-worker-port.test.ts` |
| 回执队列与 ACK 状态 | `src/main/xiaogui/hub-task/worker-state.ts`、`worker-state.test.ts` |
| Worker 补传与故障语义 | `src/main/xiaogui/hub-task/worker-service.ts`、`worker-service.test.ts` |
| 收件箱同步文案 | `src/renderer/src/xiaogui/components/HubTaskInboxSection.tsx`、`HubTaskInboxSection.test.tsx` |
| 阶段记录 | `DEVELOPMENT_STATUS.md` |

## 已完成内容

- HTTP Adapter 向已提交的 Hub H1-4B 路径提交签名回执，只传回执载荷，并严格解析 `ReceiptAckV1`；不向 Renderer 返回 token、私钥、路径、任务正文或响应错误体。
- Worker 本地状态新增 ACK 出队门：只有同一 `eventId` 且 `verified: true` 的 ACK 才能移除一条持久化回执。错误 ACK、离线、协议异常都保留本地证据。
- 回执严格按 `sequence` 顺序处理；在一个正在执行的补传中新增的回执也会被顺序继续处理，避免后续事件越过前序事件。
- 补正 ACK 关联门：服务层与状态层都要求 ACK 的 `eventId` 等于刚刚提交的队首回执。Hub 若错误回传队列中后续回执的 ACK，会 fail-closed，保留两条记录并停止本轮补传。
- `USER_OPENED` 收到验证 ACK 后，标记为本机 `HUB_CONFIRMED`；下一次 Hub 权威快照仍决定公开的 `deliveryState: OPENED`，不会把本地打开误称为送达。
- 打开任务和定向接受/拒绝后会启动不阻塞 UI 的补传尝试；网络不可用时操作仍保留为本机草稿，周期刷新或用户“同步”会重试。
- 延续 H1-4A 语义：`409` 是 Hub 已双鉴权后的回执/状态冲突（如事件载荷不一致、序号重放或关联不匹配），保留凭据、收件箱和签名回执并刷新权威状态；`403` 是节点已吊销/被替换，清除旧节点凭据、缓存任务包与未上传回执。
- 收件箱提示由阶段占位文案改为“本机签名回执等待 Hub 验证同步；联网后按顺序重试”。

## 未完成内容

- 本阶段尚未完成单机双实例或两台电脑的真实 Hub 网络旅程；该验证必须使用上述 Hub SHA、隔离用户目录和人工操作，不得用模拟结果代替。
- H1-4C 尚未开始：结果摘要/制品引用回传、发布者审阅时间线、`RESULT_READY`/失败/结果未知回执，以及最终双机 LAN 验收。
- 未实现自动执行、自动合并、自动 Apply、Agent 选择或底层运行时暴露。

## 与规格文档的偏差

- 无冻结产品或架构决策偏差。Hub 仍只识别账号与小规节点，桌面本机仍在用户批准后才生成 TaskHub 计划草稿并选择运行时。
- 本阶段只实现 H1-4B 的送达证据闭环；未提前实现 H1-4C 结果上传，也未复用 C2 的 `artifact_receipt`。
- 尚无真实跨进程/跨机测试证据，因此本记录不把 HTTP Adapter 模拟测试表述为已完成的 LAN 联调。

## 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit -- src/main/xiaogui/hub-task/worker-state.test.ts src/main/xiaogui/hub-task/worker-service.test.ts src/main/xiaogui/hub-task/http-task-worker-port.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx` | 通过：4 个测试文件、27 条用例。覆盖 ACK 精确出队、错误 ACK 指向后序回执时的 fail-closed、重复 ACK、离线保留、恢复补传、权威 `OPENED` 快照、409 保留和 403 清理。 |
| `npm run typecheck` | 通过：web 与 node 两个 TypeScript 配置。 |
| `npm run build` | 通过：主进程、预加载与 Renderer 均构建完成；仅保留仓库既有动态导入优化警告。 |
| `git diff --check` | 通过：无空白或冲突标记。 |

本工作树仅建立一个未跟踪的 `node_modules` Junction，指向 D 盘已有共享依赖目录；未安装依赖、未修改 `package.json` 或锁文件，也不纳入提交。

## 已知风险

- 如果桌面版本先于 Hub `770c0a7` 部署，回执端点不可用，Worker 会保留本地证据并显示可重试状态，不会伪造“已送达”。
- ACK 通过后必须在下一次权威轮询中看到 `deliveryState: OPENED`，发布方 UI 才能以 Hub 事实展示送达；网络请求成功不等于跨机验收完成。
- 本阶段仅覆盖功能级桌面测试；真实 LAN、Hub 数据库迁移部署和两账号权限验证仍需在 H1-4C 前单独验收。
- ACK 错指回执的首轮审查问题已经由双层前序事件校验与双回执回归修复，但必须由独立审查重新验证，当前不能视为阶段验收通过。

## 下一阶段计划

1. 对本桌面 H1-4B 候选及 Hub `770c0a7` 进行独立只读验收；验收通过前不合并、不发布、不进入 H1-4C。
2. 验收通过后，使用两套隔离小规数据目录完成“发布—领取/定向—打开—Hub ACK—发布者看到已送达”的单机双实例旅程。
3. 仅在上述送达链路验证后再讨论 H1-4C 的结果回传；继续保持本机计划、执行和最终应用的人工批准门。

## 验收门

本文件记录的是 H1-4B 提交前候选，不构成正式主线合并、发布、真实网络联调或 H1-4C 的授权。必须由人工或独立审查 Agent 基于当前分支、当前 SHA 和实际测试证据验收后，才可进入下一阶段。
