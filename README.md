# 🦞 Umi Claw

> OpenClaw 便携管理工具 + AI 工作台 — 基于 Electron + Vue3 + Vite 开发
>
> 愿景：简单点，无需复杂安装操作让每个人都能享受 AI 带来的便利

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Umi Claw 有三条并行版本线，都从 1.0 的 OpenClaw 管理能力分叉，各自独立演进：

| 版本 | 分支 | 面向谁 | 在通用能力之上新增 |
|------|------|--------|-------------------|
| **1.0** 通用版 | `master` / `release/1.0` | 想用 OpenClaw 的个人 | —（模型 / 技能 / 渠道 / Obsidian / 终端等管理能力） |
| **2.0** AI 营销版 | `release/2.0` | 实体店老板、线上获客 | AI 营销工作台：商家大脑 → 知识库 → AI 顾问 → 内容中心 → 热点雷达 |
| **3.0** 工作版 | `release/3.0` | 日常办公的打工人 | AI 工作记忆 + 每日工作闭环：今日待办 / 工作记录 / 日报周报 / 工作问答 / 工具箱 / 到点提醒 |

> 2.0 与 3.0 是两条**独立**的产品线，互不包含：3.0 基于 1.0 分叉，不带 2.0 的营销模块；2.0 也不带 3.0 的工作记忆模块。当前所在分支的功能以该分支的 README 为准。

## 项目特性

### 通用能力（所有版本共享）

- 🚀 **零配置启动** — 首次运行自动下载所需运行时
- 🖥️ **原生桌面体验** — 自定义标题栏、系统托盘、原生弹窗
- ⚙️ **完整管理界面** — 图形化配置 OpenClaw、模型、技能
- 🧩 **内置中文技能** — 开箱即用的中文 AI 能力，支持云端仓库同步更新（Gitee 勾选导入 / 版本检测）
- 🤖 **多个模型服务商** — DeepSeek、Kimi、通义千问、OpenAI 等，模型预设可在线「拉取最新」
- 🔧 **Node 运行时管理** — 界面内查看 / 切换便携 Node.js 版本
- 📋 **实时日志监控** — 带过滤、导出功能的日志查看器，日志文件：`data/logs/runtime-debug.log`
- 📩 **多渠道接入** — 内置微信，支持企业微信官方插件（扫码即接入）、飞书自建应用（长连接，界面一键装插件）
- 📚 **Obsidian 知识库** — 笔记向量化语义检索，以 MCP 工具喂给模型，按需取片段省 token
- 💾 **便携模式** — 可放置在 U 盘，数据随身带走
- 🌐 **国内镜像加速** — npmmirror + GitHub 代理，无需翻墙

### 2.0 新增：AI 营销工作台

- 🏪 **AI 营销工作台** — 围绕实体店老板的线上获客动线：商家建模 → 知识库 → AI 顾问 → 内容生成 → 热点雷达
- 🧠 **商家大脑** — 品牌 / 定位 / 客群 / 语气档案建模，资料完整度提示，关注词只喂 AI、不触发采集
- 📄 **多格式知识库** — Word / Excel / PDF / 网址 / 纯文本本地解析入库，扫描件可 AI 识别兜底
- 💬 **AI 顾问** — 基于本商家资料的流式问答，引用商家事实、不编造
- ✍️ **内容中心** — 一次生成 3 版候选，版本与提示词快照可追溯，草稿到发布的人工审核流
- 🔥 **热点雷达** — 头条 / B 站等公开榜单多源采集，AI 相关性评分、四档分组与「今日建议」
- 🎬 **平台工作流** — 内置小红书、抖音平台规则模板，问答与生成时自动注入

### 3.0 新增：工作版

- ☀️ **新的一天** — 今日待办聚合（手动 / daily·weekly 例事 / AI 提取）+ 一句话智能入口
- 🗂 **工作记录** — 手动、AI 候选、勾完成联动三来源；候选确认后才成为事实，支持 LIKE 检索
- 📊 **日报 / 周报** — 事实确定性聚合 → AI 表达 → 编辑确认；生成快照不可变、可溯源
- 💬 **工作问答** — 基于工作记忆作答，答不出说明缺什么，每条回答可展开「依据」
- 🧰 **AI 工具箱** — 会议纪要（含待办提取）、邮件起草，以及润色 / 翻译 / 摘要 / 邮件润色
- 📚 **工作知识库** — 本地文档解析入库，预算内全量注入工作记忆
- ⏰ **到点提醒** — 待办到点本机通知必达；可选外发「草稿已就绪」短提示到渠道
- 🔍 **AI 的世界** — 查看 AI 看到的工作记忆组成，以及被裁剪的内容与原因
- 🧙 **首启向导 + 用户协议** — 冷启动弹窗引导初始化，同意协议后方可使用

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | 30 | 跨平台桌面框架 |
| Vue 3 | 3.4 | 前端框架 |
| Vite | 5 | 构建工具 |
| TypeScript | 5.4 | 类型安全 |
| Pinia | 2.1 | 状态管理 |
| Vue Router | 4.3 | 前端路由 |
| electron-vite | 2.1 | Electron+Vite 集成 |
| xterm.js | 6 | 内嵌终端 |
| Less | 4.6 | 样式预处理 |
| @vueuse/core | 10 | Vue 组合式工具库 |
| mammoth / exceljs / docx / pdfjs-dist | — | Word / Excel / PDF 文档解析与生成（2.0 / 3.0） |

