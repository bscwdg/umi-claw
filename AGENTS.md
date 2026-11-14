# AGENTS.md —— Umi Claw 仓库统一 AI 规范

> 版本：v1（2026-11-02）｜适用分支：`release/4.0` 及后续
> 性质：**本仓库唯一的 AI/人类协作规范**。`PLAN-*.md` 是架构契约，本文件是**怎么写代码**的契约。
> 冲突优先级：`PLAN-4.0.md`（架构边界） > 本文件（写法） > 各 `PLAN-*.md` 的历史细节。
> 每一条都标注了「现状证据」与「校验方法」。**没有校验方法的条款不要写进来。**

---

## 0. 一分钟上手

```powershell
cd D:\work2026\umi-claw
npm run dev            # 生成插件入口表 + 启动
npm run typecheck:node; npm run typecheck:web    # 双 typecheck，必须 0 错
npm run accept         # 58 套验收（ACCEPT 54 + e2e×3 + smoke，931 项检查（930 通过 + 1 显式跳过）；node:test 21 条另计）— 2026-11-13 codex/voice HEAD 实测；release/4.0 为 40/822，voice 合并后复核
npm run build          # 构建（含 plugin:gen）
```

**开工前必读**：本文件 → `PLAN-4.0.md §〇`（已拍板结论）→ `doc/PLAN-4.2.md`（当前欠账与顺序）→ `doc/PLAN-4.1-DEBT.md`（历史）。

---

## 1. 这是什么项目

一个 Electron + Vue3 的**本地优先 AI 工作台**，底座是 OpenClaw 网关。四层能力叠在同一个壳上：

| 层 | 内容 | 形态 |
| --- | --- | --- |
| 宿主 | 窗口 / 导航 / 设置 / OpenClaw 管理 / 渠道 / 终端 / Obsidian / 技能 / 更新 / 语音 | `electron/main/*`（kernel + services + 壳能力） |
| `marketing` | 商家大脑 / 知识库 / AI 顾问 / 内容中心 / 热点雷达 | 官方内置插件 |
| `work` | 新的一天 / 工作记录 / 日报周报 / 工作问答 / 工具箱 / 知识库 / 到点提醒 | 官方内置插件 |
| `character` | 大肥鱼：桌宠 / 聊天 / 关系 / 生活 / 日记 / 语音 | **宿主模块**（不是插件，见 §5.3） |

**4.x 只做官方内置插件**：插件代码随宿主构建进安装包，`resources/plugins/` 只放 `plugin.json` + `migrations/`。4.x 不提供第三方安装；5.0 受控第三方方向见 [doc/PLAN-5.0-EXTENSIBILITY.md](doc/PLAN-5.0-EXTENSIBILITY.md)。

---

## 2. 目录与归属（写代码前先确认往哪放）

```
electron/main/
├── kernel/          # 插件内核：manifest / registry / lifecycle / plugin / services
├── services/        # 宿主能力（pluginDb / pluginRuntime / pluginServiceAdapters / gateway(parts,stream) / hostUi / knowledge / context / errors / pluginKv / pluginSecrets / characterKv / characterHost；允许 electron 运行时依赖，如 Notification）
├── database/        # 数据层：schema / migration / schemas（错误码唯一来源在 services/errors.ts）
├── ipc/             # 宿主 IPC：host/ 放宿主通道（WP5-a）；域 IPC 已在 4.1 WP6-b 搬进 plugins/<id>/main/ipc/
├── character/       # 大肥鱼宿主模块
├── fish/voice/      # 语音服务
├── work/            # 已删除：work 域代码在 plugins/work/domain/
├── marketing/       # 已删除：marketing 域代码在 plugins/marketing/domain/
├── claw/            # clawManager 拆出的纯模块（reclaim/doctor/migrations/gatewayRuntime/skills/probe/status/…；J2（clawManager 2543→1484）拆分产物，详见 PLAN-4.2 §四 #7）
├── clawManager.ts / configManager.ts / downloadManager.ts / channelManager.ts ...
└── index.ts         # 只做组装；目标 ≤ 1,800 行（现状 1,753 ✅，2026-11-10 实测）

plugins/             # 官方内置插件（同仓源码，参与宿主构建）
├── work/  main.ts + renderer.ts + ui/
├── marketing/
├── hello/           # 内核演示插件
└── shared/

plugin-sdk/          # 插件 SDK（public/official-*/client*/testing；A3b 骨架，alias/注入待 B1）

src/                 # 渲染端（Vue3 + Pinia + vue-router）
├── views/           # 宿主页面
├── character/       # 角色页面与桌宠窗口
├── renderer/        # main.ts / pluginUi.ts / *.generated.ts
├── stores/          # claw / config / envSetup
└── composables/     # useToast

resources/           # 打包为 extraResources（只放数据与脚本，不放业务源码）
├── openclaw-plugins/ # 随包 OpenClaw 原生插件（feiyu-guard：QQ 群聊硬策略 + feiyu 语音通道合规，plugins.load.paths 加载）
└── ...              # character 内容包 / database db-worker / pdfjs 等数据与脚本
test/                # accept 验收脚本（零 npm 依赖）
templates/           # 插件模板（templates/plugin，不进 plugins 扫描）
scripts/             # 构建/验收脚本
doc/                 # 计划、施工日志、运维手册、调研
```

