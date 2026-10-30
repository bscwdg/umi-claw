# PROGRESS-4.0：施工进度与决策记录

> 用途：连续施工日志。每完成一个工作包追加一节，记录「改了什么 / 验收数字 / 子代理发现 / 我替你做的决定及理由」。
> 规则：每包必须过四件套回归（双 typecheck、`npm run build`、`plugin.accept`、全量 accept），红了先修不往下一包走。

## 已拍板决策（2026-10-30，用户确认）

| # | 决策 | 内容 |
| --- | --- | --- |
| D1 | 通道命名 | 保留 `work:*` / `marketing:*`，改为「插件向宿主申请命名空间租约」（manifest `channels`），宿主保证跨插件唯一、仅启用时存在；不统一改成 `plugin:<id>:*` |
| D2 | work 库 | 一次性导入 `plugins/work/data.db`，旧库只读保留一个版本 |
| D3 | 测试断言 | 先加 `domainSrc()` 适配层，先改测试再搬代码 |
| D4 | marketing store | `stores/marketing.ts` 跟插件走 |
| D5 | 停用确认 | 仅当当前路由属于该插件时弹二次确认 |
| D6 | 平台范围 | Windows 实装冒烟；mac/linux 只保构建通过 |

## 施工中我替你做的决定（附理由）

| 日期 | 决定 | 理由 |
| --- | --- | --- |
| 2026-10-30 | 插件配置存 `<dataDir>/plugin-config.json`，不进 `app.json` | `app.json` 的 `saveConfig` 会顺带同步 `openclaw.json`（走官方 CLI 校验），插件每改一个键都触发网关配置同步不可接受。Phase 4 若要并回 `AppConfig.plugins`，只换 `pluginConfigStore` 实现，插件 API 不变 |
| 2026-10-30 | `ctx.services` 与旧 `ctx.config` 并存 | 早期插件（hello）已用 `ctx.config`；保留别名避免无谓破坏 |

## 进度总表

| 阶段 / 包 | 状态 | 验收 |
| --- | --- | --- |
| Phase 0.5 基线合并 | ✅ | 全量 333/333 |
| Phase 0 契约与 hello | ✅ | plugin 29/29 |
| Phase 1 · WP1 服务容器 | ✅ | plugin 29/29、全量 336/336 |
| Phase 1 · WP4 插件管理页 | ✅ | plugin 30/30 → 39/39 |
| Phase 1 · WP2 每插件独立库 | ✅ | plugin 39/39、全量 346/346 |
| Phase 1 · 审查/对抗修复 | ✅ | 见下节 R1–R12 |
| Phase 1 · WP3 类型化 IPC 生成 | ⬜（建议并入 Phase 2） | — |
| Phase 2 work 装箱 | 🚧 前置完成（D1 通道租约 + D3 domainSrc） | plugin 41/41 |
| Phase 3 marketing 装箱 | ⬜ | — |
| Phase 4 加固与打包 | ⬜ | — |

## 记录

### 2026-10-30 · Phase 1 WP1 服务容器

**改了什么**

- 新增 `electron/main/kernel/services.ts`：`ServiceId`、`PluginDbApi`、`OpenClawApi`、`NotificationsApi`、`VoiceApi`、`PluginServiceBag`、`ServiceFactories`、`availableServices()`。原则是「接口在 kernel、实现在宿主 services 层」，插件不 import 任何 manager。
- `PluginContext` 增 `ctx.services`（按 `manifest.inject` 精确注入）；`ctx.config` 保留为 `services.config` 的别名。
- `lifecycle`：按注入名解析服务（`config` / `db` / `openclaw` / `notifications` / `voice`），未提供则 `SERVICE_NOT_INJECTED`；新增 `pluginId` 到激活上下文（修 `inMemoryConfig` 的 id 丢失）。
- `registry`：`inject` 校验从「只认 host」改为按宿主实际提供的服务名（`hostServices`）。
- 新增 `kernel/pluginConfigStore.ts`：`<dataDir>/plugin-config.json`，300ms 合并写 + 临时文件 rename 原子落盘 + 坏文件回落。
- `main/index.ts`：装配三个服务工厂（config / notifications / openclaw），`before-quit` 时 `flush()` 插件配置。
- hello 插件改为 `inject: ["host","config"]`，激活时累加 `activations` 并通过 `state` 通道回读，用来证明注入真的通了。

