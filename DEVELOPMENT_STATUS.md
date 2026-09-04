# DEVELOPMENT STATUS

更新时间：2026-09-04
阶段：`TASKHUB-H1-4C-B` — 桌面受控结果上报候选
状态：桌面主进程实现、聚焦测试和真实 Hub HTTP 双 Worker 验证已完成；等待独立代码审查与人工验收。未合并正式主线、未发布；未进入 C3 或 Renderer/Web 前端。

## H1-4C 阶段 B 目标

在不新建执行状态机、不绕过现有计划/执行/交付人工门的前提下，把本机既有 TaskHub Delivery/Evidence 的终态投影为严格受控结果：先签名 `EXECUTION_STARTED`，再以同一有序证据队列提交“结果信封 + 终态签名回执”；只在 Hub 返回精确验证 ACK 后出队。该能力只在主进程受信生命周期回调中调用，不新增 Renderer 控制入口。

## H1-4C 实际修改文件

| 范围 | 文件 |
| --- | --- |
| 共享桌面结果契约和聚焦断言 | `packages/shared/xiaogui-hub-task-contract.ts`、`packages/shared/xiaogui-hub-task-contract.test.ts` |
| 受控 Delivery/Evidence 结果投影 | `src/main/xiaogui/hub-task/task-result-projection.ts`、`task-result-projection.test.ts` |
| HTTP Adapter 与 ACK/409 语义 | `src/main/xiaogui/hub-task/http-task-worker-port.ts`、`http-task-worker-port.test.ts` |
| 本机有序证据队列、持久化和服务 | `src/main/xiaogui/hub-task/worker-state.ts`、`worker-state.test.ts`、`worker-persistence.test.ts`、`worker-service.ts`、`worker-service.test.ts`、`worker-ipc.test.ts` |
| 受信执行/交付生命周期接线 | `src/main/xiaogui/task-hub/ipc.ts`、`ipc.test.ts`、`src/main/xiaogui/task-hub/delivery-ipc.ts`、`delivery-ipc.test.ts`、`src/main/xiaogui/index.ts`、`index.test.ts` |
| 阶段记录 | `DEVELOPMENT_STATUS.md` |

## H1-4C 已完成内容

- `XiaoguiTaskResultEnvelopeV1` 现冻结结果摘要、只含 SHA-256 的制品引用、验证结论及三类终态；本机绝对路径、文件字节、模型会话、Agent 凭据和原始验证输出均会被拒绝。
- `task-result-projection` 只消费既有 Delivery/Evidence 的 `READY_FOR_REVIEW`、`REJECTED`、`OUTCOME_UNKNOWN` 等终态投影；不能由 Renderer、自然语言或模型直接伪造结果。
- Worker 状态把普通签名回执和“结果 + 终态回执”统一为按 `sequence` 排序的持久证据队列；前一项未收到精确 ACK 时，后续终态不会越过它。
- 用户批准的本机计划被原有 orchestrator 接受后才记录 `EXECUTION_STARTED`；原有交付选择产生权威结果投影后才报告终态。没有新增自动执行、自动合并或自动 Apply。
- HTTP Adapter 已接入 Hub 的 `POST /api/v2/taskhub/worker/results`；`403` 仍表示节点失效并清理本机凭据，`409` 仍表示任务状态冲突并保留凭据、缓存和收件箱。
- 真实 HTTP 冒烟已用两套隔离桌面 Worker 服务、真实 Fastify Hub 和发布者 API 跑通；收件方上报的时间线为 `NODE_STORED → USER_OPENED → DIRECT_ACCEPTED → EXECUTION_STARTED → RESULT_READY`，发布者能读取受控结果摘要，队列最终为 0。

## H1-4C 未完成内容

