# WORK 文档能力装配证据

- 日期：2026-09-07
- 施工基线：`a60041e3bd7a8a3c34b41547da05d42755f7a696`
- 状态：阶段候选；自动化验证结果见下文，真实模型与安装包验收由总控在集成 SHA 上记录。

## 原因与复用结论

原 WORK 矩阵仅把 `work.file-organize` 标记为 DEFAULT。标准 Word、模板整理和模板生成标记为 ALLOWED；每轮仅匹配到固定词语才激活。因此 Skill 已被发现，也无法选择未进入当轮工具集合的文档工具。

实查锁定的 `@earendil-works/pi-coding-agent@0.84.1`：原生 Resource Loader 的 `additionalSkillPaths` 接受内置 Skill 路径；`AgentSession.setActiveToolsByName()` 只激活注册表中存在的工具，并重建 System Prompt。现有小规 Worker 已在每轮调用这个接口，WORK 没有 CODING 专用 `tool_call` 硬门，原生 `read` 可以读取已发现的 Skill 正文。

采用现有 Pi 原生工具注册/激活/Skill 加载及内置 `xiaogui-work-documents`。此次缺口是小规已有矩阵提前隐藏能力，Skill 或另装插件不能替 Host 修改该矩阵；无需新增插件、工具、加载器、中央格式路由或 Agent Loop。前期第三方 Skill/插件选型记录继续见 `doc/architecture/xiaogui-bundled-pi-skills.md`；本次没有新增供应链项目。

## 最小实现

`packages/shared/xiaogui-prompt-matrix.ts` 将现有三个 WORK 文档能力改为 DEFAULT，Host 默认清单从同一矩阵派生；矩阵、Registry、选择器版本为 `1.2.0`。既有本地意图结果仍用于兼容诊断、协作及其他模式，不再决定 WORK 文档能力是否可见。

每轮仍经 `Mode × Phase × Capability × 已注册工具` 筛选，再交给 Pi 原生 `setActiveToolsByName()`。EXECUTE 提供八个工具（含原生 read），ASK/PLAN 仅保留 read、PDF 读取和资料读取。CODING/DESIGN 模式及其已有默认项不变。文件任务仍允许没有工作区或未信任项目的会话通过既有用户选取/授权处理文件；本次没有把项目信任当成文件授权，也没有放宽 Host 工具门。

新增共享工具规则：单独“继续”等普通会话延续不算正式复核、生成或保存批准。模板物化说明已与当前 Host 对齐：必须取得预览按钮私有令牌，聊天确认不能替代。没有新增聊天关键词授权器。

Host 核对：

- 标准报告 `work-report-docx-service.ts` 从当前 Session 查找 PREPARED 记录，并拒绝 PREPARE 同一 Run 的 CONFIRM；它不解析用户确认文字，模型的明确确认行为需真实负例验收。
- 模板物化 `work-docx-template-materialize-service.ts` 验证当前操作的私有预览确认令牌；无令牌、伪造令牌和取消后的令牌均不能完成保存。
- 原始文档格式验证、正式复核状态、另存及来源不覆盖规则由原工具继续执行。

## 自动化验证

隔离环境 npm 安装期间，先执行不依赖该安装的只读探针：

- 已有稳定工作树的同版 Pi 0.84.1 SDK 实际执行 `loadSkills → createReadTool.execute`，读取当前施工目录的文档 Skill：发现两项 Skill、0 diagnostics，正文包含意图指导与 PDF 边界。该结果仅证明原生接口可复用，不冒充干净环境验收。
- Node 25 原生 TypeScript 类型擦除直接加载当前源代码，四种正常改述/“继续”均提供四个 WORK 默认能力、八个工具；ASK/PLAN 仅三个只读工具。
- 实际调用当前 `buildXiaoguiPromptSessionStateV1`：八个文档工具产品层 2139 字，连 custom-system 工具兼容层 6191 字，Runtime Facts 193 字；另含获准协作工具时合计 6625 字，Facts 216 字。上限仍为 7000/600。

独立 `npm ci` 成功后执行 Vitest，最终 14 个相关文件共 141 项通过：

```powershell
node node_modules/vitest/vitest.mjs run packages/shared/xiaogui-prompt-capabilities.test.ts packages/shared/xiaogui-prompt-matrix.test.ts src/main/xiaogui/prompt-context.test.ts src/worker/xiaogui-prompt src/worker/handlers/worker-handlers-turn.test.ts src/worker/handlers/worker-runtime-tool-registry.test.ts src/worker/xiaogui-bundled-skills.test.ts src/renderer/src/xiaogui/components/WorkHomeView.test.tsx src/main/__tests__/pi-prompt-catalog-effective.test.ts --reporter=dot
node node_modules/vitest/vitest.mjs run src/main/__tests__/pi-prompt-catalog-effective.test.ts src/main/xiaogui/work-report-docx-service.test.ts src/main/xiaogui/work-docx-template-materialize-service.test.ts --reporter=dot --maxWorkers=3
```

首轮 12 文件 134 项中仅 Catalog 旧版本期待值失败；更新为已修改的 Registry/Capability `1.2.0` 后重跑该文件和两个 Host 服务测试，3 文件 10 项通过。其余已通过文件未重复跑。覆盖公开选择器正常改述、阶段限制、真实 Worker 每轮激活和 Manifest、原生 Skill 发现及 read 正文、完整 custom SYSTEM 工具规则组装和摘要、现有 Host 确认/取消回归。`git diff --check` 通过。

没有用这些离线测试声称模型已经实际选择工具；真实模型调用、完整 typecheck 和集成构建由总控执行并记录。

## 集成验收待办

总控在固定集成 SHA 上执行干净环境启动、真实模型文档闭环和安装包验收。特别记录：用户说“继续”时没有未授权的正式操作；换正常说法仍能选择文档工具；PDF 只生成只读报告，不进入正式 Word 模板物化。本文件的自动化验证不替代该验收。
