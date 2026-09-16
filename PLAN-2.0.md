# Umi Claw 2.0 施工基线（持续记录）

> 本文档是 2.0 的唯一规划基线，随开发进度持续更新。
> 基线版本：v1.19 ｜ 更新日期：2026-09-16 ｜ 状态：**Commit 00/01/02/03/04/05a 均已通过验收，可开工 06（05b 待 07 后）**

## 修订记录

| 版本 | 日期 | 要点 |
|------|------|------|
| v1.19 | 2026-09-16 | **Commit 05a 完成**（Knowledge 知识库）：`knowledgeManager` + `parsers/`（docx/xlsx/pdf/url）+ `KnowledgeBase.vue` + `marketing:knowledge:*` 8 通道 + pdfjs 运行时资产入包；验收 **21/21**，回归 31/31 · 18/18 · 16/16，**打包态端到端**通过（安装包内导入真中文 PDF → `ready`、正文 7030 字、中文关键词命中）。**依赖三坑已写死**：① `mammoth` 需要 `@xmldom/xmldom@0.8.x`（仓库顶层是 `docx` 要的 0.9.10，0.9 强制 mimeType → 必须嵌套副本）；② `pdfjs-dist` 必须 **v3**（v4+ ESM-only，主进程 CJS 打不进去）；③ pdfjs 必须带 `cMapUrl`/`cMapPacked`/`standardFontDataUrl`，否则中文抽出 0 字 |
| v1.18 | 2026-09-16 | **Commit 04 完成**（Business 1:1 + 资料完整度 + Watchlist）：`marketing/businessManager.ts`（BusinessManager + WatchlistManager）+ `marketing:business:*` / `marketing:watchlist:*` + `BusinessBrain.vue`（完整度卡 + 基本盘表单 + 关注词区）+ 摄影行业预设；验收 **16/16**，**打包态端到端**通过（存资料 → Watchlist 满 10 后第 11 个被拒 → 重启资料与关注词全在 → 删 Project 级联清空，并用直读库核对 `businesses=0 / project_watchlist=0 / current=null / integrity=ok`）；回归 `accept:db` 31/31、`accept:project` 18/18 不受影响。**口径拍板**：完整度 = `name/brand/city/positioning/target_customer/tone` 六项等权（**排除 address/phone**，联系方式不属于「AI 认识你」的语义信息） |
| v1.17 | 2026-09-16 | **Commit 03 完成**（Project CRUD + conversation_key 生成 + 切换持久化 app_meta）：`marketing/projectManager.ts` + `marketing:project:*` / `marketing:context:*` 七条通道 + Pinia store + 侧边栏切换器；验收 **18/18** 且**打包态端到端**通过（新建 → 设为当前 → 优雅退出 → **重启后仍是当前商家** → 改名时 key/created_at 不变 → 删除后目录/行/current 三者全清）。**新发现回填**：`isAppError()` 的 `instanceof` 在**模块实例不唯一**时假阴性（测试各模块各自 bundle；生产里 rollup 可能把 `errors.ts` 拆进不同 chunk），会把 SETUP_REQUIRED / NOT_FOUND 静默降级成 DB_ERROR，而渲染端按 code 分支 —— 已把 `errorCodeOf()` 上提到 `errors.ts` 供所有 Manager 复用，并修掉 `toErrorEnvelope()` 同类假阴性 |
| v1.16 | 2026-09-16 | **外部复审 3 项逐条核实**：①**P2 真缺陷已修** —— Worker 初始化失败（ping 超时 / 迁移抛错）时只置标志位、**未回收刚 spawn 的子进程**，会留下游离 Worker，且下次 `ensureReady()` 再拉一个 → 双 Worker 同库，违反硬规则 8；修法 `reapFailedChild()`（kill + 反注册 + 清 child），并补回归用例 **C13**（负向验证：还原旧代码时 C13 必红）；②**P1 测试脆弱已修** —— `countWorkerProcesses()` 在拿不到 WMI 权限的环境返回 0，导致 C4/C5 **假阴性**；改为查询不可靠时返回 `null`（不可知）并降级 `process.kill(pid, 0)` 判活；③**P3 不成立** —— `electron/preload/index.d.ts` 无需补 `api.marketing`（`Api = typeof api` 从实现推导），探针文件实测 `typecheck:web` 0 错；④`setupGuard.ts` 注释笔误（`channelsInstalled` 指个人微信插件，非企微）。验收脚本现为 **31/31** |
| v1.15 | 2026-09-15 | **Commit 01/02 完成并过验收**（01 守卫 12/12、02 验收 30/30、`build:win` 出包 + 打包态端到端冒烟），4 项回填：①**发现根 `npm run typecheck` 是空转**（tsconfig 为 `files:[] + references`）→ 新增 `typecheck:node`/`typecheck:web` 逐项目检查后才暴露 6 个被掩盖的真错（已修），后续提交一律走逐项目检查；②IPC 返回信封定为 `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`（§五 信封的超集）；③02 实际落点补记：新增 `database/errors.ts`（§五 错误码表）+ `ipc/` 目录 + `marketing.system` 最小面（dbStatus/ping/metaGet/metaSet，业务 CRUD 仍归 03/04）+ `test/` 验收脚本入仓；④01 守卫抽成独立模块 `src/renderer/setupGuard.ts`（便于自动化验收）。另：打包态实测事实已补入 §六 |
| v1.14 | 2026-09-15 | **Commit 00 SPIKE 通过（VALIDATED）**，5 项实测结论回填：①⑥=**A 可回放** → **`project_messages` 表作废**、不需回灌，Commit 02 业务表回到 10 张；②`usage` 恒为 0 → Commit 06 上下文预算改用**本地估算**（不能依赖 Gateway token 统计）；③`model` 取值是 `openclaw` / `openclaw/<agentId>`（非 provider 模型 id）+ **端点开关 hot reload 已验**，均写入 Commit 07；④首次非流式 **80.3s 冷启动**、SSE 首字 1.27s → 必须流式 + 07 加预热；⑤新增两条待办：客户端 abort 后服务端是否停止生成、应用 `meta.lastTouchedAt` 被 schema 拒绝（07 顺带修）。另：只读探测确认 Gateway 仅绑 `127.0.0.1` |
| v1.13 | 2026-09-15 | 第五份评审 5 项全部核实属实并修复：①**依赖倒置**——Watchlist 的 AI 扩词依赖 Gateway（07），原写在 04（依赖 02/03）不成立，改为 04 只做手工增删 + 行业预设词 + 上限 10 词（3d→2.5d），AI 扩词移到 08（1.5d→2d），总盘不变；②**发布标记落字段**——`contents` 增 `published_at` + `effect_note`（不新增布尔列，复用 `status='published'`，避免两个真相来源）；③**Context Pack 补 `watchlist[]`**，06 行同步；④`origin` 标注 `watch` 为 2.1 预留（一期不产生）；⑤**完整度卡片范围**——04 只统计 Business 维度，Knowledge 维度随 05 接入 |
| v1.12 | 2026-09-15 | 四轮讨论并入：①新增「产品智能原则」（§一 子节）：5 个动作 + 3 杠杆 + 4 不做；②数据源定稿三条供给线（榜单聚合 API / 自建节点日历 / Watchlist 不采集）+ `hot_topics` 增 `origin` 列 + 小红书降级口径写死 + collector 目录结构；③Watchlist 轻量版进一期（`project_watchlist` 表 + AI 扩词推荐 + 上限 10 词，不采集）；④新增「2.1 阶段预留」（行业趋势 + 同行观察，含路径与红线）；⑤Commit 04/09/11/12 内容扩充、估时上调，总盘 23 → 约 27 人天，提交数不变（14） |
| v1.11 | 2026-09-15 | 两处一行级冲突修复：①UI 验收口径统一——12 的展示 = 评分三档（🔥值得跟/👀观察/❌不建议）+ ⏳待分析态（未评分热点不进三档）；②落榜清理加引用排除——被 contents.source_topic_id 引用的热点不删（NOT IN 子查询），防止 SET NULL 在 7 天后冲掉三期 Analytics 溯源；被保留行数 ≤ 内容数，成本可忽略 |
| v1.10 | 2026-09-15 | 第五轮评审 9 项（赶在 user_version=1 建表前）：①Context Pack 检索策略写死——预算内 knowledge 全量打包，超预算才 LIKE 裁剪（约占模型上下文 60%，06 定阈值）；②contents 增 source_topic_id（FK→hot_topics，ON DELETE SET NULL）+ 索引；③knowledge_items 增 UNIQUE(project_id, source_path)，重导入按此 upsert；④结论 B 时 project_messages 必须回灌最近 10 轮（20 条）随请求发送，sticky user 的 Memory ≠ 对话转录；⑤新增硬规则 13：GATEWAY_TOKEN 只留主进程，渲染端永不直连 3213；⑥Worker 崩溃写请求不自动重试（仅 Manager 预生成主键的 upsert 可重试）；⑦删 project 删行失败语义纠正（保留行+报错+幂等重试，不存在「凭目录重建」）；⑧09 Content Center 同样要 AbortController 停止生成；⑨12 续评规则（超 30 按 heat 取前 30、分批续评）+「⏳待分析」分组；11 验收补安装包内 collector 冒烟（复用 obsidianManager.getScriptPath 的 dev/安装包路径解析）；另明确一期每日动线=Advisor+热点雷达+Content Center，今日任务/日历留二期 |
| v1.9 | 2026-09-15 | 第四轮评审 16 项并入，基线封版：①Commit 表加「依赖」列（02 不依赖 01，可并行）；②新增硬规则 12：collector 只做 adapter+stdout JSON，不碰库/不做业务判断/永不改成 Agent 任务；③评分 24h TTL（仅手动重算或落榜重现才重评）；④数据源健康状态入 app_meta + 页面顶部状态条；⑤去重范围钉死为同源内标题归一化，跨平台同事件不物理合并（聚合二期）；source 仅追溯不参与身份；⑥热点页 UI 规格：默认近 24h（可切 3/7 天）、默认 Top20、三档分组（🔥值得跟 match≥70 且 fit≥70 / 👀观察 40-69 / ❌不建议）；⑦热点→Content Center 携带结构化 payload（09 落地，11 占位）；⑧热点情报永不自动入知识库；⑨页面定名「🔥 热点雷达」，内部 hot* 标识不变；⑩project_hot_topics 字段封板 |
| v1.8 | 2026-09-15 | 第三方评审 12 项全部并入：①collector 改为只抓取+stdout JSON，落库统一经 DB Worker（消除与硬规则 8 的冲突），marketing/ 补 hotManager.ts；②hot_topics.platform 改名 source_platform（来源平台），project_hot_topics 增发布平台列 platform、主键改 (project_id, topic_id, platform) 每平台一行；③05 只交付 05a（2.5d），05b 移到 07 后独立提交（1.5d，总盘 23d 不变）；④采样保留策略（最近 24 条/热点 + 落榜 7 天清理）；⑤11 并行期「带去 Content Center」占位；⑥12 评分边界（30 条/次、仅近 7 天在榜、部分失败降级）；⑦第八节导航营销(4)→(5)、补第 5 条 marketing 路由与 hotManager；⑧合规红线升为硬规则 11；⑨image 边界限定带文字资料图（客片/商品图归二期 Assets）；⑩定时改为 last_hot_fetch_at 时间差判断防睡眠漂移；⑪00⑦补多模态模型选择规则；⑫提交序列 13→14（00-12 + 05b） |
| v1.7 | 2026-09-15 | ① 平台一期扩为**小红书 + 抖音双平台**（抖音一期只做口播文案/标题/话题，不做视频），Commit 10 估时 1.5d→2d；② **热点中心进一期**：新增 Commit 11 热点采集与浏览（2.5d）+ Commit 12 AI 商家匹配（1.5d）；③ 新增 3 张表 hot_topics / hot_topic_samples / project_hot_topics 并入 user_version=1（业务表 6→9）；④ 后台定义拍板：**仅应用运行时主进程每小时定时采集 + 打开页面立即刷新**，不做关机后任务计划；采集独立于 Gateway（零依赖 collector 脚本），AI 评分才走 Agent；⑤ 评分懒计算（打开页面对当前 project 批量评分 + 落库缓存，禁止 fan-out 全商家）；红线：只用公开聚合源，不做登录/Cookie 抓取；一期合计约 23 人天 |
| v1.6 | 2026-09-15 | 知识库文档格式放开：05 从「仅 text/markdown/url/faq」改为「文字层文档本地确定性解析（docx/xlsx/pdf）+ 扫描件 AI 多模态识别兜底（显式触发、结果人工确认）」；type 枚举放开；05 拆 05a/05b，估时 2d→4d；新增依赖 mammoth/exceljs/pdfjs-dist；00 验收加 ⑦多模态支持验证；明确多模态不进默认解析管线、价格类内容必须确定性抽取 |
| v1.5 | 2026-09-15 | 补 AI Advisor（Commit 08）交付边界定义；Commit 00 验收增加「对话历史回放」验证项⑥，project_messages 表按验证结论决定是否并入 user_version=1 初始 schema（02 开工前定，零迁移成本） |
| v1.4 | 2026-09-15 | 两轮评审并入：① SQLite 定稿方案 B（node:sqlite 子进程），原 00 与 05-SPIKE 合并为「Gateway Client 原型」；② 4 缺口拍板：businesses 1:1+UNIQUE、conversation_key 入 projects 表、Setup 完成后 reload 防 守卫弹回、删 project 先目录后行；③ 新增：DB Worker 单例与协议、统一错误码、projectId 显式传参、Human-in-the-loop、子进程注册表（含 obsidian db.mjs 信号处理，列为硬规则 3 的明确例外）、VACUUM INTO 备份、trigram 保留 LIKE 兜底、异步任务事件命名预留、Commit 表加人天列；Commit 序列 12 → 11 |
| v1.3 | 2026-09-15 | 修正：02 验收去掉 03/04 的 CRUD；方案 B 补两项风险；495 行措辞更正；新增待办 #7 DB 滚动快照 |
| v1.2 | 2026-09-15 | 评审 6 修正：Schema 计数、switch 职责归位、检索策略、Setup Guard 去掉 channelsInstalled、user_version 迁移、Commit 02 验收写死；补充 app_meta、Commit 00 验证、content_versions.prompt；SQLite 选型列为待决策 |
| v1.1 | 2026-09-15 | 首版施工基线：定位、硬规则、目录策略、数据层、IPC、调用链、Commit 计划与 Commit 01 落点 |

