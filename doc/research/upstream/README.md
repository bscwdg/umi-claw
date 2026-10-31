# 上游仓库知识库备份（upstream）

> 建立日期：2026-11-01 ｜ 用途：**开发参考与知识库备份，不参与构建、不进安装包、不进 `resources/`**。
> 边界：**产品内不新增知识库**——角色的问答/世界书/热梗/日记一律走既有 Obsidian 知识库（MCP 检索）；本目录只作参考与素材来源，不构成独立 KB 服务或索引。
> 原则：只搬**文本/JSON 知识**（人格、设定、词典、方案、清单、manifest）；图片/整包等二进制素材不复制进仓库，完整克隆留在本机备份目录。
> 上游原始克隆位置（本机，不入库）：`D:\work2026\files\upstream-refs\{dafeiyu-astrbot,codex-deepseek-pet,dafeiyu-bot,blue-whale-agent}`

## 一、四个新上游一览

| 仓库 | 形态 | 代码许可 | 素材许可 | 本目录保留了什么 | 用法 |
| --- | --- | --- | --- | --- | --- |
| [whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot) `7ee692a`（2026-10-31） | AstrBot「大肥鱼」人格 + 知识库 + 自主生活方案（Python 插件） | **MIT** | 人格/文档随 MIT；`assets/` 内立绘见各自声明 | 人格设定、热梗词典、知识库笔记、自主生活方案、踩坑合集、角色生成提示词 | **人格与知识库母本**：C00b 内容包、C07 记忆、C06 生活 |
| [YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet) `7661c8b`（2026-09-23） | Electron 桌面宠物（2D 立绘 + 动作 + 窗口物理） | **大肥鱼项目署名许可 1.0**（自定义，允许商用但**必须署名作者+仓库**） | 同上；社区参考图不可再授权 | 角色设定、2D 动作规范、窗口物理、工作小动作设计、开发指南、生成说明 | **形象/桌宠参考**：C03 桌宠窗口、C10 表情动作 |
| [SAKURAfan1023/dafeiyu-bot](https://github.com/SAKURAfan1023/dafeiyu-bot) `ff2bb2f`（2026-10-28） | Swift QQ 机器人（贴纸库 + 照片画廊 + 社交浏览） | **MIT** | 贴纸**逐张不同**：CC0 / CC-BY-NC-SA-4.0 / 署名许可 1.0，见 manifest | 贴纸 manifest（情绪/场景/许可逐条）、照片贴纸 manifest、第三方说明、架构与社交方案 | **贴纸知识库母本**：C10 表情库、C08 QQ 发送、M2 素材包导入 |
| [whiteball-shiro/blue-whale-agent](https://github.com/whiteball-shiro/blue-whale-agent) `3a85cba`（2026-09-04） | Electron 桌宠挂件 + 本地模型委派（qwen） | **MIT** | — | `chat-workspace/AGENTS.md`（桌宠人格/委派规则）、配置教程、示例配置 | **桌宠实现参考**：C03 透明窗口、本地模型分流（成本控制） |

## 二、许可边界（重要）

1. **MIT 部分**（astrbot、dafeiyu-bot 代码、blue-whale-agent）：可复制、修改、商用，但**分发时保留版权声明与许可全文**；本目录已随附各仓 `LICENSE`。
2. **大肥鱼项目署名许可 1.0**（codex-deepseek-pet 的代码/文档/动画，以及 dafeiyu-bot 的 QQStickers 贴纸）：允许商用，但**必须标注「作者：YunYueSama / 仓库：https://github.com/YunYueSama/codex-deepseek-pet」**，分发时保留完整许可；修改需说明经过修改。**不得暗示原作者或 DeepSeek 官方认可**。
3. **CC BY-NC-SA 4.0 图片**（dafeiyu-bot `PhotoStickers/` 中的 B 站二创）：**非商业**，且角色原作「上善无形」、二创「ZipZipPipe」有独立权利。**只能用户自行导入，不得进安装包/公开构建**。
4. **CC0** 图片（dafeiyu-bot QQStickers 四张原创示例）：可自由使用，但底层角色仍有 CC BY-NC-SA 边界。
5. 通用红线（与 `doc/research/README.md` 一致）：产品形象仍走原创六态（PLAN-FISH-CHARACTER D5）；**素材按许可使用**——MIT / CC0 / 署名许可素材可按许可入包并保留署名，**CC BY-NC-SA 等非商业素材只能用户自行导入，不进安装包**；`codex-deepseek-pet` 的材料引用须标「作者 YunYueSama + 仓库地址」并说明修改。

## 三、已搬进来的知识与对应工作包

| 本目录文件 | 内容 | 对应 PLAN-FISH-CHARACTER |
| --- | --- | --- |
| `dafeiyu-astrbot/persona/大肥鱼-人格.md` | 12KB 完整人格提示词（形象/性格/节奏/表情/记忆/边界），v2.1 | **C00b** `persona/core.md`、`voice.md` 母本 |
| `dafeiyu-astrbot/persona/课程记忆-模板.md` | 记忆模板 | C07 每日记忆 |
| `dafeiyu-astrbot/docs/知识库-热梗词典示例.md` | 热梗词典 v1（拼音暗号 + 年度热词 + 给她的规矩） | **C00b/C10** 内容包、世界书 |
| `dafeiyu-astrbot/docs/知识库笔记.md` | 知识库切块/检索/全局 vs 会话级绑定的实操结论 | C07 记忆检索、C09 公私有隔离 |
| `dafeiyu-astrbot/docs/自主生活开发方案.md` | 自主生活/持续目标/预算/恢复的六阶段方案与踩坑 | **C06** 生活系统、C07 |
| `dafeiyu-astrbot/docs/踩坑合集.md` | 23KB 实战坑（人格漂移、记忆、平台、部署） | C09/C10 验收清单 |
| `dafeiyu-astrbot/assets/character/*` | 角色生成提示词与动画提示词（文本） | C00b 原创六态派生 |
| `codex-deepseek-pet/docs/角色设定.md` | 外观基准/性格/对话/界面口吻 | C00b、C10 |
| `codex-deepseek-pet/docs/2D角色与动作规范.md`、`动画与窗口物理.md`、`工作与思考小动作设计.md` | 2D 动作、窗口物理、小动作设计 | **C03** 桌宠、C10 |
| `dafeiyu-bot/Resources/QQStickers/manifest.json` | 情绪→贴纸→`context`（使用/禁用场景）逐条 | **C10** `emotions.v1.json` 扩充、C08 |
| `dafeiyu-bot/Resources/PhotoStickers/manifest.json` | 88 张贴纸的 emotion/context/tags/许可/来源 | M2 用户素材包导入设计 |
| `dafeiyu-bot/docs/SOCIAL_AGENT_TECHNICAL_PLAN.md`、`SOCIAL_PLATFORMS.md` | 社交浏览代理方案（平台、只读、审批、限额） | M3 直播/公开互动的合规参考 |
| `dafeiyu-bot/docs/ARCHITECTURE.md`、`USER_GUIDE.md`、`WINDOWS.md`、`UPGRADING.md` | QQ 机器人架构与运维 | C08 QQ 语音条/主动消息 |
| `blue-whale-agent/chat-workspace/AGENTS.md` | 桌宠人格 + 本地模型委派 + 安全判别 | C03、成本控制（C07/§九 风险） |

## 四、未复制进仓库的二进制（已在本机备份）

- `codex-deepseek-pet`：`design/character-standard.png`、`spritesheet*.webp`、`assets/whale/`、`docs/*.png|webp`（合计约 340MB）——形象参考，**不入库**。
- `dafeiyu-astrbot`：`assets/avatars/v3-20261025/*.png`（19 张）、`assets/character/*.png`（六视图）、`assets/voice-demo/*.wav`——不入库。
- `dafeiyu-bot`：`Resources/QQStickers/*.png|webp`、`Resources/PhotoStickers/*.png|webp|jpg`（约 77MB）——不入库；**只保留 manifest 与许可**。
- 如需取用：`D:\work2026\files\upstream-refs\...`（本机），或按各 `PROVENANCE.md` 的链接重新拉取固定版本。

## 五、与既有调研的关系

`doc/research/` 原有三篇（`DAFEIYU-ECOSYSTEM.md`、`KNOWLEDGE-AND-MEMORY-PATTERNS.md`、`LIVE-STAGE-SPEC.md`）是**摘要式**调研；本目录是**原样备份**，两者互补：
- 结论/取舍仍以原文（摘要）为准；
- 具体人格文本、词典条目、贴纸元数据以本目录原文为准，引用时注明「上游 + 固定 commit + 许可」。
