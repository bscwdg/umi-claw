// work/matterManager.ts —— 事项（PLAN-3.0.md §2.3 / §三 matters / §14 契约）
//
// 契约：
//   - 事项是**轻量的「这件事」**，不做成 Project 管理系统（硬规则 9）：
//     禁止膨胀出空间/成员/权限概念
//   - 字段只有 `name + status(active/archived) + color?`（可选 UI 字段，预设 6 色）
//   - 工作记录/待办**可挂**事项（弱关联，可空）；matters 删除时挂空而不删行（DB 层 SET NULL）
//   - `suggestMatter` 只产出**建议**，人工确认后才写（来源≠事实）
//
// 设计约束：本模块**不 import electron**，依赖注入，可在纯 Node 下测试。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** 事项状态（§2.3：只有 active / archived，没有更多态） */
export const MATTER_STATUS_ACTIVE = 'active'
export const MATTER_STATUS_ARCHIVED = 'archived'
export const MATTER_STATUSES = [MATTER_STATUS_ACTIVE, MATTER_STATUS_ARCHIVED] as const
export type MatterStatus = (typeof MATTER_STATUSES)[number]

/** 预设 6 色色板（§2.3 / 待拍板 ⑨：可选 UI 字段，不阻塞核心模型） */
export const MATTER_COLOR_PALETTE = [
  '#3B82F6', // 蓝
  '#10B981', // 绿
  '#F59E0B', // 橙
  '#EF4444', // 红
  '#8B5CF6', // 紫
  '#6B7280' // 灰
] as const

/** 默认色（不选就用灰） */
export const MATTER_COLOR_DEFAULT = MATTER_COLOR_PALETTE[5]

/** matters 表一行（与 schema.ts DDL / db-worker 白名单一一对应） */
export interface MatterRow {
  id: string
  name: string
  status: string
  color: string | null
  created_at: number
  updated_at: number
}

export interface CreateMatterInput {
  name: string
  color?: string | null
}

export interface UpdateMatterInput {
  name?: string
  status?: MatterStatus
  color?: string | null
}

/** 允许 update 的字段白名单（禁止改 id / created_at） */
export const MATTER_UPDATABLE_FIELDS = ['name', 'status', 'color'] as const

/** deleteMatter 的返回：描述这次删除真实做了什么 */
export interface DeleteMatterResult {
  id: string
  /** DB 行是否已删除（幂等：不存在 → false，但不报错） */
  rowDeleted: boolean
}

export interface SuggestMatterResult {
  /** 建议挂到哪个事项（无把握时为 null，不硬凑） */
  matterId: string | null
  /** 建议理由（可展示给用户） */
  reason: string
  /** 候选列表（按匹配度排序，供 UI 让用户选） */
  candidates: Array<{ matterId: string; name: string; score: number }>
}

export interface MatterManagerOptions {
  database: DatabaseClient
  logger?: (message: string) => void
  /** id 生成器（默认 randomUUID；注入让验收可断言） */
  newId?: () => string
  /** 当前时间（默认 Date.now；注入让验收可断言） */
  now?: () => number
}

