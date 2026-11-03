# 更新日志（CHANGELOG）

本日志记录面向使用者的版本变化。开发细节见 `PLAN-2.0.md`。

格式参考 Keep a Changelog，版本号遵循语义化版本。

---

## [4.1.0]（已发布，4.0.2 之后）— 2026-11-03

> `package.json` version = **4.1.0**；tag `v4.1.0` 已打（发布证据见 PROGRESS「4.1 版本级收尾」）

> 主题：**架构收口（无用户可见行为变化）**。完成 4.0 遗留的组装层与插件边界两块欠账。

### 重构
- **插件边界清零**：域 IPC 全部搬进 `plugins/<id>/main/ipc/`（work 1 个文件 + marketing 8 个文件：6 个搬迁 + gateway 拆分 + ipcTypes，另 services 新增 hostUi），`check:boundary` 从 9 条越界收紧到 **0（硬约束）**；插件不再 import electron，
  宿主 electron 能力经 `services/hostUi`、流透传经 `services/gateway/stream` 注入。
- **宿主装配瘦身**：`electron/main/index.ts` 2,551 → **1,777 行**（≤1,800 目标达成；4.0.2 P2 加 10 行）；61 个 host IPC（4.0.2 P2 起 +2 条 import 通道 = 63）
  拆到 `electron/main/ipc/host/*`，插件装配抽到 `services/pluginRuntime`，宿主服务适配器抽到
  `services/pluginServiceAdapters`。
- 副作用：宿主 `electron/main` 27,463 → **26,373 行**（4.0.2 P2 后；离 V4 ≤26,000 差 373，后续删减）。

### 已知残差（登记 4.2）
- `electron/main/ipc/index.ts` 仍 re-export 插件 registrar（host→plugin 兼容依赖，无环）；
- 14 处 type-only 宿主类型引用（门禁口径「非 type 越界 0」）；
- 拆分后 env/claw/terminal/config 等宿主通道的行为级测试仍待补（P45）。

---

## [4.0.2]（未发布，4.0.1 之后）— 2026-11-03

> 主题：**数据归属收口 + 测试稳定性**。

### 修复
- **work 知识库原件收进插件目录**：新导入写 `<dataDir>/plugins/work/knowledge/<id>/`（与 marketing 的
  `projects/<id>/` 同口径），不再写全局 `<dataDir>/knowledge/`；`source_path` 仍存相对 dataDir。
  **旧文件不自动迁移**：旧条目照常可读（原件只作溯源），旧 `<dataDir>/knowledge` 可手工清理；
  只有新导入进插件目录。
- 测试稳定性：report/content 收尾处 5 处固定 sleep 改 `waitFor`（异步落库/断连/注册表清空不再赌时间）。
- **旧库导入失败对用户可见 + 一键重试**：导入结果写 `<dataDir>/plugins/<id>/import-status.json`；宿主壳
  顶部横幅展示失败原因并提供「重试导入」（`plugin:import:status` / `plugin:import:retry`），重试走插件
  注册的执行器（强制绕过 `.imported` 标记，幂等 upsert）；插件停用即摘除执行器。

### 测试
- 全量验收 32 套 / **607 条断言**；knowledge.work 10/10、knowledge.marketing 23/23

### 已知未做（并入 4.2，4.0.2 不阻塞）
- P5 便携 Node 探针的 GUI 诊断横幅/引导重装入口（当前写日志文件）

---

## [4.0.1]（未发布，待 v4.0.0 tag 之后）— 2026-11-03

> 主题：**停用即止损 + 数据安全加固 + 启动可诊断**。全部为用户可感知或数据安全相关的补丁。

### 修复
- **work 插件停用/退出时中止全部在途 SSE**（问答 / 工具箱 / 日报 / OpenClaw 总结）：之前只停提醒循环，
  通道摘掉后模型仍在产出、继续烧 token；停用中止不计入当天自动总结尝试配额
- **单实例锁**：第二个实例直接退出并把启动请求转给已有窗口；避免两个实例同写 `character/kv.json`
  与插件 KV（跨进程无保护）；锁在 `app.setPath('userData', …)` 之后请求（按实际 userData 生效，
  便携版与安装版互不误伤）；`whenReady` 加守卫，quit 后不会再建窗口/拉 DB worker
- **停用中止不消耗自动总结配额**：停用中止的总结不计入「当天 3 次」；并复位 abort 标志，
  防微任务窗口残留把下一次真实失败误判成「停用中止」
