// work/recordManager.ts —— 工作记录 + 候选管线（PLAN-3.0.md §2.2 / §2.2.1 / §4.1 / §14）
//
// 铁律：**来源 ≠ 事实**（硬规则 4）。AI 的推测/产出永远不自动成为工作事实，
// 只有用户动作（手动记、勾完成、点确认）才沉淀为正式记录。
//
// 契约：
//   - 状态机（§4.1）：candidate ──[✓记入]──→ confirmed；candidate ──[忽略]──→ ignored
//                     ignored ──[恢复]──→ candidate；confirmed 可编辑/可删除（物理删）
//   - 来源（§2.2）：manual（直接 confirmed）/ todo / routine / ai_output（→ candidate）
//   - **产出型 / 加工型分流**（§2.2）：只有产出型 AI 动作才产生候选；
//     加工型（润色/翻译片段）不产生 —— 见 OUTPUT_TYPE_CLASSIFICATION
//   - **候选去重**（§2.2）：同一会话 + 同一产出类型 + 30 分钟内 → 只保留一条候选，
//     后到覆盖更新；已 ignored 的事件不重新提议
//   - **候选质量门槛**（v0.5）：去重治「重复」，预过滤治「噪音」——
//     入队前先过确定性预过滤（空/过短、同批重复、与既有 confirmed 高相似）；
//     被挡的进「已过滤」**留痕（含原因），不静默丢**
//   - **双时间语义**（§2.2.1）：created_at（入库）/ occurred_date（必填，可≠入库日）/ occurred_time（可空）
//   - **删除即遗忘**（硬规则 21）：物理删除 + 不再进未来 Pack（Pack 侧由 Commit 04 贯彻）
//
// 设计约束：本模块**不 import electron**，依赖注入，可在纯 Node 下测试。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { dateOf, normalizeDate } from './todoManager'

/** 记录来源（§2.2 收敛枚举） */
export const RECORD_SOURCES = ['manual', 'todo', 'routine', 'ai_output'] as const
export type RecordSource = (typeof RECORD_SOURCES)[number]

/** 记录状态（§4.1 状态机） */
export const RECORD_STATUS_CANDIDATE = 'candidate'
export const RECORD_STATUS_CONFIRMED = 'confirmed'
export const RECORD_STATUS_IGNORED = 'ignored'
export const RECORD_STATUSES = [RECORD_STATUS_CANDIDATE, RECORD_STATUS_CONFIRMED, RECORD_STATUS_IGNORED] as const

/** 哪些来源「录入即事实」（直接 confirmed）；ai_output 例外（→ candidate） */
export const DIRECT_CONFIRM_SOURCES: Record<RecordSource, boolean> = {
  manual: true,
  todo: true,
  routine: true,
  ai_output: false
}

/**
 * 产出型 / 加工型分流（§2.2）。
 *
 * ⚠️ **基线存在措辞冲突，此处按 §2.2 的更具体表述实现**：
 *   - §2.2：「产出型 AI 动作（生成纪要/日报/邮件草稿等有交付物的）才产生候选；
 *     加工型（润色/翻译一个片段）不产生」
 *   - §十 P0 表却笼统把「邮件」列入「润色/翻译/摘要/邮件（加工型四件套）」
 *
 * 基线两处对「邮件」归类冲突，2026-09-23 按方案 1 解决：**邮件不再一刀切**——
 * 区分「邮件起草」（从无到有生成 → 产出型）与「邮件润色」（已有文本只变形 → 加工型）。
 * 判断依据是「这次动作有没有产生关于『干了什么活』的新事实」，与 §2.2 本意一致。
 */
export const OUTPUT_TYPE_CLASSIFICATION = {
  /** 产出型：有交付物，产生候选 */
  minutes: 'productive', // 会议纪要
  report: 'productive', // 日报 / 周报
  email_draft: 'productive', // 邮件起草（从无到有生成）
  /** 加工型：加工一个片段，不产生候选 */
  polish: 'processing', // 润色
  translate: 'processing', // 翻译
  summary: 'processing', // 摘要
  email_polish: 'processing' // 邮件润色（已有草稿只改语气）
} as const

