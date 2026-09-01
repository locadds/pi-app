# CODING-P1 P3 生产接缝审查记录

## 审查范围

- P3 原始固定基线：`85142791d70f2486241bd644baa7cae58dc88208`。
- 本次最终收口增量起点：`06c410bf462562da7859116f787c2749c5bfd5e6`。
- 审查对象：Pi 会话检查点、Attempt 工作树联合恢复、三类角色配置、Runtime 角色绑定、只读验证和三角色 Electron 旅程。
- 非目标：生产模型生成质量、全量测试、Portable、阶段线合并和 WORK 功能。
- 权威边界：TaskHub 继续独占 Attempt、工作树、执行、验证、交付和结果未知状态；Pi/Runtime 执行角色硬限制，Renderer 只提交版本化人工决定。

## 最终阻断项与处置

| 发现 | 风险 | 处置 | 证据 | 结论 |
|---|---|---|---|---|
| 原派发门只允许 `IMPLEMENT` | 研究和审阅只能配置，不能完成规格要求的真实角色旅程 | Runtime 请求增加不可变角色投影；任一已绑定角色可进入派发，研究/审阅被硬限制为 `read` | 共享契约、`runtime-composition.ts`、E2E | 已修复 |
| Kimi Adapter 默认总是开放写能力 | 研究/审阅可能越过角色语义申请写入 | 对只读角色关闭 `writeTextFile`，拒绝写权限/写调用，只从模型文本事件形成只读候选证据 | `kimi-adapter.ts` 及测试 | 已修复 |
| 只读成功但工作树无改动时验证失败 | 研究/审阅无法成为有证据的依赖节点 | 只对已绑定 `RESEARCH/REVIEW` 开启显式无变更捕获；若出现任何文件改动立即失败关闭 | `task-verification-coordinator.ts`、`attempt-workspace.ts` 及测试 | 已修复 |
| 两个只读 Attempt 生成相同空补丁编号 | 第二个只读任务被不可变制品表拒绝并降级为结果未知 | 空补丁内容摘要保持内容寻址，制品编号额外绑定 Attempt；普通非空补丁规则不变 | 红/绿回归、真实 E2E | 已修复 |
| 原 Electron 旅程三个任务均为实现角色 | 无法证明 P3 的研究/审阅生产接缝 | 改为 A 研究、B 实现、C 审阅；分别绑定不可变角色并断言运行时角色、只读变更、依赖和交付 | `journey-events.jsonl`、`journey-rows.json` | 已补强 |
| 临时失败诊断会读取私有 SQLite 详情写入测试异常 | CI 失败日志可能扩大私有路径暴露 | 收口前移除数据库 dump，仅保留公开 Attempt 状态 | E2E 差异 | 已修复 |

## 行为复核

1. 未绑定角色时，批准/继续执行会失败关闭；TaskHub 不调用 Runtime。
2. Attempt 绑定保存 profile、模型选择、运行时策略、有效工具白名单和摘要快照；执行中不能静默更换。
3. 研究和审阅角色可以执行只读 Agent 回合并形成可验证证据，但有效工具固定为 `['read']`，任何文件变更都会使验证失败。
4. 实现角色仍受计划批准、TaskHub 权限、Attempt 工作树和交付人工门控制。
5. 只读 Attempt 通过显式空补丁 ChangeSet 进入依赖总账；它不伪造文件变更，最终交付只写实际变化的文件。
6. 空补丁制品编号按 Attempt 隔离，避免多个只读任务冲突；内容摘要仍由规范化空补丁字节计算。
7. 检查点同时绑定 Pi 会话和 Attempt 工作树；恢复前必须显示影响并人工确认，无法证明时进入失败或 `OUTCOME_UNKNOWN`。
8. 真实旅程中 B 从 A 已验证基线开始，C 从 B 已验证基线开始；最终三个 ChangeSet 按依赖顺序组合。
9. 会话文件、工作树和快照绝对路径只留在 Main 私有存储；公开 IPC、Renderer 和事件只含不透明地址、相对路径与摘要。

## 聚焦验证

```powershell
node_modules\.bin\vitest.cmd run packages/shared/xiaogui-agent-runtime.test.ts src/main/xiaogui/agent-runtime/kimi-adapter.test.ts src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/attempt-workspace.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/main/xiaogui/task-hub/task-verification-coordinator.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx --reporter=default
npm run typecheck
npm run build
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
git diff --check
```

- 最终聚焦组：`7` 个文件、`74/74` 通过。
- 类型检查、构建和差异检查：通过；仅保留既有构建提示。
- Electron：`1/1` 通过，约 `1.0m`；证据目录 `D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788237824316`。
- 既有 P3 广覆盖证据继续有效：`28/220`、`9/80`、`4/13` 均通过。

## 审查结论与剩余边界

P3 的角色配置、生产派发、硬只读、检查点恢复、真实验证和统一交付现已形成完整闭环。当前固定差异没有已知 P3 阻断项，可以作为独立 CODING 分支的阶段候选提交并等待人工验收。

剩余边界不是本阶段缺口：

- Scripted Runtime 证明契约和状态流，不证明生产 Kimi/Codex 的生成质量、登录状态或长期稳定性。
- 每个执行尝试仍固定一个角色和 Runtime，不支持执行中静默切换。
- 未运行全量测试、制作 Portable、合并阶段线或发布。