- **pluginKv 并发写不丢键**：同 dataDir 的多个插件实例共享缓存 + 串行写队列（之前后写者会整份抹掉
  先写者的键）；写盘成功后才更新缓存
- **便携 Node 写入探针**：启动时用便携 Node 自检能否写 dataDir（低完整性/只读环境会表现为
  「数据存不上」）；失败区分 EPERM 与超时，告警写入 `<dataDir>/logs/runtime-probe.log`

### 测试
- `ctx.kv` / `ctx.secrets` 首次有真实 ctx 注入断言（命名空间隔离 / round-trip / safeStorage 不可用拒绝）
- 新增 T7/P13/S16/P56/P57/C80/N8：停用中止、单实例锁、探针、pluginKv 并发
- 修复跨午夜假失败（`openclaw-summary` S12 假时钟）与 e2e 固定 sleep 时序 flake（waitFor）
- 全量验收 32 套 / **607 条断言**

### 已知未做（顺延 4.0.2；其中 knowledge 隔离与 P2 已在 4.0.2 完成，P5 GUI 延伸并入 4.2）
- 旧库导入失败的用户可见状态与「重试导入」入口（当前只有日志）
- work 知识库原件路径隔离（仍在全局 `<dataDir>/knowledge`）
- 便携 Node 探针的 GUI 诊断横幅/引导重装入口（当前写日志文件）

---

## [4.0.0]（release/4.0，开发中：阶段 A 已收尾，待 C0.3 真机安装后打 tag）— 2026-11-02

> 主题：**插件化宿主** + 启动可靠性/性能优化。一套代码通过官方内置插件组合出营销（2.0）/ 工作（3.0）能力。

### 插件化
- 控制台（`/dashboard`）与能力中心（`/skills`）导航；插件运行期启停、懒加载、独立路由/IPC/数据迁移
- 2.0 营销域、3.0 工作域装箱为官方内置插件；宿主保留 OpenClaw 管理/渠道/终端/Obsidian/技能/更新等壳能力
- 宿主服务下沉（db / knowledge / context / voice），插件通过 `ctx` 使用，配置与密钥归宿主（gateway 客户端仍在宿主侧，按 WP6/4.1 再下沉）
- work / marketing 域代码搬到 `plugins/<id>/domain/`；重复的文档解析器合并为 `services/knowledge`，
  上下文取舍循环收敛为 `services/context` 内核（两域共用，域侧只提供回调）
- 插件契约补 `secrets` / `kv`（4.0 只有接口：当前无插件消费、无 accept 断言，消费与断言归 4.1）；角色数据迁到 `<dataDir>/character/kv.json`
  （旧 `fish:v2:*` 一次性导入，标记文件防重复；首次导入以旧库为准，可覆盖早期版本的默认值）
- 边界门禁 `scripts/check-boundaries.mjs`（零依赖 ratchet：pluginHostBoundary=11 / managerElectron=0），
  已接入全量验收首套与 CI，覆盖静态 import / export-from / 动态 import / require / 路径穿越

### 启动可靠性与性能
- **就绪态与阶段可视化**：`running`（进程）与 `ready`（/health 200）分离；点击启动即「启动中」；
  Dashboard 展示 preparing/spawning/loading/ready 与预计剩余时间；`statusChange` 推送 `bootPhase/estimateStartupMs`
- **webhook 迁移标记兜底**：无 `legacyWebhook` 时自动补 `meta.migrations.webhookListeners=true`，
  避免每次启动重跑旧迁移（实测可省约 185s 级）；备份 + 原子写回退 + BOM/CRLF 保留，走官方写入串行队列
- **退出应用时保留网关（可选，默认关）**：网关 detached + 日志文件；退出应用不停网关，
  下次启动校验端口 owner / openclaw 版本 / 健康后直接复用（跳过数分钟冷启动）
- **启动 ETA**：记录最近 5 次启动耗时，样本 ≤2 用最近一次、≥3 取最近 3 次中位数
- **网关日志文件 tail**：增量读取、半行 carry、截断检测、stdout/stderr 分流、兼容 pino `msg`
- **语音音色热更**：改音色无需重启网关（`data/voice/tts-bridge.json`，桥接脚本每次合成读取）；
  Key / TTS 模式 / 通道变更仍需重启
- 环境开关：`OPENCLAW_GATEWAY_STARTUP_TRACE` 默认关（`CLAW_OC_STARTUP_TRACE=1` 开启）、
  `OPENCLAW_FS_SAFE_NATIVE_MODE` 覆盖值白名单、`NODE_COMPILE_CACHE` 落 data/cache 并 >512MB 后台清理

