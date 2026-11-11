// electron/main/character/contentEngine.ts —— 主动消息内容引擎：候选池 / 未回状态机 / 去重（纯逻辑）
//
// 为什么单独成文件：proactive.ts 只回答「现在能不能发」，本文件回答「发什么、要不要试探、要不要停」。
// 生活卡 hook 不再直接当消息用：每轮把「生活卡 × 模板 + 话题卡 + 台词库 + 关系试探」组合成
// 2–10 条候选，再按未回分级 / 归一化 hash / 3-gram Jaccard / topic 7 天 / intent 连续做过滤。
// 纯逻辑：不 import electron；随机数可注入，验收脚本能固定 rng 复现结果。

import type { LifeCard } from './contentCards'
import type { ProactiveDayState } from './proactive'
import type { CharacterSettings, CharacterState } from './types'

/** 每轮候选池的条数区间（PLAN：不是连续发，而是每轮生成一组再挑一条） */
export const PROACTIVE_MIN_CANDIDATES = 2
export const PROACTIVE_MAX_CANDIDATES = 10
export const PROACTIVE_DEFAULT_CANDIDATES = 6
/** 未回复累计到该条数就 backoff（停发，等用户互动把 unansweredCount 清零） */
export const PROACTIVE_BACKOFF_THRESHOLD = 3
/** 3-gram Jaccard 相似度上限；超过视为近似重复 */
export const DUPLICATE_JACCARD_THRESHOLD = 0.72
/** 最近已发文案保留条数（跨天沿用，用于精确/近似去重） */
export const RECENT_SENT_LIMIT = 20
/** 最近使用过的话题 id 保留条数（约 7 天窗口，同 topic 尽量不重复） */
export const RECENT_TOPIC_LIMIT = 10
/** 同一个关系试探 family 48 小时内最多一次 */
export const NUDGE_SAME_FAMILY_MS = 48 * 60 * 60 * 1000

export type ProactiveIntent = 'life' | 'topic' | 'line' | 'nudge'

const INTENT_ORDER: ProactiveIntent[] = ['life', 'topic', 'line', 'nudge']

export type TopicSlot = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'
const TOPIC_SLOTS: TopicSlot[] = ['morning', 'noon', 'afternoon', 'evening', 'night']

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'
const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter']

/**
 * 月份（1–12）→ 北半球季节：3–5 春、6–8 夏、9–11 秋、12–2 冬。
 * 纯函数（只吃月份），验收可固定月份复现，避免「冬天还在问夏天热不热」这类跨年语料错位。
 */
export function seasonForMonth(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  return 'winter'
}

/** 时间戳 → 当前季节（与 slotForHour 同口径，从注入的 now 取本地月份） */
export function seasonForNow(now: number): Season {
  return seasonForMonth(new Date(now).getMonth() + 1)
}

export interface TopicCard {
  id: string
  title: string
  when: string
  stance: string
  details: string[]
  hooks: string[]
  sample: string
  /** 允许出现的时段；空 = 任意时段 */
  slots: TopicSlot[]
  /** 允许出现的季节；空 = 任意季节（老卡不带此字段即全年可用，向后兼容） */
  seasons: Season[]
}

export interface TopicDeck {
  schema: string
  version: string
  topics: TopicCard[]
}

export interface LineDeck {
  schema: string
  version: string
  groups: Record<string, string[]>
}

/** 内容包：resources/character/cards/{topics,lines}.v1.json 的解析结果 */
export interface ContentDeck {
  topics: TopicDeck
  lines: LineDeck
}

export function createEmptyContentDeck(): ContentDeck {
  return {
    topics: { schema: 'fish-topics/1', version: '0.0.0', topics: [] },
    lines: { schema: 'fish-lines/1', version: '0.0.0', groups: {} }
  }
}

export function parseTopicDeck(raw: unknown): TopicDeck {
  const src = (raw ?? {}) as Record<string, unknown>
  const topics: TopicCard[] = []
  const list = Array.isArray(src.topics) ? src.topics : []
  for (const item of list) {
    const card = parseTopicCard(item)
    if (card) topics.push(card)
  }
  return {
    schema: typeof src.schema === 'string' ? src.schema : 'fish-topics/1',
    version: typeof src.version === 'string' ? src.version : '0.0.0',
    topics
  }
}

