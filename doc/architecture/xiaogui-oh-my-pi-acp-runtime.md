# 小规普通 CODING 主链与 Oh My Pi 历史边界

## 当前产品结论（2026-09-06）

当前阶段候选只有一条普通 CODING 产品主链：

~~~text
进入 CODING
→ Pi 以用户所选项目为唯一 cwd
→ ASK/PLAN 保持只读
→ EXECUTE 中通过宿主权限门调用真实工具
→ edit/write 建立文件检查点后直接修改项目
→ 展示真实 Diff 和验证结果
→ 用户可撤销单次文件修改
~~~

- 普通 CODING 不创建 TaskHub Attempt、隐藏工作树或额外 Apply。工具成功即已经修改用户项目。
- TaskHub 保持原有 Attempt 工作树 → Delivery → 人工 Apply，不与直接会话混用。
- Git 脏目录和非 Git 目录都可使用；既有内容不因进入 CODING 被清理。
- OMP 不作为 Runtime、模式、配置、启动项、能力名称或验收对象。没有“透明 OMP 六能力”，也没有通过提示词冒充执行能力。
- 所有模式继续读取小规同一套模型配置。

该结论目前是隔离分支阶段候选，仍待人工验收；不代表已合入 WORK、阶段线或正式主线。

## 生产事实源与真实接缝

| 责任 | 当前生产事实源或接缝 | 说明 |
|---|---|---|
| 阶段可用工具 | packages/shared/xiaogui-prompt-matrix.ts 与 xiaogui-prompt-capabilities.ts | ASK 仅 read；PLAN 为 read + plan；EXECUTE 普通会话或实现角色才有 read/bash/edit/write |
| Pi 工具生命周期 | xiaogui-direct-coding-tool-lifecycle-v2 + V4 preflight/begin | 在真实 Pi read/bash/edit/write 调用前后进入 Main 权限与入账接缝；Main 返回的规范相对路径是 Pi 的唯一执行路径 |
| 授权 | CodingAuthorizationModuleV2 | 一个深层 Module；Direct Adapter 服务普通会话，TaskHub Adapter 保留 Attempt V1 |
| 文件恢复 | DirectCodingFileCheckpointV2 | 主体固定 DIRECT_SESSION；私有保存前镜像，公开层只有令牌和摘要；不伪造 attemptId |
| cwd 与资源身份 | ProjectRootIdentityV2 + WorkerExecutionIdentityV1 | AgentSession、SessionManager、ResourceLoader、Skill/规则和工具共享所选项目 cwd；同路径目录实体替换、项目缺失或资源变化会停止复用 Worker |
| TaskHub | 既有 Attempt/工作树/Checkpoint V1/Delivery/Apply | 语义不变，不复用直接会话的 V2 文件检查点 |

旧 xiaogui-coding-extension-pack.ts 的六模块 Manifest 只保留历史或 TaskHub 元数据用途，不是普通 CODING 的运行时工具事实源。已删除只追加提示词的 transparent-harness-extension 及重复六字符串能力清单。

## 阶段与角色硬门

| 阶段或角色 | 可用工具 |
|---|---|
| ASK | read |
| PLAN | read + plan |
| EXECUTE，普通会话或实现角色 | read + bash + edit + write |
| 研究、审阅角色 | 只读 |

未绑定 TaskHub 角色的普通 CODING 会话不再被角色 Extension 强制只读，但仍服从 ASK/PLAN/EXECUTE 阶段。研究和审阅角色的只读上限不可由权限档位解除。

## 直接会话权限

普通会话的弹窗只有“允许一次”和“拒绝”。TaskHub V1 原有 ALLOW_TASK_RULE 继续存在，但不得用于 DIRECT_SESSION。

| 操作 | 逐条确认 | 自动通过 | 完全自主 |
|---|---|---|---|
| 项目内读取 | 询问 | 自动 | 自动 |
| 修改已有文件 | 询问 | 检查点成功后自动 | 检查点成功后自动 |
| 创建新文件 | 询问 | 询问 | 检查点成功后自动 |
| Bash | 始终询问 | 始终询问 | 始终询问 |
| 工具外传 | 始终询问 | 始终询问 | 始终询问 |

工具外传只指工具主动向当前统一模型提供方之外的第三方目的地发送数据。项目文件进入当前模型上下文不按该项重复询问，继续服从现有模型与数据策略。

## 文件检查点和幂等

edit/write 的调用顺序固定为：

~~~text
阶段与角色核验
→ 路径边界核验
→ 权限决定
→ 建立文件检查点
→ 执行前复核项目根、链接状态和前摘要
→ 串行执行真实工具
→ 记录后摘要和终态
~~~

