# 大肥鱼 GitHub 资料库调研与使用清单

> 调研时间：2026-11-08
> 范围：GitHub 上「大肥鱼 / 蓝色大肥鱼 / DeepSeek 鲸鱼娘」相关的人格、语料、表情包、主动消息与记忆评测仓库
> 结论口径：**只记录实际看过、能复核的内容；许可证不明确的一律不直接搬素材。**

## 0. 一句话结论

看了 **10+ 个仓库**，真正能合法复用的主要是 **3 类**：

1. 人格/说话规则（MIT 参考，未直接复制）；
2. 表情包的**标注格式与使用策略**（代码 Apache-2.0、素材 CC BY-NC，只借鉴格式，不内置素材）；
3. 主动消息/记忆的**行为设计**（AGPL/无许可证仓库只参考思路，不复制代码）。

**没有**可直接商用打包的「大肥鱼语料库」；现有内容池仍以项目自有的 `topics.v1.json` / `lines.v1.json` 为主。

## 1. 资源清单

| 仓库 | 内容 | 许可证 | 本项目采用情况 |
|---|---|---|---|
| [zexuanw958-svg/dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack) | 完整大肥鱼人格、AstrBot 设置、表情包/语音/主动聊天配置 | persona/settings **MIT**；绑定的插件与表情包归原作者 | 参考说话规则（短句、少客服腔、不编经历、表情包频率）；**未复制人格文本** |
| [Loping151/dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) | 322 张大肥鱼/GPT娘表情，逐张标注 emotion/tags/use/desc/dir/hash；支持 `[sticker:名字]` | 代码 **Apache-2.0**；知识库/图片 **CC BY-NC 4.0** | 借鉴标注字段、情绪检索、冷却/使用次数思路；**不内置图片**，仅支持用户本地导入 |
| [lmy414/ai-girl-stickers](https://github.com/lmy414/ai-girl-stickers) | 蓝色大肥鱼公开图片存档，PNG/JPG/GIF/WebP/APNG | 文字材料 MIT；**图片版权归原作者** | 只作为“用户可自行导入”的资源线索；不打包 |
| [BrickAZ/deepseek-chan-emotes](https://github.com/BrickAZ/deepseek-chan-emotes) | 161 张 GIF 表情，500px/30fps | **无许可证** | 未使用 |
| [diwer/ai-biaoqingbao](https://github.com/diwer/ai-biaoqingbao) | 100 张中文 GIF、热点表达、导入指南 | 标注为**非商业 AI 二创** | 未使用 |
| [czj849595422/BigFatFish](https://github.com/czj849595422/BigFatFish) | 本地中文角色扮演应用：角色卡、属性、长期记忆、候选回复 | **未指定许可证** | 只参考角色卡/记忆/属性设计；未复制代码或文案 |
| [a251231/whale_persona_plugin](https://github.com/a251231/whale_persona_plugin) | LangBot 大肥鱼“活人感全家桶”：气泡节奏、防复读、心情、记忆、主动搭话 | README 称 MIT，但仓库无 LICENSE 文件 | 采用“未回最多 2 次试探、之后等回复”“防句首复读”的行为思路；未复制代码 |
| [Kaalia0912/dsh-whale-musume-persona](https://github.com/Kaalia0912/dsh-whale-musume-persona) | DSH 全局鲸鱼娘人设预设 | MIT | 参考 DSH 预设/人设分层方式；本项目仍用自有 SOUL/IDENTITY/USER |
| [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark) | 大肥鱼聊天记忆评测：六人物、714 题、长期历史、判分工具 | MIT | 尚未接入；列为后续记忆回归测试候选 |
| [Pancakes-Labs/astrbot_plugin_proactive_chat](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat) | 主动消息插件：上下文、动态情绪、免打扰、TTS | **AGPL-3.0** | 只参考“随机间隔/上下文感知/免打扰”产品行为；未复制代码 |
| [EDMOK/blue-fish-archive](https://github.com/EDMOK/blue-fish-archive) | 早期大肥鱼图库 | 未逐一核实 | 仅登记，未使用 |

官方接口文档（实现依据，不是素材）：

- [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- [富媒体消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)（图片 `file_type=1` + `msg_type=7`）
- [消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)（C2C 无独立表情包消息类型）

## 2. 实际用到了什么

### 已落地

1. **内容多样性**
   - 项目自有 `resources/character/cards/topics.v1.json`（20 个话题）与 `lines.v1.json`（18 组约 100 句）已接入 `contentEngine`；
   - 每轮 2–10 条候选，生活三卡 + 话题 + 台词混合，不再固定取 `life.day.cardIds[0]` 的 hook；
   - 精确 hash + 3-gram 近似去重、话题/句式冷却。

2. **未回复行为**
   - 采用 `dafeiyu-config-pack` / `whale_persona_plugin` 的行为思路：未回 1 次按关系轻试探，未回 2 次换话题，≥3 次 backoff；
   - 关系语气走本项目 `relationship.mode`，没有照搬“不是恋人”的人设。

3. **表情包**
   - 采用 `dsh-nekowhale-stickers` 的标注维度（emotion/tags/use/hash/使用次数/冷却）设计本地 `stickers.json`；
   - 只做用户本地导入，不内置 CC BY-NC/无许可证图片；
   - QQ 发送走官方图片富媒体，不声称是“QQ 原生贴纸”。

4. **主动消息节奏**
   - 参考社区插件“随机间隔 + 上下文感知 + 免打扰 + 防刷屏”的产品规则；
   - 实现固定/随机区间、每日上限 60、跨天状态、改设置即时重算。

### 没有采用

- **没有直接搬人格文本**：外部人格把“不是谁的恋人/不说我爱你”写死，与当前恋人模式冲突；只借鉴语气规则。
- **没有内置第三方表情包**：许可普遍是 CC BY-NC、无许可证或图片版权归原作者，不能随安装包分发。
- **没有导入外部语料库**：没有找到可直接商用、且与当前人设一致的对话语料；现有话题/台词仍是主体。
- **没有接入 LLM 改写**：高频主动消息（10 分钟级）每条调模型成本和延迟都不划算，先做模板候选池。

## 3. 合规策略

- 安装包默认**不带**第三方表情包、人格文本、语料；
- 用户自行导入的图片只存本地，删除归档不物理删除；
- 若用户或我们后续内置某个包：必须满足以下之一：
  - MIT/Apache 等明确可再分发；
  - CC BY-NC 且产品不商用，并保留作者署名/链接；
  - 自绘或已取得授权。
- `dsh-nekowhale-stickers` 若要内置，必须保留作者“可以叫我云大人/kiriyuki.com”署名，且不能商用。

## 4. 后续可做

1. **表情包元数据兼容导入**：支持 `meta/nekowhale.json` 风格字段（emotion/tags/use/desc/dir），用户可把外部包导入本地库；仍不随包分发图片。
2. **人格规则附录**：把 MIT 人格包中可复用的“短句、少客服腔、不编经历、被问在干嘛先说自己”整理成本项目 `AGENTS.md` 的风格约束；保留本项目关系设定。
3. **记忆评测**：用 `chat-memory-benchmark` 的公开示例题做回归，不把 714 题全量塞进 CI。
4. **内容池扩写**：优先扩项目自有 topics/lines，而不是继续找“大肥鱼语料库”；外部语料许可和风格风险都更高。

## 5. 调研局限

- 主要阅读 README、人格文件、配置、表情包元数据与目录结构，**没有逐仓 clone 全量审计代码**；
- 许可证以仓库页面/README 为准，不构成法律意见；
- 社区仓库更新很快，后续内置任何素材前需要重新核对 LICENSE 与作者署名要求。