function parseTopicCard(raw: unknown): TopicCard | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const id = typeof src.id === 'string' ? src.id.trim() : ''
  if (!id) return null
  const sample = typeof src.sample === 'string' ? src.sample.trim() : ''
  const hooks = readStringList(src.hooks, 10)
  // 没有样例也没有 hook 的卡发出去只会是空话：直接丢弃
  if (!sample && hooks.length === 0) return null
  return {
    id,
    title: typeof src.title === 'string' ? src.title.trim() : id,
    when: typeof src.when === 'string' ? src.when.trim() : '',
    stance: typeof src.stance === 'string' ? src.stance.trim() : '',
    details: readStringList(src.details, 10),
    hooks,
    sample,
    slots: Array.isArray(src.slots)
      ? src.slots.filter(
          (slot): slot is TopicSlot =>
            typeof slot === 'string' && TOPIC_SLOTS.includes(slot as TopicSlot)
        )
      : [],
    seasons: Array.isArray(src.seasons)
      ? src.seasons.filter(
          (season): season is Season =>
            typeof season === 'string' && SEASONS.includes(season as Season)
        )
      : []
  }
}

export function parseLineDeck(raw: unknown): LineDeck {
  const src = (raw ?? {}) as Record<string, unknown>
  const groups: Record<string, string[]> = {}
  const rawGroups =
    src.groups && typeof src.groups === 'object' ? (src.groups as Record<string, unknown>) : {}
  for (const [name, value] of Object.entries(rawGroups)) {
    // 组名只接受小写短横线，避免把 JSON 里的脏键带进内容池
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) continue
    const lines = readStringList(value, 30)
    if (lines.length > 0) groups[name] = lines
  }
  return {
    schema: typeof src.schema === 'string' ? src.schema : 'fish-lines/1',
    version: typeof src.version === 'string' ? src.version : '0.0.0',
    groups
  }
}

export function parseContentDeck(raw: unknown): ContentDeck {
  const src = (raw ?? {}) as Record<string, unknown>
  return { topics: parseTopicDeck(src.topics), lines: parseLineDeck(src.lines) }
}

function readStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text) out.push(text.slice(0, 300))
    if (out.length >= limit) break
  }
  return out
}

/** 用户称呼：设置里没填就退回「你」，模板里永远不留 {{address}} 占位符 */
export function resolveAddress(settings: CharacterSettings): string {
  const address = settings?.relationship?.address
  return typeof address === 'string' && address.trim() ? address.trim() : '你'
}

function fillAddress(text: string, address: string): string {
  return text.replace(/\{\{\s*address\s*\}\}/g, address)
}

// ---------------------------------------------------------------------------
// 去重：归一化 hash（精确）+ 字符 3-gram Jaccard（近似）
// ---------------------------------------------------------------------------

/** 归一化：全半角统一、转小写、去掉空白/标点/符号（表情、括号动作一起进 hash） */
export function normalizeMessage(text: string): string {
  if (typeof text !== 'string' || !text) return ''
  const normalized = text.normalize('NFKC').toLowerCase()
  return normalized.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 归一化后的稳定短 hash；用于「精确重复 0」判定与日志排查 */
export function messageHash(text: string): string {
  const normalized = normalizeMessage(text)
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function messageTrigrams(text: string): Set<string> {
  const chars = Array.from(normalizeMessage(text))
  const out = new Set<string>()
  if (chars.length === 0) return out
  if (chars.length < 3) {
    out.add(chars.join(''))
    return out
  }
  for (let i = 0; i + 2 < chars.length; i += 1) out.add(chars.slice(i, i + 3).join(''))
  return out
}

export function jaccardSimilarity(a: string, b: string): number {
  const left = messageTrigrams(a)
  const right = messageTrigrams(b)
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const gram of left) if (right.has(gram)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

export interface DuplicateCheck {
  duplicate: boolean
  kind?: 'exact' | 'near'
  matched?: string
  similarity?: number
}

/** 与最近已发文案比对：归一化 hash 相同 → 精确重复；3-gram Jaccard 超阈值 → 近似重复 */
export function findDuplicateMessage(
  text: string,
  recentTexts: unknown,
  threshold = DUPLICATE_JACCARD_THRESHOLD
): DuplicateCheck {
  const recent = sanitizeTextList(recentTexts)
  const hash = messageHash(text)
  for (const recentText of recent) {
    if (messageHash(recentText) === hash) {
      return { duplicate: true, kind: 'exact', matched: recentText, similarity: 1 }
    }
  }
  let best = 0
  let matched = ''
  for (const recentText of recent) {
    const score = jaccardSimilarity(text, recentText)
    if (score > best) {
      best = score
      matched = recentText
    }
  }
  if (best > threshold) {
    return { duplicate: true, kind: 'near', matched, similarity: best }
  }
  return { duplicate: false, similarity: best }
}

export function isDuplicateMessage(
  text: string,
  recentTexts: unknown,
  threshold = DUPLICATE_JACCARD_THRESHOLD
): boolean {
  return findDuplicateMessage(text, recentTexts, threshold).duplicate
}

/** 清洗「最近已发文案」：去空/去重，保留最新 limit 条（旧数据坏值一律丢弃） */
export function sanitizeTextList(value: unknown, limit = RECENT_SENT_LIMIT): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text) continue
    const hash = messageHash(text)
    if (seen.has(hash)) continue
    seen.add(hash)
    out.push(text.slice(0, 300))
  }
  return out.slice(-limit)
}

