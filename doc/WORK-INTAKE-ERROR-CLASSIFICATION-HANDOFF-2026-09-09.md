# WORK intake 分析错误分类交接

## 状态与基线

- 已完成：分析错误分类最小修复与离线红绿验证；阶段候选，未验收、未进入主线、未发布。
- 施工树：`E:/CodexWorktrees/xiaogui-work-doc-analysis-stability-v2`，分支 `codex/work-word-doc-converter-v1`，起点 `e3f4842c45bda3d4333fe011f9bac51b515db46c`。
- 安装证据基线：`7d18334860a86653e1c5aef480c7608cea3b1919`。该版本与施工起点的 Worker intake 分析文件一致。
- 本次不是新能力或框架开发：保留 Pi 0.84.1 原生 ExtensionContext / ModelRegistry 调用，只纠正既有专用工具校验异常的分类；不增加 Skill、插件、模型配置或重试机制。

## 已证实与未定

证据：`E:/XiaoguiInternalCandidate/installed-7d18334-20260909/intake-outcome.json`、`model-binding-evidence.json`。

- 锁定合成 DOCX SHA-256：`4983f085dd243b81e1b61bb1774b5e23bfcd4f21a6544582da6b86df5224df55`。
- 外层 DeepSeek 有 toolUse，唯一 intake START 已生成 1 表、10 候选的 DRAFT；不是 DOC 转换失败或工具不可见。
- 桌面负责人从同一固定报告 `xgti1_784b07d2-1f2c-49e4-857f-649077d2db40` 补取：`versions.model=deepseek/deepseek-v4-flash-vision-exp`，警告全文为“临时模型分析不可用，已安全降级”。因此已排除无模型和无文本两个降级入口，定位到 Worker 分析 catch；这不证明供应商失败，也不证明模型绑定错误。
- 原调用没有提供内部异常类型、首轮/repair 阶段或 stopReason，具体根因仍未定。保留最初 Anthropic 403 和内部分析降级证据，不重新调用模型猜测。
- `canMaterializeTemplate=false` 是报告 DRAFT 默认状态，不作为独立故障证据。

实际调用链：

```text
外层模型 → intake.execute START → Host DOCX 解析/分批
→ ANALYSIS_REQUIRED → analyzeBatches
→ context.modelRegistry.complete(context.model, 独立 Prompt + batch)
→ 最多一次 repair → 输出校验
→ Host START(reportId, analysis) → DRAFT / warning / versions.model
```

同一个模型 toolCall 内部有两次 Host 请求，不代表两次模型 START。共享会话选型/绑定与安装包由桌面负责人负责，本次未修改。

## 最小修复

`src/worker/xiaogui-work-docx-template-intake-tool.ts` 中，文本定位校验可抛出 `MODEL_SELECTION_NOT_FOUND` 或 `MODEL_SELECTION_OVERLAP`，repair 后仍失败时进入最终 catch。原分类漏掉 `MODEL_SELECTION_`，错误归为 `MODEL_UNAVAILABLE`。

仅将该前缀纳入既有输出错误分类，返回 `MODEL_OUTPUT_INVALID`。schema、模型调用参数、一次 repair、取消和正式复核门均不变。该缺陷可以确定性复现，但未证明是安装现场这次异常的原因。

## 验证

- 红：`npx --no-install vitest run src/worker/xiaogui-work-docx-template-intake-tool.test.ts -t 'repairs only once then reports invalid model output'`，修复前 2 failed / 1 passed / 15 skipped；两项失败均为预期 `MODEL_OUTPUT_INVALID`、实际 `MODEL_UNAVAILABLE`。
- 绿：同命令修复后 3 passed / 15 skipped。
- 回归：扩充原有工具 execute→Host analysis 接缝，覆盖非法 JSON、文本不存在、文本重叠及 repair 请求抛供应商错误；模拟供应商失败仍返回 `MODEL_UNAVAILABLE`，均只调用两次模型桩。
- `npx --no-install vitest run src/worker/xiaogui-work-docx-template-intake-tool.test.ts`：19 passed。没有真实模型请求。
- `npx --no-install tsc -p tsconfig.node.json --noEmit`：exit 0；`git diff --check` 通过。
- 未重跑 Word、Office、安装包或模型闭环；本修复不关闭安装候选的真实模型分析验收。

## 代码定向复验（2026-09-09）

- 桌面/WORK 主管对固定范围 `e3f4842c45bda3d4333fe011f9bac51b515db46c…0c8819a2ef7075e3c7bb0416073116d6543f3b20` 给出 Standards APPROVE（0 项问题）、Spec APPROVE（0 项问题）。仅为代码定向批准，不是安装验收或发布批准。
- 主管确认真实注册工具 execute→分析校验→Host 断言，四类失败和两次模型桩行为成立；schema、调用参数、一次 repair 和取消行为未变。
- 原始红绿及类型检查输出仅在本 WORK 任务工具/终端历史中，没有独立 `.log` 文件。原始输出标识：`e568ef`（09:59:50，2 项红）、`683ca1`（10:00:06，聚焦绿）、`1e12d1`（10:00:34，19 项绿）、`0430e2`（独立 Node 类型检查 exit 0）。主管已从本任务 rollout 独立读取这些输出；本文件仅记录摘要，不替代原始输出。
- 主管复核本地/远端 `0c8819a2ef7075e3c7bb0416073116d6543f3b20` 一致、工作树干净、diff-check 通过；复验没有重跑测试、模型、Word 或 Office。
- 安装现场内部异常仍未定；缺失历史异常不能推断其根因是本次分类缺陷。

## 下一步（定向复验后）

将本提交作为独立分类修复交给总控组合，安装包仍由唯一桌面负责人生成。若需要解决现场内部异常，须有该调用已有的脱敏内部错误分类/阶段证据；缺失则标明无法回溯，不以本次单元绿灯宣称现场故障已修复。
