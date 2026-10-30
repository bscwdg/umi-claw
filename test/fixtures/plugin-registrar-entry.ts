// test/fixtures/plugin-registrar-entry.ts
//
// P52 需要「同一模块实例」同时暴露插件装配与注册器状态：
// 两次 bundleEntry 会各自内联 channelRegistrar，模块级 active 不共享，断言会恒真（空断言）。
// 这个单入口把三样东西打进一个产物里，才能真观测到「激活结束是否复位注册器」。

export { default as marketing } from '../../plugins/marketing/main'
export { setChannelRegistrar, hasChannelRegistrar } from '../../electron/main/ipc/channelRegistrar'
export {
  registerWorkGatewayIpc,
  registerMarketingGatewayIpc,
  WORK_GATEWAY_CHANNELS
} from '../../electron/main/ipc/gateway'
