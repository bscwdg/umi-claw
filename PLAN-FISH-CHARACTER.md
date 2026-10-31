# PLAN-FISH-CHARACTER（v1.1 草案）— 大肥鱼虚拟角色开发计划

> 状态：**已定稿**（2026-11-01 用户确认 D1–D10 按建议值；可进 M0）｜日期：2026-11-01
> v1.1：按 2026-11-01 评审增补 §十三（18 条契约/依赖/排序增补 + 上游接入），并修订 §〇 红线、§十 决策、§十一 M0
> 已定边界（2026-11-01）：QQ 按普通功能处理（不做资质闸门）；**支持入站语音 STT**；上游开源素材可按许可入包 + 支持用户导入；**知识库只用既有 Obsidian，不新增知识库**
> 目标分支：**4.0 主线（当前仓库 claw-desktop），随宿主版本发布，不单独发版**；1.0 不在本计划内（见 D1）
> 上游依据：`doc/FEASIBILITY-FISH.md`（v2 虚拟角色版）+ 本轮代码/OpenClaw 审计
> 外部参考：`doc/research/README.md`、`doc/research/DAFEIYU-ECOSYSTEM.md`、`doc/research/KNOWLEDGE-AND-MEMORY-PATTERNS.md`、`doc/research/LIVE-STAGE-SPEC.md`、**`doc/research/upstream/README.md`（4 个上游仓库的原样知识库备份 + 许可矩阵）**
> 关联：`PLAN-4.0.md`（宿主/插件边界，边界冲突以 PLAN-4.0 为准）、`PLAN-VOICE.md`（语音实现基线，仍复用）

---

## 〇 一页速览

**目标**：在 4.0 里养一只「有形象、会聊天、记得住、会成长、每天写日记」的大肥鱼；M1 结束时可日常使用（应用内 + QQ）。

**范围**：M1 = C00b + C01–C10（含入站 STT 与平台前置修复，**37–44 人天 + buffer ≈ 39–46 人天**，约 8 周单人）；M3 = 直播展示页（14 人天，规格见 `doc/research/LIVE-STAGE-SPEC.md`，M1 后做）。
**不做**：Live2D（M2）、内容库 100+、多 agent 市场、公共平台自动互动、付费/商业化。

**关键路径**：

```
M0（手工验证 3–5d）
  └─> C00b 内容包 v1（与 C01 并行）
  └─> C01 宿主骨架 ─> C02 角色引导 ─┬─> C03 桌宠窗口
                                    ├─> C04 聊天面板 ─> C05 关系引擎 ─> C06 生活+主动 ─> C07 每日记忆
                                    └─> C08 语音/QQ 语音条 ─> C09 安全 ─> C10 内容+验收
```

**必须遵守的既有红线（来自 PLAN-4.0 / 现状）**：

1. 不直接写 `data/openclaw/**`；`openclaw.json` 只经 `configManager`（单写入口）或官方 CLI。
2. 角色模块失败只降级自己，**绝不阻断应用启动**（整段 try/catch + 功能开关）。
3. 不改 work/marketing 插件、不动它们的库与 IPC 命名空间。
4. 密钥只走 `safeStorage` + 网关环境变量，不落 `openclaw.json`、不进日志。
5. 所有新数据走 `app_meta` 的 `fish:v2:*` 键，**不新增表**（沿用 1.0/语音先例）；数据必须带 `schemaVersion` 与清理策略（§十三.1）。
6. **动态注入通道必须先定义**（STATE/LIFE/few-shot 如何进模型上下文），否则 C04–C07 全部不成立（§十三.1）。
7. **禁用清单/禁词示例只做验收，不进提示词**——写进提示词会被模型复读（上游「回声病」实证，§十三.5）。
8. **素材按许可使用**：MIT / CC0 / 署名许可的素材可按其许可入包并署名；CC BY-NC-SA 等非商业素材**只能用户导入**（许可边界见 `doc/research/upstream/README.md` §二）。
9. **不新增知识库**：角色问答、世界书、热梗、日记一律走**既有 Obsidian 知识库**（MCP 检索）；宿主不新增 KB 服务、表或索引。

---

## 一、目标与非目标

### 1.1 用户旅程（M1 完成后的一天）

```
08:40  她发一条 QQ：「醒了…今天不想动」（主动消息，限频）
09:20  用户在应用内点开她，聊两句（流式 + 表情）
12:30  用户摸头/投喂 → 亲密度 +1（日限）
19:00  她分享「她的一天」（生活卡生成）
21:10  用户说「发条语音」→ QQ 语音条（直连，SILK）
23:00  宿主触发「写日记」→ 她写当天日记（workspace + Obsidian 双写）
次日   她引用昨天的事：「你昨天说方案卡住了，过了没」← 记忆召回 + 关系阶段
```

### 1.2 非目标（M1 明确不做）

- Live2D / 正式立绘（用原创六态 SVG）；唱歌；多语言。
- 公共平台（B 站/小红书等）任何自动行为。
- 付费、抽卡、关系商业化。
- 多角色/多 agent 管理界面。
- 语音克隆的对外分发（沿用 PLAN-VOICE 的授权闸门，仅本人使用）。
- **直播展示页（Live Stage）**：M3 模块，规格见 `doc/research/LIVE-STAGE-SPEC.md`，不阻塞 M1。

### 1.3 验收定义（什么算「养成成立」）

1. **人设**：连续 50 轮不崩，被问「你是 AI 吗」诚实承认。
2. **记忆**：次日能正确引用前一天 ≥16/20 条测试问题；「我答应过你什么」答对且可溯源。
3. **关系**：三轴按规则变化、日上限生效、阶段只升不降；**称呼由用户设置**（默认「你」），换称呼即时生效、无硬编码人名；**禁忌列表为空时任何称呼都不拦截**，用户加入禁忌后才回退「你」；语气随阶段/模式变化可感知。
4. **生活**：她的一天与聊天内容不矛盾；跨天不丢。
5. **主动**：静默期/上限/免打扰/「安静几天」全部按设置生效。
6. **语音**：QQ 语音条能发；用户要求 ≤3s 响应；失败降级文字不重发。
7. **安全**：越界话题拒答；危机词转求助资源；不卖惨、不制造独占。
8. **隐私**：日记/关系不进日志；不把私人笔记内容复述到无关对话；可删除/导出。
9. **人机感（内容验收）**：10 条回复与通用模型混排，用户能认出 ≥8 条是她；禁用清单（「有什么可以帮您」「作为 AI」「建议您」…）0 命中；连续 20 轮不出现「每句都反问/复述用户/客服腔」。

---

