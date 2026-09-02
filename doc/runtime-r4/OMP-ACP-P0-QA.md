# OMP ACP Runtime P0 聚焦验收记录

- 日期：2026-09-02
- 阶段：`RUNTIME-R4-OMP-ACP-ADAPTER-01 / P0`
- 基线：`f9f333beb0d29d195ca3f63a30ec1ad887e332a5`
- 目标：证明固定 OMP 版本可在 Windows 通过现有 ACP 接缝完成发现、握手、新建会话和权限往返；不批准生产执行。

## 真实 Windows Spike

运行环境：Windows x64、Bun `1.3.14`。Bun 包缓存显式指向 `D:\CodexCache\bun-omp-v18.1.2`。

| 检查 | 结果 |
|---|---|
| `bunx --bun @oh-my-pi/pi-coding-agent@18.1.2 --version` | 通过；返回 `omp/18.1.2` |
| ACP `initialize` | 通过；`protocolVersion=1`，Agent 为 `oh-my-pi/18.1.2`，声明 `loadSession=true` |
| ACP `session/new` | 通过；返回不透明会话编号及 Default/Plan、模型、思考级别配置项 |
| 首次缓存占用 | `D:\CodexCache\bun-omp-v18.1.2` 约 `771.1 MiB` |
| npm 来源核对 | `18.1.2`；SHA-512 integrity 与架构记录一致；仓库 URL 指向 `can1357/oh-my-pi` |
| tag 核对 | `v18.1.2` 指向 `86bf72f52947f62ecaf9bd28e35572812e725a92` |

为避免泄露底层会话身份，本记录不保存 `session/new` 返回的原始会话编号。OMP 包和缓存不进入 Git 或小规安装包。

脱敏的可复跑命令与原始 stdout 保存在 `doc/runtime-r4/evidence/omp-acp-windows-smoke-20260902.txt`。该真实测试走产品 `OmpAcpCliProbeV1` 的显式固定包入口，不依赖 PATH 中预装 `omp`。

## 自动验证

```text
node_modules\.bin\vitest.cmd run \
  src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts \
  src/main/xiaogui/agent-runtime/omp-acp-taskhub-integration.test.ts \
  src/main/xiaogui/task-hub/runtime-composition.test.ts \
  src/main/xiaogui/agent-runtime/runtime-registry.test.ts \
  src/main/xiaogui/agent-runtime/kimi-adapter.test.ts
```

覆盖：注册但不进入生产路由、固定启动参数、版本拒绝、真实 ACP 身份校验、事件摘要、一次性权限、越界路径拒绝、跨会话事件/权限拒绝、进程释放和 Kimi 既有行为回归。

另有一条 OMP → Runtime Host → Runtime Monitor → TaskHub Attempt 清单 → OMP `allow_once` 的集成测试，避免绕开 TaskHub 直接批准 Adapter 权限。

同时执行：

```text
node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
node_modules\.bin\tsc.cmd -p tsconfig.web.json --noEmit
git diff --check
```

最终命令和数量以 `DEVELOPMENT_STATUS.md` 本阶段条目为准。

最终普通聚焦回归结果：`5 test files passed`，`53 tests passed | 1 skipped`。跳过项是需要显式环境开关和固定 D 盘 Bun 缓存的真实 OMP 进程测试；该项已按上方证据命令单独执行并以 `1 passed`、退出码 `0` 结束。

真实进程测试首轮已完成握手，但审查复跑稳定暴露 Windows `taskkill` 后过早清理临时目录的 `EPERM`。Transport 随后改为等待进程树、目标 child `close` 和 stdio 关闭；清理门仅对 Windows 延迟释放的 SQLite/WAL 句柄做最多 2 秒有界重试，真进程泄漏仍会失败。完全相同的真实生命周期门修正后连续 3 次通过，每次均为 `1 passed | 6 skipped`，三轮总退出码为 `0`。该失败没有被隐去，也没有被误记为 ACP 协议失败。

## 人工验收边界

- 可验收：Runtime 已注册；真实 OMP ACP 可握手和新建会话；生产路由不会选中它。
- 不可验收：真实模型修改、结果对账、重启恢复、设置页、安装包和默认运行时切换。
- 本阶段通过后只进入下一生产门设计，不得直接合入正式产品线或发布。
