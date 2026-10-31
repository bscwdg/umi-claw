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
| Phase 1 · WP3 类型化 IPC 生成 | ⬜ 未排期（原建议并入 Phase 2，实际未执行） | — |
| Phase 2 work 装箱 | ✅ 完成（含 R13–R22） | plugin 45/45、全量 352/352 |
| Phase 3 marketing 装箱 | ✅ 完成（含 R23–R28） | plugin 50/50、全量 357/357 |
| Phase 4 加固与打包 | ✅ 自动化完成；NSIS 真机安装待人工（RUNBOOK §6） | plugin 53/53、全量 360/360、packaged.smoke |

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

### 2026-10-30 · Phase 4 第二批：插件 UI 的宿主 API 收敛

- 新增 `plugins/shared/hostBridge.ts`：插件 UI 访问宿主 API 的**唯一**入口（`workApi/marketingApi/clawApi/shellApi/pluginsApi`）。
- 12 个插件 UI 文件（8 个 work 页面 + 4 个 marketing 文件）里的 80+ 处 `window.api.*` 全部改为桥接函数调用；
  现在整个 `plugins/**` 里 `window.api` 只出现在 hostBridge 一个文件。
- **P32 扫描范围扩大**：从「每个插件的 renderer.ts」扩到 `plugins/**/*.{ts,vue}`（含 ui/ 与 main.ts），
  并断言「只有 hostBridge 可以出现 window.api」——之前 121 处直连的假绿被堵上。
- 顺带修了 `TodayPage` 的 `typeof workApi().xxx` 类型写法（类型位置不能用调用表达式），改为显式结果类型。

**验收**：plugin **53/53**（P32 强化后仍全绿）；全量 19 套 **360/360**；ui.accept 17/17；双 typecheck 0 错；build 通过。

**为什么先做这一层而不是直接改 host.invoke**：`host.invoke` 的签名只对「插件自有通道」通用，
而这 80+ 处里既有域通道也有宿主能力（claw.status / shell.openExternal）。先把入口收敛成一处，
下一步只需改 hostBridge 一个文件就能整体切到更窄的接口（并按需补 `host.shell` 这类显式能力）。

### 2026-10-30 · Phase 4 第三批：gateway 通道归属 + 系统唤醒事件

- `ipc/gateway.ts` 拆成 `registerWorkGatewayIpc` / `registerMarketingGatewayIpc`（`registerGatewayIpc` 保留为兼容两域一起注册，仅测试/脚本用）。
  宿主只注册 work 面；**marketing:gateway:* 由营销插件在自己的通道租约下注册**，停用即摘——
  修掉「停用营销后 marketing:gateway:* 仍活着、甚至能拉起 OpenClaw」。
- gateway 的 handle 改走共享 `channelHandle`，插件侧才能接管。
- 内核新增 `ctx.host.onResume(cb)`（宿主 `PluginHostOptions.hostEvents` 注入，生产用 `powerMonitor.resume` 广播）。
  营销插件订阅后「唤醒立即补一轮热点采集」，激活时也先补一次——补回 Phase 3 丢掉的 resume 行为。
- 新验收：**P48**（宿主零注册 marketing gateway / 插件注册）、**P49**（resume 订阅 + 停用自动退订）。

**验收**：plugin **55/55**（+P48/P49）；全量 19 套 **362/362**；双 typecheck 0 错；build 通过。

### 2026-10-30 · Phase 4 第四批：多模态预检 + 运维手册

- `HostOpsApi.isMultimodalConfigured()`：宿主按次读配置（`resolveGatewayModels().multimodal`），
  营销插件注入给 `createScanRecognizer` 的 `multimodalConfigured` —— 没配多模态模型时**在栅格化前**就返回，
  不再先花几秒解码 PDF 才报错。
- 新增 `doc/RUNBOOK-4.0.md`：数据布局（新旧库/插件库/标记文件）、升级导入与失败处置、回滚（单向，含手工搬运步骤）、
  卸载归档、7 类故障速查、Windows 安装冒烟 7 步清单、开发侧常用命令。
