# CODING-P1 P2 修复审查记录

## 审查范围

- 固定起点：`e992483`（`feat(coding): add attempt plan and real review gate`）。
- 审查对象：该提交之后、进入 P3 前的 P2 修复工作树差异。
- 范围仅包括 Attempt 计划门、派发失败恢复、公开 IPC 错误收敛和真实 Diff 的桌面验收覆盖；不包含 P3 检查点或角色配置。
- 架构边界保持不变：Pi 提交计划草稿，TaskHub 是 Attempt、计划状态、工作树、验证和交付的唯一权威，Renderer 只提交版本化用户意图。

## 原审查发现与处置

| 原发现 | 风险 | 当前处置 | 直接证据 | 结论 |
|---|---|---|---|---|
| Runtime 派发失败后计划停在 `EXECUTING` | Attempt 已回到可重试状态，但计划卡拒绝“继续执行”，重启后仍卡死 | 派发未进入 `STARTING/RUNNING` 时，将同一计划退回 `APPROVED`；若回退本身失败则进入结果未知并失败关闭 | `execution-orchestrator.ts`、`attempt-plan-module.ts`；真实计划模块 + Orchestrator 的失败、重启、单次重试回归 | 已修复 |
| 批准响应丢失后重放相同请求不幂等 | 相同 revision/digest 的重放会被错误判为版本冲突 | 计划 revision/digest 仅标识用户审阅过的正文；`APPROVED`、`EXECUTING` 等生命周期迁移不再伪造正文版本 | `attempt-plan-module.ts`；批准重放与生命周期版本回归 | 已修复 |
| Runtime/TaskHub 异常可能沿 IPC 泄漏路径或内部执行细节 | Renderer 或日志可能得到私有工作区信息 | `RESUME` 捕获底层异常，只返回稳定错误码与重新读取的权威计划投影，不转发异常正文 | `attempt-ipc.ts`；包含私有路径的抛错回归 | 已修复 |
| Electron 旅程只看到 Diff 卡片，未证明用户展开真实 Diff | 桌面证据不能证明具体补丁正文可见 | 旅程增加“查看 Diff”操作，并断言真实工作树内容 `A-verified` 或 `B-verified` 出现在展开区 | `e2e/xiaogui-real-three-task-journey.spec.ts`；`04-real-diff-and-verification.png` | 已补强 |

## 行为复核

1. 未批准计划保持 `READY`，Runtime 派发次数为零；用户批准精确 revision/digest 后才进入执行。
2. 派发失败且权威 Attempt 未进入运行态时，计划恢复为原来的 `APPROVED`，正文 revision/digest 不变；模块关闭并重新打开后仍可继续执行。
3. 若 Agent 已报告 `STARTING` 或 `RUNNING`，系统不把它伪装成“未派发”，而是保持结果未知路径，避免重复执行。
4. 同一批准请求可在丢失响应后安全重放，不产生新计划版本，也不重复派发。
5. IPC 失败结果只含稳定的 `EXECUTION_RESUME_FAILED` 和可重试投影；底层异常中的绝对路径不进入公开结果。
6. Diff 来自真实 Attempt 工作树，并在桌面旅程中由用户展开；验证状态来自真实制品和退出码，不采信模型自述。

## 聚焦验证

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts
npm run typecheck
npm run build
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

- 聚焦测试：`3` 个文件、`36/36` 通过。
- 类型检查：退出码 `0`。
- 构建：退出码 `0`。
- Electron：`1/1` 通过，约 `46s`。
- 桌面证据：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788178580071`。

## 审查结论

四项阻断发现均已有对应实现与回归证据，P2 修复可进入最终干净检出门。该结论不覆盖 P3，也不等同于正式发布批准。

本次 Electron 旅程使用受控 **Scripted Runtime**，它能证明计划门、并发/依赖、工作树 Diff、验证证据和人工交付门的系统接缝，但**不是生产模型推理质量、代码质量或真实外部 Agent 稳定性的证据**。

## 剩余限制

- P3 的 Pi 会话检查点、工作树恢复预览、角色配置和只读硬上限仍需独立验收。
- 本阶段没有运行全量测试、制作 Portable、合并阶段线或发布。
- P2 最终状态仍应以固定提交的干净检出复跑结果为准，避免把同一工作树中的后续 P3 文件计入结论。