export function sanitizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text || text.length > 120) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.slice(-limit)
}

export function sanitizeTimeList(value: unknown, limit = RECENT_SENT_LIMIT): number[] {
  if (!Array.isArray(value)) return []
  const out = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0
  )
  return out.sort((a, b) => a - b).slice(-limit)
}

/** 追加一条已发文案（归一化相同视为同一条，避免 20 条被同一句占满） */
export function appendRecentString(value: unknown, item: string, limit: number): string[] {
  const text = typeof item === 'string' ? item.trim() : ''
  if (!text) return sanitizeStringList(value, limit)
  const base = sanitizeStringList(value, limit)
  const hash = messageHash(text)
  const rest = base.filter((existing) => messageHash(existing) !== hash)
  return [...rest, text.slice(0, 300)].slice(-limit)
}

export function appendRecentText(value: unknown, text: string): string[] {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const base = sanitizeTextList(value)
  if (!trimmed) return base
  const hash = messageHash(trimmed)
  const rest = base.filter((existing) => messageHash(existing) !== hash)
  return [...rest, trimmed.slice(0, 300)].slice(-RECENT_SENT_LIMIT)
}

export function appendRecentTime(value: unknown, at: number): number[] {
  const base = sanitizeTimeList(value)
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return base
  return [...base, at].sort((a, b) => a - b).slice(-RECENT_SENT_LIMIT)
}

/** 跨天合并已发文案：旧的一天在前、今天在后，按归一化 hash 去重后保留最新 limit 条 */
export function mergeRecentTexts(older: unknown, newer: unknown, limit = RECENT_SENT_LIMIT): string[] {
  const merged = [...sanitizeTextList(older, limit), ...sanitizeTextList(newer, limit)]
  return sanitizeTextList(merged, limit)
}

/** 跨天合并字符串 ids（话题）：旧的一天在前、今天在后，保留最新 limit 条 */
export function mergeRecentStrings(older: unknown, newer: unknown, limit: number): string[] {
  const merged = [...sanitizeStringList(older, limit), ...sanitizeStringList(newer, limit)]
  return sanitizeStringList(merged, limit)
}

export function mergeRecentTimes(older: unknown, newer: unknown, limit = RECENT_SENT_LIMIT): number[] {
  const merged = [...sanitizeTimeList(older), ...sanitizeTimeList(newer)]
  // 跨天读取时 prev 会被拼进今天并再次写回；不去重会把同一条发送时间重复计数，提前触发 backoff
  return [...new Set(merged)].sort((a, b) => a - b).slice(-limit)
}

// ---------------------------------------------------------------------------
// 未回复状态机
// ---------------------------------------------------------------------------

/** 旧 kv 兼容：把 day 记录洗成安全字段（缺字段补空数组，坏值丢弃） */
export function sanitizeProactiveDay(raw: unknown): ProactiveDayState {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const day: ProactiveDayState = {
    sentTimes: sanitizeTimeList(src.sentTimes),
    recentSentTexts: sanitizeTextList(src.recentSentTexts),
    recentTopics: sanitizeStringList(src.recentTopics, RECENT_TOPIC_LIMIT)
  }
  const activeSent = countValue(src.activeSent, 1000)
  if (activeSent !== undefined) day.activeSent = activeSent
  const voiceSent = countValue(src.voiceSent, 1000)
  if (voiceSent !== undefined) day.voiceSent = voiceSent
  const intimacyGained = countValue(src.intimacyGained, 1_000_000)
  if (intimacyGained !== undefined) day.intimacyGained = intimacyGained
  const unansweredCount = countValue(src.unansweredCount, 99)
  if (unansweredCount !== undefined) day.unansweredCount = unansweredCount
  const lastActiveAt = finiteTime(src.lastActiveAt)
  if (lastActiveAt !== undefined) day.lastActiveAt = lastActiveAt
  const nextAllowedAt = finiteTime(src.nextAllowedAt)
  if (nextAllowedAt !== undefined) day.nextAllowedAt = nextAllowedAt
  const lastProactiveAt = finiteTime(src.lastProactiveAt)
  if (lastProactiveAt !== undefined) day.lastProactiveAt = lastProactiveAt
  const lastNudgeAt = finiteTime(src.lastNudgeAt)
  if (lastNudgeAt !== undefined) day.lastNudgeAt = lastNudgeAt
  const lastNudgeFamily = readShortString(src.lastNudgeFamily)
  if (lastNudgeFamily) day.lastNudgeFamily = lastNudgeFamily
  const lastIntent = readShortString(src.lastIntent)
  if (lastIntent) day.lastIntent = lastIntent
  if (Array.isArray(src.events)) {
    day.events = src.events
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(-50)
  }
  return day
}

