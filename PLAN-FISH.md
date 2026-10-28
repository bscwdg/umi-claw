# Umi Claw「大肥鱼工作搭子」跨版本开发规划（PLAN-FISH v1.0）

> 状态：**v1.0 已冻结（2026-10-28），进入 F00/F01 实施；契约冻结后只增不改** ｜ 作者：产品+工程联合稿
> v0.2：追加“鱼语音”子系统——TTS、音色克隆、唱歌三条技术链分开规划（见 §13）。
> v0.3：拍板首发语音供应商为**火山引擎/豆包语音**；TTS 与声音复刻先行，唱歌待专项验证。
> v0.4：追加“已有歌曲人声替换”路线（SVC：分离人声→音色转换→混音），与歌词重唱分开。
> v0.5：拍板**第一版不做唱歌**（SVS 重新唱与 SVC 人声替换均后置）；第一版语音只做 TTS + 音色克隆说话。
> v0.6：全文一致性收口——首发范围移除“唱短歌”残留表述；TTS/音色克隆统一标注为首发（F10–F13）；§3.2 能力矩阵补语音行；唱歌仅保留 §13.9 后置预研。
> v0.7：拍板**保留声音克隆（复刻音色说话，F12 首发）**，**不做人声替换（SVC）**；克隆能力仅用于 TTS 朗读，不用于歌曲。
> v0.8：拍板素材策略——**第三方“大肥鱼”素材一律不进仓库/安装包，只由用户运行时自行导入**（署名+许可强制展示，见 §8）；内置素材保持原创。
> v0.9：拍板**产品内定名「大肥鱼」**、**1.0 不做功能裁剪**（鱼干/米粒/聊天经本地 OpenClaw 网关与 2.0/3.0 全量对齐）；内置形象先用原创 SVG、F00 补 LICENSE、声音复刻先内部 Dogfood、语音预算独立。
> v1.0：全部待拍板项关闭（见 §12/§13.10），规划冻结。
> 适用分支：`release/3.0`（首发开发）→ 移植 `release/2.0` → 移植 `release/1.0`
> 关联资料：`PLAN-3.0.md`（工作域基线）、`PLAN-2.0.md`（营销域基线）、README 三版本说明

## 〇、调研结论速览

- “大肥鱼”是 DeepSeek 的非官方社区拟人形象（蓝色鲸鱼/鲸鱼娘），社区人设为“爱吃白饭、摸鱼、讨要 Token、偶尔摆烂但真能干活”。
- 社区现有四类玩法：表情包/皮肤、DSH 余额挂件、互动桌宠、AI 自主上网（刷 B 站评论，“鱼灾”）。
- 参考项目：
  - `EDMOK/blue-fish-archive`：静态表情档案馆（271 枚），无仓库级 LICENSE，素材 CC BY-NC-SA 4.0，单张权利归各作者。
  - `Loping151/dsh-nekowhale-stickers`：DSH/MCP 表情检索与发送插件（322 枚），代码 Apache-2.0，素材 CC BY-NC 4.0。
  - `lmy414/bluedafeiyu`：Astro 前台 + Payload 后台 + 投稿审核发布系统，代码 MIT，图片不随代码授权，部分作品授权 unknown。
- **我们的取舍**：做“工作搭子”，不做“自动冲浪机”。核心循环是
  `工作事件 → 鱼的状态/表情/气泡 → 用户处理 → 得到鱼干 → 鱼成长`；
  **鱼因“用户确认的工作产出”变肥，不因乱调模型变肥**；AI 消耗 Token 记为“米粒”，承担预算守护职责。
- **定名（v1.0 冻结）**：产品内直接叫「大肥鱼」；视觉为原创蓝色胖鱼，不复制任何社区美术（商标/联想风险对策见 §11）。
- v0.2 追加：鱼不仅显示状态，还要能**说话、使用授权复刻音色朗读**（唱歌后置，见 §13.9）；语音能力不依赖业务数据库，因此可回溯到 1.0/2.0/3.0 三个版本。

## 一、产品定位

### 1.1 一句话

住在 Umi Claw 右下角的一条名叫「大肥鱼」的原创蓝色胖鱼：感知各版本产品里的真实工作/使用事件，用表情和气泡做情感化反馈，用鱼干成长做正向激励，用米粒（Token）统计做成本守护。

### 1.2 不做什么（边界）

- 不做 AI 自动刷视频、自动评论、自动私信等公共平台自发行为。
- 不做诱导烧 Token 的玩法（调用模型不产鱼干）。
- 不在主程序安装包内打包任何第三方大肥鱼图片素材（授权原因见 §2）。
- 不做惩罚性养成（等级只升不降；体重只升或保持；只保留心情自然回落）。

### 1.3 核心循环

```text
各版本业务动作（待办完成/内容确认/技能安装…）
        │  版本适配层（EventSource）
        ▼
FishEvent（reward / signal / usage）
        │  幂等去重 + 频控
        ▼
鱼状态机（表情 + 气泡 + 鱼干 + 经验 + 心情）
        │  用户点击/投喂/跳转处理
        ▼
成长档案 & 当日米粒统计（本地存储）
```

## 二、授权与开源边界（必须先讲清）

**“我们也是开源的”不等于可以使用所有开源仓库里的素材。** 许可证是分开的：

| 对象 | 代码 | 素材/数据 | 能否进我们安装包 |
| --- | --- | --- | --- |
| EDMOK/blue-fish-archive | 无 LICENSE（默认保留权利） | CC BY-NC-SA 4.0 + 各作者保留 | 否 |
| dsh-nekowhale-stickers | Apache-2.0（需保留 NOTICE） | CC BY-NC 4.0（禁止商用） | 代码可借鉴/复用，素材否 |
| lmy414/bluedafeiyu | MIT | 图片另有授权，部分 unknown | 代码可参考，素材否 |