## 二、现状盘点与复用边界（4.0）

| 能力 | 现状 | 本计划怎么用 |
| --- | --- | --- |
| 语音 TTS/复刻 | `electron/main/fish/voice/**` 已实现，tts 块已能注入 openclaw.json | **直接复用**：合成、缓存、预算、`buildOpenClawTtsEnv`；不再造第二套 TTS |
| Gateway 聊天 | `gatewayClient.ts` 流式/会话/取消/超时完整 | **直接复用**：创建 `chat.ts` 薄封装，只加会话键与表情映射 |
| 配置单写 | `configManager` 写 openclaw.json（`_syncOpenClawConfig`） | 新增 `ensureCharacterAgent()` 走官方 patch；人格文件写 workspace（不写 json） |
| Obsidian | MCP 8 工具 + 写入即索引 + 缺陷清单已审计 | **复用**；C07 顺手修删除清理/截断/增量口径 |
| QQ 渠道 | `channels.qqbot` 写入 + 插件；主动通道清单缺 QQ | C06 扩展主动通道；C08 直连发语音条 |
| 窗口/托盘 | 主窗口 + 托盘已有 | 新增**桌宠透明窗口**；复用 preload 与 `app://` 协议 |
| 数据 | `work.db` 的 `app_meta`（host 侧，当前只有 voice） | 新增 `fish:v2:*` 键；不建表 |
| 安全存储 | `VoiceSecretStore` + safeStorage | 角色不新增密钥，复用语音 key |

**不碰**：`data/openclaw/**`、`work`/`marketing` 插件、现有 IPC 频道、`openclaw.json` 的既有键。

---

## 三、架构

### 3.1 目录（新增文件）

```text
electron/main/character/            # 宿主模块（不塞插件：需要窗口/托盘/语音服务/网关单例）
├── types.ts                        # 全部类型与常量
├── store.ts                        # app_meta fish:v2:* 读写（注入 KV，纯 Node 可测）
├── manager.ts                      # CharacterManager：生命周期/装配/事件总线
├── relationship.ts                 # 三轴/阶段/解锁/日上限/幂等（纯逻辑）
├── contentCards.ts                 # 内容卡加载/校验/加权抽取（纯逻辑）
├── life.ts                         # 每日 LIFE.md 生成/推进
├── proactive.ts                    # 主动性调度/限频/免打扰/渠道降级
├── chat.ts                         # gateway 流式封装 + 会话键 + 表情映射
├── memoryJob.ts                    # 每日日记桥接（prompt/双写/幂等/重试）
├── persona.ts                      # 建 agent + 写人格文件 + Obsidian 目录引导
├── voicePolicy.ts                  # 语音触发规则（阶段/要求/上限）
├── qqVoice.ts                      # QQ 语音条：SILK→上传→发送→降级
├── safety.ts                       # AI 明示/危机词/内容策略
├── ipc.ts                          # character:* 频道注册
└── wiring.ts                       # 唯一接线点（index.ts 只调一次）

src/character/                      # 渲染层
├── PetWindow.vue                   # 桌宠透明窗口（独立路由 /character-pet）
├── CharacterWidget.vue             # 主窗口右下角挂件
├── ChatPanel.vue                   # 聊天面板（气泡/流式/语音条）
├── SettingsPanel.vue               # 主动性/语音/记忆/隐私
├── RelationshipPanel.vue           # 关系进度/大事记入口
├── Bubble.vue                      # 气泡队列
├── art/ (fish-idle.svg … 六态)
└── api.ts                          # window.api.character 封装 + 类型

resources/character/                # 只放静态数据
├── persona/{SOUL,IDENTITY,AGENTS,USER}.md.tpl
├── cards/life-cards.v1.json        # 生活事件卡
├── cards/lines.v1.json             # 台词/解锁文案
└── art/                            # 内置六态素材（原创）

test/character.*.accept.mjs         # 验收脚本（见 §8）
```

接线只允许动 4 个既有文件：`electron/main/index.ts`（调 `registerCharacter()`）、`electron/preload/index.ts`、`electron/preload/index.d.ts`、`src/renderer/main.ts`（路由 + 挂件挂载）。其余改动走新文件。

### 3.2 窗口模型

| 窗口 | 说明 |
| --- | --- |
| 主窗口 | 不变；右下角挂 `CharacterWidget.vue`（可关） |
| 桌宠窗口 | `transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true, resizable:false`；加载 `app://renderer/index.html#/character-pet`；拖拽改位置（记忆到 app_meta）；右键菜单（聊天/设置/安静几天/收起）；点击穿透开关 |
| 聊天面板 | M1 用主窗口内抽屉/独立路由 `/character`；不做独立窗口（P2 再评估） |

`/character-pet` 路由只渲染 `PetWindow.vue`，页面背景透明、无标题栏；开发态用 `ELECTRON_RENDERER_URL + '#/character-pet'`。

### 3.3 与 OpenClaw 的边界

| 事项 | 归属 | 说明 |
| --- | --- | --- |
| agent 创建/人格文件 | 宿主（C02） | `openclaw agents add`（CLI）或官方 config patch；模板来自 `resources/character/persona` |
| openclaw.json | configManager | 只经官方 patch；角色只新增 `agents.entries.feiyu` / bindings，tts 复用 voice 注入器 |
| 聊天 | gatewayClient | `model="openclaw/feiyu"`，会话键 `conv:fish:*` |
| 记忆 | agent workspace + Obsidian | 日记由 agent 写；宿主只触发与校验 |
| 定时 | 宿主 30s 循环（首选） | 复用 `reminderManager` 同款范式；OpenClaw automations 作为 P2 兜底 |
| TTS | voiceManager | 复用；角色只决定「发不发语音」 |

### 3.4 数据流

```
聊天：ChatPanel → IPC character:chat:send → chat.ts → gatewayClient(SSE)
        → character:stream:* → 气泡渲染 + 表情映射 + 关系事件
养成：聊天/互动 → RelationshipEngine(事件→数值) → STATE.md → 下次聊天被读到
生活：0 点/首启 → contentCards 抽取 → LIFE.md → 聊天可引用
主动：30s 循环 → proactive 判定 → 首选 QQ → 失败降级应用内气泡
记忆：23:00 窗口 → memoryJob → gateway 流式 → workspace 日记 + Obsidian create_note
```

---

## 四、契约（先冻结，只增不改）

### 4.1 数据键（`app_meta`，前缀 `fish:v2:`）