## 目录结构

三条版本线共用同一套工程骨架，2.0 / 3.0 在各自分支上叠加模块。下面先列公共结构（即 `master` 上的实际目录），再分别列 2.0、3.0 的新增部分。

### 公共结构

```
umi-claw/
├── electron/
│   ├── main/
│   │   ├── index.ts           # 主进程入口 / IPC 注册 / 窗口 / 托盘
│   │   ├── clawManager.ts     # OpenClaw 进程管理
│   │   ├── configManager.ts   # 配置读写管理
│   │   ├── downloadManager.ts # 环境下载安装 / Node 运行时管理
│   │   ├── channelManager.ts  # 渠道（微信等）安装与管理
│   │   ├── openClawPaths.ts   # OpenClaw 路径解析（安装版 / 便携版）
│   │   ├── skillSyncService.ts # 技能云端仓库同步（Gitee）/ 版本检测
│   │   ├── modelConfig.ts     # 模型预设键位/命名避让（预设数据已外置）
│   │   ├── modelPresets.ts    # 预设加载/校验/「拉取最新」（上游：Gitee awesome-llm-models，快照在 resources/model-presets/）
│   │   └── obsidian/          # Obsidian 知识库管理
│   │       ├── obsidianManager.ts  # 配置/索引/检索测试/MCP 配置生成
│   │       └── types.ts            # 类型定义
│   └── preload/
│       ├── index.ts           # Preload / IPC 桥接
│       └── index.d.ts         # window.api 类型声明
├── src/
│   ├── views/
│   │   ├── Dashboard.vue      # 控制台
│   │   ├── Config.vue         # 模型配置
│   │   ├── Skills.vue         # 技能管理
│   │   ├── Logs.vue           # 运行日志
│   │   ├── Setup.vue          # 环境初始化
│   │   ├── ChannelsPage.vue   # 渠道接入（微信/企微/飞书）
│   │   ├── TerminalPage.vue   # OpenClaw 终端（支持 openclaw/npx 双运行时）
│   │   ├── ObsidianPage.vue   # 知识库（Obsidian）
│   │   ├── About.vue          # 关于
│   │   └── components/        # 通用组件
│   │       ├── ConfirmDialog.vue       # 确认对话框（关闭确认等）
│   │       └── ModelPickerModal.vue    # 模型选择弹窗
│   ├── types/
│   │   └── terminal.ts        # 终端运行时类型（TerminalRuntime）
│   ├── stores/
│   │   ├── claw.ts            # OpenClaw 状态
│   │   └── config.ts          # 配置状态
│   ├── composables/
│   │   ├── useToast.ts        # 全局提示
│   │   └── useTheme.ts        # 主题切换
│   ├── theme/
│   │   └── themes.ts          # 主题定义
│   ├── assets/style.css       # 全局样式
│   ├── env.d.ts               # 渲染端环境类型
│   ├── App.vue                # 根组件（标题栏+侧边栏+关闭确认）
│   └── renderer/
│       ├── main.ts            # Vue 入口 / 路由
│       └── index.html         # 渲染进程 HTML
├── resources/                 # 应用资源（打包为 extraResources）
│   ├── icon.ico / tray.png    # 应用 / 托盘图标
│   ├── umiIcon.svg
│   ├── model-presets/         # 模型预设内置快照
│   │   └── model-presets.json
│   └── obsidian/              # 知识库子进程脚本（零依赖，绿色 node 拉起）
│       ├── indexer.mjs        # 索引器：扫描 vault、切块、embedding、写向量库
│       ├── mcp-server.mjs     # MCP server（stdio JSON-RPC），OpenClaw 拉起
│       ├── db.mjs             # sqlite 向量库封装（node:sqlite）
│       ├── embeddings.mjs     # embedding API 适配（OpenAI 兼容 / Cohere）
│       ├── markdown.mjs       # front matter / 切块 / 标签 / wikilink 解析
│       └── search.mjs         # 检索测试脚本（与 search_notes 同链路）
├── electron.vite.config.ts
├── build/
│   └── installer.nsh          # NSIS 钩子：升级时自动搬迁旧版数据目录
└── package.json
```

### 2.0 新增（`release/2.0`）

