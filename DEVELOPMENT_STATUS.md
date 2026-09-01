# DEVELOPMENT STATUS

更新时间：2026-09-02
阶段：`TASKHUB-H1-3` — 小规桌面 Worker、收件箱与本机计划草稿
状态：已完成独立复审建议的全部桌面端收口并完成聚焦复验，等待最终复核与人工验收；未进入 H1-4，未合并正式主线。

## 本阶段目标

让小规作为 Hub 的主动 Worker：用户在既有协作面板中登录并配对此电脑，安全保存本机节点凭据、轮询自己的任务、查看收件箱，并在用户明确决定后仅生成现有本机 TaskHub 计划草稿。不得自动执行、创建工作树、选择 Agent、合并或应用成果。

## 仓库与基线

- 仓库：`https://github.com/locadds/pi-planning-agent.git`
- 隔离工作树：`D:\CodexWorktrees\xiaogui-taskhub-h1-desktop-worker-v1`
- 功能分支：`agent/taskhub-h1-desktop-worker-v1`
- 施工基点：`agent/taskhub-h1-desktop-spike-v1@adcdf3296443f53c2a486f69796dceb63cd2f022`
- 功能提交：`8a5cef5`
- 审查修复提交：`3390af65a2507bed9a5b87ad070612173d0c47de`（配对前安全存储预检、旧节点锁定和持久状态深校验）
- 最终 UI 收口提交：`cd7f8517a1055c5b195b7c777c29adc1768fa721`（吊销后立即刷新主进程权威状态并清空 Renderer 缓存任务）
- 对接 Hub 分支：`agent/taskhub-h1-worker-api-v1`；其 H1-3 API 仍待独立审查和本阶段统一推送。

## 实际修改文件

| 范围 | 文件 |
| --- | --- |
| IPC 与主进程装配 | `packages/shared/ipc-channels.ts`、`src/main/xiaogui/index.ts`、`src/main/xiaogui/index.test.ts` |
| Windows 安全凭据 | `src/main/secret-store.ts`、`src/main/xiaogui/hub-task/worker-credentials.ts`、`src/main/xiaogui/hub-task/worker-installation.ts` |
| Worker 控制层 | `src/main/xiaogui/hub-task/http-task-worker-port.ts`、`worker-persistence.ts`、`worker-state.ts`、`worker-service.ts`、`worker-composition.ts`、`worker-ipc.ts` |
| 聚焦测试 | 上述 Worker 模块对应的 `*.test.ts`，以及 `src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx` |
| 既有协作面板内的收件箱 | `src/renderer/src/xiaogui/components/HubTaskInboxSection.tsx`、`CollaborationHubPanel.tsx` |
| 阶段记录 | `DEVELOPMENT_STATUS.md` |

## 已完成内容

- 在主进程实现 Hub 登录、节点配对、当前账号任务快照轮询、任务下载、定向接受/拒绝和任务退回的窄 HTTP Adapter；公开池的首次领取继续属于 H1-2 Hub 任务池，桌面端只消费已绑定到当前节点的任务。
- 节点 Token、Ed25519 私钥、Hub JWT、端点和身份标识只保存在主进程；凭据使用 Electron `safeStorage` 加密，无法安全存储时直接失败，不降级明文。
- 使用私有主进程持久化保存任务包与待上传回执草稿；Renderer DTO 不含路径、Token、私钥、会话号、运行时或项目内部标识。
- 本机打开任务只记录 `USER_OPENED` 待同步草稿；在 H1-4 完成验签和 Hub 确认前，界面不会把任务表述为“已送达”。
- 定向接受或公开领取后，用户可显式“创建本机计划草稿”；调用既有 `flow.start.with_draft`，不提交、不执行、不建工作树、不应用变更。
- 使用既有右侧协作面板嵌入“Hub 任务收件箱”，不新增独立页面或绕过 WORK/CODING 原有会话边界。
- Hub 当前节点快照采用权威全量同步：旧节点任务投影会被清理，待同步回执草稿保留；旧节点被替换时，桌面映射为可解释的 `NODE_REVOKED` 状态。
- 配对会先用独立加密探针验证 `safeStorage` 能实际写回并解密一次性私钥，再请求 Hub 替换活动节点；加密存储不可用时不会触发替换。
- 若 Hub 明确返回旧节点已吊销或认证失效，立即清除该节点的凭据、缓存任务包和未上传的 H1-3 本地回执草稿，停止轮询并锁定收件箱操作；普通离线不清除缓存，保留后续 H1-4 的离线打开语义。
- 读取私有 Worker 持久化状态时逐层校验任务、草稿和回执结构；异常嵌套状态整体降级为空状态，不让桌面启动时崩溃。
- 收件箱刷新收到节点吊销或认证失效后，Renderer 立即重新读取主进程权威状态；若节点已锁定，清除可见缓存任务并回到登录/配对入口，不短暂展示已失效的任务内容。

