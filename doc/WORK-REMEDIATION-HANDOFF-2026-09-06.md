# WORK 单机文档稳定性与验收交接

更新日期：2026-09-07。状态：实施中，未晋级或发布。

## 固定基线与分工

- 仓库：`https://github.com/locadds/pi-app.git`。
- 基线：`a60041e3bd7a8a3c34b41547da05d42755f7a696`，开工时远端同名候选一致。
- 施工分支：`codex/work-document-stability-v1`。
- 隔离工作树：`D:\CodexWorktrees\xiaogui-work-document-stability-v1`。
- 原候选工作树存在独立 Timeline 修复的未提交改动，本次未触碰。
- WORK 负责 Gateway、Viewer、Office Main 保存接缝；CODING 负责共享能力矩阵与激活；总控负责根构建、资源装配、集成和验收。模块同时施工，统一提交后固定验收 SHA。

## 复用结论

Pi 0.84.1 的 Resource Loader、`additionalSkillPaths`、`setActiveToolsByName` 和原有 Host 工具即可承载能力选择。Skill 无法修复已观察到的 Gateway 写盘失败先推进内存状态，故在现有保存接口内修复提交顺序与并发，未增加通用事务平台。根构建直接复用 `build:office`。

## 验收记录

- LibreOffice：既定脚本从已校验的 D 盘安装包缓存重新装配；`verify-libreoffice-runtime.mjs` 返回 `LIBREOFFICE_PACKAGING_GATE_OK 26.2.5 f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9`。
- 干净依赖：本工作树独立 `npm ci --ignore-scripts`，不使用历史 `node_modules` junction；安装后补运行构建与必要原生装配。
- 保存、能力、干净资源、真实模型旅程、安装包结果将在各门执行后按实际结果补充。

## 当前模块状态

| 项目 | 状态 | 后续 |
|---|---|---|
| W-01 保存一致性 | NOT_RUN | 修复与故障注入、并发、重启验证 |
| W-02 自然语言文档流程 | NOT_RUN | 共享能力修复后在固定 SHA 上运行真实模型 |
| W-03 首次启动资源 | NOT_RUN | 无历史 Office 产物启动与资源加载 |
| 完整安装包 | NOT_RUN | 完整本地装配后测试新配置 |

完成里程碑以保存可靠和固定版本真实文档闭环证据为准。安装包单独验收，人工批准后晋级。
