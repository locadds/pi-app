# TASKHUB H1-4C / C3 共享合同规范

版本：`v1.1-candidate`

状态：`阶段 A 修订候选；仅用于审查、夹具和后续实现，不是已运行接口`

本文件是 H1-4C 和 C3 的唯一共享合同来源。它冻结跨端 DTO、状态、路径、认证、错误语义、顺序和夹具规则；不会创建产品路由、数据库或前端实现。

## 1. 公共错误信封

所有未来 Hub/C3 HTTP 错误均复用 C2 已冻结的十项闭集，不新增 `RESULT_ENVELOPE_REQUIRED`、`NODE_REVOKED`、`CONFLICT` 等顶层错误码。

```ts
type ErrorCodeV1 =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'RELEASE_NOT_APPROVED'
  | 'INTENT_EXPIRED'
  | 'INTENT_ALREADY_CLAIMED'
  | 'DOWNSTREAM_UNAVAILABLE'

interface ErrorEnvelopeV1 {
  error: {
    code: ErrorCodeV1
    messageKey: string
    message: string
    traceId: string
    params?: Record<string, string | number | boolean>
  }
}
```

`messageKey` 承担细分机器语义，`traceId` 只用于排障；两者均为必填。前端按顶层 `code` 决定恢复类，再按 `messageKey` 给出具体提示，不能解析自然语言 `message`。

| 场景 | HTTP | `code` | `messageKey` | 客户端恢复 |
| --- | --- | --- | --- | --- |
| 结果/回执结构、摘要或签名错误；终态误投旧 receipts 路径 | 400 | `VALIDATION_FAILED` | `taskhub.result_payload_invalid` / `taskhub.result_envelope_required` | 保留本地结果和证据，停止自动重传，待人工处理。 |
| Worker 或集成凭据缺失、失效 | 401 | `UNAUTHENTICATED` | `taskhub.worker_unauthenticated` / `c3.integration_unauthenticated` | 保留队列；修复凭据后按原包重试。 |
| 旧节点、错主体或错集成作用域 | 403 | `FORBIDDEN` | `taskhub.node_revoked` / `taskhub.binding_forbidden` / `c3.integration_forbidden` | 节点吊销才清桌面节点凭据；C3 Outbox 进入死信。 |
| 同 `resultId` 或同 `eventId` 内容不一致 | 409 | `IDEMPOTENCY_CONFLICT` | `taskhub.result_idempotency_conflict` / `taskhub.receipt_idempotency_conflict` | 保留凭据、收件箱和提交包，刷新权威快照；不重跑 Agent。 |
| receipt 序号、执行状态或投影版本冲突 | 409 | `VERSION_CONFLICT` | `taskhub.receipt_sequence_replayed` / `taskhub.execution_state_conflict` / `c3.projection_version_conflict` | 保留本地证据并刷新；不当作节点被替换。 |
| Task、offer 或对当前主体不可见的 timeline 不存在 | 404 | `NOT_FOUND` | `taskhub.timeline_not_found` | 不泄露其他用户、节点或任务信息。 |
| 超时、网络或下游不可用 | 503 | `DOWNSTREAM_UNAVAILABLE` | `taskhub.temporarily_unavailable` / `c3.taskhub_unavailable` | 保留原子提交包或 Outbox；依既定退避重试。 |

## 2. H1-4C：结果回传

### 2.1 权威状态

- 送达只有 `NODE_STORED`、`USER_OPENED` 回执可推进；下载、本机打开和客户端显示不能伪造 Hub 已送达。
- `EXECUTION_STARTED` 继续走既有 `POST /api/v2/taskhub/worker/receipts`，其 `resultSha256` 必须为 `null`。
- `RESULT_READY`、`EXECUTION_FAILED`、`OUTCOME_UNKNOWN` 是终态，必须与结果一起原子提交；分别把既有 assignment `executionState` 置为 `RESULT_READY`、`FAILED`、`OUTCOME_UNKNOWN`。
- Worker 只能投影既有本机 TaskHub Delivery/Evidence 的受控摘要、制品引用和验证结论。不得上传工作树路径、原始制品、模型/Agent 会话、提示词、Token、私钥或 Apply 权限。
- `FAILED`、`OUTCOME_UNKNOWN` 不触发自动重跑；任何后续工作仍受本机计划、执行范围和人工 Apply 门约束。

