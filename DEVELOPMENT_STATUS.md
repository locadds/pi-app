# DEVELOPMENT STATUS

## H1-0：Hub 用户、节点公钥与送达回执契约 / 签名 Spike

- 日期：2026-09-01
- 工作树：`D:\CodexWorktrees\xiaogui-taskhub-h1-desktop-spike-v1`
- 分支：`agent/taskhub-h1-desktop-spike-v1`
- 基线：`agent/stage-integration-v1@0d2deece4c35851363b918313cb27d2848207c73`
- 阶段状态：已完成代码与聚焦验证；等待人工或审查验收，未进入 H1-1。

### 本阶段目标

冻结小规 Hub 的跨端任务、节点绑定和签名送达回执 V1 契约，并在隔离的内存 Hub 中验证：账号绑定唯一活动节点、换机吊销旧节点、Ed25519 回执签名、双时间戳、幂等重传和序号防重放。

### 实际修改文件

- `packages/shared/xiaogui-hub-task-contract.ts`
- `packages/shared/index.ts`
- `src/main/xiaogui/hub-task/receipt-crypto.ts`
- `src/main/xiaogui/hub-task/in-memory-node-binding-spike.ts`
- `src/main/xiaogui/hub-task/in-memory-node-binding-spike.test.ts`
- `DEVELOPMENT_STATUS.md`

### 已完成内容

- 定义 `XiaoguiNodeBindingV1`、`TaskOfferV1`、`TaskAssignmentV2`、`TaskResultEnvelopeV1`、`TaskDeliveryReceiptV1`、`ReceiptAckV1` 和窄 `XiaoguiHubTaskPortV1`。
- 回执使用冻结的有序数组签名载荷，固定包含架构要求的 12 个字段，避免 JSON 对象字段顺序影响验签。
- 使用 Node 内置 Ed25519 生成节点密钥；私钥只作为一次性配对返回值，不写入 Spike 的 Hub 状态、公开绑定快照或日志接口。
- 内存 Spike 验证一个账号只保留一个活动节点；新配对自动吊销旧节点；已吊销节点无法提交新回执。
- 验证 `USER_OPENED` 的实际打开时间与 Hub 收到时间分别保存；同一 `eventId`、同一内容重传返回幂等成功，不同内容冲突；旧序号被拒绝。
- 本阶段没有改动现有 TaskHub DAG、工作树、运行时路由、LAN Worker、SQLite、IPC 或产品界面。

### 未完成内容

- H1-1 真实 Hub 账号注册/登录、scrypt 密码存储、C2 `device_pairing` 复用迁移和一账号一活跃 Worker 约束。
- H1-2 任务池、定向投递、原子领取、退回和拒绝。
- H1-3 桌面 `safeStorage` 凭据保存、HTTP Adapter、收件箱、离线回执队列和本机 TaskHub 计划草稿联动。
- H1-4 单机双实例、两机 LAN、真实 Kimi 多会话 DAG 联合验收。

### 与规格文档的偏差

无架构偏差。H1-0 严格限定为契约和内存签名 Spike：尚未接真实网络或数据库，因此不把本阶段当作 H1 生产交付。`D:\PI\xiaoguishequ` 的 C2 工作区尚有未提交施工，按工作单要求未在其上叠加 H1 改动。

### 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `.\\node_modules\\.bin\\vitest.cmd run src/main/xiaogui/hub-task/in-memory-node-binding-spike.test.ts --reporter=verbose --pool=threads --maxWorkers=1` | 通过：1 个测试文件、3 条用例全部通过。覆盖实际/Hub 双时间戳、换机吊销、幂等、重放、验签和私钥/Token 不外泄。 |
| `npm run typecheck` | 通过：`TYPECHECK_EXIT=0`。 |
| `npm run build` | 通过：Electron Vite 主进程、预加载和 Renderer 均构建完成；仅出现既有动态导入优化警告。 |

### 已知风险

- 当前为内存 Spike，不是 Hub 服务端持久化实现，也尚未证明 HTTP 边界、SQLite 条件更新或断网补传。
- 私钥的 Windows `safeStorage` 落盘和旧设备 Token 的真实吊销，必须在 H1-1/H1-3 对接时验证。
- Hub C2 的活动改动仍是 H1 的外部前置条件；未经其已提交、已推送、工作区干净的检查点，不得修改 `D:\PI\xiaoguishequ`。

### 下一阶段计划

等待人工或审查 Agent 对 H1-0 验收，同时等待 Hub C2 提供已提交、已推送的基线 SHA 与 `device_pairing` 接缝说明。验收通过后，从该基线建立独立 Hub H1-1 分支，复用而不是平行新建设备绑定表。
