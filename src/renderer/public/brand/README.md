# 小规产品品牌资产

本目录只收录已经批准的小规 A 方案生产成品，以及带明确临时状态的 C3 院标底纹扩展。产品代码不从概念图、预览图或 AI 校验图取样。

## 来源

- `production-v1.0/`：来自 `小规Hub-A方案-v1/生产标准包-v1.0/可直接使用`，以同目录 `asset-manifest.json` 为哈希与用途依据。
- `provisional/c3-institute-v0.2/`：来自 `小规Hub-A方案-v1/院标融合临时稿-v0.2`，以同目录 `asset-manifest.json` 为依据；院标源仍是 160px 位图，不是正式矢量母版。

## 尺寸规则

- 16–64px：一律使用 `production-v1.0/app-icon/` 中的核心图标，不显示院标底纹。
- 32px 及以下：同时使用微型/简化核心图标，禁止 C3。
- 128px、256px 和 1024px：数字界面或自适应图标的大尺寸层可以使用 `provisional/c3-institute-v0.2/`。
- 标题栏、控制台、托盘和通知：使用生产标准包核心图标或控制台小标。

`scripts/export-app-icon.mjs` 按上述规则生成 Windows 自适应 ICO；不得把 C3 扩散到小尺寸层。
