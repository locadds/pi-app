# OMP ACP Runtime P1D-A 复修验证记录

## 阶段结论

候选 `a9377a22e531cc55e06b40917e103217c6e71c93` 于 2026-09-03 被人工验收拒绝，不能进入 P1D-B。拒绝指出：Windows native 实际加载可逃逸到用户全局缓存、版本冲突会误删旧活动版本、完整树缓存会掩盖非关键可执行依赖漂移、词法路径检查可被 junction 绕过，以及 Pi/Skill/插件复用调查记录不完整。

本轮只修复这些 P1D-A 阻断，不进入 Renderer/P1D-B，不切换默认 Runtime，不触碰 WORK、主线、模型旅程或 Portable。当前仍是独立分支阶段候选，提交推送后继续等待人工验收。

## 拒绝项修复

### 1. Windows native 加载闭包

- 固定 manifest 现在显式绑定 Windows x64 baseline native 的相对路径、文件名、大小和 SHA-256。
- 激活事务在同一用户选择的存储根下创建与 activation receipt digest 绑定的 `native-cache-v1/native-<digest>`，从已经完成全树验证的 staging runtime 复制 native，并在原子改名前复验大小和摘要。
- `XDG_DATA_HOME`、`USERPROFILE`、`HOME`、`LOCALAPPDATA`、`APPDATA`、`TEMP`、`TMP` 和 `PI_NATIVE_VARIANT` 全部指向该回执绑定目录；OMP loader 的首选版本缓存因此不再是 `%USERPROFILE%\.omp`。
- OMP 生产进程使用封闭环境，只保留固定 allowlist 中的必要系统变量和上述受控目录；`NODE_OPTIONS`、`NODE_PATH`、Bun/OMP 用户缓存变量及其他父进程变量不会继承。
- 固定入口执行 `--version` 前、正式 ACP spawn 前，均重新核对活动 pointer、源 native 和缓存 native；任何一处漂移都 fail-closed。
- 真实 Windows 测试在 ACP `initialize` 后读取进程模块表，断言实际加载的 `pi_natives.*.node` 正是回执绑定缓存文件，且不是当前用户全局 `%USERPROFILE%\.omp\natives\18.1.2` 文件。

### 2. 版本冲突清理所有权

`activatedRoot` 只在本事务成功把 staging 改名为候选目录后才取得所有权。确定性版本目录已经存在时返回 `OMP_RUNTIME_BUNDLE_VERSION_CONFLICT`，`finally` 不再删除该既有目录；旧 pointer、旧 native 和旧 inspector 均保持可用。

### 3. 完整树漂移

删除了单进程成功结果缓存。每次生产 `inspect()` 都重读 pointer/receipt/state 并重算 24,230 个文件的完整树摘要；非关键 JavaScript/可执行依赖在两次启动之间被修改时，下一次检查立即拒绝，不再只复验少量 critical 文件。

### 4. junction 物理重叠

装配前先把源与目标的最近已存在祖先解析为物理路径，再追加尚未创建的路径段。目标目录或其祖先是 junction/symlink 且物理落点与源重叠时，在 verifier 和复制之前返回 `OMP_RUNTIME_BUNDLE_ROOT_OVERLAP`。

所有可写内部目录（`versions`、私有 state、native cache）都改为逐级、非递归创建：每一层在写入前检查最近既有祖先，创建后立刻确认物理父子关系。测试不仅断言拒绝 junction，还断言 junction 指向的外部目录没有收到任何文件，避免“先写穿、后报错”的假安全。

### 5. 并发装配与失败清理所有权

- 同一 storage root 使用一个小型 SQLite 锁文件，并以 `BEGIN EXCLUSIVE` 覆盖完整装配事务；即使两个请求使用不同 private state，也不能同时发布同一版本或 native cache。
- SQLite/OS 在进程退出或连接关闭后自动释放锁，不使用自制“超时即删除”的锁文件，不会误删仍在工作的进程锁。
- 锁文件在交给 SQLite 前先通过 `lstat`、`realpath` 和同根校验；预放置的 junction/symlink 会在写入前拒绝。
- candidate 和 native cache 只有在本事务实际创建后才获得清理所有权。pointer 提交前的晚期失败会清理本事务新资源并保留旧活动版本；既有版本、既有缓存和其他事务资源不会被删除。

## 固定清单与 D 盘事实

- OMP：`@oh-my-pi/pi-coding-agent@18.1.2`
- 上游 revision：`86bf72f52947f62ecaf9bd28e35572812e725a92`
- 完整树：24,230 文件、2,144 目录、802,081,247 字节
- tree digest：`sha256:b1e7aacadfc4791ab7cd092e17b96bfb15781f7b220bfc7eabb7a6d430f98591`
- native：175,602,176 字节
- native SHA-256：`bdfdc8abaebd2feede9d9756059da7d50ec4e2bba4b82cc91310ab22444f895e`
- 新 manifest digest：`sha256:d7240a13aa2ef236285d34112b253de19472591a888d78a8aa4cbca7c146c1f3`
- 本轮 activation receipt digest：`sha256:f59461266044eef3b01adda27311bf690ab5d7f8c4bba812ec9aaedb5ab98d44`
- 实际活动 bundle 文件字节（含约 900 字节回执）：802,082,147
- 实际回执绑定 native 缓存：175,602,176 字节
- 源、活动 bundle、native 缓存和私有 state 均位于 D 盘；本轮没有向 C/E 盘写入新的运行时副本。