export type OutputType = keyof typeof OUTPUT_TYPE_CLASSIFICATION

export function isProductiveOutputType(outputType: unknown): outputType is OutputType {
  return (
    typeof outputType === 'string' &&
    Object.prototype.hasOwnProperty.call(OUTPUT_TYPE_CLASSIFICATION, outputType) &&
    OUTPUT_TYPE_CLASSIFICATION[outputType as OutputType] === 'productive'
  )
}

/** 候选去重窗口（§2.2：同会话 + 同产出类型 + 30 分钟内） */
export const CANDIDATE_DEDUP_WINDOW_MS = 30 * 60 * 1000

/** 候选质量门槛：去空白后少于这个长度视为噪音（§2.2 规则①） */
export const CANDIDATE_MIN_CONTENT_LENGTH = 4

/** 被质量门槛挡下的原因（写进 `filtered_reason`，不静默丢） */
export const FILTER_REASONS = {
  /** 空内容 */
  EMPTY: 'empty',
  /** 过短（去空白后 < CANDIDATE_MIN_CONTENT_LENGTH） */
  TOO_SHORT: 'too-short',
  /** 与同批其他候选重复 */
  DUPLICATE_IN_BATCH: 'duplicate-in-batch',
  /** 与既有 confirmed 记录高度相似 */
  SIMILAR_TO_CONFIRMED: 'similar-to-confirmed'
} as const
export type FilterReason = (typeof FILTER_REASONS)[keyof typeof FILTER_REASONS]

/** activity_log 表一行（与 schema.ts DDL / db-worker 白名单一一对应） */
export interface RecordRow {
  id: string
  content: string
  occurred_date: string
  occurred_time: string | null
  source: string
  source_ref: string | null
  status: string
  matter_id: string | null
  confirmed_at: number | null
  filtered_reason: string | null
  created_at: number
  updated_at: number
}

/** 允许 update 的字段白名单（禁止改 id / source / status / created_at） */
export const RECORD_UPDATABLE_FIELDS = ['content', 'occurred_date', 'occurred_time', 'matter_id'] as const

export interface CreateRecordInput {
  content: string
  /** 不传默认今天（参数约定 5）；允许 ≠ 入库日（补记，§2.2.1） */
  occurredDate?: string | null
  /** 不传就是「时间未记」（§2.2.1） */
  occurredTime?: string | null
  matterId?: string | null
  /** 默认 manual（手动登记 → 录入即事实） */
  source?: RecordSource
  /** 来源细节（todo id / 对话 id 等） */
  sourceRef?: string | null
}

export interface UpdateRecordInput {
  content?: string
  occurredDate?: string
  occurredTime?: string | null
  matterId?: string | null
}

export interface ListRecordsParams {
  date?: string
  matterId?: string
  status?: string | 'all'
  /** 最简 LIKE 检索（§十 P0：记录侧检索框，让用户感知到工作记忆） */
  query?: string
  limit?: number
}

/** 提议候选的输入（产出型 AI 动作调用） */
export interface ProposeCandidateInput {
  /** 产出内容（将成为记录内容） */
  content: string
  /** 产出类型（决定是否产生候选 + 参与去重键） */
  outputType: OutputType | string
  /** 会话键（§6.4，参与去重键） */
  conversationKey: string
  /** 实际发生日（不传默认今天） */
  occurredDate?: string | null
  occurredTime?: string | null
  matterId?: string | null
  /** 来源细节（message id 等，写进 source_ref 便于溯源） */
  messageId?: string | null
}