**放错位置的典型**：把业务逻辑塞进 `index.ts`；把域代码放进 `services/`；把脚本放进 `resources/`（会整目录带进安装包，见 `PLAN-4.0 §18.5`）。

---

## 3. 代码风格（以现状为准，不发明新风格）

### 3.1 已统一的

| 项 | 规则 | 现状证据 |
| --- | --- | --- |
| 主进程（`electron/**`、`plugins/*/main.ts`） | **不加行尾分号** | `todoManager.ts` 619 行 0 个行尾分号；`kernel/lifecycle.ts` 612 行 0 个 |
| 主进程引号 | **单引号** | `electron/main` 的 `import … from '…'` **524 处**（含 `claw/` 42 处）/ 双引号 **0**（2026-11-11 实测） |
| 缩进 | **2 空格**；续行用 4 空格对齐 | 全仓无 tab |
| 换行 | **LF**（`.gitattributes` 已强制 `text=auto eol=lf`，`*.bat`/`*.cmd` 除外） | 抽查 3 个文件 CRLF=0 |
| 编码 | **UTF-8 无 BOM** | 抽查 3 个文件 BOM=False |
| 文件头 | 首行 `// <相对路径> —— <一句话职责>`，随后用空注释行写**为什么** | `electron/main` 92/150 个 `.ts` 有头（2026-11-11 实测） |
| 注释语言 | **中文**，写「为什么」和「踩过的坑」，不写「这行在赋值」 | 全仓一致 |
| 类型 | `strict`（由 `@electron-toolkit/tsconfig` 提供）；公共导出显式类型 | 双 typecheck 0 错 |

### 3.2 尚未统一的（**新代码按下面写，老代码不要顺手改**）

| 项 | 现状 | 新代码怎么写 |
| --- | --- | --- |
| 渲染端分号 | `src/` 约 20% 行尾有分号（2,597/12,849），文件间 27%–43% 不等 | **跟随所在文件的既有风格**；同一文件内不得混用。禁止为「统一」而全仓格式化（会造成 2,600 行噪声 diff） |
| 渲染端引号 | `src/` 48 单 / 26 双 | 单引号 |
| 文件头 | 58 个首行不是 `// electron/main/…` 规范头（**33 个**是 `// xxx —— …` 简写路径头，如 `gatewayClient.ts`、`kernel/index.ts`、`services/errors.ts`；**25 个**完全无注释头，如 `channelManager.ts`、`configManager.ts`、`downloadManager.ts`、`database/**` 多数）。`obsidianManager.ts`/`todayManager.ts` 等 WP3 搬家后的旧路径已不在 `electron/main`。`clawManager.ts` 已在 2026-11-10 拆分时补头 | **新文件必须带头**；老文件改动时顺手补，不单独提交格式化 |
| 提交 message | 类型/范围混用：`feat(4.0)` / `fix(3.0)` / `fix` / `feat(2.0-03)` | 见 §9 |

**理由**：本仓库没有 `.editorconfig`、没有 lint，格式化靠习惯。这些差异是历史沉淀，不是错误。**一次性的全仓格式化会淹没真正的改动**（`§18.5` 已把「验收留档时效」列为风险）。

---

## 4. 分层约定（这是本仓库最硬的部分）

### 4.1 Manager 层：纯逻辑，不碰 Electron

**规则**：`plugins/<id>/domain/**/*Manager.ts` 与 `contextEngine.ts` **禁止** `import ... from 'electron'`（WP3 起域代码住在 `plugins/<id>/domain/`；宿主 `electron/main/{work,marketing}` 已删除）。

**现状证据**：0 / 34 个域文件命中（`plugins/*/domain`，其中 21 个 `*Manager.ts`）。这是 54 套验收能在纯 Node 里跑真源码的前提。

**写法**：工厂函数 + 显式 options，不 `new`、不单例、不从全局推。

