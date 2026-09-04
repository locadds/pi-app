# 小规普通 CODING 主链与 Oh My Pi 历史边界

## 当前产品结论（2026-09-05）

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
| Pi 工具生命周期 | xiaogui-direct-coding-tool-lifecycle-v2 | 在真实 Pi read/bash/edit/write 调用前后进入 Main 权限与入账接缝，不持有策略 |
| 授权 | CodingAuthorizationModuleV2 | 一个深层 Module；Direct Adapter 服务普通会话，TaskHub Adapter 保留 Attempt V1 |
| 文件恢复 | DirectCodingFileCheckpointV2 | 主体固定 DIRECT_SESSION；私有保存前镜像，公开层只有令牌和摘要；不伪造 attemptId |
| cwd 与资源身份 | WorkerExecutionIdentityV1 | AgentSession、SessionManager、ResourceLoader、Skill/规则和工具共享所选项目 cwd；项目或资源变化会重建 Worker |
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

- 绝对路径、路径穿越、.git、symlink、junction 和 hardlink 写穿均被拒绝。
- 新文件创建会核验最近存在父目录的真实位置。
- toolCallId + requestDigest 是幂等键，状态为 PENDING → ALLOWED → EXECUTING → SETTLED/OUTCOME_UNKNOWN。
- 重复请求返回原状态；进程中断后的未知结果不会自动执行第二次。
- 撤销时只有当前摘要仍等于执行后摘要才会恢复前镜像或移除本次新文件；冲突时保持文件不变。
- 撤销只影响文件，不倒退 Pi 对话、分支或会话历史。

Bash 在所有档位都逐次确认，仅记录安全命令摘要、审计、退出码和可观察结果。它不建立可恢复文件检查点，也不承诺撤销项目外路径、网络或子进程副作用。

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
