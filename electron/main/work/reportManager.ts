// work/reportManager.ts —— 报告流（PLAN-3.0.md §2.4 / §2.5 / §七 / §14 reports）
//
// 管线：confirmed 记录 → 事实聚合(确定性) → Context Pack → AI 表达(SSE) → 草稿 → 人工确认
//
// 快照（§七）：
//   - 每次生成 = 追加一个 immutable generation（inputs 冗余副本 + memory_snapshot + prompt + 产出）
//   - 已存在 generation 永不修改；唯一可变是 `current` 指针
//   - reports.content 是可编辑工作副本，与 generation 快照分开
//
// 本模块不 import electron；DB / ContextEngine / GatewayClient 全注入，纯 Node 可测。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import {
  type ContextEngine,
  type ContextPack,
  type SnapshotScope
} from './contextEngine'
import { toView, type ContextSnapshotView } from './contextManager'
import {
  aggregateFacts,
  renderFactSheet,
  type FactAggregation,
  type FactMatterInfo,
  type FactRecord
} from './factAggregator'
import type { GatewayClient, GatewayStreamHandle } from '../gatewayClient'
import { dateOf, normalizeDate } from './todoManager'
import { addDays } from './contextEngine'

export const REPORT_TYPES = ['daily', 'weekly'] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export const REPORT_STATUSES = ['draft', 'confirmed'] as const

/** 报告列表行 */
export interface ReportSummary {
  id: string
  type: string
  period: string
  status: string
  created_at: number
  updated_at: number
}

export interface ReportDetail extends ReportSummary {
  content: string | null
  generation_context: string | null
  versions: VersionMeta[]
}

export interface VersionMeta {
  version: number
  created_at: string
  model: string | null
  content: string
}

export interface ListReportsParams {
  type?: ReportType
  period?: string
  limit?: number
}

/** 一次生成的句柄（runId 即流 ID） */
export interface ReportRunHandle {
  runId: string
  reportId: string
  version: number
  stream: GatewayStreamHandle
}

export interface GenerateParams {
  type: ReportType
  /** daily=YYYY-MM-DD；weekly=YYYY-Www；不传 daily=今天 */
  period?: string
}

export interface ReportManagerOptions {
  database: DatabaseClient
  contextEngine: ContextEngine
  gateway: GatewayClient
  newId?: () => string
  now?: () => number
  logger?: (message: string) => void
}

export class ReportManager {
  private readonly database: DatabaseClient
  private readonly contextEngine: ContextEngine
  private readonly gateway: GatewayClient
  private readonly newId: () => string
  private readonly now: () => number
  private readonly logger?: (message: string) => void

  /** 在途生成（runId/reportId/version/stream），供 abort 与落库 */
  private readonly runs = new Map<string, ReportRunHandle>()