## 未完成内容

- H1-4：签名回执上传、Hub 验签/ACK、序号防重放、离线打开后的补传、结果信封、发布者时间线、单机双实例与两机 LAN 旅程。
- Hub 任务收件箱的真实网络联调需要等 H1-3 Hub API 的同阶段审查、推送和人工验收完成。
- 真实 Kimi 多会话 DAG 旅程仍是 H1-4 的联合验收项；本阶段不以模型调用替代 Worker 通道测试。

## 与规格文档的偏差

- 未改变冻结的架构决策。H1-3 刻意不接 H1-4 的回执上传和结果回传，因此“本机打开”只是可恢复的本地事实，不对发布者宣称已送达。
- H1-0 的宽内存 Spike 在实际桌面中收敛为主进程 `safeStorage`、私有持久化和窄 IPC；共享 V1 契约未变。
- Hub 当前 Worker 列表使用权威全量任务快照，`cursor` 仅保留为未来增量同步接缝，避免此阶段增加不必要的游标状态机。
- 公开池的首个领取操作不在 H1-3 桌面收件箱重复建设：用户在 H1-2 Hub 任务池领取后，任务才成为其当前节点的收件箱项。这是既有产品边界，不新增第二个领取入口。
- 真实 Electron 冒烟未配置可用 Hub 账号和 WORK/CODING 会话，只验证应用可见、协作面板安全回退且无崩溃；不把它表述为跨机交付验收。

## 测试命令与结果

| 命令 / 场景 | 结果 |
| --- | --- |
| `npm run test:unit -- src/main/xiaogui/hub-task/http-task-worker-port.test.ts src/main/xiaogui/hub-task/worker-credentials.test.ts src/main/xiaogui/hub-task/worker-persistence.test.ts src/main/xiaogui/hub-task/worker-composition.test.ts src/main/xiaogui/hub-task/worker-ipc.test.ts src/main/xiaogui/hub-task/worker-service.test.ts src/main/xiaogui/hub-task/worker-state.test.ts src/main/xiaogui/index.test.ts src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx src/renderer/src/xiaogui/components/CollaborationHubPanel.test.tsx` | 通过：10 个测试文件、58 条用例。覆盖安全存储预检、首次配对临时离线、IPC 脱敏、节点替换后主进程与 Renderer 缓存锁定、嵌套持久化损坏降级、权威快照清理、接受后仅建草稿及 UI 状态。 |
| `npm run typecheck` | 通过。 |
| `npm run build` | 通过：Electron Vite 主进程、预加载和 Renderer 均构建完成；仅保留仓库既有动态导入优化警告。 |
| Electron 可见冒烟 | 通过：以隔离用户数据目录启动桌面应用并连接 CDP，协作面板在无可协作会话时安全显示既有回退文案，无主进程或 Renderer 崩溃。证据：`D:\CodexScratch\xiaogui-h1-3-electron-smoke\h1-3-collaboration-fallback.png`。 |
| 独立代码审查 | 初审发现 2 个高优先级和 1 个中优先级桌面保护缺口，均由 `3390af6` 修复；复审为通过，另列 3 个低优先级收口项，均已由 `cd7f851` 完成（其中 Renderer 吊销清屏新增了先失败、后通过的组件测试），等待对本最终小补丁的复核。 |

## 已知风险

- H1-4 前，待同步回执不会发送到 Hub；不能以本机收件箱状态证明跨节点送达。
- 首期按已冻结决策使用院内可信 HTTP；节点公钥仅提供可审计证据，不宣称抵抗同网段监听或主动攻击。
- 当前收件箱复用既有协作面板，需先有有效 WORK/CODING 会话；这保持现有产品边界，但真实用户流程需要在 H1-4 联调时再做可用性验收。
- Windows `safeStorage` 可用性受系统账户环境影响；失败时会阻止配对而非留下不安全凭据。
- 加密预检与最终凭据写入之间存在极小的系统账户状态变化窗口；若最终写入仍失败，客户端会清除本地状态并要求用户重新登录/配对，不保留私钥或任务包。

## 下一阶段计划

先完成本阶段两端最终复核、推送与人工验收。验收通过后才进入 `TASKHUB-H1-4`：实现签名回执上传/ACK、离线补传、结果摘要和双实例/两机 LAN 受控旅程；继续保持人工批准、工作树和最终应用门不变。

## 验收门

本文件是 H1-3 状态记录，不构成验收。独立审查和人工验收前，不得进入 H1-4、不得合并正式主线、不得将收件箱表述为已完成跨机执行或已送达。
