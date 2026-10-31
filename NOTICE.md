# NOTICE · 第三方组件与素材

本仓库（Umi Claw）自身代码遵循仓库 `LICENSE`（MIT）。以下第三方组件/参考材料按各自许可使用；
**任何第三方图片、贴纸、表情数据都不随安装包分发**（见 `doc/research/upstream/README.md`）。

## 运行时依赖

- **silk-wasm**（MIT）：QQ 语音条的 SILK 编码（`electron/main/character/qqVoice.ts` 动态加载；
  未安装时语音条自动降级为文字，不影响应用启动）。
  许可：https://github.com/...（以 npm 包内 LICENSE 为准，打包时随 `node_modules` 保留）。

## 设计与文本参考（不随安装包分发）

- [whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot) — MIT；人格/知识库/自主生活方案参考。
- [whiteball-shiro/blue-whale-agent](https://github.com/whiteball-shiro/blue-whale-agent) — MIT；桌宠窗口/本地模型分流参考。
- [SAKURAfan1023/dafeiyu-bot](https://github.com/SAKURAfan1023/dafeiyu-bot) — 代码 MIT；贴纸素材逐张 CC0 / CC BY-NC-SA 4.0 / 署名许可 1.0，
  **贴纸图片仅作格式参考，不进入本仓库或安装包**。
- [YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet) — **大肥鱼项目署名许可 1.0**（允许商用，须署名）：
  作者：YunYueSama；仓库：https://github.com/YunYueSama/codex-deepseek-pet。
  本仓库只参考其设计文档，不使用其图片/图集/动画素材。

## 原创内容

`resources/character/**`（人格模板、生活卡、台词、六态 SVG 定义、情绪知识库）为本项目原创，
不包含任何第三方图片或表情数据；六态立绘为内联 SVG（`src/character/art/FishState.vue`）。