  constructor(options: ReportManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ReportManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['database', options.database, 'request'],
      ['contextEngine', options.contextEngine, 'buildPack'],
      ['gateway', options.gateway, 'createChatStream']
    ] as const) {
      if (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `ReportManager 缺少依赖: ${name}`)
      }
    }
    this.database = options.database
    this.contextEngine = options.contextEngine
    this.gateway = options.gateway
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  // ── 读 ─────────────────────────────────────────────────────────────────────

  async list(params: ListReportsParams = {}): Promise<ReportSummary[]> {
    const where: Record<string, unknown> = {}
    if (params.type) where.type = params.type
    if (params.period) where.period = params.period
    return this.database.request<ReportSummary[]>('reports.list', {
      where,
      order: [{ column: 'period', direction: 'desc' }],
      limit: params.limit
    })
  }

  async get(id: string): Promise<ReportDetail> {
    const row = await this.database.request<Record<string, unknown> | null>('reports.get', {
      keys: { id: requireId(id, 'get') }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `报告不存在: ${id}`)
    return {
      id: String(row.id),
      type: String(row.type),
      period: String(row.period),
      status: String(row.status),
      content: row.content === null || row.content === undefined ? null : String(row.content),
      generation_context: row.generation_context === null ? null : String(row.generation_context),
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0),
      versions: readVersions(row.generation_context)
    }
  }

  /**
   * 确定性事实聚合（§14 aggregate）：**不调模型**，可单独验收。
   * 返回周期内 confirmed 记录的结构化聚合 + 事实清单文本。
   */
  async aggregate(type: ReportType, period?: string): Promise<{ aggregation: FactAggregation; factSheet: string }> {
    const p = this.resolvePeriod(type, period)
    const { start, end } = periodWindow(type, p)
    const records = await this.loadConfirmedRecords(start, end)
    const matters = await this.loadMatters(records)
    const aggregation = aggregateFacts(type, records, matters)
    return { aggregation, factSheet: renderFactSheet(aggregation) }
  }

  // ── 生成 ───────────────────────────────────────────────────────────────────

  /**
   * 生成（SSE 流式）：
   *   ① 解析周期 + 聚合事实（A4：0 条不调模型，返回结构化提示）
   *   ② 组 report Context Pack
   *   ③ 创建流（runId 唯一）
   *   ④ 立即返回 handle（渲染端消费 iterator）；流结束后由 finishRun 落 immutable generation
   */
  async generate(params: GenerateParams): Promise<ReportRunHandle> {
    const type = REPORT_TYPES.includes(params?.type as ReportType)
      ? (params.type as ReportType)
      : 'daily'
    const period = this.resolvePeriod(type, params?.period)
    const { start, end } = periodWindow(type, period)
    const records = await this.loadConfirmedRecords(start, end)
    const matters = await this.loadMatters(records)
    const aggregation = aggregateFacts(type, records, matters)

    // A4：0 条不调模型
    if (aggregation.empty) {
      const reportId = await this.ensureReportRow(type, period)
      const empty = '今天还没有记录，先记一件事后再生成日报。'
      await this.database.request('reports.update', {
        keys: { id: reportId },
        data: { content: '' },
        required: true
      })
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, empty, { reason: 'no-records' })
    }

    const reportId = await this.ensureReportRow(type, period)
    const ctx = await this.readGenContext(reportId)
    const version = (ctx.current ?? 0) + 1

    // Context Pack（report scope，anchor=周期末日）
    const pack: ContextPack = await this.contextEngine.buildPack('report' as SnapshotScope, {
      anchorDate: end
    })
    const factSheet = renderFactSheet(aggregation)
    const thinNotice = aggregation.thin ? '（记录较少，日报可能偏薄）' : ''
    const prompt = buildReportPrompt(type, factSheet, thinNotice, pack)

    const runId = this.newId()
    const conversationKey = `conv:work:report:${type}:${period}:${runId}`
    const stream = this.gateway.createChatStream({
      conversationKey,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `请基于上述事实生成${type === 'weekly' ? '周报' : '日报'}。` }
      ],
      stream: true
    })

    const handle: ReportRunHandle = { runId, reportId, version, stream }
    this.runs.set(runId, handle)
    // 异步收尾：流结束落 generation；不阻塞返回
    void this.finishRun(handle, { prompt, pack, aggregation, period })
    this.log(`[report] generate run=${runId} report=${reportId} v=${version}`)
    return handle
  }

  /** 中止生成（runId；真断上游） */
  async abortGenerate(runId: string): Promise<{ aborted: boolean }> {
    const handle = this.runs.get(runId)
    if (!handle) return { aborted: false }
    handle.stream.cancel()
    return { aborted: true }
  }

  /** 流结束：落 immutable generation（成功才落；中止/失败不落半成品） */
  private async finishRun(
    handle: ReportRunHandle,
    meta: { prompt: string; pack: ContextPack; aggregation: FactAggregation; period: string }
  ): Promise<void> {
    try {
      const result = await handle.stream.result
      if (result.aborted) {
        this.log(`[report] run=${handle.runId} 中止，不落 generation`)
        return
      }
      const snapshot: ContextSnapshotView = toView(meta.pack, 'report')
      const generation = {
        version: handle.version,
        created_at: new Date(this.now()).toISOString(),
        period: { type: meta.aggregation.type, period: meta.period },
        inputs: snapshot.memory_snapshot.records, // 冗余副本
        memory_snapshot: snapshot.memory_snapshot,
        prompt: meta.prompt,
        model: result.model,
        content: result.text,
        contextSnapshot: snapshot
      }
      await this.appendGeneration(handle.reportId, generation, result.text)
      this.log(`[report] run=${handle.runId} 完成 → v${handle.version}`)
    } catch (e) {
      this.log(`[report] run=${handle.runId} 失败: ${(e as Error)?.message}`)
    } finally {
      this.runs.delete(handle.runId)
    }
  }

  // ── 草稿 / 确认 / 版本 ─────────────────────────────────────────────────────

  /** 保存草稿（改 reports.content 工作副本；不动 generation） */
  async saveDraft(id: string, content: string): Promise<ReportDetail> {
    const reportId = requireId(id, 'saveDraft')
    const text = typeof content === 'string' ? content : ''
    await this.database.request('reports.update', {
      keys: { id: reportId },
      data: { content: text },
      required: true
    })
    return this.get(reportId)
  }

  /** 确认报告（status=confirmed；仍可编辑，但不改 generation） */
  async confirm(id: string): Promise<ReportDetail> {
    const reportId = requireId(id, 'confirm')
    await this.database.request('reports.update', {
      keys: { id: reportId },
      data: { status: 'confirmed' },
      required: true
    })
    return this.get(reportId)
  }

  /** 重生成 = 追加新 generation（硬规则 19：不覆盖旧版本） */
  async regenerate(id: string): Promise<ReportRunHandle> {
    const detail = await this.get(id)
    return this.generate({ type: detail.type as ReportType, period: detail.period })
  }

  async versions(id: string): Promise<VersionMeta[]> {
    return (await this.get(id)).versions
  }

  // ── 内部：DB 读写 ─────────────────────────────────────────────────────────

  /** 确保报告行存在（同 type+period 唯一；不存在插 draft） */
  private async ensureReportRow(type: ReportType, period: string): Promise<string> {
    const existing = await this.database.request<ReportSummary[]>('reports.list', {
      where: { type, period },
      limit: 1
    })
    if (existing[0]) return existing[0].id
    const id = this.newId()
    const ts = this.now()
    await this.database.request('reports.create', {
      data: {
        id,
        type,
        period,
        status: 'draft',
        content: '',
        created_at: ts,
        updated_at: ts
      }
    })
    return id
  }

  private async readGenContext(reportId: string): Promise<{ current: number; generations: unknown[] }> {
    const row = await this.database.request<Record<string, unknown> | null>('reports.get', {
      keys: { id: reportId }
    })
    if (!row?.generation_context) return { current: 0, generations: [] }
    try {
      const parsed = JSON.parse(String(row.generation_context)) as { current?: number; generations?: unknown[] }
      return { current: Number(parsed.current ?? 0), generations: Array.isArray(parsed.generations) ? parsed.generations : [] }
    } catch {
      return { current: 0, generations: [] }
    }
  }

  /** append-only 追加 generation + 更新 current 指针（唯一可变字段） */
  private async appendGeneration(reportId: string, generation: unknown, content: string): Promise<void> {
    const ctx = await this.readGenContext(reportId)
    const generations = [...ctx.generations, generation]
    const next = { current: (generation as { version: number }).version, generations }
    await this.database.request('reports.update', {
      keys: { id: reportId },
      data: { generation_context: JSON.stringify(next), content },
      required: true
    })
  }

  private async loadConfirmedRecords(start: string, end: string): Promise<FactRecord[]> {
    const rows = await this.database.request<Array<Record<string, unknown>>>('activity_log.list', {
      where: { status: 'confirmed' },
      order: [{ column: 'occurred_date', direction: 'asc' }],
      limit: 5000
    })
    return rows
      .map((r) => ({
        id: String(r.id),
        content: String(r.content ?? ''),
        occurred_date: String(r.occurred_date),
        occurred_time: r.occurred_time === null || r.occurred_time === undefined ? null : String(r.occurred_time),
        matter_id: r.matter_id === null || r.matter_id === undefined ? null : String(r.matter_id)
      }))
      .filter((r) => r.occurred_date >= start && r.occurred_date <= end)
  }

  private async loadMatters(records: FactRecord[]): Promise<FactMatterInfo[]> {
    const ids = Array.from(new Set(records.map((r) => r.matter_id).filter((x): x is string => x !== null)))
    if (!ids.length) return []
    const rows = await this.database.request<Array<Record<string, unknown>>>('matters.list', {
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: 5000
    })
    return rows
      .filter((m) => ids.includes(String(m.id)))
      .map((m) => ({
        id: String(m.id),
        name: String(m.name),
        color: m.color === null || m.color === undefined ? null : String(m.color)
      }))
  }

  private resolvePeriod(type: ReportType, period?: string): string {
    const ts = this.now()
    if (type === 'daily') {
      return period ? normalizeDate(period) : dateOf(ts)
    }
    if (period) return normalizeWeek(period)
    return isoWeek(dateOf(ts))
  }
}