---

## 〇、总原则（v1.4 新增）

```text
先保证 OpenClaw 稳定可用，
再让 AI 调用稳定可用，
再让 AI 知道商家是谁，
最后才让 AI 帮商家做营销。

任何新功能如果会破坏现有 OpenClaw 能力、
增加首启复杂度、增加数据迁移风险，
优先延期，而不是为了 2.0 一次做完。
```

## 一、定位（锁死，不再讨论）

```text
Umi Claw = 小白友好的 OpenClaw 桌面管理器 + AI 营销工作台

     OpenClaw 管理          AI 营销工作台
     「让它能用」           「让它有用」
          └───────┬────────┘
              OpenClaw Agent 引擎
```

**Project 定义（v1.4 拍板）**：Project = **一个独立商家 / 品牌 / 门店的 AI 工作空间**，不是一次性活动。

```text
正确：Project = 我的摄影店 / XX女装 / XX餐厅
错误：Project = 国庆活动 / 双十一推广（活动属于 Project 下的内容与策略，二期实现）
```

一个 Project 包含：Business（1:1）、Knowledge、Assets、Contents；二期再加 Strategy / Topics / Calendar / Analytics / Learning。

**一期每日动线（v1.10 明确）**：老板每天打开应用的核心动作 = 在 🔥 热点雷达发现选题 → Content Center 出稿/改稿 → 拿不准时问 AI Advisor。今日任务、日历排期、主动推送（D2/D3）全部留二期，一期首页不为「还没建的功能」留入口。

### 产品智能原则（v1.12 新增）

**判断标准：更智能 = 更少让老板解释自己。** 他填过的，AI 必须记住并用上；他没填的，AI 主动问；他改过的，AI 要学到。

AI 的四个输入（Business / Knowledge / 平台规则 / 任务）+ 两个待补（老板的历史稿件、什么有效）。一期把重心放在**上下文质量**而非模型能力——这是最便宜的智能杠杆。

一期的 5 个具体动作（折进现有 Commit，不新增编号）：

| 动作 | 说明 | 落点 |
| --- | --- | --- |
| 资料完整度卡片 | 「AI 认识你 60%，补上价目表可到 80%」——把锅甩回可行动的事（v1.13：04 只统计 Business 维度，Knowledge 维度随 05 接入） | 04 |
| 生成前主动追问缺口 | 要写价格但知识库没有 → 不硬编，提示补充或换角度 | 08/09 |
| 一次生成 3 个版本 | 3 个角度/3 种语气供选，选中与改稿都是偏好样本 | 09 |
| 雷达「今日建议」 | 把 30 条榜收敛成「今天建议跟 A，因为…，后天发」+ 备选 | 12 |
| 极简发布标记 | 「已发布」+ 可选效果备注（v1.13：复用 `status='published'`，落 `published_at` / `effect_note`）；三期 Learning 唯一的真实标签来源 | 09 |

三个杠杆（按性价比）：① 上下文质量 > 模型能力；② 结构化输出 + 固定 rubric（可校准/可缓存/可解释）；③ 闭环反馈（采纳哪个版本、改了什么、发没发）。

四条不做：① **不硬编**——资料里没有的价格/承诺/卖点一个都不编，宁可显示「资料里没有」；② **不全自动**——不自动发、不自动回（硬规则 10）；③ **不让模型干确定性的活**——价格提取、去重、统计一律本地/规则；④ **不堆页面**——一期 5 页够了，把「今日建议」做透比加功能值钱。

## 二、十三条硬规则（违反任何一条 → 停下来重新评估）

1. `data/openclaw` 不动。
2. `data/runtime` 不动。
3. `/obsidian` 路由与 `electron/main/obsidian/` 不动（Obsidian 挂到 OpenClaw 导航组）。**v1.4 明确例外**：给 `resources/obsidian/db.mjs` 增加进程信号优雅退出处理属于纯增量、不改现有行为，允许并与 marketing DB Worker 共用子进程注册表。
4. 现有 OpenClaw 安装、启动、配置、Skills、Channels、Logs、Terminal 等功能一个不删。
5. Commit 02 必须完成 Windows 安装包中的 DB Worker 冒烟测试，失败不得进入 Commit 03。
6. **Commit 00（Gateway Client 原型）未通过，不得开始 Commit 06 Context Engine 及之后所有 AI 功能。**
7. SQLite 已定稿方案 **B（`node:sqlite` 子进程）**；禁止引入 better-sqlite3 等原生模块工具链。
8. **DB Worker 全局单例常驻**：整个应用只有一个 `db-worker.mjs` 子进程，所有 Manager 经其访问数据库；严禁每次 IPC 调用 spawn 一个 node 进程。
9. **projectId 显式传参**：Manager 层每个业务方法必须显式接收 projectId，禁止从全局 currentProject 隐式推断。
10. **Human-in-the-loop**：不做自动回复、不做自动发布；AI 产出一律经人工审核/人工复制发布；涉及价格与活动变更的内容必须人工确认。
11. **热点采集合规红线（v1.8）**：只使用公开聚合数据源（DailyHotApi 类公开榜单接口）；禁止任何要求用户登录、填写 Cookie、或绕过平台访问控制的抓取；数据仅作内部选题参考。
12. **Collector 边界（v1.9）**：`hot-collector.mjs` 只做数据源适配（每个来源一个 adapter 文件）与标准化 stdout JSON；禁止写 SQLite、禁止去重/生命周期/评分等任何业务判断、禁止依赖 Gateway 或调用 Agent——**热点采集永不改成 Agent 任务**。业务逻辑全部在 hotManager 侧。
13. **Gateway 凭据与调用边界（v1.10）**：`GATEWAY_TOKEN` 与 Gateway HTTP 调用只允许存在于主进程；渲染进程永不持有 token、永不直连 `127.0.0.1:3213`，一律经 IPC → Manager → Gateway Client。

## 三、目录策略

**第一阶段不搬任何现有文件。** `electron/main/*.ts` 保持平铺，新代码新增目录：