/** 超过这个时长没有任何新主动消息，视为上一轮“未回试探”已结束，重新开始计数 */
export const UNANSWERED_EPISODE_RESET_MS = 6 * 60 * 60 * 1000

/** 最后一轮主动消息是否已超过 6 小时；是则新一轮应从 0 计数，并清掉旧 sentTimes */
export function isUnansweredEpisodeStale(day: ProactiveDayState, now?: number): boolean {
  if (typeof now !== 'number' || !Number.isFinite(now)) return false
  const lastProactiveAt = finiteTime(day.lastProactiveAt) ?? finiteTime(day.lastActiveAt) ?? 0
  const sentTimes = sanitizeTimeList(day.sentTimes)
  const lastSentAt = Math.max(lastProactiveAt, ...sentTimes)
  return lastSentAt > 0 && now - lastSentAt >= UNANSWERED_EPISODE_RESET_MS
}

/**
 * 未回复计数 = 用户最后一次互动之后又发了多少条主动消息。
 * 先看 state.lastInteractionAt 与 day.lastProactiveAt：互动不早于最后一次发送说明用户回过，
 * 直接清零；否则按 day.sentTimes 数（跨天沿用）。没有 sentTimes 的旧数据用 unansweredCount /
 * activeSent 兜底，保证升级后行为连续。
 *
 * now 传入时：最后一次发送已超过 6 小时则重新开一轮，避免用户长时间没回后
 * 被历史计数永久卡在 unanswered-backoff（主动消息再也不发）。
 */
export function resolveUnansweredCount(
  day: ProactiveDayState,
  state: Pick<CharacterState, 'lastInteractionAt'>,
  now?: number
): number {
  const lastInteractionAt = finiteTime(state?.lastInteractionAt) ?? 0
  const lastProactiveAt = finiteTime(day.lastProactiveAt) ?? finiteTime(day.lastActiveAt) ?? 0
  if (lastInteractionAt > 0 && lastInteractionAt >= lastProactiveAt) return 0
  if (isUnansweredEpisodeStale(day, now)) return 0
  const sentTimes = sanitizeTimeList(day.sentTimes)
  if (sentTimes.length > 0) {
    return Math.min(99, sentTimes.filter((at) => at > lastInteractionAt).length)
  }
  const stored = countValue(day.unansweredCount, 99)
  if (stored !== undefined && stored > 0) return stored
  if (lastProactiveAt <= 0) return 0
  return Math.min(99, Math.max(1, Math.round(day.activeSent ?? 1)))
}

function countValue(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(max, Math.round(value)))
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readShortString(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 40) : ''
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// 关系试探（未回 1 才允许一次；family/48h/同日/连续四条闸）
// ---------------------------------------------------------------------------

export type NudgeFamily = 'companion' | 'sister' | 'lover'
export type NudgeBlockReason =
  | 'not-single-unanswered'
  | 'consecutive'
  | 'same-family-48h'
  | 'same-day'

export const NUDGE_TEMPLATES: Record<NudgeFamily, string[]> = {
  lover: ['在忙吗？我想你了', '人呢，怎么不理我'],
  companion: ['在干嘛呢', '忙完了吗？'],
  sister: ['在忙吗？', '人呢？']
}

export interface NudgeGate {
  allowed: boolean
  family: NudgeFamily
  reason?: NudgeBlockReason
}

function resolveNudgeFamily(mode: string): NudgeFamily {
  if (mode === 'lover') return 'lover'
  if (mode === 'sister') return 'sister'
  return 'companion'
}

/** 未回 1 才允许轻试探；同 family 48h 内、同一天最多 1 次、不许连续试探 */
export function decideNudge(options: {
  mode: CharacterSettings['relationship']['mode'] | string
  day: ProactiveDayState
  now: number
  unansweredCount: number
}): NudgeGate {
  const family = resolveNudgeFamily(options.mode)
  const deny = (reason: NudgeBlockReason): NudgeGate => ({ allowed: false, family, reason })
  if (Math.round(options.unansweredCount) !== 1) return deny('not-single-unanswered')
  if (options.day.lastIntent === 'nudge') return deny('consecutive')
  const lastNudgeAt = finiteTime(options.day.lastNudgeAt)
  if (lastNudgeAt !== undefined) {
    if (
      options.day.lastNudgeFamily === family &&
      options.now - lastNudgeAt < NUDGE_SAME_FAMILY_MS
    ) {
      return deny('same-family-48h')
    }
    if (localDateKey(lastNudgeAt) === localDateKey(options.now)) return deny('same-day')
  }
  return { allowed: true, family }
}

