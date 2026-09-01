# CODING-P1 P3 生产接缝审查记录

## 审查范围

- 固定起点：`85142791d70f2486241bd644baa7cae58dc88208`。
- 审查对象：P3 的 Pi 会话检查点、Attempt 工作树联合恢复、三类角色配置、角色执行门以及联合 Electron 旅程。
- 非目标：生产 Kimi/Codex 生成质量、全量上游测试、Portable、阶段线合并、WORK 功能。
- 权威边界：TaskHub 继续独占 Attempt、工作树、执行、验证、交付和结果未知状态；Pi Worker 执行角色硬限制，Renderer 只提交版本化人工决定。

## 首轮审查发现与处置

| 首轮发现 | 风险 | 当前处置 | 直接证据 | 结论 |
|---|---|---|---|---|
| 角色卡只在 Renderer 出现，TaskHub 派发前不强制角色绑定 | 通过恢复或其他 IPC 路径可绕过界面，在没有角色或错误角色时开始执行 | 在权威 Orchestrator 的 `WORKSPACE_READY` 派发门增加 Attempt 角色检查；只有冻结的 `IMPLEMENT` 快照可进入 dispatch | `execution-orchestrator.ts`、`runtime-composition.ts` 及聚焦回归 | 已修复 |
| 计划批准/继续执行 IPC 未校验角色 | 用户可以先批准计划，再得到不一致的执行状态 | `APPROVE` 与 `RESUME` 均在修改计划或调用 Runtime 前读取权威角色绑定；缺失或非实现角色返回固定安全错误 `ROLE_BINDING_REQUIRED` | `attempt-ipc.ts`、`CodingAttemptPlanCard.tsx` 及测试 | 已修复 |
| Pi Worker 未绑定角色时保留全部工具 | TaskHub 门之外的 Worker 路径可能获得命令或写入能力 | 未绑定状态只公开 `read`，其他工具调用失败关闭；系统提示明确处于只读状态 | `role-runtime-binding.ts`、`role-guard-extension.ts` 及测试 | 已修复 |
| 私有 session 地址只在 Pi 计划工具路径登记 | Renderer 手工计划或兜底计划创建的 Attempt 无法使用角色/检查点；原 E2E 手工写注册表掩盖生产缺口 | 可信 session 打开/列举路径完成作用域解析后，在 Main 私有注册表登记不透明地址和私有 session 文件；E2E 已删除手工 seed | `ipc/handlers/session.ts`、`checkpoint-default-composition.ts`、联合旅程 | 已修复 |
| 原联合旅程只绑定 A，B/C 未证明角色门 | 桌面证据不能证明每个 Attempt 都固定角色 | 联合旅程先证明 A 在未绑定时被拒绝，再分别为 A/B/C 绑定默认实现角色；数据库断言三条不可变摘要，随后才允许 dispatch | `e2e/xiaogui-real-three-task-journey.spec.ts`、`02a-role-required.png`、`02a-role-bound.png`、`journey-rows.json` | 已补强 |
| Worker 角色槽允许直接从一个 Attempt 覆盖到另一个 | 同一 live Worker 的角色可在未释放时被静默替换 | Worker 只接受相同 Attempt+摘要；用户显式绑定另一 Attempt 时，Main 先以原 Attempt 编号执行 `release`，成功后才预检和绑定新快照 | `role-runtime-binding.ts`、`role-production-ports.ts` 及测试 | 已修复 |
| 缺少独立 P3 审查和 QA 交接材料 | 无法从阶段记录复核规格、证据和剩余限制 | 新增本记录与 `CODING-P1-P3-QA.md`，并同步 `DEVELOPMENT_STATUS.md` | 本文件、QA 记录、阶段状态 | 已补齐 |

## 行为复核

1. 未绑定角色时，计划可以保留为可审阅状态，但批准/继续执行会明确要求绑定“实现”角色；Runtime 派发次数保持为零。
2. 即使绕过 Renderer 直接恢复 Attempt，TaskHub Orchestrator 仍会在 dispatch 前读取同一权威角色库；缺失、读取失败或非 `IMPLEMENT` 均保持 `READY`。
3. Attempt 绑定保存 profile、模型选择、运行时策略、有效工具白名单和摘要快照。相同 Attempt 执行中不能静默更换快照；同一 Worker 切换到另一个 Attempt 必须由 Main 使用当前 Attempt 编号显式释放，失败则不检查或绑定新快照。
4. 研究和审阅角色的硬上限由 Worker 再次收紧为只读；用户编辑配置不能增加写入、命令或未知工具。
5. 检查点同时绑定 Pi 会话与 Attempt 工作树。恢复前必须显示影响文件和对话回退提示，用户勾选确认后才执行；摘要漂移、令牌过期或结果无法确认时失败关闭。
6. 会话文件、工作树和快照绝对路径只留在 Main 私有存储；公开 IPC、Renderer 和联合旅程证据只含不透明地址、相对路径及摘要。
7. 联合旅程中的 Diff 来自真实 Attempt 工作树，验证来自真实命令退出码；最终交付在人工批准前不写入用户项目。