## Pi 原生、Skill 与插件优先门

本轮重新按根 `AGENTS.md` 和 ADR 实查，而不是只读名称或 README：

1. **Pi/小规原生接缝**：现有 `AcpProcessTransportFactoryV1` 已负责进程启动，`preSpawn` 已负责启动前受信检查，TaskHub 已负责 Attempt、权限、工作树、结果对账和恢复。本轮直接复用这些接缝，只把 `preSpawn` 扩展为可等待的校验，并增加“不继承父环境”的可选项；没有新建 Agent Loop、安装状态机或权限系统。
2. **Pi Skill**：仓库内置 Skills 在 Pi Worker 启动后提供 Prompt/流程指导，无法在 OMP native `require` 之前约束子进程环境、解析 Windows 模块加载路径或校验二进制摘要，不能解决本次供应链/进程隔离缺口。
3. **Pi 插件/Extension/Package**：现有 Coding Extension Pack 与 TaskHub 接缝同样运行在 Agent/会话层；OMP 固定 package 自身的 `loader-state.js` 实查证明 Windows 会优先复用版本缓存。插件配置不能给该上游 loader 增加回执校验。最小可行接缝因此是既有 ACP Process Transport 的环境与 `preSpawn`，而不是另引插件框架。
4. **真实验证**：封闭环境用真实子进程证明父进程敌意 sentinel 不会继承；固定 OMP 18.1.2 用真实 ACP 进程模块表证明加载文件来自回执绑定缓存。该证据直接验证了上述能力缺口与最小适配。

## 测试证据

### 拒绝项红灯

新增回归首次运行得到 `3 failed / 3 passed / 1 skipped`：分别复现旧版本被删除、非关键可执行依赖漂移被缓存掩盖、junction 绕过。生产 Adapter 的 native 环境测试首次也返回 FAILED，证明旧实现只传入 `PI_CODING_AGENT_DIR`。

### 修复后聚焦验证

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts src/main/xiaogui/agent-runtime/acp/kimi-tool-policy.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
```

最终结果：`5 test files passed`，`46 tests passed`，`3 tests skipped`，耗时 `12.16s`。覆盖版本冲突保留、非关键完整树漂移、启动前全树复验、受控目录重定向、junction 写前拒绝且外部目录无写入、不同 state 的同根并发互斥、SQLite 锁释放、晚期失败资源清理、native 缓存篡改、封闭父环境、Adapter 兼容及生产 composition。

聚焦集合的一次中间运行发现 contract-test 路径误用了 production native 环境（`1 failed / 43 passed / 3 skipped`）；修复为 contract-test 保持原 `PI_CODING_AGENT_DIR` 后，上述最终集合全绿。该失败没有被当作完成证据。

封闭父环境用例证明子进程看见受控 `XDG_DATA_HOME`，看不见父进程敌意 sentinel。

```powershell
npm run typecheck
git diff --check
```

结果：Web/Node TypeScript 退出码 `0`；差异检查退出码 `0`，仅有 Windows LF/CRLF 提示。

### 新的 D 盘真实门

```powershell
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE='1'
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE_ROOT='D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike'
$env:XIAOGUI_OMP_P1D_STORAGE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-resubmit'
$env:XIAOGUI_OMP_P1D_STATE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-resubmit-state'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts
```

最终结果：`1 test file passed`，`15 tests passed`，退出码 `0`，耗时 `64.67s`。这次在已经激活的 D 盘真实闭包上执行最终代码，验证每次启动的完整树与全部受控目录复验、ACP initialize、Windows 模块表精确加载路径、用户全局缓存排除，以及把回执绑定 native 改动一个字节后的拒绝和恢复；没有重新复制闭包，也没有发送模型 Prompt。

该 D 盘目录此前由同一复修过程完成过一次全新装配，彼时结果为 `8 tests passed / 136.45s`，包含源、staging、活动闭包与 native cache 的实际复制和三段核验。最终 `15 tests / 64.67s` 是当前代码的消费与篡改门证据，不能被表述为又做了一次 802 MB 全新安装。

## 未完成与风险

1. P1D-B 的目录选择、进度、空间提示、错误恢复和单机试用 UI 尚未开始。
2. 自动下载、解包、更新、离线资源和 Portable 不属于本阶段。
3. 完整树每次启动都重新验证；最终真实消费门耗时 `64.67s`。后续若优化，只能以操作系统不可变性或等价证据替代，不能恢复“缓存一次、只验少量文件”。
4. 旧活动版本和旧 native 缓存暂不自动清理；后续必须在展示空间影响后由用户确认。
5. 既有 `omp-trusted-installation` 为 P1B/P1C 兼容证据仍保留；P1D 生产 composition 使用新的完整闭包模块。为消除少量摘要/回执逻辑重复而重构不属于本次阻断修复。
6. storage-root SQLite 锁只负责装配互斥与崩溃释放，不宣称修复底层文件系统损坏；原子 rename 与回读恢复也不宣称覆盖断电和底层文件系统损坏的所有情形。

## 下一步

独立 Standards、Spec、代码质量复审及最终只读阶段门禁均已无阻断。提交并推送当前独立分支后停在人工验收门；人工明确放行前不得进入 P1D-B。