```
electron/main/
├── database/                  # SQLite DB Worker 客户端（全局单例）
│   ├── database.ts            # 常驻 worker 客户端 / 请求队列 / 断线重连
│   ├── schema.ts              # 表结构（projects/businesses/knowledge/contents/hot...）
│   ├── migration.ts           # 迁移版本
│   └── errors.ts              # 错误码
├── gatewayClient.ts           # 网关 HTTP 客户端（token 仅留在主进程）
├── subprocessRegistry.ts      # 便携 Node 子进程注册表 / 统一优雅关闭
├── ipc/                       # marketing IPC 面
│   ├── index.ts
│   ├── gateway.ts
│   ├── marketing.ts           # project/business/knowledge/content/hot 通道
│   └── advisor.ts / content.ts / hot.ts / scan.ts
└── marketing/                 # AI 营销业务层（不 import electron）
    ├── projectManager.ts      # 商家（Project）CRUD / 当前商家
    ├── businessManager.ts     # 商家档案 1:1 / 关注词
    ├── knowledgeManager.ts    # 多格式导入解析 / 关键词检索
    ├── contextEngine.ts       # Context Pack 预算内打包 / 超预算裁剪
    ├── advisorManager.ts      # AI 顾问（流式 SSE）
    ├── contentManager.ts      # 内容生成 / 版本 / 审核状态
    ├── hotManager.ts          # 热点采集调度 / 生命周期 / 落榜清理
    ├── hotScoreManager.ts     # AI 相关性懒评分 / 四档分组
    ├── hotShared.ts / jsonExtract.ts / platformRules.ts
    ├── scanRecognizer.ts      # 扫描件 / 图片 AI 识别兜底
    ├── shootingScript.ts      # 分镜脚本生成
    └── parsers/               # Word / Excel / PDF / URL 解析
src/
├── stores/marketing.ts        # 商家 / 知识库 / AI / 内容 / 热点状态
└── views/
    ├── components/ProjectSwitcher.vue   # 商家切换器
    └── marketing/             # AI 营销页面
        ├── BusinessBrain.vue  # 商家大脑
        ├── KnowledgeBase.vue  # 知识库
        ├── AdvisorPanel.vue   # AI 顾问
        ├── ContentCenter.vue  # 内容中心
        └── HotCenter.vue      # 热点雷达
resources/
├── database/db-worker.mjs     # DB Worker 子进程（node:sqlite / stdio JSON）
└── collector/                 # 热点采集器（短命子进程，仅适配公开数据源）
    ├── index.mjs
    ├── calendar.json
    └── sources/               # toutiao / bilibili / dailyhot / calendar
```

### 3.0 新增（`release/3.0`）

```
electron/main/
├── database/                  # 3.0 数据层：schema / Worker 通信 / 迁移 / 错误码
│   └── database.ts / schema.ts / migration.ts / errors.ts
├── gatewayClient.ts           # 网关 HTTP 客户端（token 仅留在主进程）
├── channelCatalog.ts          # 渠道目录 / 元信息
├── subprocessRegistry.ts      # 子进程登记 / 统一清理
├── ipc/                       # IPC handler 分组注册
│   ├── index.ts               # 汇总注册
│   ├── gateway.ts             # 窗口/进程/配置/环境/技能等管理侧
│   └── work.ts                # 3.0 工作版域
└── work/                      # 3.0 工作版域
    ├── contextEngine.ts       # Context Pack 组装 / 预算裁剪
    ├── contextManager.ts      # 上下文快照
    ├── factAggregator.ts      # 事实确定性聚合
    ├── profileManager.ts      # 工作画像
    ├── matterManager.ts       # 事项
    ├── todoManager.ts         # 待办（含 daily/weekly 例事、AI 候选）
    ├── recordManager.ts       # 工作记录（候选确认、LIKE 检索）
    ├── todayManager.ts        # 新的一天聚合
    ├── routerManager.ts       # 一句话智能入口路由
    ├── qaManager.ts           # 工作问答
    ├── reportManager.ts       # 日报/周报 + 不可变快照
    ├── toolManager.ts         # AI 工具箱
    ├── knowledgeManager.ts    # 工作知识库
    ├── wizardManager.ts       # 首启向导 / 用户协议
    ├── reminderManager.ts     # 到点提醒 / 外发推送
    ├── openclawSummaryManager.ts # 桥接 OpenClaw 总结当天工作 → 候选
    └── parsers/               # 工作知识库文档解析
        ├── documentParsers.ts # Word/Excel/PDF/TXT
        ├── pdfjsAssets.ts     # 打包态 pdfjs 资源定位
        └── urlParser.ts       # URL 解析
src/views/
├── work/                      # 3.0 工作版页面
│   ├── TodayPage.vue          # 新的一天
│   ├── RecordsPage.vue        # 工作记录
│   ├── QaPage.vue             # 工作问答
│   ├── ReportsPage.vue        # 报告
│   ├── ToolsPage.vue          # 工具箱
│   ├── KnowledgePage.vue      # 工作知识库
│   ├── ContextPage.vue        # AI 的世界
│   └── SettingsPage.vue       # 工作设置
└── components/
    ├── UserAgreementModal.vue # 用户协议弹窗
    └── WizardModal.vue        # 首启向导弹窗
resources/
├── database/                  # 3.0 数据层 Worker
│   ├── db-worker.mjs          # Worker 子进程（sqlite 操作）
│   └── read-old-db.mjs        # 旧库读取（迁移用）
└── pdfjs/                     # pdfjs 资源（build / cmaps / standard_fonts）
scripts/run-all-accept.mjs     # 一键跑全部验收
test/                          # 验收：accept + e2e + 打包态 smoke
PLAN-3.0.md                    # 3.0 规划基线
```

## 分支说明

| 分支 | 用途 |
|------|------|
| `master` | 稳定主分支（默认分支），只接收经过验证的发布内容，PR 的默认目标 |
| `release/1.0` | 1.0 通用版开发分支，包含 Obsidian 知识库、企微官方插件、便携模式、技能云端同步等，功能稳定后合入 `master` |
| `release/2.0` | 2.0 AI 营销版开发分支：在 1.0 能力之上新增 AI 营销工作台 |
| `release/3.0` | 3.0 工作版开发分支：在 1.0 能力之上新增 AI 工作记忆 + 每日工作闭环 |

> 体验 1.0：`git checkout release/1.0` ｜ 体验 2.0：`git checkout release/2.0` ｜ 体验 3.0：`git checkout release/3.0`

## 快速开始

### 环境要求

- Node.js 18+
- npm / pnpm / yarn

### 本地开发