## 测试质量与维护性复核

本次复核不只依据测试绿灯，还检查了角色门、Worker 硬限制、可信 session 登记、恢复 Saga、Renderer 卡片和 E2E 断言：

1. **未用 Renderer 断言替代安全门**：相同角色要求同时存在于 IPC 和 TaskHub Orchestrator，界面提示只是用户反馈。
2. **未用 E2E 私有 seed 伪造生产能力**：测试已删除直接写入 session 注册表的 helper，必须经过真实 session IPC 生产路径。
3. **未采信模型自述**：角色绑定从私有 SQLite 读取脱敏摘要，Diff 从工作树读取，验证从退出状态读取，交付从 TaskHub 总账读取。
4. **未引入第二套状态机**：角色模块只保存配置和 Attempt 快照；执行、结果未知和恢复后的验证失效仍由既有 TaskHub/检查点 Saga 决定。
5. **未形成恒真测试**：删除角色门、把未绑定工具恢复为全开放、恢复 E2E 手工 seed 或允许未确认检查点恢复，均会破坏对应回归或桌面旅程。
6. **未扩大产品范围**：没有修改 WORK、DESIGN、Univer、DOCX/PDF 降级路径，没有安装依赖、制作 Portable 或调用生产模型。
7. **证据边界明确**：Scripted Runtime 只证明接缝和状态流，不证明生产模型代码质量或多会话长期稳定性。

## 聚焦验证

```powershell
node_modules\.bin\vitest.cmd run <P3 checkpoint/role focused files>
node_modules\.bin\vitest.cmd run src/main/xiaogui/coding-extensions/attempt-ipc.test.ts src/main/xiaogui/task-hub/execution-orchestrator.test.ts src/worker/xiaogui-coding-extensions/role-runtime-binding.test.ts src/worker/xiaogui-coding-extensions/role-guard-extension.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts src/renderer/src/xiaogui/components/CodingAttemptPlanCard.test.tsx src/renderer/src/xiaogui/lib/coding-attempt-client.test.ts src/main/ipc/handlers/session-preview-authorization.test.ts src/main/ipc/handlers/session-preview-invalidation.test.ts
npm run typecheck
npm run build
node_modules\.bin\playwright.cmd test e2e/xiaogui-real-three-task-journey.spec.ts --workers=1
git diff --check
```

- P3 原聚焦组：`28` 个文件、`220/220` 通过。
- 首轮审查阻断修复组：`9` 个文件、`80/80` 通过。
- 类型检查与构建：退出码均为 `0`；只有既有动态导入、大 chunk 和 Office Viewer 构建耗时提示。
- 角色槽复审修复组：`4` 个文件、`13/13` 通过。
- Electron：`1/1` 通过，`56.0s`；证据目录 `D:\CodexTemp\xiaogui-hub-m4g-real-journey-v1\evidence\run-1788233094138`。
- 差异检查：`git diff --check` 通过。

## 审查结论与剩余边界

首轮关于角色可绕过、Worker 未绑定全开放、生产 session 接缝缺失、E2E 手工 seed、Worker 角色槽覆盖和验收材料缺失的阻断项均已有最小实现与直接证据。固定差异复审结果：代码审查 `PASS`，规格审查 `APPROVE`，P3 当前无阻断项。

仍保留以下边界，不把它们伪装成已完成：

- Electron 联合旅程实际执行的是三个固定 `IMPLEMENT` Attempt；研究/审阅硬只读由聚焦 Worker 测试证明，没有为了展示而在运行中切换角色。
- 联合旅程使用受控 Scripted Runtime；生产 Kimi/Codex 的模型质量和登录状态不在本阶段证明范围。
- 未运行全量测试、制作 Portable、合并阶段线或发布。
- 符号链接 target 约束和 `OUTCOME_UNKNOWN` 后检查点 runtime 的保守全局停用已登记为后续安全/体验债；双审查确认它们不构成本次 P3 阻断。