原因：MIT/Apache 与 CC BY-NC（非商业）不能混在一个发行物里；即使 Umi Claw 开源免费，只要存在商业分发场景（企业内置、应用市场、付费服务等），NC 素材就构成违约风险。

本项目的授权策略（硬约束）：

1. **默认内置素材全部原创**（SVG/CSS 实现，无第三方位图），随仓库协议分发。
2. **（已拍板 v0.8）** 第三方素材只支持**用户运行时自行导入本地素材包**，仓库、安装包、自动更新包中均不内置任何一张；导入时强制展示作者、来源、许可，NC 包标注“非商业，不得随产品再分发”，unknown 包标注“授权未知，风险自担”。
3. 不内置任何远程 iframe / 远程脚本 / 远程图片地址。
4. 参考 Apache 项目的代码时，保留其 NOTICE（仅在确实复制代码时）。
5. 顺手补齐本仓库法律文件：根目录缺 `LICENSE`，`package.json` 缺 `license` 字段（README 已声明 MIT）——**开工前先补**，否则“我们是 MIT 开源”在法律上不完整。

三个调研仓库的使用口径：`blue-fish-archive`（无仓库 LICENSE，代码不复制；素材 CC BY-NC-SA）、`dsh-nekowhale-stickers`（代码 Apache-2.0 可借鉴并保留 NOTICE；素材 CC BY-NC）、`bluedafeiyu`（代码 MIT 可参考；素材授权独立、部分 unknown）——三者的图片统一走第 2 条用户自导入，不随产品分发。

## 三、跨版本移植总纲（本规划的第一约束）

### 3.1 三个版本的底座盘点（已核对分支）

| 维度 | release/1.0 | release/2.0 | release/3.0 |
| --- | --- | --- | --- |
| 版本号 | 1.0.0 | 1.1.0 | 3.0.0 |
| 技术栈 | Electron 30 + Vue3 + Pinia + vue-router | 同左 | 同左 |
| 外壳 | 自定义标题栏 + 侧栏 + `App.vue` 同构 | 同构（多 ProjectSwitcher） | 同构（分工作/管理两组导航） |
| 业务数据库 | **无** | sqlite + db-worker，含 `app_meta` + `metaGet/metaSet` | 同机制（8 表 + `app_meta`） |
| AI 网关 | 无 gatewayClient，但**内置并管理本地 OpenClaw HTTP 网关**（127.0.0.1:port + Bearer 令牌，作 usage/聊天通道） | 有 gatewayClient（营销域流式） | 有 gatewayClient（工作域流式） |
| IPC 组织 | 全平铺在 `main/index.ts` | `registerIpcHandlers` + `ipc/*` 聚合注册 | work 域独立注册 |
| preload | 单个 `api` 对象 | 同 | 同（多 `api.work`） |
| 资源打包 | `extraResources: resources → resources` | 同 | 同 |
| 业务域 | OpenClaw 管理/技能/渠道/知识库 | 商家/项目/内容三版/热点/扫描/顾问 | 今日/记录/问答/报告/工具箱/知识库/提醒 |

结论：三分支**外壳同构、资源通道一致、IPC/preload 形态一致**；P0 的差异只有“存储”和“业务事件来源”，用两个 SPI 吸收，P1 再增加一个聊天通道适配（gatewayClient / 本地 OpenClaw 网关）。鱼模块主体做到**跨分支字节一致、可直接 cherry-pick**。

### 3.2 能力矩阵（移植后各版本实际得到的功能）

| 能力 | 1.0 | 2.0 | 3.0 | 说明 |
| --- | --- | --- | --- | --- |
| 右下角挂件 / 表情状态机 / 气泡 / 轻养成 | ✅ | ✅ | ✅ | 纯前端+本地状态 |
| 互动（投喂/撸鱼/设置/静音） | ✅ | ✅ | ✅ | |
| 原创素材 + 本地素材包导入 | ✅ | ✅ | ✅ | |
| 鱼干（确认类动作奖励） | ✅ OpenClaw 动作 | ✅ 营销动作 | ✅ 工作动作 | 见 §4.4 |
| 米粒 Token 统计 / 预算预警 | ✅ | ✅ | ✅ | 1.0 走本地 OpenClaw 网关 usage；取不到不记假账 |
| 气泡点击跳转业务页 | 仅管理页 | ✅ | ✅ | 跳转表按版本配置 |
| 独立桌面宠物窗口（P1） | ✅ | ✅ | ✅ | 纯 Electron 能力 |
| 鱼式聊天（P1） | ✅ | ✅ | ✅ | 2.0/3.0 复用 gatewayClient；1.0 走本地 OpenClaw 网关 |
| 鱼语音：TTS / 音色克隆说话 | ✅ | ✅ | ✅ | 火山/豆包首发（F10–F13，见 §13）；唱歌第一版不做 |

**v1.0 决策：1.0 不做功能裁剪，与 2.0/3.0 全量对齐**。鱼干来自 OpenClaw 管理域中“已完成并确认”的动作（环境初始化、技能安装/更新、运行里程碑）；米粒来自本地 OpenClaw 网关的会话 usage；P1 鱼式聊天走本地网关（Bearer 令牌）。1.0 仍无 sqlite，鱼状态一律走 `userData/fish/state.json`，不新增数据库。

### 3.3 移植硬约束（架构红线）

