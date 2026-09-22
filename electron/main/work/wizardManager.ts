// work/wizardManager.ts —— 冷启动向导状态 + 旧库三分支（PLAN-3.0.md §八 Day1 / 硬规则 17）
//
// 本模块承载 Commit 09 的**主进程侧**状态（向导页本身是渲染端）：
//   - 隐私告知同意（consent）——必过，同意才能继续
//   - 向导是否完成（completed）
//   - 旧库检测与三分支决定（沿用 / 另起 / 稍后决定；默认稍后决定，不阻塞）
//   - 「沿用」时从旧库只读映射字段（只读展示，绝不写旧库）
//
// 三条硬约束（硬规则 17）：绝不静默迁移、绝不覆盖旧数据、绝不阻塞启动。
// 旧数据始终由旧版本自己拥有，3.0 只读不写。
//
// 本模块不 import electron；DB 注入，oldDbLocator/reader 注入，纯 Node 可测。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

// ── app_meta 键（本模块唯一读写这些键；app_meta 无 worker 白名单）──
const META = {
  CONSENT: 'wizard_consent',
  COMPLETED: 'wizard_completed',
  OLDDB_DECISION: 'wizard_olddb_decision',
  OLDDB_VERSION: 'wizard_olddb_version'
} as const

export const CONSENT_GRANTED = 'granted'

/** 旧库三分支 */
export const OLDDB = {
  KEEP: 'keep', // 沿用（只读展示 + 字段预填）
  FRESH: 'fresh', // 另起（全新库，不碰旧数据）
  LATER: 'later' // 稍后决定（默认；不处理直接进新库）
} as const
export type OldDbDecision = (typeof OLDDB)[keyof typeof OLDDB]

/** 检测到的旧库信息（只读） */
export interface OldDbInfo {
  version: '1.0' | '2.0'
  dbPath: string
  /** 是否真的有可读数据文件 */
  present: boolean
}

/** 「沿用」时映射出的字段（只读；用于预填，其余仅展示） */
export interface OldDbMapping {
  callName?: string
  position?: string
  department?: string
  company?: string
  tone?: string
  /** 无法安全映射、仅作展示的原始条目计数（UI 提示「还有 N 项仅展示」） */
  displayOnlyCount: number
}

export interface WizardStatus {
  /** 是否已同意隐私告知 */
  consent: boolean
  /** 向导是否完成（false = 首启需走向导） */
  completed: boolean
  /** 检测到的旧库（无则 null） */
  oldDb: OldDbInfo | null
  /** 旧库三分支决定（未决定为 null；默认在交互时落 LATER） */
  oldDbDecision: OldDbDecision | null
}

/** 旧库定位器（由主进程注入：按版本隔离目录找 1.0/2.0 的库） */
export type OldDbLocator = () => OldDbInfo[]

/** 旧库只读读取器（注入：读旧库映射字段；绝不写） */
export type OldDbReader = (info: OldDbInfo) => Promise<OldDbMapping>

export interface WizardManagerOptions {
  database: DatabaseClient
  locateOldDbs?: OldDbLocator
  readOldDb?: OldDbReader
  logger?: (message: string) => void
}

export class WizardManager {
  private readonly database: DatabaseClient
  private readonly locateOldDbs: OldDbLocator
  private readonly readOldDb?: OldDbReader
  private readonly logger?: (message: string) => void

  constructor(options: WizardManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'WizardManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'WizardManager 缺少依赖: database')
    }
    this.database = options.database
    this.locateOldDbs = options.locateOldDbs ?? (() => [])
    this.readOldDb = options.readOldDb
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  /** 向导首屏状态（不阻塞；旧库检测失败也不抛——检测不到视为无旧库） */
  async status(): Promise<WizardStatus> {
    const consentRaw = await this.database.metaGet(META.CONSENT)
    const completedRaw = await this.database.metaGet(META.COMPLETED)
    const decisionRaw = (await this.database.metaGet(META.OLDDB_DECISION)) as OldDbDecision | null

    let oldDb: OldDbInfo | null = null
    try {
      const found = this.locateOldDbs().filter((x) => x?.present)
      // 取版本最高的可交互旧库（2.0 优先于 1.0）
      oldDb = found.sort((a, b) => (a.version < b.version ? 1 : -1))[0] ?? null
    } catch (e) {
      this.log(`[wizard] 旧库定位失败（按无旧库处理）: ${(e as Error)?.message}`)
    }

    return {
      consent: consentRaw === CONSENT_GRANTED,
      completed: completedRaw === '1',
      oldDb,
      oldDbDecision: isValidDecision(decisionRaw) ? decisionRaw : null
    }
  }

  /** 记录隐私告知同意（必过；只接受 granted） */
  async grantConsent(): Promise<{ consent: true }> {
    await this.database.metaSet(META.CONSENT, CONSENT_GRANTED)
    return { consent: true }
  }

  /**
   * 完成向导。前置：必须已同意隐私告知，否则 VALIDATION_ERROR（不能跳过必过页）。
   */
  async complete(): Promise<{ completed: true }> {
    const consentRaw = await this.database.metaGet(META.CONSENT)
    if (consentRaw !== CONSENT_GRANTED) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '必须先同意隐私告知才能完成向导', {
        reason: 'consent-required'
      })
    }
    await this.database.metaSet(META.COMPLETED, '1')
    return { completed: true }
  }

  /**
   * 旧库三分支决定（§八；用户主动选择）。
   *
   * - keep：需旧库在场；读映射字段返回（供预填）；**不写旧库**
   * - fresh：记录决定；不读不碰旧数据
   * - later：默认；不处理
   *
   * 非法决定 VALIDATION_ERROR。keep 但无旧库 → NOT_FOUND。
   */
  async decide(decision: OldDbDecision): Promise<{ decision: OldDbDecision; mapping?: OldDbMapping }> {
    if (!isValidDecision(decision)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法旧库决定: ${String(decision)}`, {
        field: 'decision'
      })
    }
    const status = await this.status()

    if (decision === OLDDB.KEEP) {
      if (!status.oldDb) {
        throw new AppError(ERROR_CODES.NOT_FOUND, '没有可沿用的旧库')
      }
      if (!this.readOldDb) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'WizardManager 缺少 readOldDb 依赖')
      }
      const mapping = await this.readOldDb(status.oldDb)
      await this.database.metaSet(META.OLDDB_DECISION, OLDDB.KEEP)
      await this.database.metaSet(META.OLDDB_VERSION, status.oldDb.version)
      this.log(`[wizard] 沿用旧库 ${status.oldDb.version}（只读映射，不写旧库）`)
      return { decision, mapping }
    }

    await this.database.metaSet(META.OLDDB_DECISION, decision)
    this.log(`[wizard] 旧库决定 → ${decision}`)
    return { decision }
  }

  /**
   * 「沿用」后读取映射字段（可单独调用：UI 在确认预填前再次获取）。只读。
   */
  async readMapping(): Promise<OldDbMapping> {
    const status = await this.status()
    if (!status.oldDb || !this.readOldDb) {
      throw new AppError(ERROR_CODES.NOT_FOUND, '无可读旧库映射')
    }
    return this.readOldDb(status.oldDb)
  }
}

function isValidDecision(v: unknown): v is OldDbDecision {
  return v === OLDDB.KEEP || v === OLDDB.FRESH || v === OLDDB.LATER
}

export function createWizardManager(options: WizardManagerOptions): WizardManager {
  return new WizardManager(options)
}