```bash
# 克隆项目
git clone https://github.com/bscwdg/umi-claw.git
cd umi-claw

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 类型检查
npm run typecheck
```

> 3.0 分支额外提供 `npm run accept`：一键跑全部验收（accept 套件 + 一天 e2e + 打包态 smoke）。

### 构建打包

```bash
# 构建当前平台
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux

# 构建所有平台（需要对应系统）
npm run build:all
```

### 国内镜像打包（Windows PowerShell）

打包时 Electron 及 electron-builder 二进制需从 GitHub 下载，国内网络容易超时失败。可先设置 npmmirror 镜像和本地缓存目录再构建：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_BUILDER_CACHE="D:\work2026\umi-claw\electron-builder-cache"  # 缓存目录可按需改成自己的路径
npm run build:win
```

> 注意：解压 electron-builder 的 winCodeSign 缓存需要创建符号链接权限，请在**管理员 PowerShell**中运行上述命令，或先开启 Windows「开发人员模式」（设置 → 系统 → 开发者选项）。普通权限终端打包会在 `Cannot create symbolic link` 处失败。

### 便携模式（U 盘使用）

正常安装版的数据放在 `%APPDATA%\UmiClaw`（与安装目录分离，更新/卸载不会动数据）。如果需要 U 盘携带：

1. 解压安装包或复制 `release\win-unpacked` 到 U 盘
2. 在 exe 同级手动创建 `data` 文件夹（可从已初始化的环境拷贝）
3. 启动后即进入便携模式：`data` 和 `context-data` 都跟随 exe，换机器数据完整

便携模式下的更新**不走安装器**：直接替换程序文件即可（保留 `data` 和 `context-data` 两个文件夹）。注意便携模式下数据文件更容易被其他程序（Excel、WPS 等）占用，替换前先关闭相关程序。

> 安装器升级旧版本时（`build/installer.nsh`），会自动把旧安装在安装目录里的 `data`/`context-data` 搬到 `%APPDATA%\UmiClaw`，老用户直接装新包即可，无需手动处理。

## IPC API 设计

主进程通过 `window.api` 暴露给渲染进程（以下为 1.0 通用能力；2.0 / 3.0 的新增命名空间见各自小节）：

```typescript
// ── 窗口控制 ──
window.api.window.minimize()          // 最小化
window.api.window.maximize()          // 最大化 / 还原
window.api.window.close()             // 关闭（触发关闭确认流程）
window.api.window.onCloseRequest(cb)  // 主进程请求关闭时回调（弹出确认框）
window.api.window.resolveClose(action, remember) // 回传选择: 'tray' | 'exit'，remember 记住选择
window.api.window.cancelClose()       // 取消关闭

// ── OpenClaw 进程管理 ──
window.api.claw.start()               // 启动 OpenClaw
window.api.claw.stop()                // 停止
window.api.claw.restart()             // 重启
window.api.claw.status()              // 获取状态
window.api.claw.openWeb()             // 打开 Web 界面（跟随 config.port）
window.api.claw.getToken()            // 获取访问 token
window.api.claw.onLog(cb)             // 监听实时日志
window.api.claw.onStatusChange(cb)    // 监听状态变化

// ── 配置管理 ──
window.api.config.get()               // 读取配置
window.api.config.save(cfg)           // 保存配置
window.api.config.reset()             // 恢复默认配置
window.api.config.getDataDir()        // 获取数据目录路径
window.api.config.openDataDir()       // 打开数据目录
window.api.config.getPresetModels(name) // 获取某服务商的预设模型
window.api.config.refreshModelPresets() // 「拉取最新」：从 Gitee 上游更新预设，立即生效
window.api.config.getModelPresetsInfo() // 预设来源信息（overlay/内置快照、更新时间、数量）
window.api.config.testConnection(cfg) // 测试模型连通性

// 主要配置字段示例（config.save 时可传入）：
// {
//   activeProvider: string,    // 当前激活的服务商 id
//   providers: [...],          // 模型服务商配置
//   port: 3213,                // 服务端口（claw.openWeb 会跟随此端口）
//   autoStart: boolean,        // 应用启动时自动拉起 OpenClaw
//   launchOnBoot: boolean,     // 系统开机自动启动应用（后台驻留托盘）
//   minimizeToTray: boolean,   // 是否启用关闭时最小化到托盘
//   closeAction: string,       // 关闭行为: 'ask' | 'tray' | 'exit'
//   useChineseMirror: boolean, // 使用国内镜像（UI 预留字段）
//   logLevel: string,          // 日志级别（预留）
//   language: string,          // 语言（预留）
// }

// ── 环境管理 ──
window.api.env.check()                // 检测环境
window.api.env.init(opts)             // 初始化环境
window.api.env.update(opts)           // 更新 OpenClaw
window.api.env.checkLatest(opts)      // 检查最新版本
window.api.env.getInfo()              // 获取环境信息
window.api.env.getNodeVersions(opts)  // 可用的便携 Node.js 版本列表
window.api.env.updateNode(opts)       // 切换便携 Node.js 版本
window.api.env.onProgress(cb)         // 监听下载 / 安装进度

