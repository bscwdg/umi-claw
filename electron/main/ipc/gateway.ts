// electron/main/ipc/gateway.ts —— Gateway 面 IPC（PLAN-2.0.md Commit 07）
//
// 为什么只有两条通道（取舍理由见汇报「待拍板」）：§五 的错误码表里
// `OPENCLAW_NOT_READY` 的前端典型处理是「显示启动引导」——那就必须有一个**只读的就绪面**
// 让页面能问「现在能不能调 AI、端口是多少、端点开没开」；再加一条幂等的
// `ensureReady`（探活 → 按需自动拉起 → 就绪轮询）给「重试/手动拉起」按钮用。
//
// 业务流通道（advisor / content 的 SSE 增量）**不在这里**：
// 07 只提供 `forwardGatewayStream`（gatewayClient.ts 导出）与事件名常量，注册归 08/09。
//
// 失败统一信封：{ ok: false, error: { code, message, details? } }（与 ipc/marketing.ts 同构）

import { ipcMain } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { GatewayClient, GatewayStatusSnapshot } from '../gatewayClient'

/** IPC 统一返回信封 */
export type GatewayIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

/** §五 未列举 gateway 面，本提交只注册这两条（只读 + 幂等，均不携带 token 出主进程） */
export const MARKETING_GATEWAY_CHANNELS = {
  status: 'marketing:gateway:status',
  ensureReady: 'marketing:gateway:ensureReady'
} as const

async function wrap<T>(fn: () => Promise<T>): Promise<GatewayIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(channel: string, fn: (...args: any[]) => Promise<GatewayIpcResult<unknown>>): void {
  // 防御性：重复注册会抛 "Attempted to register a second handler"，先移除
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

/**
 * 注册 Gateway 只读面。
 *
 * - `status`：只读快照 `{ ready, port, baseUrl, endpointsEnabled, lastError }`
 *   （只发 `GET /health` + `GET /v1/models`，零 token、绝不触发拉起、绝不调 chat）
 * - `ensureReady`：探活 → 按需自动拉起（starter，复用 clawManager）→ 就绪轮询 → 同一快照
 */
export function registerGatewayIpc(gateway: GatewayClient): void {
  handle(MARKETING_GATEWAY_CHANNELS.status, () =>
    wrap<GatewayStatusSnapshot>(() => gateway.getStatus())
  )
  handle(MARKETING_GATEWAY_CHANNELS.ensureReady, () =>
    wrap<GatewayStatusSnapshot>(() => gateway.ensureReady())
  )
}
