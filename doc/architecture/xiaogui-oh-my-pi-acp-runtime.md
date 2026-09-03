# 小规 Oh My Pi ACP Coding Runtime 接入门

## 结论

`can1357/oh-my-pi` 通过标准 ACP stdio 接缝接入小规现有 `AgentRuntimeRegistryV1`，不替换 Pi Worker、TaskHub、Attempt、工作树、权限、验证或交付状态机。

`RUNTIME-R4-OMP-ACP-ADAPTER-01 / P0` 已于 2026-09-02 通过人工验收，固定提交为 `607618f952b102b889bc12f5ab101f802ab6b401`；P1A、P1B、P1C 已依次通过人工验收，P1C 固定提交为 `9728eafdb67d0aea8a2f9e52fd6f315f4e4e7692`。P1D-A 首次候选 `a9377a22e531cc55e06b40917e103217c6e71c93` 已被人工拒绝；当前只在独立分支修复受信 native、版本冲突和 junction 等阻断，尚未重新验收、未接入产品入口，也不会被默认生产路由选中。

P1 的三批任务与六项生产门映射见 `doc/runtime-r4/OMP-ACP-P1-EXECUTION-GATES.md`。P1 不把 OMP 改为 `write` 或 `yolo`；OMP 继续以 `always-ask` 作为内层审批基础，由 TaskHub 在硬边界核验后应用用户选择的三档权限策略。

P1B 已增加受信完整性回执、OMP 私有模型设置和三档权限 UI。P1C 已接通固定入口、真实工作树结果对账和同 Attempt/Runtime/vendor session/worktree 恢复。P1D-A 进一步把信任边界扩展到完整依赖闭包：固定 lock、全树总账和关键 native 摘要，采用用户选择的大体积目录、双重完整性校验及原子活动指针。Windows native 还必须复制到 activation receipt 绑定的同盘缓存，以封闭环境固定 `XDG_DATA_HOME`，在版本探测和正式 ACP spawn 前复验源与缓存摘要；不得继承用户全局 `%USERPROFILE%\.omp` native 缓存。每次真实 spawn 前重新验证完整 24,230 文件树、活动 pointer/receipt、源与缓存 native 及所有受控目录；所有目录逐级写前检查实路径，同一 storage root 由 SQLite 排他事务串行装配，失败只清理本事务取得所有权的资源。以上能力仍受显式候选门控制，不因底层装配通过而提前批准默认 Runtime。

## 固定来源

- 上游：`https://github.com/can1357/oh-my-pi`
- npm：`@oh-my-pi/pi-coding-agent@18.1.2`
- Git tag：`v18.1.2`
- Git revision：`86bf72f52947f62ecaf9bd28e35572812e725a92`
- npm SHA-512 integrity：`sha512-azsUetojUyT2e+CyDPun2LgFrCts8FtnvBlbPrzYj6Y7UbRIkdebqhNZVhMrOrueNnRsLetqcrY8EPomxTlvCg==`
- 许可证：MIT
- 运行入口：`omp acp`

小规不复制上游源码，也不把 OMP npm 包加入 `package.json`。P1D-A 将已准备好的固定完整依赖闭包作为独立 Runtime 资产装配到用户选择的私有大体积目录；二进制与缓存不进入 Git，发布包与离线资源仍未实现。Adapter 固定协议、版本、启动参数和权限边界，并只消费已激活回执。

P0 仍保留显式的固定包测试入口：仅当 `XIAOGUI_OMP_ACP_BUNX_TEST_ENABLED=1` 时，探针才会使用 `bunx --bun @oh-my-pi/pi-coding-agent@18.1.2`。默认发现不会触发下载或联网。P1D-A 生产候选不使用该探针，也不从 PATH、`OMP_CLI_PATH` 或网络寻找 OMP；只有 Bun 引擎继续经过独立的绝对路径和版本门。

## 现有接缝复用

1. `NdjsonAcpProcessTransportV1`：标准 JSON-RPC/stdio、`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` 和 `session/request_permission`；OMP 生产候选复用其 `preSpawn` 和封闭环境选项，不另建进程层。
2. `AgentRuntimeRegistryV1`：发现、健康、路由、会话绑定、事件、权限、打断和结果检查。
3. TaskHub Attempt 工作树：ACP 会话只绑定已准备且摘要匹配的独立工作树。
4. TaskHub 权限：OMP 只可提出 `allow_once` 请求；绝对路径不进入公开事件，越出 Attempt 工作树的目标直接拒绝。

没有引入第二套 Agent Loop、权限数据库、任务 DAG 或交付状态机。

## 测试启动策略

Adapter 固定以以下等价参数启动：

```text
omp --approval-mode always-ask --no-extensions --no-skills --no-rules acp
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

P1C 已完成人工验收，但 P1D-A 尚未成为用户可见产品入口。以下事项未通过前，不得把 OMP 切为默认 Runtime 或宣称完成发布装配：

1. P1D-A 人工拒绝项复修需完成新的只读审查与人工验收；当前只在独立候选分支，不得自动进入集成线。
2. P1D-B 需提供主进程目录选择、动态空间/进度/失败提示和受控单机试用入口；Renderer 不得取得私有绝对路径或伪造安装状态。
3. 旧活动版本的清理必须单独展示空间影响并取得人工确认；不得为节省空间静默删除可恢复版本。
4. 自动下载、离线资源、Portable 和发布包尚未实现；当前装配输入是已经准备并固定校验的完整闭包目录。
5. OMP 版本、依赖锁、完整树或 approval envelope 任一升级前仍需重新 Spike，不能沿用 18.1.2 回执。

因此 P1D-A 不改变默认路由，不制作 Portable，也不宣称已完成用户可用的生产安装。完整装配门通过只证明固定 Runtime 资产可以被受控激活，不等于 P1D-B 产品入口已经完成。