- Pi 的普通相对路径、`./` 路径及规范化后仍位于项目内的绝对路径均可进入授权；WSL 路径通过既有边界桥转换。项目外路径、路径穿越、`.git`、symlink、junction 和 hardlink 写穿均被拒绝。
- 新文件创建会核验最近存在父目录的真实位置。
- toolCallId + requestDigest 是幂等键，状态为 PENDING → ALLOWED → EXECUTING → SETTLED/OUTCOME_UNKNOWN。
- 只有首次 preflight 和首次 begin 返回同一规范执行路径；重复请求统一拒绝且不返回路径、不重新询问、不新建检查点、不自动执行第二次。
- 撤销时只有当前摘要仍等于执行后摘要才会恢复前镜像或移除本次新文件；冲突时保持文件不变。
- 撤销只影响文件，不倒退 Pi 对话、分支或会话历史。

Bash 在所有档位都逐次确认。授权框显示完整真实命令并保留换行和制表符，不使用截断预览；UTF-8 超过 64 KiB 或含隐藏控制字符时直接拒绝。Main 只持久化命令摘要、审计、退出码和可观察结果，不持久化命令正文。它不建立可恢复文件检查点，也不承诺撤销项目外路径、网络或子进程副作用。

## R3.3 授权路径、可信会话与后台权限

- 会话的可信项目绑定不可由当前 UI 项目覆盖；同一会话传入另一个 cwd 时直接拒绝。
- `ProjectRootIdentityV2` 将规范路径与目录实体信息写入既有 Scope 持久化；同一路径删除重建不视为原项目恢复。
- WSL 只转换 Linux 绝对路径；普通相对路径与 `./` 路径保持项目相对语义。Main 规范化项目内绝对路径，V4 preflight/begin 两次返回同一相对路径，Worker 复制参数后用该路径执行 Pi。
- `TrustedSessionAccessModuleV1` 统一 Prompt、Session Open、Prepare 和 Navigate 的可信访问。Renderer 参数不能互相证明可信；Prompt 只消费 Main 已登记的新建、可信打开、Sandbox 或 live Worker 绑定，`steer/followUp` 还要求精确活动 Worker。
- 权限提示包含安全项目名、对话名和来源摘要。精确匹配来源的后台 CODING Worker 也可在当前窗口请求权限，不自动切换会话；响应后再次核验来源。切换会话只保留结构化的 DIRECT_SESSION V3 权限请求，来源 Worker 退出只关闭自身请求。
- Bash 命令在 Worker、Main 和 Renderer 共用控制字符与 Unicode Bidi 安全门；正常换行、制表符、完整命令及 64 KiB 上限保持不变。
- READ 授权前 Main 只异步读取元数据；edit/write 在获批后才异步捕获不超过 16 MiB 的前镜像。不能建立检查点时不执行写入。
- 授权后执行前再次核验目录实体、目标实体与前摘要；未知结果和重复幂等键不重放真实工具。

## R3.3 CLOSEOUT：Pi Worker 项目根唯一权威

R3.3 CLOSEOUT 只收口 Worker 执行目录的唯一权威，不新增产品能力：

> 2026-09-06 复验补正：`fed469a` 只把能力句柄做成 Main 内部对象，签发依据仍错误地接受了 Renderer 可写的 `currentProject`／`recentProjects` 与任意匹配 cwd 的 JSONL，因此未通过人工复验。以下“Main 唯一权威”口径以补正后的信任来源为准。

- 项目能力只能从 Main 原生目录选择器确认的项目，或 Main 创建并验证的受管 Sandbox 证据中签发。`currentProject`、`recentProjects` 只用于显示和候选选择，Renderer 已不能通过 `settings.set` 修改这两个字段；`workspace.open/switch/ensureWorker` 只能消费既有 Main 登记，不能自行登记路径。
- 项目登记持久化的只是来源与目录实体摘要。每次签发内存能力前都会由 Main 重读目录实体；同路径替换会以 `PROJECT_IDENTITY_CHANGED` 失败。旧配置不会自动升级成授权，用户需要通过原生目录选择器重新确认一次。
- WSL 的执行根与比较 key 严格分离：执行根保留 Linux 文件系统真实大小写；比较 key 只统一 Windows UNC server／distro，不折叠 WSL 路径主体。`SessionScopeResolverV1` 分别持有 execution/comparison 投影，实体核验和返回 cwd 只能使用 execution；`DirectCodingModuleV2` 仅在相等判断中使用比较 key。比较 key 永远不能作为 Worker cwd。
- 会话列表由 Main 的 Session Preview/SessionManager 接缝在已授权项目根下发现。列表结果只登记“可被显式打开的精确会话项”，不签发会话能力；任意 Renderer JSONL 只有在命中该 Main 登记、原子创建回执或精确 live binding 时才能继续 Open/Prepare/Navigate。Pi 顶层列表不会递归枚举子 Agent 会话；标准嵌套子会话只能沿一个以本次新鲜顶层列表为根的已验证父链派生。每次列表刷新都会逐层重验项目身份、JSONL 元数据、`realpath` 与固定私有产物树，孤立后代被丢弃；派生登记本身仍不签发能力。
- Prompt 始终只消费已经签发并登记的会话能力。伪造 `settings.set → workspace.*` 或 `sessionFile → session.open/prepare/navigate/prompt` 会在 Worker 创建、上下文装配、模型调用和消息提交前失败。