// ── 技能管理 ──
window.api.skills.list()              // 可用技能列表
window.api.skills.install(id)         // 安装技能
window.api.skills.uninstall(id)       // 卸载技能
window.api.skills.removeSkill(id)     // 移除技能（含本地文件）
window.api.skills.getInstalledSkills()          // 已安装技能
window.api.skills.toggleSkillStatus(id, enabled)// 启用 / 停用技能
window.api.skills.importSkillZip()    // 从 zip 导入技能
window.api.skills.probeRemote()       // 探测云端技能仓库（Gitee）
window.api.skills.installSkills(ids)  // 勾选导入云端技能
window.api.skills.getPendingUpdates() // 查询有更新的技能
window.api.skills.applyUpdates(ids)   // 应用技能更新（staging 覆盖替换）

// ── 日志 ──
window.api.log.getLogs()              // 获取日志列表
window.api.log.clearLogs()            // 清空日志文件
// 日志文件永久存储在 data/logs/runtime-debug.log
// 包含主进程日志 + OpenClaw 子进程 stdout/stderr

// ── 终端（PTY）──
// runtime 参数（可选）: 'openclaw'（默认）| 'npx'（便携 npx-cli，用于企微官方安装向导等 npm 包命令）
window.api.terminal.runCommand(args, runtime?)       // 执行一次性命令
window.api.terminal.startPty(args, cols, rows, runtime?) // 启动 PTY 会话
window.api.terminal.inputPty(sid, data)           // 向 PTY 写入输入
window.api.terminal.resizePty(sid, cols, rows)    // 调整 PTY 尺寸
window.api.terminal.stopPty(sid)                  // 停止 PTY 会话
window.api.terminal.onPtyChunk(cb)                // 监听 PTY 输出流
window.api.terminal.onPtyExit(cb)                 // 监听 PTY 退出
window.api.terminal.removeListeners()             // 移除 PTY 监听

// ── 渠道接入 ──
window.api.channels.isPluginInstalled(id)     // 查询渠道插件是否已安装（如 'feishu'）
window.api.channels.installPlugin(pkg)         // 安装渠道插件（如 '@openclaw/feishu'），安装日志走 claw.onLog

// ── 知识库（Obsidian）──
window.api.obsidian.getConfig()            // 读取知识库配置
window.api.obsidian.saveConfig(cfg)        // 保存配置（触发 openclaw.json 的 MCP 注入）
window.api.obsidian.selectVault()          // 系统对话框选择 vault 目录
window.api.obsidian.getIndexStatus()       // 索引状态（笔记数/块数/维度/错误等）
window.api.obsidian.rebuildIndex()         // 重建索引（spawn indexer 子进程）
window.api.obsidian.cancelIndex()          // 取消进行中的索引
window.api.obsidian.testEmbedding(arg)     // 测试 embedding 连通，返回维度
window.api.obsidian.getEmbeddingPresets()  // embedding 模型预设列表
window.api.obsidian.testSearch(arg)        // 检索测试（与 MCP search_notes 同链路）
window.api.obsidian.onIndexProgress(cb)    // 监听索引进度，返回取消订阅函数