1. **核心零耦合**：`electron/main/fish/core/**` 只允许 import Node 内置模块与本目录类型，禁止 import `electron`、`vue`、`work/**`、`marketing/**`、`obsidian/**`、各版 database 具体实现。
2. **差异进适配层**：所有版本差异只能出现在 `electron/main/fish/platform/<version>.ts` 与 `src/fish/platform.<version>.ts`；核心与通用 UI 不允许出现 `if (version === …)`。
3. **不新增数据库表**：2.0/3.0 用 `app_meta` 的 `fish:v1:` 前缀键；1.0 用 `userData/fish/state.json`。不改 db-worker 白名单、不写迁移。
4. **IPC 独立命名空间**：统一 `fish:*` 频道 + 统一 `{ok,data}|{ok,error}` 信封，不挂在 `work:*`/`marketing:*` 下，保证三分支契约一致。
5. **接线点最少化**：每个分支接线只允许触碰 4 个文件：`electron/main/index.ts`、`electron/preload/index.ts`、`electron/preload/index.d.ts`、`src/App.vue`（2.0/3.0 可经现有 IPC 聚合文件，但计入接线改动）。
6. **UI 零全局污染**：鱼组件样式全部 scoped，不改 `src/assets/style.css`、不新增路由/导航项（P0 设置入口在挂件自身弹层；P1 再进各版设置页）。
7. **失败静默降级**：存储损坏、事件源初始化失败、素材包异常时，挂件回退为静态空闲态并可在设置里重置，**绝不阻断各版本主功能启动**。
8. **核心提交可干净 cherry-pick**：新增路径全部是三分支不存在的新目录（`electron/main/fish/`、`src/fish/`、`resources/fish/`、`test/fish.*.accept.mjs`），不与任何现有文件重名。

## 四、产品设计（P0）

### 4.1 鱼的状态机

| 状态 | 触发 | 表现 |
| --- | --- | --- |
| idle 空闲 | 无事件 5 分钟 | 呼吸摇摆，偶发待机台词（30 分钟频控） |
| busy 忙碌中 | 收到进行中信号（AI 流开始/任务执行） | 摆动加快 |
| thinking 干饭思考 | usage 事件（模型生成中） | 对着碗扒饭（米粒动画） |
| success 开心 | reward 事件到账 | 跳跃 + 鱼干 +N 气泡 |
| waiting 待处理 | signal: 有待确认候选/到期提醒 | 举牌气泡，点击跳转 |
| warning 吃撑了 | 当日 Token 超预算 | 抱肚焦虑，气泡提示 |
| error 翻车 | 业务失败信号（流错误/同步失败） | 冒烟躺平，点击查看 |
| sleep 睡觉 | 免打扰时段（默认 22:00–08:00，可关） | 不出气泡，只保留状态色 |

### 4.2 成长体系

- **鱼干**：确认类产出的奖励货币；可被“投喂/装扮（P1）”消耗，但消耗不影响等级。
- **经验/等级**：鱼干与互动共同产生经验；等级只升不降。
- **体重**：累计鱼干映射的固定区间档位（只升/保持），对应挂件尺寸与昵称文案。
- **心情**：投喂、撸鱼、完成工作上升；长时间不互动缓慢回落至“普通”，不降为负向等级。
- **连续工作天数 streak**：按当地日切，当天有 ≥1 笔确认类奖励即记 1 天。
- 所有数值 P0 写死在核心配置表（`core/economy.ts`），不做后台可调。

### 4.3 米粒（Token）与预算（全版本）

- P0 只统计：当日请求数、输入/输出 Token 数（来自网关流结束时的 usage；拿不到 usage 的模型不计入，绝不估假账）。
- **1.0 通道**：OpenClaw 本身以本地 HTTP 网关运行（`http://127.0.0.1:<port>` + Bearer 令牌），usage 从网关会话/状态接口采集；网关未返回 usage 的模型同样不记账。
- 每日预算默认值给定、可改、可关闭；超阈值只发一次 warning 气泡（当日幂等）。
- 费用估算（按模型单价）列 P1：依赖价格表，2.0 已有 `docs/token-calibration.md` 可复用。
- 鱼不主动发起任何模型调用；鱼式聊天（P1，含 1.0 本地网关通道）单独按钮触发，单独计入米粒。
- **语音费用独立预算**（v1.0 决策，见 §13.10）：TTS 按字符/时长在语音面板单独限额，不并入米粒；统一费用视图列 P1。

### 4.4 奖励规则表（P0，数值为默认值，可调）

原则：**只有“用户确认的产出/完成的动作”给鱼干；AI 生成中、候选待确认、纯调用不给。** 同幂等键只发一次。

**3.0 工作域（WorkEventSource）**

| 事件 | 挂钩点（现有模块） | 鱼干 | 备注 |
| --- | --- | --- | --- |
| todo.done | todoManager 勾选完成 | +5 | refId=`todo:<id>:<doneAt日>` |
| record.confirm | recordManager 候选确认/手动记录确认 | +3 | 批量确认逐条计，当日封顶 60 |
| report.confirm | reportManager 日报/周报确认 | +20 / +50 | 同一报告版本幂等 |
| knowledge.import | knowledgeManager 文档入库 | +2/篇 | 单次批量封顶 30 |
| qa/token、tool/run | 流式 usage | 0 | 只计米粒 |
| reminder.fire | reminderManager 到点 | 0 | waiting 气泡 |

**2.0 营销域（MarketingEventSource）**

| 事件 | 挂钩点 | 鱼干 | 备注 |
| --- | --- | --- | --- |
| content.confirm | contentManager 版本确认/采用 | +15 | 每内容每日一次 |
| content.publish | 发布动作（若已有） | +20 | 幂等 |
| knowledge.import | 营销知识库入库 | +2/篇 | 封顶 30 |
| scan.commit | scanRecognizer 识别结果提交 | +3 | |
| hot.refresh | hotManager 手动刷新 | +2 | 每日封顶 10 |
| advisor/content 流 usage | ipc 流结束 | 0 | 只计米粒 |

