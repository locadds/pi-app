# WORK DOC 分析稳定性后续交接

状态：施工候选，未验收、未进入主线、未发布。日期：2026-09-08。

## 基线与范围

- 冻结输入 `c1adfd44514ccea622185a9bee028adcf99dd441`，原 WORK 树不改。
- 唯一施工树 `E:\CodexWorktrees\xiaogui-work-doc-analysis-stability-v2`，分支 `codex/work-doc-analysis-stability-v2-e1`。
- D 盘新树独立依赖安装因 ENOSPC 失败，清理被策略拒绝；跨卷 worktree move 失败后，采用在 E 新建独立分支方案。D 失败现场保留，不称已经清理。
- 仅完善既有 DOC 分析 Prompt，不修改状态机、schema、repair 次数、Pi Harness、Office 默认、CODING、Hub 或安装包配置。最终桌面 owner 另行集成，不制作第二套 NSIS。

## 真实缺口与最小改动

旧安装版报告 `xgti1_ae81de16-d424-4555-b2e5-ce2ca7316f76` 的原始子模型输出和具体错误未保存，因此不能将旧 probe 的缺字段名问题认定为该次失败原因。

本轮用相同合成 DOC 通过真实系统选择器及 intake START 复现首次输出不合格：3 条 VARIABLE 均缺 `suggestedName`。当前精确 repair 收到 `MODEL_SCHEMA_SUGGESTED_NAME_REQUIRED: suggestion[1] kind=VARIABLE` 后，补齐全部 3 项并通过验证，形成 8 候选报告（3 VARIABLE、2 EXCLUDE、3 FIXED）。这证明当前 repair 接线有效，不证明旧二次失败已经复现或关闭。

现有 Prompt 的唯一 JSON 示例是 EXCLUDE，没有展示可变字段的必填名称。最小候选将子模型资源升级到 `1.2.2`，增加可被实际 validator 验证的 VARIABLE 示例，并明确每个 VARIABLE/REPEAT/CONDITIONAL 都必须有非空名称。示例偏向是否导致模型漏填属于待验证推断，不宣称确定因果。schema 与现有一次 repair 完全保留。

复用：沿用锁定 Pi 0.84.1、原生 Skill 发现、已有 intake 子模型/工具与 LibreOffice 转换；不引入新的通用能力或依赖。Skill 不能替代私有子模型已有的输出契约，此次仅完善该资源的说明与示例。

## 本地证据

- 证据根 `E:\CodexTemp\xiaogui-doc-stability-20260908`；`submodel.jsonl` 仅记录限定合成材料的文本与校验错误，不记录模型思考或认证。临时诊断已移除，不进入交付代码。
- DOC 10752 字节，SHA-256 `9051da51717e0d9afa5c2457638260e0b1200ec157bcf9b26c2ede90f9111898`；E 副本与旧样本一致。
- 模型 `deepseek/deepseek-v4-flash-vision-exp`，沿用现有模型配置，没有固定 Kimi 或使用 OMP。
- 基线真实会话：Pi sessions 的 `--E--CodexTemp-xiaogui-doc-stability-20260908-inputs--/2026-09-08T05-52-00-623Z_01a07f92-c66f-7480-8550-dfb59325d63e.jsonl`。
- E 独立 npm ci 成功，1197 包；Electron 原生模块装配及本树 build（含 Office）成功。
- 固定 LibreOffice 26.2.5 MSI 经 SHA-256 校验后在 E 独立解压，msiexec 退出 0；通过既有 XIAOGUI_LIBREOFFICE_PATH 使用。原准备脚本强制 D 缓存且重建共享解压目录，本轮未运行、未修改，也未借其他树构建产物。
- 模块测试：原 intake 15 项通过；新增示例测试先因无 VARIABLE 示例失败，修改后 intake/Catalog 2 文件 19 项通过。此类测试不是模型稳定性或真实旅程通过的替代。

## 待完成

新 Prompt 的真实 DOC 分析、原生 Skill 使用、正式复核、模板或成品输出、修改保存与关闭重开；最终源 SHA、产物摘要及未覆盖项。只有该旅程完成后再向总控提交验收证据。
