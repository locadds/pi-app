# 小规 Oh My Pi ACP Coding Runtime 接入门

## 结论

`can1357/oh-my-pi` 通过标准 ACP stdio 接缝接入小规现有 `AgentRuntimeRegistryV1`，不替换 Pi Worker、TaskHub、Attempt、工作树、权限、验证或交付状态机。

`RUNTIME-R4-OMP-ACP-ADAPTER-01 / P0` 已于 2026-09-02 通过人工验收，固定提交为 `607618f952b102b889bc12f5ab101f802ab6b401`；P1A 已在 `b4f93e561d02673a62bbf7b0d7797bbe41b9d498` 通过人工验收。P1B 当前为隔离实现候选，但 Runtime 仍只有 `APPROVED_FOR_TEST`，不会被生产路由选中；默认生产运行时保持不变。

P1 的三批任务与六项生产门映射见 `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`。P1 不把 OMP 改为 `write` 或 `yolo`；OMP 继续以 `always-ask` 作为内层审批基础，由 TaskHub 在硬边界核验后应用用户选择的三档权限策略。

P1B 已增加受信完整性回执、OMP 私有模型设置和三档权限 UI。完整性信任根固定到 npm 官方 archive 的 SHA-512 SRI 及其完整解包树，不接受调用方自报 integrity 或仅匹配版本的目录。全局权限偏好只在 Attempt 创建时取样，之后由 TaskHub 以策略摘要不可变绑定；命令和外传在没有权威白名单时保持 `UNVERIFIED` 并拒绝。受信回执的生产消费与真实模型结果对账仍属于 P1C，不因 UI 已出现而提前批准 Runtime。

## 固定来源

- 上游：`https://github.com/can1357/oh-my-pi`
- npm：`@oh-my-pi/pi-coding-agent@18.1.2`
- Git tag：`v18.1.2`
- Git revision：`86bf72f52947f62ecaf9bd28e35572812e725a92`
- npm SHA-512 integrity：`sha512-azsUetojUyT2e+CyDPun2LgFrCts8FtnvBlbPrzYj6Y7UbRIkdebqhNZVhMrOrueNnRsLetqcrY8EPomxTlvCg==`
- 许可证：MIT
- 运行入口：`omp acp`

小规不复制上游源码，也不把 OMP npm 包加入 `package.json` 或安装包。OMP 作为独立外部运行时安装；Adapter 只固定协议、版本、启动参数和权限边界。

P0 另提供显式的固定包测试入口：仅当 `XIAOGUI_OMP_ACP_BUNX_TEST_ENABLED=1` 时，探针才会使用 `bunx --bun @oh-my-pi/pi-coding-agent@18.1.2`。默认发现不会触发下载或联网。正式安装的 `omp` 仍可通过 PATH 或 `OMP_CLI_PATH` 被发现，但必须同样通过版本与启动参数校验。

## 现有接缝复用

1. `NdjsonAcpProcessTransportV1`：标准 JSON-RPC/stdio、`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` 和 `session/request_permission`。
2. `AgentRuntimeRegistryV1`：发现、健康、路由、会话绑定、事件、权限、打断和结果检查。
3. TaskHub Attempt 工作树：ACP 会话只绑定已准备且摘要匹配的独立工作树。
4. TaskHub 权限：OMP 只可提出 `allow_once` 请求；绝对路径不进入公开事件，越出 Attempt 工作树的目标直接拒绝。

没有引入第二套 Agent Loop、权限数据库、任务 DAG 或交付状态机。

## 测试启动策略

Adapter 固定以以下等价参数启动：

```text
omp --approval-mode always-ask --no-skills --no-rules acp
```

- `always-ask`：只自动放行 OMP 声明为只读的工具；写入和命令交给 ACP 客户端权限门。
- `--no-skills --no-rules`：不让 OMP 额外加载用户或项目的自动规则，避免绕过小规冻结的 Prompt/Skill 治理。
- `PI_CODING_AGENT_DIR` 指向小规私有 Runtime 状态目录，不隐式读取用户全局 OMP 配置或凭据。
- 小规 ACP Client 不提供终端和写文件反向能力；OMP 发出的写入、命令或外传申请映射为 TaskHub 版本化权限事件。
- `allow_always` 不会被小规选择；当前只支持一次允许或拒绝。

## 真实 Windows 门

2026-09-02 在 Windows x64、Bun `1.3.14` 上完成固定包真实检查：

1. `bunx --bun @oh-my-pi/pi-coding-agent@18.1.2 --version` 返回 `omp/18.1.2`。
2. `initialize` 返回 ACP `protocolVersion: 1`、Agent `oh-my-pi/18.1.2`，并声明 `loadSession: true`。
3. `session/new` 成功返回不透明会话编号、Default/Plan 模式和模型/思考级别配置项。
4. 首次 Bun 缓存落在 `D:\CodexCache\bun-omp-v18.1.2`，实测约 `771.1 MiB`。该缓存不进入 Git，也不进入小规安装包。

可复跑的测试和脱敏 stdout 见 `doc/runtime-r4/evidence/omp-acp-windows-smoke-20260902.txt`；私有 session 编号在输出前已替换为 `<redacted>`。

## 当前未完成门

以下事项未通过前，不得把 OMP 改为 `APPROVED_FOR_PRODUCTION`：

1. OMP 内建工具的工作区读取边界、命令摘要和数据外传需要真实模型旅程核对；上游当前权限配置本身不提供小规所需的细粒度目录规则。
2. 真实代码修改结束后，需要从 TaskHub 工作树生成可对账的 `candidateDigest`，不能把模型或 ACP 文本自述当作交付证据。
3. 断线恢复必须验证同一 Attempt、同一 Runtime、同一会话和同一工作树，不得静默换 Agent。
4. OMP 私有模型设置已形成小规设置页，但 ACP 会话级模型选择和受信安装发布指引尚未完成。
5. 尚未完成真实模型的“申请权限 → 修改独立工作树 → 验证 → Diff → 交付”桌面旅程。
6. P1B 已能为固定包生成并复验完整性回执，但禁用中的 Adapter 尚未消费该回执作为生产启动源；PATH 上的任意同版本可执行物仍不能通过生产门。

因此本阶段不会改变默认路由，不制作 Portable，也不宣称 OMP 已可用于生产任务。P1B UI 只用于配置与后续任务权限选择，不等于生产批准。