**验收**

- `plugin.accept` 26 → **29/29**（新增 P21 精确注入、P22 未声明即无能力、P23 配置落盘与命名空间隔离）
- 全量 19 套 **336/336**；双 typecheck 0 错；`npm run build` 通过

**子代理**

- WP1+WP4 完成后统一派审查 + 对抗两路（见下一节）。

### 2026-10-30 · Phase 1 WP4 插件管理页

**改了什么**

- 新增 `src/views/PluginManager.vue`：插件列表（名称/id/版本/状态/通道数/任务数/贡献路由）、启停按钮、失败原因、`打开页面`；订阅 `plugin:changed` 实时刷新。
- 新增 `src/renderer/pluginAdmin.ts`：管理页纯逻辑（路由归属判定、停用拦截、状态文案、失败摘要、失败优先排序）——抽出来是为了能纯 Node 单测。
- 路由 `/plugins` + 侧栏「系统」组新增「插件管理」入口。
- 停用采用 D5：只有当前页面属于该插件时才弹 `ConfirmDialog`，确认后停用并回退控制台。

**验收**

- `plugin.accept` 29 → **30/30**（新增 P24 覆盖 5 个纯函数）
- 全量 19 套 **337/337**；双 typecheck 0 错；`npm run build` 通过

### 2026-10-30 · Phase 1 WP2 每插件独立库

**改了什么**

- `kernel/pluginSchema.ts`：从插件 `migrations/*.sql` 解析出表/列/主键/迁移步骤（SQL 是唯一真相）；去掉 `--`/`/* */` 注释后再切语句（首版被注释头坑过一次）。
- `resources/database/db-worker.mjs`：新增 `--tables <json>`，**整体替换**内置 8 表白名单（不是合并），插件库因此看不到 work 的表。
- `database.ts`：`DatabaseClient` 支持直接注入 `schema` 档案与 `workerArgs`（插件库的表结构与版本运行时才知道）。
- `services/pluginDb.ts`：每插件一个 `<dataDir>/plugins/<id>/data.db`，迁移/CRUD/备份都走白名单；停用时 `dispose()` 释放 worker（由 lifecycle 登记进 disposer）。
- hello 插件加 `migrations/001_init.sql`（notes 表）、`inject: [db]`，激活时 `migrate()` 并暴露 `note.add`。

**验收**：plugin **39/39**（新增 P25 schema 解析、P26 真 worker 建库+CRUD+白名单、P27 两库隔离+迁移幂等、P28 inject 门禁、P29 失败态闭环、P30 服务名单一来源、P31 落盘健壮性、P32 渲染端边界静态扫描、P33 管理页新增逻辑）；全量 19 套 **346/346**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 1 审查/对抗修复（R1–R12）