// ── 周期窗口 ─────────────────────────────────────────────────────────────────

/** daily=当天；weekly=周一到周日 */
export function periodWindow(type: ReportType, period: string): { start: string; end: string } {
  if (type === 'daily') {
    const d = normalizeDate(period)
    return { start: d, end: d }
  }
  const { year, week } = parseWeek(period)
  // ISO 周年的周一
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = jan4.getUTCDay() || 7
  const isoMonday = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000)
  const monday = new Date(isoMonday.getTime() + (week - 1) * 7 * 86400000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fmt = (dt: Date): string =>
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  const start = fmt(monday)
  const end = addDays(start, 6)
  return { start, end }
}

function normalizeWeek(period: unknown): string {
  const value = String(period ?? '').trim()
  if (!/^\d{4}-W\d{2}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `周报周期必须是 YYYY-Www: ${value}`)
  }
  return value
}

function parseWeek(period: string): { year: number; week: number } {
  const [y, w] = period.split('-W')
  return { year: Number(y), week: Number(w) }
}

/** 日期 → ISO 周标记 YYYY-Www */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const dayNum = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-W${pad(week)}`
}

// ── prompt 组装 ─────────────────────────────────────────────────────────────

function buildReportPrompt(type: ReportType, factSheet: string, thinNotice: string, pack: ContextPack): string {
  const kind = type === 'weekly' ? '周报' : '日报'
  return [
    `你是工作助手，正在帮用户写${kind}。`,
    `严格只依据下面「事实清单」中已确认的记录组织内容，**不得编造未发生的事**。`,
    thinNotice,
    `要求：按事项组织，简洁、可直接复制；突出重点事项；不确定的不要写。`,
    '',
    '【事实清单】',
    factSheet,
    '',
    '【工作画像（语气参考）】',
    pack.profileSummary?.text ?? '（未填写）'
  ]
    .filter((l) => l !== null)
    .join('\n')
}

// ── 版本读取 ─────────────────────────────────────────────────────────────────

function readVersions(generationContext: unknown): VersionMeta[] {
  if (!generationContext) return []
  try {
    const parsed = JSON.parse(String(generationContext)) as {
      generations?: Array<{ version?: number; created_at?: string; model?: string | null; content?: string }>
    }
    return (parsed.generations ?? []).map((g) => ({
      version: Number(g.version ?? 0),
      created_at: String(g.created_at ?? ''),
      model: g.model ?? null,
      content: String(g.content ?? '')
    }))
  } catch {
    return []
  }
}

function requireId(id: unknown, op: string): string {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${op} 需要非空 id`, { field: 'id' })
  return value
}

export function createReportManager(options: ReportManagerOptions): ReportManager {
  return new ReportManager(options)
}