export class MatterManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number

  constructor(options: MatterManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'MatterManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'MatterManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 列表（默认只看在跟事项；`status` 显式传才过滤）——「新→旧」由参数约定 4 保证 */
  async list(params: { status?: MatterStatus | 'all' } = {}): Promise<MatterRow[]> {
    const where: Record<string, unknown> = {}
    if (params.status && params.status !== 'all') {
      if (!MATTER_STATUSES.includes(params.status)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 status: ${params.status}`, { field: 'status' })
      }
      where.status = params.status
    }
    return this.database.request<MatterRow[]>('matters.list', {
      where,
      order: [{ column: 'created_at', direction: 'desc' }]
    })
  }

  async get(id: string): Promise<MatterRow> {
    const row = await this.database.request<MatterRow | null>('matters.get', {
      keys: { id: requireId(id, 'get') }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `事项不存在: ${id}`)
    return row
  }

  async create(input: CreateMatterInput): Promise<MatterRow> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'create 需要一个入参对象')
    }
    const name = normalizeName(input.name)
    const color = normalizeColor(input.color)
    const ts = this.now()
    const id = this.newId()
    await this.database.request('matters.create', {
      data: { id, name, status: MATTER_STATUS_ACTIVE, color, created_at: ts, updated_at: ts }
    })
    this.log(`[matter] 新建事项 ${id}（${name}）`)
    return this.get(id)
  }

  /** 局部更新（未传字段不动；显式传 null 才是清空 color） */
  async update(id: string, patch: UpdateMatterInput): Promise<MatterRow> {
    const matterId = requireId(id, 'update')
    if (!patch || typeof patch !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'update 需要一个 patch 对象')
    }
    const data: Record<string, unknown> = {}
    if (patch.name !== undefined) data.name = normalizeName(patch.name)
    if (patch.status !== undefined) {
      if (!MATTER_STATUSES.includes(patch.status)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 status: ${patch.status}`, { field: 'status' })
      }
      data.status = patch.status
    }
    if (patch.color !== undefined) data.color = normalizeColor(patch.color)
    if (!Object.keys(data).length) {
      this.log(`[matter] update(${matterId}) 空 patch，未改动`)
      return this.get(matterId)
    }
    // required: true → 不存在时 NOT_FOUND（update 对不存在资源无意义，参数约定 3）
    await this.database.request('matters.update', {
      keys: { id: matterId },
      data,
      required: true
    })
    return this.get(matterId)
  }

  /**
   * 删除（幂等，参数约定 3：不存在 → `{rowDeleted:false}` 且不报错）。
   * 挂在该事项下的 todos / activity_log 由 DB 层 `ON DELETE SET NULL` 挂空，**不删行**（§4.1 W7）。
   */
  async delete(id: string): Promise<DeleteMatterResult> {
    const matterId = requireId(id, 'delete')
    const res = await this.database.request<{ changes: number }>('matters.delete', {
      keys: { id: matterId }
    })
    const rowDeleted = Number(res?.changes ?? 0) > 0
    if (!rowDeleted) this.log(`[matter] delete(${matterId}) 不存在，幂等返回 false`)
    return { id: matterId, rowDeleted }
  }

  /**
   * AI 建议归属（§2.3：AI 可建议归属，**人工确认后才写**）。
   *
   * 一期用**确定性关键词匹配**（不是模型调用）：硬规则 6 的精神——
   * 能确定性做的不用模型。匹配不到的返回 null 建议，**不硬凑**。
   */
  async suggestMatter(recordText: string): Promise<SuggestMatterResult> {
    const text = typeof recordText === 'string' ? recordText.trim() : ''
    if (!text) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'suggestMatter 需要非空文本')
    }
    const active = await this.list({ status: MATTER_STATUS_ACTIVE })
    if (!active.length) {
      return { matterId: null, reason: '当前没有在跟事项', candidates: [] }
    }
    const scored = active
      .map((m) => ({ matterId: m.id, name: m.name, score: overlapScore(text, m.name) }))
      .filter((c) => c.score > 0)
      // 同分时**更长的名称优先**（更具体者胜）：
      // 「Q3活动」与「Q3活动方案」都能命中「Q3活动方案」，应选后者而不是碰运气
      .sort((a, b) => b.score - a.score || b.name.length - a.name.length)
    if (!scored.length) {
      return { matterId: null, reason: '没有事项名称与这段内容有明显重合', candidates: [] }
    }
    return {
      matterId: scored[0].matterId,
      reason: `与事项「${scored[0].name}」名称重合`,
      candidates: scored
    }
  }
}

/** 名称与文本的重合度：按事项名切词（中文按 2-gram），命中计分 */
function overlapScore(text: string, matterName: string): number {
  const name = matterName.trim()
  if (!name) return 0
  if (text.includes(name)) return 100
  const grams = new Set<string>()
  for (let i = 0; i + 2 <= name.length; i++) grams.add(name.slice(i, i + 2))
  let hits = 0
  for (const g of grams) if (text.includes(g)) hits += 1
  return grams.size ? Math.round((hits / grams.size) * 60) : 0
}

function requireId(id: unknown, op: string): string {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${op} 需要非空 id`, { field: 'id' })
  }
  return value
}

function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '事项名称不能为空', { field: 'name' })
  }
  if (value.length > 60) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '事项名称不能超过 60 字', { field: 'name' })
  }
  return value
}

/** color 只接受色板内的十六进制值或 null（默认灰） */
function normalizeColor(color: unknown): string | null {
  if (color === undefined || color === null) return null
  if (typeof color !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'color 必须是字符串或 null', { field: 'color' })
  }
  const value = color.trim()
  if (!value) return null
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'color 必须是 #RRGGBB 形式', { field: 'color' })
  }
  return value
}

export function createMatterManager(options: MatterManagerOptions): MatterManager {
  return new MatterManager(options)
}