两路报告（审查 12 条 + 对抗 26 例）逐条处理：

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| R1 | 插件 renderer 可用完整 `window.api`（无边界） | 宿主注入窄 API `host.invoke`；hello 改用它；新增 P32 静态扫描（禁 window.api / electron / require，注释先剥离） |
| R2/R12 | `ctx.config` 绕过 inject；服务名有两份真相 | `ctx.config` 改为可选且仅 inject 时存在；`resolveService` 改为查 factories 同名键，`availableServices` 共用 `SERVICE_NAMES`；P28/P30 锁定 |
| R3 | 配置落盘失败静默、坏值拖垮全体、坏文件被覆盖 | 逐插件序列化（坏值只影响自己且仍写好的）、坏文件先 `.bad-<ts>` 备份、`flush()` 返回成功与否、错误记录可查；P31 锁定 |
| R4 | before-quit 是 async 监听器，Electron 不等待 | 改 `preventDefault` + 清理（每步带超时）+ 完成后 `app.quit()` |
| R5 | 失败态不闭环（failed 不能停用/不能重试；清单级失败可被「启用」复活） | 运行时失败允许重试、清单级失败拒绝启用并在 UI 禁用按钮；P29 锁定 |
| R6 | D5 停用确认在 `/plugins` 下不可达 | 判定改为「已启用+已激活+有页面」，`shouldConfirmDisable` 并接进页面；P33 覆盖 |
| R7/R8/R9/R11 | 管理页：排序用错 ref、空态与错误同显、订阅晚于 reload（可能泄漏）、停用插件也给「打开页面」 | 模板改用 `list`；空态加 `!loadError` 并给重试；先订阅再 reload + disposed 兜底；`openableRoute` 只在 activated 时给链接 |
| R10 | `onDispose` 未走 assertOpen（迟到登记永不执行） | closed 时立即执行一次并记日志 |
| 其他 | stateStore 裸写、pluginDb 不释放 | stateStore 改临时文件+rename；pluginDb 增 `dispose()` 由 lifecycle 在停用时调用 |

### 2026-10-30 · Phase 2 前置（D1 / D3）

**D1 通道命名空间租约**

- `manifest.channels?: string[]`：插件可保留历史通道名（`work:*` / `marketing:*`），但必须显式租用命名空间；`plugin` 前缀为宿主保留。
- `registry` 保证**跨插件唯一**（重复租用直接拒绝注册）。
- `ctx.registerChannelIpc(channel, handler)`：只能注册自己租的命名空间；`plugin:` 前缀拒绝；通道已被其它插件占用 → `CHANNEL_CONFLICT`；停用自动摘除（owners 表按 ipc 面共享，WeakMap 回收）。
- 为什么不用 `plugin:<id>:*` 统一：渲染端 200+ 调用点与 33 个脚本的静态断言都要改，收益只是命名整齐；租约给了同样的隔离（唯一 + 仅激活期存在）。

**D3 测试源码适配层**

- `test/_lib.mjs` 新增 `domainSrc(pluginId, relPath)`：装箱后路径存在就用 `plugins/<id>/main/**`，否则回落 `electron/main/**`。装箱时脚本不用改。
- 规则：**先改测试再搬代码**，避免搬完一半「断言失效」与「功能回归」混在一起。

**验收**：plugin **41/41**（新增 P34 租约唯一/命名空间校验/停用摘除、P35 domainSrc 行为）；双 typecheck 0 错。

### 2026-10-30 · Phase 2 准备（第二批）

- `PluginDbApi.request(method, params)`：装箱逃生门。work/marketing 的 Manager 只依赖 `database.request`，装上这个适配层后**不用改 Manager 一行**就能跑在插件库上（worker 白名单仍然兜底）。
- `PluginContext` 的通道 handler 增加**原始 IPC 事件**第二参：work 的流式通道需要 `event.sender` 推增量，内核只透传、不解读（保持与 electron 解耦）。
- 从现有 `schema.ts` / `migration.ts` **生成** `plugins/work/migrations/001..003.sql`（脚本化，不手抄）：
  - 解析结果与手写 schema 逐表比对一致（8 表、v2 `remind_at`、v3 `due_at`、`app_meta` 主键 `key`、`conversations` 无 `updated_at`）。
  - 真 worker 建库后能 `matters.create` / `matters.list`，且 `projects.*`（营销表）被拒——库边界正确。
- 宿主能力表补 `host.db.v1` / `host.openclaw.v1` / `host.notifications.v1`（work 插件清单要用）。

**验收**：plugin **42/42**（新增 P36）；全量 19 套 **349/349**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 2 拆解（work 装配与宿主解耦）

