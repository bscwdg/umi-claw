# 🦞 Umi Claw

> 3.0「工作版」：AI 工作记忆 + 每日工作闭环（今日待办 / 工作记录 / 日报周报 / 工作问答 / 工具箱 / 到点提醒），同时保留 OpenClaw 便携管理能力 — 基于 Electron + Vue3 + Vite 开发
>
> 愿景：简单点，无需复杂安装即可让每个人享受 AI 带来的便利

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 项目特性

**3.0 工作版**

- ☀️ **新的一天** — 今日待办聚合（手动 / daily·weekly 例事 / AI 提取）+ 一句话智能入口
- 🗂 **工作记录** — 手动、AI 候选、勾完成联动三来源；候选确认后才成为事实，支持 LIKE 检索
- 📊 **日报 / 周报** — 事实确定性聚合 → AI 表达 → 编辑确认；生成快照不可变、可溯源
- 💬 **工作问答** — 基于工作记忆作答，答不出说明缺什么，每条回答可展开「依据」
- 🧰 **AI 工具箱** — 会议纪要（含待办提取）、邮件起草，以及润色 / 翻译 / 摘要 / 邮件润色
- 📚 **工作知识库** — 本地文档解析入库，预算内全量注入工作记忆
- ⏰ **到点提醒** — 待办到点本机通知必达；可选外发「草稿已就绪」短提示到渠道
- 🔍 **AI 的世界** — 查看 AI 看到的工作记忆组成，以及被裁剪的内容与原因

**OpenClaw 管理**

- 🚀 **零配置启动** — 首次运行自动下载所需运行时
- 🖥️ **原生桌面体验** — 自定义标题栏、系统托盘、原生弹窗
- ⚙️ **完整管理界面** — 图形化配置 OpenClaw、模型、技能
- 🧩 **内置中文技能** — 开箱即用的中文 AI 能力，支持远程同步更新
- 🤖 **多个模型服务商** — DeepSeek、Kimi、通义千问、OpenAI 等
- 🧙 **首启向导 + 用户协议** — 冷启动弹窗引导初始化，同意协议后方可使用
- 🔧 **Node 运行时管理** — 界面内查看 / 切换便携 Node.js 版本
- 📋 **实时日志监控** —— 带过滤、导出功能的日志查看器，日志文件：`data/logs/runtime-debug.log`
- 📩 **多渠道接入** — 内置微信，支持企业微信官方插件（扫码即接入）、飞书自建应用（长连接，界面一键装插件）
- 📚 **Obsidian 知识库** — 笔记向量化语义检索，以 MCP 工具喂给模型，按需取片段省 token
- 💾 **便携模式** — 可放置在 U 盘，数据随身带走
- 🌐 **国内镜像加速** — npmmirror + GitHub 代理，无需翻墙

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
| mammoth / exceljs / docx / pdfjs-dist | — | Word / Excel / PDF 文档解析与生成 |
| @vueuse/core | 10 | Vue 组合式工具库 |

## 3.0 工作版

3.0 在 OpenClaw 管理能力之上，新增面向日常办公的「AI 工作记忆 + 每日工作闭环」。

- **工作记忆（Context Pack）**：把工作画像、事项、今日待办、近期已确认记录、工作知识库、历史对话按固定优先级组装成上下文；超预算时从后往前裁剪，被裁剪内容在「AI 的世界」留痕可见。
- **事实与表达分离**：工作记录只有在用户确认后才成为事实；日报由确定性规则聚合事实，再交给 AI 组织表达。日报错了改表达，事实错了改记录。
- **每日闭环**：早上在「新的一天」看待办 → 随手记工作记录 / 用工具箱处理纪要邮件 → 候选一键确认 → 傍晚生成日报、复制发出。
- **可追溯快照**：每次生成日报都把当时的输入与工作记忆作为不可变副本存下；删除记录后，历史报告仍完整，而新的记忆不再包含它。
- **隐私默认本地**：资料默认存本机；仅在主动发起 AI 操作时，相关上下文才会发送给所选模型服务商。首启需同意用户协议。

## 目录结构