**1.0 管理域（OpenClawEventSource）**

| 事件 | 挂钩点（现有模块） | 鱼干 | 备注 |
| --- | --- | --- | --- |
| env.init-complete | downloadManager 环境初始化完成 | +20 | 每个 dataDir 一次性，refId=`env:<dataDirHash>` |
| skill.install / skill.update | clawManager 技能动作完成 | +5 | 当日封顶 30 |
| claw.run-milestone | 连续运行满 30/120 分钟（进程事件，不轮询） | +2 / +5 | 每档每日一次，同时 +心情 |
| openclaw.usage | 本地网关会话 usage | 0 | 只计米粒；取不到不记假账 |

### 4.5 气泡与交互

- 气泡队列单条展示，同类冷却（默认 10 分钟），免打扰时段静默；错误类不受冷却限制但 30 分钟最多 1 条。
- 气泡按钮：主操作（跳转/查看）、知道了；文案只带事件线索（如“有 2 条工作记录等你确认”），**不带正文、不带上下文**。
- 跳转表走版本适配：3.0 `/work/records` 等；2.0 营销路由；1.0 仅管理页路由。
- 单击鱼：收起/展开状态卡（今日鱼干、米粒、连续天数）；双击：投喂（+心情，消耗 0，每日前 5 次有效）；右键：设置/素材包/重置。

### 4.6 设置（挂件自带弹层，不侵入各版设置页）

挂件开关、大小（小/中/大）、免打扰时段、气泡频控开关、Token 预算（全版本）、素材包管理、成长数据重置（二次确认）、关于与素材署名总览。语音字符预算在语音面板单独配置。

## 五、分期范围

### P0：应用内工作鱼（首发 3.0，随后移植 2.0/1.0）

1. 鱼核心：状态机、经济规则、幂等去重、日切、存储 SPI（meta + JSON 两种实现）。
2. 三版本事件源适配（§4.4）与 usage 采集（2.0/3.0 网关流；1.0 本地 OpenClaw 网关）。
3. `fish:*` IPC + preload `api.fish` + 类型声明。
4. `FishWidget.vue`：原创 SVG 六态动画、气泡、状态卡、设置弹层，挂 App.vue。
5. 本地素材包导入（§8），默认仅原创内置。
6. 核心验收 + 各分支接线验收 + 打包冒烟。
7. 鱼语音首发（F10–F13，详见 §13）：火山/豆包 TTS + 已授权声音复刻说话；唱歌（SVS/SVC）不在首发。

### P1：桌宠与对话

- 独立透明置顶 `BrowserWindow`（无边框、跳过任务栏、边缘吸附、拖拽、鼠标穿透、位置记忆、托盘菜单）——三分支同享。
- 鱼式聊天（三版本同享）：2.0/3.0 复用 gatewayClient + 各自记忆上下文，`conversation_key=conv:fish`，用户主动触发；1.0 走本地 OpenClaw HTTP 网关（Bearer 令牌），F08 先做对话接口 SPIKE，若网关无对话接口则降级为“拉起网关 Web UI”并重新拍板（不影响 P0）。
- 成就系统（周报达人、连续打卡、预算大师等）。
- Token 费用估算与余额展示（仅官方 API，禁止抓取网页会话凭据）。

### P2：生态（谨慎）

- 素材包市场/订阅式更新（只拉 JSON 清单，图片走用户确认）、更多皮肤与文字表情包模板。
- 1.0 本地网关聊天的多会话/附件能力增强（依 F08 SPIKE 结果排期）。
- 私域渠道（微信/飞书/企微）只做“草稿生成→人工确认→发送”；公共平台自动互动永久不做。
- 社区投稿/审核后台：参考 bluedafeiyu，独立项目评估，不进客户端。

## 六、系统架构

### 6.1 目录与文件（全部为新增路径）

```text
electron/main/fish/
├── core/                    # 跨分支字节一致，零外部依赖
│   ├── types.ts             # FishState / FishEvent / FishSettings / 视图类型
│   ├── economy.ts           # 奖励规则、经验/体重/心情、日切、封顶
│   ├── stateMachine.ts      # 状态机与气泡队列/频控
│   ├── store.ts             # FishKeyValueStore 接口 + 键名约定
│   ├── jsonStore.ts         # 1.0：userData/fish/state.json（原子写 tmp+rename）
│   ├── metaStore.ts         # 2.0/3.0：database.metaGet/metaSet（fish:v1: 前缀）
│   ├── manager.ts           # FishManager：事件入口、持久化、订阅推送
│   └── packs.ts             # 素材包解析/校验/启用（纯逻辑，文件 IO 注入）
├── ipc.ts                   # registerFishIpc(platform)：fish:* 频道与信封
└── platform/
    ├── work.ts              # 3.0 WorkEventSource + 跳转表 + metaStore 装配
    ├── marketing.ts         # 2.0 MarketingEventSource + 跳转表
    └── openclaw.ts          # 1.0 OpenClawEventSource + jsonStore 装配

src/fish/
├── FishWidget.vue           # 挂件（scoped 样式，依赖仅 vue）
├── FishBubble.vue
├── FishCard.vue             # 今日状态卡
├── FishSettings.vue         # 设置/素材包/署名弹层
├── art/fish-original.svg    # 原创六态精灵（或内联 SVG 组件）
└── api.ts                   # window.api.fish 的前端封装与类型

resources/fish/
└── builtin/                 # 原创素材 + builtin-pack.json（随包分发）

test/
├── fish.core.accept.mjs     # 纯 Node，核心规则/存储/幂等（三分支同一份）
├── fish.packs.accept.mjs    # 素材包校验
└── fish.ui.accept.mjs       # 各分支接线与挂件渲染（按分支增补）
```

