// work/migrate.ts —— work.db → plugins/work/data.db 的一次性导入（Phase 2 / D2）
//
// 规则（PLAN §6.2）：
//   - **只读旧库**：导入过程只对旧库发 list，不写、不改、不删；
//   - 幂等：`<插件数据目录>/.imported` 存在就直接跳过；
//   - 失败可重试：任何真实错误都抛出且**不写标记**；已写入的行用 upsert 收敛，重跑不会主键冲突。
//
// 对抗验收（P2 报告）修掉的三处：
//   A2  以前把所有错误当「缺表」吞掉 → 现在只有明确的「没有这张表/方法」才跳过；
//       库未就绪、IO、外键等一律抛出，避免「标记写成功但一行没导」。
//   A3  以前用 create（INSERT）→ 中断后重跑必撞主键；现在用 upsert。
//   A5  worker 的 list 上限是 5000（clampLimits），以前写 10 万是假承诺 → 现在分页拉满。

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

/** worker 的 list 上限（clampLimit 后单次最多 5000），分页以此为准 */
const PAGE_SIZE = 5000

/** 只有「这张表在旧库里不存在」才允许跳过；其它错误必须冒泡 */
function isMissingTableError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /no such table|no such column|未知方法|not in whitelist|unknown method/i.test(message)
}

/** 宿主的 voice 配置存在同一张 app_meta 里，导入时必须排除（否则插件库会拿到宿主的语音密钥类配置） */
function shouldSkipRow(table: string, row: Record<string, unknown>): boolean {
  if (table !== 'app_meta') return false
  const key = String(row.key ?? '')
  return key.startsWith('voice:') || key.startsWith('voice_')
}

export interface ImportResult {
  imported: boolean
  counts: Record<string, number>
  /** 每个表实际拉取的页数（>1 说明走了分页） */
  pages: Record<string, number>
  skipped: string[]
}

export async function importWorkDataIfNeeded(options: {
  /** 旧库（work.db） */
  source: LegacyReader
  /** 目标插件库 */
  target: PluginDbApi
  /** 插件数据目录（写 .imported 标记） */
  pluginDataDir: string
  pageSize?: number
  logger?: (line: string) => void
}): Promise<ImportResult> {
  const marker = join(options.pluginDataDir, '.imported')
  const log = options.logger ?? (() => undefined)

  if (existsSync(marker)) {
    return { imported: false, counts: {}, pages: {}, skipped: ['already-imported'] }
  }

  const pageSize = Math.min(options.pageSize ?? PAGE_SIZE, PAGE_SIZE)
  const counts: Record<string, number> = {}
  const pages: Record<string, number> = {}
  const skipped: string[] = []

  for (const table of TABLES) {
    let offset = 0
    let page = 0
    let total = 0

    // 分页拉满：worker 单次最多 5000，超过就会静默截断
    for (;;) {
      let rows: Array<Record<string, unknown>>
      try {
        rows = (await options.source.request(`${table}.list`, {
          limit: pageSize,
          offset
        })) as Array<Record<string, unknown>>
      } catch (e) {
        if (isMissingTableError(e)) {
          skipped.push(table)
          log(`[import] 跳过 ${table}（旧库没有这张表）`)
          break
        }
        // 真实错误：不写标记，让下次启动重试
        throw new Error(
          `[import] 读取 ${table} 失败：${e instanceof Error ? e.message : String(e)}`,
          { cause: e as Error }
        )
      }

      if (!Array.isArray(rows) || rows.length === 0) break
      page += 1

      for (const row of rows) {
        if (shouldSkipRow(table, row)) continue
        // upsert 而不是 create：中断后重跑不会撞主键
        await options.target.request(`${table}.upsert`, { data: row })
        total += 1
      }

      if (rows.length < pageSize) break
      offset += rows.length
    }

    counts[table] = total
    pages[table] = page
    if (total > 0) {
      log(`[import] ${table}: ${total} 行${page > 1 ? `（${page} 页）` : ''}`)
    }
  }

  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ at: Date.now(), counts, pages, skipped }, null, 2), 'utf-8')
  log(`[import] 完成：${JSON.stringify(counts)}`)
  return { imported: true, counts, pages, skipped }
}
