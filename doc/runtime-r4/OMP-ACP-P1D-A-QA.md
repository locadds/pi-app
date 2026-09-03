# OMP ACP Runtime P1D-A 验证记录

## 阶段结论

P1D-A 在独立分支上完成了“完整依赖闭包受信装配、原子激活、私有存储配置接缝，以及安装暂时不可用时的持久结果回放”。当前只是待人工验收的阶段候选：没有合并主线、没有切换默认 Runtime、没有接入 Renderer，也没有制作 Portable。

双轴只读审查已经完成。Spec 首轮提出的“缓存后关键 native 篡改可能漏检”和“UNKNOWN 被进程缓存”均已修复并通过最小追加回归；最终 Spec 阻断数为 `0`，Standards 轴无阻断或新增 smell，独立代码质量复审为 `CLEAR` / `APPROVE`，最终阶段门禁为 `APPROVE`。完整记录见 `OMP-ACP-P1D-A-REVIEW.md`。

## 固定清单

`OmpRuntimeBundleManifestV1` 固定以下事实，并以自身摘要封口：

- OMP：`@oh-my-pi/pi-coding-agent@18.1.2`
- 上游 revision：`86bf72f52947f62ecaf9bd28e35572812e725a92`
- npm archive URL 与 SHA-512 SRI：沿用 P1B 已验收信任根
- 启动入口与安全参数：沿用 P1C 已验收 ACP 接缝
- 完整依赖锁摘要：`sha256:eaee273001814f97cb4657730ee0f9715d1d6b298e9cdf67f7a69a4db0fa9e57`
- 完整树摘要：`sha256:b1e7aacadfc4791ab7cd092e17b96bfb15781f7b220bfc7eabb7a6d430f98591`
- 文件：`24,230`
- 目录：`2,144`（含根目录）
- 文件字节总量：`802,081,247`
- 关键原生依赖：固定 `@oh-my-pi/pi-natives`、`@oh-my-pi/pi-natives-win32-x64` 和 Windows x64 native 文件的路径、大小与 SHA-256
- manifest digest：`sha256:bde8dfedbf673246e328395d8c000aa666de77c69444150ab632a610155261a6`

清单不含本机绝对路径。仅版本号相同、缺依赖、关键 native 缺失或任意内容漂移的目录均不能通过完整树门。

## 装配与激活行为

1. 用户选择的大体积资产目录只进入主进程私有配置，不进入 Renderer 可见的通用设置、TaskHub 契约或模型会话。
2. 装配前先验证源目录完整树，再根据实测文件/目录数量和目标文件系统块大小计算暂存空间；空间不足时不开始复制。
3. 源目录与目标目录重叠、符号链接、非普通文件、超出文件数或体积上限均拒绝。
4. 复制到同一目标文件系统内的 `.staging-*` 后再次做完整树校验；通过后才改名为不可变版本目录并写入私有回执。
5. 活动指针只保存版本目录名和摘要，不保存绝对路径。指针替换失败或替换后的回读校验失败时恢复旧指针；失败的新版本和暂存目录会清理，旧版本不删除。
6. Runtime 启动只从已激活、重新通过完整树门的目录解析 OMP 入口；OMP 自身不从 PATH 获取。Bun 仍沿用已验收的独立引擎探针，只接受绝对可执行路径和最低版本门。
7. 一次进程生命周期内只缓存成功的完整树核验；每次启动检查仍重新读取活动指针和回执，并重新计算所有关键文件摘要。活动版本变化会触发新一轮完整树核验，关键文件漂移立即失效；失败不缓存。显式 `fresh` 检查和进程重启也会重新核验完整树。

## 持久恢复行为

- 恢复库新增 `request_id` 查询接缝，并对 P1C 旧表执行幂等迁移与回填。
- `createOrResume` 在尝试检查安装或启动新进程前，先按 request id 查询持久绑定。
- 完全相同且已结算的请求直接返回原 Runtime session 的持久终态；成功结果仍用 TaskHub 当前结果树复核 `candidateDigest`。
- 已绑定但未结算的请求返回 `OUTCOME_UNKNOWN`，不会检查安装、创建传输、解析 Prompt 或重新派发，也不会把 UNKNOWN 永久缓存；持久库后来结算后，下次相同请求可以回放新终态。
- 同一 request id 携带不同请求体时返回 `IDEMPOTENCY_CONFLICT`。
- `inspect` 与 `stream` 在内存会话不存在时可以读取持久终态；安装暂时不可用不会抹掉已经结算的业务结果。