- 新验收 **P50**：hostOps 暴露能力 / 宿主实现 / 插件注入 / runtime 透传 四处齐。

**验收**：plugin **56/56**（+P50）；全量 19 套 **363/363**；双 typecheck 0 错；build 通过。

**Phase 4 剩余**：Dashboard 营销摘要改插件插槽并删兼容垫片；Windows NSIS 真机安装冒烟（本环境只能做静态核对 + 手册清单）。

### 2026-10-30 · Phase 4 第五批：D4 收口（营销摘要进插槽，垫片清零）

- 新增 `plugins/marketing/ui/components/DashboardMarketingCard.vue`：把控制台的营销摘要卡（当前商家 + AI 营销）
  连同样式与数据加载一起搬进插件，注册到插槽 `dashboard.marketing`。
- `src/views/Dashboard.vue`：营销块改为渲染 `pluginSlots['dashboard.marketing']`；
  删除对插件 store / composable 的 import、`marketingReady` 探测、`formatDate` 与营销样式。
- 删除两个兼容垫片：`src/stores/marketing.ts`、`src/composables/useProjectSwitcher.ts`。
  → 「marketing store 跟插件走」（D4）从文件位置层面**升到语义层面**：宿主不再静态依赖插件代码，停用营销后摘要卡整块消失。
- 新验收 **P51**：Dashboard 零 store/composable 依赖 + 插槽注册 + 垫片不存在。

**验收**：plugin **57/57**（+P51）；全量 19 套 **364/364**；双 typecheck 0 错；build 通过。

**Phase 4 剩余**：Windows NSIS 真机安装冒烟（本环境无 GUI/安装器，只能 `packaged.smoke` + RUNBOOK §6 人工清单）。

### 2026-10-30 · Phase 4 收尾：真实打包产物核对

- 实际跑通 `electron-builder --win --dir`（Electron 30.5.1 → `release/win-unpacked`），
  产物结构核对：`resources/resources/plugins/{work,marketing}/{plugin.json,migrations}` 齐全、
  `collector/index.mjs` 与两个 db-worker 在包内、插件数据**没有**被打进 `app.asar`、
  asar 内含 `dist-electron/main/index.js`。
- `test/packaged.smoke.mjs` 新增 **S6**：把上面这条变成常驻断言（构建过 `release/win-unpacked` 才跑，否则跳过）。
  跑通结果：**6/6**。

**Phase 4 自动化部分完成**。唯一未执行项：Windows NSIS 真机安装/卸载（当前环境无 GUI 安装器），
清单已写入 `doc/RUNBOOK-4.0.md` §6。

### 2026-10-30 · Phase 4 审查/对抗修复（R29–R36）

两路子代理（Phase 4 审查 + 对抗验收）结论：2 个必现 P0、2 个 P1、若干 P2/P3。逐条修复：

