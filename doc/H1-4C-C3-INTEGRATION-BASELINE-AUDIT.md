# TASKHUB H1-4C / C3 阶段 A：集成基线审计与合同冻结

状态：`候选，等待独立审查与人工验收`
日期：2026-09-03
范围：只读审计、合同和夹具；不含产品代码、数据库迁移、路由、Renderer/Web 实现、合并或发布。

## 1. 已核对的基线

| 轨道 | 工作树 / 分支 | 已核对 HEAD | 与后续工作的关系 |
| --- | --- | --- | --- |
| 桌面 H1-LAN | `D:\CodexWorktrees\xiaogui-taskhub-h1-receipt-sync-v1` / `agent/taskhub-h1-receipt-sync-v1` | `249bab76bb9c7855a1aa75a7a03303783212f81d` | 功能基线是已验收的 `4e55034`；`249bab7` 仅登记 LAN 验收。H1-4C 桌面后续从此审计提交派生。 |
| Hub H1-4B | `D:\PI\xiaogui-hub-h1-4b-receipt-api-v1` / `codex/taskhub-h1-4b-receipt-api-v1` | 功能 `770c0a781f22a527eddd8a1c2aeb7caff09dced0`；记录 `540045b` | H1-4C 结果回传必须保留该签名回执、双鉴权和节点序列语义。 |
| Hub C2 阶段线 | `D:\PI\xiaoguishequ` / `codex/hub-c2-artifact-chain-v1` | `48e3cf515a94488a92aacb284c29383c577bc8f5` | C3 Demand Outbox、社区 Web 和制品链的候选来源。 |
| WORK 候选 | `D:\CodexWorktrees\xiaogui-next-phase-integration-v1` / `agent/next-phase-prompt-office-v1` | `8c8728c7ba1d077b8a9fc5504420c9549c8d6124` | 与 H1 共享旧阶段线，但不是 H1-4C 的必须依赖。 |
| CODING 候选 | `D:\CodexWorktrees\xiaogui-coding-work-integration-v1` / `codex/coding-work-integration-v1` | `52432efc1b9b11b1df313e22f69571193f28a929` | 与 H1 共享旧阶段线，但不是 H1-4C 的必须依赖。 |

桌面 H1、WORK、CODING 的共同祖先均为 `agent/stage-integration-v1@0d2deece4c35851363b918313cb27d2848207c73`。它们在该点之后各自修改，不能据此称为已有统一基线。

Hub H1-4B 与 C2 的共同祖先是 `1fe28cc0cb336916440fc597d51cb44a9c44cefe`；`770c0a7` 不是 `48e3cf5` 的祖先，反之亦然。C2 的 `48e3cf5` 也不含 H1-4B 的签名回执 API。

## 2. 选定的后续工作树与吸收顺序

1. 本审计分支：`agent/taskhub-h1-4c-c3-audit-v1`，从桌面 `249bab7` 建立，只存审计/合同记录。
2. 阶段 B 的桌面分支应从本审计获批提交建立；不合入 WORK 或 CODING。它只消费既有本机 TaskHub Delivery/Evidence 和 H1-LAN Worker 接缝。
3. 阶段 B 的 Hub 必须先建立新的、单独的 H1-4C/C3 集成分支：以 C2 `48e3cf5` 为社区/网页来源，受控吸收 H1-4B 功能 `770c0a7`，再开始结果后端。`540045b` 仅为 H1-LAN 记录，可在整合后重新登记，不是功能依赖。
4. WORK/CODING 保持独立候选。只有以后获得专门的阶段集成授权时，才处理它们与 H1 的共享文件冲突。

## 3. Hub 整合冲突与迁移顺序

对 `git merge-tree 1fe28cc 770c0a7 48e3cf5` 的只读审计显示，以下文件需要人工语义整合，禁止使用整文件 ours/theirs：

- `openapi/community-v1.yaml`、`docs/后端对接说明.md`：C2 制品/社区与 H1 Worker 路由、版本说明必须同时保留；C3 路径只能在 H1-4C/C3 合同落地后加入。
- `packages/server/src/app.ts`、`packages/server/src/db/schema.ts`、`packages/server/package.json`、`packages/server/src/routes/artifacts-v2.ts`：保留 C2 Registry/制品行为和 H1 账号、节点、任务、回执行为，且 `artifact_receipt` 与 `task_delivery_receipt` 永远分表。
- `packages/server/drizzle/bootstrap-current.sql`、`drizzle/meta/0016_snapshot.json`、`drizzle/meta/_journal.json`、`migration.test.ts`：两线都占用 `0016`，不能直接拼接。
- `contracts.test.ts` 与测试脚本：同时保留 C2 合同与 H1 鉴权/回执断言，新增 C3/H1-4C 测试不能删旧覆盖。