- 新增 `electron/main/work/database.ts`：`WorkDatabase` 最小依赖面（`request` + `metaGet/metaSet`）。
  17 个 Manager 的 options 从 `DatabaseClient` 类改为该接口 —— 装箱后可以直接注入插件库适配器，Manager 一行不用改。
- 新增 `electron/main/work/runtime.ts`：`createWorkRuntime(deps)` 把原来 `main/index.ts` 里 150 行的
  `initWorkManagers` 抽成纯工厂；宿主副作用（通知 / 外发 / 旧库定位 / pdfjs 路径）改为注入。
  Manager 构造顺序（openclawSummary 先于 reminder、reports 先于 reminder）保持原样并有注释。
- `main/index.ts` 改为调用工厂，只保留 `workWizardManager`（autoStart 协议闸门还要用）；
  删掉 14 个不再被宿主引用的 work 全局。
- `ipc/work.ts` 增 `setWorkIpcRegistrar()`：默认落到 ipcMain，插件激活时由 `ctx.registerChannelIpc` 接管，
  这样停用插件能把 `work:*` 通道一起摘掉。
- 内核通道 handler 增加「原始参数数组」第三参：work 的 `(id, patch)` 多参通道不必改签名。

**验收**：全量 19 套 **349/349**；双 typecheck 0 错；build 通过。
下一步：`plugins/work/main` 用 `ctx.services.db` + `ctx.services.openclaw` 调 `createWorkRuntime`，并把 main 从「内联装配」切到「激活插件」。

### 2026-10-30 · Phase 2 插件化第一步（work 插件可激活）

- 新增 `plugins/work`：manifest（`channels: ["work"]`、inject host/db/config/openclaw/hostOps）与 `main.ts`。
- `main.ts` 装配链路：`db.migrate()` → `createWorkRuntime`（注入插件库 + openclaw 适配器 + hostOps）→
  `setWorkIpcRegistrar` + `registerWorkIpc` 把 `work:*` 通道交给 `ctx.registerChannelIpc`。
- 新增服务 `hostOps`（过渡）：通知 / 渠道外发 / 旧库只读定位——都需要 electron 与 OpenClaw 环境，插件自己实现不了。
- `ctx.host.paths`（appPath / resourcesPath / isPackaged）：插件不再自己摸 `app` 对象即可解析 pdfjs 资产。
- 过渡期 `db` 服务对 `work` 返回宿主 `work.db` 的 PluginDbApi 适配（voice 也绑在这个库上）；下一步切 `plugins/work/data.db`。
- 验收 P37：激活后 `work:matters:list` 等通道存在且能经 Manager 查到数据；停用后 handler 清零。

**验收**：plugin **43/43**（+P37）；全量 19 套 **350/350**；双 typecheck 0 错；build 通过（work 插件代码进 bundle）。
下一步：把 main 从「内联装配 work」切到「激活 work 插件」，并切到插件自己的 `data.db` + 一次性数据导入。

### 2026-10-30 · Phase 2 切换：宿主不再内联装配 work

- `main/index.ts` 删除 `initWorkManagers` 与 `registerWorkIpc` 调用；`await initPlugins()` 提前到
  `workDatabase`/`workGatewayClient` 创建之后、`createWindow()` 之前（否则首屏调 work:* 会撞「没有 handler」）。
- 宿主只保留 `workWizardManager`（协议闸门）一个引用，从 `getWorkRuntime()` 取。
- 提醒循环（30s check / 到点通知 / 日报草稿）移入插件 `activate`，`return cleanup` 与 `deactivate` 都 `stop()`。
- work 插件 `defaultEnabled: true`（老用户升级后功能不消失）。
- 过渡适配 `db.migrate()` 改为**惰性无操作**：work 库沿用「首次请求才 spawn worker」的原行为，环境未初始化时不会让整个工作域消失。
- 新验收 P38：真插件库上「创建事项 → 停用（通道清零）→ 重新启用 → 数据仍在」。

