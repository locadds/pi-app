# CODING-P1 P3 聚焦 QA 记录

## 验收对象

- P3 原始固定基线：`85142791d70f2486241bd644baa7cae58dc88208`。
- 本次最终收口增量起点：`06c410bf462562da7859116f787c2749c5bfd5e6`。
- 当前分支：`agent/coding-p1-pi-extension-pack-v1`。
- 目标：验证研究、实现、审阅三类角色的生产接缝，Pi 会话与 Attempt 工作树联合检查点，恢复确认，真实 Diff/验证和最终人工交付门。
- 非目标：生产模型生成质量、全量测试、Portable、阶段线合并和 WORK 功能。

## QA 矩阵

| 场景 | 预期 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|
| 未绑定角色批准计划 | 不改变计划生命周期，不调用 Runtime，明确提示先绑定角色 | 研究任务首次点击批准被拒绝并保持等待批准 | `attempt-ipc.test.ts`、`02a-role-required.png` | 通过 |
| Attempt 固定角色 | 绑定后保存不可变角色摘要，执行中不能静默换角色 | A/B/C 分别绑定研究/实现/审阅，数据库保存三条 `sha256:` 快照摘要 | E2E 数据库断言、`journey-rows.json` | 通过 |
| 研究角色执行 | 可以形成只读研究证据，但不能修改工作树或请求写权限 | Runtime 收到 `RESEARCH + ['read']`，成功后变更文件为空 | `kimi-adapter.test.ts`、`journey-events.jsonl` | 通过 |
| 实现角色执行 | 仅在人工批准后进入独立工作树写入并验证 | B 创建 `src/b.ts`，真实验证通过 | `journey-events.jsonl`、`04-real-diff-and-verification.png` | 通过 |
| 审阅角色执行 | 可以读取前序验证成果并形成审阅证据，但不能改动工作树 | C 读取 B 的派生基线，Runtime 收到 `REVIEW + ['read']`，变更文件为空 | `journey-events.jsonl` | 通过 |
| 只读角色无变更候选 | 无改动仍可进入权威验证和依赖链，不伪造文件修改 | A、C 均形成经过验证的空补丁 ChangeSet | `task-verification-coordinator.test.ts`、E2E 投影 | 通过 |
| 多个空补丁 | 两个只读 Attempt 不得因相同空补丁字节发生不可变制品编号冲突 | 内容摘要保持相同，制品编号按 Attempt 分离 | `attempt-workspace.test.ts` | 通过 |
| Worker 硬只读上限 | 用户配置不能给研究/审阅增加写、命令或未知工具 | Kimi ACP 写能力关闭，写权限请求失败关闭 | `kimi-adapter.test.ts`、既有 Worker 角色测试 | 通过 |
| 创建联合检查点 | 同时保存 Pi 会话和 Attempt 工作树，公开结果不含私有路径 | 实现任务创建检查点并只显示相对影响摘要 | `02a-role-bound.png` | 通过 |
| 恢复影响预览 | 恢复前显示影响并要求人工确认 | 预览显示相对文件影响，确认前恢复按钮不可用 | `02b-checkpoint-restore-preview.png` | 通过 |
| 确认后恢复 | 有效令牌、摘要一致且人工确认后才恢复 | 恢复成功后再执行实现、验证和交付 | `02c-checkpoint-restored.png` | 通过 |
| 依赖基线 | B 读取 A 的验证成果；C 读取 B 的验证成果 | 事件记录分别验证 `README.md` 和 `src/b.ts` 内容摘要 | `journey-events.jsonl` | 通过 |
| 真实 Diff 与验证 | Diff 来自工作树，验证来自真实命令退出码 | 只展示 B 的真实变更和通过结果；A/C 没有伪造文件 Diff | `04-real-diff-and-verification.png` | 通过 |
| 最终人工交付门 | 批准前不写用户项目；批准后按依赖顺序应用且幂等 | 三个 Task ChangeSet 进入统一交付，只有 `src/b.ts` 写入项目；重复批准不重复写入 | `05-three-task-delivery-pending.png`、`06-apply-succeeded.png` | 通过 |
| 路径和私密信息 | Renderer、公开事件和会话不含绝对路径、私有会话编号或提示正文 | E2E 公共表面断言通过；公开事件只含相对路径和摘要 | E2E 断言 | 通过 |

## 执行记录

### 既有 P3 门禁

- P3 原聚焦组：`28` 个测试文件、`220/220` 通过。
- 首轮审查修复组：`9` 个测试文件、`80/80` 通过。
- 角色槽严格释放组：`4` 个测试文件、`13/13` 通过。

### 三角色生产接缝最终聚焦组

```powershell
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-agent-runtime.test.ts src/main/xiaogui/agent-runtime/kimi-adapter.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/xiaogui/task-hub/task-verification-coordinator.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx --reporter=default
```

结果：`7` 个测试文件、`74/74` 通过。Renderer 保留既有 React `act(...)` 警告，无失败。

### 类型检查、构建与差异检查

```powershell
npm run typecheck
npm run build
git diff --check
```

结果：三项均通过，退出码 `0`。构建仅有既有动态导入、大 chunk 和 Office Viewer chunk 提示。

### 真实 Electron 三角色旅程

```powershell
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
```

结果：`1/1` 通过，耗时约 `1.0m`。证据目录：`D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788237824316`。

| 证据 | 说明 |
|---|---|
| `01-batch-confirm.png` | 研究任务范围确认 |
| `02-attempt-plans-awaiting-approval.png` | Attempt 计划等待人工批准 |
| `02a-role-required.png` | 未绑定角色时拒绝批准和执行 |
| `02a-role-bound.png` | 显式绑定角色并创建检查点 |
| `02b-checkpoint-restore-preview.png` | 恢复影响及人工确认门 |
| `02c-checkpoint-restored.png` | 联合恢复完成 |
| `03-research-running.png` | 研究角色只读执行，后继等待依赖 |
| `04-implementation-running.png` | 实现角色执行，审阅等待依赖 |
| `04-real-diff-and-verification.png` | 真实 Diff 与验证状态 |
| `05-three-task-delivery-pending.png` | 三任务完成但仍等待交付批准 |
| `06-apply-succeeded.png` | 人工批准后的受控、幂等应用 |
| `journey-events.jsonl` | 三种角色、依赖基线和变更文件总账 |
| `journey-rows.json` | Attempt、角色快照、验证、交付和应用总账 |

## 结论与边界

P3 规格要求的“研究 → 计划 → 实现 → 审阅 → 检查点恢复 → 交付”已由一条真实 Electron 旅程覆盖。研究和审阅不是仅在单元测试中存在：它们已通过生产 TaskHub/Runtime 接缝执行、形成只读证据并参与依赖与统一交付。

旅程使用受控 **Scripted Runtime** 验证接缝和状态流；Kimi Adapter 的只读行为由聚焦测试验证，但本记录不把它宣称为生产 Kimi/Codex 的推理质量或长期稳定性证据。未运行全量测试、制作 Portable、合并阶段线或发布。