- 尚未完成独立代码审查或人工验收，也未进行两台真实电脑的 H1-4C 结果回传旅程。
- 未建设或修改 Renderer 结果时间线、Hub 网页投影、C3 Demand Intake、社区投影或死信处理。
- 未允许发布者下载结果制品、触发执行、合并或 Apply；这些均不属于本阶段。
- H1-LAN 的首页全局收件箱与 Windows CMD 启动脚本两个既有 P2，仍保持独立待办。

## H1-4C 与规格文档的偏差

- 无冻结产品或架构偏差：复用现有 TaskHub Delivery/Evidence 和 `TaskAssignment.executionState`，未建立第二套 Attempt、工作树、运行时或 Apply 状态机。
- 阶段 A 的 C3 合同仍只作为后续合同，未被本桌面候选实现或以假数据冒充真实联调。
- 本地 `node_modules` Junction 复用 `D:\PI\pi-app\node_modules`；该共享目录缺少桌面锁定的 `pdfjs-dist@6.1.200`，所以本次没有为 H1-4C 修改依赖、锁文件或 PDF 实现来掩盖环境缺口。

## H1-4C 测试命令和结果

| 检查 | 结果 |
| --- | --- |
| `vitest run packages/shared/xiaogui-hub-task-contract.test.ts src/main/xiaogui/hub-task/task-result-projection.test.ts src/main/xiaogui/hub-task/worker-state.test.ts` | 通过：3 文件 / 12 用例。 |
| `vitest run src/main/xiaogui/hub-task/worker-service.test.ts src/main/xiaogui/hub-task/worker-persistence.test.ts src/main/xiaogui/hub-task/http-task-worker-port.test.ts src/main/xiaogui/hub-task/worker-ipc.test.ts` | 通过：4 文件 / 26 用例。 |
| `vitest run src/main/xiaogui/task-hub/ipc.test.ts src/main/xiaogui/task-hub/delivery-ipc.test.ts src/main/xiaogui/index.test.ts` | 通过：3 文件 / 21 用例。 |
| 以上聚焦测试合计 | 通过：10 文件 / 59 用例。 |
| `tsx --tsconfig <desktop>/tsconfig.node.json D:\CodexTemp\xiaogui-h1-4c-result-http-smoke.mts` | 通过：真实 HTTP Hub、两套隔离 Worker、发布者结果读取；不使用 Fake Hub 数据。 |
| `tsc --noEmit -p tsconfig.node.json` 与 `tsconfig.web.json` | 未通过，仅报 4 处既有 `pdfjs-dist/legacy/build/pdf.mjs` 缺失（含 1 个 main、3 个 Renderer 文档预览文件）；H1-4C 新增/修改文件不在报错列表。 |
| `npm run build` | 未通过，主进程和 preload 已构建完成，Renderer 在同一既有 `pdfjs-dist` 缺失处停止；未修改无关 PDF 依赖以规避该问题。 |
| `git diff --check` | 待最终提交前复跑。 |

## H1-4C 已知风险

- 当前共享依赖工作树与本候选 `package-lock.json` 不一致，缺少已锁定的 `pdfjs-dist`；这阻断全量桌面 typecheck/build，但不改变已通过的 H1-4C 聚焦测试和真实 HTTP 验证。应另立依赖恢复/WORK 文档预览验证包处理，不能在本任务中静默改动。
- 真实 HTTP 冒烟是同机双 Worker 服务而非两台真实电脑，未覆盖断网、重启或跨机网络；H1-4B 的送达 LAN 证据不能自动扩展为 H1-4C 结果回传验收。
- 生命周期回调使用非阻塞上传，网络故障时证据队列保留并由同步重试；必须在人工跨机验收中核对发生时间与 Hub 接收时间。

## H1-4C 下一阶段计划

1. 复跑差异检查，分别提交并推送桌面与 Hub 候选。
2. 对固定 SHA 执行独立只读代码审查；审查通过后暂停在人工验收门。
3. 获得人工授权后，才安排两台真实电脑的 H1-4C “发布—接受—执行开始—结果回传—发布者审阅”旅程。
4. H1-4C 人工验收后，才依据冻结合同单独派发 Renderer/Web 前端小包；C3 继续保持未启动。

