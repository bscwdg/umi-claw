// work/contextEngine.ts —— Context Engine v3（PLAN-3.0.md §六 / §14 context / 硬规则 12）
//
// 把工作域的七段素材组装成 **Context Pack**，产出两样东西：
//   (a) `renderContextPackText(pack)` —— 注入 prompt 的最终文本
//   (b) Pack 结构化 JSON —— 供报告快照（§七）与 context.snapshot 只读面（§14 B1）
//
// 七段（§6.1，顺序即渲染顺序）：
//   1 任务指令段（永不裁）  2 工作画像摘要（≤200字）  3 在跟事项（≤20）
//   4 待办（今日优先，其次7天）  5 近期 confirmed 工作记录（滚动窗口）
//   6 知识检索片段（预算内全量，超预算 LIKE topK）  7 对话历史（独立预算）
//
// 裁剪（§6.2，超预算从后往前）：6 → 5 → 4 → 3 → 2；1 永不裁。
//
// 关键事实（沿用 2.0 已验证结论）：
//   - **预算内全量优先（§6.3）**：「客户嫌贵怎么回」与文档标题「价目表」无字面重合，
//     LIKE 会漏；工作知识库比商家资料库更小，全量更划算。超预算才退化 LIKE 裁剪并标注。
//   - **token 一律本地估算**（Gateway usage 实测恒 0）；估算器偏保守（宁可少塞）。
//   - **不静默丢**：未进包条目在 `dropped[]` 留痕（含原因），被截条目标 `truncated:true`。
//   - **记录进 Pack 永远是 confirmed（§6.2）**：candidate 不进第 5 段事实段；
//     当前会话产出的 candidate 只可进第 7 段对话历史并带「未确认」标记。
//   - **不裁画像**：画像是「AI 认识你」的核心，超预算让知识段让位，不把画像砍一半。
//
// 本模块**不 import electron、不做 HTTP、不碰 GATEWAY_TOKEN**；只通过注入的 DatabaseClient 读库，
// 因此纯 Node 可 bundle 测试。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { dateOf, normalizeDate } from './todoManager'

// ── 常量（§六） ───────────────────────────────────────────────────────────────

/** context.snapshot 的 scope（v0.7 枚举；§14.1 B1） */
export const SNAPSHOT_SCOPES = ['qa', 'report', 'latest'] as const
export type SnapshotScope = (typeof SNAPSHOT_SCOPES)[number]

/**
 * 预算比例：第 2-6 段合计最多占上下文窗口的 70%（其余留给生成 + 第 7 段对话历史）。
 * 2.0 用 60%（还含独立平台规则段）；3.0 无平台段、七段里 7 独立，故取 70%。
 */
export const CONTEXT_BUDGET_RATIO = 0.7

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const MIN_CONTEXT_WINDOW_TOKENS = 2_000
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000

/** 画像摘要上限（§6.1：≤200 字） */
export const PROFILE_SUMMARY_MAX_CHARS = 200
/** 在跟事项上限（§6.1：≤20 条） */
export const ACTIVE_MATTERS_MAX = 20
/** 待办窗口：今日 + N 天内到期 */
export const TODO_LOOKAHEAD_DAYS = 7
/** 单次读库上限（worker opList 硬顶 5000） */
export const READ_MAX_ITEMS = 5_000

/** 区块固定开销（标题/分隔/字段名），估算先扣，避免「账面刚好、渲染超了」 */
export const PACK_OVERHEAD_TOKENS = 48
/** 裁剪模式下单条知识至少值得占用的 token（塞半句不如显式说「还有更多」） */
export const KNOWLEDGE_ITEM_MIN_TOKENS = 120
export const ITEM_TRUNCATE_MARKER = '\n……（本条资料已按上下文预算截断，完整内容见知识库原文）'
/** 「未注入资料」最多展示的标题数（这串文字本身也占预算，必须有界） */
export const DROPPED_TITLES_SHOWN = 3
export const DROPPED_TITLE_MAX_CHARS = 20

