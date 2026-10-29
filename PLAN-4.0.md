# Umi Claw 4.0 插件化架构规划（PLAN-4.0 v1.0）

> 状态：草案（2026-10-29）｜基线：`release/1.0`（`fe5ac55`）克隆为 `release/4.0`
> 定位：以 1.0 为宿主（Host），把 2.0 营销域、3.0 工作域逐步做成**官方内置插件**，运行时加载、启停，但**不开放第三方插件安装**。
> 关联：`PLAN-2.0.md`、`PLAN-3.0.md`、`PLAN-VOICE.md`

## 〇、已拍板结论

1. **4.0 = 插件化宿主**，从 1.0 克隆；1.0 作为壳保留窗口、导航、设置、OpenClaw 管理、渠道、终端、Obsidian、技能、更新。
2. **只做官方内置插件**：插件随安装包分发，放在 `resources/plugins/`，宿主只加载 allowlist 内的插件。
3. **不做第三方安装**：不提供“从文件安装”、不做插件市场、不做签名/审核/沙箱；第三方代码只能按许可证 vendor 进仓库。
4. **运行时启停**：插件有 manifest、生命周期、独立路由/导航/IPC/DB；可在设置页启用/禁用、懒加载。
5. **先迁 3.0 工作域**，再迁 2.0 营销域；迁移前 2.0/3.0 分支作为参考实现保留。
6. **配置/密钥/OpenClaw 归宿主**：插件不直接写 `openclaw.json`，不直接持有密钥。

## 一、目标与非目标

### 1.1 目标

- 一套代码、一个安装包，通过官方插件组合出 1.0 / 2.0 / 3.0 的功能。
- 新功能以插件形式加入，不修改宿主核心；插件失效不影响宿主启动。
- 插件可独立启停、懒加载、拥有独立数据与迁移。
- 插件契约稳定，后续可平滑增加“鱼语音”“更多业务域”。

### 1.2 非目标

- 不做第三方插件市场/安装器/远程代码加载。
- 不做插件签名、权限弹窗、沙箱（官方插件默认可信）。
- 不要求插件独立升级；插件版本随宿主版本发布。
- 不重写 UI 框架；沿用 Vue3 + Pinia + vue-router。

## 二、1.0 基线现状（宿主抽取的起点）

| 维度 | 现状 | 插件化影响 |
| --- | --- | --- |
| 主进程 | `electron/main/index.ts` 平铺注册大量 IPC | 需要 IPC 注册器与插件路由 |
| preload | 静态 `api` 对象，`contextBridge` 一次暴露 | 不能动态加命名空间，需通用 `plugin.invoke` 桥 |
| 路由 | `src/renderer/main.ts` 静态 routes | 需要运行时路由注册 |
| 导航 | `src/App.vue` 静态 `navItems` | 需要运行时导航组注册 |
| 数据库 | 1.0 无 sqlite，语音用 JSON | 宿主需新增 DB 服务，插件各自 schema |
| 配置 | `configManager` 写 `openclaw.json` | 插件配置需命名空间 + 合并写入 |
| OpenClaw | `clawManager` 管理网关进程/环境变量 | 宿主统一服务，插件只调用 |
| 语音 | `fish/voice` 主进程 + `/voice` 页面 | 可先留宿主服务，后续考虑插件化 |

## 三、总体架构

```text
apps/host（4.0 壳）
├── kernel
│   ├── manifest.ts        # 清单解析/校验
│   ├── loader.ts          # 扫描/加载/激活/停用
│   ├── registry.ts        # 插件注册表 + 启停状态
│   ├── permissions.ts     # 内部权限/能力校验
│   └── version.ts         # hostApi 兼容检查
├── services
│   ├── configService      # 应用配置 + plugins.<id> 命名空间
│   ├── secretService      # safeStorage，按插件隔离
│   ├── dbService          # 每插件独立 SQLite + migration + 备份
│   ├── openClawService    # 网关/渠道/模型/TTS，唯一入口
│   ├── notificationService
│   ├── ttsService
│   └── logService
├── ipc
│   ├── hostIpc            # 窗口/配置/更新/插件管理
│   └── pluginBridge       # 通用 plugin:invoke
└── ui
    ├── routeRegistry
    ├── navRegistry
    └── pluginManagerPage

plugins/（官方内置）
├── work/                  # 3.0 工作域
├── marketing/             # 2.0 营销域
└── voice/                 # 可选，后续
```

