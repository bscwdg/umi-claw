// kernel/index.ts —— 内核出口。宿主只从这里取东西；插件只从这里取**类型**。

export {
  HOST_CAPABILITIES,
  missingCapabilities,
  parseManifest,
  PluginManifestError,
  type ManifestErrorCode,
  type PluginContributes,
  type PluginId,
  type PluginManifest,
  type PluginNavGroup
} from './manifest'
export {
  definePlugin,
  PLUGIN_IPC_PREFIX,
  pluginIpcChannel,
  type PluginConfigApi,
  type PluginContext,
  type PluginHostInfo,
  type PluginIpcHandler,
  type PluginJobs,
  type PluginLogger,
  type PluginModule
} from './plugin'
export {
  PluginRegistry,
  type PluginRecord,
  type PluginRuntimeError,
  type PluginSource,
  type PluginState
} from './registry'
export {
  PluginHost,
  type KernelIpc,
  type PluginHostOptions,
  type PluginStatus
} from './lifecycle'
export { discoverPlugins, type DiscoveredPlugin, type DiscoverOptions } from './discovery'
export { createJsonStateStore, createMemoryStateStore, type PluginStateStore } from './stateStore'
export { createPluginConfigStore, type PluginConfigStore } from './pluginConfigStore'
export {
  availableServices,
  SERVICE_NAMES,
  type HostOpsApi,
  type LegacyDbApi,
  type ServiceInfo,
  type ServiceName,
  type NotificationsApi,
  type OpenClawApi,
  type OpenClawChatInput,
  type OpenClawStatus,
  type OpenClawStreamHandle,
  type PluginDbApi,
  type PluginServiceBag,
  type ServiceFactories,
  type ServiceId,
  type VoiceApi
} from './services'