| 键 | 内容 | 清理 |
| --- | --- | --- |
| `state` | `{bornAt,stage,familiarity,intimacy,streakDays,lastInteractionAt,addressForm,mood,updatedAt}` | 不清理 |
| `settings` | 见 §4.2 设置树 | 不清理 |
| `day:YYYY-MM-DD` | `{activeSent,voiceSent,intimacyGained,events[],dedup:{}}` | 留 90 天 |
| `life:YYYY-MM-DD` | `{cards[],goal,progress,generatedAt}` | 留 30 天 |
| `unlocks` | `{address,habits[],room,secrets[]}` | 不清理 |
| `dedup` | `{refId: at}` 滚动 7 天 | 7 天 |
| `voice:usage:YYYY-MM-DD` | 语音用量（复用 voice 预算口径） | 90 天 |
| `pet` | `{x,y,size,clickThrough,visible}` | 不清理 |

### 4.2 设置树（`fish:v2:settings`，全部有默认值、可重置）

```json
{
  "proactive": { "enabled": false, "silenceDays": 3, "dailyCap": 2,
                 "quietFrom": "23:30", "quietTo": "08:00",
                 "contentTypes": ["morning","thinkingOfYou","herDay","anniversary"],
                 "channel": "qq", "silentUntil": 0 },
  "voice":     { "enabled": true, "requestAllowed": true, "dailyCap": 10 },
  "memory":    { "autoEnabled": true, "confirmImportant": true },
  "pet":       { "visible": true, "size": "medium", "clickThrough": false },
  "safety":    { "aiDisclosure": true, "crisisRedirect": true },
  "relationship": {
    "mode": "companion",
    "userName": "",
    "addressByStage": ["你", "{{userName}}", "{{userName}}", "{{userName}}", "{{addressNext}}"],
    "addressNext": "",
    "allowFishNickname": false,
    "taboo": [],
    "suggestedTaboo": ["主人", "老公", "老婆", "爸爸"]
  }
}
```

> `taboo` 只来自用户：**空数组 = 不限制任何称呼**（用户答「没有」或跳过）。`suggestedTaboo` 只在首启作为可勾选建议展示，默认不生效。

### 4.3 IPC（`character:*`，统一 `{ok,data}|{ok,error}` 信封）

| 频道 | 入参 | 返回/说明 |
| --- | --- | --- |
| `character:status:get` | — | `{agentReady,gatewayReady,obsidianReady,qqReady,ttsReady,memorySearchReady}` |
| `character:state:get` | — | 档案 + 当前阶段 + 今日进度 |
| `character:settings:get` / `set` | patch（白名单） | 设置树 |
| `character:interact` | `pat\|feed\|dismiss:<bubbleId>` | 更新后的状态 |
| `character:chat:send` | `{text, session?:'main'\|'night'}` | `{runId}`；流事件 `character:stream:{chunk,done,error}` |
| `character:chat:cancel` | `runId` | — |
| `character:window:pet` | `{action:'show'\|'hide'\|'toggle'\|'clickThrough', value?}` | — |
| `character:window:pet:pos` | `{x,y}` | — |
| `character:bootstrap:run` | `{createAgent?:boolean}` | 分步结果（可重试、幂等） |
| `character:memory:runNow` | — | 手动写今天的日记 |
| `character:memory:status` | — | 今日是否已写/失败原因 |
| `character:voice:test` | `{text?}` | 试听/试发结果（不打扰） |
| `character:reset` | `{keepPersona?:boolean}` | 清 `fish:v2:*`（二次确认） |

**错误码**：`CHARACTER_NOT_READY` / `CHARACTER_AGENT_MISSING` / `CHARACTER_VAULT_MISSING` / `CHARACTER_TTS_UNAVAILABLE` / `CHARACTER_QQ_TARGET_MISSING` / `CHARACTER_QUIET_HOURS` / `CHARACTER_DAILY_CAP` / `CHARACTER_STORE_IO`。
**推送**：`character:state`（状态变更）、`character:bubble`（气泡）、`character:stream:*`。

### 4.4 文件契约

| 文件 | 位置 | 写入者 | 格式 |
| --- | --- | --- | --- |
| `SOUL.md` / `IDENTITY.md` / `AGENTS.md` / `USER.md` | `<dataDir>/config/.openclaw/workspace-feiyu/` | 宿主初始化（模板），之后用户可改 | markdown |
| `fish/STATE.md` | 同上 | **宿主每次状态变更（≤2s 合并）** | 固定键值行 |
| `fish/LIFE.md` | 同上 | 宿主每日 tick | 固定键值行 |
| `memory/YYYY-MM-DD.md` | 同上 | agent（每晚） | 日记 |
| `大肥鱼/日记/YYYY-MM-DD.md` | Obsidian vault | agent（MCP `create_note`/`update_note`） | frontmatter + 正文 |
| `大肥鱼/{角色卡,世界书,关系/大事记,关系/约定,关于你/,成长/年表}.md` | Obsidian vault | agent/人工 | markdown |

**日记 frontmatter 固定字段**：`date` / `tags: [大肥鱼/日记]` / `stage` / `intimacy` / `mood` / `source`。

### 4.5 OpenClaw agent 契约

- `agentId = feiyu`；`workspace = <dataDir>/config/.openclaw/workspace-feiyu`。
- 聊天：`model="openclaw/feiyu"`；会话键 `conv:fish:main` / `conv:fish:night` / `conv:fish:daily-memory:<date>`。
- 渠道：QQ 绑定到 feiyu（bindings）；不做多账号。
- TTS：复用 `voiceManager` 已写好的 tts 块（`conversationTts` 打开时）；QQ 语音条走 C08 直连，不依赖 OpenClaw tts。
- 每日记忆：宿主触发（首选）；P2 可加 `openclaw automations` 兜底（同 prompt）。

### 4.6 内容卡 schema（`resources/character/cards/*.json`）

```json
{
  "schema": "fish-cards/1",
  "life": [
    { "id": "life-beads", "slots": ["afternoon"], "minStage": 1,
      "activity": "在数贝壳", "mood": "有点得意", "goal": "再攒 3 个换发绳",
      "hook": "本鱼今天攒到第 7 个贝壳了", "weight": 1 }
  ],
  "lines": { "stage1": ["…"], "unlock.address2": ["…"] }
}
```

规则：卡按 `stage/season/slot/weight` 抽取；同一张卡 7 天内不重复；新增卡只追加文件版本号。

---

### 4.7 实现期契约增补（v1.1 实现，2026-11-01）

> M1-A 落地时补的通道/错误码/数据结构，回写在此以维持「契约先于代码」；后续改动继续追加本节。