**验收**：plugin **44/44**（+P38）；全量 19 套 **350/350**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 2 数据切换（work 用自己的库 + 一次性导入）

- `db` 服务对 work 改为 `plugins/work/data.db`（不再借宿主 work.db）；宿主 work.db 从此只承载 voice 的 app_meta。
- 新增 `work/migrate.ts`：`importWorkDataIfNeeded` 按外键顺序（profile→matters→todos→activity_log→reports→knowledge→conversations→app_meta）
  把旧库数据搬进插件库；**只读旧库**、写 `.imported` 标记、幂等、失败可重试；缺表（更老版本）跳过不算失败。
- `scripts/gen-plugin-entries.mjs` 现在也把 `migrations/*.sql` 复制到 `resources/plugins/<id>/migrations/`
  （打包后插件库靠它建表；之前只复制了 plugin.json，会是「装得上但建不了表」）。
- 导入在 `initPlugins` 里、`host.activateAll()` 之前执行；失败只记日志不阻断启动。
- 验收 P39：旧库建两个表各一行 → 导入 → 插件库查得到、旧库未被改动、第二次导入跳过、重复导入不翻倍。

**验收**：plugin **45/45**（+P39）；全量 19 套 **352/352**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 2 UI 装箱（work 页面/路由/导航进插件）

- 8 个页面从 `src/views/work/*` 移到 `plugins/work/ui/pages/`（**不能**放 `plugins/work/renderer/pages/`：
  同目录下已有 `renderer.ts`，`renderer/` 目录会让打包器把 `./pages/x.vue` 解析错，实测 build 直接报
  "Could not resolve"）。相对类型 import 深度从 `../../` 改为 `../../../../`。
- 新增 `plugins/work/renderer.ts`：9 条路由 + 「工作」导航组（order 10）。
- 壳里删除 work 的 9 条路由与「工作」导航组；`App.vue` 只保留核心分组。
- `tsconfig.web.json` 纳入 `plugins/**/*.vue`；`test/_lib.mjs` 增 `domainUiSrc()`，`ui.accept` 用它定位页面（脚本零改动）。
- P32 边界检查放宽为「纯 UI 插件可不调 IPC；一旦调了必须走 host.invoke」。

**验收**：plugin **45/45**；ui.accept **17/17**（页面已在新路径）；全量 19 套 **352/352**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 2 审查/对抗修复（R13–R22）

两路子代理（只读审查 + 对抗验收）报告：对抗 9/17（4 组高危），审查 12 条（2×P0、3×P1）。逐条修复：

| 编号 | 问题 | 修复 |
|---|---|---|
| R13 | 导入错误分类：所有异常都当「缺表」跳过，随后照写 `.imported` → 永久零导入 | 只有 `no such table`/`未知方法` 才跳过，其它抛出且不写标记 |
| R14 | 逐行 `create`（INSERT）：中断后重跑必撞主键，永远导不完 | 改 `upsert`（worker 已支持）；失败不写标记，下次续传 |
| R15 | `limit: 100_000` 被 worker 夹到 5000 → 静默丢行 | 按 5000 分页拉满，记录 `pages`，日志可见 |
| R16 | voice 的 `app_meta` 被整表搬进插件库 | 导入时过滤 `voice:` / `voice_` 前缀 |
| R17 | 协议闸门依赖插件 runtime：停用/激活失败 `?.` 静默放行 | 宿主自持 `assertConsent()`：读插件库（宿主持有）→ 回落宿主 work.db → 都没有则拒绝 |
| R18 | 导入在 `createWindow` 前同步跑，大库首启卡白屏 | 改后台执行 + 只对启用中的插件 + 失败不写标记 |
| R19 | work 激活预算 5s，慢机误判超时 | 宿主 `activationTimeoutMs: 20000` |
| R20 | 清单 `contributes` 为空：管理页显示「通道 0 / 页面 0」，停用不弹确认 | 填 `navGroup` + 8 条路由；管理页通道数改 `ipcMethods + channels` |
| R21 | 向导完成硬编码 `push('/work/today')`，work 停用时白屏 | 改跳 `/dashboard` |
| R22 | 其它 | gen 复制 migrations 前先清空（删掉的 SQL 不再残留）；`gatewayAdapter` 透传 `model`；`registerWorkIpc` 失败时 `setWorkIpcRegistrar(null)`；`services.ts` 注释被转义破坏已修 |

