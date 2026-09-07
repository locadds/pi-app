# C2 桌面无会话登录整改交接

- 日期：2026-09-07
- 来源：C2 桌面独立实施 Agent
- 结论：代码候选，待独立只读验收；未做两机重验、未合并、未发布。
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