export interface ProposeCandidateResult {
  /** 入队（或按去重规则覆盖更新）的候选；被质量门槛挡下时为 null */
  candidate: RecordRow | null
  /** 是否按去重规则覆盖了已有候选 */
  deduped: boolean
  /** 被挡原因（candidate 为 null 时有值） */
  filteredReason: FilterReason | null
  /** 被挡时落下的留痕行 id（「已过滤」可见） */
  filteredRecordId: string | null
}

export interface BatchResult {
  affected: string[]
  skipped: string[]
}

export interface RecordManagerOptions {
  database: DatabaseClient
  logger?: (message: string) => void
  newId?: () => string
  now?: () => number
}

export class RecordManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number

  constructor(options: RecordManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'RecordManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'RecordManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 读 ──────────────────────────────────────────────────────────────────────

  /**
   * 列表（参数约定 4：新→旧）。`status` 不传默认只看 confirmed（事实层）；
   * 要看候选/已忽略需显式传（UI 的「已忽略」筛选走 listFiltered）。
   */
  async list(params: ListRecordsParams = {}): Promise<RecordRow[]> {
    const where: Record<string, unknown> = {}
    if (params.status === 'all') {
      // 不过滤
    } else if (params.status !== undefined) {
      if (!RECORD_STATUSES.includes(params.status as never)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 status: ${params.status}`, { field: 'status' })
      }
      where.status = params.status
    } else {
      where.status = RECORD_STATUS_CONFIRMED
    }
    if (params.date !== undefined) where.occurred_date = normalizeDate(params.date)
    if (params.matterId !== undefined) where.matter_id = params.matterId
    const rows = await this.database.request<RecordRow[]>('activity_log.list', {
      where,
      // 参数约定 4：新→旧（occurred_date 主序，created_at 次序保证同日稳定）
      order: [
        { column: 'occurred_date', direction: 'desc' },
        { column: 'created_at', direction: 'desc' }
      ],
      limit: params.limit
    })
    if (params.query === undefined) return rows
    const q = String(params.query).trim()
    if (!q) return rows
    // 最简 LIKE 检索（一期口径：字面包含；语义检索归 P1）
    const needle = q.toLowerCase()
    return rows.filter(
      (r) => r.content.toLowerCase().includes(needle) || (r.matter_id ?? '').toLowerCase().includes(needle)
    )
  }

  /** 「已过滤」留痕（§2.2 质量门槛的可见面；不静默丢的落实） */
  async listFiltered(params: { date?: string; limit?: number } = {}): Promise<RecordRow[]> {
    const where: Record<string, unknown> = { status: RECORD_STATUS_IGNORED }
    if (params.date !== undefined) where.occurred_date = normalizeDate(params.date)
    const rows = await this.database.request<RecordRow[]>('activity_log.list', {
      where,
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: params.limit
    })
    return rows.filter((r) => r.filtered_reason !== null)
  }

  async get(id: string): Promise<RecordRow> {
    const row = await this.database.request<RecordRow | null>('activity_log.get', {
      keys: { id: requireId(id, 'get') }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `工作记录不存在: ${id}`)
    return row
  }

  // ── 写 ──────────────────────────────────────────────────────────────────────

  /**
   * 手动登记（§2.2：`[+ 记录一件事]` 结构化显式输入 → 直接 confirmed）。
   * `source` 只允许 manual / todo / routine（ai_output 走 proposeCandidate）。
   */
  async create(input: CreateRecordInput): Promise<RecordRow> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'create 需要一个入参对象')
    }
    const content = normalizeContent(input.content)
    const source = normalizeSource(input.source, 'manual')
    if (source === 'ai_output') {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'ai_output 必须走 proposeCandidate（AI 产出默认是候选，不能直接落事实层）',
        { field: 'source' }
      )
    }
    const ts = this.now()
    const id = this.newId()
    await this.database.request('activity_log.create', {
      data: {
        id,
        content,
        occurred_date: input.occurredDate === undefined || input.occurredDate === null
          ? dateOf(ts)
          : normalizeDate(input.occurredDate),
        occurred_time: normalizeTime(input.occurredTime),
        source,
        source_ref: normalizeOptionalString(input.sourceRef),
        status: RECORD_STATUS_CONFIRMED,
        matter_id: normalizeOptionalId(input.matterId, 'matterId'),
        confirmed_at: ts,
        created_at: ts,
        updated_at: ts
      }
    })
    this.log(`[record] 手动登记 ${id}（${source} → confirmed）`)
    return this.get(id)
  }

  /** 局部更新（confirmed 可编辑，§4.1 规则 3；覆盖更新 + updated_at） */
  async update(id: string, patch: UpdateRecordInput): Promise<RecordRow> {
    const recordId = requireId(id, 'update')
    if (!patch || typeof patch !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'update 需要一个 patch 对象')
    }
    const data: Record<string, unknown> = {}
    if (patch.content !== undefined) data.content = normalizeContent(patch.content)
    if (patch.occurredDate !== undefined) data.occurred_date = normalizeDate(patch.occurredDate)
    if (patch.occurredTime !== undefined) data.occurred_time = normalizeTime(patch.occurredTime)
    if (patch.matterId !== undefined) data.matter_id = normalizeOptionalId(patch.matterId, 'matterId')
    if (!Object.keys(data).length) {
      this.log(`[record] update(${recordId}) 空 patch，未改动`)
      return this.get(recordId)
    }
    await this.database.request('activity_log.update', { keys: { id: recordId }, data, required: true })
    return this.get(recordId)
  }

  /**
   * 删除（**物理删除**，硬规则 21 删除即遗忘；参数约定 3：幂等，不返回 NOT_FOUND）。
   * 历史报告不受影响（快照存副本）；但该记录不再进未来 Pack。
   */
  async delete(id: string): Promise<{ id: string; rowDeleted: boolean }> {
    const recordId = requireId(id, 'delete')
    const res = await this.database.request<{ changes: number }>('activity_log.delete', {
      keys: { id: recordId }
    })
    const rowDeleted = Number(res?.changes ?? 0) > 0
    if (!rowDeleted) this.log(`[record] delete(${recordId}) 不存在，幂等返回 false`)
    return { id: recordId, rowDeleted }
  }

  // ── 候选管线（§2.2 / §4.1） ─────────────────────────────────────────────────

  /**
   * 提议候选（**产出型 AI 动作的唯一入口**）。
   *
   * 流程：① 产出型分流（加工型直接返回 notApplicable）→ ② 质量门槛（留痕不静默丢）
   *      → ③ 去重（同会话+同类型+30min → 覆盖更新）
   */
  async proposeCandidate(input: ProposeCandidateInput): Promise<ProposeCandidateResult> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'proposeCandidate 需要一个入参对象')
    }
    // ① 产出型 / 加工型分流（§2.2）：加工型不产生候选
    if (!isProductiveOutputType(input.outputType)) {
      this.log(`[record] 加工型产出（${String(input.outputType)}）不产生候选`)
      return { candidate: null, deduped: false, filteredReason: null, filteredRecordId: null }
    }
    const outputType = input.outputType as OutputType
    const conversationKey = requireConversationKey(input.conversationKey)
    const ts = this.now()

    // ② 质量门槛（确定性预过滤）
    const raw = typeof input.content === 'string' ? input.content : ''
    const reason = await this.applyQualityGate(raw)
    if (reason) {
      // 被挡 → 落「已过滤」留痕（status=ignored + filtered_reason），**不静默丢**
      const id = this.newId()
      await this.database.request('activity_log.create', {
        data: {
          id,
          content: raw.trim() === '' ? '（空内容）' : raw.trim(),
          occurred_date: input.occurredDate === undefined || input.occurredDate === null
            ? dateOf(ts)
            : normalizeDate(input.occurredDate),
          occurred_time: normalizeTime(input.occurredTime),
          source: 'ai_output',
          source_ref: encodeSourceRef({ conversationKey, outputType, messageId: input.messageId ?? null }),
          status: RECORD_STATUS_IGNORED,
          matter_id: normalizeOptionalId(input.matterId, 'matterId'),
          filtered_reason: reason,
          created_at: ts,
          updated_at: ts
        }
      })
      this.log(`[record] 候选被质量门槛挡下（${reason}）→ 已过滤留痕 ${id}`)
      return { candidate: null, deduped: false, filteredReason: reason, filteredRecordId: id }
    }

    // ③ 去重：同会话 + 同产出类型 + 30 分钟内，且**未被处理**（仍是 candidate）
    const existing = await this.findDedupTarget(conversationKey, outputType, ts)
    const data = {
      content: normalizeContent(raw),
      occurred_date: input.occurredDate === undefined || input.occurredDate === null
        ? dateOf(ts)
        : normalizeDate(input.occurredDate),
      occurred_time: normalizeTime(input.occurredTime),
      source: 'ai_output',
      source_ref: encodeSourceRef({ conversationKey, outputType, messageId: input.messageId ?? null }),
      status: RECORD_STATUS_CANDIDATE,
      matter_id: normalizeOptionalId(input.matterId, 'matterId'),
      filtered_reason: null
    }
    if (existing) {
      // 后到覆盖更新（未处理的那条），不新增第二条
      await this.database.request('activity_log.update', {
        keys: { id: existing.id },
        data: { ...data, updated_at: ts },
        required: true
      })
      this.log(`[record] 候选去重：覆盖更新 ${existing.id}（同会话+同类型+30min 内）`)
      return { candidate: await this.get(existing.id), deduped: true, filteredReason: null, filteredRecordId: null }
    }
    const id = this.newId()
    await this.database.request('activity_log.create', {
      data: { id, ...data, created_at: ts, updated_at: ts }
    })
    this.log(`[record] 候选入队 ${id}（${outputType}）`)
    return { candidate: await this.get(id), deduped: false, filteredReason: null, filteredRecordId: null }
  }

  /**
   * candidate → confirmed（§4.1 规则 1：确认时可顺手改内容/时间/事项，`confirmed_at` 落库）。
   */
  async confirm(id: string, patch: UpdateRecordInput = {}): Promise<RecordRow> {
    const recordId = requireId(id, 'confirm')
    const row = await this.get(recordId)
    if (row.status === RECORD_STATUS_CONFIRMED) {
      this.log(`[record] confirm(${recordId}) 已是 confirmed，幂等返回`)
      return row
    }
    if (row.status !== RECORD_STATUS_CANDIDATE) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `只有 candidate 可以记入（当前 status=${row.status}；ignored 请先恢复）`,
        { field: 'status', current: row.status }
      )
    }
    const data: Record<string, unknown> = { status: RECORD_STATUS_CONFIRMED, confirmed_at: this.now() }
    if (patch.content !== undefined) data.content = normalizeContent(patch.content)
    if (patch.occurredDate !== undefined) data.occurred_date = normalizeDate(patch.occurredDate)
    if (patch.occurredTime !== undefined) data.occurred_time = normalizeTime(patch.occurredTime)
    if (patch.matterId !== undefined) data.matter_id = normalizeOptionalId(patch.matterId, 'matterId')
    await this.database.request('activity_log.update', { keys: { id: recordId }, data, required: true })
    this.log(`[record] 记入 ${recordId}`)
    return this.get(recordId)
  }

  /** candidate → ignored（§4.1 规则 2：忽略不是删除，留在库中；不重复提议由去重保证） */
  async ignore(id: string): Promise<RecordRow> {
    return this.transition(id, [RECORD_STATUS_CANDIDATE], RECORD_STATUS_IGNORED, 'ignore')
  }

  /** ignored → candidate（§4.1：可在「已忽略」筛选中找回） */
  async restore(id: string): Promise<RecordRow> {
    const recordId = requireId(id, 'restore')
    const row = await this.get(recordId)
    if (row.status === RECORD_STATUS_CANDIDATE) return row
    if (row.status !== RECORD_STATUS_IGNORED) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `只有 ignored 可以恢复为候选（当前 status=${row.status}）`,
        { field: 'status', current: row.status }
      )
    }
    await this.database.request('activity_log.update', {
      keys: { id: recordId },
      data: { status: RECORD_STATUS_CANDIDATE, filtered_reason: null },
      required: true
    })
    this.log(`[record] 恢复候选 ${recordId}`)
    return this.get(recordId)
  }

  /** 批量记入（§4.1 规则 4：静默徽标 + 批量「全部记入」；默认全选由 UI 层实现） */
  async confirmBatch(ids: string[]): Promise<BatchResult> {
    return this.batchTransition(ids, RECORD_STATUS_CONFIRMED)
  }

  /** 批量忽略 */
  async ignoreBatch(ids: string[]): Promise<BatchResult> {
    return this.batchTransition(ids, RECORD_STATUS_IGNORED)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 质量门槛：返回 null 表示通过；否则返回被挡原因 */
  private async applyQualityGate(raw: string): Promise<FilterReason | null> {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) return FILTER_REASONS.EMPTY
    if (text.length < CANDIDATE_MIN_CONTENT_LENGTH) return FILTER_REASONS.TOO_SHORT
    // 与既有 confirmed 高相似 → 视为重复产出，不污染事实层
    const confirmed = await this.database.request<Array<{ content: string }>>('activity_log.list', {
      where: { status: RECORD_STATUS_CONFIRMED },
      limit: 500
    })
    const norm = normalizeForCompare(text)
    for (const row of confirmed) {
      const other = normalizeForCompare(row.content)
      if (!other) continue
      if (norm === other || norm.includes(other) || other.includes(norm)) {
        return FILTER_REASONS.SIMILAR_TO_CONFIRMED
      }
    }
    return null
  }

  /** 去重目标：同会话 + 同产出类型 + 30 分钟内，且仍是 candidate（未处理） */
  private async findDedupTarget(
    conversationKey: string,
    outputType: OutputType,
    ts: number
  ): Promise<RecordRow | null> {
    const candidates = await this.database.request<RecordRow[]>('activity_log.list', {
      where: { status: RECORD_STATUS_CANDIDATE, source: 'ai_output' },
      limit: 500
    })
    for (const row of candidates) {
      const ref = decodeSourceRef(row.source_ref)
      if (!ref) continue
      if (ref.conversationKey !== conversationKey) continue
      if (ref.outputType !== outputType) continue
      if (ts - Number(row.created_at) > CANDIDATE_DEDUP_WINDOW_MS) continue
      return row
    }
    return null
  }

  private async transition(
    id: string,
    fromStatuses: string[],
    toStatus: string,
    opName: string
  ): Promise<RecordRow> {
    const recordId = requireId(id, opName)
    const row = await this.get(recordId)
    if (row.status === toStatus) {
      this.log(`[record] ${opName}(${recordId}) 已是 ${toStatus}，幂等返回`)
      return row
    }
    if (!fromStatuses.includes(row.status)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `${opName} 只允许 ${fromStatuses.join('/')} → ${toStatus}（当前 status=${row.status}）`,
        { field: 'status', current: row.status }
      )
    }
    await this.database.request('activity_log.update', {
      keys: { id: recordId },
      data: { status: toStatus },
      required: true
    })
    return this.get(recordId)
  }

  private async batchTransition(ids: string[], toStatus: string): Promise<BatchResult> {
    if (!Array.isArray(ids) || !ids.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '批量操作需要非空 ids 数组', { field: 'ids' })
    }
    const affected: string[] = []
    const skipped: string[] = []
    const ts = this.now()
    for (const raw of ids) {
      const recordId = typeof raw === 'string' ? raw.trim() : ''
      if (!recordId) {
        skipped.push(String(raw))
        continue
      }
      const row = await this.database.request<RecordRow | null>('activity_log.get', { keys: { id: recordId } })
      // 批量**不因单条失败而中断**：不存在/状态不符一律计入 skipped
      if (!row || row.status !== RECORD_STATUS_CANDIDATE) {
        skipped.push(recordId)
        continue
      }
      const data: Record<string, unknown> = { status: toStatus }
      if (toStatus === RECORD_STATUS_CONFIRMED) data.confirmed_at = ts
      await this.database.request('activity_log.update', { keys: { id: recordId }, data, required: true })
      affected.push(recordId)
    }
    this.log(`[record] 批量 → ${toStatus}：改动 ${affected.length}，跳过 ${skipped.length}`)
    return { affected, skipped }
  }
}

// ── source_ref 编解码（溯源 + 去重键） ────────────────────────────────────────
//
// `source_ref` 是 TEXT，承载两类值：
//   - todo / routine 来源：纯字符串（todo id），由 todoManager 写入
//   - ai_output 候选：JSON `{ conversationKey, outputType, messageId }`
//     —— 去重键（会话 + 产出类型）与溯源信息都在里面，无需新增列（硬规则 24）

export interface SourceRefAiOutput {
  conversationKey: string
  outputType: string
  messageId: string | null
}

export function encodeSourceRef(ref: SourceRefAiOutput): string {
  return JSON.stringify({ conversationKey: ref.conversationKey, outputType: ref.outputType, messageId: ref.messageId })
}

export function decodeSourceRef(raw: string | null): SourceRefAiOutput | null {
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SourceRefAiOutput>
    if (typeof parsed?.conversationKey !== 'string' || typeof parsed?.outputType !== 'string') return null
    return {
      conversationKey: parsed.conversationKey,
      outputType: parsed.outputType,
      messageId: typeof parsed.messageId === 'string' ? parsed.messageId : null
    }
  } catch {
    return null
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function requireId(id: unknown, op: string): string {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${op} 需要非空 id`, { field: 'id' })
  return value
}

function requireConversationKey(key: unknown): string {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'proposeCandidate 需要 conversationKey（去重键）', {
      field: 'conversationKey'
    })
  }
  return value
}