```
umi-claw/
├── electron/
│   ├── main/
│   │   ├── index.ts              # 主进程入口 / 窗口 / 托盘
│   │   ├── clawManager.ts        # OpenClaw 进程管理
│   │   ├── configManager.ts      # 配置读写管理
│   │   ├── downloadManager.ts    # 环境下载安装（含 Node 版本管理）
│   │   ├── channelManager.ts     # 渠道（微信等）安装与管理
│   │   ├── channelCatalog.ts     # 渠道目录 / 元信息
│   │   ├── modelConfig.ts        # 模型预设键位/命名避让（预设数据已外置）
│   │   ├── modelPresets.ts       # 预设加载/校验/「拉取最新」（上游：Gitee awesome-llm-models，快照在 resources/model-presets/）
│   │   ├── gatewayClient.ts      # 网关 HTTP 客户端（token 仅留在主进程）
│   │   ├── openClawPaths.ts      # OpenClaw 路径解析（安装版/便携版）
│   │   ├── skillSyncService.ts   # 技能远程同步更新
│   │   ├── subprocessRegistry.ts # 子进程登记 / 统一清理
│   │   ├── ipc/                  # IPC handler 分组注册
│   │   │   ├── index.ts          # 汇总注册
│   │   │   ├── gateway.ts        # 窗口/进程/配置/环境/技能等管理侧
│   │   │   └── work.ts           # 3.0 工作版域
│   │   ├── obsidian/             # Obsidian 知识库管理
│   │   │   ├── obsidianManager.ts    # 配置/索引/检索测试/MCP 配置生成
│   │   │   └── types.ts              # 类型定义
│   │   ├── database/             # 3.0 数据层：schema / Worker 通信 / 迁移 / 错误码
│   │   │   ├── database.ts       # DB 句柄 / Worker 通信
│   │   │   ├── schema.ts         # 表结构
│   │   │   ├── migration.ts      # 迁移
│   │   │   └── errors.ts         # 错误码
│   │   └── work/                 # 3.0 工作版域
│   │       ├── contextEngine.ts  # Context Pack 组装 / 预算裁剪
│   │       ├── contextManager.ts # 上下文快照
│   │       ├── factAggregator.ts # 事实确定性聚合
│   │       ├── profileManager.ts # 工作画像
│   │       ├── matterManager.ts  # 事项
│   │       ├── todoManager.ts    # 待办（含 daily/weekly 例事、AI 候选）
│   │       ├── recordManager.ts  # 工作记录（候选确认、LIKE 检索）
│   │       ├── todayManager.ts   # 新的一天聚合
│   │       ├── routerManager.ts  # 一句话智能入口路由
│   │       ├── qaManager.ts      # 工作问答
│   │       ├── reportManager.ts  # 日报/周报 + 不可变快照
│   │       ├── toolManager.ts    # AI 工具箱
│   │       ├── knowledgeManager.ts   # 工作知识库
│   │       ├── wizardManager.ts  # 首启向导 / 用户协议
│   │       ├── reminderManager.ts    # 到点提醒 / 外发推送
│   │       └── parsers/           # 工作知识库文档解析
│   │           ├── documentParsers.ts # Word/Excel/PDF/TXT
│   │           ├── pdfjsAssets.ts     # 打包态 pdfjs 资源定位
│   │           └── urlParser.ts       # URL 解析
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
│   │   ├── work/              # 3.0 工作版页面
│   │   │   ├── TodayPage.vue       # 新的一天
│   │   │   ├── RecordsPage.vue     # 工作记录
│   │   │   ├── QaPage.vue          # 工作问答
│   │   │   ├── ReportsPage.vue     # 报告
│   │   │   ├── ToolsPage.vue       # 工具箱
│   │   │   ├── KnowledgePage.vue   # 工作知识库
│   │   │   ├── ContextPage.vue     # AI 的世界
│   │   │   └── SettingsPage.vue    # 工作设置
│   │   └── components/        # 通用组件
│   │       ├── ConfirmDialog.vue       # 确认对话框（关闭确认等）
│   │       ├── ModelPickerModal.vue    # 模型选择弹窗
│   │       ├── UserAgreementModal.vue  # 用户协议弹窗
│   │       └── WizardModal.vue         # 首启向导弹窗
│   ├── types/
│   │   └── terminal.ts        # 终端运行时类型（TerminalRuntime）
│   ├── stores/
│   │   ├── claw.ts            # OpenClaw 状态
│   │   └── config.ts          # 配置状态
│   ├── composables/
│   │   └── useToast.ts        # 全局提示
│   ├── theme/
│   │   └── themes.ts          # 主题系统
│   ├── assets/style.css       # 全局样式
│   ├── App.vue                # 根组件（标题栏+侧边栏+关闭确认）
│   └── renderer/
│       ├── main.ts            # Vue 入口 / 路由
│       └── index.html         # 渲染进程 HTML
├── resources/                 # 应用资源（打包为 extraResources）
│   ├── icon.ico / tray.png    # 应用 / 托盘图标
│   ├── umiIcon.svg
│   ├── database/              # 3.0 数据层 Worker
│   │   ├── db-worker.mjs      # Worker 子进程（sqlite 操作）
│   │   └── read-old-db.mjs    # 旧库读取（迁移用）
│   ├── model-presets/         # 模型预设内置快照
│   ├── pdfjs/                 # pdfjs 资源（cmaps / standard_fonts / build）
│   └── obsidian/              # 知识库子进程脚本（零依赖，绿色 node 拉起）
│       ├── indexer.mjs        # 索引器：扫描 vault、切块、embedding、写向量库
│       ├── mcp-server.mjs     # MCP server（stdio JSON-RPC），OpenClaw 拉起
│       ├── db.mjs             # sqlite 向量库封装（node:sqlite）
│       ├── embeddings.mjs     # embedding API 适配（OpenAI 兼容 / Cohere）
│       ├── markdown.mjs       # front matter / 切块 / 标签 / wikilink 解析
│       └── search.mjs         # 检索测试脚本（与 search_notes 同链路）
├── electron.vite.config.ts
├── build/
│   └── installer.nsh           # NSIS 钩子：升级时自动搬迁旧版数据目录
├── scripts/
│   └── run-all-accept.mjs      # 一键跑全部验收
├── test/                       # 验收：11 套 accept + 一天 e2e + 打包态 smoke
│   ├── _lib.mjs                # 验收公共库
│   ├── _ui.mjs                 # UI 验收公共库
│   └── fixtures/               # 验收夹具
├── CLAUDE.md / PLAN-3.0.md    # Agent 开发指引 / 3.0 规划
├── run-shared.bat             # 共享运行脚本
└── package.json
```

