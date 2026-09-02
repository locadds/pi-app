# CODING-P1 P2 聚焦 QA 记录

## 验收对象

- 基线：`e992483` 之后的 P2 阻断修复。
- 目标：验证计划修改/批准、派发恢复、真实 Diff/验证以及最终人工交付门。
- 非目标：P3 检查点和角色配置、完整上游测试、Portable、生产模型效果评测。

## QA 矩阵

| 场景 | 预期 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|
| 修改并批准计划 | 修改目标、步骤或验证方法产生新正文版本；只有批准精确 revision/digest 后可执行 | 修改撤销旧批准资格；批准后进入可执行状态 | `attempt-plan-module.test.ts`、Electron 计划卡截图 | 通过 |
| 未批准时零派发 | Attempt 保持 `READY`，Runtime 不收到 dispatch | A/B 计划卡出现前无 Runtime 启动；单元回归断言零派发 | `execution-orchestrator.test.ts`、`02-attempt-plans-awaiting-approval.png` | 通过 |
| 派发失败后恢复 | 未进入运行态的失败退回同一 `APPROVED` 计划；重启后可继续且只派发一次 | 真实计划模块关闭重开后保留相同投影，下一次恢复进入 `RUNNING`，成功 dispatch 仅一次 | `execution-orchestrator.test.ts` | 通过 |
| 派发结果无法对账 | dispatch 失败且权威 Attempt 不可读时不得退回可重试状态 | Saga 进入 `OUTCOME_UNKNOWN`，计划保持 `EXECUTING`，再次恢复不产生第二次 dispatch | `execution-orchestrator.test.ts` | 通过 |
| 计划回滚失败 | 已知 `READY` 但计划无法原子退回时不得继续重试 | Saga 进入 `OUTCOME_UNKNOWN`，rollback 只调用一次，后续恢复不重复 dispatch | `execution-orchestrator.test.ts` | 通过 |
| 批准请求重放 | 丢失响应后用同一 revision/digest 重放，返回相同结果且不产生正文新版本 | 首次批准与重放结果完全一致 | `attempt-plan-module.test.ts` | 通过 |
| A/B 并行，C 依赖 A | A、B 同一波并行；C 只在 A 验证后执行，并看到 A、不看到无关 B | 两个 root-wave 运行事件后分别成功；C 的依赖基线检查包含 `src/a.ts` 且确认 `src/b.ts` 缺失 | `journey-events.jsonl`、`03-ab-running-c-waiting.png` | 通过 |
| 展开真实 Diff | 用户点击“查看 Diff”后看到工作树中的真实补丁正文 | E2E 展开 Diff 并断言 `A-verified` 或 `B-verified` 可见 | `e2e/xiaogui-real-three-task-journey.spec.ts`、`04-real-diff-and-verification.png` | 通过 |
| 两条验证退出码为 0 | 审阅卡显示来自真实验证制品的两条成功退出状态 | Electron 旅程断言两条退出码 `0`，审阅状态为通过 | `04-real-diff-and-verification.png` | 通过 |
| 最终人工门禁 | 三项任务完成后只形成待交付；用户批准前不写用户项目 | 旅程在 `05` 保持待交付，随后显式批准才进入 `06` 应用成功；重复批准保持幂等 | `05-three-task-delivery-pending.png`、`06-apply-succeeded.png`、`journey-rows.json` | 通过 |
| 相对路径与安全错误 | Renderer 只见相对路径；IPC 异常不泄漏绝对路径和底层正文 | Manifest 仅含 `src/a.ts`、`src/b.ts`、`src/c.ts`；私有路径抛错只返回稳定错误码和权威投影 | `attempt-ipc.test.ts`、`journey-rows.json` | 通过 |

## 执行记录

### 聚焦模块测试

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-plan-module.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts
```

结果：`3` 个测试文件、`38/38` 通过。

### 类型检查与构建

```powershell
npm run typecheck
npm run build
```

结果：两条命令退出码均为 `0`。

### Electron 可见旅程

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：`1/1` 通过，耗时约 `46s`。

证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788181671956`

| 证据 | 说明 |
|---|---|
| `01-batch-confirm.png` | 本批任务与范围确认 |
| `02-attempt-plans-awaiting-approval.png` | A/B 计划等待人工批准 |
| `03-ab-running-c-waiting.png` | A/B 并行、C 等待依赖 |
| `04-real-diff-and-verification.png` | 展开的真实 Diff 与验证结果 |
| `05-three-task-delivery-pending.png` | 三任务完成但仍等待最终人工交付批准 |
| `06-apply-succeeded.png` | 人工批准后的受控应用结果 |
| `journey-events.jsonl` | Runtime 顺序、并发屏障和 C 的依赖基线检查 |
| `journey-rows.json` | Task/Attempt/验证/交付/应用持久化总账 |

## 结论与边界

P2 的计划门、失败恢复、幂等批准、真实 Diff、验证证据和最终人工门禁已取得聚焦测试与真实 Electron 证据。下一道门是从固定 P2 提交进行干净检出复跑并由审查 Agent 确认；在此之前不把当前工作树中的 P3 内容计入 P2。

本旅程使用受控 **Scripted Runtime**。它只证明多接缝状态流与桌面交互，不证明生产模型能生成高质量计划、代码或审查意见，也不证明外部 Agent 的长期稳定性。
