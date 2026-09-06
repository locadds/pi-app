# TASKHUB-H1-4C J1 最小整改交接

状态：桌面代码候选，待固定 SHA 的独立只读复验；未启动两机复验。

## 1. 固定范围

本包只修复首次两机 J1 暴露的两个桌面缺口：checkout filter 等价文件的原始字节差异，以及本机权威终态未可靠收敛到 Hub。Hub 与机器合同保持只读，不修改产品状态机、Renderer/Web、C3 或 Apply。

| 对象 | 固定值 |
| --- | --- |
| 桌面基线 | `cc29acf5d2f19f228a54562372d1430c2cce273f` |
| 合同 | `98650e0545f8bfaf19055a5748aecd06c041267e` |
| Hub | `b5bfeb77aa60adf1a88b19bb249ebd912b9bb5ee` |
| 分支 | `agent/taskhub-h1-4c-j1-remediation-v1` |
| 工作树 | `D:\CodexWorktrees\xiaogui-desktop-h1-4c-j1-remediation-v1` |

## 2. R0 结论

乙机探针以 `GIT_OPTIONAL_LOCKS=0` 只读运行，结果为 `CHECKOUT_FILTER_EQUIVALENT`、`R0_EXIT=0`。原项目与 Attempt 的 HEAD/tree/filtered object 相同且均 clean；`src/result.js` 在原项目为 41 字节 LF，在 Attempt 为 42 字节 CRLF，系统 `core.autocrlf=true`。因此准入条件满足，整改保留摘要护栏并针对 checkout filter 等价输入做精确字节修复。

R0 证据：`D:\CodexTemp\xiaogui-h1-4c-j1-remediation\evidence\r0-digest-probe.json`。该路径属于乙机验收现场，不纳入源码提交。

## 3. 实现摘要

### 3.1 跨 checkout 精确字节

- 只从权威 clean 原项目 checkout 读取批准范围内的 `MODIFY` 文件原始字节。
- Git 创建 Attempt/Delivery 工作树后，把权威字节原样播种到相同相对路径；不做换行转换。
- 对文件类型、链接数、HEAD/tree、摘要、批准路径和 Git clean 状态实行 fail-closed 检查。
- 只刷新批准路径的工作树 index，使 Git 按自身 filter 语义确认 clean；不放宽摘要、不允许额外文件。
- 补丁捕获再次比较权威 checkout 原始字节；Apply 实现没有改动。

### 3.2 Hub 执行生命周期收敛

- `HubExecutionLifecycleCoordinatorV1` 是唯一串行、幂等、可等待的 Main 进程协调入口。
- 入口覆盖：启动/批量启动返回、Runtime/验证/中断/取消权威回调、Delivery 创建、桌面启动恢复。
- 顺序固定为 `EXECUTION_STARTED` → 终态 Delivery → 必要时由执行投影形成失败/未知终态。
- 判定仅限当前 assignment 绑定 flow 与本次 taskRun/Attempt；多目标或歧义证据 fail closed。
- 终态优先级为 Delivery、`OUTCOME_UNKNOWN`、`EXECUTION_FAILED`；全部成功但没有 Delivery 时继续等待。
- `EXECUTION_FAILED` 与 `OUTCOME_UNKNOWN` 使用冻结的短摘要、验证 verdict/summary 与空制品引用，不泄漏路径、提示词、输出或会话。

## 4. 修改清单

- `src/main/xiaogui/task-hub/attempt-workspace.ts`
- `src/main/xiaogui/task-hub/attempt-workspace.test.ts`
- `src/main/xiaogui/task-hub/delivery-integration-worktree.ts`
- `src/main/xiaogui/task-hub/delivery-integration-worktree.test.ts`
- `src/main/xiaogui/task-hub/hub-execution-lifecycle.ts`
- `src/main/xiaogui/task-hub/hub-execution-lifecycle.test.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.ts`
- `src/main/xiaogui/task-hub/execution-orchestrator.test.ts`
- `src/main/xiaogui/task-hub/ipc.ts`
- `src/main/xiaogui/task-hub/ipc.test.ts`
- `src/main/xiaogui/task-hub/delivery-ipc.ts`
- `src/main/xiaogui/task-hub/delivery-ipc.test.ts`
- `src/main/xiaogui/hub-task/task-result-projection.ts`
- `src/main/xiaogui/hub-task/task-result-projection.test.ts`
- `src/main/xiaogui/hub-task/worker-service.ts`
- `src/main/xiaogui/hub-task/worker-service.test.ts`
- `src/main/xiaogui/hub-task/worker-ipc.test.ts`
- `DEVELOPMENT_STATUS.md`
- `doc/TASKHUB-H1-4C-J1-REMEDIATION-HANDOFF.md`

## 5. 验证证据

| 命令/检查 | 结果 |
| --- | --- |
| 9 个相关 Vitest 文件 | `9 passed / 96 tests passed` |
| 本次变更 TypeScript 聚焦 ESLint | 通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；Main/Preload/Renderer 均产出 |
| `git diff --check` | 通过 |

构建前在本独立工作树执行了锁文件驱动的 `npm ci`；共安装 1029 个依赖包，Electron 原生重建与项目 postinstall 成功。未修改依赖声明或锁文件，也没有借用其他工作树的 `node_modules` 作为最终构建证据。

## 6. 复审与下一步

复审应以本分支固定提交为对象，检查：

1. checkout-filter 等价场景不再触发假漂移，但非等价字节仍被拒绝；
2. 生命周期入口是否单一、串行、可等待，且覆盖异步权威终态和启动恢复；
3. `EXECUTION_STARTED` 先于终态，Delivery/UNKNOWN/FAILED 优先级及绑定范围准确；
4. 失败/未知信封满足合同且不泄漏本机信息；
5. 没有 C3、前端、Apply、Hub 或合同越界修改。

人工两机 QA：**NOT RUN**。只有固定提交复审 `APPROVE` 且用户明确再授权后，才能在全新隔离现场使用新数据库、新 `userData`、新证据目录、新任务和新 `runId` 重跑 J1；旧 `D:\CodexTemp\xiaogui-h1-4c-lan\` 继续只读保留。

本交接不授权 C3、Renderer/Web 前端、Apply、正式主线合并或发布。