/** 第 5 段记录滚动窗口（天）：qa=近 3 天；latest=当天 */
export const RECORD_WINDOW_DAYS_BY_SCOPE: Record<SnapshotScope, number> = {
  qa: 3,
  report: 7,
  latest: 1
}

// ── 本地 token 估算（§6.3：不依赖 Gateway usage，偏保守）──────────────────────

function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  )
}

/**
 * 本地 token 估算（确定性、零依赖、偏保守）：
 * 宽字符 1 token/字；ASCII 1/4；换行 1；其余 1.5；向上取整。
 * 低估会真的超窗（被截断/报错），高估只少塞资料，而裁剪路径本就为超预算准备，故宁可少塞。
 */
export function estimateTokens(text: unknown): number {
  if (text === null || text === undefined) return 0
  const s = typeof text === 'string' ? text : String(text)
  if (!s) return 0
  let weight = 0
  for (const ch of s) {
    if (ch === '\n' || ch === '\r') {
      weight += 1
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (isWideChar(cp)) weight += 1
    else if (cp < 0x80) weight += 0.25
    else weight += 1.5
  }
  return Math.ceil(weight)
}

/** 在 token 预算内取最长前缀（裁剪单条资料用）；不劈开代理对 */
export function sliceToTokenBudget(text: string, maxTokens: number): string {
  const s = String(text ?? '')
  if (maxTokens <= 0 || !s) return ''
  if (estimateTokens(s) <= maxTokens) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  if (lo > 0 && lo < s.length) {
    const code = s.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1
  }
  return s.slice(0, lo)
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type PackMode = 'full' | 'truncated'
export type RetrievalMode = 'full' | 'like' | 'recency'
export type DroppedReason = 'budget' | 'empty-content' | 'cut-order'

export interface ProfileSummary {
  text: string
  chars: number
}

export interface PackedMatter {
  id: string
  name: string
  color: string | null
}

export interface PackedTodo {
  id: string
  title: string
  dueDate: string | null
  matterId: string | null
  source: string
  /** 是否今日到期（第 4 段内排序用） */
  today: boolean
}

export interface PackedRecord {
  id: string
  content: string
  occurredDate: string
  occurredTime: string | null
  matterId: string | null
}

export interface PackedKnowledge {
  id: string
  title: string
  type: string
  content: string
  estimatedTokens: number
  truncated: boolean
  matchedQuery: boolean
}

export interface DroppedItem {
  id: string
  title: string
  section: number
  reason: DroppedReason
}

export interface ContextBudget {
  contextWindowTokens: number
  ratio: number
  budgetTokens: number
  usedTokens: number
  remainingTokens: number
  reservedTokens: number
  mode: PackMode
  recordTotal: number
  knowledgeTotal: number
  knowledgeIncluded: number
  truncatedItems: number
}

export interface ContextPack {
  scope: SnapshotScope
  conversationKey: string | null
  task: string
  profileSummary: ProfileSummary | null
  matters: PackedMatter[]
  todos: PackedTodo[]
  records: PackedRecord[]
  knowledge: PackedKnowledge[]
  /** 第 7 段对话历史（独立预算；条目带角色，candidate 内容带「未确认」标记） */
  history: Array<{ role: string; content: string; unconfirmed: boolean }>
  budget: ContextBudget
  dropped: DroppedItem[]
  retrieval: { mode: RetrievalMode; query: string | null; hits: number }
  builtAt: number
}

export interface BuildPackOptions {
  /** 任务指令（第 1 段，永不裁） */
  task?: string
  /** 超预算裁剪知识段的 LIKE 关键词；不传按时间裁剪 */
  query?: string | null
  /** 第 7 段对话历史的会话键；不传不装对话历史 */
  conversationKey?: string | null
  /** 上下文窗口 token 覆盖 */
  contextWindowTokens?: number | null
  /** report 场景下的目标日（第 5 段以该日为锚）；默认今天 */
  anchorDate?: string | null
}

export interface ContextEngineOptions {
  database: DatabaseClient
  logger?: (message: string) => void
  defaultContextWindowTokens?: number
  /** 当前时间（毫秒）；不传用 Date.now()。与其它 Manager 同一注入约定，便于确定性验收 */
  now?: () => number
}

// ── 画像摘要 ──────────────────────────────────────────────────────────────────

/** profile 行 → ≤200 字一行摘要；全空 → null */
export function summarizeProfile(row: Record<string, unknown> | null): ProfileSummary | null {
  if (!row) return null
  const segs: string[] = []
  const push = (label: string, value: unknown): void => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) segs.push(`${label}${text}`)
  }
  push('', row.call_name)
  push('，', row.position)
  push('，', row.department)
  push('，', row.company)
  push('，汇报给', row.report_to)
  push('，语气', row.tone)
  push('，行业', row.industry)
  let text = segs.join('')
  if (!text) return null
  if (text.length > PROFILE_SUMMARY_MAX_CHARS) text = text.slice(0, PROFILE_SUMMARY_MAX_CHARS) + '…'
  return { text, chars: text.length }
}

