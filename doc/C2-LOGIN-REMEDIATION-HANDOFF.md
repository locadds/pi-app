# C2 桌面无会话登录整改交接

## 追加：Skill目录BOM兼容（2026-09-07）

固定起点 `1987be39c3a90c90085f34c934b75a30c1b3abca`。名称识别增量候选待只读复验：唯一产品差异在pi-resources-editor.ts解析前仅移除内存文本的一个首BOM，原文件不写回。新增skill-catalog-bom.test.ts沿真实读取→命令目录检查名称、描述、回退及原字节不变；旧实现1失败1通过，修后2/2，typecheck/build/diff-check通过。

复用评估：锁定Pi公开parseFrontmatter/stripFrontmatter不处理BOM，直接改用它不能解决该问题，且会扩大原解析语义，因此保留现桌面解析规则。没有升级包或修改node_modules。

重要未完成项：公开loadSkillsFromDir只读加载A原测试skill-01（与B落盘同SHA）返回空skills和description is required。它在core/skills.js读原文后直接调用同一解析器，因此名称列表修复不能被当作Pi发现/Worker加载成功。此发现已回报验收协调任务，尚未修Worker适配、尚未调用模型；不能仅凭新slash名称宣布C2使用链路完成。不改签名ZIP或已安装文件来消除BOM。

- 日期：2026-09-07
- 来源：C2 桌面独立实施 Agent
- 结论：本次登录增量独立代码复验 APPROVE，Standards 0、Spec 0；未做两机重验、未合并、未发布。
- 已审产品 SHA：`2aa7d453d25dbd775aa44c6974c4a7443d0351d4`。2026-09-07 验收协调任务确认；本次登记只改文档，产品 SHA 不变。
- 基线：`1756a2c2fbee9786f875314186ccaa8ed5935789`
- 分支：`codex/desktop-c2-login-remediation-v1`

## 改动

`CollaborationHubPanel` 无会话分支挂载既有 `HubTaskInboxSection`，不伪造 scope。该组件的 address 变为可选；无 address 只读取本机连接状态并提供现有用户名、密码、Hub 地址表单，不读取收件箱、不开放任务按钮；创建计划函数再次检查 address。

复用既有主进程 connect。配对只发生于用户提交表单；挂载、刷新页面与会话切换不调用 connect。服务器决定 subjectId、同账号旧节点撤销、系统加密存储与 C2 全局安装弹窗均未改动。网页和桌面继续需要同一 Hub 的同一 installer 密码账号。

## 验证

- `node node_modules/vitest/vitest.mjs run src/renderer/src/xiaogui/components/HubTaskInboxSection.test.tsx src/renderer/src/xiaogui/components/CollaborationHubPanel.test.tsx`：2 文件、34 用例通过。
- 新增覆盖：无 canonical 会话时面板登录可见且不调用任务计划 IPC；无会话显式登录成功；无会话不读任务、不生成计划；切换至真实会话后保留任务按钮；切回和重挂载不会重新配对。
- `npm run typecheck`：通过（web 与 node 两项目）。
- `npm run build`：通过；构建报告既有动态/静态 import 同时引用的打包提示，无构建失败。
- `git diff --check`：通过。
- 依赖通过新工作树的 node_modules junction 复用原候选依赖；未安装/升级依赖，未修改原验收源码、LAN 数据库、账号、节点或乙机。

## 下一步

将固定提交交 C2 验收协调任务只读复验。通过后再由总协调制作乙机更新包；本候选测试不代表真实 Hub 配对或两机安装已通过。