### 6.2 核心 SPI

```ts
// 存储（差异点 1）
export interface FishKeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<void> // null = 删除
}

// 事件（差异点 2）
export interface FishEvent {
  kind: 'reward' | 'signal' | 'usage'
  type: string                 // todo.done / content.confirm / token / error ...
  refId?: string               // 幂等键；同键只处理一次（7 日去重窗）
  fish?: number                // 鱼干增量（reward）
  mood?: number                // 心情增量
  tokens?: { input: number; output: number } // usage
  tone?: 'success' | 'waiting' | 'warning' | 'error' | 'info'
  message?: string             // 气泡线索文案（不含正文）
  link?: string                // 版本内路由
  at?: number
}

export interface FishEventSource {
  start(emit: (e: FishEvent) => void): void
  stop?(): void
}

export interface FishPlatform {
  store: FishKeyValueStore
  source: FishEventSource
  links: Record<string, string>   // 类型 → 路由
  features: { usage: boolean; rewards: boolean; chat: boolean } // v1.0 起三版本均为 true
}
```

装配：`main/index.ts` 在数据库/管理器就绪后调用一次 `registerFishIpc(buildFishPlatform())`；1.0 在 `registerIpcHandlers` 内同点调用。FishManager 单例，挂在主进程内存，渲染端重载不丢状态。

P1 鱼式聊天再加一个 `FishChatChannel` 适配：2.0/3.0 绑定 gatewayClient，1.0 绑定本地 OpenClaw HTTP 网关（Bearer 令牌，仅访问 127.0.0.1）；对话能力差异只允许出现在 platform 适配层，核心与 UI 不分支。

### 6.3 IPC 契约（频道冻结后只增不改）

| 频道 | 方向 | 入参 | 返回 |
| --- | --- | --- | --- |
| `fish:state:get` | invoke | — | FishStateView（档案+当日+当前状态） |
| `fish:settings:get` | invoke | — | FishSettings |
| `fish:settings:set` | invoke | patch（白名单字段） | FishSettings |
| `fish:interact` | invoke | `feed`/`pet`/`dismiss:<bubbleId>` | 更新后的视图 |
| `fish:usage:get` | invoke | date? | 当日米粒（features.usage=false 时返回 null） |
| `fish:packs:list` | invoke | — | 包列表（含署名/许可/启用态） |
| `fish:packs:import` | invoke | 用户选定目录路径（主程序校验） | 导入结果 |
| `fish:packs:setEnabled` | invoke | id, enabled | — |
| `fish:packs:remove` | invoke | id | — |
| `fish:reset` | invoke | — | 清空 fish 键/JSON |
| `fish:event` | main→render | FishStateView + 气泡 | 推送频道 |

错误码（模块自洽，不依赖各版 errors）：`FISH_STORE_IO`、`FISH_BAD_STATE`、`FISH_PACK_INVALID`、`FISH_PACK_UNSAFE_PATH`、`FISH_UNSUPPORTED`、`FISH_BUSY`。

## 七、数据设计（不新增表）

2.0/3.0 一律走 `app_meta`（键前缀 `fish:v1:`，两版本 worker 均为通用 KV，无需改白名单）；1.0 走 `userData/fish/state.json` 单文件（原子写、启动时 schema 校验、坏文件备份后重建）。

| 键 | 内容 | 清理策略 |
| --- | --- | --- |
| `state` | 鱼档案：level/exp/fish/totalFish/weightTier/mood/streak/bornAt/updatedAt | 不清理 |
| `day:YYYY-MM-DD` | 鱼干收支、请求数、tokens、rewardsByType、互动次数 | 留 90 天 |
| `settings` | §4.6 设置 | 不清理 |
| `dedup` | refId → at 的去重索引 | 留 7 天，滚动裁剪 |
| `packs` | 已导入包元数据（不含图片本体） | 随包删除 |

写入合并：事件高频时在 Manager 内做短延迟合并落盘（≤2s），避免每个事件一次 KV 写。

## 八、素材包格式与安全

内置包原创素材位于 `resources/fish/builtin/`，清单为 `fish-pack.json`：

```json
{
  "schema": "fish-pack/1",
  "id": "builtin-original",
  "name": "Umi 原创胖鱼",
  "builtin": true,
  "credits": [{ "author": "Umi Claw", "url": "" }],
  "license": { "id": "MIT", "commercial": true },
  "entries": [
    { "id": "happy-01", "file": "happy.svg", "state": "success",
      "emotion": "开心", "tags": ["完成"], "width": 200, "height": 200, "animated": false }
  ]
}
```

用户包规则：

1. 导入目录必须含合法 `fish-pack.json`：`schema/id/name/credits/license/entries` 齐全，`credits` 至少一条作者与来源 URL，`license.id` 必填。
2. 只接受白名单扩展名（svg/png/webp/gif/apng）；`file` 必须解析在包目录内（拒绝 `..`、绝对路径、盘符、UNC、符号链接）。
3. 拷贝到 `userData/fish/packs/<id>/` 后只读加载；渲染端用 `file://` 本地加载，不产生外联。
4. NC/unknown 许可在 UI 常驻“非商业/授权未知，仅限本地自用，禁止再分发”标识。
5. 单包大小与条目数设上限（P0：包 ≤50MB、≤500 条），解析失败整包不入账。

## 九、Commit 计划（在 3.0 开发，按序移植）