### 2.2 `TaskResultEnvelopeV1` 与摘要

```ts
type TaskResultOutcomeV1 = 'RESULT_READY' | 'EXECUTION_FAILED' | 'OUTCOME_UNKNOWN'
type VerificationVerdictV1 = 'PASS' | 'FAIL' | 'NOT_RUN' | 'OUTCOME_UNKNOWN'

interface TaskResultArtifactRefV1 {
  artifactId: string
  mediaType: string
  sha256: string
}

interface TaskResultEnvelopeV1 {
  schemaVersion: 'xiaogui.task-result.v1'
  resultId: string
  assignmentId: string
  taskId: string
  outcome: TaskResultOutcomeV1
  resultSummary: string
  artifactRefs: readonly TaskResultArtifactRefV1[]
  verification: { verdict: VerificationVerdictV1; summary: string }
  occurredAt: string
  resultSha256: string
}
```

`resultSha256` 的规范化值不含自身字段，UTF-8 编码、SHA-256、小写十六进制并加 `sha256:` 前缀。规范化 JSON 必须是下列**有序数组**的 `JSON.stringify` 结果；不得用对象字段顺序、空白或本地化格式参与摘要。

```ts
JSON.stringify([
  result.schemaVersion,
  result.resultId,
  result.assignmentId,
  result.taskId,
  result.outcome,
  result.resultSummary,
  result.artifactRefs.map((ref) => [ref.artifactId, ref.mediaType, ref.sha256]),
  [result.verification.verdict, result.verification.summary],
  result.occurredAt,
])
```

制品数组顺序是结果语义的一部分；不能在重试时重新排序。`resultId` 全局唯一：相同 `resultId`、相同规范化结果和同一 receipt 视为幂等；任何不同内容都是 `409 IDEMPOTENCY_CONFLICT / taskhub.result_idempotency_conflict`。

### 2.3 结果与签名回执的原子提交

已有 `TaskDeliveryReceiptV1` 不变。对象有 13 个字段（12 个 unsigned 字段加 `signature`）；签名本体仍是下列 12 项有序数组，签名字段本身不进入签名内容。

```ts
JSON.stringify([
  receipt.schemaVersion,
  receipt.eventId,
  receipt.assignmentId,
  receipt.taskId,
  receipt.subjectId,
  receipt.nodeId,
  receipt.keyId,
  receipt.eventType,
  receipt.packageSha256,
  receipt.occurredAt,
  receipt.sequence,
  receipt.resultSha256,
])
```

签名算法固定为 Ed25519，编码为 Base64。终态事件的 `receipt.eventType` 必须等于 `result.outcome`，`receipt.resultSha256` 必须等于按 2.2 计算的 `result.resultSha256`，`assignmentId`、`taskId`、`occurredAt` 必须一致。

```ts
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

| 路径 | 认证 | 成功响应 | 失败边界 |
| --- | --- | --- | --- |
| `POST /api/v2/taskhub/worker/results` | Worker 用户 JWT 的 `Authorization: Bearer …` 加当前节点 `x-xiaogui-node-token` | `{ data: ResultAckV1 }` | 事务中验证绑定、签名、结果/回执幂等、`(keyId, sequence)` 与状态后再写结果、回执和时间线。 |
| `POST /api/v2/taskhub/worker/receipts` | 既有双鉴权 | `{ data: ReceiptAckV1 }` | 收到任何终态 eventType 时返回 `400 VALIDATION_FAILED / taskhub.result_envelope_required`；它不会拆分结果和回执。 |

`artifact_receipt` 是 C2 制品安装/使用回执，不能作为本表、外键或替代证据。

### 2.4 结果时间线

```ts
interface TaskHubTimelineEntryV1 {
  timelineSequence: number
  eventType:
    | 'NODE_STORED' | 'USER_OPENED' | 'DIRECT_ACCEPTED' | 'DIRECT_REJECTED'
    | 'EXECUTION_STARTED' | 'RESULT_READY' | 'EXECUTION_FAILED' | 'OUTCOME_UNKNOWN'
  occurredAt: string
  recordedAt: string
  deliveryState: 'QUEUED' | 'NODE_STORED' | 'OPENED'
  executionState: 'NOT_STARTED' | 'RUNNING' | 'RESULT_READY' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  displaySummary: string
  result?: { resultId: string; verificationVerdict: VerificationVerdictV1 }
}

