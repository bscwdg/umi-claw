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

export interface TopicCard {
  id: string
  title: string
  when: string
  stance: string
  details: string[]
  hooks: string[]
  sample: string
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
    sample
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
  const sentTimes = sanitizeTimeList(day.sentTimes)
  const lastSentAt = Math.max(lastProactiveAt, ...sentTimes)
  if (
    typeof now === 'number' &&
    Number.isFinite(now) &&
    lastSentAt > 0 &&
    now - lastSentAt >= UNANSWERED_EPISODE_RESET_MS
  ) {
    return 0
  }
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
    ...buildTopicCandidates(deck.topics, address, recentTopics),
    ...buildLineCandidates(deck.lines, address, options.now, rng, options.lineGroups)
  ]

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
    out.push({ text: `（${activity}）${hook}`, intent: 'life', sourceId: card.id, weight })
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

function buildTopicCandidates(
  deck: TopicDeck,
  address: string,
  recentTopics: string[]
): ProactiveCandidate[] {
  const recent = new Set(recentTopics)
  const out: ProactiveCandidate[] = []
  for (const topic of deck?.topics ?? []) {
    // 同一 topic 7 天窗口内尽量不重复：直接用最近使用过的 id 排除
    if (recent.has(topic.id)) continue
    const detail = topic.details[0] ?? ''
    const hook = topic.hooks[0] ?? ''
    const hook2 = topic.hooks[1] ?? ''
    if (topic.sample) {
      out.push({
        text: fillAddress(topic.sample, address),
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.4
      })
    }
    if (detail && hook) {
      out.push({
        text: `${detail}。${asQuestion(fillAddress(hook, address))}`,
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.3
      })
    } else if (hook) {
      out.push({
        text: `${address}，${asQuestion(fillAddress(hook, address))}`,
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.2
      })
    } else if (detail) {
      out.push({
        text: `（想起来）${detail}。${address}呢？`,
        intent: 'topic',
        sourceId: topic.id,
        weight: 1.1
      })
    }
    if (hook2) {
      out.push({
        text: fillAddress(hook2, address),
        intent: 'topic',
        sourceId: topic.id,
        weight: 1
      })
    }
  }
  return out
}

function asQuestion(text: string): string {
  return /[？?！!。…~～]$/.test(text) ? text : `${text}？`
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