```ts
// 唯一允许的形状
export interface TodoManagerOptions {
  database: WorkDatabase          // 依赖显式传入
  logger?: (message: string) => void
}
export function createTodoManager(options: TodoManagerOptions): TodoManager { ... }
```

**现状证据**：39 处 `export function create*`，21 个 Manager 文件全部如此。

**禁止**：
- 在 Manager 里 `import { app } from 'electron'` 取路径 → 由 `runtime.ts` 解析后注入
- 在 Manager 里 `ipcMain.handle` → IPC 归 `electron/main/ipc/host/*`（宿主通道）/ `plugins/<id>/main/ipc/*`（域通道）
- 在 Manager 里读 `process.env` 判定行为 → 由调用方注入配置

### 4.2 IPC 层：只做透传与信封

**通道命名**：`<domain>:<entity>:<method>`，全部小写 domain、camelCase method。

```ts
export const WORK_TODOS_CHANNELS = {
  list: 'work:todos:list',
  create: 'work:todos:create',
  confirm: 'work:todos:confirm'
} as const
```

**现状证据**：26 个 `*_CHANNELS` 常量，全部 `as const`，全部符合上述形状。

**返回**：统一信封，成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message, details? } }`。

**错误**：抛 `AppError(code, message, details?)`；`code` 必须来自 `electron/main/services/errors.ts` 的 `ERROR_CODES`（**唯一来源，当前 17 项**；4.0.2 P2 新增 `PLUGIN_OPERATION_FAILED`，PLAN-5.0 B2 新增 `PLUGIN_PERMISSION_DENIED`）。IPC 层用 `toErrorEnvelope(e)` 翻译，未知异常兜底 `DB_ERROR`。

**渲染端**：**只按 `code` 分支，禁止 `message.includes()`**。

**现状证据**：`src/` + `plugins/` 中 `message.includes(` 命中 **0**。

### 4.3 渲染端

- 页面放 `src/views/`（宿主）或 `plugins/<id>/ui/pages/`（插件）
- 状态放 `src/stores/*`，`defineStore('<名字>', () => { ... })` setup 写法
- 提示统一 `useToast()`（`showToast(msg, 'success'|'error'|'warning')`）
- 二次确认统一 `ConfirmDialog` 组件，**禁止 `window.confirm` / `window.alert`**

**现状证据**：全仓无一处真实调用（仅 3 处注释说明「不要用」）。由 `ui.accept` 的 U13/U14/U21 守住。

---

## 5. 插件边界（4.0 的核心；4.1/4.2 后值越界与 type 越界均已清零）

### 5.1 插件只能经 `ctx` 访问宿主

**允许 import**：`plugin-sdk/**`（新代码唯一入口；public/official-*/client*）、本插件目录内文件。过渡期仍允许 `electron/main/kernel/**`、`electron/main/services/**`，A3b 迁移完成后只允许 SDK。
**禁止 import**：其余一切 `electron/main/*`（`runtime`、`ipc`、域实现、`pluginDataImport` 等）。

**现状**：**非 type 越界 0 条、type-only 越界 0 条**（4.1 WP6-b/c：域 ipc 已搬进 `plugins/<id>/main/ipc/`，gateway 流助手/宿主 UI 适配下沉 `services`；4.2 B4 已把 14 处 type-only 宿主类型引用清零，门禁新增 `pluginHostTypeOnly` 分级计数、基线 0；裸 `electron` 包也只有非 type 引用才判违规）。门禁：`npm run check:boundary`（零依赖脚本，已接入 `npm run accept` 首套与 CI verify job）。

**读这条规则时要知道**：现状是「新代码不得新增越界，旧越界按 WP6 逐步清零」，不是「现在已经合规」。`scripts/boundary-baseline.json` 的 ratchet 会锁死这个数（只准降不准升，`--update` 才写，上调必须 `--allow-raise --note "<原因>"`）。

**非字面量引用**：`import(someVar)` / `require(someVar)` 无法静态判定目标，记成 `<non-literal>` **按违规处理**（宁可多报）；`typeof import(...)` 是类型查询，放行。注释与字符串/模板文案里的示例 `import(...)` 不算引用（门禁先做词法掩码）。

**反向依赖（host→plugin）**：4.2 B3 已拆除——插件在 activate 时自注册「中止我的后台任务」到 `abortRegistry`，宿主退出统一 `abortRegistry.abortAll()`；4.4 收官 R3 已把兼容 barrel `electron/main/ipc/index.ts` 整删（原 `@test-only` re-export，测试断言改指真实模块），4.3 登记的「barrel 测试依赖」随之清零。新代码不得再依赖 host→plugin 值导出（类型可 type-only）。

**已登记的门禁边界**（2026-11-02 G10 复核接受，B8 有断言锁住）：① 模板字符串 `${}` 内的动态 `import`/`require` 暂被视为模板内容、检不出；② `if (cond) /re/` 这种 `)` 后的正则字面量不识别（补 `)` 会带来除法误判，权衡后保留）。修这两条时同步改 `test/boundary.accept.mjs` 的 B8 断言。

### 5.2 插件形状

```ts
// plugins/<id>/plugin.json   —— 数据，不含代码
{ "id": "<id>", "version": "1.0.0", "capabilities": ["host.db.v1", ...],
  "inject": ["db", "openclaw", ...], "channels": ["work"], "defaultEnabled": true }

// plugins/<id>/main.ts
export default definePlugin({
  activate(ctx: PluginContext) { ... ; return () => cleanup() },
  deactivate?() { ... }
})

// plugins/<id>/renderer.ts
export default { routes, nav, slot, setup } as PluginUiModule
```

**硬约束**：

- `plugin.json` 的 `id` **必须等于目录名**（`scripts/gen-plugin-entries.mjs` 强制校验）
- 入口表由脚本生成，**禁止手改** `kernel/plugins.main.generated.ts` 与 `src/renderer/plugins.renderer.generated.ts`
- 禁止运行时从磁盘/网络加载可执行模块（`PLAN-4.0 §十七第3条`）。**例外**：§5.4 的随包 OpenClaw 原生插件由网关 `plugins.load.paths` 加载，不属于 Umi 插件入口表；路径固定随包、4.x 不提供第三方安装。5.0 受控第三方方向见 [doc/PLAN-5.0-EXTENSIBILITY.md](doc/PLAN-5.0-EXTENSIBILITY.md)（**4.x 仍禁止**）。
- 注册物一律返回 disposer，停用由宿主 LIFO 清理；不要在 `deactivate` 里才擦屁股

**现状证据**：`lifecycle.ts` 已实现 LIFO + 激活超时 + 迟到注册拒绝 + 失败隔离；`plugin.accept` **71 项**（P58 锁「ctx.services 使用 ⊆ inject」）。

### 5.3 大肥鱼为什么不是插件

它需要 `petWindow`（透明置顶窗口）、`screen`（多屏定位）、`globalShortcut`（点击穿透逃生键）。而插件契约**刻意不给窗口控制**（`PLAN-4.0 §4.2` 只给 db/openclaw/notifications/voice/config）。

**结论**：保留为宿主模块 `electron/main/character/`，但依赖仍走契约注入（`doc/PLAN-4.1-DEBT.md` C4.3），不得在 `index.ts` 里堆裸函数。**不要把它"顺手装箱"——那会破掉 §4.2 这条边界。**

### 5.4 随包 OpenClaw 原生 hook 插件（feiyu-guard）

`resources/openclaw-plugins/feiyu-guard/` 是随安装包发布的 OpenClaw 原生插件（`plugins.load.paths` 加载，不走 npm 安装），硬执行两类规则：① **QQ 群会话**群聊策略：`message_sending`（群回复取消 / 亲密词替换或拦截）、`reply_payload_sending`（渠道出站语音）、`before_tool_call`（群语音上传 `qqbot_platform_api` 按群按天限额、群会话 `write/edit/apply_patch` 记忆隔离）；② **feiyu 语音通道合规**（不分群/私聊）：`before_tool_call` 对 feiyu 会话的 `exec` 野链路（`say.py` / `edge-tts` / `edge_tts` / `qqbot-voice-send` / `qqbot-voice-make-silk` / `probe-upload` 脚本名特征 + `api.sgroup.qq.com` / `bots.qq.com/app/getappaccesstoken`（匹配前整体转小写）/ `api.bot.qq.com` 端点特征 + `/v2/users|groups/<id>/files` 媒体路径特征）一律 block；feiyu 会话经 `qqbot_platform_api` 直传 C2C 语音（`/v2/users/<id>/files` 且 `file_type=3`，由 `voiceUploadUserId` 识别）同口径 block，群路径参数不进该分支。语音只能走网关 tts 工具。

硬约束：

- **fail-open 红线**：私聊、非 qqbot 渠道、会话类型判不出、配置版本≠1 → 一律放行；状态文件读失败按空状态、写失败保留进程内计数（语音上限仍按内存判定），状态异常不得影响私聊或宿主启动。
- **语音通道合规例外（与群策略并列，不受 fail-open 红线的群/私聊口径限制）**：野链路规则按会话键 `agent:feiyu` 前缀门控（`isFeiyuAgentSession`，冒号边界 + 大小写不敏感），**不分群聊/私聊/渠道**，feiyu 会话内命中明确特征即 block；非 feiyu 会话、会话键缺失或形状判不出 → 返回 null 放行，不越界管其它 agent。规则以插件成功注册且配置版本=1 为前提（版本≠1 时零 hook，与群策略一起 fail-open，见 guard.mjs 注册闸）。这是「特征摩擦层」而非绝对阻断（变量拼接/编码/改名等混淆仍可绕过），减面根治靠归档工作区野工具；已知边界与实测口径登记在 `doc/PROGRESS-4.0.md`，规则真源是插件 `policy.mjs` 的 `detectWildVoiceCommand`，不经宿主 GroupPolicy 下发。
- **策略唯一真源**是宿主 `GroupPolicy`（`electron/main/character/groupPolicy.ts`）→ `services/characterGroupConfig.ts` 编译进 `plugins.entries["feiyu-guard"].config`；插件内 `api.pluginConfig` 只读，不得另立配置真源。
- **群策略写盘**在 `openClawConfigWriter` 的同一路径串行队列里直接读改写 `openclaw.json`（临时文件 + rename），**不走 `config patch` CLI**（网关运行时 CLI 会等配置锁）；写后需重启网关生效，patch 形状由 accept 的真实 dry-run + zod schema 校验兜底。
- 新增群策略字段要同步五处：`groupPolicy.ts`（模型/默认值/夹紧）、`types.ts` 的 `GROUP_PATCH_KEYS`（否则 UI 保存的局部补丁不生效）、`src/character/CharacterSettings.vue`（draft 默认值/回填/保存列表）、`characterGroupConfig.ts`（编译进 OpenClaw 配置）、插件 `policy.mjs`（读取/执行）；manifest `configSchema` 的对象层保持 `additionalProperties: true`，避免扩字段时整份配置校验失败。
- 新 hook 必须先在 `test/guard-plugin.accept.mjs` 有 fake-api 行为断言（零 npm 依赖），并保持 `MUTATION` 可红。

---

## 6. 数据与配置

| 对象 | 归属 | 规则 |
| --- | --- | --- |
| 插件数据 | `<dataDir>/plugins/<id>/data.db` | 每插件独立库 + 独立 schema + 独立 `plugin_migrations`；只能经 `ctx.db` 的参数化 CRUD，**禁止裸 SQL** |
| 宿主数据 | `<dataDir>/work.db` | 只承载 voice / wizard 的 `app_meta`（character 已迁 `<dataDir>/character/kv.json`，见 C4.2） |
| 知识库原件 | work：`<dataDir>/plugins/work/knowledge/<id>/`；marketing：`<dataDir>/projects/<id>/`；character：**既有 Obsidian vault 的 `大肥鱼/<类别>/`**（世界书/角色卡/关系/约定，不新增 KB） | `source_path` 存相对 dataDir 的路径（可随 data 目录搬移）；work 旧全局 `<dataDir>/knowledge` 仅历史数据（4.0.2 起新导入不再写） |
| 应用配置 | `<dataDir>/config/.openclaw/openclaw.json` | **单写入口**：`configManager` + `openClawConfigWriter.runSerializedOpenClawConfigWrite` |
| 密钥 | `safeStorage` | 按 `plugin:<id>:<key>` 命名空间；永不写日志/配置/导出包 |
| 群聊策略状态 | `<dataDir>/character/group-guard-state.json` | `feiyu-guard` 按群按天语音计数（原子写）；只由插件读写；读失败按空状态、写失败保留进程内计数（语音上限仍生效），不阻断私聊/宿主；「删除全部数据」时清理 |
| 迁移 | `migrations/*.sql` | 幂等、可重入、失败可回滚；迁移前必须 `backup()` |

**现状证据**：`openclaw.json` 的写盘调用集中在 `configManager.ts`（2 处 writeFileSync）+ `openClawConfigWriter.ts`（串行队列），其余文件只读或经它们写。

**禁止**：
- 插件直接写 `openclaw.json`（`PLAN-4.0 §17.2`）
- 在 Manager 里 `fs.writeFileSync` 到数据目录 — 走数据库或 `ctx`
- 为「架构完整」新增状态表（`PLAN-3.0` 硬规则 24）

---

## 7. 验收：先写断言，再写实现

### 7.1 硬性

- 改 Manager / IPC / 数据层 → **必须**有对应 `test/*.accept.mjs` 断言
- 新增 `test/*.accept.mjs` → **必须**在 `scripts/run-all-accept.mjs` 的 `ACCEPT` 数组注册（否则 `npm run accept` 不跑它）
- 验收脚本**零 npm 依赖**，只用 `node:` 内置 + `test/_lib.mjs`
- 断言打**真源码**：`bundleEntry('electron/main/work/todoManager.ts', 'todo-todo.mjs')` 后 `import()`，不 mock 被测逻辑

**现状证据**：55 个 `.accept.mjs`、run-all `ACCEPT` 54 项；`db-client.accept.mjs` 由 `db-worker.accept.mjs` 以子进程串跑（不计入 run-all 的 ACCEPT 数组，但**在总链路里**）。2026-11-13 干净基线（codex/voice HEAD；release/4.0 为 40/822，voice 合并后复核）：58 套（含 e2e×3 + smoke）、931 项检查（930 通过 + 1 显式跳过） + `node:test` 21 条。

### 7.2 `_lib.mjs` 提供的工具

| 工具 | 用途 |
| --- | --- |
| `Recorder(suite)` + `.check(id, name, fn)` | 单点失败不中断整轮 |
| `assert` / `assertEq` / `assertDeepEq` | 断言 |
| `bundleEntry(entry, outName, {externals, alias})` | esbuild 把 TS 打成临时 ESM |
| `domainSrc(pluginId, rel)` / `domainUiSrc(pluginId, rel)` | **旧路径兼容回落**：`plugins/<id>/main/<rel>` 存在就用它，否则回落 `electron/main/<rel>`。返回**绝对路径**，不能直接传给 `bundleEntry`（它要仓库相对路径）。**WP3 起域代码在 `plugins/<id>/domain/`，`domainSrc` 的第一候选恒不存在，实际总回落旧路径——新脚本用 `workSrc()` / `mkSrc()` / `anySrc([...])`（仓库相对路径）** |
| `workSrc(rel)` / `mkSrc(rel)` | 域源码定位（WP3 后）：`plugins/work/domain/<rel>` → `electron/main/work/<rel>`；返回**仓库相对路径**，可直接给 `bundleEntry` |
| `anySrc(candidates)` | 多候选定位：返回第一个存在的仓库相对路径（用于 `services/X` ↔ 旧域路径这类一对多回落） |
| `resolveNodePath()` | 便携 Node 优先；若它带**低完整性标签**（写不了 `test/.tmp`，表现为 SQLite 14 / EPERM），自动复制到系统临时目录再用（保持 `node.exe` 文件名，供进程计数断言）；`UMI_ACCEPT_NODE` 可覆盖；无便携 Node（CI）回退当前进程 Node |
| `waitFor(fn, {timeout})` | 替代固定 `sleep`，避免并发下的假失败 |
| `printResult` / `writeJson` | 结果输出与落盘 |

### 7.3 搬家前先改硬编码，不是「不用改脚本」

`domainSrc()` 的语义是「`plugins/<id>/main/<rel>` 存在就用它，否则回落 `electron/main/<rel>`」——**WP3 搬迁完成后这条候选恒为旧路径**（域代码在 `plugins/<id>/domain/`），只作历史兼容保留。它有两个硬限制：

1. 表达不了「新位置在一棵树、旧位置在另一棵树」（如 `services/knowledge/parsers/X` ↔ `marketing/parsers/X`）：两个候选里只有第二个是自由的。
2. 返回绝对路径，而 `bundleEntry()` 要仓库相对路径。

新脚本一律用 `workSrc()` / `mkSrc()` / `anySrc()`（返回仓库相对路径）。下面是 WP3 开工前的实测口径（G7 证据，供下一次搬家参考）：

| 写法 | 命中 |
| --- | --- |
| `join(..., 'electron','main', ...)` | 75 处 / 24 文件（域内 26 / 10，**全部是 marketing**，work 0） |
| `bundleEntry('electron/main/...')` | 158 处 / 30 文件 |
| 代码行含 `electron/main`（合计） | 181 行 / 31 文件（去掉注释行后） |
| 域内（`work`\|`marketing`）全写法 | 93 处 / 22 文件 |

所以流程是：**搬前先 `Select-String -Path test\*.mjs -Pattern "<被搬目录>"` 清出清单 → 改成 `anySrc([...])`（返回仓库相对路径，按顺序取第一个存在的候选；独立提交、绿了再搬）**。

---

## 8. 提交规范

### 8.1 格式

```
<type>(<scope>): <中文描述，说清「改了什么 + 为什么」>
```

| type | 用途 |
| --- | --- |
| `feat` | 新能力 |
| `fix` | 修缺陷 |
| `perf` | 性能优化（说清量化收益） |
| `refactor` | 不改行为的结构调整 |
| `test` | 只改验收 |
| `docs` | 只改文档 |
| `chore` | 构建/依赖/杂务 |

| scope | 用途 |
| --- | --- |
| `ui` `work` `marketing` `character` `voice` `plugin` `db` `gateway` `startup` | 按模块 |
| `4.0` `4.1` | 按版本（跨模块批次） |

**现状**：`feat(4.0)` 11 次、`docs(4.0)` 10 次、`fix(3.0)` 8 次…另有裸 `fix` / `feat` 12 次、`feat(2.0-03)` 这类工作包后缀。**新提交按上表；不再用工作包编号当 scope。**

### 8.2 一次提交只做一件事

特别地：**搬家（只改路径）与改逻辑绝不混在一个提交**。这是 `PLAN-4.1-DEBT` WP3 的核心纪律——出问题时才能判断是"路径错了"还是"逻辑坏了"。

### 8.3 提交信息里写可验收的事实

好的：`fix(ui): 控制台按钮文案按动作区分（pendingAction 三态，U23 锁住）`
坏的：`fix: 修复一些问题`

---

## 9. 禁止清单（违反即回退）

1. 手改 `*.generated.ts`（插件入口表由 `npm run plugin:gen` 生成）
2. 插件 import `electron/main` 下除 `kernel` / `services` 以外的模块
3. 插件直接写 `openclaw.json`，或在 Manager 里 spawn 网关
4. 渲染端 `/plugins` 之外出现运行时动态加载插件代码
5. `window.confirm` / `window.alert`（用 `ConfirmDialog`）
6. `error.message.includes()` 判断错误（用 `code`）
7. 为「架构完整」新增状态表 / 新增第三方插件安装入口（**5.0 起按 [doc/PLAN-5.0-EXTENSIBILITY.md](doc/PLAN-5.0-EXTENSIBILITY.md) 的签名/权限/隔离约束受控开放；4.x 仍禁止**）
8. 全仓格式化式提交（会淹没真实改动）
9. 密钥写进配置、日志、导出包
10. 改了 `test/*.accept.mjs` 的断言却不单独提交并说明理由

---

## 10. 自检（提 PR / 交付前跑一遍）

```powershell
# ① 双 typecheck 0 错
npm run typecheck:node; npm run typecheck:web

# ② 全量验收 56 套（ACCEPT 52 + e2e×3 + smoke，931 项检查（930 通过 + 1 显式跳过）；node:test 21 条另计）
npm run accept

# ③ 插件边界门禁（ratchet：只准降不准升；权威定义与基线见 scripts/check-boundaries.mjs 与 scripts/boundary-baseline.json）
npm run check:boundary
# 当前基线：pluginHostBoundary=0、managerElectron=0（硬约束：任何新增越界直接红）；输出里的扫描目录数必须 >0（否则是假绿）

# ⑤ 渲染端错误分支按 code（应为 0）
(Select-String -Path src\**\*.vue,src\**\*.ts,plugins\**\*.vue,plugins\**\*.ts `
  -Pattern "message\.includes\(" -ErrorAction SilentlyContinue | Measure-Object).Count

