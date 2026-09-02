# OMP ACP Runtime P0 审查记录

## 审查轴

1. 仓库标准：`AGENTS.md`、Pi 原生/Skill/插件优先 ADR、既有 Runtime/ACP 接缝和常见代码异味。
2. 阶段规格：测试批准、生产关闭、权限一次性、路径/会话不泄漏、真实 Windows ACP 门和最小修改范围。

## 首轮结论与修正

- 阻断：权限请求未核对 `params.sessionId`。已改为只接受当前 vendor session；跨会话请求直接取消。
- 阻断：启动参数测试由 Fake Probe 自行提供，属于镜像测试。已增加 `OmpAcpCliProbeV1` 真实边界测试。
- 中风险：跨会话 `session/update` 可能污染证据。已同步增加 vendor session 核对和负例测试。
- 非阻断：OMP 与 Kimi 仍各自维护部分 ACP 生命周期逻辑。P0 不做高风险重构；若 OMP 通过生产门，再提取共享 ACP Core，避免第三个实现继续复制。
- 非阻断：OMP 暂时复用 Kimi Attempt Workspace Resolver 的通用工作树验证部分。后续生产化时改为中性命名，不在 P0 扩大变更。

## 第二轮结论与修正

- 阻断：文件写权限事件携带了 TaskHub 禁止的 `actionDigest`。已改为只有命令和数据外传事件携带动作摘要；真实 Adapter → Runtime Host → Runtime Monitor → TaskHub Attempt 文件清单 → `allow_once` 集成测试通过。
- 阻断：真实 Windows ACP 结果只有文字摘要。已保存可复跑命令和脱敏 stdout 到 `evidence/omp-acp-windows-smoke-20260902.txt`，不保留私有 vendor session。
- 阻断：默认 PATH 探针无法证明固定 npm 包入口。已增加仅由显式测试环境开关启用的固定 `bunx --bun @oh-my-pi/pi-coding-agent@18.1.2` 探针分支；普通发现不会下载或联网。
- 阻断：Runtime Composition 没有 OMP 专项断言。已使用注入探针证明 OMP 被发现和注册，同时确认未启动 Transport、未改变 Kimi 默认生产路由。
- 中风险：工作区准备和 Transport 创建曾位于失败保护之外。已纳入结构化失败边界。
- 低风险：权限用途曾依赖工具标题关键词。已改为读取 ACP `kind` 与位置字段的确定性映射，不再猜测标题。

## Windows 生命周期复审

- 代码审查复跑稳定捕获：ACP `initialize` 与 `session/new` 已成功，但 `taskkill` 返回后立即删除临时状态目录偶发 `EPERM`。
- 修正：Transport 在 Windows 上等待进程树终止后，继续等待目标 child `close` 和 stdio 关闭；测试清理只为系统短暂延迟释放的 SQLite/WAL 句柄提供最多 2 秒有界重试，真实泄漏仍会失败。
- 同一条显式真实 OMP lifecycle smoke 在修正后连续 3 次通过，每次 `1 passed | 6 skipped`，三轮总退出码 `0`。

## 最终代码复审

- 结论：`WATCH / APPROVE`，无阻断项。
- 保留一项非阻断观察：新的权限集成测试中有两处 test-only `as unknown as`；它们不绕开被验证的生产边界，后续再次修改该测试时收窄类型。
- `.omo/evidence` 是本机临时审查工作区，不进入提交；本阶段的仓库内权威交接由本文件、QA、脱敏 evidence 和 `DEVELOPMENT_STATUS.md` 共同组成。
- 本阶段没有使用或依赖外部 Notepad 文件；全部验收证据均已纳入上述仓库路径，因此不存在需要补交的 Notepad 证据路径。

## 最终规格门

- 结论：`PASS / APPROVE`，无阻断项。
- 规格门确认 OMP 仅为测试批准、生产创建 fail-closed、Kimi 默认路由不变、TaskHub 权限真实链路与 Windows ACP lifecycle 证据闭合，并确认未触碰 WORK、Renderer、Worker、资源或包清单。
- 残余项均为下一生产门内容：真实模型修改和 Diff/交付对账、重启恢复、设置 UI、受信安装/完整性清单及离线打包；不能据此把 P0 解释为生产可用。

## 复审边界

最终测试结果、未完成项和提交 SHA 记录在 `DEVELOPMENT_STATUS.md`。代码审查通过只表示本 P0 候选可提交到独立分支；人工批准前仍不是生产 Runtime，也不得合入正式产品线。
