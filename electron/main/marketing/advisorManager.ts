// advisorManager.ts —— AI Advisor（PLAN-2.0.md Commit 08）
//
// 契约（§六「AI Advisor 定义」/ §一 产品智能原则 / §二 硬规则 9、10、13 / §五 错误码 / §七 08 行）：
//   - 定位：营销工作台内的 **grounded 对话入口**——老板用自然语言提问（卖点怎么讲、客户嫌贵怎么回、
//     给几个内容角度），AI 基于**当前 Project 的 Business + Knowledge + Watchlist** 回答。
//     它是 06 Context Engine 与 07 Gateway Client 的**第一个真实消费者**：证明「AI 认识这个商家」。
//   - 每轮请求 = **Context Pack**（06 组装：business 摘要 + 全部/裁剪后的 knowledge + watchlist +
//     platform/task）+ 用户消息，经 07 调 Gateway，`user=conv:<projectId>:<conversation_key>`。
//   - **事实护栏**（§一「不硬编」）：价格/套餐/承诺/卖点只能引用知识库；资料里没有就明示
//     「资料里没有，建议补充」。这条规则写在 system prompt 里，且**资料缺口（missing）显式入 prompt**——
//     08 的「生成前主动追问缺口」就靠它。
//   - **对话历史不落库**：Commit 00 实测结论 A（同一 `user=` 的第二轮能复述第一轮暗号）→
//     历史由 OpenClaw 的 sticky 会话承载，本地**不建消息表**、也**不回灌**。
//   - 明确不做（§六）：不做结构化内容生产（归 09）、不做数据复盘（三期 Analytics）、
//     **不做自动回复/自动发送**（硬规则 10，Advisor 只服务老板本人）、不做主动任务执行。
//   - **硬规则 13**：本模块不直接发 HTTP——出站全部经注入的 07 `GatewayClient`（token 只在主进程）；
//     本模块也**不 import electron**（依赖注入 → 纯 Node 可测）。
//   - 本提交**不注册 IPC**：渲染端面（`marketing:advisor:*`）与面板归本提交的 UI 半边，
//     事件名沿用 07 的 `forwardGatewayStream` 约定（见 ipc/advisor.ts）。

import { AppError, ERROR_CODES } from '../database/errors'
import { WATCHLIST_MAX, WATCHLIST_KEYWORD_MAX_LENGTH, WATCHLIST_TYPES, type WatchlistManager } from './businessManager'
import {
  renderContextPackText,
  PLATFORMS,
  type ContextEngine,
  type ContextPack,
  type Platform
} from './contextEngine'
import type { GatewayClient, GatewayChatMessage, GatewayStreamHandle, GatewayUsage } from '../gatewayClient'

/** 提问长度上限（防把整篇文档粘进来；顾问问题是短问句） */
export const ADVISOR_QUESTION_MAX_LENGTH = 1_000
/** 单轮 system prompt 的额外固定开销上限（护栏文案本身；不计入 Context Pack 预算） */
export const ADVISOR_PLATFORM_HINT_MAX_LENGTH = 200

/** 扩词候选默认/上限条数（§七 08：候选词生成 + 用户勾选；04 的 Watchlist 上限是 10 词） */
export const ADVISOR_WATCH_CANDIDATES_DEFAULT = 8
export const ADVISOR_WATCH_CANDIDATES_MAX = 20

/** 扩词任务的固定指令（写死，避免「让模型自己决定输出格式」） */
export const WATCH_CANDIDATE_PROMPT = [
  '请根据下面的【商家资料】，给出若干个「老板值得关注的行业词」候选。',
  '要求：①每个词不超过 12 个字；②不要与【已有的关注词】重复；③按类型标注。',
  '只输出 JSON 数组，不要任何解释或代码块围栏，格式：',
  '[{"keyword":"杭州婚纱","type":"industry","reason":"一句话理由"}]',
  'type 只能是 industry（行业）/ product（产品）/ audience（受众）/ region（地域）。'
].join('\n')