| 编号 | 问题 | 修复 |
|---|---|---|
| R29 [P0] | `channelRegistrar` 模块级单例被营销插件激活后**不复位**：宿主随后 `registerWorkGatewayIpc` 被劫持 → `CHANNEL_NOT_LEASED` 抛出在 try 之外 → 有旧库的升级用户**无窗口无托盘** | ① work gateway 面改 `hostHandle` 直连 `ipcMain`（宿主通道不走插件注册器）；② 插件注册阶段结束即 `setChannelRegistrar(null)` |
| R30 [P0] | `Dashboard.vue` 用了 `pluginSlots` 却没 import → 首页必崩；`tsc` 不检查 .vue 模板，所以「双 typecheck 0 错」挡不住 | 补 import；并用 `@vue/compiler-sfc` 真编译一次作为验证 |
| R31 [P1] | 旧库不存在时 `legacyDb` 工厂 throw → 新装用户营销域**永久激活失败** | 返回空 reader（`list: async () => []`），插件照常激活、导入自然跳过 |
| R32 [P1] | 超时路径丢弃 `activate()` 迟到返回的 cleanup → 后台任务/注册器残留 | `lateCleanupDone` 标记 + 统一迟到 cleanup 入口（超时与停用两条路径各执行一次，不双跑） |
| R33 [P2] | `activate` 期间停用：返回 disabled 但 handler/job 仍存活（生产窗口可达 20s） | deactivate 对在途 attempt **立即 rollback**（closed 后迟到注册本就全拒），返回时已不服务；实测 0ms |
| R34 [P2] | P52 是空断言：两次 `bundleEntry` 各自内联注册器，模块状态不共享 | 新增单入口 `test/fixtures/plugin-registrar-entry.ts`，同一实例里断言「复位 + 宿主注册不抛」 |
| R35 [P2] | P54 等待永不 resolve 的 activation，让套件多跑 20s | 不 await；该用例超时降到 1.5s；新增 **P55**（超时 + 迟到 cleanup 路径） |
| R36 [P3] | `ui.accept` U11 仍是旧架构断言（要求宿主注册 marketing:gateway）、P32 可被 8 种写法绕过、RUNBOOK 数字/版本漂移 | U11 改为「宿主不得注册 marketing:gateway」并只加载 work 面；P32 增加可选链/方括号/解构等模式；RUNBOOK 修正 |

**验收**：plugin **61/61**（+P55）；全量 19 套 **368/368**；e2e 11/11；smoke 6/6；双 typecheck 0 错；build 通过。

### 2026-10-30 · 缺陷修复：模型配置保存后 openclaw.json 不生效（官方 config patch 破坏性数组守卫）

**现象**（用户报告）：在「模型配置」给火山方舟加自定义模型 `deepseek-v4.1-flash-economy`、选中并保存，
`app.json` 已落盘（`activeProvider=volcengine-agent-plan`、`model=deepseek-v4.1-flash-economy`、
`customModels` 有该条目），但 `openclaw.json` 完全没变：`agents.defaults.model.primary` 仍是
`umiclaw-deepseek/deepseek-v4-flash`、provider 的 `models` 里也没有 economy 条目——「保存了但没生效」，
而且此后每次保存都同样失败。

**根因**（隔离 dataDir + 真实 `ConfigManager` + 真实 `openclaw config patch` 复现，CLI 原话）：

```
Refusing to replace models.providers.umiclaw-deepseek.models; it would remove existing entries:
deepseek-v4-flash. Use --replace-path models.providers.umiclaw-deepseek.models to replace intentionally.
```

- `_syncOpenClawConfig` 的「激活模型自洽性兜底」会把激活模型补进 `models.providers[].models`
  （例如 deepseek 的 `deepseek-v4-flash`），而官方预设列表里没有这个 id；
- 切换到别的服务商后，目标数组不再包含它 → 该数组替换「移除了既有条目」；
- OpenClaw 2026.10.x 起对按 id 数组做**非破坏性校验**：会移除既有条目的数组替换整单被拒（exit 1），
  **整份补丁**（含 primary、新自定义模型、modelPolicy）一起不落盘；且它不属于「配置非法」诊断面
  （不触发 doctor），用户只看到一次警告 toast；
- 于是形成**死锁**：只要 openclaw.json 里存在一条预设之外的补录模型，此后的任何保存（切服务商 /
  加自定义模型 / 换 key / 调超时）都失败。

**修复**

- `electron/main/openClawConfigWriter.ts`：新增 `collectLossyIdArrayReplacePaths(original, desired)`——
  按官方路径口径（普通键点号，含特殊字符的键走 `["..."]`）找出「会移除既有 id」的按 id 数组路径；
  `applyOpenClawConfigPatch` 增加可选 `replacePaths`，逐条转成官方 `--replace-path`（可重复参数）。
