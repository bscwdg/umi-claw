# 🐟 Umi Claw

> OpenClaw 便携管理工具 —— 零配置启动，人人都能用上 AI 代理
>
> 一键下载 Node + OpenClaw，图形化配置大模型，开箱即用的智能代理助手

![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)

## ✨ 主要功能

| 功能 | 说明 |
|------|------|
| 🚀 **零配置启动** | 首次运行自动下载 Node + OpenClaw，无需任何安装步骤 |
| 🎨 **原生桌面体验** | 无边框自定义标题栏，系统托盘驻留，原生对话框 |
| ⚙️ **完整配置界面** | 图形化配置大模型提供商、API Key、技能管理 |
| 🤖 **中文技能支持** | 内置开箱即用的中文 AI 能力（天气、搜索、写作等） |
| 🔌 **多模型支持** | DeepSeek / Kimi / 通义千问 / OpenAI / 豆包 / 硅基流动等 |
| 📝 **实时日志** | 带过滤、导出功能的运行日志查看器 |
| 💼 **便携模式** | 所有配置、数据存于应用目录，拷贝即用 |
| 🇨🇳 **国内加速** | npm + GitHub 镜像自动切换，无需科学上网 |
| 🔄 **开机自启** | 可选系统开机自动启动，应用启动自动拉起服务 |
| ❓ **智能关闭** | 点击关闭可选择最小化到托盘 / 退出程序，支持记住选择 |

## 🛠️ 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | 30+ | 跨平台桌面端框架 |
| Vue 3 | 3.4 | 前端框架 |
| Vite | 5 | 构建工具 |
| Pinia | 2.1 | 状态管理 |
| TypeScript | 5.4 | 类型安全 |

## 📁 目录结构

`
umi-claw/
├── electron/
│   ├── main/
│   │   ├── index.ts          # 主进程入口 + IPC 处理
│   │   ├── clawManager.ts    # OpenClaw 进程管理
│   │   ├── configManager.ts  # 配置读写管理
│   │   ├── downloadManager.ts # 环境下载 + 自动更新
│   │   └── channelManager.ts # 渠道管理
│   └── preload/
│       └── index.ts          # Preload 桥接层
├── src/
│   ├── views/
│   │   ├── Dashboard.vue     # 控制台
│   │   ├── Config.vue        # 模型 + 全局配置
│   │   ├── Skills.vue        # 技能管理
│   │   ├── Logs.vue          # 运行日志
│   │   ├── Setup.vue         # 环境初始化
│   │   └── About.vue         # 关于
│   ├── stores/
│   │   ├── claw.ts           # OpenClaw 状态
│   │   └── config.ts         # 配置状态
│   ├── assets/style.css      # 全局样式
│   └── renderer/main.ts      # 渲染层入口
├── resources/
│   ├── tray.png              # 托盘图标
│   ├── icon.ico              # 应用图标（多尺寸）
│   └── umiIcon.svg           # 图标源文件
└── electron-builder.json5    # 打包配置
`

## 🚀 快速开始

### 开发模式

`ash
# 安装依赖
npm install

# 启动开发模式（热重载）
npm run dev
`

### 打包构建

`ash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# 全平台
npm run build:all
`

## ⚙️ 配置说明

### 全局配置 (config/app.json)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| ctiveProvider | string | deepseek | 当前激活的模型提供商 |
| providers | Array | - | 已配置的模型提供商列表 |
| port | number | 3213 | OpenClaw 服务端口 |
| utoStart | boolean | alse | 应用启动时自动拉起 OpenClaw 服务 |
| launchOnBoot | boolean | alse | 系统开机自动启动应用 |
| minimizeToTray | boolean | 	rue | 关闭窗口行为（由 closeAction 同步控制） |
| closeAction | string | sk | 窗口关闭方式：sk 每次询问 / 	ray 最小化托盘 / exit 退出程序 |
| useChineseMirror | boolean | 	rue | 下载时使用国内加速镜像 |
| logLevel | string | info | 日志级别 |
| language | string | zh-CN | 界面语言 |

### IPC 接口（渲染层 → 主进程）

`	ypescript
// 窗口控制
window.api.window.minimize() / maximize() / close()

// OpenClaw 控制
window.api.claw.start() / stop() / restart() / status() / openWeb()
window.api.claw.onLog(callback) / onStatusChange(callback)

// 配置
window.api.config.get() / save(config) / openDataDir()

// 环境
window.api.env.check() / init() / update() / checkLatest() / getInfo()

// 技能
window.api.skills.list() / install(id) / uninstall(id) / toggleSkillStatus(id, enabled)
`

## 💡 使用提示

1. **首次启动**：应用会自动检测并下载 Node + OpenClaw 运行环境，请耐心等待
2. **模型配置**：进入「配置」页，选择你的模型提供商并填入 API Key
3. **托盘图标**：点击关闭窗口默认最小化到托盘，右键图标可快速操作
4. **便携模式**：将整个应用目录拷贝到 U 盘或其他电脑，所有配置自动跟随
5. **记住选择**：关闭窗口时勾选「记住我的选择」，下次直接执行

## 🔧 开发说明

### 添加新的模型提供商

编辑 electron/main/modelConfig.ts，仿照现有配置格式添加即可。

### 添加新技能

技能管理目前依赖 OpenClaw 内置技能系统，通过 clawManager.ts 调用。

### 打包注意事项

打包后默认开启便携模式，所有配置和数据存储在应用目录下的 data/ 文件夹。

## 🤝 贡献

欢迎提交 Issue 和 PR！

## 📄 License

MIT