/** 事实护栏：写死的 system 规则（§一「不硬编」+ 硬规则 10） */
export const ADVISOR_GUARDRAILS = [
  '你是这位老板的营销顾问。**只能依据下面给出的商家资料回答**，不得编造。',
  '',
  '硬性规则：',
  '1) 价格、套餐、优惠、承诺、卖点、案例——只能引用资料里出现过的原文信息；资料里没有，就直说',
  '   「资料里没有，建议补充」，并说明补什么最有用。',
  '2) 不编数字、不编效果、不编客户案例；不确定就说不确定。',
  '3) 建议要能直接拿去用（给具体文案/话术/标题/角度），不要只给空泛方向。',
  '4) 内容一律由老板人工确认后手动发布：不要建议「自动回复」「自动发布」。',
  '5) 如果上面的资料缺口列表非空，请在回答末尾用一行「建议补充：…」列出来。'
].join('\n')

export interface AdvisorAskInput {
  /** 当前 Project（硬规则 9：显式传参） */
  projectId: string
  /** 老板的问题（自然语言） */
  question: string
  /** 发布平台（可空：不挑平台的问题，如「客户嫌贵怎么回」） */
  platform?: string | null
  /** 覆盖模型（仍受 `openclaw` / `openclaw/<agentId>` 形态约束） */
  model?: string | null
  /** 外部中止（组件卸载/切换商家） */
  signal?: AbortSignal
}

/** 一轮问答的组装结果：给 IPC 层转发用（含「AI 看见了什么」的可解释信息） */
export interface AdvisorTurn {
  projectId: string
  /** 事实护栏 + Context Pack 渲染出的固定部分（system） */
  systemPrompt: string
  /** 老板的问题（user） */
  question: string
  pack: ContextPack
  handle: GatewayStreamHandle
  /** 该轮用的发布平台（回显） */
  platform: Platform | null
}

export interface WatchCandidate {
  keyword: string
  type: string | null
  reason: string | null
  /** 是否已在关注词里（true 的不该再推荐，保留字段仅供 UI 展示去重原因） */
  existing: boolean
}

export interface AdvisorManagerOptions {
  /** 06 的 Context Engine（唯一上下文来源） */
  contextEngine: ContextEngine
  /** 07 的 Gateway Client（唯一出站通道；token 只在它手里） */
  gateway: GatewayClient
  /** 04 的 Watchlist（扩词候选要去重既有词） */
  watchlistManager: WatchlistManager
  logger?: (message: string) => void
}

export class AdvisorManager {
  private readonly contextEngine: ContextEngine
  private readonly gateway: GatewayClient
  private readonly watchlistManager: WatchlistManager
  private readonly logger?: (message: string) => void