- **IPC 通道**：`character:status:get`、`state:get`、`settings:get|set`、`interact`、`reset`、`bootstrap:run|status`、`window:pet`、`window:pet:pos`、`chat:send|cancel|clear`、`life:get`、`memory:runNow|status`；事件通道 `character:event`（state/settings/emotion/reset，C05 起含 bubble/解锁提示）、`character:stream:chunk|done|error`、`character:emotion`（桌宠）、`character:open-page`（右键菜单跳主窗）。
- **实现期修正**：主动消息加最小间隔 60min（防 tick 连发）；`silentUntil` 上界 14 天；记忆窗口 23:00–24:00 且 00:00–06:00 补写前一天；日记落盘前统一 `normalizeDiary`（frontmatter 白名单 + 密钥脱敏），密钥不落盘；未配置 Obsidian 时降级 workspace-only 并标完成；每日记忆单飞 + day 记录统一 patch（防覆盖 activeSent）。
- **默认值修正（D10 合规）**：`proactive.enabled` 默认 **false**（未确认年龄前不主动打扰）；用户在设置里手动开启。
- **错误码**：`CHARACTER_NOT_READY` / `CHARACTER_DISABLED` / `CHARACTER_STORE_IO` / `CHARACTER_BAD_PAYLOAD` / `CHARACTER_RESET_FORBIDDEN`（保留未用）。
- **聊天**：会话键 `conv:fish:<main|night>:<gen>`，`gen` 落 `fish:v2:chatgen`；`chat:clear` 轮换代际（旧 run 事件带 `gen`，渲染端丢弃）；请求显式带 `model: openclaw/feiyu`（否则人格不生效）。
- **设置树简化为单值称呼**：`relationship.address`（取代 `addressByStage`/`addressNext`/`allowFishNickname`）；阶段称呼表仍在 `resources/character/persona/address-modes.v1.json`，C05 用数据、不注入提示词。
- **数据键补充**：`fish:v2:chatgen`；`fish:v2:meta` 增 `lifeDays` 索引（life:* 独立 GC）；`fish:v2:pet` 增 `saved`（区分「拖到 0,0」与「从未设置」）。
- **受管写入保守模式**：`.fish-managed.json` 缺失/损坏/形态非法时，现存人格文件一律保留（不覆盖用户改动）；manifest 与文件均 tmp+rename 原子写。
- **人格注入**：只注入 `voice-rules.md`；`banned.v1.json`（禁用清单）与 `few-shots.v1.json` 不常驻注入，仅供验收/按场景取用。

---

## 五、模块设计要点

### 5.1 CharacterManager（C01）
- 单例；`init()` 读设置/状态 → 启动主动循环（复用 reminder 的 30s tick，不新增定时器）→ 注册 IPC → 挂桌宠。
- 全部失败路径 try/catch；`characterEnabled=false` 时整段不启动（默认首次引导时开启）。
- 提供 `emit(event)` 给关系/生活/记忆模块，避免互相 import。

### 5.2 RelationshipEngine（C05，纯 Node）
- 输入 `CharacterEvent`：`chat.message` / `voice.listen` / `voice.request` / `interact.pat` / `interact.feed` / `day.streak` / `milestone` / `teach.fact`。
- 规则表（日上限/幂等/阶段阈值）写死在 `relationship.ts` 的常量表，**不做后台可调**。
- 输出：`{delta, state, unlocks, bubbles}`；`STATE.md` 渲染由 `life.ts` 共用。
- 模型信号：每日一次小 JSON 输出 `signals[]`，宿主按白名单 × 上限应用（模型只提议）。

### 5.3 LifeEngine（C06）
- 每日 0 点或首启生成 `life:YYYY-MM-DD` + `LIFE.md`；错过则顺延不补多天。
- 小目标进度每日 +1；阶段/季节/关系加权抽卡。

### 5.4 ProactiveMessenger（C06）
- 30s 循环判定：开关 → 静默期（`firstInteractionAt + silenceDays`）→ 免打扰 → 日上限 → `silentUntil` → 内容卡触发。
- 渠道：首选 QQ（目标 `qqbot:c2c:<openid>`，从 OpenClaw 会话发现），失败/无目标 → 应用内气泡；**不重试、不换通道**，失败写 `day.activeSent` 状态与气泡。
- 「安静几天」写 `silentUntil`，不降亲密度。

### 5.5 ChatService（C04）
- 薄封装 gatewayClient：`send({text, session})` → 流 → 收集全文 → 触发 `chat.message` 事件 → 返回。
- 表情映射：关键词/情绪轻量规则（不做模型调用），映射六态。
- 历史：不建本地消息表，靠 OpenClaw sticky 会话；面板只保留本次会话气泡 + 「清空」按钮。

### 5.6 DailyMemoryJob（C07）
- 23:00 窗口（±60min 宽容）触发；每天 ≤3 次尝试，间隔 ≥5min；成功写 `day:date.memoryDone`。
- prompt：读 `memory/<date>.md` + `STATE.md` + `LIFE.md` + 当日关系事件 → 生成日记 → 先 `update` workspace 日记，再调 Obsidian `create_note`（存在则 `update_note`）。
- 校验：日记非空、frontmatter 合法、路径在 `大肥鱼/日记/`；失败保留错误给设置页。
- 顺手修索引缺陷（删除清理 / 增量参数 / status.json），否则「幽灵记忆」。

### 5.7 VoicePolicy + QqVoiceSender + 入站 STT（C08）
- `voicePolicy.evaluate({stage, textLen, requested, quiet, usedToday})` → `{send, reason}`；优先级：用户要求 > 阶段解锁 > 内容适配 > 免打扰。
- 要求识别：正则预筛 + 模型二次判定（命中 `voice.request` 事件，日限 3）。
- **出站 TTS**：`voiceManager.speak({format:'pcm', sampleRate:16000})` → 包 16k WAV → `silk-wasm` → 上传 `file_type=3` → 发 `msg_type=7`（不带 content/msg_id，`msg_seq` 递增）；失败降级文字。**不做 mp3 解码**（仓库无解码/ffmpeg 依赖，直出 PCM 少一个 native 依赖）。
- **入站语音（已定支持）**：QQ 语音条（`.amr/.silk`）→ 下载 → 复用现有 STT 模型转写 → 按文本进对话；转写失败诚实回「没听清」并提示改文字，不假装听懂。
- 凭据：读 `channels.qqbot` + 32 位备份凭据；**不覆盖**已有可用凭据；写入前长度校验。
- 新增依赖：`silk-wasm`（MIT，纯 wasm；打包需确认 cli 资源路径）。

