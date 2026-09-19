// electron/main/ipc/index.ts —— IPC 注册聚合入口
//
// 现有 IPC 处理器仍平铺在 electron/main/index.ts 的 registerIpcHandlers() 里
// （§三：第一阶段不搬任何现有文件）；新代码从这里聚合注册。
// Commit 02 接 marketing.system；Commit 03 追加 marketing.project / marketing.context；
// 04 追加 marketing.business / marketing.watchlist；05a 追加 marketing.knowledge；
// 05b 追加扫描件识别（knowledge:recognize / recognize:abort / commitRecognized，见 ipc/scan.ts）；
// 07 追加 marketing.gateway（status / ensureReady 两条只读面，见 ipc/gateway.ts）；
// 08 追加 marketing.advisor（ask / abort / watchCandidates，流式增量走 07 的事件名）；
// 09 追加 marketing.content（CRUD + 一次 3 版生成 + 两路 abort + 版本面，流式增量同样走 07 事件名）；
// 11 追加 marketing.hot（list/get/refresh；score 归 12）。

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
export {
  registerAdvisorIpc,
  abortAllAdvisorStreams,
  summarizePack,
  MARKETING_ADVISOR_CHANNELS
} from './advisor'
export type {
  AdvisorIpcResult,
  AdvisorAskResult,
  AdvisorPackSummary,
  AdvisorWatchCandidatesResult
} from './advisor'
export {
  registerScanIpc,
  abortAllScanStreams,
  activeScanCount,
  MARKETING_SCAN_CHANNELS
} from './scan'
export type { ScanIpcResult, ScanRecognizeInput, ScanRecognizeResult } from './scan'
export {
  registerContentIpc,
  abortAllContentGenerations,
  activeContentStreamCount,
  MARKETING_CONTENT_CHANNELS
} from './content'
export type { ContentIpcResult, ContentGenerateResult } from './content'
export { registerHotIpc, abortHotCollectors, MARKETING_HOT_CHANNELS } from './hot'
export type { HotIpcResult } from './hot'
export type { IpcResult } from './marketing'