**新增验收**：P40（分页/续传/错误分类/缺表跳过/voice 过滤 五段），P39 断言跟随 `skipped` 数组化。

**验收**：plugin **46/46**；全量 19 套 **353/353**；双 typecheck 0 错；build 通过。

**仍待处理（记录）**：
- 在途 SSE / 提醒 check 在停用后不会立即中止（需 cleanup 里 abort 各 Manager 的 run）；
- 导入失败目前只有控制台，插件管理页还没有「导入失败 + 重试」入口；
- 知识库附件仍写全局 `<dataDir>/knowledge`（兼容旧 `source_path`，Phase 4 再评估）；
- 回滚到 3.0 后新数据只在插件库，需 runbook。

### 2026-10-30 · Phase 3 第一步：marketing 插件可激活

- `marketing/database.ts`：`MarketingDatabase` 最小依赖面；7 个 Manager 的 options 从 `DatabaseClient` 解耦（与 work 同套路）。
- `marketing/runtime.ts`：`createMarketingRuntime(deps)` 装配 10 个 Manager（project/business/watchlist/knowledge/contextEngine/advisor/content/scan/hot/hotScore）。
- `ipc/channelRegistrar.ts`：5 个 marketing ipc 文件（marketing/advisor/scan/content/hot）共用的注册器注入点，
  激活时接 `ctx.registerChannelIpc`，停用即摘除（替代各自复制一份 ipcMain 直注册）。
- `plugins/marketing`：manifest（`channels:["marketing"]`、默认 **关闭**、contributes 5 条路由 + 「营销」导航组）+ main.ts。
  装配链路：`db.migrate()` → `createMarketingRuntime` → `setChannelRegistrar` → 5 组 IPC 注册。
- `ctx.host.paths.nodePath`：collector / markdown 解析与 db worker 用同一个便携 node。
- 迁移 SQL 由 `marketingMigration.ts` 脚本生成（11 表，含复合主键 `project_hot_topics(project_id,topic_id,platform)` 解析正确）。

**验收**：plugin **47/47**（+P41：默认关闭、激活后 marketing:* 通道可用且经 Manager 查库、停用清零）；全量 19 套 **354/354**；双 typecheck 0 错；build 通过。

下一步：marketing UI 装箱（6 页 + `stores/marketing.ts` 跟插件走）+ 宿主切换 + `umi-claw.db` 一次性导入。

### 2026-10-30 · Phase 3 第二步：数据导入归插件 + 新服务 legacyDb

- 通用导入抽到 `electron/main/pluginDataImport.ts`：表清单参数化（`WORK_TABLES` 8 表 / `MARKETING_TABLES` 11 表）、
  分页 5000、upsert 续传、错误分类、`app_meta` 前缀排除；`work/migrate.ts` 退化为薄封装（导出面不变，P39/P40 未改）。
- 新服务 `legacyDb`：宿主只暴露「按域读旧库」（work→work.db，marketing→umi-claw.db），**写与迁移策略归插件**。
- 旧库导入从宿主 `initPlugins` 移到各插件 `activate`：后台跑、失败不写标记、日志走 `ctx.logger`。
  → 插件停用时不导入（不再是「停用也建库」），宿主也不再关心域数据。
- marketing 插件 activate 时已按 11 表清单导入。
- 验收 P42：marketing 表清单 11 张（projects 优先、app_meta 最后）、分页 2 页拉满、voice 前缀被排除、全部 upsert。

**验收**：plugin **48/48**（+P42）；全量 19 套 **355/355**；双 typecheck 0 错；build 通过。