interface TaskHubTimelinePageV1 {
  items: readonly TaskHubTimelineEntryV1[]
  nextAfterSequence: number | null
}
```

时间线按 `timelineSequence ASC` 返回。请求参数为 `afterSequence`（默认 `0`）和 `limit`（默认 `50`、范围 `1..100`）；`nextAfterSequence` 为 `null` 表示无更多项目。

| 路径 | 认证与可见性 |
| --- | --- |
| `GET /api/v2/taskhub/worker/assignments/:assignmentId/timeline` | Worker JWT + node token；只读自己的 assignment，绝不返回节点公钥、subjectId、路径或其他收件账号。 |
| `GET /api/v2/taskhub/offers/:taskId/timeline` | 发布者 JWT；只返回受控送达/结果摘要，未授权或不可见任务统一 `404 NOT_FOUND / taskhub.timeline_not_found`。 |

## 3. C3：真实 Demand Intake

### 3.1 保持旧 V1，映射另立合同

`DemandSubmittedV1` 与 `DemandIntakeReceiptV1` 都保持现有 C2 的字段和 `additionalProperties: false` 语义。尤其是 `DemandIntakeReceiptV1` **不得新增 `taskId`**。

TaskHub 内部独立持久化以下权威映射；它不是旧 V1 回执字段，也不由社区网页直接写入：

```ts
interface DemandTaskMappingV1 {
  schemaVersion: 'xiaogui.demand-task-mapping.v1'
  intakeId: string
  demandId: string
  demandVersion: number
  demandContentSha256: string
  taskId: string
  createdAt: string
}
```

### 3.2 幂等、认证与重试

- 唯一幂等键始终是 `(demandId, demandVersion)`；`demandContentSha256` 仅校验同一键是否代表相同内容，**不是第三个键字段**。
- 规范化摘要使用 UTF-8 SHA-256 及 `sha256:` 前缀，对 `DemandSubmittedV1` 固定数组求值：

```ts
JSON.stringify([
  demand.demandId,
  demand.demandVersion,
  demand.title,
  demand.problemStatement,
  demand.expectedOutcome,
  demand.backgroundSummary ?? null,
  demand.constraints,
  demand.attachmentRefs.map((ref) => [ref.ref, ref.sha256, ref.dataClassification]),
  demand.requestedDeadline ?? null,
  demand.capabilityHints,
  demand.acceptanceHints,
  demand.visibility,
])
```

- `POST /api/v2/taskhub/intakes` 的 body 是严格 `DemandSubmittedV1`，成功体是**未改变**的 `{ data: DemandIntakeReceiptV1 }`。
- 只有 C3 Outbox Worker 可以调用该路径。它使用 `Authorization: Bearer <opaque C3-outbox integration token>`；服务器从已配置的 token 摘要解析固定调用主体 `c3-outbox-worker` 和 scope `taskhub:intake:write`。浏览器、用户 JWT、Worker node token 一律无权调用。
- 同键同摘要返回原 `DemandIntakeReceiptV1`；同键不同摘要返回 `409 IDEMPOTENCY_CONFLICT / taskhub.intake_payload_mismatch`。内容修正必须发布新的 `demandVersion`，不能拿冲突的旧事件原键重投以期待不同结果。
- 一个 Outbox 事件最多 **5 次总提交尝试**。第 1、2、3、4 次可重试失败后分别等待 1、5、30、120 分钟；第 5 次仍失败即进入死信。只有超时、连接错误、`5xx`/`DOWNSTREAM_UNAVAILABLE` 可自动重试。
- `400/401/403/409` 立即死信。凭据问题修复后可人工重投**同一原始事件**；内容冲突只能发布新版本。死信恢复必须保留 `demandId`、`demandVersion`、内容摘要、尝试计数和最后错误信封。

## 4. C3：TaskHub 只读投影

### 4.1 投影写入与存储接缝

社区浏览器永远不写 TaskHub。TaskHub 通过受控内部写入接缝把受控展示投影写入 C3；该接缝不是浏览器路径，也不授予 TaskHub 修改 Demand 本体或内部状态机的权限。

```ts
interface TaskHubProjectionUpdateV1 {
  schemaVersion: 'xiaogui.taskhub-projection-update.v1'
  demandId: string
  intakeId: string
  projection: DemandProgressProjectionV1
  projectionSha256: string
}