## 实际 D 盘门

源依赖闭包：`D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike`。

激活根：`D:\CodexCache\xiaogui-omp-p1d-a-activated\xiaogui\agent-runtime\omp-v18.1.2`。

实际激活结果：

- 活动目录：`bundle-48cbae4e583ab47f09ef1942ee5162bf`
- activation receipt digest：`sha256:48cbae4e583ab47f09ef1942ee5162bf5cd0aad7db9f9c678b24955fceedda2d`
- tree digest：与固定 manifest 完全一致
- 回执计数：`24,230` 文件、`2,144` 目录、`802,081,247` 文件字节
- 残留暂存目录：`0`
- 激活目录额外只有一份约 900 字节的私有回执；源缓存与激活副本合计约 1.60 GB 文件字节，均位于 D 盘

真实门命令：

```powershell
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE='1'
$env:XIAOGUI_OMP_P1D_REAL_BUNDLE_ROOT='D:\CodexCache\xiaogui-omp-runtime-18.1.2-spike'
$env:XIAOGUI_OMP_P1D_STORAGE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-activated'
$env:XIAOGUI_OMP_P1D_STATE_DIRECTORY='D:\CodexCache\xiaogui-omp-p1d-a-state'
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts
```

结果：`1 test file passed`，`4 tests passed`，退出码 `0`，耗时 `179.96s`。真实步骤包括源完整树核验、复制、暂存完整树复验、活动目录检查、固定入口版本探测和 ACP `initialize`；没有发送模型 Prompt，也没有复测 OMP/Bun 上游测试。

## 最终聚焦验证

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-runtime-storage-config.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts src/main/xiaogui/agent-runtime/omp-trusted-installation.test.ts src/main/xiaogui/task-hub/runtime-composition.test.ts
npm run typecheck
git diff --check
```

结果：

- 聚焦测试：`6 test files passed`，`27 tests passed`，`4 tests skipped`；跳过项均为需要显式真实外部环境的门控用例。
- Web/Node TypeScript：退出码 `0`。
- 差异检查：退出码 `0`；仅有 Windows LF/CRLF 提示。

规格审查提出关键文件缓存与终态回放问题后，又执行一次只覆盖修复接缝的回归：

```powershell
npm run test:unit -- src/main/xiaogui/agent-runtime/omp-runtime-bundle.test.ts src/main/xiaogui/agent-runtime/omp-acp-production.test.ts src/main/xiaogui/agent-runtime/omp-acp-adapter.test.ts
node node_modules\typescript\bin\tsc -p tsconfig.node.json --noEmit
```

结果：`3 test files passed`，`14 tests passed`，`3 tests skipped`；Node TypeScript 退出码 `0`。该轮包含“已缓存后篡改活动 critical native 仍立即拒绝”和“UNKNOWN 后来结算可由同请求回放”的新增断言。

没有运行仓库全量测试、OMP 上游测试、模型旅程、Electron 窗口旅程、WORK/Office 测试或 Portable 构建。

## 未完成与已知风险

1. P1D-B 的目录选择 UI、安装进度、失败提示和单机试用入口尚未实现；当前私有配置服务与 composition 参数只是主进程接缝。
2. 当前装配器接收已经准备好的完整闭包目录并对其做固定清单验证；自动下载、解包或离线发布资源不属于 P1D-A。
3. 每次新版本或强制替换都保留旧激活目录，暂未实现磁盘清理策略；这是为了可恢复性，P1D-B 必须先展示空间影响再允许清理。
4. 完整树校验成本约数分钟，因此同一进程缓存一次成功的完整树结果；每次启动仍会重验活动指针、回执和关键文件。缓存期内非关键依赖发生外部篡改，要到活动版本切换、显式 fresh 或进程重启时才会由完整树门发现。
5. 原子指针采用同文件系统临时文件加 rename，并在回读失败时恢复旧内容；没有宣称抵抗断电后的所有文件系统异常。
6. P1D-A 不改变默认 Runtime。只有未来受控入口同时提供 `ompProductionEnabled` 与主进程私有存储目录时才会选择该候选；缺目录明确 fail-closed。
