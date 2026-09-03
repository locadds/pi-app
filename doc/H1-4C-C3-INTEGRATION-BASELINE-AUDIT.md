# TASKHUB H1-4C / C3 阶段 A：集成基线审计

状态：修订候选，等待重新独立审查与人工验收

日期：2026-09-03

范围：只读审计、共享合同、夹具和聚焦合同校验；不含产品代码、数据库迁移、路由、Renderer/Web 实现、合并或发布。

> `H1-4C-C3-CONTRACT-V1.openapi.json` 是唯一版本化机器合同源；`H1-4C-C3-CONTRACT-SPEC.md` 只解释产品边界。本文件只记录基线、冲突、迁移顺序与验收门；夹具只由机器合同和验证器校验。

## 1. 已核对的基线

| 轨道 | 工作树 / 分支 | 已核对 HEAD | 与后续工作的关系 |
| --- | --- | --- | --- |
| 桌面 H1-LAN | D:\CodexWorktrees\xiaogui-taskhub-h1-receipt-sync-v1 / agent/taskhub-h1-receipt-sync-v1 | 249bab76bb9c7855a1aa75a7a03303783212f81d | 功能基线是已验收的 4e55034；249bab7 仅登记 LAN 验收。H1-4C 桌面后续从此审计提交派生。 |
| Hub H1-4B | D:\PI\xiaogui-hub-h1-4b-receipt-api-v1 / codex/taskhub-h1-4b-receipt-api-v1 | 功能 770c0a781f22a527eddd8a1c2aeb7caff09dced0；记录 540045b | H1-4C 必须保留其签名回执、双鉴权和节点序列语义。 |
| Hub C2 阶段线 | D:\PI\xiaoguishequ / codex/hub-c2-artifact-chain-v1 | 48e3cf515a94488a92aacb284c29383c577bc8f5 | C3 Demand Outbox、社区 Web 和制品链的候选来源。 |
| WORK 候选 | D:\CodexWorktrees\xiaogui-next-phase-integration-v1 / agent/next-phase-prompt-office-v1 | 8c8728c7ba1d077b8a9fc5504420c9549c8d6124 | 是 CODING 候选的祖先；仍不是 H1-4C 的必须依赖。 |
| CODING 候选 | D:\CodexWorktrees\xiaogui-coding-work-integration-v1 / codex/coding-work-integration-v1 | 52432efc1b9b11b1df313e22f69571193f28a929 | 包含 WORK 候选成果；仍不是 H1-4C 的必须依赖。 |

桌面 H1、WORK、CODING 都可追溯到 agent/stage-integration-v1@0d2deece4c35851363b918313cb27d2848207c73。WORK@8c8728c 是 CODING@52432ef 的祖先；它们不是三条完全独立、互不相交的支线。H1 仍与其在共享入口、共享 IPC/状态文件上分叉，因此本阶段不吸收 WORK/CODING，避免扩大整合范围。

Hub H1-4B 与 C2 的共同祖先是 1fe28cc0cb336916440fc597d51cb44a9c44cefe；770c0a7 不是 48e3cf5 的祖先，反之亦然。C2 的 48e3cf5 也不含 H1-4B 的签名回执 API。

## 2. 选定的后续工作树与吸收顺序

1. 本审计分支：agent/taskhub-h1-4c-c3-audit-v1，从桌面 249bab7 建立，只存审计/合同/夹具记录。
2. 阶段 B 的桌面分支应从本审计获批提交建立；不合入 WORK 或 CODING。它只消费既有本机 TaskHub Delivery/Evidence 和 H1-LAN Worker 接缝。
3. Hub 必须先建立新的、单独的 H1-4C/C3 集成分支：以 C2 48e3cf5 为社区/网页来源，受控吸收 H1-4B 功能 770c0a7，再开始结果后端。540045b 仅为 H1-LAN 记录，可在整合后重新登记，不是功能依赖。
4. WORK/CODING 保持独立候选。只有以后获得专门的阶段集成授权时，才处理它们与 H1 的共享文件冲突。

## 3. Hub 整合冲突与迁移顺序

对 git merge-tree 1fe28cc 770c0a7 48e3cf5 的只读审计显示，下列文件需要人工语义整合，禁止使用整文件 ours/theirs：