# ⑥ 无明文密钥（0 命中）
Select-String -Path electron\**\*.ts,src\**\*.ts,src\**\*.vue `
  -Pattern "sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9\._-]{20,}" -ErrorAction SilentlyContinue

# ⑦ 无不可见字符（0 命中；含根目录 *.md 与 doc/）
Get-ChildItem electron,src,plugins,doc -Recurse -Include *.ts,*.vue,*.mjs,*.md | ForEach-Object {
  if ((Get-Content $_.FullName -Raw -Encoding UTF8) -match "[\u200b\u200e\u200f\ufeff]") { $_.FullName }
}
Get-ChildItem *.md | ForEach-Object {
  if ((Get-Content $_.FullName -Raw -Encoding UTF8) -match "[\u200b\u200e\u200f\ufeff]") { $_.FullName }
}
}
```

---

## 11. 给 AI 的额外约束

1. **先读再改**：改任一模块前，先读它的文件头注释与对应的 `test/*.accept.mjs`。断言就是你被允许改动的边界。
2. **不动无关代码**：修 A 时不要顺手改 B 的格式、注释、命名。
3. **改断言 = 改契约**：发现断言写错了，单独提交，并在 `doc/PROGRESS-4.0.md` 写明「原断言错在哪」。
4. **别把"能跑"当"完成"**：`npm run build` 通过不等于通过；`npm run accept` 全绿才算。
5. **别猜路径**：域代码已搬到 `plugins/<id>/domain/`（旧 `electron/main/{work,marketing}/` 已删除），用 `_lib.mjs:workSrc()/mkSrc()/anySrc()` 而不是硬编码；`domainSrc()` 只剩历史兼容。
6. **别新增文档**：新计划/新规范先问；`doc/PLAN-4.1-DEBT.md` 与 `doc/PROGRESS-4.0.md` 已覆盖施工与日志。
7. **不确定就停**：涉及 `PLAN-4.0 §17` 硬规则的改动，先回报，不要自作主张。

