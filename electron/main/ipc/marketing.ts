// electron/main/ipc/marketing.ts —— marketing IPC 面（PLAN-2.0.md §五）
//
// Commit 02 只暴露一个**真实可用**的最小面：marketing.system = { dbStatus, ping, metaGet, metaSet }。
// project / business / knowledge / content / hot 的完整 CRUD 归 Commit 03/04，此处**不提前实现**。
//
// 失败统一信封：{ ok: false, error: { code, message, details? } }
//   - code 取自 §五 错误码表（errors.ts 的 ERROR_CODES）
//   - 渲染端**禁止**用 error.message.includes() 判断，一律按 code 分支

import { ipcMain } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { BackupResult, DatabaseClient, DatabaseStatus } from '../database/database'

/** IPC 统一返回信封 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_SYSTEM_CHANNELS = {
  dbStatus: 'marketing:system:dbStatus',
  ping: 'marketing:system:ping',
  metaGet: 'marketing:system:metaGet',
  metaSet: 'marketing:system:metaSet'
} as const

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(channel: string, fn: (...args: any[]) => Promise<IpcResult<unknown>>): void {
  // 防御性：重复注册会抛 "Attempted to register a second handler"，先移除
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

export function registerMarketingIpc(database: DatabaseClient): void {
  handle(MARKETING_SYSTEM_CHANNELS.dbStatus, (options?: { initialize?: boolean }) =>
    wrap<DatabaseStatus>(() => database.dbStatus(options ?? {}))
  )
  handle(MARKETING_SYSTEM_CHANNELS.ping, () =>
    wrap(() => database.ping())
  )
  handle(MARKETING_SYSTEM_CHANNELS.metaGet, (key: string) =>
    wrap(() => database.metaGet(key))
  )
  handle(MARKETING_SYSTEM_CHANNELS.metaSet, (key: string, value: string | null) =>
    wrap(() => database.metaSet(key, value))
  )
}

/** 主进程内部使用（不做 IPC 暴露）：备份链路验证与退出前清理 */
export async function withMarketingBackup(
  database: DatabaseClient,
  reason: string
): Promise<BackupResult> {
  return database.backup(reason)
}
