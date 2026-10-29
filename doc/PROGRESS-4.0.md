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
| Phase 1 · WP4 插件管理页 | ✅ | plugin 30/30、全量 337/337 |
| Phase 1 · WP2 每插件独立库 | ⬜ | — |
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

- 本轮为契约新增（尚无独立审查轮），WP4/WP2 完成后会按规则各派审查 + 对抗两路。
