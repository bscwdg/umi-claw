// plugins/marketing/main/ipc/gateway.ts —— 营销域 gateway 只读面（4.1 WP6-b 从 host 搬入插件）
//
// 为什么在插件里：marketing:gateway:* 是营销插件自己的能力面，插件停用就该摘掉；
// work:gateway:*（宿主级能力）仍由 electron/main/ipc/gateway.ts 用宿主 ipcMain 注册。
// 本文件走插件的 channelRegistrar（激活时接管、停用即摘除），不直接 import electron。

import { channelHandle } from './channelRegistrar'
import { toErrorEnvelope, type ErrorEnvelope } from '../../../../electron/main/services/errors'
import type { GatewayClient, GatewayStatusSnapshot } from '../../../../electron/main/gatewayClient'

/** IPC 统一返回信封 */
type GatewayIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

/**
 * 2.0 营销域 gateway 面：通道名独立，但**共用同一个 GatewayClient 实例**（单例约束）。
 * 合并说明（MERGE-INVENTORY C-5）：两套 `*_GATEWAY_CHANNELS` 并存，由各自域注册。
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

/** 营销域 gateway 面：由 marketing 插件在自己的通道租约下注册（停用即摘除） */
export function registerMarketingGatewayIpc(gateway: GatewayClient): void {
  channelHandle(
    MARKETING_GATEWAY_CHANNELS.status,
    () => wrap<GatewayStatusSnapshot>(() => gateway.getStatus()) as never
  )
  channelHandle(
    MARKETING_GATEWAY_CHANNELS.ensureReady,
    () => wrap<GatewayStatusSnapshot>(() => gateway.ensureReady()) as never
  )
}