| Commit | 内容 | 分支 | 估时 |
| --- | --- | --- | --- |
| F00 | 本规划 + 补 LICENSE/package.json license | 3.0 | 0.5d |
| F01 | core：types/economy/stateMachine + 两种 store + `fish.core.accept.mjs` | 3.0（纯新增） | 2d |
| F02 | packs 素材包逻辑 + `fish.packs.accept.mjs` | 3.0（纯新增） | 1d |
| F03 | ipc.ts + preload `api.fish` + d.ts（接线 3 文件，App.vue 暂不挂） | 3.0 | 1d |
| F04 | WorkEventSource 接线（todo/record/report/knowledge/reminder/usage 挂钩点） | 3.0 | 1.5d |
| F05 | FishWidget 全组件 + 原创 SVG + App.vue 挂一行 + `fish.ui.accept.mjs` | 3.0 | 3d |
| F06 | 3.0 打包冒烟 + 文案/设置/重置收口 | 3.0 | 1d |
| F07 | **移植 2.0**：cherry-pick F01/F02/F03 核心段 + MarketingEventSource + 跳转表 + App.vue 接线 | 2.0 | 2d |
| F08 | **移植 1.0（全功能对齐，不裁剪）**：cherry-pick 核心段 + OpenClawEventSource（鱼干事件 + 网关 usage 采集，先做接口 SPIKE）+ jsonStore + 跳转表 + 接线 | 1.0 | 3d |
| F09 | 三分支验收回归 + README/使用文档更新（含素材署名页） | 三分支 | 1.5d |

P0 合计约 **16.5 人天**（F00–F09，含双分支移植与回归；F08 因 1.0 全功能对齐上调）；叠加首发语音 F10–F13 约 **9 人天**，首发总盘约 **25.5 人天**。移植规则：核心/UI/资源/test 提交 cherry-pick 必须无冲突；若出现冲突，说明违反 §3.3，应回改核心而不是在分支上分叉。

## 十、测试与验收

- `fish.core.accept.mjs`（三分支同一份、Node --test）：奖励规则与封顶、幂等去重、日切/streak、心情边界、JSON store 原子写与坏文件重建、meta store 键前缀、状态机跃迁、气泡频控与免打扰、预算阈值只报一次。
- `fish.packs.accept.mjs`：清单校验、路径穿越拒绝、扩展名白名单、NC 标识、超限拒绝、坏包回滚。
- `fish.ui.accept.mjs`：挂件渲染、六态切换、气泡按钮、投喂日限、设置持久化、store 故障降级为静态鱼。
- 各分支既有 accept 全量回归不新增红；双 `typecheck`（node/web）通过。
- 接线审查：每分支 diff 仅允许 §3.3 第 5 条的 4 个文件出现“鱼之外”的改动。
- 打包态冒烟：Windows 安装包中 `resources/fish` 就位，1.0 纯 JSON 存储可读写，2.0/3.0 `app_meta` 落键可查。

## 十一、风险登记

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| NC 素材被带入安装包造成侵权 | 高 | 默认原创 + 运行时导入 + 署名/许可强制展示；构建期脚本扫描 resources/fish 仅允许白名单许可 |
| 鱼模块拖垮启动/与主流程耦合 | 中 | 核心零依赖、接线包 try/catch、失败静态降级、独立验收 |
| 刷鱼干（重复勾选/批量操作） | 中 | refId 幂等 + 当日封顶 + 批量去重 |
| usage 拿不到（部分模型不返回） | 低 | 缺 usage 不记账不估算，UI 标注“该模型不计米粒” |
| 三分支 cherry-pick 漂移 | 中 | 差异全部进 platform 适配层；移植冲突即回改核心 |
| “大肥鱼”名称的商标/联想风险 | 中 | **已拍板使用该名称**：视觉保持原创、不复制社区美术；不主张商标、宣传不冒充 DeepSeek 官方；素材署名与用户导入机制不变，保留后续改名可能 |
| 1.0 本地网关拿不到 usage/对话接口 | 中 | F08 先做接口 SPIKE：usage 缺则不记假账并在 UI 标注；对话缺则降级拉起网关 Web UI 并单独拍板，不阻塞 P0 挂件/养成 |

## 十二、决策记录（v1.0 已拍板冻结）

1. **对外名称**：产品内直接叫「大肥鱼」；视觉形象保持原创，第三方素材只走用户导入（§2/§8）。
2. **1.0 不裁剪**：鱼干、米粒、P1 鱼式聊天全部对齐；鱼干取 OpenClaw 管理动作，米粒取本地网关 usage，聊天走本地网关（§3.2/§4.3/§4.4）。
3. **补授权文件**：F00 先补根目录 `LICENSE` 与 `package.json.license`（MIT，与 README 一致），复制 Apache/MIT 代码时补 `THIRD_PARTY_NOTICES.md`。
4. **内置素材**：首发用工程侧原创 SVG 六态（0 成本、可缩放、版权干净）；约稿正式立绘/Live2D 列 P1 皮肤，不阻塞首发。
5. **鱼式聊天**：进 P1，三版本同享；用户主动触发，1.0 经本地 OpenClaw 网关。
6. **数值口径**：奖励默认值按 §4.4 执行；米粒默认空预算＝仅统计不预警，用户显式设置预算后才报警。

---

## 十三、鱼语音（TTS / 音色克隆；唱歌后置）

### 13.1 能力边界

| 能力 | 输入 | 输出 | 本质 | 阶段建议 |
| --- | --- | --- | --- | --- |
| 普通 TTS | 文本 + 官方音色 + 语速/情绪 | 朗读语音 | 文字转语音 | 首发（F11） |
| 音色克隆 | 本人/已授权音频样本 + 文本 | 用复刻音色说话 | 声纹注册/零样本复刻 + TTS | 首发（F12，强授权闸门；开放范围待 §13.10-8） |
| 唱歌：重新唱 | 歌词 + 旋律/曲谱 + 音色 | 歌曲片段 | 歌声合成 SVS | **第一版不做，后置预研** |
| 唱歌：人声替换 | 一首已有歌曲 + 克隆音色 | 保留旋律/节奏/咬字，只换音色 | 伴奏分离 + 歌声转换 SVC + 混音 | **不做（已拍板）**；与声音克隆无关，未来重启见 §13.9 |