- `electron/main/configManager.ts`：`_syncOpenClawConfig` 算补丁时一并算 replacePaths 传入。
  依据是「本应用是这些模型数组的唯一作者，目标列表即权威列表」；**只在确实会移除条目时才传**，
  老版本 CLI（没有该选项/没有该守卫）行为完全不变，也不会因未知参数失败。

**验收**

- `openclaw-config-writer.accept` 新增 4 条用例（会移除→给出路径；只增/同集→为空；缺数组/非按 id→为空；
  带点号的 provider 键走括号形式）：21/21 通过。
- 真实复现脚本（隔离 dataDir + 真 CLI，`test/.tmp/repro-economy-sync.mjs`）修复前后对照：
  `syncOk` false → true；`primary` `umiclaw-deepseek/deepseek-v4-flash` →
  `volcengine-agent-plan/deepseek-v4.1-flash-economy`；plan provider `models` 出现 economy 条目；
  `modelPolicy.allow` → `volcengine-agent-plan/*`。
- 双 typecheck 0 错；`npm run build` 通过；全量 accept 除 `shooting` S5 外全绿（S5 是本就存在的
  并行会话键顺序竞态：单独重跑 9/9 通过，同一提交上复现率与环境相关，与本改动无关）。
- `test/p0-sync-selftest.mjs` 本机失败原因是它自己的前置 `doctor --fix` 超时（180s 预算，本机并行
  进程多），失败点在 doctor 门禁而非本次改动路径。

### 2026-10-30 · 启动慢优化 批次 1（就绪态 + 埋点）

按 `doc/OPT-STARTUP-4.0.md` 实施（渠道保留、不做 patch 后台化）：

- **启动埋点**：`clawManager` 新增 `_fetchHealthOk()`（HTTP `GET /health`，1.5s 超时）与后台探活
  `_startReadyProbe()`；就绪时写日志 `[gateway] 启动耗时 X.Xs（spawn→health）` 并推 `statusChange`。
- **`waitReady(timeoutMs)`**：UI 等待网关真正可用；超时/进程退出返回 `error`（不再用「进程存在」冒充可用）。
- **`ClawStatus` 扩展**：`starting / ready / readyAt / startupMs`；`statusChange` 广播一并带上。
- **新 IPC**：`claw:waitReady`（只读探测，不启动、不走协议闸门）；preload 暴露 `claw.waitReady`。
- **`stores/claw.ts`**：区分 `running`（进程已 spawn）与 `ready`（/health 200）；点击启动即进入
  `starting`（覆盖 spawn 前的 patch/doctor 准备阶段），后台 `trackReady()`；失败写 `startupError`；
  暴露 `startingSeconds`。（子代理审查后补充：`readyEpoch` 代际让 stop/restart 后旧等待结果作废，
  避免「主动停止 → 报启动失败」；`statusChange(ready=true)` 清历史错误，避免 exit 78 自愈后挂红。）
- **Dashboard**：「打开网页」只认 `ready`；启动中显示「启动中 xx s…」、状态卡显示已等秒数与
  「就绪后才能打开 Web 界面」提示；就绪/失败各给一次 toast；Token/重启按钮在启动中禁用。
  （审查后修正：快捷入口「Web 控制台」也改走 `openWeb()`；Token 不依赖网关，不再被 ready 门禁挡住。）
- **语音页重启**：`restart` 后等待 `waitReady`，就绪 toast「本次启动 xx s」，失败给错误（不再误报成功）。
- **探活健壮性**（审查后补）：`_startReadyProbe` 加代际 `readyProbeSeq` + await 后 ready 去重
  （旧探针不写新实例状态、不重复写「启动耗时」）；探活端口改用 spawn 时的 `this.port`。
- **验收**：`ui.accept` 新增 **U18**（store 五条路径：准备阶段/就绪/失败/停止作废/事件清错）与 **U19**
  （Dashboard 门禁、语音页等待、主进程/预加载/探活接线静态断言）。

