# OMP ACP Runtime P1C QA 证据

## 结论

P1C 的五项运行时门已在独立分支形成阶段候选：真实 OMP 模型经 TaskHub 审批后只修改 Attempt 工作树；主机捕获的结果树摘要贯穿 Runtime、CandidateAudit、ChangeSet 和 Delivery；重启恢复保持同一 Attempt、Runtime selection、vendor session 与工作树；生产启动先消费受信安装回执且不从 PATH 选择 OMP。

该结论不代表已经合入产品主线、切换默认 Runtime 或完成发布装配。P1C 仍等待人工验收。

## 环境与边界

- 分支：`agent/runtime-r4-omp-acp-p1-v1`
- 已验收基线：`a9ee7bc4b18ce8ded6f5fc7fd00d393374cd9589`
- OMP：固定 `18.1.2`，源码 revision `86bf72f52947f62ecaf9bd28e35572812e725a92`
- 启动参数：`--approval-mode always-ask --no-extensions --no-skills --no-rules acp`
- 完整依赖图：D 盘私有测试缓存；未提交 Git
- 模型配置：本机私有配置；路径、内容和凭据未写入本证据或公开契约
- 未触碰：WORK 工作树、正式主线、默认 Runtime、发布包、`package.json`、README

## 真实旅程

门控命令：

```powershell
$env:XIAOGUI_OMP_P1C_REAL_SMOKE='1'
$env:XIAOGUI_OMP_P1C_REAL_PACKAGE_ROOT='<D盘固定18.1.2完整依赖图中的主包目录>'
$env:XIAOGUI_OMP_P1C_MODELS_JSON='<本机私有模型配置>'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-acp-production.test.ts
```

最终结果：

```text
Test Files  1 passed (1)
Tests       4 passed (4)
exit code   0
duration    37.81s
```

最终收口时使用同一固定依赖图再次执行，结果为 `4 passed`、退出码 `0`、耗时 `37.61s`。带时间、D 盘依赖图位置、非敏感指纹及原始控制台输出的可复查记录见 `OMP-ACP-P1C-REAL-SMOKE.md`。

真实用例断言：

1. Adapter 使用冻结的 `kimi-coding/k3-256k` model selector 建立 OMP 会话。
2. OMP 发起普通 `edit` 审批，TaskHub 只收到 `src/feature.ts` 相对路径。
3. 只有该相对路径获得一次性允许；命令和外传没有被预批准。
4. Attempt 工作树内容从 `export const value = 1` 变为 `export const value = 2`。
5. 源项目相同文件仍为 `export const value = 1`。
6. Attempt 工作树 `git diff --check` 无错误。
7. TaskHub `captureTaskPatch()` 的 `resultTreeHash` 等于 Runtime `candidateDigest`。
8. SQLite recovery store 对 Attempt、Runtime session 和候选摘要的绑定复核为真。

## 真实进程与交付证据的口径

P1C 使用两段聚焦证据，而不是声称同一个真实模型进程贯穿所有交付对象：

1. 真实 OMP 18.1.2 子进程负责证明模型选择、权限请求、独立工作树实际修改、源项目不变、真实 Diff、主机捕获的 `candidateDigest` 和恢复绑定。
2. 同一 `OmpAcpRuntimeAdapterV1`、`OmpAcpRecoveryStoreV1`、`TaskCandidateAudit` 与生产绑定接缝的确定性集成用例，负责把该主机摘要继续对账到 `TaskChangeSet` 与 `Delivery`。

这样既覆盖生产接缝，又避免为重复验证 ChangeSet/Delivery 而再次消耗真实模型。当前证据不等于“一个真实 OMP 会话已经从 prompt 连续跑到最终人工应用”，最终应用仍由既有人工批准门控制。

## 聚焦回归

```powershell
npm run test:unit -- packages/shared/xiaogui-agent-runtime.test.ts src/main/xiaogui/coding-extensions/role-profile-module.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-taskhub-integration.test.ts src/main/xiaogui/agent-runtime/omp-private-layout.test.ts src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/task-hub/task-candidate-audit.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
```

结果：`9 test files passed`、`50 tests passed`、`3 tests skipped`。门控真实 OMP 用例在上述普通回归中按设计跳过，随后已用真实环境变量单独执行并取得 4/4。

```powershell
npm run typecheck
git diff --check
```

结果：Node/Web 类型检查均通过；差异检查退出码 `0`，仅有 Windows 行尾提示。

## 五门逐项证据

| P1C 门 | 结果 | 证据 |
|---|---|---|
| 权限申请 → 独立工作树修改 → Diff | 通过 | 真实 OMP 用例只允许一个相对路径；源项目不变；`git diff --check` 通过 |
| candidateDigest 三处对账 | 通过 | Runtime outcome、TaskCandidateAudit/TaskChangeSet 和 Delivery 使用同一 result tree hash |
| 四同恢复与防重复派发 | 通过 | SQLite 恢复同一 Attempt、selection、vendor session、workspace；已结算回放结果；未结算返回 UNKNOWN 且 prompt 次数为 0 |
| 受信回执在启动前消费 | 通过 | trusted launch inspection 先于进程创建；缺回执时 PATH 同版本也拒绝；composition 测试断言 PATH probe 未调用 |
| 生产能力仅候选开放 | 通过 | `supportsResultReconcile: true` 仅由显式 `ompProductionEnabled` 组装；仓库现有产品调用方未开启该选项 |

## 上游协议差距

实测 OMP 18.1.2 普通 `edit/write` 的顺序为：

```text
elicitation/create
→ 宿主批准或拒绝
→ tool_call / tool_call_update
```

因此普通写入无法在审批前绑定尚未出现的结构化 `toolCallId`。P1C 没有用宽松自然语言分类器替代协议，而是增加一个与固定 OMP 版本、固定源码 revision 和 capability digest 绑定的窄兼容层：

- 只接受 OMP 18.1.2 的精确 form schema；
- 只接受普通单目标 `edit` 或 `write` envelope；
- 只提取一个目标并交给 TaskHub 重新做工作树与 manifest 核验；
- 多目标、多行路径、截断、空路径、错误会话、未知工具或未来形状全部取消；
- 原生 `session/request_permission` 路径仍优先使用结构化 tool call。

这不是通用 prompt 解析，也不能在升级 OMP 时沿用。版本变化必须重新 Spike，否则 fail-closed。

## 审查时发现的环境差异

一次复核使用了仅含 OMP 主包的 archive 解包子目录，因缺失 `pi_natives` 等传递依赖而在 initialize 前失败。该结果证明缺依赖时会安全停止，但不能用于否定完整安装图上的真实旅程。随后使用 P1B 保留的 D 盘完整固定依赖图连续复跑，真实旅程 4/4 通过。

正式装配仍需把完整依赖闭包纳入安装/升级流程；P1C 没有把测试缓存冒充发布成果。

## 未执行

- 不重复 OMP 上游全量测试。
- 不跑 WORK、Office、React 或仓库无关全量套件。
- P1C 没有 Renderer 改动，因此未重复 Electron 窗口操作；真实 ACP 子进程、Git、SQLite、TaskHub 和 Delivery 已进入同一测试旅程。
- 不制作 Portable，不清理人工验收前仍需复验的 D 盘固定依赖图。
