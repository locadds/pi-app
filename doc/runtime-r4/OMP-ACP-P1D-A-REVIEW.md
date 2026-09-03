# OMP ACP Runtime P1D-A 审查记录

## 审查结论

- Standards 轴：无阻断、无新增工程 smell；实现继续复用既有 OMP/Pi、TaskHub、摘要和并发工具，没有引入第二套运行框架、权限系统或恢复状态机。
- Spec 轴：首轮发现的两个阻断均已修复，复审后阻断数为 `0`。
- 独立代码质量复审：状态 `CLEAR`，建议 `APPROVE`，无阻断项。
- 最终阶段门禁：`APPROVE`，无真实阻断；允许提交并推送本分支，随后必须停在人工验收门。
- 产品状态：P1D-A 仍是独立分支阶段候选。本记录只支持提交并推送当前分支，不授权合并、切换默认 Runtime、进入 P1D-B、发布或触碰 WORK 主线。

## 审查范围

- 基线：已验收 P1C `9728eafdb67d0aea8a2f9e52fd6f315f4e4e7692`
- 分支：`agent/runtime-r4-omp-acp-p1d-a-v1`
- 范围：完整 OMP 依赖闭包清单、验证、装配、原子激活、私有存储配置、生产启动消费活动回执、持久请求恢复及相应聚焦测试和阶段记录
- 排除：Renderer/P1D-B、WORK、默认 Runtime 切换、主线合并、模型旅程、Electron 窗口、Portable、自动下载和无关全量测试

## Spec 首轮发现与修复

### 1. 完整树缓存可能漏掉活动关键原生文件的后续篡改

首轮实现会缓存一次完整树成功结果。如果活动目录中的关键 native 在缓存建立后被外部修改，同进程后续启动可能复用缓存而未立即发现。

处理结果：缓存命中时仍重新读取活动 pointer、receipt 和私有 state，并重新计算 manifest 中全部关键文件摘要。pointer 或 receipt 变化触发完整树复验；关键 native 漂移直接 fail-closed。新增测试先建立缓存，再篡改活动 native，确认不使用 `fresh` 也会拒绝。

复审结论：阻断解除。

### 2. 持久 UNKNOWN 被进程缓存，已结算结果不能在后续同请求中显现

首轮恢复路径把持久记录统一包装成 READY，并可能把未结算 UNKNOWN 放入进程缓存。这会让持久库后来结算后，同一 request id 仍看不到真实终态。

处理结果：已结算持久记录直接回放原 SUCCEEDED/FAILED/CANCELLED 终态；SUCCEEDED 继续复核当前 TaskHub 结果树摘要。未结算记录直接返回 UNKNOWN，但不进入进程缓存；持久库后来结算后，同一请求下一次读取会得到新终态。整个路径仍先于安装检查、进程创建和 Prompt 读取。

复审结论：阻断解除。

## Standards 复审

- 受信检查的新增逻辑保持在同一 bundle 模块职责内，并复用既有摘要、并发和安全相对路径工具。
- Adapter 只缓存终态；UNKNOWN 直接返回，职责与持久恢复库边界清楚。
- 未发现绝对路径、凭据、私有会话编号或原始内部命令进入公开契约。
- 未发现复制 OMP/Pi/TaskHub 能力、无关抽象、跨层依赖或范围扩大。

结论：无 Standards 阻断或 smell 记录。

## 独立代码质量复审

独立复审者逐块检查装配事务、活动指针、完整性门、SQLite 迁移、恢复顺序和 composition 边界，并复跑聚焦测试。最终状态为 `CLEAR`，建议 `APPROVE`。

三项 LOW 观察明确留到 P1D-B 或后续受控维护，不构成 P1D-A 阻断：

1. 多进程同时安装的跨进程锁尚未实现。
2. 活动安装损坏后的用户可见修复/重装入口尚未实现。
3. 原子 rename 与回读恢复不宣称覆盖断电和底层文件系统损坏的全部情况。

这些边界已在 QA 和 `DEVELOPMENT_STATUS.md` 中记录，不应为本阶段提前扩展 Renderer 或安装管理范围。

## 验证证据

- 最终聚焦集合：`6 test files passed`，`27 tests passed`，`4 tests skipped`。
- Spec 修复后的最小追加回归：`3 test files passed`，`14 tests passed`，`3 tests skipped`；Node TypeScript 退出码 `0`。
- Web/Node 类型检查：退出码 `0`。
- 真实 D 盘完整闭包装配和 ACP initialize：`4 tests passed`，退出码 `0`；24,230 文件、2,144 目录、802,081,247 字节，残留暂存目录 `0`。
- 独立代码复审者另行复跑聚焦集合后未发现新增失败；Standards/Spec 两位审查者在最终修复后未重复运行测试，以代码和既有证据复审。

## 最终建议

P1D-A 的实现、证据、双轴只读审查和最终阶段门禁均满足阶段候选提交条件。提交并推送后应核对本地 HEAD、远端 SHA 与干净状态，再交给用户人工验收。人工放行前停止在 P1D-A，不进入 P1D-B。
