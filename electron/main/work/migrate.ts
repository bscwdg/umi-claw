// work/migrate.ts —— work.db → plugins/work/data.db 的一次性导入（Phase 2 / D2）
//
// 规则（PLAN §6.2）：
//   - **只读旧库**：导入过程只对旧库发 list，不写、不改、不删；
//   - 幂等：`<插件数据目录>/.imported` 存在就直接跳过；
//   - 失败可重试：任何一张表写失败就整体抛出（外层决定是否继续启动）。
//
// 注意顺序：先基础表（profile / matters）再引用它们的表（todos / activity_log），
// 最后 app_meta（偏好类，丢了最不影响可用性）。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PluginDbApi } from '../kernel/services'

/** 旧库只需要 list */
export interface LegacyReader {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** 导入顺序（外键依赖优先） */
const TABLES = [
  'profile',
  'matters',
  'todos',
  'activity_log',
  'reports',
  'knowledge',
  'conversations',
  'app_meta'
] as const

export interface ImportResult {
  imported: boolean
  counts: Record<string, number>
  /** 跳过原因（imported=false 时） */
  skipped?: string
}

export async function importWorkDataIfNeeded(options: {
  /** 旧库（work.db） */
  source: LegacyReader
  /** 目标插件库 */
  target: PluginDbApi
  /** 插件数据目录（写 .imported 标记） */
  pluginDataDir: string
  /** 单表上限，默认 10 万行 */
  limit?: number
  logger?: (line: string) => void
}): Promise<ImportResult> {
  const marker = join(options.pluginDataDir, '.imported')
  const log = options.logger ?? (() => undefined)

  if (existsSync(marker)) return { imported: false, counts: {}, skipped: 'already-imported' }

  const limit = options.limit ?? 100_000
  const counts: Record<string, number> = {}
  let anyRow = false

  for (const table of TABLES) {
    let rows: Array<Record<string, unknown>> = []
    try {
      rows = (await options.source.request(`${table}.list`, { limit })) as Array<Record<string, unknown>>
    } catch (e) {
      // 旧库里没有这张表（更老的版本）→ 跳过，不算失败
      log(`[import] 跳过 ${table}：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      counts[table] = 0
      continue
    }
    for (const row of rows) {
      await options.target.request(`${table}.create`, { data: row })
      anyRow = true
    }
    counts[table] = rows.length
    log(`[import] ${table}: ${rows.length} 行`)
  }

  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ at: Date.now(), counts }, null, 2), 'utf-8')
  log(`[import] 完成（${anyRow ? '有数据' : '旧库为空'}）`)
  return { imported: true, counts }
}
