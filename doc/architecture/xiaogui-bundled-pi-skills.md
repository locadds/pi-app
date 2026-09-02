# 小规安装包内置 Pi Skills

- 状态：实现候选；开发窗口 Skill Catalog 已确认，等待正式安装包、真实模型任务与人工验收
- 日期：2026-09-02
- 适用版本：`@earendil-works/pi-coding-agent@0.84.1`
- 上位决策：[`ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md`](../adr/ADR-PI-NATIVE-SKILL-PLUGIN-FIRST.md)

## 结论

小规直接复用 Pi 的 Resource Loader 与标准 `SKILL.md` 发现机制。源码中的 Skill 放在 `resources/pi-skills/`；开发环境传入该目录，打包后由 Electron Builder 复制到 `process.resourcesPath/pi-skills`，Main 在 Worker 初始化消息中传递路径，Worker 只把它设置为 Pi `DefaultResourceLoaderOptions.additionalSkillPaths`。

本实现没有增加 Skill 注册表、中央文档类型路由、公开 IPC、Agent 可见 Tool 或重试状态机。Skill 只指导模型理解意图和组合现有工具；文件格式、安全门与受控本机读取仍由各工具负责。

```text
resources/pi-skills/*/SKILL.md
          │
          │ electron-builder extraResources
          ▼
process.resourcesPath/pi-skills
          │ Main 私有 Worker init
          ▼
Pi additionalSkillPaths → Resource Loader → 模型按需 read(SKILL.md)
```

WSL Worker 使用既有 `windowsPathToWsl` 把同一安装目录映射成 WSL 可读路径，不复制第二套 Skill，也不改变 Skill 内容。

## 第一批内置项

| Skill | 来源 | 许可 | 采用理由与边界 |
|---|---|---|---|
| `xiaogui-work-documents` | 小规自编 | 项目内部资源 | 指导模型按“读取/归纳/模板整理报告/正式模板”意图选择现有 WORK 工具；扩展名只作提示，工具验证真实格式。PDF 只允许读取、分析和只读模板整理报告，不允许直接生成可编辑正式 Word 模板。 |
| `internal-comms` | `anthropics/skills@53048666b05b4799081517d00e09e0a2dd688678` | Apache-2.0 | 提供内部状态汇报、项目更新、FAQ、简报和事件说明格式；除清理一处行尾空格外保留上游内容，许可证随包交付。它不增加连接器、网络权限或自动发送能力。 |

第三方精确来源与分发说明同时登记在仓库根 `THIRD_PARTY_NOTICES.md`。

## 候选审查结果

### `can1357/oh-my-pi`

在 `18781d829586fff77af98b222728b5b29bcaba41` 实查到的三项项目 Skill 是 `semantic-compression`、`system-prompts` 和 `tool-prompt-optimization`，均为开发者 Prompt/压缩元能力，没有面向最终用户的 PDF、DOC 或 DOCX 文档 Skill。其 PDF 支持位于重写的运行时 `read` 工具，不是可独立嵌入 Pi 的 Skill；`tool-prompt-optimization` 还依赖 Bun、`@oh-my-pi/pi-ai` 与仓库内脚本。因此本阶段不引入 oh-my-pi，也不为取得其 PDF 能力替换小规/Pi 运行时。

### `anthropics/skills` 的 PDF/DOCX

上游 PDF 与 DOCX 目录使用限制复制、修改与再分发的 source-available 条款，不满足安装包嵌入条件，所以未复制。`internal-comms` 自带 Apache-2.0 许可证，可追溯且不需要额外运行时，故作为首个第三方通用 Skill。

## 约束与完成门

1. 新 Skill 或插件仍须先固定官方来源、commit/version、许可证、依赖和 Windows/离线行为。
2. 不把扩展名关键词分类器写进框架；模型依据 Skill/工具说明理解任务，各工具验证文件头和结构。
3. 工具选错时优先使用 Pi Agent Loop 和明确错误完成一次纠正；没有复现证据前不建设自定义状态机。
4. Pi 只把 Skill 名称、描述和位置加入发现上下文，并按需读取正文；产品 Prompt 六层顺序与既有预算门保持不变。
5. 自动测试必须覆盖源码与打包路径、Pi 真实发现无诊断、Worker `additionalSkillPaths` 接缝和 PDF 正式模板边界。
6. 最终验收还需在真实开发窗口或目录包中确认 Skill 可发现，并用无敏感内容的任务验证模型按意图调用现有工具；自动测试不能代替人工批准。