interface TaskHubProjectionAckV1 {
  demandId: string
  intakeId: string
  projectionVersion: number
  duplicate: boolean
  receivedAt: string
}
```

`projectionSha256` 也使用 UTF-8 SHA-256 和 `sha256:` 前缀。它不含自身字段，规范化内容固定为：

```ts
JSON.stringify([
  update.schemaVersion,
  update.demandId,
  update.intakeId,
  [
    update.projection.projectionVersion,
    update.projection.demandId,
    update.projection.intakeId,
    update.projection.stage,
    update.projection.displaySummary,
    update.projection.updatedAt,
    update.projection.deliveryRef ?? null,
  ],
])
```

| 路径 | 调用主体与认证 | 存储规则 |
| --- | --- | --- |
| `PUT /api/v2/community/internal/demand-projections/:demandId` | TaskHub 投影 Writer，`Authorization: Bearer <opaque taskhub-projection integration token>`；服务端固定主体 `taskhub-projection-writer`，scope `community:projection:write`。 | 仅写 `demand_taskhub_projection` 投影存储；按 `demandId` 保持最新完整快照及 `projectionSha256`。同版本同摘要幂等 ACK；同版本异摘要或更低版本为 `409 VERSION_CONFLICT / c3.projection_version_conflict`；更高版本原子替换。 |
| `GET /api/v2/demands/:demandId/taskhub-projection` | 现有社区用户会话与 Demand 可见性规则。 | 只返回 `{ data: DemandProgressProjectionV1 }`；无可见投影时 `404 NOT_FOUND`。 |

TaskHub 负责将成功状态写入自己的 projection-outbox 后再尝试内部 PUT；C3 Writer 只接受该受控主体。C3 不得反向创建、修改或推进 TaskHub 状态。

### 4.2 可展示状态

`DemandProgressProjectionV1` 保持 C2 预留的字段和阶段：`CLARIFYING`、`PLANNING`、`AWAITING_APPROVAL`、`EXECUTING`、`AWAITING_ACCEPTANCE`、`DELIVERED`、`CLOSED`。TaskHub 是唯一写入者，映射固定为：Intake 澄清→`CLARIFYING`；计划→`PLANNING`；本机计划待批准→`AWAITING_APPROVAL`；已验证执行开始→`EXECUTING`；受控结果就绪→`AWAITING_ACCEPTANCE`。

`DELIVERED`、`CLOSED` 只有未来经人工确认的 TaskHub 交付/关闭事实可写入；不得由 C3、浏览器、下载、结果上传或接收方打开任务推断。

## 5. 固定夹具与前端包

`H1-4C-C3-CONTRACT-FIXTURES.json` 提供成功、幂等、冲突、认证失败、旧路径拒绝、时间线分页和投影版本冲突样例。它必须通过 `node doc/validate-h1-4c-c3-contract-fixtures.mjs`：校验固定 DTO、C2 错误闭集、`messageKey`/`traceId`、结果摘要、13 字段 receipt 和 Ed25519 签名。

夹具只允许合同测试和之后的前端聚焦交互测试。它们不是实时 Hub、Worker、C3 Outbox 或网页联调证据。

在阶段 A 经人工验收前，不能派发前端代码。通过后按两个隔离小包派发：

1. 桌面 Renderer：仅消费 Worker timeline DTO 和固定夹具，不能修改主进程、持久化、状态机或 Hub。
2. Hub Web：仅消费 C3 read-only projection DTO 和固定夹具，不能修改 C3 Intake、投影 Writer、数据库或 TaskHub。
