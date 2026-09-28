// work/openclawSummaryManager.ts —— 桥接 OpenClaw：让它自己说「今天做了什么」
//
// v0.18 改判（北 2026-09-28 拍板）：**不再自己去读 OpenClaw 的内部库**。
// 旧实现为了「自己去找」背了一整条脆弱链路——schema 耦合（transcript_events /
// session_windows / event_json 格式）、created_at 时钟口径、重启重写守卫、秒级时间戳
// 兼容、keyset 增量分页、每库水位线、三重去重、行数/输出预算降级、指数退避——
//  bug 修不完。现在改成**问它自己**：通过现有 GatewayClient 发一次会话，
// 让 OpenClaw 用自己的跨会话记忆列出当天做过的事，我们只做「按行解析 → 落候选」。
//
// 为什么是「日报时刻前 30 分钟」（b 方案）：未确认的候选不进事实层（硬规则 4），
// 到点自动生成的日报草稿才可能包含它们——总结必须**早于**草稿生成，留出确认窗口。
//
// 口径钉死：
//   - 结果永远是**候选**（走 recordManager.proposeCandidate），用户确认才成为事实
//   - 自动：每天最多 3 次尝试、两次尝试间隔 ≥5 分钟。**不做指数退避**——一次调用
//     就是一次，没有旧实现「重读同一批转录」的成本放大效应；耗尽后当天不再自动跑
//   - 手动按钮永远可用：不消耗、也不受自动尝试预算约束；成功后**不清** autoDone
//     （到点那次照跑，把下午新增的工作补上）
//   - 同日重复触发靠「当日已提议集合」（内容哈希）挡住，不产生重复候选
//   - 一次总结 = 一个按日固定的 conversationKey（天然幂等锚，且被 reader 侧的
//     `:conv:work:` 排除规则挡在提炼范围外，不会自我循环）
//
// 本模块不 import electron；gateway / records / DB 全注入，纯 Node 可测。

import { createHash } from 'crypto'
import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import type { GatewayClient } from '../gatewayClient'
import type { RecordManager } from './recordManager'
import { dateOf } from './todoManager'

/** 自动开关（app_meta；默认关——它会调模型花钱，必须用户主动开） */
const META_AUTO = 'openclaw_summary_auto'
/** 当日自动轮次状态（app_meta）：尝试次数 / 是否已跑成 / 最近一次结果 */
const META_STATE = 'openclaw_summary_state'
/** 当日已提议集合（app_meta）：日期 → 内容哈希集合，防同日重复触发产生重复候选 */
const META_PROPOSED = 'openclaw_summary_proposed'

/** 自动模式当天最多尝试次数（失败不无限重试烧钱） */
export const MAX_AUTO_ATTEMPTS_PER_DAY = 3
/** 两次自动尝试的最小间隔：网关没起来时不要每 30 秒撞一次 */
export const AUTO_RETRY_GAP_MS = 5 * 60_000
/** 已提议集合只保留今天与昨天（跨午夜补跑仍挡得住，更早的自然过期） */
const PROPOSED_KEEP_DAYS = 2

export type SummaryTrigger = 'manual' | 'auto'

/** 一次总结的结果（手动按钮据此出 toast） */
export interface SummaryRunResult {
  /** 被总结的那一天（YYYY-MM-DD） */
  date: string
  /** 新入队候选条数 */
  proposed: number
  /** 当日已提议过、本次跳过的条数（重复触发 / 措辞相同） */
  duplicates: number
  /** 被质量门槛挡下的条数（留痕在记录页「已过滤」） */
  filtered: number
  /** 模型明确表示没有可确证内容 */
  empty: boolean
  candidateIds: string[]
}

/** 设置页 / 今日页要展示的状态 */
export interface SummaryStatus {
  enabled: boolean
  date: string
  /** 当天自动尝试次数 */
  attempts: number
  /** 当天自动轮次是否已成功跑过（成功即不再自动跑；手动不受限） */
  autoDone: boolean
  lastAt: number | null
  lastTrigger: SummaryTrigger | null
  lastStatus: 'done' | 'empty' | 'error' | null
  lastMessage: string | null
  lastProposed: number
}