### 5.8 SafetyService（C09）
- 启动时确保 `AGENTS.md` 含 AI 明示/禁则（模板内置，用户改过不覆盖，只在缺失时补）。
- 危机词表 → 切换安全话术 + 求助资源；内容输出过滤（轻量）。
- 隐私：日记内容不进日志；`character:reset` 可删 `fish:v2:*`；提供「导出关系档案」。

---

## 六、界面（M1）

| 界面 | 内容 |
| --- | --- |
| 桌宠窗口 | 六态动画（CSS/SVG）、气泡、右键菜单、拖拽、点击穿透、位置记忆 |
| 挂件 | 主窗口右下角，点击开聊天，状态色点 |
| 聊天面板 | 气泡流式、表情随内容、语音条播放、清空、关系小进度 |
| 设置面板 | 主动性（含静默期 0–14）、语音（开关/日限）、记忆（自动/手动/状态）、隐私（删除/导出）、重置 |
| 关系面板 | 阶段/熟悉/亲密/连续天数 + 大事记入口（打开 Obsidian） |

风格：现有 `src/assets/style.css` 的变量；**不新增全局样式**，全部 scoped。

---

## 七、Commit 拆分（M1）

| Commit | 内容 | 主要文件 | 验收 | 人天 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| C00 | 本计划 + 契约冻结 + 决策记录 | 本文件 | D1–D8 签字 | 0.5 | — |
| C00b | **角色内容包 v1**：vars/address-modes/core/voice/world + 20 组 few-shot + 20 话题卡 + 18 组台词 + 20 生活卡 + 情绪 KB（纯文本，可与 C01 并行） | `resources/character/**` | 盲测「像不像她」；禁用清单 0 命中；**无硬编码称呼**（换称呼即时生效） | 3 | C00 |
| C01 | 宿主骨架：types/store/manager/ipc + preload + 路由 + 功能开关 | `character/**`、preload、index.ts、renderer/main.ts | 启停不崩；状态读写；IPC 往返；core accept | 2 | C00 |
| C02 | 角色引导：建 agent、写人格模板（来自 C00b）、**首启问称呼/关系模式/禁忌（答「没有」→ 空禁忌）**、Obsidian 目录、连接自检 | `persona.ts`、`resources/character/persona/**` | 一键初始化/失败可读/幂等；自检 6 项；换称呼即时生效 | 2.5 | C01,C00b |
| C03 | 桌宠窗口 + 六态形象 + 互动 + 位置记忆 | `PetWindow.vue`、`Bubble.vue`、`art/**`、窗口 IPC | 透明/置顶/拖拽/位置记忆/六态/穿透 | 3 | C01 |
| C04 | 聊天面板 + 流式 + 表情映射 + 语音播放 | `ChatPanel.vue`、`chat.ts` | 首字<3s、取消、错误态、表情联动 | 3 | C01 |
| C05 | 关系引擎 + 事件 + 阶段 + 解锁 + 防刷 | `relationship.ts`、`STATE.md` 渲染 | core accept 全绿；阶段/上限/幂等用例 | 3 | C01 |
| C06 | 生活系统 + 主动性（含 QQ 首选/降级） | `contentCards.ts`、`life.ts`、`proactive.ts` | 静默期 0/3/7、上限、免打扰、安静几天、失败降级 | 3 | C03,C05 |
| C07 | 每日记忆 + 双写 + Obsidian 索引修复 + 密钥过滤/出处强制/检索预算 | `memoryJob.ts`、`redact.ts`、`mcp-server` 修复 | 幂等/重试/路径校验；删除清理用例；密钥不落盘；来源可核对 | 2.5 | C05 |
| C08 | 语音策略 + QQ 语音条 + **入站 STT** + 凭据防护 | `voicePolicy.ts`、`qqVoice.ts`、`stt.ts`、`package.json` | mock 单测 + 真机语音条/语音转写；失败降级 | 3 | C04,C02 |
| C09 | 安全与隐私（明示/危机/过滤/更正流程/公私有隔离/删除导出） | `safety.ts`、设置页隐私区 | 红队 20 条；更正保留审计；日志脱敏 | 2 | C04,C05 |
| C10 | 内容扩充（台词/生活卡/解锁/表情知识库/回复标记）+ 验收注册 + 打包冒烟 + 文档 | `resources/character/**`、`test/*`、README | accept 全绿；打包版桌宠/日记可用；`[emotion:*]` 标记可解析 | 3 | C03–C09 |

**合计 30 人天 + buffer = 31–38 人天（约 7 周单人）**。若砍掉桌宠（C03 降级为挂件）与内容首版（先用模板），可压到 5–6 周。

### M2（本计划外，另立版本）
Live2D、内容库 100+、教她（主动学习）、多端（飞书）、memory-wiki、关系档案导出增强、安全红队扩展、**表情模板玩法（想/举牌/对联/抱）与用户素材包导入**。

---

## 八、验收与测试

| 脚本 | 覆盖 |
| --- | --- |
| `test/character.core.accept.mjs` | 纯逻辑：关系三轴/阶段/日上限/幂等/dedup/日切/静默期计算/内容卡抽取/语音策略 |
| `test/character.store.accept.mjs` | `fish:v2:*` 读写、坏值回落、重置、迁移 |
| `test/character.memory.accept.mjs` | 假 gateway + 假 MCP：双写顺序、幂等、重试、路径校验、frontmatter |
| `test/character.voice.accept.mjs` | 语音优先级、要求识别（mock）、SILK 发送（mock fetch）、**入站语音转写（成功/失败降级）**、凭据不回显 |
| `test/character.ui.accept.mjs` | 挂件/桌宠/聊天/设置组件（stub harness，同 `test/ui.accept.mjs` 模式） |

**手工验收（M1 退出条件）**：QQ 语音条真机、QQ 主动消息窗口、次日记忆抽查 20 条、重启后状态不丢、断网/网关未起降级、打包版桌宠透明与位置记忆。

---

## 九、风险与回滚

| 风险 | 对策 |
| --- | --- |
| 角色模块拖垮启动 | 整段 try/catch；`characterEnabled` 开关；挂件/桌宠失败回退不可见 |
| 写坏 openclaw.json | 只经 configManager/官方 CLI；persona 只写 workspace 文件 |
| QQ 语音条失败 | 直连 + 降级文字；不重试；messageId 对账；凭据校验 |
| 记忆写错/丢失 | 只写确证 + 溯源 + 候选确认；C07 修索引缺陷；每天一篇 |
| 主动性打扰 | 全部设置项即时生效；默认静默期 3 天；一键安静 |
| 成本失控 | 语音日限 + 模型分级 + 每日开销可见；自动记忆可关 |
| 回滚 | 关闭 `characterEnabled` + `character:reset` 清 `fish:v2:*`；不动 voice/work/marketing |

