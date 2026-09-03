# OMP ACP Runtime P1 生产门与施工卡

## 状态边界

- P0 已于 2026-09-02 经人工验收通过，固定提交为 `607618f952b102b889bc12f5ab101f802ab6b401`。
- P1 在独立分支 `agent/runtime-r4-omp-acp-p1-v1` 施工，不触碰 WORK 活动分支，也不直接合入产品主线。
- P1 完成前，OMP 继续保持 `APPROVED_FOR_TEST`、`OMP_PRODUCTION_DISABLED` 和固定 `--approval-mode always-ask`。
- 三档权限控制属于 TaskHub 策略，不等价于把 OMP 启动参数改为 `write` 或 `yolo`。只有 TaskHub 已核验的操作才可依据用户档位自动放行；未核验、越界或被拒绝的操作在所有档位下均拒绝。

## P1A：权限契约与接缝 Spike（已验收）

### 目标

1. 用一个共享版本化来源定义“逐条确认、自动通过、完全自主”的中文名称、说明和确定性效果。
2. 在既有 `CodingPermissionModuleV1` 增加可选的 TaskHub 策略接缝，不新增权限数据库、Agent Loop 或 Renderer 权限系统。
3. 证明自动允许、继续询问和硬边界拒绝都能通过同一个权限模块返回；未装配策略时保持原有逐次询问行为。
4. 实查 OMP 固定版本的 ACP 配置与现有小规模型设置接缝，为 P1B 留下准确输入，不在本阶段先做设置页。

### 冻结语义

| 档位 | TaskHub 已核验读写 | TaskHub 已核验命令 | TaskHub 已核验外传 | 未核验/越界/拒绝 |
|---|---|---|---|---|
| 逐条确认 | 询问 | 询问 | 询问 | 拒绝 |
| 自动通过 | 自动一次性允许 | 询问 | 询问 | 拒绝 |
| 完全自主 | 自动一次性允许 | 自动一次性允许 | 自动一次性允许 | 拒绝 |

“已核验”必须来自 TaskHub 的 Attempt 工作树、文件授权范围、命令策略和数据策略。Runtime 或 Renderer 的自报不能产生该状态。当前 TaskHub 已有文件清单核验，但命令硬边界和外传预批准尚未完成，因此后续 UI 即使选择“完全自主”，也不得提前把尚未核验的命令或外传标为 `VERIFIED`。

### 上游实查

固定上游 `can1357/oh-my-pi@86bf72f52947f62ecaf9bd28e35572812e725a92` 的 `src/modes/acp/acp-agent.ts` 已确认：

- `session/new`、`session/load` 和 `session/resume` 返回 `configOptions`；
- 稳定配置编号为 `mode`、`model`、`thinking`；
- `session/set_config_option` 可切换模型和思考级别；
- ACP 的 Default/Plan 模式与小规三档权限不是同一概念，不能复用一个 UI 字段；
- OMP 的 `--approval-mode` 仍是 Runtime 内层审批基础，小规生产接入继续固定 `always-ask`，以保证每个写入、命令和外传请求都先到 TaskHub。

现有小规 `pi-models-json.ts` 和模型设置页已能管理 Pi 兼容的 `models.json`。P1B 应把经过现有校验的配置写入 OMP 私有 `PI_CODING_AGENT_DIR`，而不是把 API Key、路径或原始配置放入 TaskHub 公共 DTO。

## P1B：受信安装、私有模型设置与三档 UI（已验收）

P1B 已于 2026-09-03 由用户人工验收，固定提交为 `a9ee7bc4b18ce8ded6f5fc7fd00d393374cd9589`：

1. 受信安装流程生成固定版本、包完整性、入口摘要和私有状态目录摘要；PATH 上仅版本相同但来源不明的程序不得通过生产门。
2. 设置页复用现有模型配置表单与校验，只增加 OMP Runtime 目标；凭据和原始配置继续留在主进程私有目录。
3. Composer 显示三档权限选择器；选择在 Attempt 创建时冻结为 `CodingPermissionModeBindingV1`，执行中不得静默改变。
4. TaskHub 为文件、命令和外传分别给出硬边界核验结果；Renderer 只展示模式与审批，不拥有策略决定权。
5. 断线恢复读取同一 Attempt 的冻结权限档位和 Runtime 绑定；缺失或摘要冲突时停止。

### P1B 当前证据与边界