  constructor(options: AdvisorManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'AdvisorManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['contextEngine', options.contextEngine, 'buildContextPack'],
      ['gateway', options.gateway, 'createChatStream'],
      ['watchlistManager', options.watchlistManager, 'listWatchlist']
    ] as const) {
      if (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `AdvisorManager 缺少依赖: ${name}`)
      }
    }
    this.contextEngine = options.contextEngine
    this.gateway = options.gateway
    this.watchlistManager = options.watchlistManager
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 组装 system prompt：事实护栏 + Context Pack 渲染 + 资料缺口（§一「生成前主动追问缺口」） */
  buildSystemPrompt(pack: ContextPack, platform: Platform | null): string {
    const parts = [ADVISOR_GUARDRAILS, '', '——— 以下是这位商家的资料 ———', renderContextPackText(pack)]
    if (platform) {
      parts.push('', `本次面向的发布平台：${platform}`)
    }
    const missing = pack.businessCompleteness.missing
    parts.push(
      '',
      '资料缺口列表：' +
        (missing.length
          ? `${missing.join('、')}（商家资料六项里缺这些）`
          : '商家资料六项齐全') +
        (pack.budget.mode === 'truncated'
          ? `；另有 ${pack.budget.knowledgeDropped} 条资料因上下文预算未注入`
          : '')
    )
    return parts.join('\n')
  }

  /**
   * 问一轮（**流式**：§六 实测首字 1.27s vs 冷启动 80.3s，产品必须走流式）。
   *
   * 返回的 `handle` 交给 IPC 层用 `forwardGatewayStream` 推给渲染进程；
   * `cancel()` 会真的断上游（07 已验），因此面板的「停止生成」是名副其实的。
   */
  async ask(input: AdvisorAskInput): Promise<AdvisorTurn> {
    const projectId = requireId(input?.projectId, 'ask')
    const question = requireQuestion(input?.question)
    const platform = normalizePlatform(input?.platform)
    const model = input?.model ? String(input.model) : undefined

    // 1) Context Pack（06 负责预算内全量打包 / 超预算裁剪）
    const pack = await this.contextEngine.buildContextPack(projectId, {
      platform,
      task: 'advisor-qa',
      customer: null,
      query: question // 超预算时按问题做 LIKE 裁剪（§六）
    })

    // 2) 组装消息：system = 护栏 + 资料；user = 老板的问题（历史由 sticky user= 承载，不回灌）
    const systemPrompt = this.buildSystemPrompt(pack, platform)
    const messages: GatewayChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ]

    const handle = this.gateway.createChatStream({
      projectId,
      messages,
      model,
      signal: input?.signal
    })
    this.log(
      `[advisor] ask project=${projectId} platform=${platform ?? '-'} ` +
        `knowledge=${pack.knowledge.length}/${pack.budget.knowledgeTotal} ` +
        `mode=${pack.budget.mode} used=${pack.budget.usedTokens}/${pack.budget.budgetTokens}`
    )
    return { projectId, systemPrompt, question, pack, handle, platform }
  }

  /**
   * Watchlist AI 扩词候选（§七 08：候选词生成 + 用户勾选；**不自动写入**——写库走 04 的 addWatch）。
   *
   * 写死 JSON 口径 + 本地清洗：去重（大小写不敏感）、排除已有词、剔非法 type、
   * 超长截断/丢弃、条数封顶。模型输出脏了只降级（少给几个），绝不把垃圾写进上下文。
   */
  async suggestWatchlist(
    projectId: string,
    options: { count?: number } = {}
  ): Promise<{ candidates: WatchCandidate[]; raw: string; pack: ContextPack }> {
    const pid = requireId(projectId, 'suggestWatchlist')
    const count = clampCount(options?.count)

    const pack = await this.contextEngine.buildContextPack(pid, {
      task: 'watchlist-candidates',
      query: null
    })
    const existing = await this.watchlistManager.listWatchlist(pid)
    const existingWords = new Set(
      (Array.isArray(existing) ? existing : []).map((row) => String(row?.keyword ?? '').trim().toLowerCase())
    )

    const messages: GatewayChatMessage[] = [
      { role: 'system', content: ADVISOR_GUARDRAILS },
      {
        role: 'user',
        content: [
          WATCH_CANDIDATE_PROMPT,
          `候选数量：${count} 个。`,
          '',
          '——— 商家资料 ———',
          renderContextPackText(pack),
          '',
          '【已有的关注词】' + (existingWords.size ? [...existingWords].join(' / ') : '（暂无）')
        ].join('\n')
      }
    ]
    const result = await this.gateway.chat({ projectId: pid, messages })
    const candidates = parseWatchCandidates(result.text, { existingWords, max: count })
    this.log(
      `[advisor] suggestWatchlist project=${pid} 模型给出 ${candidates.length} 个可用候选（已有 ${existingWords.size} 词）`
    )
    return { candidates, raw: result.text, pack }
  }
}

export function createAdvisorManager(options: AdvisorManagerOptions): AdvisorManager {
  return new AdvisorManager(options)
}

// ── 纯函数：扩词候选解析（可单测） ────────────────────────────────────────────