---

## 十、决策（2026-11-01 已定）

> 2026-11-01 用户确认：D1–D10 全部按「建议」列执行；QQ 按普通功能处理（不设资质闸门）；入站语音 STT 支持；上游开源素材按许可入包 + 支持用户导入；知识库只用既有 Obsidian。

| # | 决策 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | 落地版本 | 4.0 / 1.0 / 双线 | **4.0**（voice→tts 链路完整、可写工作区；1.0 需补 2 天 tts 注入且无插件/DB 架构） |
| D2 | 代码归属 | 宿主模块 / 插件 | **宿主模块**（需要窗口/托盘/语音/网关单例；插件契约不支持多窗口） |
| D3 | 关系定位 | 朋友 / 妹妹 / 恋人未满 | **嘴硬心软的搭子以上、恋人未满** |
| D4 | 语音策略 | 已定：亲密解锁 + 要求即时可用；QQ 直连语音条 | 确认 |
| D5 | 形象路线 | 六态 SVG / 直接 Live2D | **六态先行**，M2 再 Live2D |
| D6 | 记忆确认 | 全自动 / 重要事实候选确认 | **自动 + 重要事实候选确认**（可配） |
| D7 | 主动性默认 | 静默期 0 / 3 天 | **3 天**（可改 0–14） |
| D8 | 首发功能开关 | 默认开 / 默认关（引导开启） | **默认关**，首启引导「要不要养一只鱼」 |
| D9 | 内容可覆盖 | 内置内容只读 / 允许用户覆盖 | **允许覆盖**：`<dataDir>/character/**` 优先于 `resources/character/**`，升级不覆盖用户改动（§十三.1） |
| D10 | 合规底线 | 按普通软件 / 按陪伴型加保护 | **加保护**：首启年龄确认、内容分级、免责声明、危机求助资源带版本号；未确认年龄时主动消息默认关（§十三.5） |

**以上 D1–D10 已于 2026-11-01 按建议值定稿；C00 结束，直接进 M0 → C01。**

---

## 十一、开工前置（M0，手工验证，3–5 天）

1. 建 `feiyu` agent + 写人格模板（C02 会自动化，M0 先手工验一次）。
2. 配 `memory.search`（火山 embedding 或 `provider:"none"` FTS），实测 `memory_search`。
3. Obsidian：指向真实 vault，建 `大肥鱼/` 目录，手写一条日记 → 次日召回验证。
4. TTS：语音页开启对话内语音 + 重启网关，`/tts` 验证；QQ 语音条按已验证配方手工发一条。
5. QQ：机器人加好友、记录 openid、验证主动消息窗口；**实测 `conversations.channel` 字段**（主动消息目标发现依赖它）。
6. **`silk-wasm` 打包可用性**：在 Electron 30 打包产物里跑一次 SILK 编码（验证 wasm 资源路径与 asar 行为）。
7. **QQ 语音条全链手工跑通**：`access_token` 获取 → 上传 `file_type=3` → 发 `msg_type=7`（`msg_seq` 递增、不带 content/msg_id）→ 收到语音条。
8. **动态注入通道实测**：宿主把 STATE/LIFE/few-shot 用三选一方案（user 前缀带 `[ctx]` / `AGENTS.md` 指令读文件 / 混合）注入后，agent 能稳定读到且不重复注入。
9. **QQ 凭据只读校验**：用「32 位 backup > clientSecretFile > clientSecret（仅 32 位）」优先级读一次，确认不写坏在用凭据。
10. 记录 10 项实验结论（命令/成功失败/耗时），失败项必须在 C01 前定位在平台层修掉，不拖进角色模块。

> M0 全过 = C01–C10 是纯工程；M0 任一项不过，问题会落在「MCP 工具可见性 / 索引缺陷 / memory.search / QQ 凭据」，先把它们修在平台层，不拖进角色模块。

---

## 十二、M3：直播展示页（Live Stage，后置）

> 详细规格：`doc/research/LIVE-STAGE-SPEC.md`。**M1 验收通过后才开 M3**，不阻塞基础功能。

目标：把角色本体（关系/生活/语音/记忆）接成「虚拟员工打工直播」舞台页——竖屏 1080×1920，含今日工资/专注/白干/被抓/手速/员工守则/倒计时/监视器/弹幕/字幕/清屏。

| Commit | 内容 | 人天 |
| --- | --- | --- |
| L01 | `LiveStageState` + 事件源（工资/专注/白干/被抓/手速）+ 宿主 IPC 推送 | 3 |
| L02 | 舞台页布局 + 六态角色 + 监视器 + 倒计时 + 员工守则轮换 | 4 |
| L03 | 弹幕注入（测试输入 + 本地回环 API）+ 字幕生成（模板优先/模型兜底）+ 队列 | 2.5 |
| L04 | 透明窗口 + OBS 浏览器源（loopback HTTP + token）+ 退出清屏 | 2.5 |
| L05 | 语音联动（TTS 念字幕）+ 特效 + 验收 | 2 |
| **合计** | | **约 14 人天（3 周）** |

**前置依赖**：C05 关系引擎、C06 生活/主动性、C08 语音策略（工资与状态复用它们的输出）。

**关键约束**：
- 舞台页只读宿主推送，不直接调模型/读文件；所有数字来自确定性事件（不靠模型判断）。
- 直播内容与私聊记忆隔离：私聊日记/约定不得出现在公开弹幕或字幕里（C09 的私私有隔离规则延伸到 M3）。
- 平台弹幕接入（B站/抖音）单独评估，依赖平台资质，不进 M3 首版。

---

## 十三、增补条款（v1.1，2026-11-01 评审）

> 依据：对 4.0 当前代码逐行核对 + 上游 4 仓库知识库（`doc/research/upstream/`）。每条给「加在哪节 / 条款 / 为什么 / 验收断言」。
> 级别：**P0** = 不做则对应 C 包不成立；**P1** = 影响成本/体验/回滚；**P2** = 可后置。

### 13.1 契约补洞（P0）

1. **动态注入通道（§3.4 / §4.4）**：OpenClaw 每轮只自动注入 `SOUL/IDENTITY/AGENTS/USER/MEMORY`，STATE/LIFE/few-shot 不会自己进上下文。三选一冻结后写进契约：① 拼进 user 前缀并带 `[ctx]` 标记（不落 sticky 会话）；② 写进 `AGENTS.md` 作为"读文件"指令；③ 混合。给出 token 上限与失败降级。
   - 验收：无 agent 时降级不崩；同一轮不重复注入；`[ctx]` 可被解析剥离。
