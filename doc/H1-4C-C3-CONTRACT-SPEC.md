# TASKHUB H1-4C / C3 共享合同说明

版本：`v1.3-candidate`

状态：阶段 A 第三次修订候选；未实现、未合并、未发布。

## 机器合同是唯一规范源

`[H1-4C-C3-CONTRACT-V1.openapi.json](H1-4C-C3-CONTRACT-V1.openapi.json)` 是 H1-4C / C3 的唯一版本化机器合同源。它定义了所有新增的路径、认证组合、DTO、错误响应、状态枚举、分页参数、结果详情、C3 重试/死信扩展，以及摘要/签名的完整规范化字节规则。

以下文件不再重新定义传输合同：

- 本文只解释产品边界与施工约束；
- `H1-4C-C3-CONTRACT-FIXTURES.json` 只提供正常和失败样例；
- `validate-h1-4c-c3-contract-fixtures.mjs` 只读取 OpenAPI 合同校验夹具与负例。

任何后续 Hub、桌面或 C3 Web 实现必须从该 OpenAPI 合同生成或严格对齐接口；修改 DTO、路径、认证或错误语义时，先修改机器合同、再修改夹具和验证器，不得先在产品代码或 Markdown 中另立定义。

## H1-4C 结果回传边界

- 本包只补充“执行开始后的受控结果事实”，不建立第二套 TaskHub 执行状态机。Worker 继续复用本机既有 Delivery/Evidence；本机计划、范围确认、运行时选择、工作树、验证和最终 Apply 的人工门全部保留。
- `EXECUTION_STARTED` 保持既有签名回执路径；`RESULT_READY`、`EXECUTION_FAILED`、`OUTCOME_UNKNOWN` 必须通过同一个原子结果提交携带完整结果与对应签名回执。终态误投旧 receipt 路径，按 `VALIDATION_FAILED / taskhub.result_envelope_required` 拒绝。
- 结果中只允许受控 `resultSummary`、制品引用（ID、媒体类型、哈希）与验证结论；不得含本机路径、制品二进制、模型/Agent 会话、提示词、凭据、私钥或 Apply 权限。
- 结果幂等由 `resultId` 加规范化结果/回执确定；相同提交返回原 ACK 且 `duplicate:true`，同 ID 不同内容返回 `IDEMPOTENCY_CONFLICT`。机器合同的 `x-canonicalizations` 逐项固定 ECMAScript `JSON.stringify` 有序数组、嵌套数组、源数组顺序、缺失可选值转 `null`、不做 Unicode 规范化、无额外空白及 UTF-8 字节输入；验证器只解释并执行这份机器规则，不再另写字段顺序。
- 结果 ACK 的 `executionState` 是既有 assignment 状态投影：`RESULT_READY → RESULT_READY`、`EXECUTION_FAILED → FAILED`、`OUTCOME_UNKNOWN → OUTCOME_UNKNOWN`。失败和未知结果不自动重跑。

## 送达、结果和发布者可见性

- `USER_OPENED` 仍是唯一可令 Hub 认定“已送达”的回执事实；下载、客户端显示和结果上传都不能伪造送达。
- Worker 与发布者分别有只读时间线。时间线按 `timelineSequence ASC` 返回；后续页面必须逐字使用服务器上页发出的 `nextAfterSequence`，不能猜测或跳跃游标。
- 时间线的终态条目包含受控 `resultSummary`、`artifactRefs` 和完整验证摘要；发布者另有受控的结果详情读取路径，能看到同一受控结果，不获得节点、主体、路径、会话或原始制品。
- 未认证是 `401 UNAUTHENTICATED`；已认证但不可见的发布者时间线/结果统一 `404 NOT_FOUND`，不泄露任务存在性；节点吊销使用 `403 FORBIDDEN`，而普通状态冲突使用 `409` 并保留桌面凭据和待同步证据。

## C3 Demand Intake

- 既有严格 `DemandSubmittedV1` 和 `DemandIntakeReceiptV1` 保持 V1 不变；V1 receipt 绝不添加 `taskId`。
- `DemandTaskMappingV1` 是独立的 TaskHub 权威映射，保存 `demandId`、`demandVersion`、`intakeId` 与 `taskId` 的关联，不给社区网页写入。
- 幂等键永远只有 `(demandId, demandVersion)`；内容 SHA-256 只核验同键一致性。相同键相同内容返回原 receipt/映射；同键不同内容拒绝，修正必须创建更高 `demandVersion`。
- Intake 只能由 C3 Outbox 的固定集成主体以不透明 bearer token 调用；浏览器、用户 JWT、节点 token 均无权调用。
- 重试规则已在机器合同的 `submitDemandIntake.x-retry-policy` 固定：每次请求 30 秒超时，最多五次总尝试，四次延迟为 1、5、30、120 分钟；仅网络/超时/5xx/下游不可用可自动重试，第五次仍失败进死信。`DemandIntakeDeadLetterV1` 保存需求 ID、版本、内容摘要、尝试次数、末次错误和恢复状态；400/401/403/409 直接死信，凭据修复可人工重投原始不可变事件，内容冲突只能升版本。

## C3 只读投影

- TaskHub 通过受控的内部 projection writer 将最新快照写入 C3；C3 网页只能读取显示，不能反向创建、修改或推进 TaskHub 内部状态。
- projection writer 有独立不透明集成 token；它只能写入 `demand_taskhub_projection`，不能写 Demand 本体。
- 投影 `projectionVersion` 必须单调。相同版本相同摘要幂等；同版本不同摘要、或低版本，都返回 `VERSION_CONFLICT`。TaskHub 的 projection-outbox 负责未来重试。
- 可展示阶段固定为 `CLARIFYING`、`PLANNING`、`AWAITING_APPROVAL`、`EXECUTING`、`AWAITING_ACCEPTANCE`、`DELIVERED`、`CLOSED`。后两者只能来自未来人工确认的 TaskHub 事实。

## 固定夹具与验证门

夹具覆盖：三种结果终态、结果幂等 ACK、结果内容冲突、旧路径拒绝、匿名/吊销失败、Worker/发布者两页 cursor 时间线、发布者受控结果详情、Demand 同键同内容/异内容、严格未知字段拒绝、30 秒请求超时、五次重试及完整死信记录、projection 幂等与版本冲突、只读投影。

验证器还主动断言以下假阳性必须失败：使用正确 C3 集成凭据却把 Result 请求体误投 Intake 路由、匿名请求被当作 Worker 成功、非法 timeline eventType、缺失 ResultAck 字段、Demand 额外 `agentId`、断裂 fixture 引用，以及跳过服务器 cursor 的分页。

阶段 A 的唯一验证命令为：

```powershell
node doc/validate-h1-4c-c3-contract-fixtures.mjs
git diff --check
```

阶段 A 仍是纯合同审计，因此不运行构建、Electron、E2E 或真实网络旅程；该豁免不传递到 B/C/D 实现阶段。

## 后续派发约束

阶段 A 只有在独立审查和人工验收通过后才能进入 B。之后仍拆为两个独立前端工作包：

1. 桌面 H1-4C Renderer：消费 Worker timeline DTO 与固定夹具；不改主进程、持久化、权威状态机或 Hub。
2. Hub C3 网页投影：消费只读 projection DTO 与固定夹具；不改 C3 Intake、projection writer、数据库或 TaskHub。

两者都不能用 Fake 数据冒充真实联调；固定夹具只能支持聚焦交互开发。
