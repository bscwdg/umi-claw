# Umi Claw 4.0 插件化架构规划（PLAN-4.0 v1.1）

> 状态：v1.1 修订（2026-10-30）｜基线：**改为 `release/3.0`（`5f578e3`）合并 `release/2.0`（`4410888`）后的单体**，见 §〇.5；v1.0 的「以 1.0 为基线、分别迁 2.0/3.0」作废
> 定位：以「合并后的单体」为宿主（Host），把 2.0 营销域、3.0 工作域做成**官方内置插件**，运行期启停，但**不开放第三方插件安装**。
> 配套：冲突清单与仲裁依据 `doc/MERGE-INVENTORY.md`；v1.1 变更说明见 §十六
> 关联：`PLAN-2.0.md`、`PLAN-3.0.md`、`PLAN-VOICE.md`

## 〇、已拍板结论

1. **4.0 = 插件化宿主**，基线改为 **3.0 merge 2.0 后的单体**（§〇.5）；1.0 的壳能力（窗口、导航、设置、OpenClaw 管理、渠道、终端、Obsidian、技能、更新）作为宿主能力全部保留。
2. **只做官方内置插件**：插件代码随宿主构建进安装包（`plugins/` 源码目录），`resources/plugins/` 只放 manifest 与 migrations；宿主只认构建期登记过的插件。
3. **不做第三方安装**：不提供“从文件安装”、不做插件市场、不做签名/审核/沙箱；第三方代码只能按许可证 vendor 进仓库。
4. **运行时启停**：插件有 manifest、生命周期、独立路由/导航/IPC/DB；可在设置页启用/禁用、懒加载。
5. **先合再拆**：Phase 0.5 先做基线合并（3.0 ← 2.0），再做插件化；迁移顺序改为「合并 → kernel → work 装箱 → marketing 装箱」。
6. **配置/密钥/OpenClaw 归宿主**：插件不直接写 `openclaw.json`，不直接持有密钥。
7. **渲染端不做运行时动态加载**：插件 UI 构建期装配，运行期只注册/注销路由、导航、插槽（§5.2）。v1.0 里唯一评级「高」的风险项由此消除。
8. **插件粒度按能力切，不按域切**：`db` / `gateway` / `knowledge` / `context` / `voice` 先下沉为宿主服务，域插件只 `inject`（§4.1）。
9. **信任边界按「官方内置」定级**：不做 permissions 校验、清单哈希、插件沙箱；只保留三条真收益的约束——能力必须经 `ctx`、密钥必须经宿主、迁移前必须备份（§9）。
10. **继承 3.0 的硬规则体系**：`PLAN-3.0.md §十三` 的硬规则（契约先于代码 = 11、accept 先断言后实现 = 13、禁新增状态表 = 24 等）对 4.0 继续有效，4.0 另加三条本文件硬规则（§十七）。

## 〇.5、起点与合并策略（v1.1 新增）

### 0.5.1 为什么换基线

2.0 与 3.0 同源于 `27b4b82`（2026-09-15），各自 47 / 52 个提交。两条分支**各自实现过同一套宿主服务**：`electron/main/database/*`、`gatewayClient.ts`、`ipc/*`、`subprocessRegistry.ts`、`resources/database/db-worker.mjs`。以 1.0 为基线做 4.0，等于第三次实现这套服务，并把两条分支的和解工作摊进两次「域迁移」。

### 0.5.2 实测（2026-10-30，临时 worktree 试跑，未改动任何 `release/*`）

| 合并 | 冲突文件 | 冲突块 | 说明 |
| --- | --- | --- | --- |
| 1.0 ← 2.0 | 19 | — | 11 个是 `fish/voice/*`：两分支其实已一致，纯属基线选错带来的假冲突 |
| 1.0 ← 3.0 | 18 | — | 同上 |
| **3.0 ← 2.0** | **27** | **168** | voice 零冲突；129 块落在数据库/网关层及其验收测试（实现 50 + 测试 79） |