## H1-4C 验收门

当前只形成独立候选。不得合并正式主线、发布、启动 C3 或启动前端实施；必须先完成独立审查与人工验收。

## 历史阶段 A 目标

只读核对 H1、C2、WORK 与 CODING 的提交关系、冲突面和迁移顺序，选择后续独立工作树基线；冻结 H1-4C 结果回传和 C3 Demand Intake/只读投影的 DTO、状态语义、错误码、接口路径与正常/失败夹具，并对夹具执行摘要、签名和错误信封的聚焦合同校验。阶段 A 不建立统一产品基线、不写产品代码。

## 阶段 A 实际修改文件

| 范围 | 文件 |
| --- | --- |
| 集成基线、合同与迁移审计 | `doc/H1-4C-C3-INTEGRATION-BASELINE-AUDIT.md` |
| 前端与后端共用的合同夹具 | `doc/H1-4C-C3-CONTRACT-FIXTURES.json` |
| 唯一版本化机器合同 | `doc/H1-4C-C3-CONTRACT-V1.openapi.json` |
| 阶段状态记录 | `DEVELOPMENT_STATUS.md` |

### REQUEST CHANGES 修订新增文件

| 范围 | 文件 |
| --- | --- |
| 人类可读合同说明 | doc/H1-4C-C3-CONTRACT-SPEC.md |
| 无依赖 OpenAPI/夹具聚焦验证器 | doc/validate-h1-4c-c3-contract-fixtures.mjs |

## 阶段 A 已完成内容

- 确认桌面 H1-LAN、WORK、CODING 都以 `agent/stage-integration-v1@0d2deece4c35851363b918313cb27d2848207c73` 为共同祖先；其中 `WORK@8c8728c` 是 `CODING@52432ef` 的祖先。H1 仍与其共享入口分叉，后续 H1-4C 不吸收 WORK/CODING。
- 确认 Hub H1-4B `770c0a7` 与 C2 阶段线 `48e3cf5` 从 `1fe28cc` 分叉；实际三方 merge-tree 已列出 OpenAPI、Drizzle、应用注册、schema、制品路由、测试和文档冲突，不能静默合并。
- 冻结仅供后续实现的结果/Intake/投影机器合同与契约夹具；夹具明确标为 `CONTRACT_ONLY`，不得作为真实联调证据。
- 明确后续前端必须拆为桌面 H1-4C Renderer 与 Hub C3 网页两个独立工作树、两个工作包；当前尚未派发。

### REQUEST CHANGES 修订完成

- H1 合同现在冻结结果有序摘要、完整 13 字段 Ed25519 receipt、原子结果提交、双时间线 DTO 和 C2 闭集错误信封；夹具使用真正可验签的测试公钥和签名，不存测试私钥。
- C3 保留既有 DemandIntakeReceiptV1；三 ID 映射改为内部 DemandTaskMappingV1。幂等键严格是 demandId + demandVersion，规范化内容摘要仅做同键一致性校验。
- C3 Outbox→TaskHub Intake 与 TaskHub→C3 internal projection Writer 均已有调用主体、认证头、存储、重试/死信和只读网页路径的冻结合同。
- 夹具新增旧 receipt 终态拒绝、结果冲突、时间线、认证失败、同键同内容/异内容、projection 写入与版本冲突等正常/失败样例。

### 第二轮 REQUEST CHANGES 修订完成