---

## 12. 对抗审查纪律（2026-11-02 立，硬规则）

本仓库的改动**不得由同一个执行者自行放行**。以下两条是硬规则，违反即回退。

### 12.1 每个 commit 前必须有子代理对抗审查

流程固定为四步，不可跳步：

1. **执行者自测**：双 typecheck + 相关 accept + `npm run build`，贴真实输出。
2. **派子代理对抗审查**：把「改了什么 + 为什么 + 自测输出」交给独立子代理，要求它**主动找反例**——
   路径漏改、断言被改松、边界越界、行为回退、文档数字与实测不一致。
   指令里要写明「不要确认我做得对，找能推翻我的证据」。
3. **逐条处置**：子代理的每条意见给三态结论——「属实→已修（附改动）」/「前提不成立→附实测证据」。
   不接受「知道了但不改」。
4. **通过后才 commit**：提交信息里写清「对抗审查已过」与否决项处置结果。

**例外**：纯粹的提交信息错字修正可不走审查，但不得顺手夹带任何代码或文档内容改动。

### 12.2 每个工作包收尾必须有两次独立子代理检查

一个**工作包**（WP0–WP4）收尾时派**两次**子代理，两次**互不可见**（各自独立读仓库，不共享上下文）。
WP 内部的「阶段 A / 阶段 B」不单独触发这两次检查。

