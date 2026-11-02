// electron/main/ipc/host/importStatus.ts —— 旧库导入状态 / 重试入口（4.0.2 P2）
//
// 为什么由宿主注册：导入失败要「用户可见 + 一键重试」，UI 是宿主壳（任何插件页都能看到横幅），
// 不能依赖某个插件页面自己实现；实际重试执行器由插件在 activate 时注册到 services。
// 通道：plugin:import:status（读 work/marketing 的 import-status.json）、plugin:import:retry。

import { AppError, ERROR_CODES, toErrorEnvelope } from '../../services/errors'
import type { HostIpcRegistrar } from './types'

export interface ImportStatusIpcDeps {
  /** 读各插件目录下的 import-status.json（不存在则不返回该项） */
  listStatuses: () => unknown
  /** 触发某插件的重试导入（插件未激活/未注册时抛错） */
  retry: (pluginId: string) => Promise<void>
}

/** 只允许重试已知内置插件：避免任意 pluginId 被当成入口 */
const RETRYABLE_PLUGIN_IDS = ['work', 'marketing'] as const

export function registerImportStatusIpc(ipc: HostIpcRegistrar, deps: ImportStatusIpcDeps): void {
  ipc.handle('plugin:import:status', () => ({ ok: true, data: deps.listStatuses() }))
  ipc.handle('plugin:import:retry', async (_e, pluginId: string) => {
    try {
      const id = String(pluginId ?? '')
      if (!RETRYABLE_PLUGIN_IDS.includes(id as (typeof RETRYABLE_PLUGIN_IDS)[number])) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持重试导入的插件：${id}`, {
          field: 'pluginId'
        })
      }
      await deps.retry(id)
      return { ok: true, data: true }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })
}
