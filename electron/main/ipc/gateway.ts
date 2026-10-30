// electron/main/ipc/gateway.ts —— Gateway 面 IPC（PLAN-3.0.md Commit 01）
//
// 为什么只有两条通道：§14.2 的 `OPENCLAW_NOT_READY` 前端典型处理是「显示启动引导」——
// 那就必须有一个**只读的就绪面**让页面能问「现在能不能调 AI、端口是多少、端点开没开」；
// 再加一条幂等的 `ensureReady`（探活 → 按需自动拉起 → 就绪轮询）给「重试/手动拉起」按钮用。
//
// 业务流通道（qa / tools / reports 的 SSE 增量）**不在这里**：
// 本模块只提供 `forwardGatewayStream`（gatewayClient.ts 导出）与事件名常量，注册归各自 Commit。
//
// 失败统一信封：{ ok: false, error: { code, message, details? } }

import { ipcMain } from 'electron'
import { channelHandle } from './channelRegistrar'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { GatewayClient, GatewayStatusSnapshot } from '../gatewayClient'

/** IPC 统一返回信封 */
export type GatewayIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

/** §14 契约：work 域 gateway 面只注册这两条（只读 + 幂等，均不携带 token 出主进程） */
export const WORK_GATEWAY_CHANNELS = {
  status: 'work:gateway:status',
  ensureReady: 'work:gateway:ensureReady'
} as const

/**
 * 2.0 营销域 gateway 面：通道名独立，但**共用同一个 GatewayClient 实例**（单例约束）。
 * 合并说明（MERGE-INVENTORY C-5）：两套 `*_GATEWAY_CHANNELS` 必须并存、由同一次
 * `registerGatewayIpc` 注册；分开注册会因 `removeHandler` 静默覆盖而只活一个域。
 */
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

/** 宿主通道：直连 ipcMain（不能走插件注册器——那会在插件激活期间被劫持，见审查 P0#1） */
function hostHandle(
  channel: string,
  fn: (...args: any[]) => Promise<GatewayIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

/** 插件通道：走 channelRegistrar，插件激活时接管到自己的租约下（停用即摘除） */
function pluginHandle(
  channel: string,
  fn: (...args: any[]) => Promise<GatewayIpcResult<unknown>>
): void {
  channelHandle(channel, fn as never)
}

/**
 * 注册 Gateway 只读面。
 *
 * - `status`：只读快照 `{ ready, port, baseUrl, endpointsEnabled, lastError }`
 *   （只发 `GET /health` + `GET /v1/models`，零 token、绝不触发拉起、绝不调 chat）
 * - `ensureReady`：探活 → 按需自动拉起（starter，复用 clawManager）→ 就绪轮询 → 同一快照
 */
/**
 * 注册 Gateway 只读面。
 *
 * Phase 4：**按域拆开**——work 命名空间由宿主持有（网关是宿主级能力），
 * marketing 命名空间归插件（营销插件激活时用自己的通道租约注册，停用即摘除）。
 * 之前两套通道由同一次调用注册，导致「停用营销后 marketing:gateway:* 仍然活着」。
 */
export function registerWorkGatewayIpc(gateway: GatewayClient): void {
  hostHandle(WORK_GATEWAY_CHANNELS.status, () => wrap<GatewayStatusSnapshot>(() => gateway.getStatus()))
  hostHandle(WORK_GATEWAY_CHANNELS.ensureReady, () =>
    wrap<GatewayStatusSnapshot>(() => gateway.ensureReady())
  )
}

/** 营销域 gateway 面：由 marketing 插件在自己的通道租约下注册（不再由宿主代劳） */
export function registerMarketingGatewayIpc(gateway: GatewayClient): void {
  pluginHandle(
    MARKETING_GATEWAY_CHANNELS.status,
    () => wrap<GatewayStatusSnapshot>(() => gateway.getStatus())
  )
  pluginHandle(MARKETING_GATEWAY_CHANNELS.ensureReady, () =>
    wrap<GatewayStatusSnapshot>(() => gateway.ensureReady())
  )
}

/** 兼容旧调用：两个域一起注册（仅用于测试/脚本，生产按域调用） */
export function registerGatewayIpc(gateway: GatewayClient): void {
  registerWorkGatewayIpc(gateway)
  registerMarketingGatewayIpc(gateway)
}
