# DEVELOPMENT STATUS

更新时间：2026-09-02
阶段：`TASKHUB-H1-4A` — Worker 状态冲突保护
状态：已完成聚焦实现与验证，待独立审查或人工验收；未开始 H1-4B 回执上传/ACK，未合并正式主线。

## 本阶段目标

落实 H1-3 人工验收登记的 P2：Hub Worker 收到良性 `409 CONFLICT`（任务状态已变化）时，必须与旧节点 `403 FORBIDDEN` 明确区分。`403` 才清除安全凭据、缓存任务和本地回执草稿；`409` 必须保留凭据与收件箱，仅提示用户同步后重试。

## 仓库与基线

- 仓库：`https://github.com/locadds/pi-planning-agent.git`
- 隔离工作树：`D:\CodexWorktrees\xiaogui-taskhub-h1-receipt-v1`
- 功能分支：`agent/taskhub-h1-receipt-v1`
- 施工基点：`agent/taskhub-h1-desktop-worker-v1@5e9fc1866a67ca777e485db29a628ca87cc58f0d`（H1-3 人工验收状态记录）
- H1-3 功能验收基点：`c25a80ce429d740ce40e05507dc5e640add16512`
- 对接 Hub H1-3 已验收状态记录：`agent/taskhub-h1-worker-api-v1@4cede5f02e9650889ba1ef15a3df5850800e92c4`

## 实际修改文件

| 范围 | 文件 |
| --- | --- |
| HTTP 错误语义 | `src/main/xiaogui/hub-task/http-task-worker-port.ts`、`http-task-worker-port.test.ts` |
| Worker 保留策略 | `src/main/xiaogui/hub-task/worker-service.ts`、`worker-service.test.ts` |
| 收件箱提示与回归 | `src/renderer/src/xiaogui/components/HubTaskInboxSection.tsx`、`HubTaskInboxSection.test.tsx` |
| 阶段记录 | `DEVELOPMENT_STATUS.md` |

## 已完成内容

- `403` 保持唯一的旧节点/吊销语义，仍会触发现有 fail-closed 清凭据、清本地任务包、清未上传草稿和停止轮询流程。
- `409` 映射为独立的安全 HTTP 错误 `STATE_CONFLICT`，不再冒充 `NODE_REVOKED`。
- Worker 服务将 `STATE_CONFLICT` 投影为 `HUB_WORKER_STATE_CONFLICT`：保留已配对凭据、收件箱和本地任务内容，并维持可同步状态。
- 收件箱显示“任务状态已发生变化，本机连接和收件箱已保留；请同步后再操作。”，不会把用户带回登录/配对表单。
- 聚焦回归分别验证 409 HTTP 映射、服务端保留凭据/缓存和 Renderer 保持收件箱可见。

## 未完成内容

- H1-4B：桌面上传签名 `TaskDeliveryReceiptV1`、Hub 验签/ACK、`eventId` 幂等、`(keyId, sequence)` 防重放、离线补传和收件箱中的 Hub 已确认送达状态。
- H1-4C：结果摘要/制品引用回传、发布者审阅时间线、单机双实例与两机 LAN 受控旅程。
- 真实 Hub 网络环境下的 409 联调留给 H1-4B 的端到端回执链路；本阶段以 HTTP Adapter/Worker/UI 聚焦回归验证语义，不把模拟响应表述为跨机联调。

## 与规格文档的偏差

- 无冻结产品或架构决策偏差；本阶段只是 H1-3 验收登记项的修复，不提前实现 H1-4 回执、结果、执行或应用能力。
- 未修改 Hub `403` 合同、TaskHub DAG、工作树、运行时/Agent 路由、C2 `artifact_receipt` 或正式主线。

## 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit -- src/main/xiaogui/hub-task/http-task-worker-port.test.ts src/main/xiaogui/hub-task/worker-service.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx` | 通过：3 个测试文件、17 条用例。 |
| `npm run typecheck` | 通过：web 与 node 两个 TypeScript 配置。 |
| `npm run build` | 通过：主进程、预加载和 Renderer 均构建完成；仅保留仓库既有动态导入优化警告。 |
| `git diff --check` | 通过。 |

本工作树测试时仅建立了一个未跟踪的 `node_modules` Junction，指向 D 盘已有共享依赖目录；未安装新依赖、未修改 `package.json` 或锁文件，也不纳入提交。

## 已知风险

- 当前 Hub H1-3 的 409 响应由既有任务状态机产生；本阶段验证的是桌面端不误清凭据，真实 HTTP 联调仍需随 H1-4B 回执端点一起完成。
- `409` 后用户必须显式同步，避免客户端在状态不明时盲目重试动作；本阶段不增加自动重试或自动执行。

## 下一阶段计划

等待 H1-4A 独立审查或人工验收。通过后，在本独立桌面分支与 Hub 的新 H1-4 分支上接入签名回执上传、ACK 与离线补传；继续维持“Hub 只识别小规节点、桌面本机选择 Agent、人工批准后才执行/应用”的冻结边界。

## 验收门

本文件不构成 H1-4 完成或发布授权。H1-4A 通过后也不得合并正式主线；H1-4B/H1-4C 仍须各自有实际测试证据和独立验收。
