// businessManager.ts —— Business（商家大脑）+ Watchlist（关注词）（PLAN-2.0.md Commit 04）
//
// 契约（§一 定位 / §二 硬规则 9 / §四 Schema / §五 IPC / §七 Commit 04 / §十 概念备忘）：
//   - Business 与 Project **1:1**（`businesses.project_id UNIQUE`）：没有独立 list / create，
//     只有 `get` / `upsert`（§五）。`get` 无行 → `null`（UI 首填场景，不是错误）。
//   - 每个业务方法**显式接收 projectId**，绝不读全局 currentProject 做隐式推断（硬规则 9）。
//   - `project_watchlist` = 老板自己关注的行业词；**一期只作为 AI 上下文与关注点记录**（§十）。
//
//   ⚠️ 本模块**绝不联网、绝不采集**：
//      - 不发起任何网络请求（本文件不 import 任何网络模块，也不使用任何网络 API）；
//      - 不触发采集任务、不产生采集结果——采集只属于 Commit 11 的 collector adapter（硬规则 12，
//        「热点采集永不改成 Agent 任务」），Watchlist 的 AI 扩词推荐属 Commit 08。
//      - 这里的读写全部落在本地 SQLite，等价于「老板往记事本上抄了一个词」。
//
// 设计约束：本模块**不 import electron**，依赖（DatabaseClient / logger）全部注入，
// 因此可在纯 Node 下被 esbuild bundle 后直接测试（test/business.accept.mjs）。
//
// upsert 的 SQL 形态：走 DB Worker 的 `businesses.upsert`（= `INSERT … ON CONFLICT(<pk>) DO UPDATE`），
// 第一次（无行）走 `businesses.create`，撞 `UNIQUE(project_id)` 时回落更新路径——见 upsertBusiness 注释。

import { randomUUID } from 'node:crypto'
import { AppError, ERROR_CODES, errorCodeOf } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** businesses 表可写字段白名单（与 §四 DDL / db-worker.mjs 的 businesses 白名单一一对应） */
export const BUSINESS_FIELDS = [
  'name',
  'brand',
  'city',
  'address',
  'phone',
  'positioning',
  'target_customer',
  'tone'
] as const
export type BusinessField = (typeof BUSINESS_FIELDS)[number]

/** 单字段长度上限（防误粘整篇文档进表单；Oracle/Excel 之外的纯产品约束） */
export const BUSINESS_FIELD_MAX_LENGTH = 200

/**
 * 「商家资料完整度」计分字段（Business 维度，§七 Commit 04）。
 * **六个等权**：name / brand / city / positioning / target_customer / tone。
 * - 不含 address / phone：这两项属于「联系方式」，缺失不影响 AI 是否"认识这个商家"；
 * - 不含 Knowledge 维度（§七 v1.13：Knowledge 维度随 Commit 05 接入）。
 * `src/stores/marketing.ts` 的 `BUSINESS_COMPLETENESS_FIELDS` 必须与本表一致
 * （跨 tsconfig 无法共享常量，故由 test/business.accept.mjs 做静态一致性核对）。
 */
export const BUSINESS_COMPLETENESS_FIELDS = [
  'name',
  'brand',
  'city',
  'positioning',
  'target_customer',
  'tone'
] as const

/** 单个 Project 的关注词上限（§七 Commit 04：上限 10 词） */
export const WATCHLIST_MAX = 10

/** 关注词长度上限（trim 后计算） */
export const WATCHLIST_KEYWORD_MAX_LENGTH = 30

/** 关注词类型取值（§四 `project_watchlist.type` 注释：industry / product / audience / region） */
export const WATCHLIST_TYPES = ['industry', 'product', 'audience', 'region'] as const
export type WatchType = (typeof WATCHLIST_TYPES)[number]

/** businesses 表一行 */
export interface BusinessRow {
  id: string
  project_id: string
  name: string | null
  brand: string | null
  city: string | null
  address: string | null
  phone: string | null
  positioning: string | null
  target_customer: string | null
  tone: string | null
  created_at: number
  updated_at: number
}