- 固定包完整性模块以 npm 官方固定 archive 的 SHA-512 SRI 及其完整解包树为独立信任根，已经生成并复验版本、来源、入口、树摘要、文件数/体积和私有状态目录摘要；D 盘真实固定缓存与官方 archive 解包结果完全一致，伪造同版本目录、内容/回执篡改或私有状态目录重定向均拒绝。
- 模型设置页已复用既有表单和 Pi SDK 校验器增加 OMP 私有目标；公开 UI 只显示安全标签，TaskHub 不接收配置、凭据或绝对路径。
- Composer 三档选择已接入。TaskHub 在调度前取样，在真实 Attempt 返回后不可变绑定；恢复时同时校验 Saga 快照与绑定摘要。
- 文件边界可由 Attempt manifest 核验；命令和外传尚无权威白名单，因此明确为 `UNVERIFIED` 并拒绝，三档 UI 不会扩大该边界。
- P1B 提交中的 OMP 仍为测试专用；受信回执消费、真实结果对账和生产候选接缝由 P1C 完成。PATH 同版本不构成生产信任。
- 聚焦结果：12 个测试文件、96 项通过、1 项按设计跳过；真实 D 盘固定包门 9 项通过；Node/Web 类型检查、Electron 构建和真实设置页/Composer 窗口检查通过。完整命令和截图路径见根 `DEVELOPMENT_STATUS.md`。

## P1C：真实 Coding、结果对账与恢复验收

P1B 人工验收后已开始 P1C；当前实现、真实旅程和聚焦验证完成，作为独立分支阶段候选等待人工验收：

1. 用真实模型完成“权限申请 → 修改独立工作树 → 聚焦验证 → 真实 Diff”。
2. 从 TaskHub 工作树生成 `candidateDigest` 并通过现有 `RuntimeOutcomeMonitorV1`、ChangeSet 和 Delivery 接缝对账；模型文字不能替代证据。
3. 断开并恢复后核对同一 Attempt、同一 Runtime selection、同一 vendor session 和同一工作树；结果未知时不重复派发。
4. 只有真实旅程、恢复和受信安装均通过，才提出 `supportsResultReconcile: true` 与生产批准变更；仍需人工验收，不自动切换默认 Runtime。

### P1C 当前证据与边界

- 显式生产候选接缝先消费固定安装回执和固定入口；缺回执时即使 PATH 上存在同版本 OMP 也不会使用。
- OMP 18.1.2 普通文件工具实测在结构化 `tool_call` 前先请求 form elicitation。适配器保留结构化权限通道，并对该固定版本增加精确、单目标、fail-closed 的兼容 envelope；任何歧义、截断或未来形状均取消。
- 真实 OMP 模型只修改 Attempt 工作树中的一个授权文件，源项目不变；真实结果树摘要贯穿 RuntimeOutcomeMonitor、CandidateAudit、ChangeSet 和 Delivery。
- SQLite 绑定保证恢复同一 Attempt、Runtime selection、vendor session 和工作树；已结算结果回放，未结算结果返回 UNKNOWN 且不重新 prompt。
- `supportsResultReconcile: true` 只存在于显式 `ompProductionEnabled` 候选路径；当前桌面调用方没有开启，默认 Runtime 未改变。
- 完整测试证据、环境差异和未执行项见 `OMP-ACP-P1C-QA.md`；审查结论见 `OMP-ACP-P1C-REVIEW.md`。

## 六个未完成门映射

| P0 留下的生产门 | 负责阶段 | 验收证据 |
|---|---|---|
| 工作区、命令摘要、外传边界 | P1B + P1C | 三档负例与真实权限旅程 |
| `candidateDigest` 对账 | P1C | 工作树摘要、ChangeSet、Delivery 一致 |
| 同 Attempt/Runtime/session/worktree 恢复 | P1B + P1C | 断线恢复与防重复派发 |
| 模型凭据、选择和私有状态设置 | P1B | 设置页、私有落盘、公开 DTO 泄漏检查 |
| 真实模型修改到交付 | P1C | Electron 可见旅程与聚焦验证 |
| 受信安装与完整性清单 | P1B | 固定包 receipt 与篡改拒绝 |

## 固定的最小验证

- P1A：共享契约、权限策略、权限模块聚焦测试；Node/Web 类型检查；差异检查。
- P1B：只运行受信安装、模型设置、权限档位、Attempt 绑定和对应 Renderer 聚焦测试，再做一次设置页可见冒烟。
- P1C：只运行 Runtime/TaskHub/Delivery/恢复聚焦测试和一条真实 Electron Coding 旅程。
- 不复跑 OMP 上游测试，不跑无关 WORK、Office、Git、SQLite、React 或 Electron 全量套件，不制作 Portable。
