# PROVENANCE · dafeiyu-astrbot

- 上游：https://github.com/whyever77/dafeiyu-astrbot
- 固定版本：`7ee692a7479aa2774fa41ff54390ad8bef46d8d3`（2026-10-31，提交信息 `docs: prepare v2.9.1 release notes`）
- 拉取时间：2026-11-01（`git clone --depth 1`），本机完整备份：`D:\work2026\files\upstream-refs\dafeiyu-astrbot`
- 许可：**MIT**（见本目录 `LICENSE`）。分发本目录内容时保留版权声明与许可全文。
- 内容性质：AstrBot（QQ 机器人框架）的「大肥鱼」人格、知识库与自主生活方案的社区实现。

## 本目录收录（仅文本）

| 路径 | 原路径 | 用途 |
| --- | --- | --- |
| `persona/大肥鱼-人格.md` | `persona/大肥鱼-人格.md` | 人格母本（12KB，v2.1） |
| `persona/课程记忆-模板.md` | 同 | 记忆模板 |
| `docs/知识库-热梗词典示例.md` | 同 | 热梗词典 v1 |
| `docs/知识库笔记.md` | 同 | 知识库/检索实操 |
| `docs/自主生活开发方案.md` | 同 | 生活系统方案 |
| `docs/踩坑合集.md` | 同 | 实战坑清单 |
| `docs/部署指南.md`、`导入指南.md`、`指令手册.md`、`生图玩法.md`、`视频识别.md` | 同 | 平台/玩法参考 |
| `assets/character/README.md`、`ANIMATION-PROMPTS.json`、`PROMPT*.txt` | `assets/character/v1-20261030/` | 角色生成提示词（原创六态派生参考） |
| `assets/avatars/README.md`、`assets/README.md` | 同 | 素材说明 |

## 未收录

- `assets/avatars/v3-20261025/*.png`、`assets/character/*.png`、`assets/voice-demo/*.wav`、`assets/character/*.png`：二进制素材，留在本机备份。
- `plugin/`、`deploy/`、`tests/`、`CHANGELOG.md`：代码/部署/测试，留在本机备份；如需借鉴，按 MIT 保留声明，**不直接复制进产品代码**。

## 使用边界

- 其中的**人物外观描述**基于社区二创（角色原作「上善无形」等），我们产品形象仍按 PLAN-FISH-CHARACTER D5 走**原创六态 SVG**，本目录只借文本与结构，不复用图片。
- 人格文本可直接作为 C00b 母本改写，但需**去掉固定人称/平台专属指令**，并按我们的变量系统（`{{address}}`）重写。