补充事实：

- 27 个冲突中 **14 个是 AA（add/add）**：`database/{database,errors,migration,schema}.ts`、`gatewayClient.ts`、`ipc/{index,gateway}.ts`、`subprocessRegistry.ts`、`db-worker.mjs`、`test/{db-client,db-worker,gateway,context,knowledge}.accept.mjs`、`test/_lib.mjs`。**两边独立创建了同名文件——这 14 个路径就是宿主服务的候选边界。**
- 合并会带进 2.0 的 95 个新文件：`electron/main/marketing/*` 7313 行、`src/views/marketing/*` 3054 行、`resources/collector/*` 381 行、10 个验收脚本。
- 回归网规模：3.0 有 22 个 `test/*.mjs` + `scripts/run-all-accept.mjs`；2.0 有 27 个（无总入口）。合并后应收敛成一个 `npm run accept`。

### 0.5.3 结论

1. **起点定为 3.0**（不是 1.0）：省掉 11 个假冲突，白得 `ipc/` 聚合骨架、DB 服务、`gatewayClient`。
2. **合并冲突的分布即宿主服务边界**：168 块里 129 块集中在 db/gateway，这正是 v1.0 Phase 1「凭想象抽服务」要产出的东西，现在有两个真实实现可以对照。
3. **先合再拆**：Phase 0.5 产出一个能跑的单体，之后每一阶段都有可发布产物，而不是在「宿主重建 + 两个域迁移」三线并行里等三个月。

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

## 二、起点现状（合并后的单体，v1.1 修订）

| 维度 | 合并后现状 | 4.0 要做的 |
| --- | --- | --- |
| 主进程 | `electron/main/index.ts` 约 1900 行 / 60+ 通道平铺，另有 `ipc/` 聚合入口 | 抽 service 容器 + 插件通道命名空间；把域逻辑移出宿主 |
| preload | 268 行手写命名空间对象；`index.d.ts` 仅 9 行 | 构建期生成类型；通道改 `plugin:<id>:<method>` |
| 路由 | `src/renderer/main.ts` 静态 11 条 | 构建期 registry + 运行期注册/注销 |
| 导航 | `src/App.vue` 静态 `navItems` 10 条 | `navRegistry` + 插槽；停用即隐藏 |
| 数据库 | 已有 `database/` + `db-worker.mjs`（`node:sqlite`，单例子进程） | 抽成 `dbService`；每插件独立库 + 独立 migration 表 |
| 配置 | `configManager` 写 `openclaw.json` | 命名空间 + 合并写入；**单写入口** |
| OpenClaw | `clawManager` + `gatewayClient.ts` | 收敛为 `openclawService`，插件只调用 |
| 语音 | `fish/voice` 主进程 + `/voice` 页面 | 留宿主，作为跨域能力 `inject` 给域插件 |

## 三、总体架构

```text
electron/main（4.0 宿主，单包内）
├── kernel
│   ├── manifest.ts        # 清单解析/校验（读 resources/plugins/*/plugin.json）
│   ├── registry.ts        # 插件注册表 + 启停状态 + 入口表（构建期生成）
│   ├── lifecycle.ts       # activate/deactivate/dispose，LIFO 清理
│   └── capabilities.ts    # 能力版本校验（不走 semver）
├── services
│   ├── configService      # 应用配置 + plugins.<id> 命名空间
│   ├── secretService      # safeStorage，按插件命名空间
│   ├── dbService          # 每插件独立库 + 独立 schema + worker 参数化 + 备份
│   ├── openClawService    # 网关/渠道/模型/TTS，唯一入口（单例）
│   ├── notificationService
│   ├── voiceService       # fish/voice，跨域能力
│   └── logService
├── ipc
│   ├── hostIpc            # 窗口/配置/更新/插件管理
│   └── pluginIpc          # plugin:<id>:<method> 命名空间 + 构建期生成的类型
└── index.ts               # 只做组装：注册服务 → 按启用状态激活插件

src/renderer
├── routeRegistry / navRegistry / slotRegistry
├── plugins.generated.ts   # 构建期生成（静态 import 入口）
└── pluginManagerPage

plugins/（官方内置，同仓源码目录）
├── work/                  # 3.0 工作域
└── marketing/             # 2.0 营销域
```