### 修复
- adopt 复用网关时不再显示异常的「本次启动耗时」
- 编译缓存清理覆盖默认配置（keep=false 用户同样写缓存）
- 串行配置写入避免任务 reject 时的 unhandledRejection
- 渲染端 `AppConfig` 补 `keepGatewayOnQuit` 字段

### 验收
- 32 套（accept×30 + e2e + smoke）/ 600 条断言；双 typecheck 0 错、build 通过
- 本机 `npm run accept` 全绿（含 hot）；便携 Node 若带低完整性标签（写不了 `test/.tmp`），验收会自动复制到系统临时目录再用（见 `test/_lib.mjs:resolveNodePath`）

---
## [2.0.0]（release/2.0 分支，待发布）

> 主题：从「OpenClaw 管理器」升级为「**AI 营销工作台**」。
> 在不改动原有 OpenClaw 管理能力的前提下，新增一套面向实体店老板的线上获客工具。

### ✨ 全新功能

**营销工作台（新）**
- **商家管理**：可建立多个商家档案（Project），一键切换；每个商家的数据与文件独立隔离，互不串味。
- **商家大脑**：集中填写品牌、定位、客群、语气、关注词等信息，AI 回答和创作时自动带上，不用反复解释"我是谁"。
- **关注词（Watchlist）**：手工维护行业/关注点词库，作为 AI 问答与内容生成的上下文，并支持 AI 推荐扩词、勾选采纳。
- **知识库**：导入文字、Markdown、Word、Excel、PDF、网址链接、FAQ 等资料，本地解析入库，支持关键词检索与资料完整度提示；大文件保留原件。
- **扫描件 AI 识别**：扫描版 PDF / 纯图片资料可显式触发 AI 文字识别，经人工确认后入库。

**AI 创作（新）**
- **AI 顾问（Advisor）**：基于本商家资料的问答，回答有出处、不瞎编；资料不足时主动提示要补充什么；支持流式输出与「停止生成」。
- **上下文引擎**：自动把商家信息 + 知识库 + 关注词 + 平台规则组装成上下文包，预算内全量、超预算智能裁剪。
- **内容中心（Content Center）**：一次生成 **3 个候选版本**供挑选，支持流式生成与中断；可编辑、保存历史版本（含当时提示词快照）、提交审核 → 审核通过 → 标记已发布。
- **双平台工作流**：内置**小红书**与**抖音**两套平台规则模板，生成内容时自动注入；抖音一期提供口播脚本/标题/话题标签文案。
- 所有内容均**人工复制发布**，不自动对外发送。

**热点雷达（新）**
- 多源采集全网热点（头条、B 站等公开数据源 + 节点日历），展示近 24 小时 / 3 天 / 7 天榜单，可按数据源筛选、切换发布视角。
- 热点自动去重、生命周期管理；数据源状态条可见每个来源的成功 / 失败 / 超时。
- **AI 商家匹配评分**：对热点按当前商家与发布平台做相关性打分，分为「值得跟 / 观察 / 不建议 / 待分析」四档，懒评分、可手动重新分析；顶部给出「今日建议」。没有强推内容时坚持宁缺毋滥。
- 榜单热点可一键「带去内容中心」，自动预填选题、来源与建议角度。

**模型与系统**
- **模型预设外置**：内置模型预设快照，开箱可用；支持从 Gitee「**拉取最新**」在线更新预设，立即生效、断网仍有内置兜底。

### 🛡️ 数据与安全
- 结构化数据存入本地 **SQLite**（经便携 Node 子进程，零原生依赖），WAL 模式防损坏，支持自动滚动备份。
- 首启 **Setup 守卫**：环境未就绪时引导完成初始化，已安装则直达工作台。
- 全程不改动 OpenClaw 数据目录与运行时；现有配置、技能、渠道、日志、终端等功能全部保留。

---

## [1.x]

- OpenClaw 便携管理器：零配置启动、图形化配置模型 / 技能 / 渠道、实时日志、内置终端、系统托盘。
- 内置微信渠道；支持企业微信官方插件扫码接入、飞书自建应用长连接。
- Obsidian 知识库：笔记向量化语义检索，以 MCP 工具按需喂给模型。
- 便携模式（U 盘数据随身）、国内镜像加速。

---

### 升级说明
- 老用户直接安装新包即可，安装器会自动搬迁旧版数据目录，无需手动处理。
- 首次使用营销功能需先建立一个商家档案。
