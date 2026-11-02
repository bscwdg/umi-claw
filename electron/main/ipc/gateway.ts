// electron/main/ipc/gateway.ts —— work 域 Gateway 只读面（宿主级能力，4.1 WP6-b 拆分）
//
// 为什么只有两条通道：§14.2 的 `OPENCLAW_NOT_READY` 前端典型处理是「显示启动引导」——
// 那就必须有一个**只读的就绪面**让页面能问「现在能不能调 AI、端口是多少、端点开没开」；
// 再加一条幂等的 `ensureReady`（探活 → 按需自动拉起 → 就绪轮询）给「重试/手动拉起」按钮用。
//
// Phase 4 / 4.1 WP6-b 起按域拆开：work 命名空间由**宿主**持有（网关是宿主级能力，插件停用
// 也要能看状态）；marketing 命名空间归营销插件（见 plugins/marketing/main/ipc/gateway.ts）。
// 之前两套通道由同一次调用注册，导致「停用营销后 marketing:gateway:* 仍然活着」。
//
// 失败统一信封：{ ok: false, error: { code, message, details? } }

import { ipcMain } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../services/errors'
import type { GatewayClient, GatewayStatusSnapshot } from '../gatewayClient'

/** IPC 统一返回信封 */
export type GatewayIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

/** §14 契约：work 域 gateway 面只注册这两条（只读 + 幂等，均不携带 token 出主进程） */
export const WORK_GATEWAY_CHANNELS = {
  status: 'work:gateway:status',
  ensureReady: 'work:gateway:ensureReady'
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

/** 注册 work 域 Gateway 只读面（宿主级；marketing 面见插件侧 gateway.ts） */
export function registerWorkGatewayIpc(gateway: GatewayClient): void {
  hostHandle(WORK_GATEWAY_CHANNELS.status, () => wrap<GatewayStatusSnapshot>(() => gateway.getStatus()))
  hostHandle(WORK_GATEWAY_CHANNELS.ensureReady, () =>
    wrap<GatewayStatusSnapshot>(() => gateway.ensureReady())
  )
}

/** 兼容旧测试/脚本入口：只注册宿主自有 work 面（marketing 面归插件） */
export function registerGatewayIpc(gateway: GatewayClient): void {
  registerWorkGatewayIpc(gateway)
}