| 次序 | 检查什么 | 判据 |
| --- | --- | --- |
| 第一次 | **事实核对**：目标是否真的达成。逐条对比工作包的出口判据，自己跑命令取数字 | 每条判据都有实测证据，不接受「应该没问题」 |
| 第二次 | **对抗复核**：找这次改动引入的新问题——残留死代码、被绕过的断言、没被覆盖的分支、回退的能力 | 列出的问题必须逐条处置或明确接受 |

两次检查的结论都要写进 `doc/PROGRESS-4.0.md` 的阶段条目，**包括没被采纳的意见及理由**。

### 12.3 子代理的边界

- 子代理**只读**：不提交、不改文件、不跑 `git` 写操作。发现问题回报，由执行者改。
- 子代理要看**真实文件**，不接受执行者的口述摘要作为唯一依据。
- 子代理给出的结论必须带**可复查的命令或文件行号**，否则视为无效意见。

### 12.4 校验方法（本条也要可机械检查）

判据与命令分开放（命令里的 `|` 写进表格会把 GFM 表格拆坏）：

| # | 检查 | 判据 |
| --- | --- | --- |
| C1 | 提交带审查记录 | 每个非「纯提交信息修正」的提交，`%b` 里含 `对抗审查:` |
| C2 | 审查意见已处置 | `%b` 含 `属实` 或 `前提不成立`；审查无问题时写 `对抗审查: 无问题（<subagent runId>）` |
| C3 | 工作包两次检查入档 | 该包的 PROGRESS 条目里 `事实核对` 与 `对抗复核` 各至少一次 |

