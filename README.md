<div align="center">

<img src="resources/icon.svg" alt="小规 Agent 图标" width="80" height="80" />

# 小规 Agent

面向日常工作、文档处理和编码协作的桌面智能助手。

[![内部试用版](https://img.shields.io/badge/内部试用版-0.3.0--rc.1-c0392b?style=flat-square)](https://github.com/locadds/pi-planning-agent)
[![许可证](https://img.shields.io/badge/许可证-MIT-green?style=flat-square)](package.json)

</div>

## 小规是什么

小规把自然语言对话、文件处理、人工确认、执行记录和多智能体协作放进同一个桌面应用。用户只需要说明目标；当操作涉及读取资料、修改文件、调用外部智能体或形成正式交付时，小规再展示必要的确认与复核界面。

小规基于开源 [pi](https://github.com/jvm/pi-mono) 应用能力进行二次开发，保留其会话、模型和扩展生态，同时增加 WORK、CODING、本机应用中台以及未来的小规节点互联能力。第三方来源与许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 0.3.0-rc.1 能做什么

- WORK：读取和整理资料、按已标记 Word 模板生成文档、把普通成品 Word 整理为候选模板并由用户复核。
- CODING：把自然语言需求变成可审阅的计划、执行记录、验证证据和可恢复的变更。
- 本机应用中台：以任务为中心管理执行尝试、人工门禁、验证和交付。
- 多运行时接缝：已建立统一注册和确定性路由；Kimi 保持现有生产行为，Scripted Adapter 用于证明可替换性，Qoder 当前仅诊断登记，Codex HEADLESS 必须经精确版本和显式批准才能装配。

本版不包含正式 DESIGN 产品能力、公开任务市场、积分、礼品、社区平台和真实局域网节点通信。DESIGN 只保留接口；局域网小规互联在后续施工包中接入。

## 使用原则

- 自然语言是主入口，不为每个能力堆放首页按钮。
- 涉及文件写入、数据外传或跨节点执行时，必须经过本机用户批准。
- 中央任务中枢只选择小规节点；具体智能体由目标小规在本机按能力、健康状态和数据策略选择。
- 原文件默认保留，正式产物另存；失败时不得伪装为成功或静默换用其他智能体。

## 本地开发

```powershell
git clone https://github.com/locadds/pi-planning-agent.git
cd pi-planning-agent
npm install
npm run dev
```

发布前只需运行与变更相关的聚焦检查、`npm run typecheck`、`npm run build`，再在 E 盘生成 Windows x64 Portable。内部试用版默认不自动查询更新，安装包和便携包以本仓库明确发布的版本为准。

## 兼容性说明

为避免破坏既有会话、设置、扩展和用户数据，部分内部存储键、事件名、包名和适配器协议仍保留 `pi-desktop` 标识。这些是兼容接口，不会作为小规的用户可见品牌；后续如需迁移，将通过带版本的数据迁移完成。
