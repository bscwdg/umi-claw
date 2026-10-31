# 大肥鱼项目 · 外部参考资料索引（research）

> 建立日期：2026-11-01 ｜ 用途：**开发参考，不参与构建**。本目录不进安装包、不进 `resources/`，仅作设计与合规依据。
> 原则：**只记录摘要、字段结构、链接与结论；不复制上游代码/图片/完整文档**（避免把 AGPL/CC BY-NC 内容混进 MIT 仓库）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `README.md` | 本索引 + 许可总表 + 采纳/不采纳结论 |
| `DAFEIYU-ECOSYSTEM.md` | 三个上游项目逐项分析（形态/许可/可复用点/坑） |
| `KNOWLEDGE-AND-MEMORY-PATTERNS.md` | 表情知识库 schema、冷档记忆、夜间回顾、记忆纠错、知识服务治理——可借鉴的工程模式 |
| `LIVE-STAGE-SPEC.md` | 直播展示页（截图概念）的 UI/数据/技术规格与分期 |
| `upstream/README.md` | **新上游仓库知识库备份**（2026-11-01 新增 4 个仓库：人格/贴纸知识库/2D 动作/桌宠实现），含逐仓 `PROVENANCE.md` 与许可边界 |

> 2026-11-01 用户新增四个上游仓库并要求「下载备份、知识库拿过来使用」，已完整克隆到本机
> `D:\work2026\files\upstream-refs\`，并把**文本/JSON 知识**归档进 `upstream/`（图片等二进制不入库）。
> 索引与许可矩阵见 `upstream/README.md`；四个仓库为：`whyever77/dafeiyu-astrbot`（MIT）、
> `YunYueSama/codex-deepseek-pet`（署名许可 1.0）、`SAKURAfan1023/dafeiyu-bot`（MIT，贴纸逐张许可）、
> `whiteball-shiro/blue-whale-agent`（MIT）。

## 上游与许可总表

| 项目 | 形态 | 代码许可 | 素材/数据许可 | 我们能做什么 |
| --- | --- | --- | --- | --- |
| [Loping151/dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) | DSH 插件 + MCP + CLI + 表情知识库（322 张，逐张标注） | Apache-2.0（需保留 NOTICE） | 数据 `meta/` 为 **CC BY-NC 4.0**；图片版权归作者，不可打包 | **借鉴 schema、标记协议、模板玩法**；不复制图片/数据进安装包 |
| [CleverWing/fat-whale-library](https://github.com/CleverWing/fat-whale-library) | DSH 插件 + 共享视频知识服务（REST/MCP） | MIT | 图像 CC BY-NC-SA 4.0 | **借鉴知识服务治理**（安装 ID、限额、审计、投稿审核、provenance）；不复制内容 |
| [FigaroGao/astrbot-fish-capabilities](https://github.com/FigaroGao/astrbot-fish-capabilities) | AstrBot 大肥鱼能力扩展（QQ/B站/记忆/语音识别） | **AGPL-3.0（传染性，禁止拷贝代码进 MIT 项目）** | 见其 NOTICE | **只借鉴设计思路**（冷档、夜间回顾、记忆纠错、任务调度、公私有隔离），代码与文档原文一律不复制 |
| [EDMOK/blue-fish-archive](https://github.com/EDMOK/blue-fish-archive) | 表情档案馆 | 无代码许可证 | CC BY-NC-SA 4.0 + 各作者 | 只作形象背景资料；不打包 |
| [whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot) | AstrBot 插件：大肥鱼人格 + 知识库 + 自主生活方案 | **MIT** | 人格/文档随 MIT，立绘见仓库声明 | **人格/知识库母本**；不复制立绘（见 `upstream/dafeiyu-astrbot`） |
| [YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet) | Electron 桌面宠物（2D 立绘 + 动作 + 窗口物理） | **大肥鱼项目署名许可 1.0**（可商用，须署名作者+仓库） | 同上；社区参考图不可再授权 | 借设计文档与规范，**不借图片**；上线物料须署名（见 `upstream/codex-deepseek-pet`） |
| [SAKURAfan1023/dafeiyu-bot](https://github.com/SAKURAfan1023/dafeiyu-bot) | Swift QQ 机器人（贴纸库 / 照片画廊 / 社交浏览） | **MIT** | 贴纸逐张：CC0 / CC BY-NC-SA 4.0 / 署名许可 1.0（见 manifest） | 只取 manifest 元数据（emotion/context/license）；图片不入包（见 `upstream/dafeiyu-bot`） |
| [whiteball-shiro/blue-whale-agent](https://github.com/whiteball-shiro/blue-whale-agent) | Electron 桌宠挂件 + 本地 qwen 委派 | **MIT** | — | 桌宠透明窗口实现与「本地模型分流控成本」参考（见 `upstream/blue-whale-agent`） |
| 36氪报道 | 「大肥鱼」传播链 | — | — | 人设背景引用 |

> 结论：**代码可借鉴的只有 nekowhale（Apache）与 fat-whale（MIT）的部分设计；图片、表情数据、astrbot 代码都不可直接入库**。形象一律原创（见 `doc/FEASIBILITY-FISH.md` §1.1/§5.1）。

## 对当前计划的采纳清单（已写进 PLAN-FISH-CHARACTER）

1. **表情/动作知识库 schema**（nekowhale）：我们自建 `resources/character/cards/emotions.v1.json`，字段借鉴 `id/emotion/tags/use/desc/dir`，但只标注**我们自己的原创六态立绘**。
2. **回复标记协议**（nekowhale 的 `[sticker:名字]`）：聊天/直播里用 `[emotion:开心]` 这类标记驱动表情，不把图片塞进模型上下文。
3. **模板玩法**（想/举牌/上联/下联/抱）：M2 内容玩法候选，用于直播与聊天。
4. **冷档 + 夜间回顾 + 记忆纠错**（astrbot，只借思路）：写进 C07（每日记忆）与 C09（安全/隐私），包括：
   - 只追加、按日分文件、落盘前过滤密钥；
   - 05:00 夜间回顾门控（安静期 + 无聊天 + 每天最多一次 + 失败不重试）；
   - 更正需要「明确原话 + 版本号 + 独立审查 + 保留审计」；
   - 公开/私有上下文隔离（私聊记忆不进入公开内容）。
5. **知识服务治理**（fat-whale，只借思路）：记忆写入带 `source` 溯源、限额、审计不存正文、投稿/候选审核——用于 C07 的「重要记忆候选确认」与 M2 的「关系档案导出」。
6. **直播展示页**：截图概念已整理成 `LIVE-STAGE-SPEC.md`，排在 M3（M1 之后），不阻塞基础功能。

## 明确不采纳

- 不引入 DSH 插件契约（我们是 Electron 4.0 宿主，不是 DSH）。
- 不复制任何第三方表情/立绘/数据文件进安装包或仓库构建产物。
- 不复制 astrbot 代码（AGPL）；不把其文档原文搬进本仓库。
- 不依赖上游在线服务（kiriyuki.com / livecompanion 等）：只看接口形态，不做运行时依赖。

## 核验与获取方式

- 2026-11-01 通过 GitHub raw / 官网 JSON 拉取 README 与接口文档（未克隆仓库）。
- 2026-11-01 **新增四个上游仓库**：`git clone --depth 1` 完整克隆到本机 `D:\work2026\files\upstream-refs\`，
  固定版本分别为 `dafeiyu-astrbot@7ee692a`、`codex-deepseek-pet@7661c8b`、`dafeiyu-bot@ff2bb2f`、`blue-whale-agent@3a85cba`；
  文本知识归档到 `upstream/`，图片等二进制不入库（详见 `upstream/README.md` 与各仓 `PROVENANCE.md`）。
- 表情知识库 JSON：`https://kiriyuki.com/meme/kit/nekowhale.json`（schema `sticker-kit/1`，25 种情绪，字段 `id/hash/text/emotion/tags/use/desc/meme/dir/en`）。
- 知识服务契约：`https://livecompanion.duckdns.org/dafeiyu`（REST + MCP，安装 ID + 限额 + 审计）。