目标数据库迁移顺序必须先在实现分支确认部署历史：

1. 以已部署的 C2 `48e3cf5` 迁移序列为目标基线时，保留它已有的 `0016`，将 H1 身份/节点、任务分配和回执 DDL 重新生成到后续连续编号；不得把 H1 原 `0016` 直接套到 C2 数据库。
2. 统一最终 schema 后重新生成 Drizzle snapshot、journal 和 `bootstrap-current.sql`，并补迁移测试：C2 旧库升级、H1 旧库升级（如仍需支持）、全新库初始化。
3. 只有迁移与 OpenAPI 语义整合通过，才可追加 H1-4C `task_result`、C3 intake/mapping/projection 表。不得先写业务路由再补迁移。

## 4. H1-4C 冻结合同

### 4.1 状态与权威边界

- 送达状态仍只由 `TaskDeliveryReceiptV1` 的 `NODE_STORED`、`USER_OPENED` 推进；下载或本机打开均不能伪造 Hub 已送达。
- `EXECUTION_STARTED` 继续走既有 `POST /api/v2/taskhub/worker/receipts`，`resultSha256` 必须为 `null`。
- 终态 `RESULT_READY`、`EXECUTION_FAILED`、`OUTCOME_UNKNOWN` 只能走新的原子结果提交，不允许只提交一条缺少结果摘要的终态回执。
- 结果是既有本机 TaskHub Delivery/Evidence 的受控投影：只含摘要、制品引用和验证结论；没有本机绝对路径、运行时会话、提示词、Token、私钥、原始文件或 Apply 权限。
- 本包不自动执行、自动重试执行、自动合并或自动 Apply。`OUTCOME_UNKNOWN` 不自动重派，`FAILED` 不自动重跑。

### 4.2 DTO 与路径

当前桌面 `XiaoguiTaskResultEnvelopeV1` 只是未实现的预留类型，字段不足以做签名关联/幂等。实施时将以以下冻结的跨端 `TaskResultEnvelopeV1` 取代该预留接缝；因为没有生产消费者，不做静默兼容猜测。

```ts
type TaskResultOutcomeV1 = 'RESULT_READY' | 'EXECUTION_FAILED' | 'OUTCOME_UNKNOWN'
type VerificationVerdictV1 = 'PASS' | 'FAIL' | 'NOT_RUN' | 'OUTCOME_UNKNOWN'

interface TaskResultEnvelopeV1 {
  schemaVersion: 'xiaogui.task-result.v1'
  resultId: string
  assignmentId: string
  taskId: string
  outcome: TaskResultOutcomeV1
  resultSummary: string
  artifactRefs: readonly { artifactId: string; mediaType: string; sha256: string }[]
  verification: { verdict: VerificationVerdictV1; summary: string }
  occurredAt: string
  resultSha256: string
}

interface TaskResultSubmissionV1 {
  result: TaskResultEnvelopeV1
  receipt: TaskDeliveryReceiptV1
}

interface ResultAckV1 {
  resultId: string
  eventId: string
  verified: true
  duplicate: boolean
  executionState: 'RESULT_READY' | 'FAILED' | 'OUTCOME_UNKNOWN'
  occurredAt: string
  receivedAt: string
}
```

- `resultSha256` 是不含自身字段的有序数组摘要，且必须等于同一 `receipt.resultSha256`；`receipt.eventType` 必须等于 `result.outcome`。
- `POST /api/v2/taskhub/worker/results`：JWT + `x-xiaogui-node-token` 双鉴权；原子验签、结果幂等、回执幂等、序列递增、任务/节点/包摘要绑定和 assignment 状态推进。
- `GET /api/v2/taskhub/worker/assignments/:assignmentId/timeline`：只给该 Worker 的脱敏时间线。
- `GET /api/v2/taskhub/offers/:taskId/timeline`：只给发布者的受控结果/送达时间线；未授权仍按既有可见性规则返回 `404`，不泄露收件账号或节点数据。
- `POST /api/v2/taskhub/worker/receipts` 对终态事件改为拒绝并返回 `409 RESULT_ENVELOPE_REQUIRED`，避免结果摘要和签名回执拆散。

### 4.3 H1-4C 错误与重试语义

