// electron/main/ipc/index.ts —— IPC 注册聚合入口
//
// 现有 IPC 处理器仍平铺在 electron/main/index.ts 的 registerIpcHandlers() 里
// （§三：第一阶段不搬任何现有文件）；新代码从这里聚合注册。
// Commit 02 接 marketing.system；Commit 03 追加 marketing.project / marketing.context；
// 04 追加 marketing.business / marketing.watchlist；05a 追加 marketing.knowledge；
// 07 追加 marketing.gateway（status / ensureReady 两条只读面，见 ipc/gateway.ts）；
// 09+/11+ 的 content/hot 在此继续追加。

export {
  registerMarketingIpc,
  MARKETING_SYSTEM_CHANNELS,
  MARKETING_PROJECT_CHANNELS,
  MARKETING_CONTEXT_CHANNELS,
  MARKETING_BUSINESS_CHANNELS,
  MARKETING_WATCHLIST_CHANNELS,
  MARKETING_KNOWLEDGE_CHANNELS,
  withMarketingBackup
} from './marketing'
export { registerGatewayIpc, MARKETING_GATEWAY_CHANNELS } from './gateway'
export type { GatewayIpcResult } from './gateway'
export type { IpcResult } from './marketing'