### 3.1 进程模型（闭源方案）

- 官方插件默认在宿主主进程内运行（可信、低开销）。
- 每个插件 `activate/deactivate` 包 try/catch；失败只禁用该插件，不影响宿主。
- 预留 `utilityProcess` 适配接口，但 4.0 不启用（无第三方插件，不需要沙箱）。

### 3.2 插件目录

```text
resources/plugins/work/
├── plugin.json
├── main.mjs
├── renderer.mjs
├── migrations/
│   └── 001_init.sql
└── assets/
```

## 四、插件契约

### 4.1 manifest

```json
{
  "id": "work",
  "name": "工作域",
  "version": "1.0.0",
  "hostApi": "^4.0.0",
  "main": "main.mjs",
  "renderer": "renderer.mjs",
  "migrations": "migrations",
  "activation": ["onStartup"],
  "permissions": ["db", "openclaw", "notifications", "secrets"],
  "contributes": {
    "navGroup": { "id": "work", "label": "工作" },
    "routes": ["/work/today", "/work/records"],
    "settings": ["/work/settings"]
  },
  "defaultEnabled": false
}
```

规则：

- `id` 小写、稳定、不可变；用作 DB/schema/配置/日志前缀。
- `hostApi` 用 semver range；不兼容直接拒绝加载并提示。
- `permissions` 由内核校验；插件调用未声明能力返回 `PLUGIN_FORBIDDEN`。
- `defaultEnabled` 控制首次安装是否启用。

### 4.2 PluginContext

```ts
interface PluginContext {
  id: string
  version: string
  config: PluginConfig            // plugins.<id>.*
  db: PluginDb                    // 独立库 + migrate()
  secrets: PluginSecrets          // safeStorage，按插件命名空间
  openclaw: OpenClawService       // 网关/聊天/渠道/TTS
  notifications: NotificationService
  tts?: TtsService
  jobs: JobScheduler              // 随插件停用自动清理
  logger: PluginLogger
  registerIpc(method: string, handler: (payload: unknown) => Promise<unknown>): void
  registerRoutes(routes: PluginRoute[]): void
  registerNav(group: PluginNavGroup): void
  registerSettings(section: PluginSettingsSection): void
}
```

### 4.3 生命周期

```text
discovered → validated → migrated → activated → deactivated → disabled
```

- `activate(ctx)` 返回可选 `dispose()`；宿主在停用/退出时调用。
- `migrate()` 在 `activate` 前执行；失败则插件进入 `failed`，不加载 UI。
- 插件崩溃/激活超时：宿主记录错误、禁用插件、保留数据。
- 启停状态持久化在宿主设置中，不写进插件目录。

## 五、运行时加载

### 5.1 主进程

- 宿主只扫描 `resources/plugins/*`，读 allowlist（`plugins.builtin.json`），不扫描用户目录。
- 动态 `import()` 插件 `main.mjs`；ESM，external 宿主 SDK。
- 插件不能直接 `require('electron')`；通过 `PluginContext` 服务访问。

### 5.2 渲染端

- 自定义协议 `umi-plugin://<id>/renderer.mjs`，CSP 只允许该协议 + `blob:`（语音播放）。
- 插件 renderer 入口导出：

```ts
export default {
  routes: PluginRoute[],
  nav: PluginNavGroup,
  components: Record<string, Component>
}
```

- **Vue 不重复打包**：宿主提供 import map，`vue` / `vue-router` / `pinia` 映射到宿主已加载模块；插件构建时 external 这三项。
- 样式 scoped；共享 `ui-kit` 通过宿主导出；禁止全局样式。
- 插件页面懒加载；停用插件时卸载其路由/导航。

### 5.3 preload 通用桥

```ts
window.api.plugin = {
  invoke<T>(pluginId: string, method: string, payload?: unknown): Promise<T>
  on(pluginId: string, event: string, cb: (data: unknown) => void): () => void
}
```

- 宿主校验：插件存在、已启用、方法已注册、权限允许。
- 返回统一信封 `{ ok: true, data } | { ok: false, error }`。
- 不动态修改 `contextBridge` 暴露的 API；插件命名空间由 `pluginId` 参数隔离。

## 六、数据与迁移

### 6.1 隔离