**验收**：全量 accept **28 套 / 503 条断言**；ui **19/19**；e2e 11/11；smoke 6/6；双 typecheck 0 错；build 通过。
（历史条目中的「19 套 / 370」是当时的套件数与断言数快照，现已扩到 28 套。）
**人工验证**：点启动/重启 → 从点击起状态卡就出现「启动中（已等 xx s）」→ 就绪后 toast「启动耗时 xx s」，
日志面板有 `[gateway] 启动耗时`；就绪前「打开网页」与「Web 控制台」都禁用。

### 2026-10-31 · 启动慢专项：应用侧兜底（环境无关代码修复）

用「同机手动起网关 + 真实配置」做了对照实验，把 415–522s 的启动拆开：

| 配置 | 启动到 /health 200 |
|---|---|
| 全新空配置（无渠道/无历史） | 45s |
| 真实配置 | 415–522s |
| 真实配置 + 移走 139MB agent 历史库 | 522s（无改善 → 不是历史库） |
| 真实配置 + 补 `meta.migrations.webhookListeners=true` | 329s（`process.bootstrap` 259s→77s） |
| 真实配置 + 再关 3 个渠道插件 | 96s（`main-session-recovery` 240s→秒级） |

定位到**代码问题**（不改环境，全部在应用侧兜底；含一轮子代理审查后的修正）：

1. **legacy webhook 迁移每次重跑（实测 ~185s/次）**
   - OpenClaw 只在迁移「无 warning」时才可能记录 `meta.migrations.webhookListeners`；迁移要动态加载
     telegram/feishu/msteams/nextcloud-talk 的插件 doctor 契约，Windows 上可能因符号链接权限 /
     复制期文件变化失败（`EPERM symlink` / `copy path changed during operation`）→ 标记写不进去，
     下次启动继续重跑。
   - 官方对「外部管理的配置」要求「补 legacyWebhook 端点 + 补完成标记」；本应用是 openclaw.json 的外部
     管理者，但**只在配置里没有 legacyWebhook 端点时**才补标记（有则交回官方迁移，避免静默跳过）。

2. **启动状态机 / 探活健壮性缺口**（子代理审查发现，均已修）
   - 点击启动后、spawn 之前（ghost 清理 / config patch / doctor，可能数分钟）界面仍显示「已停止」；
   - 主动停止后旧的 `waitReady` 返回会写「启动失败」，且 `startupError` 在 exit 78 自愈成功后不清空；
   - `_startReadyProbe` 无实例代际：stop→start 窗口旧探针可能用旧 spawnAt 写就绪/重复日志；
     探活用配置端口而非 spawn 端口；
   - Dashboard 快捷入口「Web 控制台」绕过 ready 门禁；Token 按钮被无关的 ready 门禁挡住。
   - 注：上一版「修链接后等 realpath 稳定避免与插件复制抢时序」的因果不成立（实测 no-op 且发生在
     spawn 前），已删除该等待，仅保留修复计数日志。

**实现**
- 新增 `electron/main/openclawWebhookMarker.ts`：
  - `findLegacyWebhookChannels`（扫 4 个历史渠道的 `legacyWebhook`）+ `hasWebhookMigrationMarker` +
    `applyWebhookMigrationMarker`（纯函数、幂等）；
  - `ensureWebhookMigrationMarkerFile`：有 legacyWebhook → 不补（返回 `skippedLegacyChannels`）；
    无则先备份（`openclaw.json.webhook-marker-bak.<yyyyMMddHHmmss>`，备份成功才上报路径）→
    「临时文件 + rename」原子写，rename 失败回退直写并在 finally 清 tmp；保留原文件 BOM/CRLF/结尾换行；
    坏 JSON 不动作。
- `openClawConfigWriter`：导出 `runSerializedOpenClawConfigWrite`，让标记补写与官方 config patch 走
  **同一按路径串行队列**（避免 read→write 交错 lost update）。
- `configManager` / `downloadManager`：两处首文件骨架都按「无 legacyWebhook 才带标记」写入；
  `ConfigManager.ensureWebhookMigrationMarker()` 走串行队列。
