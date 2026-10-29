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
| Phase 2 work 装箱 | ⬜ | — |
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
