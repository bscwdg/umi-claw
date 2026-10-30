// electron/main/ipc/index.ts —— IPC 注册聚合入口（PLAN-3.0.md §14）
//
// 现有 1.0 的 IPC 处理器仍平铺在 electron/main/index.ts 的 registerIpcHandlers() 里
// （1.0 能力一个不删）；3.0 新代码从这里聚合注册。
//
// 已注册：
//   Commit 01 → work.gateway（status / ensureReady 两条只读面，见 ipc/gateway.ts）
//   Commit 02 → work.profile / work.matters / work.todos（见 ipc/work.ts）
//   Commit 03 → work.records（含候选管线，见 ipc/work.ts）
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

export {
  registerGatewayIpc,
  registerWorkGatewayIpc,
  registerMarketingGatewayIpc,
  WORK_GATEWAY_CHANNELS,
  MARKETING_GATEWAY_CHANNELS
} from './gateway'
export type { GatewayIpcResult } from './gateway'
export {
  registerWorkIpc,
  WORK_PROFILE_CHANNELS,
  WORK_MATTERS_CHANNELS,
  WORK_TODOS_CHANNELS,
  WORK_RECORDS_CHANNELS,
  WORK_CONTEXT_CHANNELS,
  WORK_TODAY_CHANNELS,
  WORK_ROUTER_CHANNELS,
  WORK_REPORTS_CHANNELS,
  WORK_QA_CHANNELS,
  WORK_TOOLS_CHANNELS,
  WORK_KNOWLEDGE_CHANNELS,
  WORK_WIZARD_CHANNELS,
  WORK_REMINDER_CHANNELS
} from './work'
export type { WorkIpcResult, WorkIpcDeps } from './work'

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
} from './marketing'
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