- Main 以内存对象身份和 `WeakMap` 持有项目／会话能力。能力句柄不含可序列化授权字段，不能由路径、摘要、IPC 参数或持久化数据构造；Renderer 和 Worker 均不会收到该句柄。
- `WorkerManager` 的创建、恢复、聚焦与重新绑定只接受上述 Main 内部句柄。旧的裸会话文件、字符串 cwd/workspace hint 和 JSONL cwd 执行兜底已被替换，不保留兼容重载。
- Main→Worker 只发送一次性执行租约。租约绑定精确 slot、项目摘要、转换后的 cwd、会话文件和 nonce；Worker 只验证并消费，不在 Windows/WSL 两侧重算项目实体身份，也不能签发新能力。
- 冷装载固定使用 Pi 0.84.1 的 `SessionManager.open(..., cwdOverride)`，热切换固定使用 `switchSession(..., { cwdOverride })`。装载后的 AgentSession、SessionManager、ResourceLoader、项目 Skill/规则和工具共用同一授权 cwd。
- JSONL `cwd` 只参与归属一致性检查。Main 登记缺失、JSONL 伪造、项目实体变化或会话不属于授权根时，在 Worker 创建、上下文装配、模型调用和消息提交前失败。
- New/Fork/Clone 的一次性创建操作绑定来源 Worker、slot、项目能力、nonce 和预期会话目录；Main 验证未使用回执后原子签发新会话能力。列表和预览只返回安全显示数据，不签发能力或冷启动 Worker。
- Checkpoint 持久化只保存待复核证据。恢复时 Main 重新核验项目实体、会话归属和 JSONL 一致性，再签发新的内存能力；旧记录不能直接恢复执行权。
- WORK 可以继续调用迁移后的共享底层接口，但其 UI、产品流程、状态语义和工具能力不变。TaskHub V1 仍独立保有 Attempt 工作树、Checkpoint、Delivery 和人工 Apply。

该实现仍是隔离分支阶段候选，等待人工复验；不代表已合入 WORK、阶段线或主线。

## Pi 原生复用与最小框架例外

- 固定复用 @earendil-works/pi-coding-agent@0.84.1 的 AgentSession、SessionManager、ResourceLoader、Extension 生命周期和 read/bash/edit/write。
- 复用现有 Worker→Main 宿主工具窄通道、Extension UI、Review 区域和 TaskHub 权限 Module。
- Skill 与历史 OMP 研究无法在 Main 边界提供直接会话路径复验、幂等入账和私有前镜像；本阶段只为这些已确认安全缺口增加 V2 Module/Adapter，没有新增 Agent Loop、通用文件平台或第二套工作树服务。

## Oh My Pi 历史研究

RUNTIME-R4-OMP-ACP-ADAPTER-01 的 P0—P1D-A 仅保留为隔离研究证据。曾固定研究：

- 上游：https://github.com/can1357/oh-my-pi
- npm：@oh-my-pi/pi-coding-agent@18.1.2
- Git tag：v18.1.2
- Git revision：86bf72f52947f62ecaf9bd28e35572812e725a92
- 许可证：MIT

这些历史结果不能作为恢复 OMP Adapter、受信装配、私有模型目录、启停、安装、状态或 Runtime 选择的依据。P1D-A 通过只证明当时的隔离研究接缝，不代表产品接入、主线合并、发布或升级授权。

## 当前验证边界

自动证据只命名为“真实 Pi 工具生命周期与真实文件写入冒烟”，并配合聚焦测试、Node/Web typecheck、定向 ESLint 和差异检查。它不等同于“自然语言 → 外部模型 → 用户界面”的完整旅程；真实模型和 Electron 操作留给人工验收。

本阶段不运行 OMP、802 MB 装配、Portable 或无关全量测试。
