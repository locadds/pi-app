# OMP ACP Runtime P1D-A 复修审查记录

## 当前结论

- 首次候选 `a9377a22e531cc55e06b40917e103217c6e71c93` 已于 2026-09-03 被人工拒绝；本记录不沿用首次候选的批准结论。
- Spec 复审：`APPROVE`，当前代码阻断数 `0`。
- Standards 复审：`APPROVE`，当前代码无 Standards 阻断。
- 独立代码质量复审：`CLEAR / APPROVE`，无阻断项。
- 最终阶段门禁：`APPROVE`，未发现真实阻断；只授权提交并推送当前独立分支，随后停止等待人工验收。
- 产品状态：P1D-A 仍是独立分支复修候选，不授权进入 P1D-B、合入主线、切换默认 Runtime、发布或触碰 WORK。

## 审查范围

- 复修基线：被拒绝候选 `a9377a22e531cc55e06b40917e103217c6e71c93`
- 分支：`agent/runtime-r4-omp-acp-p1d-a-v1`
- 范围：实际 native 加载闭包、版本冲突与资源清理所有权、每次启动的完整树复验、junction 写前拒绝、跨进程装配互斥，以及直接相关的 Adapter、Process Transport、测试和阶段记录
- 排除：Renderer/P1D-B、WORK、默认 Runtime、主线合并、模型 Prompt、Electron 窗口、Portable、自动下载和无关全量测试

## 人工拒绝项闭环

### 1. 实际 native 加载逃逸出受信闭包

首次候选只设置 `PI_CODING_AGENT_DIR`，但子进程继承用户环境；OMP 18.1.2 的 Windows loader 会优先复用 `%USERPROFILE%\.omp\natives\18.1.2`，该文件在活动回执之外。

复修后：

- manifest 固定 Windows x64 native 的相对来源、文件名、大小和 SHA-256；
- 激活事务在所选 storage root 内生成 activation receipt 绑定的 native cache；
- OMP 生产进程使用封闭 allowlist 环境，`XDG_DATA_HOME`、用户目录和临时目录均指向受控目录，不继承 `NODE_OPTIONS`、`NODE_PATH` 或用户 OMP/Bun 缓存变量；
- 固定入口版本探测和每次真实 ACP spawn 前，重新验证完整活动树、pointer/receipt、源 native、缓存 native 和所有受控目录；
- Windows 真实进程模块表断言实际加载文件精确等于 D 盘回执缓存，且不等于用户全局缓存；缓存单字节篡改会在启动前拒绝。

Spec 复审结论：阻断解除。

### 2. 版本冲突可能删除旧有效版本

首次候选在发现目标版本目录已经存在后返回冲突，但 `finally` 仍可能删除该目录。

复修后，事务只在 staging 成功 rename 为 candidate 后取得 candidate 清理所有权。`VERSION_CONFLICT` 不取得所有权，也不会删除旧版本。native cache 同样记录事务所有权；pointer 提交前晚期失败只清理本事务新建资源。

Spec 复审结论：阻断解除。

## Standards 复审追踪

独立 Standards 审查先后发现并推动关闭以下同一安全边界问题：

1. 完整树验证必须位于真实 `preSpawn`，不能只在较早 inspector 阶段完成。
2. `preSpawn` 还必须复验全部受控进程目录和最终 pointer/receipt 绑定。
3. native cache 的发布与清理必须有事务所有权，不能出现共享缓存删除竞态。
4. 不采用可误判存活进程的自制 stale-lock；改为 SQLite/OS 管理的排他事务。
5. 锁必须以 storage root 为作用域，不得因 private state 不同而绕过。
6. SQLite 打开锁文件前必须检查预放置 junction/symlink 和实路径。
7. 递归 `mkdir` 可能先写穿 junction 再报错；所有可写目录改为逐级、非递归、写前和写后实路径校验。

最终 Standards 结论：`APPROVE`，当前代码无阻断。保留的非阻断观察只有模块较长及少量受控环境字段聚集；本轮为消除此类 smell 扩大重构反而会增加风险。

## 独立代码质量复审

独立审查者逐块核对当前 `a9377a22...` 之后的复修差异，结论为 `CLEAR / APPROVE`，没有 CRITICAL、HIGH 或 MEDIUM 项。其确认：受信回执到 native cache、`preSpawn` 和封闭环境的链路完整；完整树不再依赖成功缓存；junction/重叠根/锁数据库具备写前门；同一 storage root 的 SQLite 排他锁覆盖装配事务；失败清理遵守资源所有权；contract-test/非生产路径未被生产门破坏。

两项 LOW 观察不阻断本阶段：

1. `installFrom()` 的 `finally` 若遇到极端锁释放失败，会让 Promise reject，而不是返回结构化失败结果。
2. 旧活动版本若缺失或损坏回执绑定 native cache，当前会安全停止而不会自动修复；用户可见重装/修复入口属于 P1D-B，不能在本轮提前扩展。

## 验证证据

- 拒绝项红灯：新增 bundle 回归首次 `3 failed / 3 passed / 1 skipped`；生产 native 环境用例亦先失败，证明问题可复现。
- 最终聚焦集合：`5 test files passed / 46 tests passed / 3 tests skipped`，耗时 `12.16s`。
- Node/Web TypeScript：退出码 `0`。
- `git diff --check`：退出码 `0`，仅 Windows LF/CRLF 提示。
- 最终 D 盘真实门：`1 test file passed / 15 tests passed`，退出码 `0`，耗时 `64.67s`；在已激活闭包上验证当前代码的全树/受控目录门、ACP initialize、实际模块路径、全局缓存排除和 native 篡改拒绝。没有发送模型 Prompt。
- 同一复修过程较早已完成一次全新 D 盘装配（`8 tests passed / 136.45s`）；最终 15 项运行复用该活动闭包，不冒充第二次 802 MB 全量复制。

详细命令和 D 盘体积总账见 `OMP-ACP-P1D-A-QA.md`。

## 未完成与最终建议

最终 13 个文件已精确暂存、暂存外差异为 `0`，最终只读阶段门禁结论为 `APPROVE`。当前只允许提交并推送本独立分支；提交后必须停在人工验收门。人工再次放行前，不得进入 P1D-B。