## 分支说明

| 分支 | 用途 |
|------|------|
| `master` | 稳定主分支（默认分支），只接收经过验证的发布内容，PR 的默认目标 |
| `release/1.0` | 1.0 版本开发分支，日常开发在此进行，包含最新特性（Obsidian 知识库、企微官方插件、便携模式等），功能稳定后合入 `master` |
| `release/2.0` | 2.0 版本分支：AI 助手能力与验收体系，3.0 的移植来源 |
| `release/3.0` | 3.0「工作版」开发分支：AI 工作记忆 + 每日工作闭环，即当前版本 |

> 想体验最新工作版请切换到 `release/3.0`：`git checkout release/3.0`

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

# 一键跑全部验收（11 套 accept + e2e）
npm run accept
```

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

主进程通过 `window.api` 暴露给渲染进程：

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
window.api.env.getNodeVersions()      // 查看可用/当前便携 Node 版本
window.api.env.updateNode(opts)       // 切换 / 更新 Node 版本
window.api.env.onProgress(cb)         // 监听下载 / 安装进度

// ── 技能管理 ──
window.api.skills.list()              // 可用技能列表
window.api.skills.install(id)         // 安装技能
window.api.skills.uninstall(id)       // 卸载技能
window.api.skills.getInstalledSkills()          // 已安装技能
window.api.skills.toggleSkillStatus(id, enabled)// 启用 / 停用技能
window.api.skills.importSkillZip()    // 从 zip 导入技能
window.api.skills.syncFromRemote()    // 从远程检查技能更新
window.api.skills.getPendingUpdates() // 待更新技能列表
window.api.skills.applyUpdates(ids)   // 应用更新

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
window.api.shell.openExternal(url)    // 用系统默认浏览器打开链接
window.api.app.getVersion()           // 应用版本号
window.api.dialog.showMessage(opts)   // 弹出系统原生消息框

// ── 3.0 工作版（work 域）──
// 硬规则：渲染端不持有 GATEWAY_TOKEN、不直连网关，一律 IPC → Manager → Gateway。
// 流式事件统一 work:stream:{chunk,done,error}，按 runId 归并：
window.api.work.stream.onChunk(cb)    // 流式增量 { runId, index, delta }
window.api.work.stream.onDone(cb)     // 完成 { runId, chunks, text, aborted }
window.api.work.stream.onError(cb)    // 出错 { runId, error }
window.api.work.stream.removeAll()    // 移除全部流式监听

window.api.work.gateway.status()            // 网关就绪状态
window.api.work.gateway.ensureReady()       // 确保网关可用（必要时拉起）
window.api.work.profile.get() / .update(input)                 // 工作画像
window.api.work.matters.list(params) / .create / .update / .delete
window.api.work.matters.suggestMatter(recordText)              // 从记录 AI 推荐归属事项
window.api.work.todos.list(params) / .create / .update / .delete
window.api.work.todos.complete(id) / .uncomplete(id)           // 完成 / 取消完成
window.api.work.todos.confirm(id) / .ignore(id)                // 确认 / 忽略 AI 候选
window.api.work.todos.confirmBatch(ids) / .ignoreBatch(ids)    // 批量处理候选
window.api.work.records.list(params) / .get(id) / .create / .update / .delete
window.api.work.records.confirm(id, patch?) / .ignore(id)      // 候选确认后才成事实
window.api.work.records.restore(id)                            // 恢复已删除记录
window.api.work.records.confirmBatch(ids) / .ignoreBatch(ids)
window.api.work.records.listFiltered(params)                   // LIKE 检索
window.api.work.records.proposeCandidate(input)                // AI 提取候选
window.api.work.context.snapshot({ scope, id? })               // 「AI 的世界」记忆快照
window.api.work.today.get(date?)                               // 新的一天聚合
window.api.work.router.route(input)                             // 一句话智能入口路由
window.api.work.reports.list(params) / .get(id)
window.api.work.reports.aggregate({ type, period? })           // 确定性事实聚合
window.api.work.reports.generate({ type, period? })             // AI 表达（流式）
window.api.work.reports.abortGenerate(runId)
window.api.work.reports.saveDraft(id, content)                 // 编辑保存
window.api.work.reports.confirm(id) / .regenerate(id)
window.api.work.reports.versions(id)                           // 不可变快照版本
window.api.work.qa.ask({ question, conversationKey? })         // 工作问答（流式）
window.api.work.qa.abortAsk(runId)
window.api.work.tools.list()                                   // 工具箱能力列表
window.api.work.tools.run({ toolId, text, conversationKey?, instruction? })
window.api.work.tools.abortRun(runId)
window.api.work.knowledge.list(params) / .get(id) / .create / .update / .delete
window.api.work.knowledge.search(query, limit?)                 // 工作知识库检索
window.api.work.knowledge.import(input)                        // 解析文档入库
window.api.work.knowledge.pickFile(expectedType?)              // 系统对话框选文件
window.api.work.wizard.status()                                // 首启向导状态
window.api.work.wizard.grantConsent() / .revokeConsent() / .ensureConsent()
window.api.work.wizard.complete() / .decide(decision) / .readMapping()
window.api.work.reminder.isEnabled('morning'|'report')         // 提醒开关
window.api.work.reminder.setEnabled(id, enabled)
window.api.work.reminder.getTimes() / .setTime(id, hour, minute)
window.api.work.reminder.getPushConfig() / .setPushConfig(patch) // 外发推送配置
window.api.work.reminder.availablePushChannels()               // 可用推送渠道
window.api.work.reminder.availablePushTargets(channel)         // 渠道下可选目标
window.api.work.reminder.testPush() / .getPushStatus() / .check()
```

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

## 知识库（Obsidian）

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

## 便携模式

便携模式的完整说明（数据目录、U 盘使用、升级与数据搬迁）见上文 [便携模式（U 盘使用）](#便携模式u-盘使用)。

简而言之：将构建产物解压到任意目录（包括 U 盘），在 exe 同级创建 `data` 文件夹即进入便携模式，所有配置和运行时均存储在该目录中，删除即可完全卸载。

## 联系作者
嘿嘿，我是小北，开源不易请点点stars，谢谢！
如使用安装遇到问题，或者遇到无法处理的bug请邮箱联系作者哟！
邮箱：guzhengkai97@163.com

## License

MIT