// ---------------------------------------------------------------------------
// 候选生成
// ---------------------------------------------------------------------------

export interface ProactiveCandidate {
  text: string
  intent: ProactiveIntent
  /** 来源 id：生活卡/话题卡 id、台词组名、试探 family；用于跨轮去重 */
  sourceId: string
  weight: number
}

export interface ContentEngineOptions {
  settings: CharacterSettings
  state: CharacterState
  day: ProactiveDayState
  /** 话题/台词内容包；缺省只用生活卡模板 */
  deck?: ContentDeck
  /** 今天的「她的一天」卡（最多取前 3 张） */
  cards?: LifeCard[]
  now: number
  /** 候选目标条数，夹到 2–10（默认 6） */
  candidateCount?: number
  /** 调用方已算好的未回条数；缺省从 day/state 推导 */
  unansweredCount?: number
  /** backoff 阈值（默认 3；测试可放宽到 2） */
  backoffThreshold?: number
  rng?: () => number
  /** 台词组白名单（缺省按当前时段挑） */
  lineGroups?: string[]
  /** 最近真实聊天（用户/她），用于话题亲和与敏感话题触发 */
  recentChat?: string
}

export interface ProactiveContentResult {
  /** false = 本轮不发送（未回 backoff / 没有可用内容） */
  send: boolean
  reason?: 'unanswered-backoff' | 'no-content'
  /** 本轮候选池（2–10 条，已去重、按 intent 交错） */
  candidates: ProactiveCandidate[]
  chosen: ProactiveCandidate | null
  message: string
  unansweredCount: number
  nudge: NudgeGate
}

export function generateProactiveContent(options: ContentEngineOptions): ProactiveContentResult {
  const rng = options.rng ?? Math.random
  const settings = options.settings
  const day = options.day ?? {}
  const state = options.state
  const deck = options.deck ?? createEmptyContentDeck()
  const cards = Array.isArray(options.cards) ? options.cards : []
  const unansweredCount =
    typeof options.unansweredCount === 'number' && Number.isFinite(options.unansweredCount)
      ? Math.max(0, Math.round(options.unansweredCount))
      : resolveUnansweredCount(day, state, options.now)
  const backoffThreshold = clampInteger(
    options.backoffThreshold ?? PROACTIVE_BACKOFF_THRESHOLD,
    1,
    99
  )
  const nudge = decideNudge({
    mode: settings.relationship.mode,
    day,
    now: options.now,
    unansweredCount
  })

  if (unansweredCount >= backoffThreshold) {
    return {
      send: false,
      reason: 'unanswered-backoff',
      candidates: [],
      chosen: null,
      message: '',
      unansweredCount,
      nudge
    }
  }

  const address = resolveAddress(settings)
  const recentTexts = sanitizeTextList(day.recentSentTexts)
  const recentTopics = sanitizeStringList(day.recentTopics, RECENT_TOPIC_LIMIT)
  const lastIntent = readShortString(day.lastIntent)

  let normal: ProactiveCandidate[] = [
    ...buildLifeCandidates(cards, address),
    ...buildTopicCandidates(
      deck.topics,
      address,
      recentTopics,
      slotForHour(options.now),
      options.recentChat ?? '',
      seasonForNow(options.now)
    ),
    ...buildLineCandidates(deck.lines, address, options.now, rng, options.lineGroups)
  ]
  const followUp = buildRecentChatFollowUp(options.recentChat ?? '')
  if (followUp) normal = [followUp, ...normal]

  // 未回 ≥2：不再试探，必须换话题/问别的事（话题卡够用就只留话题卡）
  if (unansweredCount >= 2) {
    const topicOnly = normal.filter((candidate) => candidate.intent === 'topic')
    if (topicOnly.length > 0) normal = topicOnly
  }

  // 连续 intent 不重复；去掉上次 intent 后不够 2 条时再放回（生活卡-only 时不能断更）
  let pool = normal.filter((candidate) => candidate.intent !== lastIntent)
  if (pool.length < PROACTIVE_MIN_CANDIDATES) pool = normal
  if (nudge.allowed) {
    const nudgeCandidates = buildNudgeCandidates(nudge.family)
    if (nudgeCandidates.length > 0) {
      pool = [...nudgeCandidates, ...pool.filter((candidate) => candidate.intent !== 'nudge')]
    }
  }

  const filtered: ProactiveCandidate[] = []
  for (const candidate of pool) {
    const text = candidate.text.trim()
    if (!text) continue
    if (findDuplicateMessage(text, recentTexts).duplicate) continue
    if (candidate.intent === 'topic' && recentTopics.includes(candidate.sourceId)) continue
    // 同轮候选之间也不能近似重复，否则「2–10 条」只是同一句换标点
    if (filtered.some((accepted) => isDuplicateMessage(text, [accepted.text]))) continue
    filtered.push({ ...candidate, text })
  }

  if (filtered.length === 0) {
    return {
      send: false,
      reason: 'no-content',
      candidates: [],
      chosen: null,
      message: '',
      unansweredCount,
      nudge
    }
  }

  const candidates = interleaveCandidates(filtered, rng, resolveCandidateCount(options.candidateCount))
  const nudgeCandidate = nudge.allowed
    ? candidates.find((candidate) => candidate.intent === 'nudge') ?? null
    : null
  // 未回 1：优先把这次机会用在关系试探上；其余轮次从候选池里随机挑（避免固定顺序）
  const chosen =
    nudgeCandidate ?? candidates[Math.min(candidates.length - 1, Math.floor(clamp01(rng()) * candidates.length))]
  return {
    send: true,
    candidates,
    chosen,
    message: chosen.text,
    unansweredCount,
    nudge
  }
}