/** 给 ReminderManager 的调度结果（永不抛错：调度侧只看 status 决定要不要下轮再试） */
export type ScheduledSummaryResult =
  | { status: 'done'; date: string; proposed: number }
  | { status: 'empty'; date: string }
  | {
      status: 'skipped'
      reason: 'disabled' | 'done' | 'attempts-exhausted' | 'retry-wait'
      date: string
    }
  | { status: 'error'; message: string; date: string }

interface DayState {
  date: string
  attempts: number
  autoDone: boolean
  lastAt: number | null
  lastTrigger: SummaryTrigger | null
  lastStatus: 'done' | 'empty' | 'error' | null
  lastMessage: string | null
  lastProposed: number
}

export interface OpenClawSummaryManagerOptions {
  database: DatabaseClient
  records: RecordManager
  gateway: GatewayClient
  newId?: () => string
  now?: () => number
  logger?: (message: string) => void
}

/** 「没有内容」标记短语（整行精确匹配；只收明确表达「无事可记」的说法） */
const EMPTY_MARKER_PHRASES = new Set([
  '无',
  '暂无',
  '无内容',
  '暂无内容',
  '无记录',
  '暂无记录',
  '无工作记录',
  '暂无工作记录',
  '无可记录内容',
  '暂无可记录内容',
  '没有内容',
  '没有可记录内容',
  '没有需要记录的内容',
  '没有值得记录的内容',
  '无事项',
  '暂无事项',
  '无进展',
  '暂无进展',
  '无工作',
  '暂无工作'
])

/** 去掉句末标点与外层括号后的标记归一化（「（无）。」→「无」） */
function normalizeMarker(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/[。.：:！!？?]+$/g, '')
    .replace(/^[（(]/, '')
    .replace(/[）)]$/, '')
    .trim()
}

function isEmptyMarker(text: string): boolean {
  return EMPTY_MARKER_PHRASES.has(normalizeMarker(text))
}

/**
 * 模型整体明确表示「没有可记录内容」。
 * 空串/纯空白**不算**——空响应按失败处理（绝不能当「明确无」，否则当天静默丢内容）。
 * 容忍「好的，如下：」之类散文前后缀：只要任一行是「无内容」标记，本意就是无内容。
 */
function isExplicitEmpty(text: string): boolean {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => isEmptyMarker(line.replace(/^[-·*]\s+/, '')))
}

/** 解析模型输出：每行 `- 内容` 为一条；「无内容」标记与解释性散文一律忽略 */
function parseRecordLines(text: string): string[] {
  const items: string[] = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^[-·*]\s+(.+)$/.exec(line)
    if (!match) continue
    const content = match[1].trim()
    // 「- （无）」「- 无。」「- 暂无可记录内容」等变体必须在此挡下：
    // isExplicitEmpty 只在整段 0 条时才被咨询，挡不到逐行变体
    if (content && !isEmptyMarker(content)) items.push(content)
  }
  return items
}