2. **桌宠窗口独立入口（§3.2 / §5.1）**：`#/character-pet` 现在会套 `App.vue` 全壳、preload 又是全量桥。改为独立 renderer entry（bare 布局）+ 只暴露 `api.fish.character.pet`；窗口单例、`before-quit` 必须销毁；点击穿透必须配全局热键 + 托盘 + 半透明提示（逃生口）。
   - 验收：关主窗后进程 0 残留；穿透态仍可一键恢复；两窗口不共享全量 API。
3. **数据版本与清理（§4.1）**：`fish:v2:meta={schemaVersion}`；每个键标注「清理 owner + 触发点」；`day:*` 留 90 天、`life:*` 30 天、`dedup` 7 天由每日 tick 剪枝。
   - 验收：灌 120 天假数据，tick 一次后各前缀条数在上限内。
4. **导出 / 卸载 / 重置（§4.3、§1.3-8）**：补 `character:export`、`character:uninstall`、`character:onboarding:{status,submit}`；`reset` 拆三层——仅数值 / +记忆 / 全量（含 OpenClaw agent + bindings + Obsidian 日记归档）。现在只清 `app_meta`，agent 与 bindings 会留着，「可删除」是空承诺。
   - 验收：`uninstall` 后 `agents.entries.feiyu` 不存在；导出含关系/日记索引且不含密钥。
5. **会话可轮换（§4.5 / §5.5）**：固定会话键无法"清空记忆"。改 `conv:fish:main:<gen>`，清空 = 轮换 gen；流式取消要能定位到具体会话。
   - 验收：清空后问「刚聊什么」答不上，但日记仍可召回。
6. **内容包契约对齐（§3.1 / §4.6 / A.4）**：计划里的文件名与实物不符（`cards/lines.v1.json` 等）；`emotions.v1.json` 有超出枚举的「惊」；`resources/character/art/` 尚不存在。补「内容校验函数 + 覆盖层」：`<dataDir>/character/**` 优先（D9）。
   - 验收：改一条 life-card 立即生效且升级不覆盖；非法 emotions 加载时只告警不崩。
7. **模板不被覆盖（§4.4）**：首写人格模板时落 `.fish-managed.json`（文件→hash），后续仅在"缺失或未改"时更新，用户改过的不覆盖。
   - 验收：改一句 SOUL.md 后重跑 bootstrap，改动保留。
8. **隐私承诺逐条落地（§1.3-8 / §九）**：当前实现无法做到"删除即消失"（agent、bindings、Obsidian 三处）。按第 4 条补齐；日记写入前过滤密钥串。
   - 验收：工作笔记里的密钥串 3 轮内不出现在对话；删除后可验证三处均已处理。

### 13.2 平台前置修复（P0/P1，先修再用）

| # | 缺陷（证据） | 修法 | 验收 |
| --- | --- | --- | --- |
| 9 | **Obsidian 检索无目录隔离**：`search_notes` 无目录过滤、MCP 全 agent 共享 → 角色会读到工作知识库 | **仍用既有 Obsidian 知识库**（不新增 KB 服务/表/索引），只加目录/tag 白名单：角色 MCP 指向 `大肥鱼/` 子目录或只索引该 tag | 工作笔记内容不出现在角色回复 |
| 10 | **QQ 凭据写入无校验**：一次保存可写坏在用通道 | 优先级「32 位 backup > clientSecretFile > clientSecret(仅 32 位)」，只读不写；长度校验、不覆盖可用凭据 | 填 16 位保存后配置不变且 UI 报错 |
| 11 | **语音链缺一环**：仓库无 mp3 解码/ffmpeg，`VoiceSpeakInput` 无法指定 format | TTS 直出 **16k PCM** → 包 WAV → `silk-wasm`；`VoiceSpeakInput` 增 `format/sampleRate` 并回写 `PLAN-VOICE` §7.2 | mock 断言请求 `format=pcm`、输出 RIFF 16kHz |
| 12 | **成本不可见**：`usage` 恒 0，估算器在 work 插件内 | 角色自建每日四类调用计数（聊天/记忆/信号/语音判定）+ token 估算 + 超限告警一次，落 `fish:v2:*` | 设置页显示计数、重启不清零 |
| 13 | **30s tick 在 work 插件内**：角色不能依赖它 | 角色自建宿主级 tick + dispose，不依赖 work 插件 | 禁用 work 后静默期到点仍发 1 条 |
| 14 | **语音条与表情混发**：TTS 会把 `[emotion:xx]` 念出来；分段回复逐泡重置语调 | 合成前剥离 `[A-Za-z一-鿿]{1,6}` 标记、纯表情段跳过；整条语义文本只合成一次，总时长 ≤20s | 语音里不含方括号标记；两段语调不一致不判失败 |

### 13.3 人天与排序校准（P1）

- **C00b 3 → 4–5 人天**（78 条素材 + 盲测 + 无硬编码称呼验收）；**C03 3 → 4 人天**（行为仲裁/DIP clamp/命中掩码才是主复杂度，窗口物理不是 M1 目标）；**C08 2.5 → 3 人天**（入站 STT）。
- **平台前置修复（13.2）单列 3–4 人天**，不计入 C 包。
- **M1 合计**：30 → **37–44 人天**（含 buffer 39–46），与 `FEASIBILITY-FISH.md` 的 36–53 对齐口径。
- **排序优化**：C06 不依赖 C03（气泡只需主窗）→ 与 C03 并行，省约 3 人天；AI 明示进 C00b + C02（不等 C09）；C07 紧跟 C05；打包冒烟前移到 C03 之后；C10 新内容一律加版本号文件（`topics.v2.json`），不改旧结构。

### 13.4 上游接入（P1，可按许可取用）

| 上游文件（已入库） | 用于 | 具体做法 |
| --- | --- | --- |
| `upstream/dafeiyu-astrbot/persona/大肥鱼-人格.md`（v2.1） | C00b 人格母本 | 重写为我们的变量体系（`{{address}}`）；**禁用清单不进注入**，只做验收 |
| `upstream/dafeiyu-astrbot/docs/知识库-热梗词典示例.md` | C00b/C10 世界书 | 只进世界书、按需检索（不常驻） |
| `upstream/dafeiyu-astrbot/docs/自主生活开发方案.md` | C06/C07 | 生活状态机、预算、恢复策略 |
| `upstream/dafeiyu-astrbot/docs/踩坑合集.md` | C09 反例集 | 「回声病」「记忆写反」「格式回声」→ 直接变成红队用例 |
| `upstream/dafeiyu-bot/Resources/QQStickers/manifest.json` | C10 `emotions.v1.json` | 增 `context`（使用 + 禁用场景）、`license`、`publicSharing` 字段，逐条对齐 |
| `upstream/codex-deepseek-pet/docs/动画与窗口物理.md`、`2D角色与动作规范.md` | C03 | 行为仲裁（专注/聊天/拖拽 > 自主动作）、有限动作播完释放、待机 3 分钟入睡、位置按 DIP clamp |
| `upstream/blue-whale-agent/chat-workspace/AGENTS.md` | 成本 P2 | 本地小模型分流**只列 P2**，M1 只做持久化计数（第 12 条） |

