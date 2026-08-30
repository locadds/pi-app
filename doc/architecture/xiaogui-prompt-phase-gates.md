# 小规 Prompt 阶段门禁覆盖与技术债

版本：v1
日期：2026-08-30

## 当前已由代码强制的范围

Worker 将“候选工具注册”和“本轮工具激活”分开。ResourceLoader 可以注册模式兼容的候选扩展；每条用户消息到达后，`xiaogui.turn-capability-selector.v1` 使用结构化 Context、唯一的 `DEFAULT` 能力和原始用户输入生成冻结的 Turn Context，再由 Agent Session 的 `setActiveToolsByName()` 形成 Provider 实际看到的 Tool Schema。

`ASK`、`PLAN` 的最终集合只保留 Pi Core `read` 与明确只读的 `xiaogui_read_pdf`。`bash/edit/write`、未知或混合动作的 `design_*`、协作计划、标准文档、模板整理、模板物化和模板生成工具均不进入最终 Tool Schema。该门禁使用 Pi SDK 正式接缝，不依赖模型遵守 Prompt。

`EXECUTE` 也不会开放所有已注册工具：工具所属 Capability 必须在当前模式中允许，且来自结构化 Context、`DEFAULT` 或本轮本地确定性选择；工具还必须真实注册、工作区条件满足。Manifest 使用同一冻结 Context 和 Session 当前 active tools，只记录真实交集。

## 当前 Host Gate 总账

| 工具来源 | 工具 | 当前控制 | 技术债 |
|---|---|---|---|
| Pi Core | `read` | ASK/PLAN/EXECUTE 均可保留 | 无 |
| Pi Core | `bash`、`edit`、`write` | ASK/PLAN 由 `setActiveToolsByName()` 从最终 Schema 移除；仅 CODING+EXECUTE 且本轮选择 `coding.workspace` 时激活 | 无阶段门禁遗留 |
| Worker Builtin | `xiaogui_read_pdf` | `work.file-organize` 的明确只读工具；ASK/PLAN 可激活 | 无 |
| Worker Builtin | Word、模板、协作工具 | 仅 EXECUTE 且对应非默认能力被显式/本地规则选中时激活 | 无阶段门禁遗留 |
| Project Extension | `design_*` | ASK/PLAN 全部不激活；DESIGN+EXECUTE、本轮选中且 Runtime 实际注册时才激活 | 单个 EXECUTE 工具内部仍可能有多种 action；其参数和业务确认门仍由各工具实现，不由 Prompt 推断 |

## 现阶段风险处置

1. Runtime Facts 明示当前阶段、工作区、信任状态、真实 active tools 和有效能力，不把“候选已注册”描述成写入授权。
2. `ALLOWED` 不自动激活；普通 Word 整理、自有模板、标准报告、纯文字和协作输入由离线规则区分。
3. 混合或跨模式输入可以放弃判断；未被可靠选择的高风险能力不会预激活。
4. 运行中的 Turn 使用冻结 Context；新消息不能在同一 Turn 中更换 active tools。
5. 离线测试验证 ASK/PLAN 最终 Schema、P01—P16 原始输入、跨模式 Worker 复用时 active tools 与 Manifest 同步更新。
6. Word 确认流只有在对应 `PREPARE` / `START` 工具返回精确的成功结果后，才保留一个下一轮可消费的 sticky Capability；只有意图、未调用工具、工具失败、用户取消或挂起均不会保留。新明确意图优先，消费、模式变化、切换 Session 或重建 Runtime 后清除。

## 真实遗留

- 本地选择器刻意保守；新增业务表达必须先扩充离线 Fixture，不使用在线模型兜底。
- `PREPARE → CONFIRM` 等业务级动作仍由工具状态机和人工确认门控制；Host Phase Gate 只决定工具是否进入本轮 Schema，不替代工具内部状态校验。一次性续接能力仅依据 Pi 真实工具生命周期和精确成功结果提交，不依据模型回复或意图推断提交。
- `design_*` 在 EXECUTE 阶段的 action 级读写边界仍由各扩展负责；若未来需要在同一工具内按 action 动态裁剪，应拆分工具或增加参数级 Host Gate。