- `clawManager._spawnGateway`：`syncOpenClawConfig()` 之后、`spawn` 之前 await 补齐标记并写日志
  （有 legacy 时写 stderr 提示保留官方迁移）。
- `stores/claw.ts`：点击启动即 `starting`；`readyEpoch` 代际使 stop/restart 后旧等待结果作废；
  `statusChange(ready=true)` 清空历史错误；删除死 API `waitReadyNow`。
- `clawManager`：`readyProbeSeq` 代际 + await 后 ready 去重；`_fetchHealthOk` 用 spawn 端口。
- `Dashboard`：快捷入口改走 `openWeb()`；Token 按钮去掉 ready 门禁。

**验收**
- `claw-maintenance.accept` 新增 4 项：`marker-pure`、`marker-legacy`（有 legacyWebhook 不补标记）、
  `marker-file`（14 位备份名/CRLF+BOM 保留/原子写无 tmp 残留/幂等/坏文件保护）、`marker-wiring`
  （顺序 + 串行队列 + 两处首文件骨架）→ **25/25**。
- `ui.accept`：U18 扩为五条路径（准备阶段/就绪/失败/停止作废/事件清错）、U19 增代际与快捷入口断言
  → **19/19**。
- 全量 `npm run accept`：**30 套全部通过**（accept×28 = 503 条断言 + e2e 11/11 + smoke 6/6）；
  双 typecheck 0 错；`npm run build` 通过。
- 子代理审查结论「无阻断、5 重要 + 若干次要」中的问题已逐条修复；文档数字与因果表述同步修正
  （套件数 28/503；「省 ~185s」限定为「原本会重跑迁移的配置」）。


### 2026-10-31 · 启动阶段 UX + 官方 trace 接入 + 文档调研

- **阶段 UX**：`clawManager` 新增 `bootPhase`（preparing → spawning → loading → ready），
  用 TCP 监听探测区分「进程已起」与「端口已监听、插件/渠道加载中」；`ClawStatus`/`statusChange`/
  `stores/claw.ts`/Dashboard 全链路展示「当前阶段 + 已等 N 秒」，loading 阶段提示
  「首次或升级后需重建渠道插件包，可能需数分钟」。
- **官方 trace**：网关 spawn env 增加 `OPENCLAW_GATEWAY_STARTUP_TRACE=1`（仅日志），
  下次启动可拿到每个插件的 configValidation / artifactPreparation / load（含 source capture）/ register 分项。
- **文档调研**（docs.openclaw.ai：debugging / secure-file-operations / dependency-locking /
  cli-plugins / manage-plugins / runtime-compatibility）：结论写入 `doc/OPT-STARTUP-4.0.md` §8，
  含 7 条后续优化项（渠道插件双重物化验证、fs-safe native 模式对照、agent 会话裁剪、
  插件包瘦身、workspace 体检、健康复查、更细阶段可视化）。
- **验收**：ui 19/19（U18 增阶段断言、U19 增阶段与 trace 接线断言）；全量 30 套通过；双 typecheck 0 错；build 通过。

### 2026-10-31 · 不迁数据前提下的三项优化（语音热更 / 退出保留网关 / 启动 ETA）

约束：用户明确「不迁任何数据」→ 放弃 SSD 迁移方案，改为纯代码侧优化。

1. **语音音色热更（减少重启次数）**
   - 新增 `data/voice/tts-bridge.json`（应用原子写：speaker/resourceId 0600）；`volc-tts.mjs` 每次合成时读取，
     env 只做兜底。→ 改音色立即生效、**无需重启网关**；Key / tts 模式 / 通道变更仍需重启（Key 仍只走进程 env，不落盘）。
   - `openclawTts.buildOpenClawTtsEnv` 增加 `UMI_VOICE_SETTINGS_FILE`；语音页保存提示同步更新。
   - 验收：`voice.accept` 新增 `hot-speaker`（env 路径 / 原子写 / 保存即更新 / 脚本确实读取）→ 20/20。