// ── 引擎 ──────────────────────────────────────────────────────────────────────

export class ContextEngine {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void
  private readonly defaultContextWindowTokens: number
  private readonly now: () => number

  constructor(options: ContextEngineOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextEngine 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextEngine 缺少依赖: database')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextEngine 的 now 必须是函数')
    }
    this.database = options.database
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.defaultContextWindowTokens =
      options.defaultContextWindowTokens === undefined || options.defaultContextWindowTokens === null
        ? DEFAULT_CONTEXT_WINDOW_TOKENS
        : requireWindow(options.defaultContextWindowTokens)
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /**
   * 组装 Context Pack。
   *
   * 顺序：画像 → 事项 → 待办 → 记录（confirmed）→ 知识（ready）→ 预算判定 →
   * 全量 or 裁剪（§6.2）→ 对话历史（独立预算）→ 账本。
   * 依赖层错误（SETUP_REQUIRED/DB_ERROR …）原样透传，渲染端按 code 分支。
   */
  async buildPack(scope: SnapshotScope, options: BuildPackOptions = {}): Promise<ContextPack> {
    if (!SNAPSHOT_SCOPES.includes(scope)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 scope: ${scope}`, { field: 'scope' })
    }
    const task = normalizeTask(options.task)
    const query = normalizeQuery(options.query)
    const window = this.resolveWindow(options.contextWindowTokens)
    const now = this.now()
    const anchorDate = options.anchorDate ? normalizeDate(options.anchorDate) : dateOf(now)

    // ── 2 画像（惰性建行后读；§八 装完即用）──
    await this.database.request('profile.upsert', { data: { id: 'default' } })
    const profileRow = await this.database.request<Record<string, unknown> | null>('profile.get', {
      keys: { id: 'default' }
    })
    const profileSummary = summarizeProfile(profileRow)

    // ── 3 在跟事项 ──
    const matterRows = await this.database.request<Array<Record<string, unknown>>>('matters.list', {
      where: { status: 'active' },
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: ACTIVE_MATTERS_MAX
    })
    const matters: PackedMatter[] = matterRows.map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ''),
      color: m.color === null || m.color === undefined ? null : String(m.color)
    }))

    // ── 4 待办（confirmed：今日 + 7 天内；今日优先）──
    const todoRows = await this.database.request<Array<Record<string, unknown>>>('todos.list', {
      where: { state: 'confirmed' },
      order: [
        { column: 'due_date', direction: 'asc' },
        { column: 'created_at', direction: 'desc' }
      ],
      limit: READ_MAX_ITEMS
    })
    const horizon = addDays(anchorDate, TODO_LOOKAHEAD_DAYS)
    const todos: PackedTodo[] = todoRows
      .map((t) => {
        const due = t.due_date === null || t.due_date === undefined ? null : String(t.due_date)
        return {
          id: String(t.id),
          title: String(t.title ?? ''),
          dueDate: due,
          matterId: t.matter_id === null || t.matter_id === undefined ? null : String(t.matter_id),
          source: String(t.source ?? 'manual'),
          today: due === anchorDate
        }
      })
      // 无到期日的也保留（open-ended）；有日期的只收今日起 7 天内
      .filter((t) => t.dueDate === null || (t.dueDate >= anchorDate && t.dueDate <= horizon))
      .sort((a, b) => {
        if (a.today !== b.today) return a.today ? -1 : 1
        if (a.dueDate === null) return 1
        if (b.dueDate === null) return -1
        return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0
      })

    // ── 5 近期 confirmed 记录（滚动窗口）──
    const windowDays = RECORD_WINDOW_DAYS_BY_SCOPE[scope]
    const startDate = addDays(anchorDate, -(windowDays - 1))
    const recordRows = await this.database.request<Array<Record<string, unknown>>>('activity_log.list', {
      where: { status: 'confirmed' },
      order: [
        { column: 'occurred_date', direction: 'desc' },
        { column: 'created_at', direction: 'desc' }
      ],
      limit: READ_MAX_ITEMS
    })
    const records: PackedRecord[] = recordRows
      .map((r) => ({
        id: String(r.id),
        content: String(r.content ?? ''),
        occurredDate: String(r.occurred_date ?? anchorDate),
        occurredTime: r.occurred_time === null || r.occurred_time === undefined ? null : String(r.occurred_time),
        matterId: r.matter_id === null || r.matter_id === undefined ? null : String(r.matter_id)
      }))
      .filter((r) => r.occurredDate >= startDate && r.occurredDate <= anchorDate)

    // ── 6 知识（ready）──
    const knowledgeRows = await this.database.request<Array<Record<string, unknown>>>('knowledge.list', {
      where: { status: 'ready' },
      order: [{ column: 'updated_at', direction: 'desc' }],
      limit: READ_MAX_ITEMS
    })
    const knowledgeCandidates: Array<Record<string, unknown>> = []
    const dropped: DroppedItem[] = []
    for (const row of knowledgeRows) {
      const content = typeof row.content === 'string' ? row.content : ''
      if (!content.trim()) {
        dropped.push({ id: String(row.id), title: String(row.title ?? ''), section: 6, reason: 'empty-content' })
        continue
      }
      knowledgeCandidates.push(row)
    }

    // ── 预算（账本 = 实际渲染文本，沿用 2.0 探针法）──
    const budgetTokens = Math.floor(window * CONTEXT_BUDGET_RATIO)

    const skeleton = (
      knowledge: PackedKnowledge[],
      mode: PackMode,
      recordTotal: number
    ): ContextPack => ({
      scope,
      conversationKey: options.conversationKey ?? null,
      task,
      profileSummary,
      matters,
      todos,
      records,
      knowledge,
      history: [],
      budget: {
        contextWindowTokens: window,
        ratio: CONTEXT_BUDGET_RATIO,
        budgetTokens,
        usedTokens: 0,
        remainingTokens: 0,
        reservedTokens: window - budgetTokens,
        mode,
        recordTotal,
        knowledgeTotal: knowledgeCandidates.length,
        knowledgeIncluded: knowledge.length,
        truncatedItems: knowledge.filter((k) => k.truncated).length
      },
      dropped: [...dropped],
      retrieval: { mode: 'full', query: null, hits: 0 },
      builtAt: 0
    })
    const measure = (knowledge: PackedKnowledge[], mode: PackMode): number =>
      estimateTokens(renderContextPackText(skeleton(knowledge, mode, records.length)))

    const asDropped = (row: Record<string, unknown>): DroppedItem => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      section: 6,
      reason: 'budget'
    })
    const packKnowledge = (row: Record<string, unknown>, truncated: boolean, matched: boolean, slice?: number): PackedKnowledge => {
      const full = String(row.content ?? '')
      const content = truncated && slice !== undefined ? sliceToTokenBudget(full, slice) : full
      return {
        id: String(row.id),
        title: String(row.title ?? ''),
        type: String(row.type ?? 'text'),
        content,
        estimatedTokens: estimateTokens(content) + (truncated ? estimateTokens(ITEM_TRUNCATE_MARKER) : 0),
        truncated,
        matchedQuery: matched
      }
    }

    const allPacked = knowledgeCandidates.map((row) => packKnowledge(row, false, false))
    const mode: PackMode = measure(allPacked, 'full') <= budgetTokens ? 'full' : 'truncated'

    let knowledge: PackedKnowledge[]
    let retrieval: ContextPack['retrieval']
    if (mode === 'full') {
      knowledge = allPacked
      retrieval = { mode: 'full', query: null, hits: 0 }
    } else {
      const ranked = this.rankKnowledge(knowledgeCandidates, query)
      retrieval = { mode: ranked.mode, query, hits: ranked.hits }
      const chosen: PackedKnowledge[] = []
      for (let i = 0; i < ranked.entries.length; i++) {
        const rest = ranked.entries.slice(i + 1).map((e) => asDropped(e))
        const packed = packKnowledge(ranked.entries[i], false, ranked.matched[i])
        const restDropped = [...dropped, ...rest]
        if (measureWith([...chosen, packed], restDropped, budgetTokens) <= budgetTokens) {
          chosen.push(packed)
          continue
        }
        // 放不下整条：剩余空间够一段有意义内容就截断收入，否则收手
        const probe = skeleton([], 'truncated', records.length)
        probe.knowledge = chosen
        probe.dropped = restDropped
        const sliceBudget =
          budgetTokens -
          estimateTokens(renderContextPackText(probe)) -
          PACK_OVERHEAD_TOKENS -
          estimateTokens(String(ranked.entries[i].title ?? '')) -
          estimateTokens(ITEM_TRUNCATE_MARKER)
        if (sliceBudget >= KNOWLEDGE_ITEM_MIN_TOKENS) {
          chosen.push(packKnowledge(ranked.entries[i], true, ranked.matched[i], sliceBudget))
        }
        break
      }
      // 保险丝：估算/渲染极小差值也不许越界，按同序从尾部让位
      let count = chosen.length
      const rebuildDropped = (): DroppedItem[] => [
        ...dropped,
        ...ranked.entries.slice(count).map((e) => asDropped(e))
      ]
      let currentDropped = rebuildDropped()
      while (count > 0 && measureWith(chosen.slice(0, count), currentDropped, budgetTokens) > budgetTokens) {
        count -= 1
        currentDropped = rebuildDropped()
      }
      knowledge = chosen.slice(0, count)
      dropped.push(...currentDropped.filter((d) => d.reason === 'budget'))
      this.log(
        `[context] scope=${scope} 裁剪：注入 ${knowledge.length}/${knowledgeCandidates.length} 条知识` +
          `（mode=truncated, query=${query ?? '（无，按时间）'}）`
      )
    }

    // ── 7 对话历史（独立预算，不进 60/70% 账本）──
    const history = await this.loadHistory(options.conversationKey)

    const pack: ContextPack = {
      scope,
      conversationKey: options.conversationKey ?? null,
      task,
      profileSummary,
      matters,
      todos,
      records,
      knowledge,
      history,
      budget: {
        contextWindowTokens: window,
        ratio: CONTEXT_BUDGET_RATIO,
        budgetTokens,
        usedTokens: 0,
        remainingTokens: 0,
        reservedTokens: window - budgetTokens,
        mode,
        recordTotal: records.length,
        knowledgeTotal: knowledgeCandidates.length,
        knowledgeIncluded: knowledge.length,
        truncatedItems: knowledge.filter((k) => k.truncated).length
      },
      dropped: dedupeDropped(dropped),
      retrieval,
      builtAt: this.now()
    }
    const usedTokens = estimateTokens(renderContextPackText(pack))
    pack.budget.usedTokens = usedTokens
    pack.budget.remainingTokens = Math.max(0, budgetTokens - usedTokens)
    return pack
  }

  /** 第 7 段：读最近对话；assistant 内容若对应未确认候选，带「未确认」标记 */
  private async loadHistory(
    conversationKey: string | null | undefined
  ): Promise<ContextPack['history']> {
    if (!conversationKey) return []
    const rows = await this.database.request<Array<Record<string, unknown>>>('conversations.list', {
      where: { conversation_key: conversationKey },
      order: [{ column: 'created_at', direction: 'asc' }],
      limit: 20
    })
    return rows.map((row) => {
      let unconfirmed = false
      if (row.metadata) {
        try {
          const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>
          unconfirmed = meta?.status === 'candidate' || meta?.unconfirmed === true
        } catch {
          /* 元数据损坏不影响装载 */
        }
      }
      return {
        role: String(row.role ?? 'user'),
        content: typeof row.content === 'string' ? row.content : '',
        unconfirmed
      }
    })
  }

  /** 裁剪排序：有 query → LIKE 命中优先（命中集内按最近）；无 query → 按时间 */
  private rankKnowledge(
    candidates: Array<Record<string, unknown>>,
    query: string | null
  ): {
    entries: Array<Record<string, unknown>>
    matched: boolean[]
    mode: RetrievalMode
    hits: number
  } {
    if (!query) {
      // candidates 已按 updated_at desc 读入 → recency
      return { entries: candidates, matched: candidates.map(() => false), mode: 'recency', hits: 0 }
    }
    const needle = query.toLowerCase()
    const hitRows: Array<Record<string, unknown>> = []
    const rest: Array<Record<string, unknown>> = []
    for (const row of candidates) {
      const hay = `${String(row.title ?? '')}\n${String(row.content ?? '')}`.toLowerCase()
      if (hay.includes(needle)) hitRows.push(row)
      else rest.push(row)
    }
    return {
      entries: [...hitRows, ...rest],
      matched: [...hitRows.map(() => true), ...rest.map(() => false)],
      mode: 'like',
      hits: hitRows.length
    }
  }

  private resolveWindow(value: number | null | undefined): number {
    if (value === undefined || value === null) return this.defaultContextWindowTokens
    return requireWindow(value)
  }
}

/** 裁剪测量：渲染时带显式 dropped 列表（未注入清单也占预算） */
function measureWith(
  knowledge: PackedKnowledge[],
  droppedItems: DroppedItem[],
  _budget: number
): number {
  // 直接渲染一个临时 pack 的第 2-6 段
  const text = [
    '',
    '',
    ...knowledge.map(
      (k) => `《${k.title}》\n${k.content}${k.truncated ? ITEM_TRUNCATE_MARKER : ''}`
    ),
    ...droppedItems.slice(0, DROPPED_TITLES_SHOWN).map((d) => shortTitle(d.title))
  ].join('\n')
  return estimateTokens(text) + PACK_OVERHEAD_TOKENS
}

// ── 渲染（Pack → prompt 文本）────────────────────────────────────────────────

export function renderContextPackText(pack: ContextPack): string {
  const parts: string[] = []

  // 1 任务指令（永不裁）
  parts.push('【任务】')
  parts.push(pack.task)

  // 2 画像
  parts.push('')
  parts.push('【工作画像】')
  parts.push(pack.profileSummary ? pack.profileSummary.text : '（尚未填写工作画像）')

  // 3 事项
  parts.push('')
  parts.push(`【在跟事项】（${pack.matters.length} 条）`)
  parts.push(pack.matters.length ? pack.matters.map((m) => (m.color ? `#${m.name}` : m.name)).join('、') : '（无）')

  // 4 待办
  parts.push('')
  parts.push(`【待办】（${pack.todos.length} 条）`)
  if (pack.todos.length) {
    parts.push(
      pack.todos.map((t) => {
        const due = t.dueDate ? `（截止 ${t.dueDate}）` : ''
        return `· ${t.title}${due}`
      }).join('\n')
    )
  } else {
    parts.push('（无）')
  }

  // 5 近期记录
  parts.push('')
  parts.push(`【近期工作记录】（${pack.records.length} 条，均为已确认事实）`)
  if (pack.records.length) {
    parts.push(
      pack.records.map((r) => {
        const time = r.occurredTime ? r.occurredTime : ''
        return `· [${r.occurredDate}${time ? ' ' + time : ''}] ${r.content}`
      }).join('\n')
    )
  } else {
    parts.push('（窗口期内无已确认记录）')
  }

  // 6 知识
  const total = pack.budget.knowledgeTotal
  const included = pack.knowledge.length
  const suffix = pack.budget.mode === 'full' ? '全量注入' : `超上下文预算，已裁剪 ${included}/${total} 条`
  parts.push('')
  parts.push(`【工作知识库】（${included}/${total} 条，${suffix}）`)
  if (!included) {
    parts.push(total > 0 ? '（预算不足，本次未注入资料）' : '（知识库为空）')
  } else {
    pack.knowledge.forEach((k, i) => {
      parts.push(`〈${i + 1}. ${k.title}〉`)
      parts.push(k.content + (k.truncated ? ITEM_TRUNCATE_MARKER : ''))
    })
  }
  if (pack.dropped.filter((d) => d.section === 6).length) {
    const d6 = pack.dropped.filter((d) => d.section === 6)
    const shown = d6.slice(0, DROPPED_TITLES_SHOWN).map((d) => shortTitle(d.title))
    const more = d6.length > shown.length ? ` 等 ${d6.length} 条` : ''
    parts.push(`（本次未注入：${shown.join('、')}${more}）`)
  }

  // 7 对话历史（独立预算）
  if (pack.history.length) {
    parts.push('')
    parts.push('【本会话历史】')
    for (const h of pack.history) {
      const tag = h.unconfirmed ? '（未确认）' : ''
      parts.push(`${h.role === 'user' ? '用户' : '助手'}${tag}：${h.content}`)
    }
  }

  return parts.join('\n')
}

function shortTitle(title: string): string {
  const t = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > DROPPED_TITLE_MAX_CHARS ? t.slice(0, DROPPED_TITLE_MAX_CHARS) + '…' : t
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function requireWindow(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `上下文窗口必须是整数 token: ${String(value)}`)
  }
  if (n < MIN_CONTEXT_WINDOW_TOKENS || n > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `上下文窗口需在 ${MIN_CONTEXT_WINDOW_TOKENS}-${MAX_CONTEXT_WINDOW_TOKENS} 之间`
    )
  }
  return n
}

function normalizeTask(task: unknown): string {
  const text = typeof task === 'string' ? task.trim() : ''
  if (!text) return '请基于上述工作记忆完成本次任务。'
  if (text.length > 1000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '任务指令不能超过 1000 字')
  }
  return text
}

function normalizeQuery(query: unknown): string | null {
  if (query === undefined || query === null) return null
  const text = typeof query === 'string' ? query.trim() : ''
  return text || null
}

function dedupeDropped(items: DroppedItem[]): DroppedItem[] {
  const seen = new Set<string>()
  const out: DroppedItem[] = []
  for (const item of items) {
    const key = `${item.section}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
}

/** 日期加减天（返回 YYYY-MM-DD） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  return new ContextEngine(options)
}