```powershell
# C1/C2（从基线起逐条看，而不是只看 HEAD）
git log 5cc072e..HEAD --format='--- %h%n%b' | Select-String '对抗审查|属实|前提不成立'
# C3
Select-String doc\PROGRESS-4.0.md -Pattern '事实核对|对抗复核'
```

> C3 对已经记为完成、但当时还没有这条规则的工作包（WP0）不算追溯红：在该包条目补一行「两次检查已补跑」即可。

---

## 13. 相关文档

- 架构契约：[PLAN-4.0.md](PLAN-4.0.md)
- 扩展性/第三方路线：[doc/PLAN-5.0-EXTENSIBILITY.md](doc/PLAN-5.0-EXTENSIBILITY.md)
- 当前欠账执行：[doc/PLAN-4.2.md](doc/PLAN-4.2.md)
- 欠账历史：[doc/PLAN-4.1-DEBT.md](doc/PLAN-4.1-DEBT.md)
- 施工日志：[doc/PROGRESS-4.0.md](doc/PROGRESS-4.0.md)
- 运维手册：[doc/RUNBOOK-4.0.md](doc/RUNBOOK-4.0.md)
- 合并仲裁：[doc/MERGE-INVENTORY.md](doc/MERGE-INVENTORY.md)
- 3.0 硬规则：[PLAN-3.0.md](PLAN-3.0.md)（§十三，4.0 继续沿用）
- 角色计划：[PLAN-FISH-CHARACTER.md](PLAN-FISH-CHARACTER.md)