/** upsert 入参：只接受白名单字段；`string` / `''`（归一为 null）/ `null`（显式置空）；未传 = 不改 */
export type BusinessInput = Partial<Record<BusinessField, string | null>>

/** project_watchlist 表一行 */
export interface WatchRow {
  project_id: string
  keyword: string
  type: string | null
  enabled: number
  created_at: number
}

export interface BusinessManagerOptions {
  /** DB Worker 客户端（唯一的数据访问通道，硬规则 8） */
  database: DatabaseClient
  /** 日志（默认静默） */
  logger?: (message: string) => void
}

export interface WatchlistManagerOptions {
  database: DatabaseClient
  logger?: (message: string) => void
}

// ── Business：商家大脑（1:1） ─────────────────────────────────────────────────

export class BusinessManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void

  constructor(options: BusinessManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'BusinessManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'BusinessManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /**
   * 读取该 Project 的 Business（1:1）。
   *
   * **无行 → `null`，不抛 NOT_FOUND**：老板第一次进「商家大脑」时本来就没有行，
   * 这是正常状态而不是错误（抛错会让 UI 把首填场景渲染成故障页）。
   */
  async getBusiness(projectId: string): Promise<BusinessRow | null> {
    const id = requireId(projectId, 'getBusiness')
    const rows = await this.database.request<BusinessRow[]>('businesses.list', {
      where: { project_id: id },
      order: ['created_at', 'id'],
      limit: 2
    })
    const list = Array.isArray(rows) ? rows : []
    if (list.length > 1) {
      // UNIQUE(project_id) 理论上不允许出现；真出现说明库被绕过 manager 写过，记日志留证据
      this.log(`[business] ⚠️ project_id=${id} 有 ${list.length} 行 business（UNIQUE 应保证 1:1）`)
    }
    return list[0] ?? null
  }

  /**
   * 保存 Business（新建或覆盖），返回落库后的行。
   *
   * 语义（**PATCH 式**，与 `Partial<Business>` 的契约一致）：
   *   - 传了字段：以本次值为准（空串/空白 → `null`，即「清掉」）
   *   - 没传字段（`undefined`）：**保留旧值**（新建时落 `null`）
   *   - `project` 不存在 → `NOT_FOUND`（不靠外键报错糊过去，错误码要能直接喂给 UI 分支）
   *
   * SQL：已有的 Project 走 `businesses.upsert`（`INSERT … ON CONFLICT(id) DO UPDATE SET …`，
   * **单条语句**完成「有则改、无则插」）；首次走 `businesses.create`，若并发下撞上
   * `UNIQUE(project_id)`（另一个写者刚好先插了）则回落更新路径重试一次，而不是把 CONFLICT
   * 抛给只想要「保存」的 UI（那是并发细节，不是用户错误）。
   */
  async upsertBusiness(projectId: string, data: BusinessInput): Promise<BusinessRow> {
    const id = requireId(projectId, 'upsertBusiness')
    const patch = normalizeBusinessFields(data)
    await assertProjectExists(this.database, id)

    for (let attempt = 1; attempt <= 2; attempt++) {
      const existing = await this.getBusiness(id)
      if (existing) return this.applyUpdate(id, existing, patch)

      const now = Date.now()
      const row: BusinessRow = {
        id: randomUUID(),
        project_id: id,
        name: null,
        brand: null,
        city: null,
        address: null,
        phone: null,
        positioning: null,
        target_customer: null,
        tone: null,
        ...patch,
        created_at: now,
        updated_at: now
      }
      try {
        const res = await this.database.request<{ row: BusinessRow }>('businesses.create', { data: row })
        const saved = res?.row ?? (await this.getBusiness(id))
        if (!saved) {
          throw new AppError(ERROR_CODES.DB_ERROR, 'Business 写入后读回失败', { projectId: id })
        }
        this.log(`[business] 已创建 project_id=${id}`)
        return saved
      } catch (e) {
        // 并发 upsert 撞 UNIQUE(project_id)：下一个 attempt 会读到那一行并改成更新路径
        if (errorCodeOf(e) === ERROR_CODES.CONFLICT && attempt < 2) {
          this.log(`[business] project_id=${id} 并发写入冲突，回落更新路径重试`)
          continue
        }
        throw e
      }
    }
    throw new AppError(ERROR_CODES.DB_ERROR, 'Business 保存失败（并发重试后仍未成功）', { projectId: id })
  }

  /** 更新路径：读旧 → 合并 PATCH → ON CONFLICT DO UPDATE（保留 created_at） */
  private async applyUpdate(id: string, existing: BusinessRow, patch: BusinessInput): Promise<BusinessRow> {
    const merged: Record<string, unknown> = {}
    for (const field of BUSINESS_FIELDS) {
      // 未传字段保留旧值；传了（含 null）以本次为准
      merged[field] = Object.prototype.hasOwnProperty.call(patch, field) ? patch[field] : existing[field]
    }
    const data = {
      id: existing.id,
      project_id: id,
      ...merged,
      // created_at 必须显式带上：ON CONFLICT DO UPDATE 会把未提供的列一起写成 excluded 值，
      // 漏掉它等于每次保存都把「创建时间」刷成现在
      created_at: existing.created_at,
      updated_at: Date.now()
    }
    const res = await this.database.request<{ row: BusinessRow }>('businesses.upsert', { data })
    const saved = res?.row ?? (await this.getBusiness(id))
    if (!saved) {
      throw new AppError(ERROR_CODES.DB_ERROR, 'Business 写入后读回失败', { projectId: id })
    }
    this.log(`[business] 已更新 project_id=${id}`)
    return saved
  }

  /**
   * 删除该 Project 的 Business（**幂等**：本来就没有 → `deleted:false`，不报错）。
   *
   * 与 §十「删除 Project」不同：Business 是 Project 的从属数据，删不到目标状态时
   * 重试是无害的，UI 也不需要为「这个词/这份资料已经没了」弹错误。
   * Project 本身被删时由 `ON DELETE CASCADE` 一并清掉，不经过这里。
   */
  async deleteBusiness(projectId: string): Promise<{ projectId: string; deleted: boolean }> {
    const id = requireId(projectId, 'deleteBusiness')
    const existing = await this.getBusiness(id)
    if (!existing) return { projectId: id, deleted: false }
    await this.database.request('businesses.delete', { keys: { id: existing.id } })
    this.log(`[business] 已删除 project_id=${id}`)
    return { projectId: id, deleted: true }
  }
}