关键判断：

- **第一版只承诺“会说话”**：官方音色 TTS + 已授权克隆音色朗读。
- **TTS 会“有感情朗读”不等于会唱歌**；唱歌需要音高、时长、音符、呼吸和旋律对齐。
- **声音克隆首发只用于说话/朗读**（F12）；克隆音色不送入任何歌声链路。重新唱需要 SVS，已有歌曲换音色需要 SVC，二者第一版均不做（见 §13.9），其中 **SVC 人声替换已明确拍板不做**。

### 13.2 产品场景

- 朗读鱼气泡：默认点播，不自动外放；可在设置中开启“重要提醒自动朗读”。
- 日报/周报完成：鱼口头祝贺并提示报告已生成，不朗读完整报告。
- 待办/候选提醒：只朗读短提示，不读业务正文和敏感上下文。
- 复刻音色：用户可创建“我的音色”或“授权角色音色”，试听后设为鱼的声音。
- **预算独立（v1.0 决策）**：语音按字符/时长单独设预算，不并入米粒；统一费用视图列 P1。

跨版本口径：语音不依赖工作/营销数据库，**1.0/2.0/3.0 都可使用 TTS 与音色克隆**；1.0 仍没有鱼式聊天和业务米粒，但不影响独立语音配置。唱歌三版本第一版均不开放。

### 13.3 供应商与本地路线

云端优先，本地引擎后置；第一版不内置大模型和音色权重。

| 路线 | 候选 | 优点 | 边界 |
| --- | --- | --- | --- |
| 云端 TTS/克隆 | 火山引擎/豆包语音、MiniMax Speech、Fish Audio、ElevenLabs 等 | 接入快、中文质量高、短样本复刻成熟 | 数据外发、按字符/秒计费、克隆条款需逐一确认 |
| 本地 TTS/克隆 | CosyVoice、GPT-SoVITS 等（用户自备服务） | 音频可不出本机、可离线 | 模型体积大、GPU/CPU 性能和权重许可复杂，不随安装包打包 |

TTS/克隆供应商按中文自然度、克隆样本门槛、首字延迟、流式播放、价格、商用/数据保留条款、Windows/Electron 接入成本评估。接口适配层先行，不在核心里写死单一供应商。

### 13.3.1 v0.3 首发决策：火山引擎/豆包语音

首发云端供应商确定为**火山引擎豆包语音**：

- F11 接豆包语音合成大模型：优先 HTTP/SSE 单向流式，覆盖鱼气泡点播、短提醒朗读和简单流式播放；后续有实时对话需求再评估双向流式 WebSocket。
- F12 接豆包声音复刻：以官方 SpeakerID/音色注册链路为准，封装注册、状态查询、试听、删除/续费等操作；样本要求、审核时长、费用和删除语义以正式接入文档为准。
- 官方语音合成文档已确认的工程参数：大模型音色约 325 个；单向流式首包约 600ms，双向流式首包约 300ms；单向/非流式支持 `pcm / ogg_opus / mp3` 与 24k/16k/8k 采样率。播放器侧 P0 优先接收 mp3/ogg，PCM 播放放入兼容层。
- 火山 API Key 使用独立“语音服务密钥”配置，不复用方舟文本模型 Key；仍走 `safeStorage` 加密。若后续官方确认同一账号/密钥体系可复用，也只在适配层合并，UI 仍分项展示。
- 豆包语音当前确认的是 TTS 与声音复刻；**唱歌（重新唱/人声替换）第一版不接入、不承诺**，后续单独预研，不能用普通 TTS 冒充唱歌。
- 保留 Provider 抽象：火山为首发默认项，但不把签名、接口路径、音色 ID 写进 fish core；MiniMax/Fish Audio/本地 HTTP 后续作为备选 adapter。

### 13.4 架构边界

新增纯新增目录，仍遵守 §3.3 的跨分支 cherry-pick 规则：

```text
electron/main/fish/voice/
├── types.ts                 # VoiceProvider / VoiceProfile / SpeakJob
├── voiceManager.ts          # 任务排队、取消、缓存、成本提示、事件推送
├── providers/
│   ├── contract.ts          # TtsProvider / VoiceCloneProvider 能力接口
│   ├── cloudHttp.ts         # 通用 HTTP/SSE 适配基类（fetch，无重型 SDK）
│   ├── localHttp.ts         # 用户自托管 CosyVoice/GPT-SoVITS HTTP 服务
│   └── <provider>.ts        # F11/F12 按预研结果逐个落地
├── audioCache.ts            # 音频文件哈希缓存与 LRU 清理
└── consent.ts               # 音色授权记录、样本校验、删除编排

src/fish/
├── FishVoicePanel.vue       # 供应商配置、试听、语速/音量、自动朗读开关
└── FishVoiceClone.vue       # 样本导入、授权确认、复刻状态、试听、删除

<dataDir>/fish/
├── voices/                  # 用户导入样本和供应商元数据（可整体删除）
├── audio/                   # TTS 缓存，不进数据库
└── jobs/                    # 长任务临时状态，重启后可丢弃或重新查询
```

密钥规则：