2. **退出应用时保留网关（可选开关，默认关）**
   - `AppConfig.keepGatewayOnQuit`（Config.vue 开关）；开启后网关以 `detached + 日志写文件` 方式启动，
     退出不再停网关；下次启动 `adoptRunningGateway()` 检测「进程存活 + /health 200」直接复用（跳过冷启动）。
   - 复用的网关 stop 用 taskkill 结束；运行时描述 `data/cache/gateway-runtime.json`。
   - 验收：`claw-maintenance` 新增 `keep-gateway`（复用/清理/设置关闭不复用/退出保留与停止）→ 28/28。

3. **启动 ETA**
   - 新增 `electron/main/startupStats.ts`（纯函数：追加/上限 5/中位数/估算/序列化），
     `clawManager` 记录最近几次 spawn→health 并暴露 `estimateStartupMs`；
     store `etaRemainingSeconds`，Dashboard 启动中显示「预计还需约 N」。
   - 验收：`stats-pure`、`eta-wiring` 用例。

### 2026-10-31（续）· 子代理审查后的阻断/重要问题修复

针对「退出保留网关未接线（阻断）／阶段与 ETA 未推送／preparing 状态矛盾／adopt 竞态与身份校验／日志 tail 全量读」逐条修复：

- **退出路径接线**：`quitApp`、托盘「退出」、`before-quit` 统一走 `clawManager.handleAppQuit()`（幂等）；
  开启保留时不再杀网关，关闭时照常停止。
- **statusChange 推送**：payload 补 `bootPhase` / `estimateStartupMs`；U18 增加「statusChange → phase/ETA」行为断言。
- **preparing 状态**：`getStatus` 把 `startInFlight` 纳入 starting，bootPhase 返回 `preparing`（刷新窗口不再显示已停止）。
- **adopt 加固**：启动时 `await adopt` 后再决定 autoStart；`start()` 优先识别 adoptedPid；
  复用前校验「端口 owner pid == 记录 pid」「openclaw 版本一致」；允许等待 loading 中的网关（≤3 分钟），
  超时/taskkill 失败返回错误；taskkill 后回读存活；adopt 后 30s 健康巡检，失联自动置 idle。
- **文件日志 tail**：改为 `stat + read(offset)` 增量读（不再整文件 readFileSync）、保留半行 carry、
  截断检测、stdout/stderr 分开（`.err.log`）、兼容 pino `msg`；adopt 从末尾 64KB 开始。
- **其它**：热更文件只在 bridge 通道存在（其它通道清理）；rename 失败清 tmp；Dashboard ETA/preparing 改为独立 v-if；
  ETA 以 spawn 时刻为基准且只在 spawning/loading 显示；runtime 描述仅在 detached 模式写、含 openclawVersion；
  `OPENCLAW_GATEWAY_STARTUP_TRACE` 改为默认关（`CLAW_OC_STARTUP_TRACE=1` 打开）；fs-safe 覆盖值白名单；
  V8 编译缓存 >512MB 后台清理。
- **测试**：maintenance 增加「端口 owner 不一致拒绝复用」「生产退出接线/推送接线」断言；voice 增加「非 bridge 清理热更文件」断言。
- **说明**：`tts-bridge.json` 在 Windows 上 POSIX `0600` 不生效（mode 位被忽略），文件本身不含 Key；
  上一版文档「0600」表述已修正。
- **既有 flaky**：`shooting.accept` 的并发请求顺序断言偶发（`['0','2','1']`），与本轮改动无关，重跑通过。

### 2026-10-31（续 2）· 启动耗时实测收敛：648s 为一次异常，325s 为当前最佳

- 648s 那轮：`process.bootstrap` 184s、`main-session-recovery` 463s、feishu 物化 295s（≈15 文件/s）；
  同时段机器在跑 typecheck/构建/全量验收，且是首次写 V8 编译缓存（2,264 文件/10.9MB）→ 整机争用。
