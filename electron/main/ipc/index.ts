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
//
// 待接（按 Commit 顺序）：
//   07 → work.qa / work.tools
//   08 → work.knowledge
//   09 → 冷启动向导（渲染端为主，无新通道）
//
// 契约先于代码（硬规则 11）：任何新增通道先改 PLAN-3.0.md §14，再动实现。

export { registerGatewayIpc, WORK_GATEWAY_CHANNELS } from './gateway'
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
  WORK_REPORTS_CHANNELS
} from './work'
export type { WorkIpcResult, WorkIpcDeps } from './work'