- 非密配置（供应商、模型、voiceId、语速）写入既有 fish store 的 `voice:v1:*` 键；2.0/3.0 落 `app_meta`，1.0 落 JSON。
- API Key 不写入 `app_meta`、不写日志、不进截图/错误详情；通过 Electron `safeStorage` 加密后保存。`safeStorage` 不可用时不持久化密钥，只允许本次会话临时使用或改用本地服务。
- 核心仍不直接 import Electron；加解密由平台适配层以 `SecretStore` 注入。
- 音频按 `sha256(provider + voiceId + text + emotion + speed + version)` 去重，缓存默认上限 500MB，LRU 清理；用户可一键清空。

### 13.5 IPC 增补

| 频道 | 入参 | 返回/说明 |
| --- | --- | --- |
| `fish:voice:providers` | — | 供应商及能力（tts/clone/local） |
| `fish:voice:settings:get` | — | 非密语音设置；密钥只回 `hasKey:true` |
| `fish:voice:settings:set` | patch | 保存设置；密钥单独写入加密存储 |
| `fish:voice:test` | provider/profile/text | 短试听，强制 30 字以内 |
| `fish:voice:speak` | text/options | 生成或命中缓存，返回 audioId、字符数、预计费用 |
| `fish:voice:cancel` | jobId | 取消生成/播放 |
| `fish:voice:audio` | audioId | 安全读取本地音频（只读 fish/audio） |
| `fish:voice:clone:validate` | sample paths | 格式、时长、采样率、大小、噪声预检 |
| `fish:voice:clone:create` | samples + consent + displayName | 创建 voiceId，任务态推送 |
| `fish:voice:clone:list/delete` | id | 列出/删除本地记录并尽力删除供应商侧复刻音色 |

### 13.6 音色克隆合规闸门

1. 创建复刻音色前必须勾选：**“我确认这是我本人的声音，或我已获得权利人明确授权，可用于语音合成与商业用途（如适用）。”**
2. 本地保存授权时间、样本文件 hash、来源（录音/导入）、用户填写的权利说明；不把授权口号当成真实法律保证，但保留可审计记录。
3. 不提供名人、公众人物、第三方角色的内置克隆模板；名称命中明显公众人物时先阻断并提示人工改名确认。
4. 样本仅用于用户发起的复刻请求；支持删除本地样本、缓存和供应商侧 voiceId。供应商保留策略必须在 UI 明示。
5. 生成音频遵循供应商水印/溯源能力；若供应商不支持水印，在设置里标注“无供应商水印”。
6. 不做批量声纹采集、隐藏录音、通话音频提取或从视频目录自动扫样本。

### 13.7 分期与新增 Commit

| Commit | 内容 | 估时 |
| --- | --- | --- |
| F10 | VoiceProvider 抽象、IPC、safeStorage、音频缓存、零密钥系统朗读兜底、语音设置面板 | 2d |
| F11 | 接入火山/豆包语音合成大模型（官方音色 + HTTP/SSE + mp3/ogg 播放）+ 点播/短气泡自动朗读 + 三分支适配 | 2.5d |
| F12 | 接入火山声音复刻：样本校验、授权闸门、SpeakerID 创建/状态/试听/删除、失败与额度处理；**首发内部 Dogfood**（`voiceCloneEarlyAccess` 开关默认关，F13 后观察 1–2 周再全量） | 3d |
| F13 | 1.0/2.0/3.0 语音回归：火山密钥、缓存、离线、打包冒烟 | 1.5d |

第一版语音增量约 **9 人天**（F10–F13，TTS + 音色克隆说话）。不包含唱歌、完整歌曲编辑器、本地模型安装器和云端 SVC 商务接入。

### 13.8 语音验收要点

- 未配置密钥时鱼模块仍可正常使用，语音面板给出明确配置路径，不阻断启动。
- 短文本首字延迟、失败重试、取消、字符上限、费用确认、长文分段策略有可重复验收。
- 密钥不落 `app_meta`/JSON/日志；错误对象经过脱敏。
- 克隆未授权不能提交；坏样本、过多样本、多人声/低音量样本有明确错误；删除链路覆盖本地和供应商侧。
- Provider capability 不暴露 singing/swap；任何唱歌入口第一版都不得出现在 UI 或 IPC 中。
- 三个分支都验证：便携数据目录、普通安装目录、打包后 `fish/audio` 路径可写。

### 13.9 第一版不做与未来重启条件

以下能力第一版明确不做，UI、IPC、依赖和打包资源均不预埋半成品（声音克隆 F12 仅产出“说话”音频，不与下列任何链路共用样本或管线）：

- **SVS 重新唱**：歌词 + 旋律从头合成歌声。未来重启需先确认可商用供应商或本地 DiffSinger/OpenUTAU 链路，并解决 MIDI/旋律输入。
- **SVC 人声替换（已拍板不做）**：已有歌曲分离人声后换成克隆音色。即使未来重启，也需先通过 15–30 秒清唱/干声 SPIKE，验证 Demucs/UVR + RVC/So-VITS-SVC/Seed-VC 或云端 SVC 的质量、性能、授权和版权流程；重启需重新走拍板，不在首发排期内预留。

### 13.10 语音决策记录（v1.0 已拍板冻结）

7. 首发供应商：**火山引擎/豆包语音**；本地 HTTP（CosyVoice/GPT-SoVITS 类）仅作隐私/离线兜底。
8. 声音复刻：**首发内部 Dogfood**，早期入口由 `voiceCloneEarlyAccess` 控制；观察样本成功率、审核时长与额度表现后全量。
9. 外发口径：接受云端语音外发（配置页明示数据外发与供应商保留策略）；默认只允许点播，自动朗读默认关闭。
10. 费用预算：**语音独立字符/时长预算**，不并入米粒；P1 再做统一费用视图。

---

PLAN-FISH v1.0 已冻结。F00 先补 LICENSE 与授权文件，F01 起遵循“契约/验收先行，实现随后”；任何范围变更走新版本号追加，不就地改冻结契约。