```text
electron/main/
├── （现有 7 个 .ts 原样保留；obsidian/ 子目录不动）
├── marketing/          ← 新增
│   ├── projectManager.ts
│   ├── businessManager.ts
│   ├── knowledgeManager.ts
│   ├── contentManager.ts
│   └── hotManager.ts        ← Commit 11：调度 collector、经 DB Worker 落库、去重/生命周期/采样清理
├── database/           ← 新增（Commit 02）
│   ├── database.ts     # DB Worker 客户端（单例、断线重连、请求序列化）
│   ├── schema.ts
│   └── migration.ts
├── subprocessRegistry.ts   ← 新增（便携 Node 子进程注册表 + 统一优雅关闭）
└── ipc/                ← 新增
    ├── marketing.ts
    └── index.ts

resources/
├── database/
│   └── db-worker.mjs   ← 新增：零依赖，node:sqlite，stdio JSON 协议，单例常驻
└── collector/
    └── hot-collector.mjs ← 新增（Commit 11）：零依赖，仅 fetch 公开聚合源并按行 stdout 输出 JSON；**不写库**（落库统一 hotManager → DB Worker，守硬规则 8）；不依赖 Gateway，主进程定时器以短命子进程方式调用
```

data 目录冻结现状，只新增三项：

```text
data/
├── config/  logs/  openclaw/  runtime/   ← 冻结，不动
├── projects/      ← 新增（商家原始文件：knowledge/assets 原文等）
├── backup/        ← 新增（VACUUM INTO 滚动快照，保留最近 5 份）
└── umi-claw.db    ← 新增（SQLite，结构化数据）
```

若未来统一为 `data/runtime/openclaw`，必须独立版本任务（迁移检测 → 备份 → 复制 → 配置更新 → 健康检查 → 失败回滚），不属于 2.0 MVP。
## 四、数据层：SQLite（v1.4 定稿方案 B）

### 选型结论

采用方案 B：**`node:sqlite` 子进程**（Electron 30 内置 Node 20 无 node:sqlite，因此必须走便携 Node）。

决策依据：`resources/obsidian/db.mjs` 已在 1.0 生产验证 node:sqlite DatabaseSync + WAL + busy_timeout，spawn 便携 Node + stdio JSON 是仓库内既成模式；零原生构建、零 electron-rebuild、打包天然可用，规避非管理员 Windows 上 VS Build Tools 风险。代价（全异步 DB 访问）在 Vue → Pinia → IPC → Manager 分层中零成本。

两个专属风险及对策：

1. **DB 子进程会被运行时更新流程强杀**：对策见「子进程注册表」——`_stopRuntimeProcesses()` 前置优雅关闭；Worker 异常退出后 Database 客户端自动重启并重放未完成请求（幂等查询直接重试）。
2. **新机首启无 Node**：DB **惰性初始化**——应用启动不建库、不拉起 Worker；首次 marketing IPC 调用时才 spawn 建库；Node 缺失时返回 `SETUP_REQUIRED` 错误（统一错误码，见第五节），前端引导去 Setup，绝不阻塞应用启动。

### DB Worker 协议（Commit 02 定死）

单例常驻子进程，请求/响应按行（JSONL）收发：

```json
请求：{ "id": "req-001", "method": "project.list", "params": {} }
成功：{ "id": "req-001", "ok": true, "data": [] }
失败：{ "id": "req-001", "ok": false, "error": { "code": "DB_ERROR", "message": "..." } }
```

- `database.ts` 维护请求队列（id → resolve/reject + 超时 30s）、Worker 单例、断线自动重启一次；method 白名单分发，禁止前端传 SQL。
- **崩溃重试语义（v1.10）**：Worker 异常退出后自动重启；**读请求自动重试，写请求默认不自动重试**（防重复写入），直接返回 DB_ERROR 由上层决定；唯一例外是 Manager 预生成主键的 upsert（INSERT OR REPLACE/ON CONFLICT，天然幂等）可安全重试。
- Worker 侧写操作串行执行（DatabaseSync 本身同步），读操作不做额外并发。
- 优雅关闭：父进程发 `{ "method": "shutdown" }` → Worker 执行 `PRAGMA wal_checkpoint(TRUNCATE)` + close → exit(0)；3s 未退出再由 `_stopRuntimeProcesses` 强杀。

### 子进程注册表（subprocessRegistry.ts）

- 所有「便携 Node 拉起的常驻/长任务子进程」（marketing db-worker、obsidian indexer）启动即注册：`{ name, pid, gracefulStop(): Promise<void> }`。
- `downloadManager._stopRuntimeProcesses()` 改为：**先逐个调用注册表 gracefulStop（等待上限 3s）→ 再按 ExecutablePath 精确 taskkill / pkill**。
- 同步给 `resources/obsidian/db.mjs` 补 `process.on('SIGTERM'/'SIGINT')` 与 stdin shutdown 指令（硬规则 3 例外）；mcp-server 由 OpenClaw 自身拉起，不纳入我们的注册表。

### 连接约定

- Worker 启动执行 `PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=5000`。
- 结构迁移用 `PRAGMA user_version`（初始 1），`migration.ts` 顺序升级；不另建版本表。
- 外键列全部建索引；渲染端永不直接碰 DB。
- 结构化数据进库；大文件留文件系统，库存 `source_path`。
- `config/app.json` 保持不动。

### 第一版 Schema（10 张业务表 + 1 张元数据表；user_version = 1）

v1.4 变更：projects 增 `conversation_key`；businesses 对 project_id 加 **UNIQUE**（1:1 定稿）。v1.6 变更：knowledge_items.type 放开（见 05 边界）。

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT,
    description TEXT, status TEXT DEFAULT 'active',
    conversation_key TEXT NOT NULL,          -- 创建时生成的 uuid；OpenClaw 会话隔离 user=conv:<projectId>:<此值>
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE businesses (                    -- 与 project 1:1；多门店/多品牌二期再拆
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
    name TEXT, brand TEXT, city TEXT, address TEXT, phone TEXT,
    positioning TEXT, target_customer TEXT, tone TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,                      -- v1.6：text/markdown/url/faq/docx/xlsx/pdf/image；文字层本地解析，扫描件走 AI 兜底
    source_path TEXT, source_name TEXT, content TEXT,
    status TEXT DEFAULT 'ready',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, source_path)         -- v1.10：手输 text/faq 的 path 为 NULL（NULL 互不冲突）；文件/URL 重导入按此键 upsert，天然防同份文件重复
);
CREATE TABLE knowledge_chunks (   -- 预留 RAG，二期向 resources/obsidian 切块对齐；第一阶段仅 LIKE 检索
    id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL, metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
);
CREATE TABLE contents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT, platform TEXT,               -- platform = 发布平台：xiaohongshu / douyin
    topic TEXT,                              -- 选题/主题文案（人工填写或 AI 生成，与热点溯源分开）
    source_topic_id TEXT,                    -- v1.10：来源于热点雷达时溯源 hot_topics.id；热点清理时 SET NULL，不带走内容
    content TEXT,
    status TEXT DEFAULT 'draft',             -- draft/review/approved/published/archived
    published_at INTEGER,                    -- v1.13：发布标记；复用 status='published'，不另设布尔列（避免两个真相来源）
    effect_note TEXT,                        -- v1.13：老板手填效果备注（不错/一般/没动静），三期 Learning 的结果标签
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(source_topic_id) REFERENCES hot_topics(id) ON DELETE SET NULL
);
CREATE TABLE content_versions (   -- Learning 地基：source=ai 必须带 prompt 快照；source=user 的 prompt 为 NULL
    id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
    version INTEGER NOT NULL, content TEXT NOT NULL, source TEXT,
    prompt TEXT,                             -- source=ai：本次 Context Pack 快照；source=user：NULL
    created_at INTEGER NOT NULL,
    FOREIGN KEY(content_id) REFERENCES contents(id) ON DELETE CASCADE
);
-- v1.8 热点中心三表：热点是全局数据（无 project_id），相关性是 Project × 发布平台数据
CREATE TABLE hot_topics (                     -- 全局热点，抓一次所有 Project 共享
    id TEXT PRIMARY KEY,
    source_platform TEXT NOT NULL,           -- 来源平台（榜单出处：douyin/weibo/bilibili…），与 contents.platform（发布平台）区分
    source TEXT NOT NULL,                    -- 聚合源标识，仅用于追溯/排障，不参与热点身份与去重
    origin TEXT NOT NULL DEFAULT 'board',    -- v1.12：来源类别 board=榜单 / calendar=节点日历 / watch=关注词（一期只产前两者，watch 为 2.1 预留）
    title TEXT NOT NULL,
    url TEXT,
    fingerprint TEXT NOT NULL,               -- 去重指纹 = source_platform + 标题归一化（仅同源内去重）
    heat REAL,                               -- 最新热度（历史在 samples 表）
    rank INTEGER,                            -- 最新榜单名次
    lifecycle TEXT,                          -- new/rising/breaking/peak/long_tail，由采样序列计算
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    UNIQUE(source_platform, fingerprint)     -- v1.9：跨平台同事件不物理合并（各平台各一行，二期再做 cluster 聚合）
);
CREATE TABLE hot_topic_samples (             -- 时间序列：趋势/生命周期判定至少需 2-3 次采样
    id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
    sampled_at INTEGER NOT NULL, heat REAL, rank INTEGER,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
);
CREATE TABLE project_hot_topics (            -- 按 Project × 发布平台的 AI 懒评分缓存（同热点两平台各一行，不重复花钱）
    project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    platform TEXT NOT NULL,                  -- 发布平台：xiaohongshu / douyin
    match_score INTEGER,                     -- 商家相关度 0-100
    platform_fit INTEGER,                    -- 该发布平台的适配度 0-100
    reason TEXT, content_angle TEXT, lifecycle_advice TEXT,
    scored_at INTEGER NOT NULL,              -- v1.9：24h TTL，期内不重评；表结构就此封板，不再加列
    PRIMARY KEY(project_id, topic_id, platform),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
);
CREATE TABLE project_watchlist (  -- v1.12：老板关注的行业词；只喂 AI 评分/生成上下文，不触发任何采集
    project_id TEXT NOT NULL, keyword TEXT NOT NULL,
    type TEXT,                               -- industry / product / audience / region
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, keyword),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE app_meta (           -- 仅存应用级全局状态（白名单），禁止塞业务数据
    key TEXT PRIMARY KEY, value TEXT          -- 允许：current_project_id / last_open_page / db_* / hot_last_fetch_at / hot_source_status / hot_source_error
);
CREATE INDEX idx_businesses_project   ON businesses(project_id);
CREATE INDEX idx_knowledge_project    ON knowledge_items(project_id);
CREATE INDEX idx_chunks_knowledge     ON knowledge_chunks(knowledge_id);
CREATE INDEX idx_contents_project     ON contents(project_id);
CREATE INDEX idx_contents_topic       ON contents(source_topic_id);
CREATE INDEX idx_versions_content     ON content_versions(content_id);
CREATE INDEX idx_samples_topic_time    ON hot_topic_samples(topic_id, sampled_at);
CREATE INDEX idx_hot_topics_seen       ON hot_topics(source_platform, last_seen_at);
CREATE INDEX idx_project_hot_score     ON project_hot_topics(project_id, platform, match_score);
CREATE INDEX idx_watchlist_project     ON project_watchlist(project_id, enabled);
```

### 对话历史存储（Commit 00 已定：结论 A）

Commit 00 实测（2026-09-15，dev 实例 3214）：同一 `user=conv:<projectId>:<conversation_key>` 的第二轮请求**准确复述了第一轮暗号**（`UMI-ZEBRA-42`）；换一个 `user=` 问同样问题则回答「无（本次对话里你没有给过我暗号）」。

**结论 A —— 不建本地消息表。** AI Advisor 的续聊历史完全由 OpenClaw 的 sticky `user` 会话承载，**也不需要「每轮回灌最近 N 轮」**。

- **`project_messages` 表作废**（不并入 user_version=1）；Commit 02 业务表为 **10 张**。
- 若未来出现「切换 Project 后历史错乱」或「需要跨设备同步对话」，再作为独立版本任务评估；当前粘性会话已满足一期需求。
- ⚠️ 待办：客户端 abort 后**服务端是否真正停止生成**未验证（关系到 token 是否白烧），见第九节。
### 检索策略

- 第一阶段：SQLite LIKE 关键词检索。零配置，中文友好，α 数据量足够。
- v2 迁移（user_version=2）：FTS5 + trigram tokenizer（SQLite ≥ 3.34）。**已确认坑：trigram 对 <3 字符的查询无效，中文双字词（如"减肥"）搜不到——迁移后 LIKE 必须保留为兜底分支**，不能 FTS 化后删 LIKE。FTS5 默认 unicode61 会把整段中文当单 token，不可直接用。
- 语义检索（Embedding）后置，复用 `resources/obsidian/` 的 indexer/embeddings 链路，不引入外部向量库。

### 备份（待办 #7 定稿）

- 不 copy 三文件，用 `VACUUM INTO 'data/backup/umi-claw-<ts>.db'`：在线一致性快照，自动含 WAL checkpoint，一句 SQL。
- 触发时机：应用启动时（距上次备份 >24h）与 Schema 迁移前；保留最近 5 份，超出删最旧。

## 五、IPC API 与统一错误规范（v1.4 新增）

```ts
window.api = {
  claw, config, models, skills, channels,   // 现有，不动
  marketing: {
    project:  { list, get, create, update, delete },
    context:  { getCurrentProject, setCurrentProject },   // current_project_id 存 app_meta（白名单内）
    business: { get(projectId), upsert(projectId, data) },// 1:1，无独立 list/create
    knowledge:{ list(projectId), get, create(projectId, data), update, delete(projectId, id), search(projectId, query) },
    content:  { list(projectId), get, create(projectId, data), update, generate(projectId, spec), saveVersion },
    hot:      { list(projectId, {platform, force?}), get(topicId), refresh(), score(projectId, platform) },  // platform=发布平台(xiaohongshu/douyin)；list 返回热点+当前 project/该平台缓存评分；refresh=立即采集；score=懒评分
  }
}
// Manager 层签名全部显式 projectId（硬规则 9）；二期再扩 assets/strategy/calendar/analytics/learning
```

**统一错误码**（Manager 抛出 → IPC 透传 → 渲染端按 code 分支，禁止 `error.message.includes()` 判断）：

| code | 含义 | 前端典型处理 |
|---|---|---|
| VALIDATION_ERROR | 参数不合法 | 表单内联提示 |
| NOT_FOUND | 资源不存在 | 404/返回列表 |
| CONFLICT | 冲突（如 business 已存在） | 冲突提示 |
| DB_ERROR | Worker 查询失败（重试后仍败） | 通用错误 + 日志 |
| SETUP_REQUIRED | 便携 Node 不存在，Worker 无法启动 | 引导去环境初始化 |
| OPENCLAW_NOT_READY | Gateway 探活/拉起失败 | 显示启动引导 |
| OPENCLAW_TIMEOUT | 调用超时 | 重试按钮 |
| OPENCLAW_AUTH_ERROR | Gateway token 鉴权失败 | 配置指引 |
| FILE_NOT_FOUND / FILE_PARSE_ERROR | 原始文件缺失/解析失败 | 知识条目标红 |

IPC 失败统一信封：`{ code, message, details? }`。

**异步任务事件命名（只定形状，v1 不实现任务基础设施）**：未来批量生成/素材分析等走 `taskId` + 事件 `marketing:task:<id>`（payload: progress/completed/error）；v1 单次内容生成仍走 SSE → IPC 透传通道，不预建派发器。
## 六、AI 调用链与 Context Pack

```text
用户 → Content Center → 当前 Project
     → Business + Knowledge + 平台规则
     → Context Pack（组装上下文包）
     → OpenClaw Agent（Gateway HTTP 主路线，由 Commit 00 原型验证）
     → AI 内容 → 人工审核 → 人工复制发布