// ── 其他工具 ──
window.api.app.getVersion()           // 获取应用版本
window.api.shell.openExternal(url)    // 用系统默认浏览器打开链接
window.api.dialog.showMessage(opts)   // 弹出系统原生消息框
```

### 2.0 新增：`window.api.marketing.*`

所有方法返回统一信封 `{ ok, data | error }`：

```typescript
window.api.marketing.system.dbStatus(opts)               // 数据库状态 / 初始化
window.api.marketing.project.list()                      // 商家列表
window.api.marketing.project.create(input)               // 新建商家
window.api.marketing.project.update(projectId, patch)    // 改名 / 行业 / 简介
window.api.marketing.project.delete(projectId)           // 物理删除（先目录后行）
window.api.marketing.context.getCurrentProject()         // 当前商家
window.api.marketing.context.setCurrentProject(id)       // 切换并持久化
window.api.marketing.business.get(projectId)             // 商家档案（无行回 null）
window.api.marketing.business.upsert(projectId, data)    // 保存档案
window.api.marketing.watchlist.list(projectId)           // 关注词（只做手工增删，不采集）
window.api.marketing.watchlist.add(projectId, kw, type)  // 新增关注词
window.api.marketing.knowledge.list(projectId)           // 知识库列表
window.api.marketing.knowledge.import(projectId, input)  // 文件/网址/文本导入
window.api.marketing.knowledge.search(projectId, q)      // 关键词检索
window.api.marketing.knowledge.recognize(projectId, in)  // 扫描件 AI 识别（显式触发）
window.api.marketing.knowledge.commitRecognized(...)     // 人工确认后入库
window.api.marketing.gateway.ensureReady()               // 探活 → 按需拉起 → 就绪快照
window.api.marketing.advisor.ask(input)                  // AI 顾问（流式，onChunk 归并）
window.api.marketing.content.list(projectId)             // 内容列表
window.api.marketing.content.generate(projectId, spec)   // 一次生成 3 版（流式）
window.api.marketing.hot.list(projectId, options)        // 热点榜单（可触发采集）
window.api.marketing.hot.score(projectId, platform)      // AI 相关性懒评分
```

### 3.0 新增：`window.api.work.*`

按域划分的命名空间（统一信封 + 流式订阅）：

```typescript
window.api.work.profile      // 工作画像
window.api.work.matters      // 事项
window.api.work.todos        // 待办（例事 / 状态机 / AI 候选）
window.api.work.records      // 工作记录（候选确认 / 检索）
window.api.work.today        // 新的一天聚合
window.api.work.router       // 一句话智能入口
window.api.work.qa           // 工作问答
window.api.work.reports      // 日报 / 周报 + 快照
window.api.work.tools        // AI 工具箱
window.api.work.knowledge    // 工作知识库
window.api.work.context      // 上下文快照（AI 的世界）
window.api.work.reminder     // 到点提醒 / 外发
window.api.work.openclawSummary // 桥接 OpenClaw 当日总结 → 日报候选
window.api.work.wizard       // 首启向导 / 用户协议
window.api.work.gateway      // 网关探活 / 拉起 / SSE
window.api.work.stream       // 流式事件订阅
```

## AI 营销工作台（2.0）

2.0 在 OpenClaw 管理器之上新增面向实体店老板的 AI 营销工作台，覆盖线上获客动线：**建档 → 喂资料 → 提问 → 写文案 → 追热点**。所有 AI 产出都经人工审核、人工复制发布，应用不自动外发。

### 商家与工作空间

- 可建立多个商家，每个商家 = 独立工作空间：结构化数据按商家隔离，原文文件落在 `data/projects/<id>/`
- 支持新建 / 重命名 / 删除 / 切换，「当前商家」持久化、重启保持；每个商家独立会话键，AI 记忆互不串味
- 删除为物理删除：确认后先删文件目录、再删数据库行（级联清空）；目录被占用会中止并提示重试，不会假报成功

### 商家大脑

- 与商家 1:1 的档案：品牌、定位、城市 / 地址、联系方式、目标客群、语气风格
- 资料完整度即时提示缺什么；关注词（Watchlist，上限 10）只作为 AI 上下文，不触发任何采集

### 知识库

- 本地解析导入 Word（docx）、Excel（xlsx）、PDF、Markdown / 纯文本、网址链接；大文件保留原件、文本入库，支持去重与重新导入
- 关键词检索（SQLite LIKE，对中文友好）与 Knowledge 维度完整度提示
- 扫描版 PDF / 纯图片可显式触发 AI 文字识别，结果经人工确认后入库，识别可中止

> 与 1.0 / 3.0 知识库的实现差异，见下方「知识库对比（1.0 / 2.0 / 3.0）」。

### AI 顾问

- 基于本商家资料的问答：只引用已有事实（grounded），资料里没有的价格 / 承诺 / 卖点绝不编造，资料不足会提示该补什么
- 流式逐字输出，可随时停止；支持 AI 扩词生成候选关注词，勾选采纳

### 内容中心

- 输入选题（手填或从热点雷达一键带入），**一次生成 3 个候选版本**（不同角度 / 语气），流式输出、可停止、可编辑
- 版本管理：历史版本与每次生成的提示词快照一并保存，便于复盘
- 审核流：草稿 → 提交审核 → 审核通过 → 标记已发布；「已发布」是提醒人工发布的本地状态，不自动外发

### 平台工作流

- 内置小红书、抖音两套平台规则模板，问答与生成时自动注入
- 抖音一期提供口播脚本 / 标题 / 话题标签等文案层，不做视频成片；均为人工复制发布
- 摄影 / 服装业务线额外支持**分镜脚本**（`shooting_script`）：单路流式 + 严格 JSON 契约生成，原始 JSON 作为版本快照留存、渲染成可编辑的交付文本

### 热点雷达与 AI 评分

- 多源采集头条、B 站等公开免鉴权榜单（不登录、不带 Cookie、不绕风控），支持 24 小时 / 3 天 / 7 天榜单与平台视角切换
- 生命周期管理（rising / breaking / peak / long_tail）、同源去重、7 天落榜清理（被内容引用的保留），数据源状态逐源可见
- AI 按「当前商家 × 发布平台」相关性懒评分（分批、24h 缓存，可强制重评），四档分组：🔥 值得跟 / 👀 观察 / ❌ 不建议 / ⏳ 待分析
- 「今日建议」宁缺毋滥：只有出现足够强的热点时给出 1 条主推 + 理由 + 时机，并可一键带去内容中心

### 数据存储

- 营销数据存本地 SQLite：`data/umi-claw.db`（WAL 模式，自动滚动备份保留 5 份），由全局单例的 DB Worker 子进程（`node:sqlite`，零原生依赖）统一访问
- 分层 `Vue → Pinia → window.api → IPC → Manager → SQLite`：渲染端不直连数据库、不持有网关凭据
- 数据目录：开发环境为项目根 `data/`；安装版默认 `%APPDATA%\UmiClaw\data`；可设置 `CLAW_DATA_DIR` 或用 exe 同级 `data/` 进入便携模式

### 明确不做

- 不自动发布、不自动回复；一期不做矩阵 / 多账号、不做视频成片
- 不登录、不带 Cookie、不绕风控抓取；需登录的指数类数据服务不做

## 3.0 工作版

3.0 在 OpenClaw 管理能力之上，新增面向日常办公的「AI 工作记忆 + 每日工作闭环」。

- **工作记忆（Context Pack）**：把工作画像、事项、今日待办、近期已确认记录、工作知识库、历史对话按固定优先级组装成上下文；超预算时从后往前裁剪，被裁剪内容在「AI 的世界」留痕可见。
- **事实与表达分离**：工作记录只有在用户确认后才成为事实；日报由确定性规则聚合事实，再交给 AI 组织表达。日报错了改表达，事实错了改记录。
- **每日闭环**：早上在「新的一天」看待办 → 随手记工作记录 / 用工具箱处理纪要邮件 → 候选一键确认 → 傍晚生成日报、复制发出。
- **可追溯快照**：每次生成日报都把当时的输入与工作记忆作为不可变副本存下；删除记录后，历史报告仍完整，而新的记忆不再包含它。
- **隐私默认本地**：资料默认存本机；仅在主动发起 AI 操作时，相关上下文才会发送给所选模型服务商。首启需同意用户协议。

### 各页面

| 页面 | 作用 |
|------|------|
| 新的一天 | 今日待办聚合 + 一句话智能入口 |
| 工作记录 | 记录 CRUD、事项管理、AI 候选确认、已过滤留痕 |
| 工作问答 | 基于工作记忆的问答，附「依据」 |
| 报告 | 日报 / 周报生成与历史快照 |
| 工具箱 | 会议纪要（含待办提取）、邮件起草与润色 / 翻译 / 摘要 |
| 工作知识库 | 本地文档解析入库，预算内全量注入 |
| AI 的世界 | 查看工作记忆组成与被裁剪内容及原因 |
| 工作设置 | 工作画像、提醒等设置 |

> 工作知识库与 1.0 / 2.0 知识库的实现差异，见下方「知识库对比（1.0 / 2.0 / 3.0）」。

## 渠道接入

应用内置微信渠道，同时支持**企业微信官方插件**和**飞书自建应用**两种扩展渠道。

### 企业微信（官方插件，推荐）

企业微信接入使用官方脚手架 `@wecom/wecom-openclaw-cli`，**无需 CorpID/Secret**，扫码即可完成接入。

#### 接入步骤

1. 进入「渠道接入」页，找到**企业微信（官方插件）**卡片
2. 点击「💼 企微扫码接入」，自动跳转到终端并运行官方安装向导
3. 向导会自动完成：安装插件 → 企业微信扫码 → 一键创建机器人
4. 机器人创建成功后**重启 OpenClaw**，前往企业微信即可开始对话

> 企微 CLI 通过 npx 运行，会自动检测便携 Node.js 环境。国内用户默认走 npmmirror 镜像加速。
> 安装过程中如遇问题，可在终端手动执行 `npx -y @wecom/wecom-openclaw-cli doctor` 诊断。

### 飞书（自建应用）

飞书为**插件驱动**渠道（与微信一致），除填写凭证外还需安装官方插件 `@openclaw/feishu`，界面已将这一步自动化。

#### 前置准备（飞书开放平台）

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**。
2. 在「凭证与基础信息」复制 **App ID**（`cli_xxx`）与 **App Secret**。
3. 添加应用能力 → **机器人**，并至少开通 `im:message` 相关权限。
4. 事件订阅的连接方式选 **长连接（WebSocket）**，订阅 `im.message.receive_v1`。
   - 长连接无需公网回调，`Encrypt Key` / `Verification Token` 可留空。
5. **发布应用**并等待管理员审核通过。

#### 在应用内接入

1. 进入「渠道接入」页，展开**飞书自建应用**，填写 App ID / App Secret，
   并按需设置私聊策略、群聊策略、是否需要 @机器人。
2. 点击保存。若飞书插件尚未安装，应用会自动执行安装
   （首次约 1-2 分钟，安装日志实时显示在「日志」页，前缀 `[feishu]`）。
3. 安装完成后**重启 OpenClaw**，飞书长连接会自动建立。

#### 首次私聊配对

私聊默认策略为 `pairing`：陌生人首次私聊会生成配对码，需要审批。
可点击飞书卡片的「前往终端配对审批」，或在终端页执行：

```bash
openclaw pairing list feishu              # 查看待审批的配对码
openclaw pairing approve feishu <配对码>  # 审批通过
```

> 群聊中默认需要 @机器人 才会响应，可在渠道卡片中关闭。

## 知识库对比（1.0 / 2.0 / 3.0）

三个版本各有一个叫「知识库」的模块，但它们是三套独立实现，只有名字相同。核心分歧在**检索方式**：1.0 走检索式（RAG），2.0 / 3.0 走注入式。

| | **1.0（master / release/1.0）** | **2.0（release/2.0）** | **3.0（release/3.0）** |
|---|---|---|---|
| 模块名 | Obsidian 知识库 | 商家知识库 | 工作知识库 |
| 数据源 | 用户的 Obsidian vault（`.md` 笔记） | 人工导入的商家资料 | 人工导入的工作资料 |
| 支持格式 | 仅 Markdown | docx / xlsx / pdf / url / text / markdown / faq | 同 2.0 |
| 存储 | 独立向量库 `data/config/.openclaw/obsidian/index.db` | 主库 `umi-claw.db` 的 `knowledge_items` 表 | 主库的 `knowledge` 表 |
| 原件位置 | 不动，留在 vault 原地 | 拷贝到 `data/projects/<id>/` | 拷贝到 `data/knowledge/` |
| 切块 | 按标题切块，800 字/块，每篇上限 50 块 | 不切块（整篇入库） | 不切块 |
| 向量化 | 有（OpenAI 兼容 / Cohere embedding） | 无（`knowledge_chunks` 表预留） | 无 |
| 检索 | 语义向量 topK + 多样性剪枝 | LIKE 关键词（中文友好） | 全量注入优先，超预算才退化为 LIKE |
| 消费方 | OpenClaw 模型调用 MCP 工具 | 应用内 ContextEngine → AI 顾问 / 内容中心 | 应用内 ContextEngine → 工作问答 / 工具箱 / 日报 |
| 隔离维度 | 单 vault，无多租户 | 按 `project_id` 隔离，跨商家访问一律 NOT_FOUND | 全局单库，无 project 维度 |
| 写入路径 | 模型可经 MCP `create_note` / `update_note` 写回笔记 | 仅人工显式导入，无自动写入 | 仅人工导入 |
| 扫描件 OCR | 无 | 有（显式触发 + 人工确认后入库 + 可中止） | 无 |
| 增量更新 | vault watcher + 写后 1.5s 去抖增量索引 | 按 `UNIQUE(project_id, source_path)` 重导入覆盖 | 按 `UNIQUE(source_path)` 重导入覆盖 |

### 1.0：检索式（RAG）

笔记按标题切块并向量化，注册为 `openclaw.json` 的 `mcp.servers.obsidian`，模型通过 `search_notes` / `read_note` / `list_notes` / `create_note` / `update_note` / `get_backlinks` / `get_outgoing_links` / `get_tags` 按需取片段。省 token 是核心卖点，代价是模型得先「想到要查」。它绑定 Obsidian 生态：只吃 `.md`，但会把 wikilink、标签、front matter 一并建索引（代码块不参与语义索引，`read_note` 仍可读全文）。

### 2.0：注入式 + 多租户

知识库是**一级能力**，不是商家大脑的子功能，存的是「商家事实知识」——套系单、价目表、话术、常见问答。定位上明确 *External Intelligence ≠ Merchant Knowledge*：热点雷达等外部情报**永不自动写入**，只有老板人工采纳的事实才进来，因此整条链路**没有任何自动写入路径**。每个方法显式接收 `projectId`，跨 Project 的 id 一律视同不存在，杜绝「换个商家还能看到别家资料」。另有扫描件 AI 识别兜底：显式触发、人工确认后才入库、可中止。

### 3.0：2.0 解析管线的裁剪版

复用 2.0 的解析管线（`documentParsers` / `urlParser` 两边逐字相同），数据源换成全局 `knowledge` 表——3.0 无 project 维度，去掉了 `project_id`、`knowledge_chunks` 预留表与 OCR 兜底，原件落 `data/knowledge/`。它不对外暴露 MCP 工具，只作为 Context Pack 的第 6 段被消费。

### 检索策略：两个相反的方向

- **1.0 不注入，让模型自己查**：知识库可以很大，靠向量检索按需取片段。
- **2.0 / 3.0 预算内全量注入**：2.0 是 business + knowledge ≤ 上下文窗口 60%，3.0 是第 2–6 段合计 ≤ 70%；超预算才退化为 LIKE 裁剪，被丢 / 被截的条目留痕可查。理由是顾问类问题（「客户嫌贵怎么回」）与文档标题（「套系价目表」）常无字面重合，LIKE 会漏掉最相关的资料；只有全量注入才验证得了「AI 认识这个商家」。

> 共同短板：2.0 / 3.0 的 LIKE 检索对语义改写无能为力。2.0 里预留的 `knowledge_chunks` 表，以及 1.0 已经跑通的切块 + embedding 管线，是二期升级 RAG 的现成起点。

## 知识库（Obsidian）— 1.0 线

把 Obsidian 笔记库接入模型：笔记按标题切块并向量化，存入本地 sqlite 向量库；
OpenClaw 通过 MCP 工具按需检索片段，不用把整个知识库塞进上下文。

- **向量库本地存储**：`data/config/.openclaw/obsidian/index.db`（node:sqlite，零原生依赖）
- **embedding 两种来源**：预设（复用模型配置里已填 key 的服务商：百炼/智谱/硅基流动/豆包/OpenAI/本地 Ollama）或自定义（直填 baseUrl/key，可接 Cohere 等）
- **增量索引**：全量重建支持 mtime+hash 跳过未变文件；MCP server 常驻 watcher 监听 vault 变更，笔记增删改 1.5s 内自动增量索引

### 使用步骤

1. 在「模型配置」为某服务商填好 API Key（或在知识库页用自定义 embedding 直填凭据）
2. 进入「知识库」页，选择 Obsidian Vault 目录
3. 选择 embedding 模型并点击「测试连通」
4. 点击「重建索引」（首次较慢，后续增量）
5. 打开「启用 Obsidian 集成」并保存配置
6. 重启 OpenClaw，模型即可调用知识库工具

### MCP 工具

启用后注入 `openclaw.json` 的 `mcp.servers.obsidian`，提供以下工具：

| 工具 | 说明 |
|------|------|
| `search_notes` | 语义检索笔记片段（支持自然语言 query、limit、tag 过滤） |
| `read_note` | 读取整篇笔记 |
| `list_notes` | 列出已索引笔记（可按文件夹 / 标签过滤） |
| `create_note` / `update_note` | 创建 / 更新笔记（写后自动增量索引） |
| `get_backlinks` / `get_outgoing_links` | 反向 / 正向 wikilink 查询 |
| `get_tags` | 全库标签统计 |

> 切换 embedding 模型后需重新「重建索引」，应用会检测到签名变化自动清掉旧向量库。
> 代码块内容不参与语义索引（避免污染切块），但 `read_note` 可读取全文。

## 联系作者

嘿嘿，我是小北，开源不易请点点 stars，谢谢！
如使用安装遇到问题，或者遇到无法处理的 bug 请邮箱联系作者哟！
邮箱：guzhengkai97@163.com

## License

MIT
