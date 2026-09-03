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

本次复用调查针对的是一个窄而明确的契约：**在外部 OMP ACP 子进程执行其 Windows native `require` 之前，完成活动回执绑定、父环境隔离、完整依赖树复验，并在启动后证明实际加载模块来自同一受信缓存**。普通 Skill 发现、Pi Package 安装或命令沙箱不能被当作这一契约已经满足。

### 实际候选、来源与验证结论

| 优先级 | 实际检索对象与固定来源 | 实际验证 | 采用或拒绝结论 |
|---|---|---|---|
| Pi 原生 | `@earendil-works/pi-coding-agent@0.84.1`；Git revision `53fa77ccd8a279eb87e92294ef3687b03ff80112`；MIT；npm SRI `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==`。实查了 `DefaultResourceLoader.additionalSkillPaths`、`loadSkills`、Extension/Package loader 与 Bash `spawnHook`；能力说明以 [Pi Extensions](https://pi.dev/docs/latest/extensions)、[Pi Packages](https://pi.dev/docs/latest/packages) 和 [Pi Security](https://pi.dev/docs/latest/security) 为准。 | 当前锁定包直接执行 `loadSkills`，发现 `internal-comms`、`xiaogui-work-documents`，`diagnosticCount=0`。类型与实现核对表明 `spawnHook` 只属于 Pi 自身 Bash Tool 的进程入口。 | **复用** Resource Loader、Agent Loop、Extension/Package 机制；**不用于** OMP 启动信任门。OMP 是 TaskHub 经 `AcpProcessTransportFactoryV1` 启动的外部 ACP Runtime，不是模型调用 Bash Tool 产生的命令；把它改走 Bash Tool 会绕开既有 Attempt/Runtime 绑定，也仍不能证明完整树和实际 native 模块。 |
| 已安装/可引入 Skill | `xiaogui-work-documents`：小规第一方 Skill，以代码基线 `f1034ac5ee944ded4f63518e536ee602a636d128` 固定；`internal-comms`：`anthropics/skills@53048666b05b4799081517d00e09e0a2dd688678`，Apache-2.0。来源与边界见 `doc/architecture/xiaogui-bundled-pi-skills.md`。 | 既有真实 Electron Catalog 证据为两项均 `enabled/effective=true`、`diagnostics=[]`；本轮又用当前 `0.84.1` Resource Loader 做只读发现冒烟，两项均成功且无诊断。 | **保留并复用**，但二者都是会话启动后的 Prompt/流程说明。前者只指导 WORK 文档工具选择，后者只指导内部沟通写作；均没有外部进程、文件树摘要、Windows 模块表或启动前环境控制能力。未找到能关闭本次受信闭包缺口的已装 Skill。 |
| pi.dev Extension/Package | 最接近“安装/管理固定包”的候选是 [`pi-package-manager@0.2.1`](https://pi.dev/packages/pi-package-manager)；Git revision `903e14ec2f52871cd8baf83f3104e894d69a04f7`；MIT；npm SRI `sha512-AoVjV3TJKIkhwPOuiLAwahNyDGER4W2yztM+jlgh3J4YLd0Dj8ThnFO3NE+LkpDjZ8aFOzJTNrLdtXVyIszhsg==`；Node `>=18`；Pi peer dependency `>=0.74.0`。 | 在 D 盘缓存执行 `npm pack`：tarball `25,049` 字节、解包 `103,750` 字节、9 项文件。实查 `extensions/index.ts` 与 `src/server.mjs` 后，用当前 Pi Extension loader 加载：`extensionCount=1`、命令为 `packages`/`packages-stop`、`errorCount=0`；未调用安装、浏览器或网络命令。 | **不采用为 P1D 装配器**。它通过本地面板调用 `pi install/remove` 管理 Pi Package source；不接收 OMP 完整树清单，不签发小规 activation receipt，不约束 OMP loader 的 Windows native 缓存，也不核对已加载模块路径。把它套在 OMP 外面仍需重写相同的受信闭包逻辑。 |
| pi.dev 安全候选 | [`pi-sandbox@0.6.6`](https://pi.dev/packages/pi-sandbox)；`carderne/pi-sandbox`；MIT；npm SRI `sha512-KHL+/JJ9eX0znStRLnZtzeSgp6MdM1gvg+aB8EQDlqZZuFn4n3vLDzW+1xR1M9aSa7C+mP6JMAG9MA05sRfeaQ==`。 | 官方候选页明确使用 macOS `sandbox-exec` 或 Linux `bubblewrap`；当前目标是 Windows x64，因此在平台门即拒绝，没有执行不适用的安装冒烟。 | **不采用**。即使未来有 Windows 后端，命令隔离也不等于供应链证明：它不会固定 24,230 项 OMP 闭包、签发/核对回执或证明 `pi_natives.*.node` 的实际来源。 |
| 已批准成熟开源 Runtime | `@oh-my-pi/pi-coding-agent@18.1.2`；Git tag `v18.1.2`；revision `86bf72f52947f62ecaf9bd28e35572812e725a92`；MIT；npm SRI `sha512-azsUetojUyT2e+CyDPun2LgFrCts8FtnvBlbPrzYj6Y7UbRIkdebqhNZVhMrOrueNnRsLetqcrY8EPomxTlvCg==`；Bun `>=1.3.14`。 | P0/P1 已完成真实 ACP `initialize`；P1D-A 的 15 项 D 盘真实门进一步读取 Windows 进程模块表，证明加载的 `pi_natives.*.node` 精确来自回执绑定缓存，篡改后启动前拒绝。 | **采用 OMP 本体，不复制其实现**。上游 `loader-state.js` 会优先使用用户版本缓存，OMP 自身没有小规所需的活动回执、完整树、TaskHub Attempt 或 D 盘存储契约；因此只在宿主现有 Transport/`preSpawn` 增加最小信任接缝。未批准、未切换到其他 OMP 版本。 |
| 院内既有能力 | 小规 `AcpProcessTransportFactoryV1`、`preSpawn`、TaskHub Attempt/权限/工作树/结果对账/恢复，代码基线 `f1034ac5ee944ded4f63518e536ee602a636d128`。 | 46 项聚焦回归和 15 项真实 D 盘门已覆盖启动前复验、封闭环境、实际加载路径、篡改拒绝和恢复；详见下节。 | **采用并最小扩展**：`preSpawn` 可等待验证，Transport 可选择不继承父环境；没有新增 Agent Loop、权限系统、Package 市场或第二套任务状态机。 |

### 候选冒烟账

1. 当前 Pi Skill 发现冒烟：输出 `skills=[internal-comms,xiaogui-work-documents]`、`diagnosticCount=0`。
2. `pi-package-manager@0.2.1`：先按固定版本与 SRI下载到 `D:\CodexCache\xiaogui-p1d-a-reuse-candidates`，再做源码核对和只加载不执行的 Extension 冒烟；结果 `1` 个 Extension、`2` 个命令、`0` 个加载错误。包管理命令、浏览器和本地服务均未执行。
3. 当前 Pi 包的根运行时导出不提供 `loadExtensions`；候选冒烟只借用该固定版本内部 loader 观察注册结果，不把内部路径变成产品接缝，也不新增对它的依赖。
4. `pi-sandbox@0.6.6` 因官方平台矩阵不含 Windows，在平台门终止；这属于可验证的不适用结论，不以“网页可访问”冒充功能冒烟。
5. OMP 真实进程证据沿用本阶段已经完成的 D 盘门，没有为文档补录重复复制 802 MB 或再次运行 46 项回归。

实际执行命令如下；输出只保留能力结果，不把候选缓存绝对路径写进产品公开契约：

```powershell
npm view @earendil-works/pi-coding-agent@0.84.1 version gitHead license dist.integrity repository.url engines --json
npm view pi-package-manager@0.2.1 version gitHead license dist.integrity repository.url engines peerDependencies dependencies --json
npm view pi-sandbox@0.6.6 version license dist.integrity repository.url --json
npm view @oh-my-pi/pi-coding-agent@18.1.2 version license dist.integrity repository.url engines --json

node --input-type=module -e "import { loadSkills } from '@earendil-works/pi-coding-agent'; const r=loadSkills({cwd:process.cwd(),agentDir:'D:/CodexCache/xiaogui-p1d-a-pi-candidate-smoke/agent',skillPaths:['resources/pi-skills'],includeDefaults:false}); console.log(JSON.stringify({skills:r.skills.map(s=>s.name).sort(),diagnosticCount:r.diagnostics.length},null,2)); if(r.diagnostics.length!==0) process.exit(1);"

$env:npm_config_cache='D:\CodexCache\npm-p1d-a-reuse-candidates'
npm pack pi-package-manager@0.2.1 --json --pack-destination D:\CodexCache\xiaogui-p1d-a-reuse-candidates

node --input-type=module -e "import { pathToFileURL } from 'node:url'; const m=await import(pathToFileURL(process.cwd()+'/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')); const p='D:/CodexCache/xiaogui-p1d-a-reuse-candidates/pi-package-manager-0.2.1/package/extensions/index.ts'; const r=await m.loadExtensions([p],process.cwd()); const commands=r.extensions.flatMap(e=>[...e.commands.keys()]).sort(); console.log(JSON.stringify({extensionCount:r.extensions.length,commands,errorCount:r.errors.length},null,2)); if(r.errors.length) process.exit(1);"
```

### 缺口与最小框架例外

复用调查后的缺口不是“没有 Package Manager”，而是没有候选能够在**既有 TaskHub Runtime 调度与外部 ACP spawn 之间**同时提供：固定 OMP 完整树、活动回执、Windows 用户缓存隔离、启动前逐次复验和启动后实际模块路径证明。Skill 编排发生得太晚；Pi Package 管理的对象和回执契约不同；非 Windows sandbox 不适用；OMP 本体则正是被复用但需要受控启动的对象。

因此最小例外限定为既有 `AcpProcessTransportFactoryV1` 的 `preSpawn` 与环境装配，以及 P1D-A 的受信 bundle/receipt 检查；TaskHub、Pi Agent Loop、Extension/Skill 发现和 OMP 本体均保持原权威。两项 LOW 观察——`omp-runtime-bundle.ts` 的职责集中、七项受控环境目录字段聚集——登记为后续维护风险，本阶段不为它们扩大重构。

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

P1D-A 功能与 Spec 已通过人工复验；人工 Standards 指出的复用调查文档门已按上表补齐，现等待再次复验。提交并推送当前独立分支后停在人工验收门；人工明确放行前不得进入 P1D-B。