```

Context Pack：`{ business, knowledge[], watchlist[], customer, platform, task }`（v1.13 增 `watchlist`）一次组装、一次调用。**直接模型 API（如 DeepSeek HTTP）只作 Fallback**，会丢失 Agent/Skill/Tool/Memory 能力。

**Knowledge 检索策略（v1.10 写死，06 实现）**：α 阶段商家资料量小，**预算内全量打包**——先估算 business + 全部 ready knowledge 的 token，占所选模型上下文窗口 ≤60%（其余留给对话历史、生成与平台规则，具体阈值 06 按模型定）时全部注入，不做检索；超预算才退化为 LIKE 关键词裁剪（按 query 命中排序截断并标注截断）。理由：顾问类问题（「客户嫌贵怎么回」）与文档标题（「套系价目表」）常无字面重合，LIKE 检索会漏掉最相关资料；全量注入才能验证「AI 认识这个商家」。

### 已实测事实（2026-09-15，OpenClaw 2026.9.4）

**只读探测（安装版，端口 3213）**

- `GET /health` → 200 `{"ok":true,"status":"live"}`；`GET /v1/models` → **404**：OpenAI 兼容面默认关闭。
- 监听地址：**仅 `127.0.0.1:3213`**，未绑 `0.0.0.0` ✅（Commit 00 验收第 8 条）。
- 开关默认值应写入配置生成处（`configManager.ts` 约 :473 gateway 段）并覆盖老用户迁移（Commit 07）。

**Commit 00 SPIKE 实测（dev 实例，端口 3214；证据 `spikes/000-gateway-client/spike-result.json`）**

- 开启：`gateway.http.endpoints.chatCompletions.enabled = true`；鉴权 `Authorization: Bearer <GATEWAY_TOKEN>`。
- **`reloadKind = hot`：改配置后无需重启即生效**（实测 `/v1/models` 404 → 200）。
- `GET /v1/models` 返回 **`openclaw` / `openclaw/default` / `openclaw/main`** —— **`model` 取值是 `openclaw` 或 `openclaw/<agentId>`，不是 provider 模型 id**。
- 非流式**首次**调用 **80.3s**（agent 冷启动）；SSE **首字 1268ms**、总 13.6s → **产品必须走流式**，Commit 07 需加**预热**。
- 错误是**结构化 JSON**：坏 token → `401 {"type":"unauthorized"}`；坏 model → `400 {"type":"invalid_request_error"}`。
- **`usage` 恒为 0**（`prompt_tokens`/`completion_tokens`/`total_tokens`）→ **不能依赖 Gateway 返回的 token 统计**；Commit 06 的上下文预算改用**本地估算**。
- `user` 会话粘性**可回放历史**（⑥=A）、跨 user **隔离干净**（详见「对话历史存储」）。
- 客户端 `AbortController` 可中止流；服务端是否真正停止生成**未验证**（见第九节）。

**打包态端到端实测（2026-09-15，Commit 02 验收产出）**

- 打包应用加 `--remote-debugging-port` 后可用 **CDP 驱动真实渲染进程**调真 IPC，**不需要 GUI 截图通道**（Node 22+ 自带 `WebSocket` 即可，无需 puppeteer/playwright）。
- 便携模式确认：exe 同级存在 `data/` → 数据目录 = `<exe同级>/data`；便携 Node 路径 = `<dataDir>/runtime/node-<platform>-<arch>/node.exe`（冒烟前需先就位运行时，否则 `SETUP_REQUIRED`）。
- 实测链路：建库 11 表 / uv=1 / WAL / FK=on（sqlite 3.53.4）→ 写样例 → **优雅退出后 WAL 截断（`-wal`/`-shm` 消失）** → 重启读回、`migrated:false`。
- 关闭链路：`closeAction='ask'` 时窗口关闭被主进程拦截 → 渲染层确认框 → `resolveClose('exit')` 才真正退出（CDP 冒烟即走此路径，同时验证 before-quit → 注册表优雅停止）。
- Electron 的 CDP 只暴露 page target，**没有 browser target**（`Browser.close` 不可用）。
### 会话隔离

- `user` 格式 `conv:<projectId>:<conversation_key>` 从第一天写死；**conversation_key 是 project 创建时生成的 uuid、持久化于 projects 表**（不放 app_meta，删 project 即随级联清除）。
- 每次打开复用同一 key：既防多 Project 间 Memory 串味，也保同 Project 的连续记忆。

### Fallback 规则

仅当 Gateway 多次探活且自动拉起均失败后才允许直连模型；UI 明示「当前未经过 OpenClaw，Skill / 知识库 / Memory 不可用」。

### 热点中心架构（Commit 11/12，v1.7 拍板）

```text
采集（不依赖 AI / Gateway）          评分（依赖 Context Engine + Gateway）
主进程定时触发 / 打开页面             打开热点中心 → 当前 project × 当前发布平台
→ hot-collector.mjs（只抓取）         → 未评分热点批量一次 Agent 调用（≤30 条）
→ stdout JSON → hotManager            → JSON 评分落 project_hot_topics（每平台一行）
→ DB Worker → hot_topics + samples    → 页面按分排序 + 推荐理由 + 一键带去 Content Center
```

- **后台定义（已拍板）**：仅应用运行时工作——主进程每分钟 tick，但**是否采集按 `app_meta.hot_last_fetch_at` 时间差判断（≥60 分钟才跑）**，不用 setInterval 直接计时（防机器睡眠唤醒后漂移/连跑）；打开热点页时同样看时间差决定是否立即刷新；另在系统唤醒（`powerResume`）事件后补一次检查。不做应用退出后的任务计划/常驻服务（二期如需，同一 collector 脚本可挂 Windows 任务计划，本期不实现）。
- **数据源三条供给线（v1.12 定稿）**：
  1. **榜单**（`origin=board`）：公开聚合 API（DailyHotApi 类），实测**无需认证直接调用**，覆盖 50-60+ 源（抖音热点 / 微博热搜 / 百度 / 头条 / 知乎 / B站 / 快手等）；collector 的 **base URL 可配置**——默认公开实例，高级用户可自部署（Docker/Vercel，本地 6688 端口）。
  2. **节点日历**（`origin=calendar`）：**自建 JSON**（节日 / 换季 / 大促 / 场景季，带提前量），零抓取、零鉴权、零失效、命中率 100%；走同一 `hot_topics` 与同一评分管线。对摄影店 / 女装店的实用价值高于全网热榜。
  3. **Watchlist**（`origin=watch`）：老板填的关注词，**一期只喂 AI 上下文，不触发任何采集**（表见 schema `project_watchlist`）。
- **小红书降级口径（v1.12 写死）**：小红书**没有公开、稳定、免鉴权的热点出口**（平台策略，非技术难度；第三方聚合源版本间时有时无）。Commit 11 SPIKE 实测两种结果均有预案——**验得通**则纳入，雷达双平台对称；**验不通**则降级为「综合榜 + AI 语义判断 + 节点日历」，并在 UI 明示小红书侧选题来源，**不得假装小红书有专属榜单**。影响可控：内容生产靠平台规则 Skill + 商家资料（不依赖小红书数据），`platform_fit` 本就由 AI 语义判断。
- **collector 结构（v1.12）**：`resources/collector/index.mjs` + `sources/*.mjs`（每来源一个 adapter），沿用硬规则 12。**红线：不做任何要求登录 / Cookie 的抓取。**
- **生命周期**：由 `hot_topic_samples` 时间序列计算（同热点 ≥2 次采样才能判 rising/breaking/peak/long_tail），首次入库标 `new`；跨源/跨标题去重靠 fingerprint + 标题相似度聚类。
- **采样保留与清理（v1.11 修订）**：每热点最多保留最近 24 条 samples；`last_seen_at` 超过 7 天（落榜）的 hot_topics 整行删除（级联清 samples 与评分），清理随每次采集后执行。**例外：被内容引用过的热点不删**——删除条件加 `AND id NOT IN (SELECT source_topic_id FROM contents WHERE source_topic_id IS NOT NULL)`，否则 7 天后级联 SET NULL 会冲掉 contents.source_topic_id，三期 Analytics 的热点溯源地基失效；保留行数 ≤ 累计内容数，成本可忽略。
- **评分懒计算（硬约束）**：严禁热点入库后向所有 project fan-out 调 LLM（O(热点×商家) 成本不可接受）；仅打开页面对当前 project × 发布平台的未评分热点批量评分（一次调用评多条），失败降级为裸榜（OPENCLAW_NOT_READY 不阻塞浏览）。
- **评分缓存 TTL（v1.9）**：`scored_at` 在 24h 内一律不重评（直接用缓存）；只有两种情况重算——用户点「手动重新分析」、或该热点落榜后重新上榜。成本模型就此闭合。
- **去重范围（v1.9 钉死）**：v1 只做**同源内**标题归一化（去特殊符号/统一大小写/剥平台前缀词）+ 阈值合并；**跨平台同一事件不物理合并**（抖音/微博各保留各的行，这样才回答得了「哪个平台最火」）。跨源 cluster 聚合需要额外表，二期再做，v1 接受同事件被各平台分别评分。
- **护栏沿用 Advisor**：推荐理由/选题角度只能基于 Business + Knowledge，资料不支持就明示；热点内容不自动发布，一键仅带入 Content Center 生成草稿，仍走人工审核（硬规则 10）。
- `platform_fit` 按 project_hot_topics.platform（发布平台）分别评分缓存；评分 prompt 中体现该平台适配性，防止抖音/微博源热点在小红书得到虚高适配分。
- **Commit 11 页面降级**：11 是纯工程、可早于 09 交付；热点页「带去 Content Center」按钮在 09 上线前占位禁用，11 不得提前实现内容生成。
- **Commit 12 评分边界（v1.8）**：每次批量调用最多 30 条，仅评近 7 天在榜（last_seen_at）且当前 project × 平台未评分（或超过 24h TTL 且手动触发）的热点；返回 JSON 部分条目解析失败时，成功条目照常落库、失败条目留待下次重试，整次调用失败才降级为裸榜。
- **热点雷达页 UI 规格（v1.11 统一口径，12 的验收标准）**：时间范围默认近 24h（可切 3 天/7 天）；默认只展示 Top 20；**评分三档 + 一个待分析态**——🔥 值得跟（match_score ≥ 70 **且** platform_fit ≥ 70，双门槛防高相关低适配误推）/ 👀 观察（任一分数 40–69）/ ❌ 不建议（均 < 40）/ ⏳ 待分析（尚未评分，不参与三档，续评后自动归位）；底层数字全部保留可查，分组只是展示层。
- **数据源健康状态（v1.9）**：每个数据源的最后成功时间/错误写 `app_meta.hot_source_status / hot_source_error`（不建表）；热点雷达页顶部显示各源「正常 · N 分钟前 / 异常已降级」状态条，单源失败不拖垮整页与其他源。
- **热点 → Content Center（v1.9）**：09 落地跳转，携带结构化 payload `{ topic_id, title, source_platform, platform, content_angle, lifecycle_advice }` 预填充生成表单；11 阶段按钮只占位禁用。**热点情报永不自动写入 Knowledge Base**（External Intelligence ≠ Merchant Knowledge，概念见第十节），只有老板人工采纳后才可能成为商家资料。

### AI Advisor 定义（Commit 08 交付边界）

**定位**：营销工作台内的 grounded 对话入口——老板用自然语言提问（卖点怎么讲、客户嫌贵怎么回、给几个内容角度），AI 基于**当前 Project 的 Business + Knowledge** 回答。它是 06 Context Engine 与 07 Gateway Client 的第一个真实消费者，用来证明「AI 认识这个商家」。

交付物：

- 聊天面板：消息流 + SSE 流式渲染 + 「停止生成」（AbortController；组件卸载或切换商家时必须中止上游请求，避免白烧 token）。
- 每轮请求 = Context Pack（business 摘要 + 命中的 knowledge 片段 + 平台/任务说明）+ 用户消息，经 07 调 Gateway，`user=conv:<projectId>:<conversation_key>`。
- 复用 07 的探活/自动拉起/统一错误码；切换 Project 即换 conversation_key，记忆天然隔离。
- 事实护栏：价格/套餐/承诺只能引用知识库；资料中没有就明示「资料里没有，建议补充」，禁止编造。

明确不做（v1）：

- 不做结构化内容生产（选题→平台规格→成稿→版本→审核归 Commit 09 Content Center）；
- 不做数据复盘型建议（v1 无发布数据，属第三阶段 Analytics）；
- 不做自动回复/自动发送（硬规则 10），Advisor 只服务老板本人；
- 不做主动任务执行。

对话历史存储按本节上方「对话历史存储」预案，由 Commit 00 验收⑥的结论拍板。

## 七、Commit 计划（14 个提交：00-12 + 05b；合计约 27 人天；v1.9 加依赖列、v1.12 上调估时）

| # | 主题 | 内容 | 估时 | 依赖 | 负责人 | 状态 |
|---|------|------|------|------|------|------|
| 00 | SPIKE：Gateway Client 原型 —— **✅ 2026-09-15 通过（VALIDATED / Primary）** | 开 chatCompletions → 完整链路 5 场景 + 多模态/模型选择 + CLI/直连快速对比 → **结论：Primary = Gateway HTTP；直连保留 Fallback；⑥=A 不建 project_messages；`usage` 恒 0（06 改本地估算）；`model`=`openclaw`/`openclaw/<agentId>`；SSE 首字 1.27s / 冷启动 80s（07 加预热）** | 0.5d | — | | ⬜ |
| 01 | UI / 导航骨架 —— **✅ 2026-09-15 完成** | Sidebar 4 组（工作台/营销5/OpenClaw6/系统2，to 值不变）、Dashboard 三卡（状态卡 + 当前商家 + AI 营销）、`/marketing/*` 5 条占位路由（共用 `Placeholder.vue`）、**首启 Setup 守卫**（独立模块 `setupGuard.ts`，判定 `nodeInstalled && openClawInstalled`）+ Setup 完成后 reload、10 条旧路由保留 | 1.5d | —（与 02 并行） | | ✅ |
| 02 | DB Worker + 构建 —— **✅ 2026-09-15 完成** | schema/migration + `db-worker.mjs` 单例（零依赖 JSONL，84 白名单方法）+ `database.ts` 客户端（惰性初始化/队列/30s 超时/断线重启/读重试写不重试）+ 子进程注册表接入（`_stopRuntimeProcesses` 前置优雅停止）；**`build:win` 出包（81.8MB）+ 打包态端到端冒烟通过（验收见下）** | 2d | —（与 01 并行） | | ✅ |
| 03 | Project —— **✅ 2026-09-16 完成** | projectManager + store + CRUD + conversation_key 生成 + 切换持久化 app_meta（落点与验收见下） | 1d | 02 | | ✅ |
| 04 | Business —— **✅ 2026-09-16 完成** | businessManager + BusinessBrain.vue + 摄影行业首套字段 + upsert/级联删除验收 + 资料完整度卡片（Business 维度）+ Watchlist（手工增删 / 行业预设词 / 上限 10 词 / 不采集）；落点与验收见下 | 2.5d | 02、03 | | ✅ |
| 05 | Knowledge（仅 05a） —— **✅ 2026-09-16 完成** | knowledgeManager + KnowledgeBase.vue + 文字层文档解析（docx/xlsx/pdf/url/faq）+ 导入/重导入 + LIKE 检索 + Knowledge 维度完整度；落点与验收见下 | 2.5d | 02、03 | | ✅ |
| 06 | Context Engine | Business + Knowledge + **Watchlist** + Platform → Context Pack | 1d | 00、04、05 | | ⬜ |
| 07 | Gateway Client | 端点开关默认化 + 老用户迁移、探活、自动拉起（**复用 clawManager 启停，不另起炉灶**）、就绪轮询、SSE→IPC 透传、会话隔离、多模态模型选择 | 2d | 00 | | ⬜ |
| 05b | 扫描件 AI 识别兜底 | 复用 07：扫描 PDF/带文字资料图的「用 AI 识别」显式触发 + 识别结果人工确认后入库；00⑦ 结论为不支持则只做提示 | 1.5d | 05a、07（可与 08 并行） | | ⬜ |
| 08 | AI Advisor | Grounded 营销问答面板（边界见第六节）：Context Pack + SSE + 停止生成 + 事实护栏；对话历史按 00⑥ 结论；**+ Watchlist AI 扩词推荐（候选词生成 + 用户勾选，v1.13 由 04 移入）** | 2d | 06、07 | | ⬜ |
| 09 | Content Center | AI 生成（SSE 流式 + **AbortController「停止生成」**，规格同 08：组件卸载/切换必须中止上游）→ 编辑 → 版本（prompt 快照）→ 人工审核；**接收热点雷达结构化 payload 预填充（v1.9），source_topic_id 溯源（v1.10）**；**一次生成 3 个版本供选 + 极简发布标记（v1.12）** | 3d | 06、07、08 | | ⬜ |
| 10 | 双平台工作流 | **小红书 + 抖音**平台适配（两套平台规则模板注入 Context Pack）；抖音一期只做口播脚本/标题/话题标签文案层，不做视频；均人工复制发布 | 2d | 09 | | ⬜ |
| 11 | 热点采集与浏览（🔥 热点雷达） | 数据源 SPIKE（公开聚合源，双平台发布视角）+ collector adapters（只抓取 stdout JSON，硬规则 12）+ hotManager 经 Worker 落库 + 时间差定时/唤醒补检/打开即刷 + 三表 + **同源内**去重 + 生命周期 + 采样保留(24 条)/落榜清理(7 天) + 数据源状态条 + 雷达页（近 24h/Top20/平台筛选；「带去 Content Center」09 前占位）；**安装包内 collector 冒烟：复用 obsidianManager.getScriptPath 的 dev/安装包（process.resourcesPath）路径解析，不改打包配置**；**节点日历自建 adapter（origin=calendar）（v1.12）**；不依赖 Gateway | 3d | 02（可与 03-06 并行） | | ⬜ |
| 12 | AI 商家匹配 | 当前 project × 平台懒评分（≤30 条/次、近 7 天在榜、24h TTL；**待评超 30 条按 heat 取前 30，每次打开雷达续评一批直到评完**）+ JSON 落库 + 部分失败容错 + 整体失败降级裸榜 + 分组（🔥/👀/❌ + **⏳ 待分析**）+ 手动重新分析 + 事实护栏；**雷达顶部「今日建议」摘要（1 条主推 + 理由 + 时机）（v1.12）** | 2d | 06、07、11 | | ⬜ |

顺序备注：00 必须第一；**01 与 02 互不依赖、可并行**；03/04/05 依赖 02；06 必须在 00 结论之后；07 之后插入 05b（可与 08 并行），08/09/10 顺序推进；**11 是纯工程，02 完成后即可与 03-06 并行（跳转按钮占位到 09）；12 必须在 06/07/11 之后**。一期做完再整体测试，后续迭代优化。

### Commit 03 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/projectManager.ts    新增（注入式依赖，不 import electron，纯 Node 可 bundle 测试）
electron/main/ipc/{marketing,index}.ts       新增 marketing:project:* / marketing:context:* 通道
electron/preload/index.ts                    api.marketing.project.{list,get,create,update,delete}
                                             api.marketing.context.{getCurrentProject,setCurrentProject}
electron/main/index.ts                       工厂 + wiring（dataDir / DatabaseClient / logger）
src/stores/marketing.ts                      新增 Pinia store
src/views/components/ProjectSwitcher.vue     新增：侧边栏切换器（切换 / 新建 / 重命名 / 删除 + 危险确认弹窗）
src/composables/useProjectSwitcher.ts        新增：切换器开关单例（工作台卡片可复用同一面板）
src/App.vue / src/views/Dashboard.vue        挂载切换器；「当前商家」卡接真实数据
test/project.accept.mjs + `npm run accept:project`   18 项验收（打真 projectManager.ts）
```

**验收（独立复跑）**：`accept:project` **18/18**；`typecheck:node` / `typecheck:web` 0 错；Commit 02 回归 `accept:db` **31/31** 不受影响。

**打包态端到端（真安装包产物 + CDP 驱动真渲染进程调真 IPC，非替身）**：
新建 `E2E 摄影工作室`（id / conversation_key 均为 uuid，`data/projects/<id>/` 已建）→ 设为当前 →
**优雅退出**（WAL 截断）→ **重启后当前商家仍是它** → 改名（`conversation_key` / `created_at` 不变，current 仍指同一 id）→
删除（`dirRemoved` / `rowDeleted` / `currentCleared` 全 true，列表清空、目录消失）。复现脚本 `test/packaged-smoke.mjs`。

**关键设计决策**

- 删除顺序逐字按 §十：**目录删不掉时行必然还在**（P12 实测：占用期回 `DB_ERROR(project-dir-remove-failed)` + 行与子数据保留 + 释放句柄后重试成功）；顺序反了行就没了。
- `currentBefore` 必须在删行**之前**取，否则拿不到「原本指向谁」这个事实；清空失败不反转已成功的删除，残留悬空指针由读路径自愈兜底。
- `conversation_key` 创建即定、`update` 白名单外一律 VALIDATION_ERROR（静默丢弃会变成「改了但没生效」的幽灵 bug）；删除后同名重建拿**新键**，绝不复活旧键。
- `Project` 契约**不含 conversation_key** —— §六 的 `user=conv:<projectId>:<key>` 拼装在主进程（硬规则 13），渲染端拿不到也不需要。

⏳ **未覆盖**：①「删行失败」分支需在 DELETE 执行中途让 Worker 崩溃（竞态不可靠），仅代码审阅；②store 的三条降级语义（load 部分降级 / create 后 select 失败仍返回 project / remove 同步本地 current）无单测（仓库无 vitest）；③UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）。

### Commit 04 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/businessManager.ts   新增：BusinessManager（get / upsert / delete）+ WatchlistManager（list / add / remove / setEnabled）
electron/main/ipc/marketing.ts               +marketing:business:{get,upsert,delete} · marketing:watchlist:{list,add,remove,setEnabled}
electron/preload/index.ts                    api.marketing.business.* / api.marketing.watchlist.*
electron/main/index.ts                       工厂 + wiring
src/stores/marketing.ts                      +business / completeness / watchlist 三切片
src/constants/photographyPresets.ts          新增：摄影行业预设（定位 6 / 客群 6 / 语气 5 / 关注词 10）
src/views/marketing/BusinessBrain.vue        新增：完整度卡 + 基本盘表单（预设筹码可点选）+ Watchlist 区
src/renderer/main.ts                         /marketing/business 由占位页换真页
test/business.accept.mjs + `npm run accept:business`   16 项验收（打真 businessManager.ts）
```

**验收（独立复跑）**：`accept:business` **16/16**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18** 均不受影响。

**打包态端到端（真安装包 + CDP 驱动真渲染进程调真 IPC）**：
新建商家 → `business.upsert` 存 4 字段 → 读回一致且 `created_at` 稳定 → Watchlist 加满 **10 个** →
第 11 个 **VALIDATION_ERROR(max:10)** → 重复词 **CONFLICT** → 删一个后第 11 个加入成功 →
**优雅退出 → 重启后资料与 10 个词全在** → 删 Project → `business.get` 回 `null`、关注词清空、
`dirRemoved` / `rowDeleted` / `currentCleared` 全 true；**直读库复核** `projects=0 / businesses=0 / project_watchlist=0 / current_project_id=null / integrity_check=ok`。

**关键设计决策**

- **upsert 的 ON CONFLICT 目标**：worker 的 `businesses.upsert` 冲突目标是主键 `id`，**打不到 `project_id UNIQUE`**。故先按 project_id 读既有行 → 用它的 `id` 走 upsert（真正的单语句 `INSERT … ON CONFLICT(id) DO UPDATE`）；首插走 create，并发撞 `UNIQUE(project_id)`（worker 把 UNIQUE 映射为 CONFLICT）→ 回落更新路径重试一次。**「同 project 反复 upsert 只有一行」由 `UNIQUE(project_id)` 兜底**（B4/B5 两路都验证），**没有为此改 worker**。
- **`created_at` 必须显式回传**：`ON CONFLICT DO UPDATE` 会把未提供的列一并写成 excluded 值，漏掉它等于每次保存都把「创建时间」刷成现在。
- **未传字段 = PATCH 保留旧值**；显式 `null` / 空串才清空（PUT 式「未传即清空」会让部分调用者误删数据）。
- **完整度口径**：`name / brand / city / positioning / target_customer / tone` 六项**等权**，**排除 address / phone**（联系方式不属于「AI 认识你」的语义信息）；Knowledge 维度归 05。跨 tsconfig 无法共享常量 → store 与 manager 各留一份，由 B16 做**静态一致性核对**防漂移；`missing` 返回字段名，卡片渲染用 `BUSINESS_FIELD_LABELS`。
- **错误语义分开**：读无行 → `null`；写目标不存在 → `NOT_FOUND`（防「点了没反应还说成功」）；`remove` / `deleteBusiness` **幂等**（`removed:false` / `deleted:false`，重复点删不弹错）；`type` 非法 → VALIDATION_ERROR（不静默归一，避免污染喂给 AI 的分类）。
- **不采集**：Watchlist 只作 AI 上下文，B15 对模块源码做静态扫描（7 类网络特征 0 命中）。

⏳ **未覆盖**：①UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）；②完整度常量跨 tsconfig 双份（有 B16 静态核对兜底，但仍是两份）；③Watchlist 无批量导入/导出（不在基线范围）。

### Commit 05a 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/knowledgeManager.ts        新增：list/get/create/update/delete/search + import（本地解析一次入库）
electron/main/marketing/parsers/documentParsers.ts 新增：docx(mammoth) / xlsx(exceljs) / pdf(pdfjs) / text / markdown / faq
electron/main/marketing/parsers/urlParser.ts       新增：HTML→文本（去 script/style、实体解码、块级转行）
electron/main/marketing/parsers/pdfjsAssets.ts     新增：pdfjs 资产 dev/安装包双路径解析
electron/main/ipc/marketing.ts + preload + index.ts  marketing:knowledge:{list,get,create,update,delete,search,import,pickFile}
src/stores/marketing.ts                            +knowledge 九件套 + knowledgeCompleteness + overallCompleteness
src/views/marketing/KnowledgeBase.vue              新增：四路导入（文件/文本/网址/FAQ）+ 拖拽 + LIKE 检索 + 列表预览 + 删除
src/renderer/main.ts                               /marketing/knowledge 由占位页换真页
resources/pdfjs/                                   4.54 MB：cmaps 1.11MB(169 个 .bcmap) + standard_fonts 0.74MB + build/pdf.worker.js(2.01MB) + build/pdf.js(0.68MB)
test/knowledge.accept.mjs + `accept:knowledge`     21 项验收（打真 knowledgeManager.ts）
test/fixtures/{make-minimal-pdf.mjs,min-text-layer.pdf}  提交级最小 PDF fixture（710 字节）
```

**验收（独立复跑，非自述）**：`accept:knowledge` **21/21**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**；
**K8 用真中文文字层 PDF 跑实** → 一份 8 页国标 PDF 抽出 **3015 个汉字**，关键词「国卫生部」命中。

**打包态端到端（真安装包 + CDP 驱动真渲染进程调真 IPC）**：安装包内导入真中文 PDF →
`status=ready`、正文 **7030 字**、`source_name` 正确、列表 1 条、中文关键词「值域代码」检索命中（snippet 为真实中文）。
→ 满足 05a 验收补充项「**安装包环境（非 dev）pdfjs 可用**」。

**关键设计决策**

- **重导入 upsert 键与路径**：键 = `UNIQUE(project_id, source_path)`；worker 的 upsert 冲突目标是主键 `id`、打不到该唯一键 → 先按键查既有行、用它的 `id` 走 `INSERT … ON CONFLICT(id) DO UPDATE`，并发撞键回落重试一次（与 businessManager 同构）；**`created_at` 必须显式带回**，否则每次重导入都刷掉首次导入时间。`source_path` 存**相对 dataDir 的正斜杠路径**（`projects/<id>/<净化文件名>`），URL 类存原始 URL，text/markdown/faq 存 `NULL`。
- **扫描件检测**：抽样页面文字量≈0 → `FILE_PARSE_ERROR` + `reason=scanned-pdf`，**不落行、不落文件**（K9 断言库里 0 空内容行、0 孤儿文件）；`doc/xls` 老格式 → `VALIDATION_ERROR` + 提示另存为新格式。
- **parser 与 electron 解耦**：manager/parsers 不 import electron，pdfjs 资产路径由 `pdfjsAssets.ts` 注入解析（dev 用 `app.getAppPath()/resources`，打包用 `process.resourcesPath/resources`），因此纯 Node 可测（K20 断言 dev/pack 两条路径 + bundle 内无 pdfjs 静态引入）。
- **url 类口径**：只做 http(s) 单次 GET + 本地 HTML→文本，**不跟 Cookie、不调第三方 API、不做站点特化**（K21 静态扫描 5 类网络特征 0 命中）。

⏳ **未覆盖**：①K8 默认 SKIPPED（需 `KNW_PDF_SAMPLE` 指真中文 PDF，本机已跑实并把结果记在此处）；②UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）；③**仓库 `package-lock.json` 与 `node_modules` 存在既存漂移** —— 本次依赖（mammoth/exceljs/pdfjs-dist）是「隔离安装 + 只补不覆盖」补入的（新增 34 包、0 覆盖），**未执行 `npm install`**（dry-run 显示它会删掉 471 个包，含 electron-builder 的依赖）；锁漂移修复留作独立动作。

### Commit 11 数据源 SPIKE（v1.12 新增）

```text
[ ] 榜单聚合源可用性：抖音热点 / 微博热搜等接口实测可取，字段含 title / heat / rank / url
[ ] 小红书源实测：能否免鉴权拿到？结论二选一（可 → 纳入雷达；不可 → 按降级口径执行并写回本基线）
[ ] 节点日历 adapter：JSON 内置，插桩后能生成 origin=calendar 的 hot_topics 行
[ ] 行业命中率：每天 50 条榜中，被摄影 / 女装行业评到 match≥70 的有 ≥3 条；否则补充来源或调整口径
[ ] 空态规则：无高相关热点时显示「今天没有值得跟的」+ 节点日历兜底建议
[ ] base URL 可配置：公开实例不可用时能切自部署地址
```

### Commit 00 验收（✅ 2026-09-15 通过 → Primary）

```text
[x] chatCompletions 开启后 POST /v1/chat/completions 带 Bearer Token 成功，SSE 收到完整文本
[x] ② 就绪判定：/health 返回 200（97ms）可作为就绪判据；超时/重试参数留 07 定
[x] ③ SSE 中途断开 → 客户端正确结束并区分（4 chunks 后 abort 成功）
[x] ④ 坏 model / 坏 token → 结构化错误码（400 invalid_request_error / 401 unauthorized），非超时
[x] ⑤ 两个不同 user= 交叉对话 → OpenClaw Memory 不串（no leak）
[x] ⑥ 同一 user= 新连接 → 【结论 A】可回放历史 → 不建 project_messages、不需回灌
[x] Gateway HTTP 只绑定 127.0.0.1（非 0.0.0.0）
[—] ① Gateway 未启动 → 自动拉起：本次未覆盖（dev 实例已启动）；由 Commit 07 复用 clawManager 实现时验收
[—] ⑦ 多模态：按产品决定未测（模型必支持多模态）；端点 image 通道留 07 验证
[—] CLI / 直连对比：主路线已判定 Primary，未单独测（直连保留 Fallback）
```

### Commit 02 验收（✅ 2026-09-15 通过，2026-09-16 复审补 C13 后 **31/31**；`npm run accept:db` 一键重跑）

```text
[x] 惰性初始化：首次 marketing IPC 才拉 Worker 建库 —— C2 dbExists=false / C3 tables=11 + uv=1 + wal；应用启动不建库、不阻塞
[x] 10 张业务表 + app_meta 齐备、user_version=1、**无 project_messages** —— C3 / W4 schema.info
[x] Worker 单例：连续 20 次 IPC 只存在一个 node 子进程 —— C4（OS 层进程计数=1）
[x] foreign_keys=ON 级联删除 + businesses UNIQUE(project_id) —— W7（级联清空，hot_topics 不受影响）/ W8 CONFLICT
[x] migration 0→1 实测并幂等；WAL 生效；强杀后库不损坏 —— W2/W3/W6/W14（integrity_check=ok）
[x] Worker 被强杀后自动重启：读自动重试成功、写不自动重试 —— C5；例外（预生成主键 upsert）可重试 —— C6
[x] shutdown 优雅退出（checkpoint→close→exit 0）；注册表先于 taskkill —— W16（wal=0B）/ W17 / W18 + C12 全链路
[x] 🔥 安装包冒烟：**打包态端到端**（win-unpacked 真应用 + CDP 驱动真渲染进程调真 IPC）——
    建库 11 表 / uv=1 / WAL / FK=on → 写样例数据 → 优雅退出（-wal/-shm 消失）→ **重启数据仍在**（migrated=false）
    —— 复现脚本 `test/packaged-smoke.mjs`
[x] VACUUM INTO 备份链路可用、保留最近 5 份 —— W13 / C9
[x] data/openclaw、data/runtime 零影响；既有安装实例全程不受影响 —— 仓库 data/ 无改动

[x] 初始化失败回收 Worker：不留游离进程、可安全重试 —— C13（v1.16 复审 P2 修复的回归用例；负向验证：还原旧代码时 C13 判红）

⏳ 未覆盖（北已拍板不单独补，v1.15）：
[—] 真 NSIS 安装 + GUI 点击流：跑的是等价 win-unpacked 产物；03 完成后一次性人工过
[—] _stopRuntimeProcesses 端到端触发（只在 env:updateNode 流程走到）：契约由 C12 + diff 覆盖
```

### Commit 05（Knowledge）边界（v1.6 修订）

**总原则：导入时本地确定性解析一次 → 文本存 `knowledge_items.content`，原文件留 `data/projects/<id>/` 存 `source_path`；运行时不再解析，重新导入覆盖。schema 不加表，只放开 type 枚举。**

**多模态不进默认解析管线**：模型视觉只作显式触发的兜底，不做默认解析器。理由：① docx/xlsx/文字层 PDF 本地抽取确定、免费、忠实；② 模型有上下文上限，长文档照样要分页切块；③ 表格（价目表）可能串行/错读——**涉及价格的内容必须确定性抽取，不得走模型识别**；④ 解析不应依赖 Gateway 在跑或模型支持图。

分两步交付（**Commit 05 只交付 05a；05b 在 Commit 07 之后作为独立提交，编号 05b**）：

- **05a（约 2.5d）文字层文档全收**，新增依赖：`mammoth`（docx→文本）、`exceljs`（xlsx 按 sheet → Markdown 表）、`pdfjs-dist`（PDF 文字层，纯 JS 主进程运行，worker 打包路径进安装包冒烟）：
  - 支持 `text / markdown / url / faq / docx / xlsx / pdf`（doc/xls 老格式 v1 不支持，提示另存为新格式）；
  - url 类只做正文/HTML 到文本的轻量抽取；
  - PDF 抽取后做**扫描件检测**（抽样页面文字量≈0）→ 条目标 `FILE_PARSE_ERROR` 待 05b 处理，不得静默存入空内容。
- **05b（约 1.5d）扫描件/图片 AI 识别兜底**：
  - 仅扫描 PDF 与**带文字的资料图**（价目表截图、海报、产品说明图等）；客片/商品图等营销素材归二期 Assets，不在本功能范围。UI 提供「用 AI 识别」按钮，**用户显式触发**（Human-in-the-loop），识别文本入库前必须人工确认；
  - 大文件分页/切块发送、大小上限、失败重试；可行性以 Commit 00 验收⑦结论为准——不支持图则降级为明确提示，不阻塞 05a；
  - 解析失败统一 `FILE_PARSE_ERROR`，条目标红可重导入。

05a 验收补充：docx 套系单、xlsx 价目表、文字层 PDF 各一份真实样本导入后 LIKE 可检索且数字/表格无串行；安装包环境（非 dev）pdfjs worker 可用。

第二阶段：Assets / Calendar / Strategy+Topics（策略→选题→素材→内容→日历→人工发布）。
第三阶段：Analytics + Learning（数据反馈 → 风格学习 → 生成闭环）。

### 2.1 阶段预留（v1.12 新增）

**定位**：在热点雷达之上补「行业层」与「同行层」（三层结构：全网热点 / 行业热点 / 同行观察）。**不进一期**，编号就叫 2.1（不用 11b，避免提交序列混乱）。

**2.1 要做的事**：
- 行业趋势：把榜单里的行业信号 + 关键词趋势，做成「我的行业在发生什么」；
- 同行市场观察：**关键词层面的市场信号，不是抓同行账号内容**；
- 雷达加「行业」Tab（一期不做空壳 Tab，首页不为未建功能留入口）。

**数据路径与可行性（红线写死）**：

| 路径 | 可行性 | 说明 |
| --- | --- | --- |
| 从综合榜里筛行业信号 | ✅ 现成 | 零新增成本，一期评分管线已在做 |
| 搜索联想词 suggest | 🟡 待 SPIKE | 通常公开，但可能有签名校验；验不通就放弃 |
| 百度指数 / 微信指数 | ❌ 不做 | 需要登录，撞硬规则 11 |
| 爬同行账号内容 | 🚫 红线 | 需登录态 / Cookie，工程量大、数据噪声高，不做 |

**成本控制（2.1 开工即生效）**：观察词**全局去重成一个词池**，一个词只采一次、多商家共享结果（与 `hot_topics` 全局共享同理），严禁 O(商家 × 词) 的 fan-out 采集。

## 八、Commit 01 精确落点（已核对代码，v1.4 修订）

- 路由实际入口 `src/renderer/main.ts`（hash 模式，10 条路由平铺）；**首启 Setup 守卫当前不存在，属新增**。
- 守卫设计：模块级缓存 `env.check()` 只调一次；未完成判定 = `nodeInstalled && openClawInstalled`（**不含 channelsInstalled**，其定义是 `downloadManager.ts:230` 的 `existsSync(weixinPluginPath)`，与可运行性无关）；目标已是 `/setup` 放行；env.check 异常放行；用 `router.replace`。
- **v1.4 新增验收**：「Setup 完成 → 进 dashboard 不被守卫弹回」。方案：Setup 完成回调里直接 `location.reload()`（hash 应用代价最低），不引入缓存重置机制。因此 01 对 Setup.vue 有一处最小改动（完成后的 reload），其余逻辑不动。
- `src/App.vue` navItems 平铺改分组：工作台 / 营销(**5**：商家大脑、知识库、AI Advisor、Content Center、热点中心) / OpenClaw(6，含 Obsidian + 环境初始化) / 系统(日志、关于)；**to 值不变，只动 label 与分组**。
- `src/views/Dashboard.vue` 改三卡：OpenClaw 状态卡整块保留 + 「当前商家」占位卡 + 「AI 营销」占位卡。
- 新增 `src/views/marketing/Placeholder.vue`，**5 条 marketing 路由共用**：`/marketing/business`（商家大脑）、`/marketing/knowledge`（知识库）、`/marketing/advisor`（AI Advisor）、`/marketing/content`（Content Center）、`/marketing/hot`（UI 名「🔥 热点雷达」，内部路由/表名/文件名一律维持 hot* 不变）；01 全占位，后续提交逐页替换。
- **零改动**：Config.vue、Skills.vue、ChannelsPage.vue、Logs.vue、TerminalPage.vue、About.vue、ObsidianPage.vue、stores/*、electron/**（Setup.vue 仅 reload 一处例外）。
- 验证：`tsc --noEmit`；`npm run dev` 三链手测（清空 data → 进 Setup 且完成后不弹回；已装 → 直达工作台；手动进 Setup 仍可）；10 条旧路由全通 + 5 条 marketing 占位路由可达。

### ✅ 实施结果（2026-09-15，v1.15 补记）

- 落点与计划一致：`src/App.vue`（4 组导航 + 待办 #2 改名）、`src/renderer/main.ts`（+5 路由 + 守卫接入）、`src/views/marketing/Placeholder.vue`（新增）、`src/views/Dashboard.vue`（+2 卡）、`src/views/Setup.vue`（reload + 放宽 channels）；**额外新增 `src/renderer/setupGuard.ts`**（守卫独立模块，`createSetupGuard({ check })`，便于无 GUI 自动化验收）。
- 守卫口径实测：`nodeInstalled && openClawInstalled`（不含 channels）✓、探测只调一次（缓存）✓、目标 `/setup` 放行不产生重定向环 ✓、探测异常放行 ✓、`replace` 重定向 ✓。
- 验收方式调整：**可执行测试替代 GUI 手测** —— `node test/commit01-guard.test.mjs`（esbuild 打真模块 + 真 vue-router，12/12 PASS）；GUI 三链手测未做（本机无桌面通道），但打包态冒烟时实测到守卫在真安装包里把首启拦到 `#/setup`。
- 类型检查：`tsc --noEmit`（根）0 错；`vue-tsc -p tsconfig.web.json` 仅 1 条**预存在**告警 `TerminalPage.vue:153`（本次未改该文件）。⚠️ 根 `tsc --noEmit` 为空转，见 v1.15 第①条。

## 九、待确认事项

| # | 事项 | 状态 |
|---|------|------|
| 1 | 「环境初始化」入口分组 | ✅ 已落地：随 01 进 OpenClaw 组 |
| 2 | label 改名（控制台→工作台、技能管理→能力中心、渠道接入→渠道） | 🟡 建议执行：to 值不变，随 01 上线 |
| 3 | 分支策略 | ✅ 已落地：当前 `release/2.0`，master / release/1.0 并存 |
| 4 | PLAN-2.0.md 入库 | ✅ 2026-09-15 随 Commit 01 提交入库（含 `spikes/`） |
| 5 | 放宽 Setup.vue 完成按钮的 channels 要求 | 🟡 与 01 的 reload 改动同期处理（最小改动） |
| 6 | SQLite 选型 | ✅ v1.4 定稿：方案 B |
| 7 | DB 滚动快照 | ✅ v1.4 定稿：VACUUM INTO，保留 5 份，02 落地 |
| 8 | Commit 负责人 | ⬜ 多人协作时在第七节表中填名 |
| 9 | v1.8 第三方评审 12 项 | ✅ 2026-09-15 全部并入基线（见 v1.8 修订记录） |
| 10 | v1.9 第四轮评审 16 项 | ✅ 2026-09-15 全部并入，基线封版，进入 Commit 00；开工后新发现一律走新版本修订，不口头改基线 |
| 11 | v1.10 第五轮评审 9 项 | ✅ 2026-09-15 全部并入；#1-4、#6-7 为 user_version=1 建表前必须项（Commit 02 前有效），#5 立即生效，#8-9 已进 09/11/12 验收 |
| 12 | v1.12 产品智能 + 数据源定稿 | ✅ 2026-09-15 全部并入（见 v1.12 修订记录）；数据源三线与小红书降级口径由 Commit 11 SPIKE 实测确认 |
| 13 | v1.13 依赖/字段/上下文补齐 5 项 | ✅ 2026-09-15 全部并入：①AI 扩词 04→08（依赖倒置）②contents 补 `published_at`/`effect_note` ③Context Pack 加 `watchlist[]` ④`origin=watch` 标 2.1 预留 ⑤完整度卡片 Knowledge 维度随 05 接入 |
| 14 | 客户端 abort 后**服务端是否停止生成** | ⬜ 待 07 验证（关系到 08/09 停止生成是否真的省 token）|
| 16 | **根 `npm run typecheck` 空转**（tsconfig 为 `files:[] + references`，什么都没检查） | ✅ v1.15 已补 `typecheck:node` / `typecheck:web`（逐项目检查暴露 6 个被掩盖的真错并修复）；后续提交一律走逐项目检查 |
| 17 | Commit 03 三条未覆盖项（删行失败分支 / store 降级语义无单测 / UI 点击流） | ⬜ 见「Commit 03 落点与验收」；均已在代码层说明，未做执行证据 |
| 18 | Commit 04 三条未覆盖项（UI 点击流 / 完整度常量双份 / Watchlist 无批量导入） | ⬜ 见「Commit 04 落点与验收」 |
| 19 | Commit 05a 三条未覆盖项（K8 需真样本 / UI 点击流 / **lock 与 node_modules 漂移**） | ⬜ 见「Commit 05a 落点与验收」；漂移修复建议独立做 |
| 15 | 应用写 `meta.lastTouchedAt` / `lastTouchedVersion:'latest'` 被 schema 拒绝 | ⬜ 待 07 顺带修（`configManager.ts:703-707`、`downloadManager.ts:1451-1452`）；实测 OpenClaw 启动时会自愈，后果较轻 |

## 十、概念备忘

- Skill ≠ 商家数据：Skill 是能力/行业知识；商家资料属于 Project。
- OpenClaw Memory ≠ Umi Claw Knowledge Base：Memory 是 Agent 工作记忆；Knowledge 是商家事实知识。
- 知识库是一级能力，不是 BusinessBrain 的子功能；素材库与知识库分离（「你是谁」 vs 「你手里有什么」）。
- 热点是全局数据（hot_topics 抓一次共享），相关性是 Project × 发布平台数据（project_hot_topics 懒评分缓存，24h TTL）；采集不依赖 Gateway，AI 才依赖。
- **External Intelligence ≠ Merchant Knowledge**：热点榜单是外部情报，永不自动写入 Knowledge Base；只有老板人工采纳的事实才进入商家资料。
- 去重只在同源内做；跨平台同事件保留多行（能回答「哪个平台最火」），聚合是二期的事。
- 数据源三条供给线（v1.12）：榜单（公开聚合 API，base URL 可配）/ 节点日历（自建，零抓取零鉴权）/ Watchlist（老板填的词，只喂 AI 不采集）。
- Watchlist ≠ 采集任务：一期只作为 AI 上下文与关注点记录；2.1 若做关键词采集，按全局词池去重、一个词只采一次多商家共享。
- 小红书**没有**公开稳定的免鉴权热点出口（平台策略，非技术难度）：抖音侧雷达信号更厚、小红书侧靠通用热点 + AI 语义判断，**UI 不得假装小红书有专属榜单**。
- 更智能 = 更少让老板解释自己：他填过的必须用上，没填的主动问，改过的要学到。
- 纯目录不做结构化存储；大文件走文件系统 + 库存路径。
- 营销数据按 Project 隔离：`data/projects/<id>/` 原始文件 + 结构化数据 project_id 外键。
- 删除 Project（v1.10 修订）：弹确认窗 → **先删 `data/projects/<id>/` 目录（占用失败做重试并记日志）→ 再删 DB 行（级联清结构化数据）**。删行失败时**不声称删除成功**：保留 DB 行、向用户报错并提供「重试删除」（操作幂等：目录已不存在则直接删行）；目录可能已被删故不存在「凭目录重建」，仅依赖 VACUUM INTO 快照兜底。物理删除无软删。