function resolveCandidateCount(value: unknown): number {
  const count = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : PROACTIVE_DEFAULT_CANDIDATES
  return clampInteger(count, PROACTIVE_MIN_CANDIDATES, PROACTIVE_MAX_CANDIDATES)
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(0.999999, Math.max(0, value))
}

/** 生活卡：hook 只作为素材，必须和动作/心情/目标/称呼组合，避免整条就是一句 hook */
function buildLifeCandidates(cards: LifeCard[], address: string): ProactiveCandidate[] {
  const out: ProactiveCandidate[] = []
  for (const card of cards.slice(0, 3)) {
    if (!card || typeof card.activity !== 'string' || !card.activity) continue
    const activity = card.activity.trim()
    const hook = (card.hook || activity).trim()
    const mood = (card.mood || '平静').trim()
    const goal = typeof card.goal === 'string' ? card.goal.trim() : ''
    const weight = typeof card.weight === 'number' && card.weight > 0 ? card.weight : 1
    // 第一条不要 activity+hook 硬拼（如「（睡到很晚）本鱼今天起晚了」），
    // 直接说 hook 更像人在聊天；活动/心情放到后面模板里。
    out.push({ text: hook, intent: 'life', sourceId: card.id, weight })
    out.push({
      text: `${hook}——${address}今天怎么样？`,
      intent: 'life',
      sourceId: card.id,
      weight
    })
    out.push({
      text: `今天${activity}，${mood}。${address}呢？`,
      intent: 'life',
      sourceId: card.id,
      weight
    })
    if (goal) {
      out.push({
        text: `本鱼今天想${goal}，${address}要不要监督本鱼？`,
        intent: 'life',
        sourceId: card.id,
        weight: weight * 0.9
      })
    }
  }
  return out
}

/** 最近聊天关键词 → 话题亲和（命中则提高该话题权重） */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  'topic-food': ['吃', '饭', '饿', '白饭', '外卖', '食堂'],
  'topic-slack': ['摸鱼', '偷懒', '老板', '上班', '工作'],
  'topic-work': ['工作', '项目', '加班', '甲方', '老板', '公司'],
  'topic-night': ['熬夜', '睡不着', '晚', '困', '睡'],
  'topic-weather': ['天气', '下雨', '太阳', '热', '冷'],
  'topic-game': ['游戏', '打游戏', '开黑', '番', '动漫'],
  'topic-music': ['歌', '音乐', '耳机', '听歌'],
  'topic-praise': ['可爱', '夸', '好看', '喜欢'],
  'topic-neglect': ['没来', '忙', '忘', '回得慢', '不理'],
  'topic-relationship': ['关系', '称呼', '算什么', '喜欢'],
  'topic-dream': ['以后', '未来', '愿望', '想干嘛'],
  'topic-live': ['直播', '上班', '工钱', '打工'],
  'topic-sick': ['生病', '感冒', '头疼', '胃', '不舒服', '药'],
  'topic-trip': ['出差', '旅行', '出门', '高铁', '飞机', '酒店'],
  'topic-birthday': ['生日', '礼物', '蛋糕'],
  'topic-festival': ['节日', '过年', '春节', '中秋', '圣诞', '元旦'],
  'topic-fight': ['吵架', '凶', '生气', '对不起', '冷战'],
  'topic-dress': ['发绳', '衣服', '打扮', '好看', '样子'],
  'topic-photo': ['拍照', '照片', '合照', '截图'],
  'topic-movie': ['电影', '剧', '看剧', '恐怖片'],
  'topic-morning': ['早', '起床', '醒', '闹钟'],
  'topic-coffee': ['咖啡', '提神', '困'],
  'topic-lunch': ['午饭', '中午', '吃饭'],
  'topic-weekend': ['周末', '放假', '休息'],
  'topic-hot': ['热', '空调', '风扇', '夏天'],
  'topic-exercise': ['运动', '跑步', '散步', '步数'],
  'topic-sleep': ['睡', '失眠', '熬夜', '几点睡'],
  'topic-cat': ['猫', '宠物', '小动物'],
  'topic-meme': ['梗', '表情包', '好笑', '段子'],
  'topic-clean': ['收拾', '房间', '乱'],
  'topic-laundry': ['洗衣服', '晾衣服', '洗衣机'],
  'topic-grocery': ['超市', '买菜', '购物车'],
  'topic-cook': ['做饭', '下厨', '厨房', '菜'],
  'topic-shop': ['快递', '网购', '购物车', '买'],
  'topic-money': ['工资', '钱', '省钱', '工钱'],
  'topic-study': ['学习', '看书', '书', '考试'],
  'topic-news': ['新闻', '热搜', '网上'],
  'topic-travel': ['旅行', '海边', '出门', '去哪'],
  'topic-summer': ['夏天', '热', '风扇', '冰'],
  'topic-hobby': ['爱好', '小玩意', '攒', '玩什么']
}