- 新增 `H1-4C-C3-CONTRACT-V1.openapi.json` 作为唯一版本化机器合同源，严格覆盖新增 Result、ResultAck、Worker/发布者 Timeline、发布者结果详情、DemandTaskMapping、Projection Writer/ACK、路径、错误响应和认证组合；说明文档不再重新定义传输 DTO。
- 验证器现在从 OpenAPI 读取路径、认证、请求/响应 schema 与 C2 错误闭集，逐一校验夹具；不再把 JSON 能解析当成合同正确。
- H1 夹具补齐 `RESULT_READY`、`EXECUTION_FAILED`、`OUTCOME_UNKNOWN`、幂等 `duplicate:true` ACK、发布者受控结果详情，以及非空第一页到第二页的严格 cursor 闭环。
- C3 夹具补齐同键同内容的原回执/不新建映射、严格未知 `agentId` 拒绝、集成认证失败、五次重试后死信、projection 同版本异摘要和低版本冲突请求。
- fixture `keyId` 已按现有 Hub 公钥 SHA-256 截断发行规则派生；所有测试 receipt 以对应私钥的单次签名验证，仓库仅保存测试公钥。
- 负例覆盖错误路由、匿名成功、非法 timeline eventType、缺失 ResultAck 字段、断裂 fixture 引用和跳跃 cursor，确保上述改坏方式必须验证失败。

### 第三轮 REQUEST CHANGES 修订完成

- OpenAPI `x-canonicalizations` 不再只列字段名，而是逐项机器描述 ECMAScript `JSON.stringify` 有序数组、嵌套/映射数组、UTF-8、无 Unicode 规范化、无空白、源数组顺序和可选缺失值转 `null`；验证器从该规则解释并生成摘要/签名字节，不再硬编码四套字段顺序。
- C3 Intake 固定单次请求超时为 30 秒；新增严格 `DemandIntakeDeadLetterV1`，以及包含需求 ID、版本、内容摘要、五次尝试、末次错误和恢复状态的死信夹具。
- 错误路由负例改用正确 `C3_OUTBOX_INTEGRATION` 鉴权；验证器先确认路由/鉴权/状态码合法，再只验证 H1 Result 请求体被 Intake schema 拒绝，消除鉴权先失败造成的假阳性。

### 第三轮独立复验

- 复验对象：`agent/taskhub-h1-4c-c3-audit-v1@8d2063c6fe7d2fd49fee5a8e77917a8aa0ed4a04`；复验时本地、远端 SHA 一致且工作树干净。
- 结论：`APPROVE`；Standards 0 项、Spec 0 项。审查确认规范化字节规则由 OpenAPI 机器定义且被验证器解释执行，30 秒超时与死信 DTO/夹具完整，错误路由负例在正确 C3 鉴权下因请求体 schema 不符而失败。
- 独立复验实际执行 `node doc/validate-h1-4c-c3-contract-fixtures.mjs` 与 `git diff --check 98ac8b670aaf71a9d01c887cfe7b77eb6e2f8bd3..HEAD`，均通过；未修改文件、未运行构建/typecheck/E2E/真实联调。
- 此结论只放行阶段 A 合同候选，不构成阶段 B 开工、前端派发、合并或发布授权。

## 阶段 A 未完成内容

- 未建立 Hub H1-4C/C3 的实际整合基线，未解决 C2 与 H1-4B 的 schema、迁移或 OpenAPI 冲突。
- 未实现结果上传、ACK、时间线、发布者视图、Demand Intake、死信恢复或 C3 投影。
- 未派发任何前端代码任务；须在合同经独立审查和人工验收后再直接向前端 Agent 派发。
- H1-LAN 的两个 P2 跟进项仍独立待办，不混入本阶段。

## 阶段 A 与规格的偏差

- 无冻结产品或架构决策偏差。阶段 A 按授权只做审计和合同 Spike，不将 C2 `artifact_receipt` 用作 TaskHub 回执或结果。
- `XiaoguiTaskResultEnvelopeV1` 在桌面分支仅是未实现的预留类型，尚无 Hub 同名实现、解析器、路由或持久化；后续以本阶段冻结的规范统一实现，不能把现有预留类型误报为已可用接口。
- C3 当前 `DemandIntakeReceiptV1` 与 `DemandProgressProjectionV1` 仍为 `RESERVED_C3`。阶段 A 仅给出实现合同，未把夹具数据伪装为真实 Intake 或投影。

## 阶段 A 测试与证据