// ── Watchlist：老板关注词（手工增删，**不采集**） ──────────────────────────────

export class WatchlistManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void

  constructor(options: WatchlistManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'WatchlistManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'WatchlistManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 列出该 Project 的关注词（`created_at` 升序；同刻按 keyword 收敛，排序稳定 UI 不抖） */
  async listWatchlist(projectId: string): Promise<WatchRow[]> {
    const id = requireId(projectId, 'listWatchlist')
    const rows = await this.database.request<WatchRow[]>('project_watchlist.list', {
      where: { project_id: id },
      order: ['created_at', 'keyword']
    })
    return Array.isArray(rows) ? rows : []
  }

  /**
   * 手工添加一个关注词。
   *
   * 校验顺序（先具体后笼统，报错要能直接告诉老板怎么回事）：
   *   1. projectId 缺失 → VALIDATION_ERROR
   *   2. keyword 空/超长（> 30） → VALIDATION_ERROR
   *   3. type 非法 → VALIDATION_ERROR
   *   4. project 不存在 → NOT_FOUND
   *   5. 已存在同名词 → **CONFLICT**（UI 要能提示「这个词已在列表里」，而不是笼统的"失败"）
   *   6. 已满 10 词 → VALIDATION_ERROR + `details:{ max: 10 }`
   *      （**不是** DB_ERROR：这是用户可读的业务约束，不是基础设施故障，UI 要就地提示）
   */
  async addWatch(projectId: string, keyword: string, type?: string | null): Promise<WatchRow> {
    const id = requireId(projectId, 'addWatch')
    const word = requireKeyword(keyword)
    const kind = normalizeWatchType(type)
    await assertProjectExists(this.database, id)

    const duplicate = await this.getWatch(id, word)
    if (duplicate) {
      throw new AppError(ERROR_CODES.CONFLICT, `关注词已在列表中: ${word}`, {
        projectId: id,
        keyword: word
      })
    }

    const current = await this.countWatch(id)
    if (current >= WATCHLIST_MAX) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `关注词最多 ${WATCHLIST_MAX} 个，请先删除一个再加`,
        { max: WATCHLIST_MAX, current, field: 'keyword' }
      )
    }

    const now = Date.now()
    try {
      const res = await this.database.request<{ row: WatchRow }>('project_watchlist.create', {
        data: { project_id: id, keyword: word, type: kind, enabled: 1, created_at: now }
      })
      const row = res?.row ?? (await this.getWatch(id, word))
      if (!row) throw new AppError(ERROR_CODES.DB_ERROR, '关注词写入后读回失败', { projectId: id, keyword: word })
      this.log(`[watchlist] +${word}（project_id=${id}，共 ${current + 1} 词）`)
      return row
    } catch (e) {
      // 并发下同一秒插入同一个词：主键冲突仍按 CONFLICT 暴露（语义与上面的预检查一致）
      if (errorCodeOf(e) === ERROR_CODES.CONFLICT) {
        throw new AppError(ERROR_CODES.CONFLICT, `关注词已在列表中: ${word}`, {
          projectId: id,
          keyword: word
        })
      }
      throw e
    }
  }

  /**
   * 移除关注词（**幂等**：不存在 → `removed:false`，不报错）。
   * 删除是「回到用户想要的状态」，重复点删除不该给老板弹错误。
   */
  async removeWatch(projectId: string, keyword: string): Promise<{ projectId: string; keyword: string; removed: boolean }> {
    const id = requireId(projectId, 'removeWatch')
    const word = requireKeyword(keyword)
    const existing = await this.getWatch(id, word)
    if (!existing) return { projectId: id, keyword: word, removed: false }
    await this.database.request('project_watchlist.delete', {
      keys: { project_id: id, keyword: word }
    })
    this.log(`[watchlist] -${word}（project_id=${id}）`)
    return { projectId: id, keyword: word, removed: true }
  }

  /**
   * 启停某个关注词（`enabled` 存 0/1）。
   * 词不存在 → `NOT_FOUND`：这是「修改」而不是「删除」，静默成功会变成
   * 「点了没反应但界面说好了」的幽灵 bug。
   */
  async setWatchEnabled(projectId: string, keyword: string, enabled: boolean | number): Promise<WatchRow> {
    const id = requireId(projectId, 'setWatchEnabled')
    const word = requireKeyword(keyword)
    const flag = normalizeEnabled(enabled)
    const existing = await this.getWatch(id, word)
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `关注词不存在: ${word}`, { projectId: id, keyword: word })
    }
    const res = await this.database.request<{ row: WatchRow }>('project_watchlist.update', {
      keys: { project_id: id, keyword: word },
      data: { enabled: flag }
    })
    const row = res?.row ?? (await this.getWatch(id, word))
    if (!row) throw new AppError(ERROR_CODES.DB_ERROR, '关注词写入后读回失败', { projectId: id, keyword: word })
    return row
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────────

  private async getWatch(projectId: string, keyword: string): Promise<WatchRow | null> {
    return await this.database.request<WatchRow | null>('project_watchlist.get', {
      keys: { project_id: projectId, keyword }
    })
  }

  private async countWatch(projectId: string): Promise<number> {
    const res = await this.database.request<{ count: number }>('project_watchlist.count', {
      where: { project_id: projectId }
    })
    return Number(res?.count ?? 0)
  }
}