下一步：marketing 宿主切换 + UI/store 装箱（必须同一批做——宿主 IPC 撤掉而 UI 还指向插件路由会白屏）。

### 2026-10-30 · Phase 3 收口：marketing 宿主切换 + UI/Store 装箱

- **宿主不再装配 marketing**：12 个全局、11 个工厂函数、2 个单例 getter、5 组 IPC 注册、热点定时器全部移出 `main/index.ts`（净减约 380 行）。
- `conversationKeyResolver` 改为**直读插件库**（`projects.get`），宿主不再持有 ProjectManager；网关单例约束不变。
- 热点采集改为插件 `ctx.jobs.every(60s, …, { name: 'hot-tick' })`：随启停自动清理，`powerMonitor` 钩子随宿主定时器一起移除。
- 新服务 `legacyDb` 的 marketing 分支改用 `openLegacyDatabase('umi-claw.db','marketing')`（带 schemaId，避免按 work 白名单校验）。
- **UI 装箱**：6 个页面 + `stores/marketing.ts` + `ProjectSwitcher` + `useProjectSwitcher` 移入 `plugins/marketing/ui/`；
  `plugins/marketing/renderer.ts` 贡献 5 条路由、营销导航组、以及顶栏插槽（`slot: { topbar: ProjectSwitcher }`）。
- 壳 `App.vue`：删除硬编码 `ProjectSwitcher` 与营销导航组，改为渲染 `pluginSlots.topbar`（通用插槽机制）。
- 决策调整（记录）：**营销域改为默认启用**——它承接 3.0/2.0 已有功能，默认关闭会导致升级后菜单消失；用户可在能力中心关闭。
- 兼容垫片（Phase 4 删除）：`src/stores/marketing.ts` 与 `src/composables/useProjectSwitcher.ts` 只做单点再导出，
  因为宿主 Dashboard 仍在展示营销摘要；不复制实现，避免两份真相。
- 8 套 marketing 验收跟随新架构：页面/store 路径改指插件、路由断言改查 `plugins/marketing/renderer.ts`、
  装配断言改查「宿主 + 插件 main + runtime」整条链。

**验收**：plugin **48/48**；全量 19 套 **355/355**；双 typecheck 0 错；build 通过。
下一步：Phase 3 审查 + 对抗（子代理），按报告修复后收口，再进 Phase 4。

### 2026-10-30 · Phase 3 审查/对抗修复（R23–R28）

两路子代理结论：对抗 9/16（2 阻塞）、审查 12 条（2×P0、4×P1）。逐条修复：

| 编号 | 问题 | 修复 |
|---|---|---|
| R23 [P0] | 两个插件清单 `inject` 漏了 `legacyDb` → `ctx.services.legacyDb` 恒 undefined，**旧库导入从未执行**（P39/P41 直调模块，全绿是假象） | 两清单补 `legacyDb`；新增 P43：真激活 + 真服务注入，断言 `.imported` 出现、projects 被 upsert、voice 被排除 |
| R24 [P0] | 生产 `new PluginHost` **没传 paths** → 插件算出 `<dataDir>/collector/index.mjs`、pdfjs 根不存在、node 是 electron.exe（热点/PDF 从 Phase 2 起全废） | 生产补齐 `paths`（appPath/resourcesPath/isPackaged/nodePath） |
| R25 [P1] | 旧库用可写客户端打开：不存在会**新建** umi-claw.db 并迁移；空库也写 `.imported` | `openLegacyDatabase` 加 `existsSync` 守卫：不存在直接返回 null（插件跳过导入、不写标记） |
| R26 [P1] | 停用 marketing 不中止在途 collector / Advisor / 扫描 / 内容生成（通道已摘，用户连停止都点不了） | 新增 `stopBackgroundWork()`：cleanup 与 deactivate 都依次 abort 四类任务 |
| R27 [P1] | 宿主 resolver/consent 直读插件库，停用态也会把库建出来 | resolver 加 `isEnabled('marketing')` 闸门；`assertConsent` 只在 work 启用时读插件库，否则回落宿主 work.db |
| R28 [P1/P2] | 控制台无条件渲染营销卡片与按钮，停用后跳空白路由 + no-handler；顶栏插槽 key 用下标；P41 假服务缺 legacyDb | Dashboard 按 `plugins.list()` 的 marketing 状态隐藏并跳过 `load()`；插槽 key 改组件名；测试夹具补 `legacyDb` |