/** 这些话题容易冒犯/不搭：只有最近聊天明确提到才发 */
const SENSITIVE_TOPIC_KEYWORDS: Record<string, string[]> = {
  'topic-sick': TOPIC_KEYWORDS['topic-sick'],
  'topic-trip': TOPIC_KEYWORDS['topic-trip'],
  'topic-birthday': TOPIC_KEYWORDS['topic-birthday'],
  'topic-festival': TOPIC_KEYWORDS['topic-festival'],
  'topic-fight': TOPIC_KEYWORDS['topic-fight'],
  'topic-neglect': TOPIC_KEYWORDS['topic-neglect']
}

function buildTopicCandidates(
  deck: TopicDeck,
  address: string,
  recentTopics: string[],
  slot: TopicSlot,
  recentChat: string,
  season: Season
): ProactiveCandidate[] {
  const recent = new Set(recentTopics)
  const chat = recentChat.trim()
  const out: ProactiveCandidate[] = []
  for (const topic of deck?.topics ?? []) {
    if (topic.slots.length > 0 && !topic.slots.includes(slot)) continue
    // 季节受限的卡（如夏天话题）在非当季直接跳过；seasons 为空的老卡全年可用
    if (topic.seasons.length > 0 && !topic.seasons.includes(season)) continue
    // 同一 topic 7 天窗口内尽量不重复：直接用最近使用过的 id 排除
    if (recent.has(topic.id)) continue
    const keywords = TOPIC_KEYWORDS[topic.id] ?? [topic.title]
    const mentioned = Boolean(chat) && keywords.some((word) => chat.includes(word))
    // 生病/吵架/出差/生日/节日/被冷落：没有最近聊天触发就不要硬问，避免前后不搭
    if (SENSITIVE_TOPIC_KEYWORDS[topic.id] && !mentioned) continue
    const affinity = mentioned ? 1.8 : 1
    const detail = topic.details[0] ?? ''
    const hook = topic.hooks[0] ?? ''
    const hook2 = topic.hooks[1] ?? ''
    if (topic.sample) {
      out.push({
        text: fillAddress(topic.sample, address),
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.15 * affinity
      })
    }
    // details 是「设定碎片」不是完整句子，不能和 hook 硬拼
    // （会出现「新发绳执念。新发绳好看吗？」这种读不懂的拼接）；优先用 sample/hook。
    if (hook) {
      out.push({
        text: `${speechLead(address)}${asSpeech(fillAddress(hook, address))}`,
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.3 * affinity
      })
    } else if (detail) {
      out.push({
        text: `（${topic.title}）${fillAddress(detail, address)}。`,
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.1 * affinity
      })
    }
    if (hook2) {
      out.push({
        text: asSpeech(fillAddress(hook2, address)),
        intent: 'topic',
        sourceId: topic.id,
        weight: 1 * affinity
      })
    }
  }
  return out
}

