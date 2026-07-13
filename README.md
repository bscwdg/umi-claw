# 🦞 Umi Claw

> OpenClaw 便携管理工具（愿景：简单点，无需复杂安装操作让每个人都能享受ai带来的便利） — 基于 Electron + Vue3 + Vite 开发

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 项目特性

- 🚀 **零配置启动** — 首次运行自动下载所需运行时
- 🖥️ **原生桌面体验** — 自定义标题栏、系统托盘、原生弹窗
- ⚙️ **完整管理界面** — 图形化配置 OpenClaw、模型、技能
- 🧩 **内置中文技能** — 开箱即用的中文 AI 能力
- 🤖 **多个个模型服务商** — DeepSeek、Kimi、通义千问、OpenAI 等
- 📋 **实时日志监控** —— 带过滤、导出功能的日志查看器，日志文件：`data/logs/runtime-debug.log`
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

## 目录结构

```
umi-claw/
├── electron/
│   ├── main/
│   │   ├── index.ts          # 主进程入口
│   │   ├── clawManager.ts    # OpenClaw 进程管理
│   │   ├── configManager.ts  # 配置读写管理
│   │   └── downloadManager.ts# 环境下载安装
│   └── preload/
│       └── index.ts          # Preload / IPC 桥接
├── src/
│   ├── views/
│   │   ├── Dashboard.vue     # 控制台
│   │   ├── Config.vue        # 模型配置
│   │   ├── Skills.vue        # 技能管理
│   │   ├── Logs.vue          # 运行日志
│   │   ├── Setup.vue         # 环境初始化
│   │   └── About.vue         # 关于
│   ├── stores/
│   │   ├── claw.ts           # OpenClaw 状态
│   │   └── config.ts         # 配置状态
│   ├── assets/style.css      # 全局样式
│   ├── App.vue               # 根组件（标题栏+侧边栏）
│   └── main.ts               # Vue 入口
├── resources/                # 应用图标等静态资源
├── electron.vite.config.ts
├── electron-builder.json5
└── package.json
```

## 快速开始

### 环境要求

- Node.js 18+
- npm / pnpm / yarn

### 本地开发

```bash
# 克隆项目
git clone <repo-url>
cd umi-claw

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev
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

## IPC API 设计

主进程通过 `window.api` 暴露给渲染进程：

```typescript
window.api.claw.start()           // 启动 OpenClaw
window.api.claw.stop()            // 停止
window.api.claw.status()          // 获取状态
window.api.claw.onLog(cb)         // 监听实时日志
window.api.claw.onStatusChange(cb)// 监听状态变化

window.api.config.get()           // 读取配置
window.api.config.save(cfg)       // 保存配置
window.api.config.reset()         // 恢复默认配置
window.api.config.getDataDir()    // 获取数据目录路径
window.api.config.openDataDir()   // 打开数据目录

// 主要配置字段示例（config.save 时可传入）：
// {
//   autoStart: boolean,        // 应用启动时自动拉起 OpenClaw
//   launchOnBoot: boolean,     // 系统开机自动启动应用
//   closeAction: string,       // 关闭行为: 'ask' | 'tray' | 'exit'
//   minimizeToTray: boolean,   // 是否已启用托盘模式
//   useChineseMirror: boolean, // 使用国内镜像加速
//   providers: [...],          // 模型服务商配置
//   port: 3213,               // 服务端口
// }       // 保存配置

window.api.env.check()            // 检测环境
window.api.env.init(opts)         // 初始化环境
window.api.env.onProgress(cb)     // 监听下载进度

window.api.skills.list()          // 技能列表
window.api.skills.install(id)     // 安装技能
window.api.skills.uninstall(id)   // 卸载技能

window.api.log.getLogs()          // 获取日志列表
window.api.log.clearLogs()        // 清空日志文件
// 日志文件永久存储在 data/logs/runtime-debug.log
// 包含主进程日志 + OpenClaw 子进程 stdout/stderr   // 卸载技能
```

## 便携模式

将构建产物解压到任意目录（包括 U 盘）。程序会优先检测 `exe同级/data/` 目录，若存在则使用便携模式，所有配置和运行时均存储在该目录中，删除即可完全卸载。

## 联系作者
嘿嘿，我是小北，开源不易请点点stars，谢谢！
如使用安装遇到问题，或者遇到无法处理的bug请邮箱联系作者哟！
邮箱：guzhengkai97@163.com

## License

MIT