- openapi/community-v1.yaml、docs/后端对接说明.md：C2 制品/社区与 H1 Worker 路由、版本说明必须同时保留；C3 路径只能在 H1-4C/C3 合同落地后加入。
- packages/server/src/app.ts、packages/server/src/db/schema.ts、packages/server/package.json、packages/server/src/routes/artifacts-v2.ts：保留 C2 Registry/制品行为和 H1 账号、节点、任务、回执行为，且 artifact_receipt 与 task_delivery_receipt 永远分表。
- packages/server/drizzle/bootstrap-current.sql、drizzle/meta/0016_snapshot.json、drizzle/meta/_journal.json、migration.test.ts：两线都占用 0016，不能直接拼接。
- contracts.test.ts 与测试脚本：同时保留 C2 合同与 H1 鉴权/回执断言，新增 C3/H1-4C 测试不能删旧覆盖。

目标数据库迁移顺序必须先在实现分支确认部署历史：

1. 以已部署的 C2 48e3cf5 迁移序列为目标基线时，保留它已有的 0016，将 H1 身份/节点、任务分配和回执 DDL 重新生成到后续连续编号；不得把 H1 原 0016 直接套到 C2 数据库。
2. 统一最终 schema 后重新生成 Drizzle snapshot、journal 和 bootstrap-current.sql，并补迁移测试：C2 旧库升级、H1 旧库升级（如仍需支持）、全新库初始化。
3. 只有迁移与 OpenAPI 语义整合通过，才可追加 H1-4C task_result、C3 intake/mapping/projection 表。不得先写业务路由再补迁移。

## 4. 本次修订后冻结的边界

- H1-4C 的终态结果通过原子结果提交进入既有 TaskHub Delivery/Evidence，不建立第二套执行状态机；artifact_receipt 不复用。
- H1 结果摘要、13 字段签名 receipt、12 项签名数组、三种终态、结果幂等 ACK、双时间线、受控发布者结果详情、分页/排序、路径和错误信封均在机器合同中明确。
- C2 的十项顶层错误码闭集保持有效。细分语义只写入 messageKey，每个失败夹具都有 messageKey 与 traceId。
- DemandIntakeReceiptV1 不被静默扩展；demandId、intakeId、taskId 映射为独立的 DemandTaskMappingV1。
- Intake 的幂等键严格保持 (demandId, demandVersion)；规范化内容摘要只是同键一致性校验，绝不升格为三元组键。
- C3 Outbox→TaskHub Intake 与 TaskHub→C3 投影写入各有调用主体、认证头、五次超时/重试/死信、同键同内容/异内容、projection 幂等/版本冲突及存储接缝；社区网页仍只有只读 GET。

## 5. 聚焦合同验证与文档阶段豁免

本阶段没有产品实现，故不运行 Electron、构建、类型检查、全量测试或真实网络旅程；这些检查不能证明纯文档中的协议语义，也会越过“只读审计”范围。该豁免仅适用于阶段 A，不传递给 H1-4C/C3 实现阶段。

代替 JSON 语法检查，本分支必须运行以下聚焦验证：

~~~powershell
node doc/validate-h1-4c-c3-contract-fixtures.mjs
git diff --check
~~~

验证器以 Node 内置能力直接读取 OpenAPI 机器合同，检查：所有路径/方法/双鉴权或集成鉴权、严格 DTO、C2 错误码闭集、完整 messageKey/traceId、结果有序摘要、真实 Ed25519 fixture 签名与公钥派生 keyId、三种终态、结果幂等 ACK、两页 cursor 链、发布者结果详情、Demand 同键与未知字段、五次重试入死信、投影摘要与版本冲突。它还断言错误路由、匿名成功、非法 timeline 事件、缺失 ACK 字段、断裂引用和 cursor 跳跃必须失败。它不需要安装依赖，也不是对真实 Hub 联调的替代。

## 6. 前端包与验收门

当前没有派发、提交或声称完成任何 Renderer/Web 产品代码。阶段 A 重新验收通过后，才按两个工作树、两个仓库拆分：

1. 桌面 H1-4C Renderer：只消费 Worker timeline DTO 和固定夹具，不改主进程、持久化、状态机或 Hub。
2. Hub C3 网页投影：只消费只读 projection DTO 和固定夹具，不改 Intake、投影 Writer、数据库或 TaskHub。

之后仍须由总控审查固定前端提交，并通过真实后端链路验收；夹具展示不等于联调成功。

## 7. 阶段 A 重新验收门

审查需确认：基线关系准确；Hub 合并冲突没有被隐瞒；迁移顺序不复用冲突编号；OpenAPI 是唯一机器合同源且其严格 schema 覆盖 Result、Timeline、Mapping、Projection Writer；结果、送达、Intake、映射与投影的边界清楚；C2 artifact_receipt 未被复用；夹具不含路径、凭据、私钥或真实任务内容；并且上述聚焦验证实际通过。

批准前不得开始阶段 B、C、D 产品实现或派发前端代码任务。