/** 工厂（与 DatabaseClient / ProjectManager 同风格；便于纯 Node 测试与主进程 wiring） */
export function createBusinessManager(options: BusinessManagerOptions): BusinessManager {
  return new BusinessManager(options)
}

export function createWatchlistManager(options: WatchlistManagerOptions): WatchlistManager {
  return new WatchlistManager(options)
}

// ── 校验辅助（全部抛 §五 的 VALIDATION_ERROR） ────────────────────────────────

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

/** projectId 必须真实存在——写一个不存在的 project 只会留下孤儿行（外键报错太晚、文案也不好用） */
async function assertProjectExists(database: DatabaseClient, projectId: string): Promise<void> {
  const row = await database.request<{ id: string } | null>('projects.get', { keys: { id: projectId } })
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Project 不存在: ${projectId}`, { projectId })
  }
}

/**
 * 白名单 + 归一化。
 * - 未知字段 → VALIDATION_ERROR（静默丢弃会让「改了但没生效」变成幽灵 bug，必须炸在入口）
 * - 非字符串（且非 null）→ VALIDATION_ERROR
 * - 空串/空白 → `null`（避免 `''` 与 `null` 两种「空」并存）
 * - 超长 → VALIDATION_ERROR + `details:{ field, max, length }`
 */
function normalizeBusinessFields(data: BusinessInput | null | undefined): Record<string, string | null> {
  if (data === undefined || data === null) return {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'upsertBusiness 需要一个字段对象', { field: 'data' })
  }
  const unknown = Object.keys(data).filter((k) => !(BUSINESS_FIELDS as readonly string[]).includes(k))
  if (unknown.length) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `不允许写入的字段: ${unknown.join(', ')}（可写: ${BUSINESS_FIELDS.join(', ')}）`,
      { fields: unknown, allowed: [...BUSINESS_FIELDS] }
    )
  }
  const out: Record<string, string | null> = {}
  for (const field of BUSINESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue
    const raw = (data as Record<string, unknown>)[field]
    if (raw === undefined) continue
    if (raw === null) {
      out[field] = null
      continue
    }
    if (typeof raw !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `字段 ${field} 必须是字符串`, {
        field,
        type: typeof raw
      })
    }
    const text = raw.trim()
    if (text.length > BUSINESS_FIELD_MAX_LENGTH) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `字段 ${field} 过长（${text.length} > ${BUSINESS_FIELD_MAX_LENGTH}）`,
        { field, max: BUSINESS_FIELD_MAX_LENGTH, length: text.length }
      )
    }
    out[field] = text ? text : null
  }
  return out
}

function requireKeyword(value: unknown): string {
  const word = typeof value === 'string' ? value.trim() : ''
  if (!word) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '关注词不能为空', { field: 'keyword' })
  }
  if (word.length > WATCHLIST_KEYWORD_MAX_LENGTH) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `关注词过长（${word.length} > ${WATCHLIST_KEYWORD_MAX_LENGTH}）`,
      { field: 'keyword', max: WATCHLIST_KEYWORD_MAX_LENGTH, length: word.length }
    )
  }
  return word
}

/**
 * type 非法值 → VALIDATION_ERROR（不静默归一为 null）。
 * 理由：type 决定这个词喂给 AI 的分类（行业/产品/受众/地域），写错了会静默污染上下文质量；
 * 而 UI 侧的类型始终来自 `WATCHLIST_PRESET_TYPES`，正常路径不可能撞上。
 * 不传 / `null` / 空白 → `null`（= 未分类，合法）。
 */
function normalizeWatchType(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'type 必须是字符串', { field: 'type', type: typeof value })
  }
  const kind = value.trim()
  if (!kind) return null
  if (!(WATCHLIST_TYPES as readonly string[]).includes(kind)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法的关注词类型: ${kind}`, {
      field: 'type',
      value: kind,
      allowed: [...WATCHLIST_TYPES]
    })
  }
  return kind
}

/** enabled 归一为 0/1（接受 boolean 与 0/1，其余非法） */
function normalizeEnabled(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === 0 || value === 1) return value
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'enabled 必须是布尔值或 0/1', {
    field: 'enabled',
    value: value as unknown as string
  })
}
