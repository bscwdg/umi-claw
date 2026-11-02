// electron/main/ipc/index.ts —— 域 IPC 注册聚合入口（PLAN-3.0.md §14）
//
// 4.1 WP6-b 起：分域 IPC 已搬进插件（plugins/<id>/main/ipc/），本文件仅做兼容聚合；
// 4.1 WP5 起：宿主通道（window/app/log/shell/dialog/obsidian/skills/channels/config/
// claw/test-connection/term/env）已全部下沉 `electron/main/ipc/host/*`；
// 域 IPC（work / marketing）的 registrar 与通道表已搬进插件，这里 re-export 只为测试/兼容。
//
// 已注册：
//   Commit 01 → work.gateway（status / ensureReady 两条只读面，见 electron/main/ipc/gateway.ts（work 面））
//   Commit 02 → work.profile / work.matters / work.todos（见 plugins/work/main/ipc/work.ts）
//   Commit 03 → work.records（含候选管线，见 plugins/work/main/ipc/work.ts）
//   Commit 04 → work.context（Context Engine v3，只读快照面）
//   Commit 05 → work.today / work.router
//   Commit 06 → work.reports
//   Commit 07 → work.qa / work.tools
//   Commit 08 → work.knowledge
//   Commit 09 → work.wizard / work.reminder（冷启动 + 两个固定通知）
//
// 待接（按 Commit 顺序）：
//   10 → 「一天」端到端（仅验收，无新业务通道）
//
// 契约先于代码（硬规则 11）：任何新增通道先改 PLAN-3.0.md §14，再动实现。

export { registerGatewayIpc, registerWorkGatewayIpc, WORK_GATEWAY_CHANNELS } from './gateway'
export type { GatewayIpcResult } from './gateway'
export {
  registerMarketingGatewayIpc,
  MARKETING_GATEWAY_CHANNELS
} from '../../../plugins/marketing/main/ipc/gateway'

// ── 2.0 营销域（合并自 release/2.0，通道前缀 marketing:*，与 work:* 正交）──────────
export {
  registerMarketingIpc,
  MARKETING_SYSTEM_CHANNELS,
  MARKETING_PROJECT_CHANNELS,
  MARKETING_CONTEXT_CHANNELS,
  MARKETING_BUSINESS_CHANNELS,
  MARKETING_WATCHLIST_CHANNELS,
  MARKETING_KNOWLEDGE_CHANNELS,
  withMarketingBackup
} from '../../../plugins/marketing/main/ipc/marketing'
export {
  registerAdvisorIpc,
  abortAllAdvisorStreams,
  summarizePack,
  MARKETING_ADVISOR_CHANNELS
} from '../../../plugins/marketing/main/ipc/advisor'
export type {
  AdvisorIpcResult,
  AdvisorAskResult,
  AdvisorPackSummary,
  AdvisorWatchCandidatesResult
} from '../../../plugins/marketing/main/ipc/advisor'
export {
  registerScanIpc,
  abortAllScanStreams,
  activeScanCount,
  MARKETING_SCAN_CHANNELS
} from '../../../plugins/marketing/main/ipc/scan'
export type { ScanIpcResult, ScanRecognizeInput, ScanRecognizeResult } from '../../../plugins/marketing/main/ipc/scan'
export {
  registerContentIpc,
  abortAllContentGenerations,
  activeContentStreamCount,
  MARKETING_CONTENT_CHANNELS
} from '../../../plugins/marketing/main/ipc/content'
export type { ContentIpcResult, ContentGenerateResult } from '../../../plugins/marketing/main/ipc/content'
export { registerHotIpc, abortHotCollectors, MARKETING_HOT_CHANNELS } from '../../../plugins/marketing/main/ipc/hot'
export type { HotIpcResult } from '../../../plugins/marketing/main/ipc/hot'
export type { IpcResult } from '../../../plugins/marketing/main/ipc/marketing'