/** 内容短哈希（确定性、跨重启稳定）：当日已提议集合与候选去重键都用它 */
function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** 去重前的内容归一化：忽略大小写与空白差异（模型换行/空格抖动不算新内容） */
function normalizeForDedupe(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * 提示词：让它**只写能确证的**，并明确排除定时推送与「关于工作流本身」的操作
 *（例如让它写日报这件事，不是业务工作）。
 */
function buildSummaryPrompt(date: string): string {
  return [
    `你是工作助手。请回忆 ${date} 这一天，用户通过你（桌面对话 / 微信 / 飞书等任意渠道）实际完成或推进的业务工作。`,
    '',
    '规则：',
    '1. 只写你能从自己的会话记录 / 记忆里**确证**的事，不得编造；不确定就不要写。',
    '2. 忽略闲聊、问候、定时推送（新闻 / 热点播报等），以及「让 AI 写日报 / 周报 / 纪要」这类关于工作流本身的操作。',
    '3. 同一事项的多次来回只保留一条最终进展。',
    '4. 每条单独一行、以「- 」开头，一句话、动宾结构，可直接作为日报事实；不要编号、标题或任何解释。',
    '5. 没有可确证的内容时，只输出一行：- （无）',
    '',
    `【要回忆的日期】${date}`
  ].join('\n')
}

export class OpenClawSummaryManager {
  private readonly database: DatabaseClient
  private readonly records: RecordManager
  private readonly gateway: GatewayClient
  private readonly newId: () => string
  private readonly now: () => number
  private readonly logger?: (message: string) => void
  /** 在途总结（手动点击撞上自动轮次时复用，不重复调模型） */
  private inflight: Promise<SummaryRunResult> | null = null

  constructor(options: OpenClawSummaryManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'OpenClawSummaryManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['database', options.database, 'metaGet'],
      ['records', options.records, 'proposeCandidate'],
      ['gateway', options.gateway, 'createChatStream']
    ] as const) {
      if (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `OpenClawSummaryManager 缺少依赖: ${name}`)
      }
    }
    this.database = options.database
    this.records = options.records
    this.gateway = options.gateway
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 自动总结开关（默认关） */
  async isAutoEnabled(): Promise<boolean> {
    return (await this.database.metaGet(META_AUTO)) === '1'
  }

  async setAutoEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    const value = enabled === true
    await this.database.metaSet(META_AUTO, value ? '1' : '0')
    this.log(`[openclaw-summary] 自动总结 → ${value ? '开' : '关'}`)
    return { enabled: value }
  }

  /** UI 展示用状态（永不抛错：读不到就按「今天还没跑过」返回） */
  async getStatus(): Promise<SummaryStatus> {
    const enabled = await this.isAutoEnabled().catch(() => false)
    const date = dateOf(this.now())
    const state = await this.readState(date)
    return {
      enabled,
      date,
      attempts: state.attempts,
      autoDone: state.autoDone,
      lastAt: state.lastAt,
      lastTrigger: state.lastTrigger,
      lastStatus: state.lastStatus,
      lastMessage: state.lastMessage,
      lastProposed: state.lastProposed
    }
  }

  private emptyState(date: string): DayState {
    return {
      date,
      attempts: 0,
      autoDone: false,
      lastAt: null,
      lastTrigger: null,
      lastStatus: null,
      lastMessage: null,
      lastProposed: 0
    }
  }

  /** 读当日状态（跨天自动归零；损坏按空处理，绝不因为状态坏掉而不总结） */
  private async readState(date: string): Promise<DayState> {
    const raw = await this.database.metaGet(META_STATE).catch(() => null)
    if (!raw) return this.emptyState(date)
    try {
      const parsed = JSON.parse(raw) as Partial<DayState>
      if (!parsed || parsed.date !== date) return this.emptyState(date)
      const empty = this.emptyState(date)
      return {
        ...empty,
        attempts: Number(parsed.attempts) || 0,
        autoDone: parsed.autoDone === true,
        lastAt: Number(parsed.lastAt) || null,
        lastTrigger: parsed.lastTrigger === 'manual' ? 'manual' : parsed.lastTrigger === 'auto' ? 'auto' : null,
        lastStatus:
          parsed.lastStatus === 'done' || parsed.lastStatus === 'empty' || parsed.lastStatus === 'error'
            ? parsed.lastStatus
            : null,
        lastMessage: typeof parsed.lastMessage === 'string' ? parsed.lastMessage : null,
        lastProposed: Number(parsed.lastProposed) || 0
      }
    } catch {
      return this.emptyState(date)
    }
  }

  private async writeState(state: DayState): Promise<void> {
    await this.database.metaSet(META_STATE, JSON.stringify(state))
  }

  /** 读当日已提议集合（内容哈希 → 提议时间） */
  private async readProposed(date: string): Promise<Record<string, number>> {
    const raw = await this.database.metaGet(META_PROPOSED).catch(() => null)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const day = parsed?.[date]
      if (!day || typeof day !== 'object') return {}
      const out: Record<string, number> = {}
      for (const [hash, ts] of Object.entries(day as Record<string, unknown>)) {
        const n = Number(ts)
        if (hash && Number.isFinite(n)) out[hash] = n
      }
      return out
    } catch {
      return {}
    }
  }

  /** 写回已提议集合，并把超过保留天数的旧日期整块丢掉（防长期累积） */
  private async saveProposed(date: string, dayMap: Record<string, number>, now: number): Promise<void> {
    const raw = await this.database.metaGet(META_PROPOSED).catch(() => null)
    let all: Record<string, Record<string, number>> = {}
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (value && typeof value === 'object') all[key] = value as Record<string, number>
          }
        }
      } catch {
        all = {}
      }
    }
    all[date] = dayMap
    const cutoff = now - PROPOSED_KEEP_DAYS * 24 * 3600_000
    for (const key of Object.keys(all)) {
      const timestamps = Object.values(all[key] ?? {}).map(Number).filter((n) => Number.isFinite(n))
      const newest = timestamps.length ? Math.max(...timestamps) : 0
      if (newest && newest < cutoff) delete all[key]
    }
    await this.database.metaSet(META_PROPOSED, JSON.stringify(all))
  }

  /**
   * 调度入口（ReminderManager 在「日报时刻 - 30 分钟」窗口内调用）。
   * **永不抛错**：调度侧只看 status 决定本轮是否结束、下一轮要不要再试。
   */
  async runScheduled(): Promise<ScheduledSummaryResult> {
    const date = dateOf(this.now())
    if (!(await this.isAutoEnabled())) return { status: 'skipped', reason: 'disabled', date }
    const state = await this.readState(date)
    if (state.autoDone) return { status: 'skipped', reason: 'done', date }
    if (state.attempts >= MAX_AUTO_ATTEMPTS_PER_DAY) {
      this.log('[openclaw-summary] 当天自动尝试已达上限，等手动触发')
      return { status: 'skipped', reason: 'attempts-exhausted', date }
    }
    const lastAttemptAt = state.lastAt ?? 0
    if (state.lastStatus === 'error' && this.now() - lastAttemptAt < AUTO_RETRY_GAP_MS) {
      return { status: 'skipped', reason: 'retry-wait', date }
    }
    try {
      const result = await this.summarizeToday('auto')
      return result.empty
        ? { status: 'empty', date }
        : { status: 'done', date, proposed: result.proposed }
    } catch (e) {
      return { status: 'error', message: (e as Error)?.message ?? String(e), date }
    }
  }

  /**
   * 立刻总结今天（手动按钮 / 调度共用）。
   * 失败抛 AppError（手动侧出 toast；调度侧由 runScheduled 兜成 error 状态）。
   */
  async summarizeToday(trigger: SummaryTrigger = 'manual'): Promise<SummaryRunResult> {
    // 在途复用：手动点击撞上自动轮次时不重复调模型（两条路径做的是同一件事）
    if (this.inflight) return this.inflight
    const run = this.doSummarize(trigger).finally(() => {
      this.inflight = null
    })
    this.inflight = run
    return run
  }

  private async doSummarize(trigger: SummaryTrigger): Promise<SummaryRunResult> {
    const now = this.now()
    const date = dateOf(now)
    const state = await this.readState(date)

    // 流式而非一次性：网关冷启动实测 80s+，非流式的 120s 硬超时太贴脸；
    // 流式按 chunk 空闲计时，且首字快（实测 1.27s）
    const handle = this.gateway.createChatStream({
      conversationKey: `conv:work:summary:daily:${date}:${this.newId()}`,
      messages: [
        { role: 'system', content: buildSummaryPrompt(date) },
        { role: 'user', content: `请列出 ${date} 的工作记录。` }
      ],
      stream: true
    })
    let text = ''
    try {
      const result = await handle.result
      if (result.aborted) {
        throw new AppError(ERROR_CODES.OPENCLAW_NOT_READY, 'OpenClaw 总结已中止', {
          reason: 'aborted'
        })
      }
      text = String(result.text ?? '')
    } catch (error) {
      await this.recordFailure(state, trigger, now, (error as Error)?.message ?? String(error))
      throw error
    }

    const items = parseRecordLines(text)
    // 0 条时：整段是明确的「无内容」标记才放过；空响应与无法识别同属失败
    //（空响应绝不能当「明确无」，否则当天内容静默丢失）
    if (items.length === 0 && (!text.trim() || !isExplicitEmpty(text))) {
      const message = text.trim()
        ? 'OpenClaw 总结结果无法识别，请稍后重试'
        : 'OpenClaw 总结返回空内容，请稍后重试'
      await this.recordFailure(state, trigger, now, message)
      throw new AppError(ERROR_CODES.OPENCLAW_INVALID_OUTPUT, message, {
        reason: text.trim() ? 'unparseable-output' : 'empty-output'
      })
    }

    // 落候选：当日已提议过的内容跳过（同日重复触发不产生重复候选）
    const proposedMap = await this.readProposed(date)
    const candidateIds: string[] = []
    let proposed = 0
    let duplicates = 0
    let filtered = 0
    for (const content of items) {
      const hash = shortHash(normalizeForDedupe(content))
      if (proposedMap[hash] !== undefined) {
        duplicates += 1
        continue
      }
      const result = await this.records.proposeCandidate({
        content,
        outputType: 'openclaw_summary',
        // 去重键锚定「哪天 + 哪条内容」：同一天重复总结命中同键 → 覆盖更新而非新增
        conversationKey: `conv:work:summary:daily:${date}:${hash}`,
        occurredDate: date
      })
      proposedMap[hash] = now
      if (result.candidate) {
        if (result.deduped) duplicates += 1
        else {
          proposed += 1
          candidateIds.push(result.candidate.id)
        }
      } else if (result.filteredReason) {
        filtered += 1
      }
    }
    await this.saveProposed(date, proposedMap, now)

    const empty = items.length === 0
    await this.writeState({
      ...state,
      date,
      // 自动成功 → 置 autoDone（当天不再自动跑）并清尝试计数；
      // 手动成功 → **两者都不动**：既不占自动预算，也不占掉当天的自动轮次
      //（到点那次照跑，才能把下午新增的工作补进候选）
      attempts: trigger === 'auto' ? 0 : state.attempts,
      autoDone: trigger === 'auto' ? true : state.autoDone,
      lastAt: now,
      lastTrigger: trigger,
      lastStatus: empty ? 'empty' : 'done',
      lastMessage: empty ? 'OpenClaw 表示没有可确证的内容' : null,
      lastProposed: proposed
    })
    this.log(
      `[openclaw-summary] ${date}（${trigger}）→ 新候选 ${proposed}，重复跳过 ${duplicates}，门槛过滤 ${filtered}${empty ? '，模型表示无内容' : ''}`
    )
    return { date, proposed, duplicates, filtered, empty, candidateIds }
  }

  /** 失败落状态：自动尝试计数 +1（手动不占预算），供 UI 展示与调度判定 */
  private async recordFailure(
    state: DayState,
    trigger: SummaryTrigger,
    now: number,
    message: string
  ): Promise<void> {
    try {
      await this.writeState({
        ...state,
        attempts: trigger === 'auto' ? state.attempts + 1 : state.attempts,
        lastAt: now,
        lastTrigger: trigger,
        lastStatus: 'error',
        lastMessage: message
      })
    } catch {
      /* 状态写入失败不掩盖原始故障 */
    }
    this.log(`[openclaw-summary] ${trigger} 总结失败: ${message}`)
  }
}

export function createOpenClawSummaryManager(
  options: OpenClawSummaryManagerOptions
): OpenClawSummaryManager {
  return new OpenClawSummaryManager(options)
}