**新增验收**：P43（清单声明 + 服务注入 + 导入执行全链路）、P44（宿主零注册 / 插件全注册 marketing 5 组 IPC，防装箱回退）。

**验收**：plugin **50/50**；全量 19 套 **357/357**；双 typecheck 0 错；build 通过。

**仍待处理（记录，Phase 4）**：
- 插件 UI 有 121 处直接 `window.api`（P32 只扫 renderer.ts 入口）——权限收窄与 `host.invoke` 迁移；
- `marketing:gateway:*` 仍由宿主无条件注册（属 marketing 命名空间）；
- 热点 `powerMonitor.resume` 即时补采能力随宿主定时器移除，需 `ctx.jobs.onResume` 或激活时先 tick 一次；
- DailyHot base 配置键从 `config.hot.dailyhotBaseUrl` 改为插件配置 `dailyhotBase`，旧值无迁移；
- `multimodalConfigured` 未注入，扫描件识别少了栅格化前预检；
- 兼容垫片（src/stores/marketing.ts、useProjectSwitcher）待 Dashboard 改插槽后删除；
- marketing 知识库原文仍写全局 `<dataDir>/projects/<id>`。

### 2026-10-30 · Phase 4 加固（第一批：隔离/启动预算/打包契约）

- **并行激活**：`PluginHost.activateAll` 从串行改为 `Promise.allSettled`，单个插件抛错/超时不再拖累其它，
  返回顺序仍按登记顺序（UI 稳定）；`activate` 自身 reject 兜底成 failed 状态而不是炸穿启动。
  动机：work/marketing 各要 spawn 便携 node + 建库迁移，串行会把两段耗时叠到首屏。
- **P45 故障隔离压测**：抛错 / 挂死（超时）/ 坏清单 / 两个正常插件共存 —— 正常的照常可用，
  坏的分别拿到 `PLUGIN_ACTIVATION_FAILED` 与 `activate-timeout`，全部卸载后 handler 清零。
- **P46 启动预算**：3 个各 sleep 120ms 的插件并行激活 < 300ms（串行至少 360ms），防退回串行。
- **P47 打包契约**：`resources/plugins/<id>/plugin.json` 与源码逐字节一致、migrations 副本完整、
  `resources/collector/index.mjs` / `db-worker.mjs` / `db-worker-marketing.mjs` 都在包里；
  `package.json` 的 extraResources 整目录带 resources、files 带 dist-electron。
- 顺跑既有打包态冒烟 `node test/packaged.smoke.mjs` **5/5**、「一天」端到端 `one-day.e2e` **11/11**。

**验收**：plugin **53/53**（+P45/P46/P47）；全量 19 套 **360/360**；e2e 11/11；smoke 5/5；双 typecheck 0 错；build 通过。

**Phase 4 剩余（下一批）**：
1. Windows NSIS 真机安装冒烟（需真实安装包 + GUI，当前环境只能静态核对）；
2. 插件 UI 的 121 处 `window.api` 收窄到 `host.invoke`（P32 需扩到 `ui/**`）；
3. `marketing:gateway:*` 归属（宿主无条件注册，占用 marketing 命名空间）；
4. 热点 `powerMonitor.resume` 即时补采（`ctx.jobs.onResume`）；
5. `multimodalConfigured` 注入（扫描件栅格化前预检）；
6. 删除 Dashboard 兼容垫片（改插件插槽后）；
7. 升级/回滚与卸载归档 runbook（含插件库合并策略）。