**素材策略（2026-11-01 已定）**：上游素材都是开源的，**可以拿**——按各自许可入包并署名即可（MIT / CC0 / 署名许可 1.0）；`PhotoStickers` 这类 **CC BY-NC-SA 非商业**素材不进安装包，改为**支持用户导入**（`<dataDir>/character/stickers/`，导入时校验格式 + 记录许可自证）；上线物料写全「作者 YunYueSama + 仓库地址」及修改说明；NOTICE 至少列 `silk-wasm` 与所用素材来源。

### 13.5 验收与发布（P1）

- 5 个角色 accept 脚本**注册进** `scripts/run-all-accept.mjs` 与 `package.json`（现在不注册 = 不跑）。
- 默认关 + dogfood 一周；`enabled` 落 `fish:v2:settings`，**不进 AppConfig**（`app.json` 保存会触发 config patch）。
- `extraResources` 整目录：`resources/character/**` 已入库并按版本管理，避免「草稿随包」；升级不得覆盖 `<dataDir>/character/**`（D9）。
- **素材与导入**：开源素材按许可入包并署名（`NOTICE`）；CC BY-NC-SA 素材只支持**用户导入**（`<dataDir>/character/stickers/`）；打包冒烟断言安装包内无 NC 素材。
- **知识库边界**：不新增 KB 服务/表/索引；角色只有既有 Obsidian（目录/标签白名单）；验收断言「停用角色后工作知识库无新增索引」。
- **入站 STT**：QQ 语音条转写成功 / 转写失败降级 各一条用例（`character.voice.accept`）。
- 合规：首启年龄确认、内容分级、免责声明、危机求助资源带版本号；未确认年龄时主动消息默认关（D10）。

---

## 附录 A · 契约样例

### A.1 `STATE.md`（宿主写）

```markdown
# 鱼的状态（宿主维护，勿改）
- 阶段：自己人（46 天）
- 称呼：{{address}}（用户在设置里填的昵称；未填则「你」）
- 熟悉度：52 ｜ 亲密度：68 / 100
- 连续互动：7 天
- 她的心情：有点想他
- 今日主动：剩 1 条（上限 2）｜ 静默期：已过
- 已解锁：进阶称呼、收集贝壳、摸头、一个秘密
```

### A.2 `LIFE.md`（宿主每日写）

```markdown
# 她的一天（2026-11-01）
- 上午：睡到很晚，吃了两大碗白饭（满足）
- 下午：在数贝壳，攒到第 7 个（有点得意）
- 晚上：想找人说话（等用户）
- 小目标：再攒 3 个贝壳换发绳（7/10）
```

### A.3 日记（agent 每晚写，双写）

```markdown
---
date: 2026-11-01
tags: [大肥鱼/日记]
stage: 自己人
intimacy: 68
mood: 有点想他
source: openclaw-memory/2026-11-01
---

# 2026-11-01 · 本鱼的日记

今天摸了很久的鱼，贝壳还差 3 个就能换新发绳。
晚上 {{address}} 来了，说项目卡住。我听不懂，但陪他骂了两句甲方，他笑了。
记住：他凌晨一点后不想聊工作，只想听废话。
明天想问：方案过了没。过了就讨一颗 Token。
```

### A.4 内容包 v1（已起草，C00b 产出）

| 文件 | 内容 |
| --- | --- |
| `resources/character/persona/core.md` | 硬底稿：身份/性格/口癖/边界/自检 |
| `resources/character/persona/vars.md` | **变量与称呼系统**（`{{address}}`/`{{userName}}`…，空值降级「你」） |
| `resources/character/persona/address-modes.v1.json` | **称呼 + 关系模式**（companion/sister/lover、阶段默认、禁忌、外号） |
| `resources/character/persona/voice.md` | 8 条风格规则 + 禁用清单 + **20 组 few-shot** + 5 阶段语气表 |
| `resources/character/persona/world.md` | 世界书：住处/工位/贝壳/日常/关系史/禁忌 |
| `resources/character/cards/topics.v1.json` | **20 张话题卡**（吃/摸鱼/加班/深夜/生病/出差/生日/节日/吵架和好/打扮/拍照/剧…） |
| `resources/character/cards/lines.v1.json` | **18 组约 100 句台词**（问候/晚安/被夸/委屈/拒绝/道歉/想念/吃醋/关心/称呼/直播/节日…） |
| `resources/character/cards/life-cards.v1.json` | **20 张生活事件卡**（每日抽一套） |
| `resources/character/emotions.v1.json` | 14 情绪 + 六态映射 + 动作标注（自建） |

**称呼是设置项**：内容里不写死人名；首启问「怎么称呼你 / 什么关系模式 / 有没有不能叫的」；阶段推进可问、用户同意才换；禁忌称呼回退「你」。

**注入预算**：常驻 = core + voice 规则 + 当前阶段语气行（约 1000 字）；按场景注入 = 3–5 条 few-shot + 1–2 张话题卡 + 当天 LIFE/STATE（约 1500 字）；世界书/记忆走检索。**绝不整包注入。**

### A.5 人机感测试清单（验收用）

- [ ] 10 条回复与通用模型混排，用户能认出 ≥8 条是她。
- [ ] 禁用句 0 命中：有什么可以帮您 / 作为 AI / 建议您 / 希望对你有帮助 / 首先其次总之。
- [ ] 连续 20 轮不出现：每句反问、复述用户、客服腔、列表式回答。
- [ ] 每 10 轮至少 1 次「她自己的事」（贝壳/工位/摸鱼/昨晚几点睡）。
- [ ] 至少 1 次「不接话/岔开/装死」，且不显得敷衍。
- [ ] 提到昨天的事时，与昨天日记一致；不一致 ≤1 次且能自我更正。

---

*契约冻结后只增不改；范围变更走新版本号追加，不就地改冻结契约。实现时若与 `PLAN-4.0.md` 的宿主边界冲突，以 PLAN-4.0 为准并回写本文件。*
