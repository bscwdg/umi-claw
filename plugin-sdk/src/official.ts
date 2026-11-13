// plugin-sdk/src/official.ts —— 官方插件专用的 internal 能力（第三方不可用）
//
// 这些服务（hostOps/legacyDb/consent/abort/registerChannelIpc/ctx.host.paths）
// 依赖宿主内部实现，不进入公开 API。第三方包构建时该入口会被 external 并拒绝解析。
// A3b 迁移期间官方插件仍可直接 import kernel；迁移完成后只允许从本入口取 internal。

export { definePlugin } from '../../electron/main/kernel'

export type {
  HostOpsApi,
  LegacyDbApi,
  PluginAbortApi,
  PluginConsentApi,
  PluginContext,
  PluginModule,
  PluginServiceBag,
  ServiceName
} from '../../electron/main/kernel'
