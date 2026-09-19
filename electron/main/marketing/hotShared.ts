// hotShared.ts —— 热点采集（11）与 AI 评分（12）共用的纯工具
//
// 两个 manager 都分页读表（worker 单次硬上限 5000），也都按 heat/rank 给热点排序——
// 抽到这里只有一份真相，避免「5000 截断假设」与排序口径在四处拷贝里漂移（12 复审 6/8）。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** worker 单页硬上限（db-worker.mjs opList limit 上限） */
export const DB_PAGE_SIZE = 5000
/** 分页保险丝：50 万行还没读完一定是哪里坏了 */
export const DB_MAX_PAGES = 100

/**
 * 分页拉全一张表。
 * 采集/清理/评分路径绝不能假设「5000 行装得下」：截断会让旧指纹走 INSERT 撞 UNIQUE（C1）、
 * 引用集漏判击穿 v1.11 例外（C2）、雷达漏行（A5）、评分漏候选。
 */
export async function listAllRows<T>(
  database: Pick<DatabaseClient, 'request'>,
  table: string,
  where?: Record<string, unknown>
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < DB_MAX_PAGES; page += 1) {
    const rows = await database.request<T[]>(table + '.list', {
      where: where ?? {},
      limit: DB_PAGE_SIZE,
      offset: page * DB_PAGE_SIZE
    })
    const list = Array.isArray(rows) ? rows : []
    out.push(...list)
    if (list.length < DB_PAGE_SIZE) return out
  }
  throw new AppError(ERROR_CODES.DB_ERROR, table + ' 行数超过 ' + DB_PAGE_SIZE * DB_MAX_PAGES + '，停止处理以防失控')
}

/** 可排序的热点形状（采集行、评分视图都满足） */
export interface HeatRankRow {
  heat: number | null
  rank: number | null
  last_seen_at: number
}

/**
 * 榜单统一排序：heat 高者优先 → rank 靠前者优先 → last_seen 新者优先。
 * 采集雷达（cmpBoard）、评分选批、今日建议平分兜底共用这一份口径。
 */
export function compareHeatRank(a: HeatRankRow, b: HeatRankRow): number {
  const ha = typeof a.heat === 'number' ? a.heat : -1
  const hb = typeof b.heat === 'number' ? b.heat : -1
  if (ha !== hb) return hb - ha
  const ra = typeof a.rank === 'number' ? a.rank : 9999
  const rb = typeof b.rank === 'number' ? b.rank : 9999
  if (ra !== rb) return ra - rb
  return b.last_seen_at - a.last_seen_at
}