| 检查 | 结果 |
| --- | --- |
| `git merge-base`（H1/WORK/CODING 与阶段线） | 三者共同祖先均为 `0d2deece4c35851363b918313cb27d2848207c73`。 |
| `git merge-base 770c0a7 48e3cf5` | 共同祖先为 `1fe28cc0cb336916440fc597d51cb44a9c44cefe`，Hub 两线不是祖先关系。 |
| `git merge-tree 1fe28cc 770c0a7 48e3cf5` | 已识别真实冲突清单；详见审计文档，不执行工作树 merge。 |
| `git diff --check` | 通过：审计、夹具与状态记录无空白或冲突标记；不跑与文档审计无关的构建或全量测试。 |
| `node -e "JSON.parse(...)"` | 通过：OpenAPI 机器合同与夹具均为有效 JSON。 |

### REQUEST CHANGES 验证门与文档阶段豁免

本阶段没有可构建的产品实现，所以豁免 Electron/E2E、构建、类型检查和全量测试；它们不能证明本阶段的签名、摘要、错误信封或幂等语义。豁免只适用于阶段 A，不传递到 H1-4C/C3 实现阶段。

| 检查 | 结果 |
| --- | --- |
| node doc/validate-h1-4c-c3-contract-fixtures.mjs | 通过：从 OpenAPI 校验路由/方法/认证/状态码/严格 DTO，并解释机器定义的 JSON.stringify/UTF-8/嵌套/null 规则生成摘要与签名字节；验签完整 13 字段 receipt 与派生 keyId，校验三终态、幂等 ACK、发布者结果详情、同键冲突、两页 cursor、C3 30 秒超时、五次重试及完整死信记录与投影冲突；错误路由以正确 C3 鉴权进入请求体校验后被拒绝，其余负例也均被拒绝。 |
 | git diff --check | 通过：本次修订无空白或冲突标记；它只检查文档差异卫生，不能替代语义校验。 |

## 阶段 A 已知风险

- Hub Drizzle 的 `0016` 编号、snapshot 和 journal 均碰撞；不先制定目标数据库升级路径就开始 H1-4C/C3 会损坏迁移语义。
- 结果状态必须投影既有本机 TaskHub Delivery/Evidence，不得复制出第二套 Attempt、工作树、运行时或 Apply 状态机。
- C3 网页只能读受控投影；社区 Outbox/路由不得直接写 TaskHub 内部表或触发执行。

## 阶段 A 下一步

1. 等待用户完成人工验收并明确授权阶段 B；在此之前不建立产品整合分支、不派发前端实现。
2. 获得授权后才建立 Hub H1-4C/C3 受控整合基线，先处理迁移与合同冲突，再实施 H1-4C 后端。
3. H1-4C 合同在后端验证夹具通过后，分别派发桌面 Renderer 前端小包和 Hub C3 网页投影小包；不跨仓库混写。

## 前置 H1-4B / H1-LAN 已验收记录

### H1-4B 本阶段目标

在不改变本机 TaskHub DAG、运行时选择、工作树或人工批准门的前提下，把 H1-3 已持久化的签名 `TaskDeliveryReceiptV1` 接入 Hub 的 H1-4B Worker 回执端点：离线时保留，联网后按序上传，只有获得匹配且 `verified: true` 的 ACK 才移出本地队列。

### H1-4B 仓库与基线

- 桌面仓库：`https://github.com/locadds/pi-planning-agent.git`
- 隔离工作树：`D:\CodexWorktrees\xiaogui-taskhub-h1-receipt-sync-v1`
- 功能分支：`agent/taskhub-h1-receipt-sync-v1`
- 施工基点：`agent/taskhub-h1-receipt-v1@1e0626a1bf70422fe13cba0ec9d666ffaa957168`（H1-4A 人工验收状态记录）
- 对接 Hub 独立检查点：`codex/taskhub-h1-4b-receipt-api-v1@770c0a781f22a527eddd8a1c2aeb7caff09dced0`
- Hub 接口：`POST /api/v2/taskhub/worker/receipts`，成功体为 `{ data: ReceiptAckV1 }`；同时要求 Hub bearer token 与 `x-xiaogui-node-token`。