### 3.1 进程模型（闭源方案）

- 官方插件默认在宿主主进程内运行（可信、低开销）。
- 每个插件 `activate/deactivate` 包 try/catch；失败只禁用该插件，不影响宿主。
- 预留 `utilityProcess` 适配接口，但 4.0 不启用（无第三方插件，不需要沙箱）。

### 3.2 插件目录

```text
resources/plugins/work/        # 只放数据，不含可执行代码
├── plugin.json
├── migrations/
│   └── 001_init.sql
└── assets/

plugins/work/                  # 源码参与宿主构建
├── main.ts                    # activate/deactivate
├── renderer.ts                # routes / nav / slot / setup
└── migrations/                # 与 resources 下的保持同源（构建期拷贝）
```

## 四、插件契约

### 4.1 manifest

```json
{
  "id": "work",
  "name": "工作域",
  "version": "1.0.0",
  "capabilities": ["host.fs.v1", "host.ui.slot.v1"],
  "migrations": "migrations",
  "activation": ["onStartup"],
  "inject": ["db", "openclaw", "notifications", "secrets"],
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
- `capabilities` 用**能力版本**而不是宿主 semver：宿主 4.1 加字段不该让插件失效。缺失能力 → 拒绝加载并给出明确文案。
- `inject` 是**依赖声明**而不是权限申请：插件只能拿到自己 inject 的服务（对应 §3 的 service 容器），未 inject 的调用返回 `SERVICE_NOT_INJECTED`。不设 `permissions` 白名单——官方插件可信，白名单只增加维护成本。
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

## 五、加载方式（v1.1：构建期装配，运行期只做启停）

### 5.1 主进程

- 插件代码**构建期**打进 `dist-electron`，由生成的 `plugins.main.generated.ts` 提供入口：`work: () => import('../../plugins/work/main')`。
- 随安装包分发的只有**数据**：`resources/plugins/<id>/plugin.json` + `migrations/`；**没有可执行代码**从 `resources` 加载，也不扫描用户目录。
- 启动时读 manifest → 按启用状态 `import()` 入口 → `activate(ctx)`；入口失败只禁用该插件。
- 插件不能直接 `require('electron')`；只能通过 `PluginContext` 拿到 `inject` 的服务。

### 5.2 渲染端（v1.1 改为构建期装配）

- 插件 renderer 入口是普通 ES 模块，**构建期**打进宿主 `renderer` 产物，不做运行时远程加载：

```ts
export default {
  routes: PluginRoute[],
  nav: PluginNavGroup,
  slot: Record<string, Component>,   // 注册到宿主插槽（侧栏/设置页/详情页）
  setup(ctx: PluginUiContext): () => void   // 返回清理函数
}
```

- 宿主用脚本在构建期扫描 `plugins/*/plugin.json`，生成 `src/renderer/plugins.generated.ts`：

```ts
export const pluginUiEntries = {
  work: () => import('../../plugins/work/renderer'),
  marketing: () => import('../../plugins/marketing/renderer')
}
```

- 运行期只做三件事：按启用状态注册/注销路由与导航组；把 `slot` 里的组件挂到宿主插槽；调用 `setup()` 并在停用时执行其返回值。
- 收益：Vue/Pinia 单实例天然成立，不需要 import map、不需要 `umi-plugin://` 协议、CSP 不变；HMR、sourcemap、类型、断点全部保留。
- 逃生门：`pluginUiEntries` 每个 entry 都是 `() => import()`，将来真要运行时加载，只替换这一层，插件代码不动。
- 样式 scoped；共享 `ui-kit` 通过宿主导出；禁止全局样式；插件页面懒加载，停用即卸载。

### 5.3 preload 与通道（v1.1：类型化命名空间）

```ts
// 生成物，不是手写
export interface UmiApi {
  work: { records: { list(q: Query): Promise<Record[]>; create(r: NewRecord): Promise<Id> } }
  marketing: { hot: { refresh(): Promise<HotList> } }
  // ...
}
```

- 通道名固定为 `plugin:<id>:<method>`，由插件 `defineIpc({...})` 声明，构建期生成 d.ts 与白名单；宿主只做两次校验（插件已启用、method 已注册）。
- 不做通用 `plugin:invoke(pluginId, method, payload)` 反射桥：会丢类型、丢定位、丢参数校验，通道从 60 涨到 200 后无法维护。
- 返回统一信封 `{ ok: true, data } | { ok: false, error }`，错误码沿用 `database/errors.ts` 的 `AppError` 体系。
- 事件（流式/进度）走 `plugin:<id>:<event>`，`on()` 返回取消订阅函数，随插件停用自动清理。

## 六、数据与迁移

### 6.1 隔离（v1.1：每插件一套 schema，不是一套 schema 装所有域）

实测事实（见 `doc/MERGE-INVENTORY.md` §四）：work 域 8 表、marketing 域 11 表，**只有 `app_meta` 重叠**；`knowledge` 与 `knowledge_items` 是同义改名。所以「宿主一套 schema + 插件各自加表」在这个仓库不成立。

- 每插件独立 SQLite 文件 + **独立 schema + 独立 TABLES 白名单**；`db-worker` 参数化为 `--db <path> --schema <id>`。这是 Phase 0.5 的前置改造（R2），不是 Phase 1 的优化。
- 独立 `plugin_migrations` 表与版本序列：不再共用 `user_version`（当前两代都把 v2 用在完全不同的 DDL 上，直接撞车）。
- 宿主 DB 服务负责 worker 生命周期/事务/迁移前快照；不跨插件查询。
- 卸载默认归档数据目录，不立即删除。

### 6.2 现有域迁移

| 来源 | 目标 | 处理 |
| --- | --- | --- |
| 3.0 `work` 表/Manager | `plugins/work` | 建新 schema；旧库一次性导入；保留原表名映射 |
| 2.0 marketing 表/Manager | `plugins/marketing` | 同上 |
| 1.0 语音 `fish/voice` JSON | 宿主 `voice` 服务 | 先留宿主，后续可拆 `plugins/voice` |

迁移要求：幂等、可重入、失败可回滚；旧数据备份到 `backup/4.0-migration/`。

## 七、UI 与导航

- 宿主维护 `routeRegistry` / `navRegistry` / `slotRegistry`；插件注册时合并，停用时移除。
- 导航组顺序由 manifest `contributes.navGroup.order` 控制；宿主保留“管理”组。
- 插件设置页通过 `registerSettings` 注入宿主设置页；也可自带 `/plugin/<id>/settings` 路由。
- **细粒度插槽优先**：一个页面内的区块（侧栏、详情面板、设置分区）用 `slot` 注册，不要各自贡献整棵路由树；停用一个插件不应导致导航结构重排。
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

## 九、安全与边界（v1.1 按「官方内置」定级）

- **只加载构建期登记的插件**（`plugins.*.generated.ts`）：不扫描用户目录、不提供“从文件安装”、加载不到未登记代码。
- ~~清单哈希校验、permissions 白名单、`PLUGIN_FORBIDDEN`~~ → 降为 P2：对官方可信代码边际收益≈0，维护成本持续。
- 保留的三条硬约束：① 能力只能经 `ctx`（lint 禁 `import electron/fs`）；② 密钥只能经宿主（目的是卸载不泄漏）；③ 迁移前必须备份。
- 渲染端：`contextIsolation`、无 `nodeIntegration`、CSP 禁 `eval`/远程脚本（不新增自定义协议，CSP 反而更简单）。
- 代码复用：MIT/Apache 可 vendor 并保留 NOTICE；GPL/AGPL 不复制；CC-BY-NC 素材不进商业包。
- 插件失败：超时/异常 → 禁用插件 + 记录错误 + 保留数据；宿主继续运行。

## 十、目录与构建（v1.1：单包 + 目录约定，不迁 monorepo）

```text
umi-claw/                       # 保持单个 package.json（延续 1.0/2.0/3.0 的构建链）
├── electron/main/
│   ├── services/               # 能力层：db / gateway(openclaw) / config / secrets / voice / log
│   ├── kernel/                 # manifest / registry / lifecycle / 通道注册器
│   └── index.ts                # 只做组装：注册服务 + 启动插件
├── plugins/
│   ├── work/                   # main.ts + renderer.ts + plugin.json + migrations/
│   └── marketing/
├── resources/plugins/<id>/     # 只放 plugin.json + migrations（数据，不含代码）
└── src/renderer/plugins.generated.ts   # 构建期生成
```

构建：

- 沿用 `electron-vite` 三入口；插件作为源码目录参与同一个构建（不单独出一套打包配置）。
- 插件代码进入 `dist-electron` / `renderer` bundle；`resources/plugins` 只承载 manifest 与 migration。
- 不迁 pnpm workspace：合并期同时改包管理器 + 构建链，是把两个高风险叠在一起；等 Phase 2 后再评估。
- 打包：`extraResources` 只拷 manifest/migrations；安装包内没有可执行插件代码。

## 十一、迁移路径

### Phase 0.5：基线合并（v1.1 新增，3–5 人天）｜✅ 已完成（2026-10-30）

**结果**：`release/4.0` 已并入 3.0+2.0 合并基线（`1d9bff4`），并补齐多 schema 数据层（`55fdaae`）。
`typecheck` node/web 均 0 错；`npm run build` 通过；17 套验收 **291 项全绿**（db 38 / gateway 29 / work 20 / ui 17 / context.work 12 / knowledge.work 10 / context.marketing 22 / knowledge.marketing 23 / project 18 / business 16 / content 12 / advisor 10 / hot 16 / hotscore 14 / scan 18 / platform 7 / shooting 9）。详见 `doc/MERGE-LOG.md`。

原始计划（保留作记录）：

目标：`merged/4.0-base` = 3.0 + 2.0，单体可跑、可发布。

- 在 worktree 里 `merge release/2.0`（3.0 为 ours），按 `doc/MERGE-INVENTORY.md` 的仲裁规则处理 27 个冲突 / 168 个冲突块。
- **先定规则再动手**（R1–R5，见清单 §二）；执行顺序按清单 §九：A 类 → B 数据库 → C 网关 → D 接线 → E 测试。
- 两处必须在合并期一并解决的结构问题：① `db-worker` 参数化（每库一套 schema + 白名单，R2）；② `registerGatewayIpc` 参数化并保两套通道常量（否则后注册者静默覆盖前者）。
- 三个真互斥点按清单 §七处理：voice 初始化块（并存会因 `fish:voice:*` 二次注册启动崩溃）、`Setup.vue` 的 `goToDashboard`（向导接续 + reload 各要一半）、`App.vue` 导航模型（二选一）。
- 顺手修一个 3.0 现存缺陷：`forwardGatewayStream` 的 `handle.result.catch(() => null)` 会把「解析/落库失败」伪装成成功 done（2.0 的 A1 修复），本阶段搬回来。
- 版本统一 4.0.0；`package-lock.json` 用 `npm install` 重生成，不手工合并。
- 测试入口收敛：`npm run accept` = 3.0 的 22 个 + 2.0 的 27 个验收脚本；5 个 add/add 的同名脚本必须拆文件并改键（R5），`scripts/run-all-accept.mjs` 的显式数组同步。
- 验收四件：双 typecheck 绿；`npm run accept` 绿；1.0 全链路（启动/配置/终端/Obsidian/语音）；work 与 marketing 各一条最深链路（记录→今日；热榜→内容）。
- **判据**：5 人天内跑不通 → 停插件化，回到「从 1.0 重建」并重估（§14 风险首行）。

### Phase 0：契约与 Demo（3–5 人天）｜✅ 已完成（2026-10-30）

**落地**（提交 `cb671db`）：

| 文件 | 作用 |
| --- | --- |
| `electron/main/kernel/manifest.ts` | 清单校验（id / 版本 / **能力版本** / 路由前缀），错误带 `field` |
| `electron/main/kernel/registry.ts` | 注册表 + 能力检查 + 启停状态（持久化可注入） |
| `electron/main/kernel/lifecycle.ts` | activate/deactivate、disposer **LIFO** 清理、失败隔离、激活超时 |
| `electron/main/kernel/discovery.ts` | 只扫构建期登记过的 id；坏清单只标记不抛 |
| `electron/main/kernel/stateStore.ts` | `<dataDir>/plugins-state.json` |
| `scripts/gen-plugin-entries.mjs` | 扫 `plugins/*/plugin.json` → 生成两端入口表 + 拷贝清单到 `resources/plugins` |
| `plugins/hello/` | 演示插件：2 条 IPC + 1 个定时任务 + 1 条路由 + 1 个导航组 |
| `src/renderer/pluginUi.ts` | 渲染端注册表（路由/导航/插槽的安装与卸载） |
| `test/plugin.accept.mjs` | 26 项：清单/能力/激活/停用 LIFO/失败隔离/重复 id/坏清单/超时/迟到注册/停用竞态/幂等/真 hello/UI 归属与路由冲突 |
| `electron/preload/index.ts` | `api.plugins.{list,setEnabled,invoke,onChanged}`；`invoke` 即 `plugin:<id>:<method>` |

**验收**：`npm run build` 通过；hello 代码进 bundle 而 `resources/plugins/hello/` 只有 `plugin.json`；`plugin.accept` **26/26**。

**审查与对抗修复**（`95a54a2`）：一轮代码审查 + 一轮对抗测试后修掉 4 类真问题——①激活超时后插件仍在跑（closed 标记 + 迟到注册一律拒绝）②停用竞态与重复 enable（幂等短路 + 关闭在途激活尝试）③UI 导航/插槽按名整体删除导致插件互删（改为按 owner 归属合并，路由名/路径冲突直接拒绝安装）④清单级失败只 console、管理页看不见（进 `plugin:list`，带 code + stage）。

原始计划（保留作记录）：

- 本文定稿；`PLAN-4.0.md` 冻结。
- 建 `electron/main/kernel`、`electron/main/services`、`plugins/hello`（不迁 monorepo，见 §10）。
- `hello` 验证：manifest、activate、1 条 IPC、1 个路由/导航、1 个插槽、1 个 migration、启停。
- 验收：宿主启动 + hello 启用/停用；插件异常不崩宿主。

### Phase 1：Kernel 与运行时（1.5–2 周）｜✅ 已完成（2026-10-30，plugin 53/53）

- 把合并产物里的 `database` / `gatewayClient` / `ipc` / `voice` 抽成 service 容器接口（能力下沉，见 §4.1 `inject`）。
- 实现 registry / lifecycle / 启用状态 / 懒加载 + 构建期清单生成（`plugins.generated.ts`）。
- 路由/导航/插槽注册与反注册；`plugin:<id>:<method>` 命名空间 + 构建期生成 preload 类型。
- 宿主 DB 服务统一入口：每插件独立库 / migration / 备份（复用 3.0 的 `db-worker` 与迁移版本表）。
- 验收：hello 插件全链路；宿主零插件也能启动；停用后路由、导航、插槽、定时器全部卸载。

### Phase 2：work 装箱（1.5–2 周）｜✅ 已完成（2026-10-30，含 R1–R22 修复）

- 迁 17 个 `work/*` 模块、DB schema、`ipc/work.ts` 通道、9 个页面、22 个验收脚本到 `plugins/work`。
- 宿主提供 work 所需服务适配（db/openclaw/notifications）。
- 验收：3.0 全部页面/功能通过；插件启停后路由/导航正确增删；数据迁移幂等。

### Phase 3：marketing 装箱（1.5–2 周）｜✅ 已完成（2026-10-30，含 R23–R28 修复）

- 迁 `marketing/*` 14 个模块、`ipc/{marketing,hot,content,advisor,scan}.ts`、7 个页面、collector 资源。
- 插件管理页（官方插件列表/启停/详情/错误）。
- 验收：2.0 核心链路；两个插件同时启用无冲突。

### Phase 4：加固与打包（1 周）｜✅ 自动化完成（2026-10-30）：故障隔离/并行启动/打包产物核对全绿；仅 NSIS 真机安装待人工（RUNBOOK §6）

- 插件失败隔离、启动耗时、懒加载、日志。
- 安装包三平台冒烟；插件资源路径；升级/回滚。
- 全量 E2E + 插件契约测试。

## 十二、成本与 Token

| 阶段 | 人天 | Token 估算 |
| --- | --- | --- |
| Phase 0.5 基线合并 | 3–5 | 100–250 万 |
| Phase 0 契约与 Demo | 3–5 | 100–250 万 |
| Phase 1 Kernel 与运行时 | 8–10 | 300–550 万 |
| Phase 2 work 装箱 | 8–10 | 300–550 万 |
| Phase 3 marketing 装箱 | 8–10 | 300–550 万 |
| Phase 4 加固与打包 | 5–7 | 150–350 万 |
| **合计** | **35–47 人天** | **1250–2500 万** |

口径说明（v1.1 校准）：

- 人天比 v1.0（47–68）低，是因为「合并」把 2–3 周的宿主重建压到 3–5 天；但 Token 比 v1.0（400–800 万）高——v1.0 那个数等于假设「一次写对、不返工」，实际每块冲突仲裁都要同时读两个实现。
- 换算法：按 **1 人天 ≈ 35–60 万 token**（含读旧代码、返工、验收）反推，比按阶段拍脑袋可靠。
- 单人约 2–3 个月，两人约 1–1.5 个月。Phase 0.5 若判停，已投入 ≤ 总预算的 5%。

## 十三、验收标准

1. 宿主不加载任何插件可正常启动；插件目录缺失/损坏不影响启动。
2. 官方插件可启用/禁用；停用后路由、导航、IPC、后台任务全部卸载。
3. 插件异常/超时只禁用自身，宿主继续运行并显示错误。
4. 每插件独立 DB；migration 幂等；备份/恢复可用；卸载归档数据。
5. 插件配置命名空间正确；密钥互不可见；`openclaw.json` 不被插件直接写。
6. 插件 renderer 动态加载；Vue 单实例；CSP 无 `eval`/远程脚本。
7. 打包后 `resources/plugins` 只含 manifest 与 migrations；构建期入口表与 manifest 一致；插件代码不在 `resources` 下。
8. 不存在用户目录插件扫描/安装入口；第三方插件无法被加载。
9. 3.0/2.0 迁移后核心链路 e2e 通过；原分支数据可导入。
10. 全部插件契约测试 + 宿主回归通过。

## 十四、风险

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 3.0←2.0 合并不收敛（同服务双实现的语义冲突） | 高 | Phase 0.5 设 5 人天判据；先定 4 条仲裁规则；依据 `doc/MERGE-INVENTORY.md` |
| 合并期功能回退（voice / 提醒 / 外发等已在用链路） | 高 | 44 个 accept 脚本当回归网；先让 accept 绿再动 UI |
| DB 依赖 `node:sqlite`（Electron 30 自带 Node 20 没有它） | 高 | 写进宿主依赖清单；启动自检 + 明确错误码；备选 `better-sqlite3` + rebuild |
| 渲染端运行时动态加载 | — | **v1.1 已移除**（改构建期装配），风险关闭 |
| DB schema/migration 迁移失败 | 中 | 独立库 + 幂等 migration + 迁移前备份（沿用 3.0 `db-worker` 机制） |
| 插件停用残留（IPC/定时器/路由/插槽） | 中 | `register*` 一律返回 disposer，注册表 LIFO 清理；E2E 启停测试 |
| 能力越界（直接 fs / 直写 `openclaw.json`） | 中 | `ctx` 只暴露服务；lint 禁 `import electron/fs`；`openclaw.json` 单写入口 |
| 打包/升级插件路径 | 中 | `extraResources` + 三平台冒烟（清单哈希校验降为 P2） |
| 迁移期双维护 | 低 | 合并后不再双维护；2.0/3.0 冻结，只修 P0 |

## 十五、开放问题（v1.1 已定）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 4.0 默认启用哪些插件 | 迁移即继承用户当前分支的使用状态；新安装默认只启用宿主 + `work`，`marketing` 默认关 |
| 2 | 插件是否随宿主独立更新 | 否。但 manifest 用**能力版本**（`capabilities`）而非宿主 semver，宿主加字段不该让插件失效 |
| 3 | 语音留宿主还是做 `plugins/voice` | 留宿主服务。理由不是"简单"，而是它已经是跨域能力（work 播报、marketing 配音都要用），一旦装箱必然被复制 |
| 4 | 2.0/3.0 旧数据怎么迁 | 一次性导入 + 原库只读保留一个版本；不双写、不长期并存 |
| 5 | 是否保留 1.0「无插件模式」 | 不作为产品开关，降级为 Phase 1 验收项：宿主零插件可启动 |

## 十六、变更记录

| 版本 | 日期 | 要点 |
| --- | --- | --- |
| v1.0 | 2026-10-29 | 插件化架构初稿；以 1.0 为基线 |
| v1.1 | 2026-10-30 | ①**换基线**：3.0（`5f578e3`）+ merge 2.0（`4410888`），新增 §〇.5 与 Phase 0.5；②**渲染端改为构建期装配**（§5.2），移除 import map / `umi-plugin://` / Vue external，风险表对应项关闭；③**manifest 契约改 `capabilities` + `inject`**，去掉 `hostApi` semver 与 `permissions` 白名单（§4.1）；④**插件粒度按能力切**：db/gateway/knowledge/context/voice 先下沉，域插件只 inject；⑤**成本校准**：35–47 人天 / 1250–2500 万 token，口径见 §十二；⑥**开放问题 5 项全部定稿**；⑦继承 3.0 硬规则并新增 4.0 硬规则（§十七）；⑧配套 `doc/MERGE-INVENTORY.md`（27 文件 / 168 冲突块的归类与仲裁） |

## 十七、硬规则（v1.1 新增，违反任一条 → 停下来重新评估）

1. **基线只认合并产物**：4.0 的宿主来自 `merged/4.0-base`，不得再从 1.0/2.0/3.0 任一分支直接抽代码绕过合并。
2. **插件只经 `ctx` 访问宿主**：禁止 `import` 宿主内部模块、禁止直接 `require('electron')`、禁止直写 `openclaw.json`（lint 守）。
3. **渲染端插件 UI 必须构建期装配**：禁止运行时从磁盘/网络加载可执行模块。
4. **同名能力第二次出现即下沉**：第二个域需要同一能力时，先提升为 `services/*`，禁止复制（`contextEngine` / `knowledgeManager` 已各存在两份，是反面样本）。
5. **契约先于代码**（继承 `PLAN-3.0.md` 硬规则 11）：新增 IPC 通道、插件贡献点，先改本文再动实现。

---

4.0 的第一原则：**宿主稳定、插件可启停、失败可隔离、数据可迁移**。

顺序上只有一句：**先合（Phase 0.5）→ 再定契约（Phase 0）→ 再装箱（Phase 2/3）**。合并是刚性成本，不合并就得永远双写；插件化是投资，回报在第四个域之后才出现。先把刚性成本付掉，每一步都留一个能发布的产品。