- 每插件独立 SQLite：`<dataDir>/plugins/<id>/data.db`。
- 独立 `plugin_migrations` 表；插件自带 SQL/JS migration。
- 宿主 DB 服务负责连接池/懒加载/事务/备份；不共享表、不跨插件查询。
- 卸载默认归档数据目录，不立即删除。

### 6.2 现有域迁移

| 来源 | 目标 | 处理 |
| --- | --- | --- |
| 3.0 `work` 表/Manager | `plugins/work` | 建新 schema；旧库一次性导入；保留原表名映射 |
| 2.0 marketing 表/Manager | `plugins/marketing` | 同上 |
| 1.0 语音 `fish/voice` JSON | 宿主 `voice` 服务 | 先留宿主，后续可拆 `plugins/voice` |

迁移要求：幂等、可重入、失败可回滚；旧数据备份到 `backup/4.0-migration/`。

## 七、UI 与导航

- 宿主维护 `routeRegistry` / `navRegistry`；插件注册时合并，停用时移除。
- 导航组顺序由 manifest `contributes.navGroup.order` 控制；宿主保留“管理”组。
- 插件设置页通过 `registerSettings` 注入宿主设置页；也可自带 `/plugin/<id>/settings` 路由。
- 插件页面加载失败显示兜底页，不影响其他页面。
- 插件命令/快捷键通过 `contributes.commands` 注册。

## 八、配置、密钥、OpenClaw

### 8.1 配置

- 应用配置新增 `plugins.<id>`，按 manifest 的 JSON Schema 校验。
- 宿主合并写入；插件不得直接写 `openclaw.json`。
- 插件配置迁移随插件版本；卸载保留配置（可手动清理）。

### 8.2 密钥

- `safeStorage` 按 `plugin:<id>:<key>` 命名空间加密。
- 插件只拿到 `get/set/clear`，拿不到其他插件密钥。
- 密钥永不写日志/配置/导出包。

### 8.3 OpenClaw

- 宿主 `openclawService` 统一管理网关启动、环境变量、模型、渠道、TTS。
- 插件通过 `ctx.openclaw` 调用聊天/流式/渠道；不能自己 spawn 网关。
- `openclaw.json` 的写入由宿主串行化；`tts`/`mcp` 等块合并写入，保留用户已有字段（参见语音 `tts` 整段覆盖的教训）。

## 九、安全与边界

- **只加载 allowlist 内的内置插件**：`resources/plugins` + 清单哈希校验；用户目录不扫描。
- 不做“从文件安装”入口；插件管理页只展示/启停官方插件。
- 渲染端：`contextIsolation`、无 `nodeIntegration`、CSP 禁 `eval`/远程脚本。
- 主进程插件可信，但仍通过 `PluginContext` 限制能力；禁止直接 `fs`/`net` 访问（lint/评审约束）。
- 代码复用：MIT/Apache 可 vendor 并保留 NOTICE；GPL/AGPL 不复制；CC-BY-NC 素材不进商业包。
- 插件失败：超时/异常 → 禁用插件 + 记录错误 + 保留数据；宿主继续运行。

## 十、目录与构建

```text
umi-claw/
├── apps/host/                 # 1.0 壳迁入
├── packages/
│   ├── kernel/                # manifest/loader/registry/permissions
│   ├── plugin-sdk/            # main + renderer 类型/工具
│   ├── ui-kit/                # 共享组件/样式
│   └── services/              # config/db/openclaw/secrets/tts
├── plugins/
│   ├── work/
│   ├── marketing/
│   └── voice/
└── resources/plugins/         # 构建产物 + builtin 清单
```

构建：

- 宿主 `electron-vite` 主/预加载/渲染三入口。
- 插件独立构建：`main.mjs` + `renderer.mjs` + manifest + migrations。
- 插件构建 external：`electron`、`vue`、`vue-router`、`pinia`、`@umi/plugin-sdk`。
- 打包：`extraResources` 拷贝 `resources/plugins`；安装包只含官方插件。

## 十一、迁移路径

### Phase 0：契约与 Demo（约 1 周）

- 本文定稿；`PLAN-4.0.md` 冻结。
- 建 `packages/kernel`、`packages/plugin-sdk`、`plugins/hello`。
- `hello` 验证：manifest、activate、1 条 IPC、1 个路由/导航、1 个 migration、启停。
- 验收：宿主启动 + hello 启用/停用；插件异常不崩宿主。

