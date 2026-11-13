// plugin-sdk/src/client.ts —— 官方插件 UI 的类型入口（第三方 v1 不开放 UI）
//
// 与 public 分开：client 依赖渲染端类型（vue-router / Vue Component），不能进主进程
// 的 typecheck；官方 renderer.ts 从这里取 PluginUiModule。

export type {
  PluginNavGroup,
  PluginNavItem,
  PluginUiHost,
  PluginUiModule
} from '../../src/renderer/pluginUi'
