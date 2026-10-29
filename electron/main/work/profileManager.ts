// work/profileManager.ts —— 工作画像（PLAN-3.0.md §三 profile / §14 契约 / §八 冷启动）
//
// 契约：
//   - **单行表**：`id` 恒为 `'default'`，不存在第二行
//   - `get()` 返回 `{ profile, completeness }` —— 完整度随 get 返回（§14：不单独开通道）
//   - `update(patch)` 局部更新（参数约定 2：未传字段不动，不是置空）
//   - 画像字段是「岗位差异压缩原则」的落点（§一）：扩行业只进画像/模板/提示词/事项预设四层
//
// 设计约束：本模块**不 import electron**，依赖（DatabaseClient）注入，
// 因此可在纯 Node 下被 esbuild bundle 后直接测试。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** 单行画像的固定主键 */
export const PROFILE_ROW_ID = 'default'

/** 画像行（与 schema.ts 的 profile DDL / db-worker 白名单一一对应） */
export interface ProfileRow {
  id: string
  call_name: string | null
  position: string | null
  department: string | null
  company: string | null
  report_to: string | null
  tone: string | null
  report_style: string | null
  industry: string | null
  created_at: number
  updated_at: number
}

/** 完整度参与字段（六项等权，与 2.0 商家大脑同口径：联系方式类不算「AI 认识你」的语义信息） */
export const PROFILE_COMPLETENESS_FIELDS = [
  'call_name',
  'position',
  'department',
  'company',
  'report_to',
  'tone'
] as const

export interface ProfileCompleteness {
  filled: number
  total: number
  percent: number
  /** 还缺哪些字段（UI 弱存在感提示用：补上 X 可到 Y%） */
  missing: string[]
}

export interface ProfileView {
  profile: ProfileRow
  completeness: ProfileCompleteness
}

/** update 的输入：字段名用驼峰（IPC 面），落库转下划线 */
export interface UpdateProfileInput {
  callName?: string | null
  position?: string | null
  department?: string | null
  company?: string | null
  reportTo?: string | null
  tone?: string | null
  reportStyle?: string | null
  industry?: string | null
}

/** 允许 update 的字段白名单（禁止改 id / created_at） */
export const PROFILE_UPDATABLE_FIELDS = [
  'call_name',
  'position',
  'department',
  'company',
  'report_to',
  'tone',
  'report_style',
  'industry'
] as const

const CAMEL_TO_SNAKE: Record<keyof UpdateProfileInput, (typeof PROFILE_UPDATABLE_FIELDS)[number]> = {
  callName: 'call_name',
  position: 'position',
  department: 'department',
  company: 'company',
  reportTo: 'report_to',
  tone: 'tone',
  reportStyle: 'report_style',
  industry: 'industry'
}

export interface ProfileManagerOptions {
  /** DB Worker 客户端（唯一数据访问通道，硬规则 2） */
  database: DatabaseClient
  logger?: (message: string) => void
}

export class ProfileManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void

  constructor(options: ProfileManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ProfileManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ProfileManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /**
   * 读画像（单行）。**惰性建行**：首次 get 时 INSERT OR IGNORE，
   * 保证「装完即用」——用户没填任何资料也能拿到一条结构完整的画像。
   */
  async get(): Promise<ProfileView> {
    await this.database.request('profile.upsert', {
      data: { id: PROFILE_ROW_ID }
    })
    const row = await this.database.request<ProfileRow | null>('profile.get', {
      keys: { id: PROFILE_ROW_ID }
    })
    if (!row) {
      // upsert 后仍读不到：属于真异常，不静默兜底
      throw new AppError(ERROR_CODES.DB_ERROR, '画像行写入后读取失败')
    }
    return { profile: row, completeness: computeCompleteness(row) }
  }

  /** 局部更新（未传字段不动；显式传 null 才是清空） */
  async update(input: UpdateProfileInput): Promise<ProfileView> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'update 需要一个入参对象')
    }
    const patch: Record<string, unknown> = {}
    for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
      const value = (input as Record<string, unknown>)[camel]
      if (value === undefined) continue
      if (value !== null && typeof value !== 'string') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `字段 ${camel} 必须是字符串或 null`, { field: camel })
      }
      const trimmed = typeof value === 'string' ? value.trim() : value
      patch[snake] = trimmed === '' ? null : trimmed
    }
    if (!Object.keys(patch).length) {
      // 空 patch 不是错误，但没有可写字段时直接返回当前状态（幂等）
      this.log('[profile] update 收到空 patch，未改动任何字段')
      return this.get()
    }
    // 惰性建行后再更新（保证 update 先于 get 也不会 NOT_FOUND）
    await this.database.request('profile.upsert', { data: { id: PROFILE_ROW_ID } })
    await this.database.request('profile.update', {
      keys: { id: PROFILE_ROW_ID },
      data: patch,
      required: true
    })
    return this.get()
  }
}

/** 完整度：六项等权；未填（NULL 或空串）计入缺失 */
export function computeCompleteness(row: ProfileRow): ProfileCompleteness {
  const missing: string[] = []
  for (const field of PROFILE_COMPLETENESS_FIELDS) {
    const value = row[field as keyof ProfileRow]
    if (value === null || value === undefined || String(value).trim() === '') missing.push(field)
  }
  const total = PROFILE_COMPLETENESS_FIELDS.length
  const filled = total - missing.length
  return { filled, total, percent: Math.round((filled / total) * 100), missing }
}

/** 工厂（与 2.0 各 Manager 同风格：显式注入，禁止全局隐式推断） */
export function createProfileManager(options: ProfileManagerOptions): ProfileManager {
  return new ProfileManager(options)
}