### Phase 1：Host 抽取 + 运行时（3–4 周）

- 从 1.0 抽 `config/openclaw/notifications/tts/logs/window` 服务。
- 实现 loader/lifecycle/启用状态/懒加载。
- 通用 `plugin:invoke` 桥 + preload SDK。
- 宿主 DB 服务 + 每插件独立库/migration/备份。
- 路由/导航注册 + 插件协议 + import map。
- 验收：hello 插件全链路；宿主无插件也能启动。

### Phase 2：3.0 work 插件化（2–3 周）

- 迁 16 个 Manager、DB schema、IPC、页面、测试到 `plugins/work`。
- 宿主提供 work 所需服务适配（db/openclaw/notifications）。
- 验收：3.0 全部页面/功能通过；插件启停后路由/导航正确增删；数据迁移幂等。

### Phase 3：2.0 marketing 插件化（2–3 周）

- 迁 marketing 域；插件管理页（官方插件列表/启停/详情/错误）。
- 验收：2.0 核心链路；两个插件同时启用无冲突。

### Phase 4：加固与打包（1–2 周）

- 插件失败隔离、启动耗时、懒加载、日志。
- 安装包三平台冒烟；插件资源路径；升级/回滚。
- 全量 E2E + 插件契约测试。

## 十二、成本与 Token

| 阶段 | 人天 | Token 估算 |
| --- | --- | --- |
| Phase 0 | 5–7 | 10–30 万 |
| Phase 1 | 15–20 | 150–300 万 |
| Phase 2 | 12–18 | 100–200 万 |
| Phase 3 | 10–15 | 80–150 万 |
| Phase 4 | 5–8 | 50–100 万 |
| **合计** | **47–68 人天** | **400–800 万** |

单人约 2.5–3.5 个月；两人约 1.5–2 个月。Token 为 AI 辅助开发的量级估算，随返工/会话数浮动。

## 十三、验收标准

1. 宿主不加载任何插件可正常启动；插件目录缺失/损坏不影响启动。
2. 官方插件可启用/禁用；停用后路由、导航、IPC、后台任务全部卸载。
3. 插件异常/超时只禁用自身，宿主继续运行并显示错误。
4. 每插件独立 DB；migration 幂等；备份/恢复可用；卸载归档数据。
5. 插件配置命名空间正确；密钥互不可见；`openclaw.json` 不被插件直接写。
6. 插件 renderer 动态加载；Vue 单实例；CSP 无 `eval`/远程脚本。
7. 打包后 `resources/plugins` 路径正确；插件清单哈希校验通过。
8. 不存在用户目录插件扫描/安装入口；第三方插件无法被加载。
9. 3.0/2.0 迁移后核心链路 e2e 通过；原分支数据可导入。
10. 全部插件契约测试 + 宿主回归通过。

## 十四、风险

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 渲染端动态模块/CSP/import map 复杂 | 高 | Phase 0 先做 hello 插件验证；Vue external + 协议加载 |
| DB schema/migration 迁移失败 | 高 | 独立库 + 幂等 migration + 备份/回滚 |
| 宿主抽取范围失控 | 中 | 只抽服务，不重写业务；插件适配层薄 |
| 插件停用残留（IPC/定时器/路由） | 中 | 统一 dispose；注册器反注册；E2E 启停测试 |
| 配置/密钥越权 | 高 | PluginContext 只暴露命名空间；lint 禁直接 fs/openclaw.json |
| 打包/升级插件路径 | 中 | extraResources + 清单哈希 + 三平台冒烟 |
| 迁移期双维护 | 中 | 2.0/3.0 冻结为参考实现，只修 P0 bug |

## 十五、开放问题

1. 4.0 默认启用哪些插件？工作域、营销域、语音是否默认关？
2. 插件是否允许“随宿主版本独立更新”？当前规划为否。
3. 语音（fish/voice）留宿主服务，还是做成 `plugins/voice`？
4. 2.0/3.0 旧数据迁移是一次性导入还是保留只读？
5. 是否需要在 4.0 内保留 1.0 的“无插件模式”作为安全模式？

---

4.0 的第一原则：**宿主稳定、插件可启停、失败可隔离、数据可迁移**。先做 Phase 0/1，再迁业务；不要一上来同时改宿主和两个域。