/**
 * 从模型输出里解析候选词。
 *
 * 容忍三种常见脏输出：①裸 JSON 数组；②```json 围栏；③解释文字里夹一个数组。
 * **解析不出数组一律抛 `VALIDATION_ERROR`**（details.reason='candidates-unparsable'）——
 * 静默返回空列表会让 UI 显示「没有候选」，把「模型抽风」伪装成「真的没什么可关注」。
 */
export function parseWatchCandidates(
  raw: string,
  options: { existingWords?: Set<string>; max?: number } = {}
): WatchCandidate[] {
  const text = String(raw ?? '')
  const jsonText = extractJsonArray(text)
  if (!jsonText) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '模型未返回可解析的候选词 JSON 数组', {
      reason: 'candidates-unparsable',
      sample: text.slice(0, 200)
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '候选词 JSON 解析失败', {
      reason: 'candidates-unparsable',
      detail: e instanceof Error ? e.message : String(e)
    })
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '候选词不是数组', { reason: 'candidates-unparsable' })
  }
  const existing = options.existingWords ?? new Set<string>()
  const max = clampCount(options.max)
  const seen = new Set<string>()
  const out: WatchCandidate[] = []
  for (const item of parsed) {
    const keyword = String((item as { keyword?: unknown })?.keyword ?? '').trim()
    if (!keyword) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue // 模型自己重复
    seen.add(key)
    const type = normalizeCandidateType((item as { type?: unknown })?.type)
    const reasonRaw = (item as { reason?: unknown })?.reason
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null
    const existingHit = existing.has(key)
    if (existingHit) {
      // 已有关注词不该再作为候选（UI 不该让老板重复添加 → CONFLICT）
      out.push({ keyword, type, reason, existing: true })
      continue
    }
    if (keyword.length > WATCHLIST_KEYWORD_MAX_LENGTH) continue // 超长直接丢（04 也会拒，不如在这挡）
    out.push({ keyword, type, reason, existing: false })
  }
  // 候选不该超过「还能再加几个」的上限：已有词占满 10 时，UI 加了也是 CONFLICT
  const room = Math.max(1, WATCHLIST_MAX - existing.size)
  const usable = out.filter((c) => !c.existing).slice(0, Math.min(max, room))
  // 已存在的候选随结果一起回（UI 可展示「已在列表里」），但排在可用候选之后
  return [...usable, ...out.filter((c) => c.existing)]
}

/** 取第一段平衡的 JSON 数组（剥掉 ``` 围栏与前后解释文字） */
function extractJsonArray(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

function normalizeCandidateType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim().toLowerCase()
  return (WATCHLIST_TYPES as readonly string[]).includes(t) ? t : null
}

export function clampCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ADVISOR_WATCH_CANDIDATES_DEFAULT
  return Math.min(Math.floor(n), ADVISOR_WATCH_CANDIDATES_MAX)
}

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

function requireQuestion(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'question 不能为空', { field: 'question' })
  }
  const q = value.trim()
  if (q.length > ADVISOR_QUESTION_MAX_LENGTH) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `问题过长（${q.length} > ${ADVISOR_QUESTION_MAX_LENGTH}）`,
      { field: 'question', max: ADVISOR_QUESTION_MAX_LENGTH, length: q.length }
    )
  }
  return q
}

/** 平台：不传 → null；非法 → VALIDATION_ERROR（不静默归一，避免把错误平台喂进上下文） */
function normalizePlatform(value: unknown): Platform | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'platform 必须是非空字符串或 null', { field: 'platform' })
  }
  const p = value.trim()
  if (!(PLATFORMS as readonly string[]).includes(p)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的发布平台: ${p}`, {
      field: 'platform',
      value: p,
      allowed: [...PLATFORMS]
    })
  }
  return p as Platform
}

/** 供 09/后续复用：usage 里的 token 统计恒为 0（§六 实测），只做透传展示，不参与预算 */
export function summarizeUsage(usage: GatewayUsage | null): string {
  if (!usage) return 'usage=null'
  return `usage(total=${Number(usage.total_tokens ?? 0)})`
}
