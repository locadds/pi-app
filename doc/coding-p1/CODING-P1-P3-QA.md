# CODING-P1 P3 聚焦 QA 记录

## 验收对象

- 基线：`85142791d70f2486241bd644baa7cae58dc88208`。
- 目标：验证角色执行门、研究/审阅硬只读、Pi 会话与工作树联合检查点、恢复确认、真实 Diff/验证和最终人工交付门。
- 非目标：生产模型效果、全量测试、Portable、阶段线合并、WORK 功能。

## QA 矩阵

| 场景 | 预期 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|
| 未绑定角色批准计划 | 不改变计划生命周期，不调用 Runtime，明确提示先绑定实现角色 | A 首次点击批准被拒绝并保持等待批准 | `attempt-ipc.test.ts`、`execution-orchestrator.test.ts`、`02a-role-required.png` | 通过 |
| 非实现角色执行 | 研究/审阅角色不能进入写执行 | IPC 和 Orchestrator 都只接受冻结的 `IMPLEMENT` 快照 | `attempt-ipc.test.ts`、`execution-orchestrator.test.ts` | 通过 |
| 研究角色只读 | 即使用户配置加入写工具，也只能读取 | Worker 有效工具集剔除写入、命令和未知工具 | `role-runtime-binding.test.ts`、`role-guard-extension.test.ts` | 通过 |
| 审阅角色只读 | 审阅不能修改工作树或运行命令 | Worker 使用相同硬只读上限，非法工具失败关闭 | `role-runtime-binding.test.ts`、`role-guard-extension.test.ts` | 通过 |
| 未绑定 Worker | 未绑定不能继承全部 Pi 工具 | 仅 `read` 可用，其他工具返回 `XIAOGUI_CODING_ROLE_BINDING_REQUIRED` | Worker 聚焦测试 | 通过 |
| Worker 角色切换 | 已绑定 Worker 不能直接覆盖；新 Attempt 必须显式释放旧绑定 | 不释放时返回 `XIAOGUI_CODING_ROLE_RUNTIME_ALREADY_BOUND`；Main 用原 Attempt 编号释放后才预检和绑定下一项 | `role-runtime-binding.test.ts`、`role-production-composition.test.ts` | 通过 |
| 三个 Attempt 固定角色 | A/B/C 各自绑定不可变实现快照后才允许执行 | 角色数据库存在三条默认实现绑定，均含 `sha256:` 摘要和绑定时间 | E2E 数据库断言、`02a-role-bound.png`、`journey-rows.json` | 通过 |
| 生产 session 登记 | Renderer 手工计划或兜底计划不依赖 Pi 计划工具 seed | E2E 删除私有 seed 后仍能通过可信 session 打开路径完成角色与检查点操作 | `ipc/handlers/session.ts`、E2E 旅程 | 通过 |
| 创建联合检查点 | 同时保存 Pi 会话与 Attempt 工作树，公开结果不含私有路径 | 检查点卡生成一条不透明检查点，公开只见影响摘要 | 检查点模块测试、`02a-role-bound.png` | 通过 |
| 恢复影响预览 | 恢复前显示文件影响和对话回退，并要求人工确认 | 预览显示将影响 1 个相对文件；确认按钮在勾选前禁用 | `02b-checkpoint-restore-preview.png`、Renderer 测试 | 通过 |
| 确认后恢复 | 只有有效令牌、摘要一致和人工确认时执行；恢复后验证失效 | 勾选确认后进入已恢复状态，之后仍重新执行和验证 | `02c-checkpoint-restored.png`、检查点 Saga 测试 | 通过 |
| 恢复异常失败关闭 | 过期、漂移、工作树忙碌或结果未知时不重复派发 | 对应回归进入固定错误或 `OUTCOME_UNKNOWN`，不猜测成功 | checkpoint module/production/authority 测试 | 通过 |
| A/B 并行，C 依赖 A | A/B 并行；C 只读取 A 的验证基线，不读取 B | Runtime 事件显示两个 root-wave；C 基线含 `src/a.ts` 且确认 `src/b.ts` 缺失 | `journey-events.jsonl`、`03-ab-running-c-waiting.png` | 通过 |
| 真实 Diff 与验证 | Diff 来自工作树，验证来自真实退出码 | 展开区显示 `src/a.ts` 真实补丁及两条退出码 `0` | `04-real-diff-and-verification.png` | 通过 |
| 最终人工交付门 | 用户批准前不写项目；批准后按依赖顺序应用且幂等 | `05` 保持待交付；显式批准后 `06` 成功，重复批准项目指纹不变 | `05-three-task-delivery-pending.png`、`06-apply-succeeded.png`、`journey-rows.json` | 通过 |
| 路径和私密信息 | Renderer、公开 IPC 和证据不含绝对路径、session 文件或提示正文 | 公开证据只含相对文件、不透明编号和摘要；私有路径仅在 Main SQLite | IPC/契约测试、结构化证据检查 | 通过 |

## 执行记录

### P3 原聚焦测试

结果：`28` 个测试文件、`220/220` 通过。覆盖检查点恢复 Saga、会话登记、角色配置、Worker 会话隔离、TaskHub 状态转换和 Renderer 卡片。

### 首轮审查阻断修复测试

```powershell
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/worker/xiaogui-coding-extensions/role-runtime-binding.test.ts src/worker/xiaogui-coding-extensions/role-guard-extension.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx src/renderer/src/xiaogui/lib/coding-attempt-client.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts
```

结果：`9` 个测试文件、`80/80` 通过。

角色槽严格释放修复另补跑 `role-runtime-binding`、`role-production-composition`、`worker-manager-coding-role`、`role-ipc`：`4` 个测试文件、`13/13` 通过。

### 类型检查与构建

```powershell
npm run typecheck
npm run build
```

结果：两条命令退出码均为 `0`。构建只有既有动态导入、大 chunk 和 Office Viewer 构建耗时提示。

### Electron 可见旅程

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：`1/1` 通过，耗时 `56.0s`。证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788233094138`。

| 证据 | 说明 |
|---|---|
| `01-batch-confirm.png` | 本批任务与文件范围确认 |
| `02-attempt-plans-awaiting-approval.png` | A/B 计划等待人工批准 |
| `02a-role-required.png` | 未绑定实现角色时拒绝批准和执行 |
| `02a-role-bound.png` | 显式绑定实现角色并可创建检查点 |
| `02b-checkpoint-restore-preview.png` | 恢复影响及人工确认门 |
| `02c-checkpoint-restored.png` | 联合恢复完成 |
| `03-ab-running-c-waiting.png` | A/B 并行，C 等待依赖 |
| `04-real-diff-and-verification.png` | 真实 Diff 与验证退出状态 |
| `05-three-task-delivery-pending.png` | 三任务完成但仍等待交付批准 |
| `06-apply-succeeded.png` | 人工批准后的受控、幂等应用 |
| `journey-events.jsonl` | Runtime 顺序、并发与派生基线检查 |
| `journey-rows.json` | Attempt、角色摘要、验证、交付和应用总账 |

## 结论与边界

P3 已取得角色门、检查点恢复、真实 Diff/验证和人工交付的聚焦测试与真实 Electron 证据。研究/审阅角色的硬只读上限由 Worker 聚焦测试证明，桌面旅程没有在 Attempt 运行中静默切换角色。固定差异代码审查 `PASS`、规格审查 `APPROVE`。

本旅程使用受控 **Scripted Runtime**，不代表生产 Kimi/Codex 的推理质量、代码质量或长期稳定性；未运行全量测试、制作 Portable、合并阶段线或发布。
