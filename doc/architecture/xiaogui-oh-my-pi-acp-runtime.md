# 小规 Oh My Pi ACP 研究记录（产品路线已取代）

## 当前产品结论（2026-09-04）

小规 CODING 有且只有一条用户主链：

```text
进入 CODING
→ 启动现有 Pi Coding Harness
→ 自动装载小规内置的 Coding Extension / Skill
→ 使用小规唯一一套模型配置
```

OMP 不作为独立 Runtime、模式、模型目标或用户可见产品。产品组合不注册 OMP Adapter，不提供 OMP 启停、目录、状态、安装、清理或选择入口，也不启动 OMP 进程。上下文、权限、计划、Diff、检查点和角色等已完成能力属于小规自己的 Pi/TaskHub 扩展；它们在 CODING 下按现有接缝自动工作，不要求用户知道 OMP。

`RUNTIME-R4-OMP-ACP-ADAPTER-01` 的 P0—P1D-A 代码和下文说明仅保留为隔离研究证据。它们不进入当前产品主链，不因曾经通过研究验收而恢复。以后若 OMP 某项具体能力优于 Pi 原生能力，必须先给出真实缺口，再以 Pi Extension、Skill 或最小适配单独审批；不得整体恢复 OMP Runtime 产品化。

## 历史研究结论

`can1357/oh-my-pi` 曾通过标准 ACP stdio 接缝接入小规 `AgentRuntimeRegistryV1`，用于验证外部 Runtime、权限和结果对账。P0—P1C 及 P1D-A 的固定版本、供应链和测试记录仍可复核，但不再构成施工指令。

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

## 已取消的后续路线

`P1D-B` 的目录选择、安装进度、失败提示、清理、显式 OMP 单机试用和默认 Runtime 讨论全部取消。自动下载、离线 OMP 资源和 Portable 装配也不再是当前待办。历史代码继续留在研究分支，产品分支不得重新注册或暴露；本文件不能作为恢复这些工作的依据。