### H1-4B 实际修改文件

| 范围 | 文件 |
| --- | --- |
| HTTP 回执 Adapter | `src/main/xiaogui/hub-task/http-task-worker-port.ts`、`http-task-worker-port.test.ts` |
| 回执队列与 ACK 状态 | `src/main/xiaogui/hub-task/worker-state.ts`、`worker-state.test.ts` |
| Worker 补传与故障语义 | `src/main/xiaogui/hub-task/worker-service.ts`、`worker-service.test.ts` |
| 收件箱同步文案 | `src/renderer/src/xiaogui/components/HubTaskInboxSection.tsx`、`HubTaskInboxSection.test.tsx` |
| 阶段记录 | `DEVELOPMENT_STATUS.md` |

### H1-4B 已完成内容

- HTTP Adapter 向已提交的 Hub H1-4B 路径提交签名回执，只传回执载荷，并严格解析 `ReceiptAckV1`；不向 Renderer 返回 token、私钥、路径、任务正文或响应错误体。
- Worker 本地状态新增 ACK 出队门：只有同一 `eventId` 且 `verified: true` 的 ACK 才能移除一条持久化回执。错误 ACK、离线、协议异常都保留本地证据。
- 回执严格按 `sequence` 顺序处理；在一个正在执行的补传中新增的回执也会被顺序继续处理，避免后续事件越过前序事件。
- 补正 ACK 关联门：服务层与状态层都要求 ACK 的 `eventId` 等于刚刚提交的队首回执。Hub 若错误回传队列中后续回执的 ACK，会 fail-closed，保留两条记录并停止本轮补传。
- `USER_OPENED` 收到验证 ACK 后，标记为本机 `HUB_CONFIRMED`；下一次 Hub 权威快照仍决定公开的 `deliveryState: OPENED`，不会把本地打开误称为送达。
- 打开任务和定向接受/拒绝后会启动不阻塞 UI 的补传尝试；网络不可用时操作仍保留为本机草稿，周期刷新或用户“同步”会重试。
- 延续 H1-4A 语义：`409` 是 Hub 已双鉴权后的回执/状态冲突（如事件载荷不一致、序号重放或关联不匹配），保留凭据、收件箱和签名回执并刷新权威状态；`403` 是节点已吊销/被替换，清除旧节点凭据、缓存任务包与未上传回执。
- 收件箱提示由阶段占位文案改为“本机签名回执等待 Hub 验证同步；联网后按顺序重试”。

### H1-4B 未完成内容

- 已完成两台真实电脑的 LAN 送达旅程；本阶段不再把同机双实例当作唯一跨机证据。
- P2 跟进尚未实施：主页的全局收件箱与已接受任务摘要、以及 Windows CMD 可可靠运行的 `start-hub-lan.cmd` 换行修复，均须另立受控修复包。
- H1-4C 尚未开始：结果摘要/制品引用回传、发布者审阅时间线、`RESULT_READY`/失败/结果未知回执。
- 未实现自动执行、自动合并、自动 Apply、Agent 选择或底层运行时暴露。

### H1-4B 与规格文档的偏差

- 无冻结产品或架构决策偏差。Hub 仍只识别账号与小规节点，桌面本机仍在用户批准后才生成 TaskHub 计划草稿并选择运行时。
- 本阶段只实现 H1-4B 的送达证据闭环；未提前实现 H1-4C 结果上传，也未复用 C2 的 `artifact_receipt`。
- 同机双实例先提供真实跨进程、真实 Hub 与隔离数据目录证据；2026-09-03 的两机 LAN 验收再补足跨电脑送达证据。验收方明确 J0–J3 依据 Kimi 交接与 `hub-lan-dump-j3.json` 通过、未重复执行；本登记不把它改写为开发方自行复跑。

