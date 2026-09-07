# C2 Desktop 制品安装候选交接

日期：2026-09-07

分支：`codex/desktop-c2-artifact-install-v1`

基线：`b55b236a1e1a3c8ee1da745f07855aeb1de5e062`

固定社区合同：`locadds/xiaoguishequ@71a2b9fc3c510865d80d9675d1ca5b2c3fc67fe4`

## 已完成

- 首次启动 argv、Windows/Linux second-instance 与 macOS open-url 共用同一 `xiaogui://install/{installIntentId}?nonce=...` 分发器；主进程未就绪时按到达顺序暂存。
- 先以设备身份读取非消费式 preview，渲染层只看到名称、版本、摘要、权限和兼容性；nonce、ticket、registryRef、签名、公钥、本机路径和凭据不进入 Renderer。
- 只有本机明确确认后才 claim；ZIP 只经 Hub `/api/v2/download-tickets/{ticket}` 代理下载，不直接访问 Nexus/registryRef。
- 主进程验证 SHA-256、固定 keyId/公钥、Ed25519 签名、版本/模式兼容性、ZIP 数量/大小/路径/大小写冲突/链接类型/入口点和静态文件策略，再以同父目录 staging 原子替换。
- Skill 只安装到当前 Pi Agent 全局 `skills/{artifactId}`，完成后调用现有 Worker resource reload；不写项目、Session 或 TaskHub 状态。
- App 只允许根 `index.html` 和静态资源，通过 `xiaogui-app://` 独立无持久化 partition 打开；Node、preload、Shell、文件系统 IPC、权限请求、默认网络和外部导航均关闭。
- C2 artifact receipt 使用独立持久 FIFO；只有精确 ACK 的 `eventId` 同时匹配实际提交 id 和当前队首才删除。没有读写 H1 receipt/state 文件。

## 聚焦验证

- `npx vitest run src/main/xiaogui/c2/deep-link-dispatcher.test.ts src/main/xiaogui/c2/install-coordinator.test.ts src/main/xiaogui/c2/archive-installer.test.ts src/main/xiaogui/c2/receipt-outbox.test.ts`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

## 尚未验收

- 未启动 Electron、未注册真实系统协议、未做真实 Hub/Community 安装、未做真实 Skill 刷新、未打开真实静态 App。
- 未做两机、LAN、Nexus 故障注入、真实 safeStorage 或打包安装程序验证。
- 本候选未进入主线、未合并、未发布；C3、Apply、H1 状态机和用户项目均不在本次范围。

## 下一授权门

由独立验收者在干净候选上完成一次真实 Electron 本机安装旅程：Hub 创建 intent → 浏览器协议唤起 → preview → 取消不 claim；再创建新 intent → 确认 → Skill/App 安装 → 重启后检查独立回执重放。通过前不得合并或发布。