/** 最近一条用户聊天做“接话”候选：只有具体内容才追问，避免「在吗」也被接成一句 */
function buildRecentChatFollowUp(recentChat: string): ProactiveCandidate | null {
  const lines = recentChat
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('用户：'))
  const last = lines.length > 0 ? lines[lines.length - 1].slice('用户：'.length).trim() : ''
  if (last.length < 6 || last.length > 60) return null
  if (/^(在吗|在不在|你好|嗨|hi|hello|嗯|哦|好)[呀啊]?$/i.test(last)) return null
  if (!/[\u4e00-\u9fa5]{4,}/.test(last)) return null
  const quote = last.replace(/[。！？!?…~～]+$/g, '').replace(/\s+/g, ' ').slice(0, 40)
  if (!quote) return null
  return {
    text: `你刚才说「${quote}」，后来呢？`,
    intent: 'line',
    sourceId: 'recent-chat',
    weight: 1.2
  }
}

/** 称呼在句首：默认「你」用「诶，」更自然，避免「你，新发绳好看吗？」 */
function speechLead(address: string): string {
  const text = address.trim()
  return !text || text === '你' ? '诶，' : `${text}，`
}

/** hooks 有陈述句也有问句；按语气词/疑问词补标点，不能一律加问号 */
/** 与 life.ts 的 slotForHour 同口径；内容引擎保持纯逻辑，不 import 宿主 */
function slotForHour(now: number): TopicSlot {
  const hour = new Date(now).getHours()
  if (hour < 10) return 'morning'
  if (hour < 13) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

function asSpeech(text: string): string {
  const value = text.trim()
  if (!value) return value
  if (/[。！？!?…~～]$/.test(value)) return value
  const isQuestion =
    /吗|呢|吧$|嘛|干嘛|什么|怎么|为什么|是不是|有没有|多少|几|要不要|热不热|好不好|对不对|行不行|可不可以|想不想|去不去|哪里|哪儿|谁|哪$|没$/.test(
      value
    )
  return `${value}${isQuestion ? '？' : '。'}`
}

function buildLineCandidates(
  deck: LineDeck,
  address: string,
  now: number,
  rng: () => number,
  groups?: string[]
): ProactiveCandidate[] {
  const wanted = Array.isArray(groups) && groups.length > 0 ? groups : lineGroupsForNow(now)
  const out: ProactiveCandidate[] = []
  for (const group of wanted) {
    const list = deck?.groups?.[group]
    if (!Array.isArray(list) || list.length === 0) continue
    const start = Math.floor(clamp01(rng()) * list.length) % list.length
    for (let i = 0; i < Math.min(2, list.length); i += 1) {
      const line = list[(start + i) % list.length]
      if (typeof line !== 'string' || !line.trim()) continue
      out.push({
        text: fillAddress(line.trim(), address),
        intent: 'line',
        sourceId: group,
        weight: 1
      })
    }
  }
  return out
}

const ALWAYS_LINE_GROUPS = ['proactive', 'miss', 'greeting', 'care', 'memory']

/** 台词组按当前时段挑，避免早上发「睡吧」、深夜发「早」 */
function lineGroupsForNow(now: number): string[] {
  const hour = new Date(now).getHours()
  const groups = [...ALWAYS_LINE_GROUPS]
  if (hour >= 5 && hour < 11) groups.push('morning')
  if (hour >= 21 || hour < 2) groups.push('night')
  if ((hour >= 6 && hour < 10) || (hour >= 11 && hour < 14) || (hour >= 17 && hour < 20)) {
    groups.push('food')
  }
  if (hour >= 9 && hour < 19) groups.push('work')
  return groups
}

function buildNudgeCandidates(family: NudgeFamily): ProactiveCandidate[] {
  const templates = NUDGE_TEMPLATES[family] ?? NUDGE_TEMPLATES.companion
  return templates.map((text, index) => ({
    text,
    intent: 'nudge',
    sourceId: family,
    weight: 2.5 - index * 0.2
  }))
}

/**
 * 按 intent 交错取候选，保证内容池「生活卡 + 话题 + 台词」都露面；
 * 每组内部用 rng×权重打散，既随机又不至于全是低权重来源。
 */
function interleaveCandidates(
  pool: ProactiveCandidate[],
  rng: () => number,
  target: number
): ProactiveCandidate[] {
  const buckets: ProactiveCandidate[][] = []
  for (const intent of INTENT_ORDER) {
    const bucket = pool.filter((candidate) => candidate.intent === intent)
    if (bucket.length === 0) continue
    const scored = bucket
      .map((candidate) => ({
        candidate,
        score: clamp01(rng()) * Math.max(0.1, candidate.weight)
      }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.candidate)
    buckets.push(scored)
  }
  const out: ProactiveCandidate[] = []
  let index = 0
  while (out.length < target) {
    let picked = false
    for (const bucket of buckets) {
      const candidate = bucket[index]
      if (!candidate) continue
      out.push(candidate)
      picked = true
      if (out.length >= target) break
    }
    if (!picked) break
    index += 1
  }
  return out
}