### H1-4B 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit -- src/main/xiaogui/hub-task/worker-state.test.ts src/main/xiaogui/hub-task/worker-service.test.ts src/main/xiaogui/hub-task/http-task-worker-port.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx` | 通过：4 个测试文件、27 条用例。覆盖 ACK 精确出队、错误 ACK 指向后序回执时的 fail-closed、重复 ACK、离线保留、恢复补传、权威 `OPENED` 快照、409 保留和 403 清理。 |
| `npm run typecheck` | 通过：web 与 node 两个 TypeScript 配置。 |
| `npm run build` | 通过：主进程、预加载与 Renderer 均构建完成；仅保留仓库既有动态导入优化警告。 |
| `git diff --check` | 通过：无空白或冲突标记。 |
| H1-LAN 验收方真实两机旅程（非开发方重跑） | `APPROVE WITH FOLLOW-UPS`：J0–J3 以 Kimi 交接和 `hub-lan-dump-j3.json` 为依据；J4–J7 覆盖发布者隔离、离线补传、重启持久化和当前发布者可见性边界。 |

### H1-4B 单机双实例真实验收

- 验收结论：`APPROVE`。验收所用桌面为本分支 `90ec63c689f7f58e2801eeacb9dd53856549facf`，Hub 为 `codex/taskhub-h1-4b-receipt-api-v1@770c0a781f22a527eddd8a1c2aeb7caff09dced0`；验收全程未修改任一仓库。
- 证据目录：`D:\CodexTemp\xiaogui-h1-4b-dual-acceptance\evidence\`。本次登记已核对目录与关键截图/JSON 存在；完整旅程与数据库地面真值来自验收报告，不将其改写为开发方自行复跑。
- 已验证：同机两个活跃节点及独立 Ed25519 密钥；DIRECT 和 POOL 两条真实送达链路；A 的收件箱/API 隔离；Hub 停止期间 B 可打开任务并持久化 `USER_OPENED`，恢复后补传的 `occurredAt` 比 `receivedAt` 早 51 秒；B 节点回执序列 1 至 6 连续；重启桌面后凭据、收件箱与三项任务状态保留。
- Hub 数据库地面真值为 3 个 assignment 均 `OPENED`、6 条回执全序列留存；B UI 显示“Hub 已确认送达”。
- 范围确认：没有结果上传、`RESULT_READY`、自动执行、工作树写入、合并/Apply 或 C2 `artifact_receipt` 复用。

本工作树仅建立一个未跟踪的 `node_modules` Junction，指向 D 盘已有共享依赖目录；未安装依赖、未修改 `package.json` 或锁文件，也不纳入提交。

### H1-4B 两机 LAN 真实验收（验收方报告）

- 结论：`APPROVE WITH FOLLOW-UPS`。验收对象为桌面 `agent/taskhub-h1-receipt-sync-v1@4e55034f44d4b6800dea200cf6d97434d07617c8` 与 Hub `codex/taskhub-h1-4b-receipt-api-v1@770c0a781f22a527eddd8a1c2aeb7caff09dced0`；验收时两候选工作树均干净且与远端一致。
- J0–J3：验收方依据 Kimi 交接和 `hub-lan-dump-j3.json` 通过，未在本轮重复执行。
- J4：发布者 UI 和 API 收件箱均为空，发布者隔离通过。
- J5：断网时任务内容可读、回执未丢失；节点 `sequence` 为 1–7 连续，第 7 条 `USER_OPENED` 延迟约 5 分 22.620 秒补传，最终 `delivery_state=OPENED`。
- J6：桌面重启后节点凭据、任务和状态保留。
- J7：发布者查询仍返回 `assignment: null` 且没有 `deliveryState`，符合当前冻结边界，不把它表述为发布者送达视图已完成。
- 截图未另行归档；按验收决定，以本次会话记录与 Hub 数据库输出作为证据。验收未授权 H1-4C、正式主线合并或发布。

### H1-4B 已知风险

- 如果桌面版本先于 Hub `770c0a7` 部署，回执端点不可用，Worker 会保留本地证据并显示可重试状态，不会伪造“已送达”。
- ACK 通过后必须在下一次权威轮询中看到 `deliveryState: OPENED`，发布方 UI 才能以 Hub 事实展示送达；网络请求成功不等于跨机验收完成。
- 两台真实电脑 LAN 已经通过；本轮未单独新增节点替换或实时 `409` 冲突的两机证据，不能把这些未覆盖情形写成已验收。
- ACK 错指回执的首轮审查问题已由双层前序事件校验与双回执回归修复，并经独立复审确认；后续真实网络旅程仍须验证 Hub 行为不会产生该类异常 ACK。
- P2（产品口径，非缺陷）：当前 Hub 发布者读取 offer 时没有 `deliveryState` 视图；验收中的发布者送达事实由执行者侧权威 `OPENED` 快照与 Hub 数据库地面真值确认。发布者最小送达视图仍应在 H1-4C+ 显式立项，不能提前声称已具备。
- P3（观察项）：IPC 直建会话在 Pi 落盘首个 assistant 消息前，`session.list` 可能看不到会话而留下不可见 scope 绑定。本轮改用真实 composer 绕过，节点级回执不受影响；后续应在 scope 绑定处增加防御或记录约束。
- P2（两机验收跟进）：主页应展示全局收件箱与已接受任务摘要，详细执行仍关联具体对话；该界面修复不改变现有收件箱、回执或 TaskHub 领域状态机。
- P2（两机验收跟进）：`start-hub-lan.cmd` 使用 LF 换行，Windows CMD 无法可靠执行；应在独立工具修复包中转换为 Windows 可执行的换行格式并做最小启动验证。
- 运行提示：验收方建议关闭监听 `0.0.0.0:8790` 的测试 Hub；本阶段没有收到关闭授权，开发方未执行停止或清理操作。

### H1-4B 独立验收记录

- 复审对象：`agent/taskhub-h1-receipt-sync-v1@9ad12dc094a52fcca59be02b4e3a9d9093dac81c`，与 `planning-agent` 远端同 SHA。
- 结论：`APPROVE`。首轮发现的 HIGH（ACK 错指本地后续回执）已消除：服务层校验刚提交队首，状态层也要求 `expectedEventId`；两条待发回执的错指 ACK 回归确认 fail-closed、仅提交首条、两条均保留。
- 验收方实际复跑：聚焦 4 文件 / 27 用例、`npm run typecheck`、`npm run build` 与 `git diff --check 1e0626a...HEAD` 均通过；构建只出现仓库既有动态导入优化警告。
- 范围复核：没有结果上传、自动执行、工作树、Agent 运行时选择、merge / Apply，也没有复用或污染 C2 `artifact_receipt`。
- 工作树只剩独立只读审查产生的未跟踪 `.omo/` 证据目录，未纳入源码提交。

### H1-4B 历史下一阶段计划

1. 等待用户决定是否分别建立两个窄 P2 修复包：桌面主页全局收件箱摘要，和 Hub LAN 启动脚本 Windows CMD 兼容；两项均不得顺带进入 H1-4C。
2. H1-4C 的结果摘要/制品引用回传、发布者审阅时间线和结果回执仍须另行立项，继续保持本机计划、执行和最终应用的人工批准门。
3. 不合并正式主线、不发布、不制作新安装包；测试 Hub 的停止或清理由其运行所有者明确授权后再做。

### H1-4B 历史验收门

本文件记录的是 H1-4B 桌面代码已通过独立审查、并已完成单机双实例和两机 LAN 的真实送达验收；两机 LAN 结论为 `APPROVE WITH FOLLOW-UPS`。它不构成正式主线合并、发布或 H1-4C 的授权；两个 P2 跟进项必须另立修复包并重新验收。