- 325s 那轮（缓存已热、无并发测试）：feishu 物化 170s、weixin 32s、wecom 40s；
  剩余 ~80s 为 bootstrap/配置/状态；与 355/364s 对比说明 `NODE_COMPILE_CACHE` 有小幅正收益。
- ETA 估算修正：样本 ≤2 次时用「最近一次」而不是中位数，避免 648s 这类一次性异常把预估拉高。

## 2026-10-31 · 启动可靠性修复包跨分支同步（3.0 / 2.0 / master / 1.0）

4.0 的启动慢优化（就绪态/阶段/ETA + webhook 迁移标记兜底 + 退出保留网关 + 日志 tail）已在 4.0 稳定，
因 1.0/2.0/3.0 与本版本共用同一套 OpenClaw 网关启动链路，本日将修复包按功能簇移植到各发布线，
并在各分支自己的测试体系下验证后合并、推送。

### 同步内容（按分支适用范围）
- **就绪态与阶段可视化**：`running`（进程）与 `ready`（/health 200）分离；点击启动即 preparing；
  `claw:waitReady` IPC；`statusChange` 推送 `starting/ready/startedAt/startupMs/bootPhase/estimateStartupMs`；
  Dashboard 显示阶段文案与 ETA、启动中禁用重启按钮
- **webhook 迁移标记兜底**：仅当 telegram/feishu/msteams/nextcloud-talk 无 `legacyWebhook` 时补
  `meta.migrations.webhookListeners=true`，避免每次启动重跑旧迁移（约 185s 级）；走官方写入串行队列，
  备份 + 原子写回退 + BOM/CRLF 保留
- **退出保留网关（可选，默认关）**：网关 detached + stdout/stderr 分文件；退出路径统一幂等 `handleAppQuit`；
  下次启动 `adoptRunningGateway()` 校验端口 owner pid、openclaw 版本、进程存活后直接复用（跳过冷启动）
- **启动 ETA**：记录最近 5 次 spawn→health，样本 ≤2 用最近一次、≥3 取最近 3 次中位数
- **文件日志 tail**：stat+read(offset) 增量读、半行 carry、截断检测、stdout/stderr 分流、兼容 pino `msg`
- **环境开关**：`OPENCLAW_GATEWAY_STARTUP_TRACE` 默认关（`CLAW_OC_STARTUP_TRACE=1` 开启）；
  `OPENCLAW_FS_SAFE_NATIVE_MODE` 覆盖值白名单；`NODE_COMPILE_CACHE` 落 data/cache 并 >512MB 后台清理

### 审查后收尾（合并前审查发现）
- adopt 复用后台网关时 `startupMs` 置 undefined，避免 Dashboard 显示网关历史运行时长
- 编译缓存清理移出 detached 分支（默认 keep=false 用户也需要）
- `serializePatch` 改 `then(cleanup, cleanup)`，避免任务 reject 时 unhandledRejection
- 渲染端 `AppConfig` 补 `keepGatewayOnQuit` 字段

### 合并落点（2026-10-31，均已推送 origin）
- `release/3.0` @ `480fd60`（启动修复包 + 语音音色热更，按 3.0 无插件体系适配）
- `release/2.0` @ `fabce3e`（启动修复包 + 语音音色热更，保留营销卡）
- `master` @ `815c984`（启动修复包，不含语音模块）
- `release/1.0` @ `9b51b8b`（= master 修复包 + 原有鱼语音，未引入语音热更；顺带清理克隆轮询死代码）
- `release/4.0` @ `9408ebc`（审查后收尾修复）

### 灰度/冒烟建议
- 开启保留网关 → 重启应用 → 退出 → 再开：应秒级复用且无异常「本次启动耗时」；关闭后退出应正常停网关
- 升级核心包后旧后台网关应被拒绝复用并结束
- 2.0/3.0：改音色不重启网关；改 Key/TTS 模式/通道仍需重启
- master/1.0：托盘/关窗/系统退出三入口确认终端与网关按设置停止/保留