function normalizeContent(content: unknown): string {
  const value = typeof content === 'string' ? content.trim() : ''
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '记录内容不能为空', { field: 'content' })
  if (value.length > 2000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '记录内容不能超过 2000 字', { field: 'content' })
  }
  return value
}

function normalizeSource(source: unknown, fallback: RecordSource): RecordSource {
  if (source === undefined || source === null) return fallback
  if (!RECORD_SOURCES.includes(source as RecordSource)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 source: ${source}`, { field: 'source' })
  }
  return source as RecordSource
}

/** `HH:MM` 严格校验；空/undefined → null（时间未记） */
export function normalizeTime(time: unknown): string | null {
  if (time === undefined || time === null) return null
  if (typeof time !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'occurred_time 必须是字符串或 null', { field: 'occurredTime' })
  }
  const value = time.trim()
  if (!value) return null
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `时间必须是 HH:MM 形式: ${value}`, { field: 'occurredTime' })
  }
  const [h, m] = value.split(':').map(Number)
  if (h > 23 || m > 59) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `时间不存在: ${value}`, { field: 'occurredTime' })
  }
  return value
}

function normalizeOptionalId(id: unknown, field: string): string | null {
  if (id === undefined || id === null) return null
  if (typeof id !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 必须是字符串或 null`, { field })
  }
  const value = id.trim()
  return value === '' ? null : value
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'source_ref 必须是字符串或 null', { field: 'sourceRef' })
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 归一化用于相似度比较：去空白/标点，转小写 */
export function normalizeForCompare(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'`（）()\[\]【】<>《》\-—_~·]/g, '')
}

export function createRecordManager(options: RecordManagerOptions): RecordManager {
  return new RecordManager(options)
}
