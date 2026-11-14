# 🦞 Umi Claw

> OpenClaw 便携管理工具 + AI 工作台 —— 全版本总览
>
> 愿景：简单点，无需复杂安装操作，让每个人都能享受 AI 带来的便利

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest](https://img.shields.io/badge/latest-v5.0.0-brightgreen)](https://github.com/bscwdg/umi-claw/tree/release/5.0)

> **最新发布：5.0（GA `v5.0.0`，分支 `release/5.0`）** —— 在 4.x 插件化宿主上开放受控第三方插件（Ed25519 签名 / TOFU / `utilityProcess` 隔离）。
>
> `master` 是 **1.0 通用版**稳定线（默认分支），**不代表最新功能**；各版本功能以所在分支的 README 为准。想直接体验最新能力请切到 `release/5.0`。
>
> 本页信息截至 2026-11-14；版本号、分支与验收数字以各分支最新提交为准。

## 五条版本线：先选对分支

Umi Claw 有 5 条并行版本线，都从 1.0 的 OpenClaw 管理能力分叉，各自独立演进：

| 版本 | 分支 | 面向谁 | 在通用能力之上新增 |
|------|------|--------|-------------------|
| **1.0** 通用版 | `master` / `release/1.0` | 想用 OpenClaw 的个人 | 模型 / 技能 / 渠道 / Obsidian / 终端等管理能力；`release/1.0` 额外含鱼语音（火山 TTS / 音色克隆 / 预算） |
| **2.0** AI 营销版 | `release/2.0` | 实体店老板、线上获客 | AI 营销工作台：商家大脑 → 知识库 → AI 顾问 → 内容中心 → 热点雷达 |
| **3.0** 工作版 | `release/3.0` | 日常办公的打工人 | AI 工作记忆 + 每日工作闭环：今日待办 / 工作记录 / 日报周报 / 工作问答 / 工具箱 / 到点提醒 |
| **4.x** 插件化宿主 | `release/4.0` | 想一站式用营销 + 工作 + 大肥鱼的人 | 插件化宿主 + 控制台/能力中心 + 官方内置插件 + 大肥鱼角色（维护线；最新发布 tag `v4.1.0`） |
| **5.0** 受控第三方插件 | `release/5.0` | 想安装签名第三方插件的人 / 插件开发者 | Ed25519 签名 + TOFU + `utilityProcess` 隔离安装 / 更新 / 回滚；插件配置、审计、吊销与 kill switch |

> 2.0 与 3.0 是两条**独立**的产品线，互不包含：3.0 基于 1.0 分叉，不带 2.0 的营销模块；2.0 也不带 3.0 的工作记忆模块。4.x 是合并后的插件化线，把 2.0 / 3.0 作为官方内置插件集成；5.0 在 4.x 之上开放**受控**第三方插件，4.x 仍不提供第三方安装入口。

## 最新发布：5.0 受控第三方插件

5.0 的目标是「在插件化宿主上安全地装第三方能力」，而不是开放一个任意代码入口：

- **包格式**：`.umi-plugin`（zip：`plugin.json` + `main.js` + `SIGNATURE`，可选 `migrations/`、`icon.png`、`README.md`）。
- **签名与信任**：Ed25519 签名；`SIGNATURE` 对文件集做 canonical 哈希；支持 official / partner / self 三档信任。
- **自签 TOFU**：自签包**首次安装**展示指纹并要求显式勾选确认；同 keyId 换指纹或换 keyId 会被拒绝，已信任后的更新不再重复确认。
- **安装 / 更新 / 回滚 / 卸载**：验签 → 安全解包 → `<dataDir>/plugin-packages/<id>/<version>` → 数据快照 → 安装态；更新保留 previous，回滚恢复版本与数据；卸载可选保留数据。
- **隔离运行**：第三方默认跑在 Electron `utilityProcess`，用 `NODE_OPTIONS` 文件权限 + 显式 env 白名单限制 `fs` / 子进程；服务调用经 broker 按 manifest 权限授权，默认拒绝，设置页可授权 / 撤销。
- **配置**：manifest `configSchema` 在设置页渲染并原子写入 `<dataDir>/plugin-data/<id>/config.json`；宿主校验类型 / 枚举 / 大小 / 深度。
- **运维**：安装 / 更新 / 回滚 / 卸载审计 JSONL、诊断、备份保留 5 份、吊销列表与 kill switch。
- **插件开发**：从 `templates/plugin/` 起步，SDK 在 `plugin-sdk/`，打包 / 签名 / 验签 CLI 为 `scripts/umi-plugin.mjs`（keygen / pack / verify）。
- **已知限制**：数据目录或 Windows 用户名含空格时无法注入 `NODE_OPTIONS`，会显式拒绝启动；官方 / 伙伴根密钥由发布流水线注入，开源仓库默认只支持 self-TOFU；第三方 UI 隔离与在线市场属 Phase 3。

**相关文档**（以下文件在 `release/5.0` 分支）：[5.0 README](https://github.com/bscwdg/umi-claw/blob/release/5.0/README.md) · [扩展性规划](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/PLAN-5.0-EXTENSIBILITY.md) · [插件 API](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/PLUGIN-API.md) · [更新日志](https://github.com/bscwdg/umi-claw/blob/release/5.0/CHANGELOG.md)

## 4.x 插件化宿主 + 大肥鱼

4.x 在合并后的单体上做插件化：宿主提供窗口、导航、设置、OpenClaw 管理、渠道、终端、Obsidian 等壳能力；2.0 营销域、3.0 工作域装箱为官方内置插件，运行期可启停。`release/4.0` 为维护线：最新发布 tag 为 `v4.1.0`，分支 `package.json` 已到 4.2.0；下面标注 4.3 / 4.4 的能力已合入分支但**尚未发布**。

### 插件化宿主

- **控制台（`/dashboard`）**：网关状态、启动阶段与 ETA、Token、日志、快速入口。
- **能力中心（`/skills`）**：插件列表、启用 / 禁用、懒加载；插件可注册独立路由 / 导航 / IPC / 插槽与数据迁移。
- **官方内置插件**：marketing（营销工作台）、work（工作版）；插件源码随宿主构建，`resources/plugins/` 只放 manifest 与 migrations。
- **宿主服务**：db / gateway / knowledge / context / voice 由宿主提供，插件通过 `ctx` 使用；配置与密钥不交给插件。
- **插件契约**：插件能力统一经 `ctx` 注入；插件失效不影响宿主启动。

规划与边界见 [PLAN-4.0.md](https://github.com/bscwdg/umi-claw/blob/release/4.0/PLAN-4.0.md)。

### 大肥鱼角色（默认关闭）

> 📖 [大肥鱼使用指南](https://github.com/bscwdg/umi-claw/blob/release/4.0/doc/%E5%A4%A7%E8%82%A5%E9%B1%BC-%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md) —— 启用 / 首启三问 / 日常使用 / 配置依赖 / FAQ。
>
> 📚 [GitHub 资料库调研](doc/大肥鱼-GitHub资料库调研.md) —— 看过哪些人格 / 表情包 / 语料 / 评测仓库、许可证、实际采用情况。

在宿主内养一只「有形象、会聊天、记得住、有自己的生活、每天写日记」的大肥鱼：

- **形象**：透明置顶桌宠窗口（暂下线，M2 恢复；当前可导入自定义形象做预览）+ 六态原创 SVG + 气泡。
- **聊天**：流式气泡、表情映射、会话代际清空；每轮注入【本鱼状态】（称呼 / 阶段 / 心情 / 今日活动）。
- **关系**：三轴（熟悉 / 亲密 / 连续天数）、阶段只升不降、每日上限、`refId` 幂等、解锁提示。
- **生活与主动（4.4，未发布）**：生活卡确定性抽取 → `fish/LIFE.md`；30s tick 按静默期 / 免打扰 / 日上限发主动消息。支持固定 / 随机间隔（1–720 分钟）与每日上限最高 60；每轮从生活卡 + 话题 + 台词中选候选，去重 / 冷却后交给 `feiyu` agent 生成文案，失败回退规则候选；未回复按关系轻试探，2 条未回换话题、≥3 条进入退避。
- **表情包（4.4，未发布）**：导入 PNG / JPEG / GIF / WebP（≤10MB、最多 200 张、sha256 去重），按情绪 / 标签管理；QQ 发图走 `file_type=1` + `msg_type=7`。
- **备份（4.4，未发布）**：角色页导出 / 导入单个 zip（设置 / 状态 / 关系 / 解锁 / 桌宠状态、人格文件、workspace 日记、表情包），不含密钥 / token / 截图 / 日志。
- **记忆**：确认年龄后 23:00 自动写日记（workspace + Obsidian `大肥鱼/日记`），失败重试、密钥脱敏；tags 归一化。
- **语音**：TTS 出 16k PCM → SILK → QQ 语音条（失败降级文字，`silk-wasm` 已内置）；外部 TTS 支持 OpenAI 兼容 `/v1/audio/speech` 与 Voicebox 原生 `17493`；入站 STT 暂未接 QQ。
- **多渠道聊天（4.3，未发布）**：角色页可勾选已配置的外部渠道，把策略放行的单账号会话（含群聊）路由给大肥鱼（文本）；经官方 CLI 写 OpenClaw bindings，保存后需重启网关。
- **安全隐私**：危机词转求助资源；AI 明示；未确认年龄不主动；导出不含密钥；删除分层且日记归档。

> 默认关闭：在「大肥鱼」页手动启用；停用后侧栏入口隐藏，仍可从「插件管理 → 宿主模块」重新启用。

## 3.0 工作版

3.0 在 OpenClaw 管理能力之上，新增面向日常办公的「AI 工作记忆 + 每日工作闭环」。

- **工作记忆（Context Pack）**：把工作画像、事项、今日待办、近期已确认记录、工作知识库、历史对话按固定优先级组装成上下文；超预算时从后往前裁剪，被裁剪内容在「AI 的世界」留痕可见。
- **事实与表达分离**：工作记录只有在用户确认后才成为事实；日报由确定性规则聚合事实，再交给 AI 组织表达。日报错了改表达，事实错了改记录。
- **每日闭环**：早上在「新的一天」看待办 → 随手记工作记录 / 用工具箱处理纪要邮件 → 候选一键确认 → 傍晚生成日报、复制发出。
- **可追溯快照**：每次生成日报都把当时的输入与工作记忆作为不可变副本存下；删除记录后，历史报告仍完整，而新的记忆不再包含它。
- **隐私默认本地**：资料默认存本机；仅在主动发起 AI 操作时，相关上下文才会发送给所选模型服务商。首启需同意用户协议。

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

> `release/3.0` 为独立工作版；4.x / 5.0 中该域作为官方内置插件 `work` 集成，数据与交互保持一致。

## 2.0 AI 营销工作台

2.0 在 OpenClaw 管理器之上新增面向实体店老板的 AI 营销工作台，覆盖线上获客动线：**建档 → 喂资料 → 提问 → 写文案 → 追热点**。所有 AI 产出都经人工审核、人工复制发布，应用不自动外发。

- 🏪 **AI 营销工作台** — 商家建模 → 知识库 → AI 顾问 → 内容生成 → 热点雷达。
- 🧠 **商家大脑** — 品牌 / 定位 / 客群 / 语气档案建模，资料完整度提示；关注词只喂 AI、不触发采集。
- 📄 **多格式知识库** — Word / Excel / PDF / 网址 / 纯文本本地解析入库，扫描件可 AI 识别兜底。
- 💬 **AI 顾问** — 基于本商家资料的流式问答，引用商家事实、不编造。
- ✍️ **内容中心** — 一次生成 3 版候选，版本与提示词快照可追溯，草稿到发布的人工审核流。
- 🔥 **热点雷达** — 头条 / B 站等公开榜单多源采集，AI 相关性评分、四档分组与「今日建议」。
- 🎬 **平台工作流** — 内置小红书、抖音平台规则模板，问答与生成时自动注入。

**明确不做**：不自动发布、不自动回复；不做矩阵 / 多账号、不做视频成片；不登录、不带 Cookie、不绕风控抓取。

> 4.x / 5.0 中该域作为官方内置插件 `marketing` 集成；详细设计见 [release/2.0 README](https://github.com/bscwdg/umi-claw/blob/release/2.0/README.md)。

## 1.0 通用版（OpenClaw 管理）

1.0 是所有版本线的底座，提供完整的 OpenClaw 桌面管理能力。`master` 是 1.0 的最小集；`release/1.0` 在 `master` 之上额外包含**鱼语音**，更细的文件级目录、IPC 逐方法签名与配置字段见 [release/1.0 README](https://github.com/bscwdg/umi-claw/blob/release/1.0/README.md)。

- 🚀 **零配置启动** — 首次运行自动下载所需运行时。
- 🖥️ **原生桌面体验** — 自定义标题栏、系统托盘、原生弹窗。
- ⚙️ **完整管理界面** — 图形化配置 OpenClaw、模型、技能。
- 🧩 **内置中文技能** — 开箱即用的中文 AI 能力，支持远端仓库同步更新（Gitee 勾选导入 / 版本检测）。
- 🤖 **多个模型服务商** — DeepSeek、Kimi、通义千问、OpenAI 等，模型预设可在线「拉取最新」。
- 🔧 **Node 运行时管理** — 界面内查看 / 切换便携 Node.js 版本。
- 📋 **实时日志监控** — 带过滤、导出功能的日志查看器，日志文件：`data/logs/runtime-debug.log`。
- 📩 **多渠道接入** — 内置微信，支持企业微信官方插件（扫码即接入）、飞书自建应用（长连接，界面一键装插件）、QQ 机器人（官方插件）。
- 📚 **Obsidian 知识库** — 笔记向量化语义检索，以 MCP 工具喂给模型，按需取片段省 token（见下文）。
- 💾 **便携模式** — 可放置在 U 盘，数据随身带走。
- 🌐 **国内镜像加速** — npmmirror + GitHub 代理，无需翻墙。
- ⚡ **启动可靠性** — 网关就绪态与启动阶段 / ETA；webhook 迁移标记兜底；可选「退出应用时保留网关」；网关日志文件 tail。
- 🎙 **鱼语音（仅 `release/1.0`）** — 火山 TTS、音色克隆、音色选择与预算用量；`master` 不含该模块。

### Obsidian 知识库（1.0）

把 Obsidian 笔记库接入模型：笔记按标题切块并向量化，存入本地 sqlite 向量库；OpenClaw 通过 MCP 工具按需检索片段，不用把整个知识库塞进上下文。

- **向量库本地存储**：`data/config/.openclaw/obsidian/index.db`（`node:sqlite`，零原生依赖）。
- **embedding 两种来源**：预设（复用已填 key 的服务商：百炼 / 智谱 / 硅基流动 / 豆包 / OpenAI / 本地 Ollama）或自定义（直填 baseUrl / key，可接 Cohere 等）。
- **增量索引**：全量重建支持 mtime + hash 跳过未变文件；MCP server 常驻 watcher，笔记增删改 1.5s 内自动增量索引。

使用步骤：配置 embedding 凭据 → 选择 vault → 测试连通 → 重建索引 → 启用集成并保存 → 重启 OpenClaw。

MCP 工具：`search_notes` / `read_note` / `list_notes` / `create_note` / `update_note` / `get_backlinks` / `get_outgoing_links` / `get_tags`。

> 切换 embedding 模型后需重新「重建索引」；代码块内容不参与语义索引，但 `read_note` 可读全文。

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
| mammoth / exceljs / docx / pdfjs-dist | — | Word / Excel / PDF 文档解析与生成 |
| adm-zip | — | `.umi-plugin` 安装包解包（5.0） |
| silk-wasm | — | 语音条 SILK 编码（4.x / 5.0） |

> 各分支的完整依赖以对应分支的 `package.json` 为准。

## 目录结构（以 5.0 为主干；2.0 / 3.0 的域目录在 4.x / 5.0 迁入 plugins/）

```
umi-claw/
├── electron/
│   ├── main/
│   │   ├── index.ts                 # 主进程入口（只做装配；窗口 / 托盘 / IPC）
│   │   ├── kernel/                  # 插件内核：manifest / registry / lifecycle / plugin / services / 隔离进程
│   │   ├── services/                # 宿主能力：pluginDb / pluginRuntime / pluginInstaller / pluginPermissions /
│   │   │                            #   gateway / knowledge / context / hostUi / consent / characterKv / …
│   │   ├── database/                # 数据层：schema / migration / db-worker 客户端
│   │   ├── ipc/                     # 宿主 IPC：host/ 放宿主通道；域通道在 plugins/<id>/main/ipc/
│   │   ├── character/               # 大肥鱼宿主模块（桌宠窗口 / 记忆 / 日记 / 主动消息 / 安全）
│   │   ├── fish/voice/              # 语音：TTS / SILK / 克隆 / 外部 TTS
│   │   ├── claw/                    # clawManager 拆出的纯模块（reclaim / doctor / migrations / …）
│   │   └── clawManager.ts / configManager.ts / downloadManager.ts / channelManager.ts / …
│   └── preload/index.ts             # window.api 桥（含 plugins / character 等命名空间）
├── plugins/                         # 官方内置插件（同仓源码，参与宿主构建）：work / marketing / hello / shared
├── plugin-sdk/                      # 插件 SDK：public / official-* / client* / testing
├── src/
│   ├── views/                       # 宿主页面（Dashboard / Config / Channels / Obsidian / Terminal / …）
│   ├── character/                   # 大肥鱼页面与桌宠窗口
│   ├── renderer/                    # main.ts / pluginUi.ts / *.generated.ts（入口表生成，禁止手改）
│   ├── stores/ / composables/ / theme/ / types/ / constants/
│   └── App.vue
├── resources/                       # 打包 extraResources：openclaw-plugins/feiyu-guard、character 内容包、
│                                    #   database/db-worker、pdfjs、plugins 清单与 migrations、voice…
├── test/                            # 验收：accept + e2e + 打包态 smoke（零 npm 依赖，打真源码）
├── scripts/                         # gen-plugin-entries / run-all-accept / check-boundaries / umi-plugin CLI …
├── templates/plugin/                # 插件模板（不进 plugins 扫描）
├── doc/                             # 计划、施工日志、运维手册、插件 API（各分支内容不同）
├── electron.vite.config.ts
└── package.json
```

**各分支目录差异**

- **1.0（`master` / `release/1.0`）**：只有 `electron/main/*.ts` + `src/views/*` + `resources/obsidian` / `model-presets`；没有插件内核。
- **2.0**：新增 `electron/main/marketing/`、`electron/main/database/`、`src/views/marketing/`、`resources/collector/`。
- **3.0**：新增 `electron/main/work/`、`electron/main/database/`、`src/views/work/`、`resources/database/`、`resources/pdfjs/`。
- **4.x / 5.0**：2.0 / 3.0 域搬进 `plugins/<id>/`（`domain/` + `ui/` + `main/`）；新增 `kernel/`、`services/`、`ipc/host/`、`character/`、`fish/voice/`、`claw/`、`src/character/`、`renderer/pluginUi.ts`、`resources/plugins/`、`resources/openclaw-plugins/`；**5.0** 再增加 `plugin-sdk/` 与签名 / 安装 / 隔离链路（`pluginPackage*`、`pluginInstaller`、`pluginIsolation*`、`scripts/umi-plugin.mjs`、`templates/plugin/`）。

> `master` 上只有 1.0 子集，README 其余章节描述的是对应分支的能力。

## 分支说明

| 分支 | 用途 |
|------|------|
| `master` | **1.0 通用版稳定线**，默认分支，PR 默认目标；只接收经过验证的发布内容 |
| `release/1.0` | 1.0 开发分支（鱼语音 / Obsidian / 企微官方插件 / 便携模式 / 技能同步等），稳定后合入 `master` |
| `release/2.0` | 2.0 AI 营销版（独立线） |
| `release/3.0` | 3.0 工作版（独立线） |
| `release/4.0` | 4.x 插件化宿主维护线（最新发布 tag `v4.1.0`，分支含未发布 4.2 / 4.3 / 4.4 增强），含大肥鱼与官方插件 |
| `release/5.0` | **当前发布分支**：5.0 受控第三方插件（GA `v5.0.0`） |

> 体验：1.0 → [`release/1.0`](https://github.com/bscwdg/umi-claw/tree/release/1.0) ｜ 2.0 → [`release/2.0`](https://github.com/bscwdg/umi-claw/tree/release/2.0) ｜ 3.0 → [`release/3.0`](https://github.com/bscwdg/umi-claw/tree/release/3.0) ｜ 4.x → [`release/4.0`](https://github.com/bscwdg/umi-claw/tree/release/4.0) ｜ 5.0 → [`release/5.0`](https://github.com/bscwdg/umi-claw/tree/release/5.0)
>
> 不同版本线需要不同代码时，建议用 `git worktree` 分别检出，避免频繁切分支。

## 快速开始

> 说明：当前仓库 GitHub Releases 暂未提供预编译安装包，以下为源码开发 / 构建流程；使用安装包的用户按既有版本升级即可。

### 环境要求

- Node.js 18+（仅用于构建 / 开发；运行时由应用下载并管理便携 Node）。
- npm / pnpm / yarn。
- 5.0 默认便携 Node v24.22.1（首次运行时下载），满足当前 OpenClaw 引擎要求（`>=24.22.1 <25 || >=26.12.1`）。

### 本地开发

```bash
# 克隆项目并切到想开发的分支
git clone https://github.com/bscwdg/umi-claw.git
cd umi-claw
git switch release/5.0     # 或 master / release/2.0 / release/3.0 / release/4.0

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 类型检查（4.x / 5.0）
npm run typecheck:node
npm run typecheck:web
# master / 1.0 使用 npm run typecheck

# 全量验收（3.0 / 4.x / 5.0；5.0 为 59 套 / 944 项（943 通过 + 1 显式跳过；GA 留档 942）+ node:test 21 条）
npm run accept
```

### 构建打包

```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
npm run build:all    # 所有平台（需在对应系统 / 容器内执行）
```

### 国内镜像打包（Windows PowerShell）

打包时 Electron 及 electron-builder 二进制需从 GitHub 下载，国内网络容易超时失败。可先设置 npmmirror 镜像和本地缓存目录再构建：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_BUILDER_CACHE="D:\work2026\umi-claw\electron-builder-cache"  # 缓存目录可按需改成自己的路径
npm run build:win
```

> 注意：解压 electron-builder 的 winCodeSign 缓存需要创建符号链接权限，请在**管理员 PowerShell**中运行，或先开启 Windows「开发人员模式」。普通权限终端打包会在 `Cannot create symbolic link` 处失败。

### 便携模式（U 盘使用）

正常安装版的数据放在 `%APPDATA%\UmiClaw`（与安装目录分离，更新 / 卸载不会动数据）。如果需要 U 盘携带：

1. 解压安装包或复制 `release\win-unpacked` 到 U 盘；
2. 在 exe 同级手动创建 `data` 文件夹（可从已初始化的环境拷贝）；
3. 启动后即进入便携模式：`data` 和 `context-data` 都跟随 exe，换机器数据完整。

便携模式下的更新**不走安装器**：替换程序文件即可（保留 `data` 和 `context-data`）。注意数据文件容易被 Excel / WPS 等程序占用，替换前先关闭相关程序。

> 安装器升级旧版本时（`build/installer.nsh`）会自动把旧安装目录里的 `data` / `context-data` 搬到 `%APPDATA%\UmiClaw`，老用户直接装新包即可。

## 数据与隐私

数据目录：开发环境为项目根 `data/`；安装版默认 `%APPDATA%\UmiClaw\data`；可设置 `CLAW_DATA_DIR` 或用 exe 同级 `data/` 进入便携模式。

| 对象 | 位置 / 方式 | 说明 |
|------|-------------|------|
| 应用与网关配置 | `<dataDir>/config/.openclaw/openclaw.json` | 单写入口；串行队列原子写，避免并发覆盖 |
| 日志 | `<dataDir>/logs/runtime-debug.log` | 主进程 + OpenClaw 子进程 stdout/stderr |
| 1.0 知识库 | `<dataDir>/config/.openclaw/obsidian/index.db` | 向量索引，原始笔记留在 vault |
| 2.0 数据 | `<dataDir>/umi-claw.db` + `<dataDir>/projects/<id>/` | SQLite（WAL，自动备份 5 份） |
| 3.0 数据 | `<dataDir>/work.db` + `<dataDir>/knowledge/` | 8 张表；图片 / 文档原件按目录存放 |
| 4.x / 5.0 插件数据 | `<dataDir>/plugins/<id>/data.db` | 每插件独立库 + 独立 schema / migrations |
| 5.0 安装包与配置 | `<dataDir>/plugin-packages/<id>/<version>/`、`plugin-data/<id>/config.json` | 安装记录、回滚 previous、configSchema 配置 |
| 5.0 信任与运维 | `plugin-trust.json`、`plugin-audit.log`、`plugin-index.json`、`plugin-revocations.json`、`plugin-kill-switch.json` | TOFU 指纹、审计、静态索引、吊销、安装开关 |
| 大肥鱼 | `<dataDir>/character/kv.json` 等 | 设置 / 状态 / 关系；表情包与桌宠形象另落子目录 |
| 密钥 | `safeStorage`，命名空间 `plugin:<id>:<key>` | 永不写日志 / 配置 / 导出包 |

**隐私原则**：本地优先；资料默认只存本机，仅在主动发起 AI 操作时把相关上下文发给所选模型服务商；网关 token 只留在主进程；3.0 起首启需同意用户协议，4.x / 5.0 的协议状态由宿主单源管理（`window.api.consent.*`）。

## IPC / API 设计

主进程通过 `window.api` 暴露给渲染进程。**2.0 起**的业务 IPC 使用统一信封 `{ ok: true, data }` / `{ ok: false, error: { code, message, details? } }`，渲染端**只按 `code` 分支**，不解析 `message`；错误码来源：2.0 / 3.0 为 `electron/main/database/errors.ts`，4.x / 5.0 为 `electron/main/services/errors.ts`。1.0（`master` / `release/1.0`）的宿主 IPC 直接返回原始值，没有信封。

### 通用能力（所有版本）

```typescript
// 窗口 / 进程 / 配置 / 环境 / 技能 / 日志 / 终端 / 渠道 / Obsidian / 系统
window.api.window.*        // minimize / maximize / close / onCloseRequest / resolveClose / cancelClose
window.api.claw.*          // start / stop / restart / status / waitReady / openWeb / getToken / onLog / onStatusChange
window.api.config.*        // get / save / reset / getDataDir / openDataDir / getPresetModels / refreshModelPresets / testConnection
window.api.env.*           // check / init / update / checkLatest / getInfo / getNodeVersions / updateNode / onProgress
window.api.skills.*        // list / install / uninstall / getInstalledSkills / toggleSkillStatus / importSkillZip / probeRemote / installSkills / getPendingUpdates / applyUpdates
window.api.log.*           // getLogs / clearLogs
window.api.terminal.*      // runCommand / startPty / inputPty / resizePty / stopPty / onPtyChunk / onPtyExit / removeListeners
window.api.channels.*      // isPluginInstalled / installPlugin
window.api.obsidian.*      // getConfig / saveConfig / selectVault / getIndexStatus / rebuildIndex / cancelIndex / testEmbedding / getEmbeddingPresets / testSearch / onIndexProgress
window.api.shell.openExternal(url) / window.api.app.getVersion() / window.api.dialog.showMessage(opts)
```

### 2.0（`window.api.marketing.*`）

按域划分：`system` / `project` / `context` / `business` / `watchlist` / `knowledge` / `gateway` / `advisor` / `content` / `hot`。所有方法返回统一信封；流式回答通过事件按 runId 归并。

### 3.0（`window.api.work.*`）

`profile` / `matters` / `todos` / `records` / `today` / `router` / `qa` / `reports` / `tools` / `knowledge` / `context` / `reminder` / `openclawSummary` / `wizard` / `gateway` / `stream`（`onChunk` / `onDone` / `onError` / `removeAll`）。

### 4.x / 5.0 插件与角色

```typescript
// 插件管理 + 签名安装（5.0）
window.api.plugins.list() / .setEnabled(id, enabled)
window.api.plugins.permissions() / .grantPermissions(id) / .revokePermissions(id)
window.api.plugins.pickPackage() / .inspectPackage(file)
window.api.plugins.install(file, { allowSelfSigned?, tofuFingerprint? }) / .update(...)
window.api.plugins.rollback(id) / .uninstall(id, keepData) / .installed()
window.api.plugins.devMode() / .isolatedStatuses() / .invokeIsolated(id, method, payload) / .invoke(id, method, payload)
window.api.plugins.getConfig(id) / .setConfig(id, config) / .diagnostics() / .indexEntries() / .onChanged(cb)
window.api.pluginImports.status() / .retry(pluginId)   // 旧数据导入状态
window.api.consent.status() / .grant() / .revoke()     // 用户协议（4.x / 5.0：宿主单源）

// 大肥鱼（4.x / 5.0 宿主模块）
window.api.character.status() / .state() / .settings.* / .interact() / .reset()
window.api.character.bootstrap.* / .life.* / .memory.* / .voice.* / .persona.* / .knowledge.*
window.api.character.stickers.* / .content.* / .backup.* / .chatChannels.* / .safety.* / .pet.* / .chat.*
window.api.character.onEmotion(cb) / .onOpenPage(cb) / .onEvent(cb)
window.api.fish.voice.*    // TTS / 克隆 / 外部 TTS 等语音能力
```

> 插件开发者请以 [PLUGIN-API.md](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/PLUGIN-API.md) 和 `plugin-sdk/` 为准；渲染端不得持有网关 token 或直连数据库。

## 渠道接入

应用内置微信渠道，同时支持**企业微信官方插件**、**飞书自建应用**和 **QQ 机器人（官方插件）**。

### 企业微信（官方插件，推荐）

使用官方脚手架 `@wecom/wecom-openclaw-cli`，**无需 CorpID / Secret**，扫码即可完成接入：

1. 进入「渠道接入」页，找到**企业微信（官方插件）**卡片；
2. 点击「💼 企微扫码接入」，自动跳转终端运行官方安装向导；
3. 向导自动完成安装插件 → 扫码 → 创建机器人；
4. 创建成功后**重启 OpenClaw**，在企业微信即可开始对话。

> CLI 通过 npx 运行，自动检测便携 Node；国内默认走 npmmirror。遇到问题可在终端执行 `npx -y @wecom/wecom-openclaw-cli doctor`。

### QQ 机器人（官方插件）

使用腾讯官方插件 `@tencent-connect/openclaw-qqbot`，支持**手机 QQ 扫码绑定**，也可手动填写 AppID / AppSecret；默认 WebSocket 长连接，无需公网 IP。

- **前置**：在 [QQ 开放平台](https://q.qq.com/) 创建机器人并获取 AppID / AppSecret（AppSecret 只显示一次）；沙箱测试需把测试 QQ 加为沙箱成员。
- **接入**：渠道页点「📱 QQ 扫码登录」，应用会先确认 / 补装官方插件，再执行 `channels login --channel qqbot`；也可直接填写 AppID / AppSecret 保存。
- **群聊**：默认只有 @机器人 才回复；群聊策略（允许所有群 / 仅白名单群 / 禁用）在渠道卡片设置，白名单写 `channels.qqbot.groupAllowFrom`。
- **升级**：Windows 不支持插件 `/bot-upgrade` 热升级，请重新执行安装流程，或在终端执行 `plugins install @tencent-connect/openclaw-qqbot@latest`（外部 shell 用 `openclaw plugins install ...`）。

### 飞书（自建应用）

飞书为**插件驱动**渠道，除凭证外还需安装官方插件 `@openclaw/feishu`，界面已将这一步自动化。

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**，获取 App ID / App Secret；
2. 添加「机器人」能力并开通 `im:message` 相关权限；
3. 事件订阅选**长连接（WebSocket）**，订阅 `im.message.receive_v1`；`Encrypt Key` / `Verification Token` 可留空；
4. 发布应用并等待管理员审核；
5. 在应用「渠道接入」页填写凭证并保存（首次自动安装插件，日志前缀 `[feishu]`）；
6. 安装完成后**重启 OpenClaw**。

私聊默认 `pairing`：陌生人首次私聊生成配对码，可在终端执行：

```bash
openclaw pairing list feishu              # 查看待审批的配对码
openclaw pairing approve feishu <配对码>  # 审批通过
```

> 群聊默认需要 @机器人，可在渠道卡片关闭。

## 知识库对比（1.0 / 2.0 / 3.0）

三个版本各有一个「知识库」，是三套独立实现，核心分歧在**检索方式**：1.0 检索式（RAG），2.0 / 3.0 注入式。

| | **1.0**（master / release/1.0） | **2.0**（release/2.0） | **3.0**（release/3.0） |
|---|---|---|---|
| 模块名 | Obsidian 知识库 | 商家知识库 | 工作知识库 |
| 数据源 | 用户的 Obsidian vault（`.md`） | 人工导入的商家资料 | 人工导入的工作资料 |
| 格式 | 仅 Markdown | docx / xlsx / pdf / url / text / markdown / faq | 同 2.0 |
| 存储 | 独立向量库 `config/.openclaw/obsidian/index.db` | 主库 `umi-claw.db` 的 `knowledge_items` 表 | 主库 `work.db` 的 `knowledge` 表 |
| 切块 / 向量 | 按标题切块 + embedding | 不切块、无向量 | 不切块、无向量 |
| 检索 | 语义 topK + 多样性剪枝 | LIKE 关键词（中文友好） | 全量注入优先，超预算退化为 LIKE |
| 消费方 | OpenClaw 通过 MCP 工具 | 应用内 ContextEngine → 顾问 / 内容中心 | 应用内 ContextEngine → 问答 / 工具箱 / 日报 |
| 隔离 | 单 vault | 按 `project_id` 隔离 | 全局单库 |
| OCR | 无 | 扫描件 AI 识别（显式触发 + 人工确认） | 无 |

> 4.x / 5.0 把 2.0 / 3.0 的域装箱为插件，数据迁移到 `<dataDir>/plugins/<id>/data.db` / `plugin-data/`；检索策略不变。大肥鱼不新增知识库，使用既有 Obsidian vault 的 `大肥鱼/` 分类目录。

## 常见问题

### Windows 下网关启动失败（OpenClaw ≥ 2026.10.9）

**现象**：点「启动」后提示启动失败；日志（`data/logs/runtime-debug.log` 或 `%TEMP%\openclaw\openclaw-日期.log`）出现：

- `Windows ACL permits untrusted SQLite staging access on ancestor: ... principal=S-1-5-11`
- `OpenClaw state ... is undergoing offline maintenance` / `openclaw.json` 读取失败

**原因**：OpenClaw 2026.10.9 起会对 SQLite 状态目录做安全预检：若数据目录（或其祖先）允许 `Authenticated Users`（S-1-5-11）写入，就拒绝 state capture。Windows 上新建在普通目录（项目根、U 盘、便携目录）的 `data` 默认会继承宽松 ACL。

**修复**（PowerShell；`<数据目录>` 换成实际路径）：

```powershell
icacls "<数据目录>" /inheritance:r /grant "NT AUTHORITY\SYSTEM:(OI)(CI)F" /grant "$(whoami):(OI)(CI)F"
```

数据目录位置：dev 为项目根 `data`；安装版为 `%APPDATA%\UmiClaw\data`；便携版为 exe 同级 `data`。执行后重启应用再启动网关；若日志提示更上级目录，对提示的目录做同样处理（只去掉 `Authenticated Users` 的写权限）。

### 5.0 第三方插件安装失败

- **`PACKAGE_SIGNATURE_MISSING` / `PACKAGE_SIGNATURE_INVALID`**：包未签名或签名损坏，重新打包。
- **`PACKAGE_UNTRUSTED_KEY`**：自签包首次安装需在界面上**勾选确认该密钥**（TOFU）；官方 / 伙伴包需要发布流水线注入的根密钥。
- **`PACKAGE_TOFU_MISMATCH`**：同一 keyId 的指纹变了，可能被替换 / 重新签名；确认来源前不要继续。
- **`PLUGIN_INCOMPATIBLE`**：`apiVersion` / `engines.host` 与当前宿主不兼容。
- **`PLUGIN_KILL_SWITCH`**：安装能力被显式停用。
- 选择安装包时点「取消」是正常操作，不应产生错误提示。

### 其他

- 便携模式数据文件被占用：关闭 Excel / WPS 等程序后再替换程序文件。
- 升级后老数据找不到：安装器会自动搬迁 `data` / `context-data`；便携模式需手动保留这两个目录。

## 文档

### 本分支（master / 1.0）

- [Umi Claw 使用文档](doc/Umi_Claw_使用文档.docx)
- [OpenClaw 使用文档](doc/OpenClaw_使用文档.docx)
- [大肥鱼 GitHub 资料库调研](doc/大肥鱼-GitHub资料库调研.md)

### 其他版本线

- 1.0：[README](https://github.com/bscwdg/umi-claw/blob/release/1.0/README.md)
- 2.0：[README](https://github.com/bscwdg/umi-claw/blob/release/2.0/README.md) · [PLAN-2.0](https://github.com/bscwdg/umi-claw/blob/release/2.0/PLAN-2.0.md)
- 3.0：[README](https://github.com/bscwdg/umi-claw/blob/release/3.0/README.md) · [PLAN-3.0](https://github.com/bscwdg/umi-claw/blob/release/3.0/PLAN-3.0.md)
- 4.x：[README](https://github.com/bscwdg/umi-claw/blob/release/4.0/README.md) · [PLAN-4.0](https://github.com/bscwdg/umi-claw/blob/release/4.0/PLAN-4.0.md) · [大肥鱼规划](https://github.com/bscwdg/umi-claw/blob/release/4.0/PLAN-FISH-CHARACTER.md) · [启动优化](https://github.com/bscwdg/umi-claw/blob/release/4.0/doc/OPT-STARTUP-4.0.md) · [运行手册](https://github.com/bscwdg/umi-claw/blob/release/4.0/doc/RUNBOOK-4.0.md) · [进度](https://github.com/bscwdg/umi-claw/blob/release/4.0/doc/PROGRESS-4.0.md)
- 5.0：[README](https://github.com/bscwdg/umi-claw/blob/release/5.0/README.md) · [扩展性规划](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/PLAN-5.0-EXTENSIBILITY.md) · [插件 API](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/PLUGIN-API.md) · [更新日志](https://github.com/bscwdg/umi-claw/blob/release/5.0/CHANGELOG.md) · [大肥鱼使用指南](https://github.com/bscwdg/umi-claw/blob/release/5.0/doc/%E5%A4%A7%E8%82%A5%E9%B1%BC-%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md)

## 贡献与反馈

- PR 默认目标为 `master`；新功能请先对应版本线分支开发（2.0 / 3.0 / 4.0 / 5.0），稳定后再合入。
- 提交前至少跑对应分支已有的检查：`master` / `release/1.0` / `release/2.0` 跑 `npm run typecheck` + 各自 `accept:*` 分项；`release/3.0` 跑 `npm run typecheck` + `npm run accept`；`release/4.0` / `release/5.0` 跑 `npm run typecheck:node` + `npm run typecheck:web` + `npm run accept` + `npm run check:boundary`。
- 改动插件 / IPC / 数据层时请同步补 `test/*.accept.mjs` 断言。
- Bug / 使用问题可通过 Issue 或文末邮箱反馈，附版本、分支、日志（`runtime-debug.log`）。

## 联系作者

嘿嘿，我是小北，开源不易请点点 stars，谢谢！
如使用安装遇到问题，或者遇到无法处理的 bug 请邮箱联系作者哟！
邮箱：guzhengkai97@163.com

## License

MIT

## 附录：启动可靠性修复（2026-10-31，自 4.0 同步）

master 与 release/4.0 共用 OpenClaw 网关启动链路，本次同步启动慢优化与可靠性修复（**不含语音模块**）。

- **就绪态与阶段可视化**：`running`（进程）与 `ready`（`/health` 200）分离；点击启动立即显示「启动中」；状态推送新增 `starting/ready/startedAt/startupMs/bootPhase/estimateStartupMs`；Dashboard 展示阶段与 ETA。
- **webhook 迁移标记兜底**：无 `legacyWebhook` 时自动补 `meta.migrations.webhookListeners=true`，避免每次启动重跑旧迁移；备份 + 原子写回退 + BOM/CRLF 保留，走官方写入串行队列。
- **退出应用时保留网关（可选，默认关）**：开启后网关 detached 运行、退出应用不停网关；下次启动校验端口 owner / 版本 / 健康后直接复用（跳过冷启动）；退出路径统一幂等。
- **启动耗时统计与 ETA**：最近 5 次；样本 ≤2 用最近一次，≥3 取最近 3 次中位数。
- **网关日志文件 tail**：增量读、半行 carry、截断检测、stdout/stderr 分流、兼容 pino `msg`。

验证：双 typecheck 0 错、build 通过、`npm run accept:startup-sync`（config-writer / startup-stats / webhook-marker / startup-ready / qqbot）全绿。