| 情形 | HTTP / 代码 | 桌面行为 |
| --- | --- | --- |
| 结构、摘要、签名或终态组合无效 | `400 VALIDATION_FAILED` | 保留本地草稿和证据，标记为需人工处理；不伪造已上传。 |
| JWT/节点 token 缺失或失效 | `401 UNAUTHENTICATED` | 连接不可用，保留队列。 |
| 节点已替换/吊销 | `403 FORBIDDEN` / `NODE_REVOKED` | 延续 H1-4A：清凭据、停止轮询，禁止继续签发。 |
| 同 `eventId`/`resultId` 不同内容、序号重放、状态不允许、摘要不匹配 | `409 CONFLICT` 加细分码 | 保留凭据、收件箱和队列，刷新权威快照；不当成节点吊销。 |
| 网络超时、连接失败、`5xx` | 可重试 | 保留原子提交包，按队首重试；不重跑本机 Agent。 |

## 5. C3 冻结合同

### 5.1 Intake

- `DemandSubmittedV1` 保持字节语义和严格解析不变；社区审核通过后的 Outbox 是唯一输入，社区路由不直接创建 TaskHub Task。
- 新内部路径：`POST /api/v2/taskhub/intakes`。调用方是受控 C3 Outbox Worker，不是浏览器；使用专用集成凭据，不复用用户/节点 token，也不让社区前端保存凭据。
- 幂等键：`demandId + demandVersion`；持久化规范化事件摘要。相同摘要重试返回同一 `DemandIntakeReceiptV1`；同键不同摘要返回 `409 INTAKE_IDEMPOTENCY_CONFLICT`；修改必须升 `demandVersion`。
- 回执增加权威映射：`intakeId`、`demandId`、`demandVersion`、`taskId`、`state`、`receivedAt`、`displayMessage`。映射只由 TaskHub Intake 服务写入。
- 单次网络超时为 10 秒；仅超时、连接错误和 `5xx` 自动重试，退避为 1 分钟、5 分钟、30 分钟、2 小时、10 小时；第 5 次失败后进入可见死信。`400/401/403/409` 不自动重试，直接进入死信并记录安全错误码。人工恢复只能重新投递同一 Outbox 事件，仍使用原幂等键。

### 5.2 只读投影

```ts
interface DemandProgressProjectionV1 {
  projectionVersion: number
  demandId: string
  intakeId: string
  stage:
    | 'CLARIFYING' | 'PLANNING' | 'AWAITING_APPROVAL' | 'EXECUTING'
    | 'AWAITING_ACCEPTANCE' | 'DELIVERED' | 'CLOSED'
  displaySummary: string
  updatedAt: string
  deliveryRef?: string
}
```

- TaskHub 是唯一写入者；同一 `intakeId` 的 `projectionVersion` 必须严格递增。旧版本重放返回 `409 PROJECTION_VERSION_CONFLICT`，相同版本同摘要为幂等成功，不同摘要拒绝。
- 社区网页只读路径：`GET /api/v2/demands/:demandId/taskhub-projection`，按原 demand 可见性授权；不提供网页写入口。
- 初期映射为：Intake 澄清→`CLARIFYING`，TaskHub 规划→`PLANNING`，本机计划待批准→`AWAITING_APPROVAL`，已验证 `EXECUTION_STARTED`→`EXECUTING`，已验证 `RESULT_READY`→`AWAITING_ACCEPTANCE`。`DELIVERED` 与 `CLOSED` 只接受未来 TaskHub 明确的人工交付/关闭事实；C3 不可自行推进或伪造这两个阶段。
- `deliveryRef` 仅在已交付时返回不透明引用和展示摘要，不含工作树、文件路径、Agent 会话或制品二进制。

## 6. 合同夹具与前端包边界

`doc/H1-4C-C3-CONTRACT-FIXTURES.json` 是合同夹具唯一来源。它仅供解析、错误显示和聚焦交互测试；固定包含 H1 成功/失败、C3 Intake 幂等冲突和只读投影样本，不能用于宣称真实 Hub 联调。

通过本阶段人工门后，派发顺序固定为：

1. H1-4C 后端先实现并通过契约测试；桌面 Renderer 可以针对夹具并行，但不得改状态机、SQLite、主进程权威合同或 Hub 后端。
2. C3 Intake 后端通过后，再实现只读投影后端与夹具。
3. 再分别派发两个前端包：桌面 H1-4C Renderer 与 Hub C3 网页投影。两包使用不同工作树和不同仓库，不能跨写。
4. 前端完成后由总控读取固定提交、审查差异、完成语义集成和真实链路验收；不接受把夹具显示当作联调通过。

## 7. 阶段 A 验收门

审查需确认：基线与共同祖先无误；Hub 合并冲突没有被隐瞒；迁移顺序不复用冲突编号；结果、送达、Intake 与投影的边界清楚；C2 `artifact_receipt` 未被复用；夹具无本机路径、凭据、私钥或真实任务内容。批准前不得开始阶段 B、C、D 产品实现或派发前端代码任务。
