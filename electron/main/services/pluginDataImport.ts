// pluginDataImport.ts —— 域数据一次性导入（Phase 2/3 共用）
//
// 规则（PLAN §6.2 / D2）：
//   - **只读旧库**：只对旧库发 list，不写、不改、不删；
//   - 幂等：`<插件数据目录>/.imported` 存在就直接跳过；
//   - 可续传：失败不写标记；已写入的行用 upsert 收敛，重跑不会主键冲突；
//   - 分页：worker 单次 list 上限 5000，按页拉满，避免静默截断。
//
// work 与 marketing 各有一份旧库（work.db / umi-claw.db）和一套表，这里只做通用部分。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 旧库只需要 list */
export interface LegacyReader {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** 目标库只需要 upsert */
export interface ImportTarget {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** worker 的 list 上限（clampLimit 后单次最多 5000） */
const PAGE_SIZE = 5000

/** 只有「这张表在旧库里不存在」才允许跳过；其它错误必须冒泡 */
export function isMissingTableError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /no such table|no such column|未知方法|not in whitelist|unknown method/i.test(message)
}

export interface ImportOptions {
  source: LegacyReader
  target: ImportTarget
  pluginDataDir: string
  /** 表名（按外键依赖排序） */
  tables: readonly string[]
  /** app_meta 里要排除的 key 前缀（如宿主的 voice: 配置） */
  skipKeyPrefixes?: readonly string[]
  pageSize?: number
  logger?: (line: string) => void
  /** 重试入口用：忽略 .imported 标记强制再导一次（幂等 upsert，不删旧数据） */
  force?: boolean
}

export interface ImportResult {
  imported: boolean
  counts: Record<string, number>
  pages: Record<string, number>
  skipped: string[]
}

/** 旧库导入状态（宿主持久化到插件目录 import-status.json，供 UI 展示「失败 + 重试」） */
export interface ImportStatusRecord {
  pluginId: string
  state: 'ok' | 'skipped' | 'failed'
  error?: string
  counts?: Record<string, number>
  at: number
}

const IMPORT_STATUS_FILE = 'import-status.json'

export function readImportStatus(pluginDataDir: string): ImportStatusRecord | null {
  try {
    return JSON.parse(readFileSync(join(pluginDataDir, IMPORT_STATUS_FILE), 'utf-8')) as ImportStatusRecord
  } catch {
    return null
  }
}

function writeImportStatus(pluginDataDir: string, record: ImportStatusRecord): void {
  try {
    mkdirSync(pluginDataDir, { recursive: true })
    // 错误信息可能很长且含路径/数据片段：截断后再落盘（UI 只展示摘要）
    const safe: ImportStatusRecord = {
      ...record,
      error: record.error ? record.error.slice(0, 300) : undefined
    }
    // tmp + rename：避免进程崩溃时留下半截 JSON（readImportStatus 会当成无状态）
    const target = join(pluginDataDir, IMPORT_STATUS_FILE)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8')
    renameSync(tmp, target)
  } catch {
    // 状态写入失败不影响导入主流程
  }
}

/** 各插件的「重试导入」实际执行器（插件 activate 时注册，停用即摘） */
const retryHandlers = new Map<string, () => Promise<void>>()
/** 同一插件的重试串行化：连点两次只跑一次，第二次复用在途 Promise */
const retryInflight = new Map<string, Promise<void>>()

export function registerLegacyImportRetry(pluginId: string, handler: () => Promise<void>): void {
  retryHandlers.set(pluginId, handler)
}

export function clearLegacyImportRetry(pluginId: string): void {
  retryHandlers.delete(pluginId)
  retryInflight.delete(pluginId)
}

export async function runLegacyImportRetry(pluginId: string): Promise<void> {
  const inflight = retryInflight.get(pluginId)
  if (inflight) return inflight
  const handler = retryHandlers.get(pluginId)
  if (!handler) throw new Error('插件 ' + pluginId + ' 未注册旧库导入重试（插件未激活或已停用）')
  const run = handler().finally(() => retryInflight.delete(pluginId))
  retryInflight.set(pluginId, run)
  return run
}

export async function importTableData(options: ImportOptions): Promise<ImportResult> {
  const pluginId = basename(options.pluginDataDir)
  try {
    const result = await importTableDataInner(options)
    writeImportStatus(options.pluginDataDir, {
      pluginId,
      state: result.imported ? 'ok' : 'skipped',
      counts: result.counts,
      at: Date.now()
    })
    return result
  } catch (e) {
    writeImportStatus(options.pluginDataDir, {
      pluginId,
      state: 'failed',
      error: e instanceof Error ? e.message : String(e),
      at: Date.now()
    })
    throw e
  }
}

async function importTableDataInner(options: ImportOptions): Promise<ImportResult> {
  const marker = join(options.pluginDataDir, '.imported')
  const log = options.logger ?? (() => undefined)

  if (existsSync(marker) && !options.force) {
    return { imported: false, counts: {}, pages: {}, skipped: ['already-imported'] }
  }

  const pageSize = Math.min(options.pageSize ?? PAGE_SIZE, PAGE_SIZE)
  const skipPrefixes = options.skipKeyPrefixes ?? []
  const counts: Record<string, number> = {}
  const pages: Record<string, number> = {}
  const skipped: string[] = []

  for (const table of options.tables) {
    let offset = 0
    let page = 0
    let total = 0

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
        throw new Error(
          `[import] 读取 ${table} 失败：${e instanceof Error ? e.message : String(e)}`,
          { cause: e as Error }
        )
      }

      if (!Array.isArray(rows) || rows.length === 0) break
      page += 1

      for (const row of rows) {
        if (table === 'app_meta') {
          const key = String(row.key ?? '')
          if (skipPrefixes.some((prefix) => key.startsWith(prefix))) continue
        }
        await options.target.request(`${table}.upsert`, { data: row })
        total += 1
      }

      if (rows.length < pageSize) break
      offset += rows.length
    }

    counts[table] = total
    pages[table] = page
    if (total > 0) log(`[import] ${table}: ${total} 行${page > 1 ? `（${page} 页）` : ''}`)
  }

  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ at: Date.now(), counts, pages, skipped }, null, 2), 'utf-8')
  log(`[import] 完成：${JSON.stringify(counts)}`)
  return { imported: true, counts, pages, skipped }
}

/** work 域 8 表（外键依赖优先） */
export const WORK_TABLES = [
  'profile',
  'matters',
  'todos',
  'activity_log',
  'reports',
  'knowledge',
  'conversations',
  'app_meta'
] as const

/** marketing 域 11 表（外键依赖优先） */
export const MARKETING_TABLES = [
  'projects',
  'businesses',
  'knowledge_items',
  'knowledge_chunks',
  'hot_topics',
  'hot_topic_samples',
  'project_hot_topics',
  'project_watchlist',
  'contents',
  'content_versions',
  'app_meta'
] as const

/** 宿主的 voice 配置存在 app_meta 里，导入时必须排除 */
export const HOST_APP_META_PREFIXES = ['voice:', 'voice_'] as const
