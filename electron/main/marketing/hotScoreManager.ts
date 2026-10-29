// hotScoreManager.ts —— 热点 AI 商家匹配（PLAN-2.0.md Commit 12）
//
// 契约（§七 Commit 12 / v1.8-v1.12 热点口径 / §五 marketing:hot:score / 硬规则 8、9、10）：
//   - **懒评分、按 Project × 发布平台缓存**：只对当前 project + platform 近 7 天在榜的
//     board 热点评分，结果落 project_hot_topics（02 已建表，12 不加列）；同一热点两平台
//     各一行（平台适配度必须分别判，防抖音源热点在小红书虚高适配）。
//   - **每批 ≤30 条**，待评超 30 按 heat/rank 取前 30，由渲染端打开雷达时续批评完；
//     **24h TTL** 内不重评，只有手动重新分析（force）才无视 TTL。force 在内存里记一道
//     「水位」：首批只评 30，续批虽改回非 force，水位之前的旧分仍 stale，保证整榜真重评；
//     remaining 一律在落库后按真实 stale 数重算（模型漏回/非法条目计入，续批不会提前终止）。
//   - 热点表与 Context Pack 按 pid|平台 短 TTL（60s）缓存，续批期间不全表扫/不重建 Pack。
//   - **部分失败容错**：模型一次返回里个别条目坏，成功条目照常落库、坏条目留下批重试；
//     **整次调用失败**（Gateway 错误 / 整包 JSON 不可解析 / 全条目非法）直接抛错信封，
//     渲染端降级为裸榜（未评分热点照常浏览，不阻塞 11 的任何功能）。
//   - **事实护栏**：评分只能依据 Context Pack 里的商家资料，资料没有的关联宁给低分并在
//     reason 写「资料不足」；热点情报永不自动入知识库（v1.9），本模块也不写评分外的表。
//   - **不 import electron、不发裸 HTTP**：出站一律走注入的 07 GatewayClient
//     （**走 SSE 但逐帧拼完整 JSON**——30 条/批的输出量大，非流式有 120s 整体超时，
//     真网实测会整批超时导致续批永不启动；流式只有 chunk 间空闲超时，模型边写边保活），
//     DB 一律走 Worker（硬规则 8）。评分用独立会话键，不进 Advisor 的 sticky 对话历史。
//   - 与 11 的边界：hotManager 管采集/读榜（不碰 AI），本模块只评分/写缓存；listRadar
//     的 LEFT 关联会自动读到这里写的分数，渲染端评分后 skipCollect 重读即可看到分组。

import { AppError, ERROR_CODES } from '../database/errors'
import { extractJsonArray } from './jsonExtract'
import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '../database/database'
import type { ContextEngine, Platform } from './contextEngine'
import { renderContextPackText } from './contextEngine'
import { PLATFORM_LABELS, renderPackRuleSection } from './platformRules'
import type { GatewayClient, GatewayChatMessage, GatewayStreamDelta } from '../gatewayClient'
import type { HotTopicRow } from './hotManager'
import { listAllRows, compareHeatRank } from './hotShared'

// ── 常量（v1.8/v1.9/v1.11 钉死） ──────────────────────────────────────────────

/** 单次模型调用最多评分条数（v1.8：≤30 条/次） */
export const SCORE_BATCH_SIZE = 30
/** 评分缓存 TTL：24 小时（v1.9：期内不重评，仅手动重算或落榜重现才重评） */
export const SCORE_TTL_MS = 24 * 60 * 60 * 1000
/** 评分候选窗：仅评近 7 天在榜（v1.8），与雷达展示窗（24h/3d/7d 可切）相互独立 */
export const SCORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** 今日建议只从雷达 24h 窗口里挑（当天建议必须还在榜） */
export const SUGGESTION_WINDOW_MS = 24 * 60 * 60 * 1000
/** 热点表/Context Pack 短缓存 TTL：一轮续批（秒级~分钟级）内复用，到期重读重建 */
const SCORE_CACHE_TTL_MS = 60 * 1000
/** 三档阈值（v1.11：双门槛，防高相关低适配误推） */
export const TIER_HOT_MIN = 70
export const TIER_WATCH_MIN = 40
/** 模型文本字段入库长度上限（防脏输出超长） */
const REASON_MAX_CHARS = 200
const ANGLE_MAX_CHARS = 300
const ADVICE_MAX_CHARS = 300

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface HotScoreRow {
  project_id: string
  topic_id: string
  platform: string
  match_score: number | null
  platform_fit: number | null
  reason: string | null
  content_angle: string | null
  lifecycle_advice: string | null
  scored_at: number
}

/** marketing:hot:score 单批结果 */
export interface HotScoreBatchResult {
  /** 本批实际落库条数 */
  scored: number
  /** 模型返回但被本地校验丢弃的条目数（留下批重试） */
  failed: number
  /** 近 7 天在榜的候选总数 */
  total: number
  /** 本批之后仍待评（含 TTL 过期）条数；0 = 这个 project×平台评完了 */
  remaining: number
  /** 本次是否强制重评 */
  forced: boolean
  /** 评分后即时计算的「今日建议」（无合格推荐时为 null） */
  suggestion: HotTodaySuggestion | null
}

export interface HotTodaySuggestion {
  topicId: string
  title: string
  sourcePlatform: string
  url: string | null
  lifecycle: string | null
  matchScore: number
  platformFit: number
  reason: string
  timing: string
}

export interface HotScoreManagerOptions {
  database: DatabaseClient
  contextEngine: Pick<ContextEngine, 'buildContextPack'>
  gateway: Pick<GatewayClient, 'createChatStream'>
  logger?: (message: string) => void
  now?: () => number
  batchSize?: number
  ttlMs?: number
  scoreWindowMs?: number
  /** 热点表/Context Pack 缓存 TTL（默认 60s）；显式 0 关闭（冻结时钟的测试用） */
  cacheTtlMs?: number
}

interface ScoredTopic extends HotTopicRow {
  score: HotScoreRow | null
}

/** pid|平台 维度的短缓存：续批期间热点表与 Context Pack 只取/建一次（复审 7） */
interface HotScoreCacheEntry {
  at: number
  topics: HotTopicRow[]
  pack: Awaited<ReturnType<ContextEngine['buildContextPack']>> | null
}

// ── 纯函数（可单测/静态断言） ─────────────────────────────────────────────────

/** v1.11 四档：hot 双门槛 / watch 任一 40-69 / skip 均 <40 / null=待分析 */
export type HotTier = 'hot' | 'watch' | 'skip' | 'pending'
export function scoreTier(match: number | null | undefined, fit: number | null | undefined): HotTier {
  if (typeof match !== 'number' || typeof fit !== 'number') return 'pending'
  if (match >= TIER_HOT_MIN && fit >= TIER_HOT_MIN) return 'hot'
  if (match < TIER_WATCH_MIN && fit < TIER_WATCH_MIN) return 'skip'
  return 'watch'
}

/** 0-100 整数化；越界/非数/NaN 一律 null（调用方据此丢弃该条） */
export function coerceScore(value: unknown): number | null {
  if (typeof value === 'string' && value.trim()) value = Number(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const v = Math.round(value)
  if (v < 0 || v > 100) return null
  return v
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  return v.length > max ? v.slice(0, max) : v
}

/**
 * 从模型输出抽 JSON 数组文本（裸数组 / markdown 围栏 / 解释文字里夹数组均可）。
 * 实现收在 jsonExtract.ts：平衡扫描，解释文字里带方括号也不会切错（与 08/09 同口径）。
 */
export { extractJsonArray } from './jsonExtract'

interface ParsedScoreItem {
  idx: number
  match: number
  fit: number
  reason: string | null
  angle: string | null
  advice: string | null
}

/**
 * 解析+校验一批模型评分。成功条目映射到候选下标；坏条目（idx 越界/重复/分数非法）
 * 计入 failed 丢弃，留下批重试；数组整体不可解析抛 VALIDATION_ERROR（整次失败）。
 */
export function parseScoreItems(raw: string, batchSize: number): { items: ParsedScoreItem[]; failed: number } {
  const jsonText = extractJsonArray(raw)
  if (!jsonText) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '热点评分返回不是 JSON 数组', { reason: 'score-unparsable' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '热点评分 JSON 解析失败', { reason: 'score-unparsable' })
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '热点评分返回不是数组', { reason: 'score-unparsable' })
  }
  const items: ParsedScoreItem[] = []
  const seen = new Set<number>()
  let failed = 0
  for (const entry of parsed) {
    const obj = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    const idx = coerceScore(obj?.idx)
    if (idx === null || idx < 0 || idx >= batchSize || seen.has(idx)) {
      failed += 1
      continue
    }
    const match = coerceScore(obj?.match_score)
    const fit = coerceScore(obj?.platform_fit)
    if (match === null || fit === null) {
      failed += 1
      continue
    }
    seen.add(idx)
    items.push({
      idx,
      match,
      fit,
      reason: cleanText(obj?.reason, REASON_MAX_CHARS),
      angle: cleanText(obj?.content_angle, ANGLE_MAX_CHARS),
      advice: cleanText(obj?.lifecycle_advice, ADVICE_MAX_CHARS)
    })
  }
  return { items, failed }
}

/** 跟发时机：优先用模型给的 lifecycle_advice，缺失时按本地生命周期阶段兜底 */
export function timingFor(lifecycleAdvice: string | null, lifecycle: string | null): string {
  if (lifecycleAdvice) return lifecycleAdvice
  switch (lifecycle) {
    case 'breaking':
    case 'rising':
      return '热度正在上升，建议 24 小时内跟发'
    case 'peak':
      return '正在高热在榜，越早跟发越好'
    case 'new':
      return '刚上榜，可先发轻量内容试水'
    case 'long_tail':
      return '热度已在回落，如要跟请尽快'
    default:
      return '结合商家排期尽快跟进'
  }
}

/**
 * 今日建议：24h 窗口内 hot 档（双 ≥70）取 (match+fit) 最高，平分看 heat/rank；
 * 没有合格推荐返回 null（v1.12：宁缺毋滥，不硬凑）。纯函数。
 */
export function pickTodaySuggestion(topics: ScoredTopic[], now: number, windowMs = SUGGESTION_WINDOW_MS): HotTodaySuggestion | null {
  const since = now - windowMs
  const eligible = topics.filter(
    (t) =>
      t.origin !== 'calendar' &&
      Number(t.last_seen_at) >= since &&
      scoreTier(t.score?.match_score ?? null, t.score?.platform_fit ?? null) === 'hot'
  )
  if (!eligible.length) return null
  eligible.sort((a, b) => {
    const sa = (a.score?.match_score ?? 0) + (a.score?.platform_fit ?? 0)
    const sb = (b.score?.match_score ?? 0) + (b.score?.platform_fit ?? 0)
    if (sa !== sb) return sb - sa
    // 平分兜底与采集雷达/选批共用 compareHeatRank（复审 8：排序口径只留 hotShared 一份）
    return compareHeatRank(a, b)
  })
  const picked = eligible[0]
  return {
    topicId: picked.id,
    title: picked.title,
    sourcePlatform: picked.source_platform,
    url: picked.url,
    lifecycle: picked.lifecycle,
    matchScore: picked.score?.match_score ?? 0,
    platformFit: picked.score?.platform_fit ?? 0,
    reason: picked.score?.reason || '与商家业务高度相关，且适配当前发布平台',
    timing: timingFor(picked.score?.lifecycle_advice ?? null, picked.lifecycle)
  }
}

const SOURCE_LABELS: Record<string, string> = {
  toutiao: '头条',
  bilibili: 'B站',
  douyin: '抖音',
  weibo: '微博',
  zhihu: '知乎',
  baidu: '百度',
  kuaishou: '快手',
  calendar: '节点日历'
}
const LIFECYCLE_LABELS: Record<string, string> = {
  new: '新上榜',
  rising: '上升中',
  breaking: '爆发',
  peak: '高热',
  long_tail: '降温'
}
function sourceLabelOf(platform: string): string {
  if (SOURCE_LABELS[platform]) return SOURCE_LABELS[platform]
  if (platform.indexOf('dailyhot:') === 0) return '聚合·' + platform.slice('dailyhot:'.length)
  return platform
}

function formatHeat(heat: number): string {
  if (heat >= 100000000) return (heat / 100000000).toFixed(1) + '亿'
  if (heat >= 10000) return (heat / 10000).toFixed(1) + '万'
  return String(heat)
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class HotScoreManager {
  private readonly database: DatabaseClient
  private readonly contextEngine: Pick<ContextEngine, 'buildContextPack'>
  private readonly gateway: Pick<GatewayClient, 'createChatStream'>
  private readonly logger?: (message: string) => void
  private readonly now: () => number
  private readonly batchSize: number
  private readonly ttlMs: number
  private readonly scoreWindowMs: number
  private readonly cacheTtlMs: number
  private readonly packCaches = new Map<string, HotScoreCacheEntry>()
  /** force 水位：force 调用的时间戳；续批（非 force）仍须重评水位之前的旧评分（复审 1） */
  private readonly forceWatermarks = new Map<string, number>()

  constructor(options: HotScoreManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotScoreManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotScoreManager 缺少依赖: database')
    }
    if (!options.contextEngine || typeof options.contextEngine.buildContextPack !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotScoreManager 缺少依赖: contextEngine（06）')
    }
    if (!options.gateway || typeof options.gateway.createChatStream !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotScoreManager 缺少依赖: gateway（07 createChatStream）')
    }
    this.database = options.database
    this.contextEngine = options.contextEngine
    this.gateway = options.gateway
    this.logger = options.logger
    const batch = Number(options.batchSize ?? SCORE_BATCH_SIZE)
    this.batchSize = Number.isFinite(batch) && batch > 0 && batch <= 100 ? Math.trunc(batch) : SCORE_BATCH_SIZE
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : SCORE_TTL_MS
    this.scoreWindowMs = Number(options.scoreWindowMs) > 0 ? Number(options.scoreWindowMs) : SCORE_WINDOW_MS
    // 显式 0 = 关闭缓存；缺省 60s（一轮续批内复用，热点每小时才采一轮，60s 内不会漏新热点）
    this.cacheTtlMs =
      options.cacheTtlMs === undefined ? SCORE_CACHE_TTL_MS : Math.max(0, Number(options.cacheTtlMs) || 0)
    this.now = options.now ?? (() => Date.now())
  }

  private log(message: string): void {
    this.logger?.('[hot-score] ' + message)
  }

  /**
   * 评一批（≤batchSize）。无待评条目时不调模型（零成本），只回当前今日建议。
   * 整次失败（网关/JSON 不可解析/全条目非法）直接抛错信封；个别坏条目只计 failed。
   */
  async scoreBatch(
    projectId: string,
    platformInput: string,
    options: { force?: boolean } = {}
  ): Promise<HotScoreBatchResult> {
    const pid = typeof projectId === 'string' ? projectId.trim() : ''
    if (!pid) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'scoreBatch 需要 projectId', { field: 'projectId' })
    const platform = this.normalizePlatform(platformInput)
    const force = options.force === true
    const now = this.now()

    const cacheKey = pid + '|' + platform
    // 复审 1：force 水位在续批期间有效——首批 force 只评 30，之后续批虽改回非 force，
    // 水位之前的旧评分仍算 stale，保证「重新分析」真的重评全部候选（否则 TTL 行永不再评）
    if (force) this.forceWatermarks.set(cacheKey, now)
    const watermark = this.forceWatermarks.get(cacheKey) ?? 0

    // 复审 7：热点表 + Context Pack 按 pid|平台短 TTL 复用（打开一次雷达最多 20 批，
    // 旧实现每批两次全表扫 + 每批重建 Pack）。project_hot_topics 仍每批重读——表小，
    // 且必须拿到本进程刚落库的新鲜评分来判定 stale。
    let cacheEntry = this.cacheTtlMs > 0 ? this.packCaches.get(cacheKey) : undefined
    if (!cacheEntry || now - cacheEntry.at >= this.cacheTtlMs) {
      cacheEntry = {
        at: now,
        topics: await listAllRows<HotTopicRow>(this.database, 'hot_topics'),
        pack: null
      }
      this.packCaches.set(cacheKey, cacheEntry)
    }
    const since = now - this.scoreWindowMs
    // 只评榜单热点（origin=board）；日历节点是确定要跟的备稿节点，不花评分钱
    const candidates = (Array.isArray(cacheEntry.topics) ? cacheEntry.topics : []).filter(
      (t) => t.origin !== 'calendar' && Number(t.last_seen_at) >= since
    )
    const scoreRows = await listAllRows<HotScoreRow>(this.database, 'project_hot_topics', {
      project_id: pid,
      platform
    })
    const scoreByTopic = new Map<string, HotScoreRow>()
    for (const s of Array.isArray(scoreRows) ? scoreRows : []) scoreByTopic.set(s.topic_id, s)

    const scoredTopics: ScoredTopic[] = candidates.map((t) => ({ ...t, score: scoreByTopic.get(t.id) ?? null }))
    // stale：无评分 / 超 24h TTL / 评分早于本轮 force 水位
    const isStale = (t: ScoredTopic): boolean =>
      !t.score ||
      Number(t.score.scored_at) < now - this.ttlMs ||
      (watermark > 0 && Number(t.score.scored_at) < watermark)
    const pending = scoredTopics.filter(isStale)
    const total = scoredTopics.length
    if (!pending.length) {
      return { scored: 0, failed: 0, total, remaining: 0, forced: force, suggestion: pickTodaySuggestion(scoredTopics, now) }
    }

    // v1.8：待评超批量按 heat（再 rank）取前 N，其余由渲染端续批；排序口径与采集雷达共用
    pending.sort(compareHeatRank)
    const batch = pending.slice(0, this.batchSize)

    let pack = cacheEntry.pack
    if (!pack) {
      pack = await this.contextEngine.buildContextPack(pid, { platform, task: 'hot-scoring' })
      cacheEntry.pack = pack
    }
    const messages = this.buildMessages(pack, platform, batch)

    // 走 SSE 拼完整 JSON（30 条输出量大，非流式 120s 整体超时在真网上会整批挂掉、续批永不启动；
    // 流式只有 chunk 空闲超时，模型边生成边保活）。独立会话键，不污染 Advisor 的 sticky 历史。
    // 整次失败（OPENCLAW_NOT_READY / 空闲超时 / 鉴权 / abort）由 iterator/result 原样抛出。
    const handle = this.gateway.createChatStream({
      projectId: pid,
      // 每批独立会话键：同 project×平台连续多批评分时，若同 key 会在网关侧排队/串上下文，
      // 实测第二批可等到空闲超时；评分是无状态结构化任务，一批一个 uuid
      conversationKey: 'hot-score-' + platform + '-' + randomUUID(),
      messages,
      temperature: 0.2
    })
    let streamText = ''
    // iterator 与 result 共享同一条流：先兜住迭代器错误（防 result 未被消费时泄漏
    // unhandled rejection），真错误统一由下面的 await handle.result 原样抛出
    try {
      for await (const delta of handle.iterator as AsyncIterable<GatewayStreamDelta>) {
        streamText += delta.delta
      }
    } catch {
      /* 以 result 的拒绝为准 */
    }
    const settled = await handle.result
    const parsed = parseScoreItems(settled.text || streamText, batch.length)
    if (!parsed.items.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '热点评分整批校验失败（无可用条目）', {
        reason: 'score-all-invalid',
        failed: parsed.failed
      })
    }

    // 复审 9：30 次串行 IPC 往返压成一排并发（client 多路复用；upsert 幂等且主键互不相同）
    await Promise.all(
      parsed.items.map(async (item) => {
        const topic = batch[item.idx]
        const row: HotScoreRow = {
          project_id: pid,
          topic_id: topic.id,
          platform,
          match_score: item.match,
          platform_fit: item.fit,
          reason: item.reason,
          content_angle: item.angle,
          lifecycle_advice: item.advice,
          scored_at: now
        }
        await this.database.request('project_hot_topics.upsert', { data: row })
        scoreByTopic.set(topic.id, row)
      })
    )

    const refreshed: ScoredTopic[] = scoredTopics.map((t) => ({ ...t, score: scoreByTopic.get(t.id) ?? null }))
    // 复审 3：remaining 在落库后按真实 stale 状态重算。模型漏回/非法的条目仍是 stale，
    // 必须计入 remaining——否则渲染端 remaining<=0 提前 break，坏条目本会话永远停在「待分析」
    const remaining = refreshed.filter(isStale).length
    this.log(
      'score project=' + pid + ' platform=' + platform +
      ' batch=' + parsed.items.length + ' failed=' + parsed.failed +
      ' total=' + total + ' remaining=' + remaining + (force ? ' force' : '')
    )
    return {
      scored: parsed.items.length,
      failed: parsed.failed,
      total,
      remaining,
      forced: force,
      suggestion: pickTodaySuggestion(refreshed, now)
    }
  }

  private normalizePlatform(value: string): Platform {
    const v = typeof value === 'string' ? value.trim() : ''
    if (v !== 'xiaohongshu' && v !== 'douyin') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '不支持的发布平台: ' + String(value), { field: 'platform' })
    }
    return v
  }

  /** system=护栏+商家资料+平台规则；user=编号热点清单+严格 JSON 输出契约 */
  private buildMessages(
    pack: Awaited<ReturnType<ContextEngine['buildContextPack']>>,
    platform: Platform,
    batch: ScoredTopic[]
  ): GatewayChatMessage[] {
    const system = [
      SCORE_GUARDRAILS,
      '',
      '——— 以下是这位商家的资料（评分唯一事实来源） ———',
      renderContextPackText(pack),
      '',
      '本次评分的发布平台：' + PLATFORM_LABELS[platform] + '（platform_fit 必须按该平台的内容形态判）',
      renderPackRuleSection(platform, pack.platformRule)
    ].join('\n')

    const lines = batch.map((t, idx) => {
      const heat = typeof t.heat === 'number' ? formatHeat(t.heat) : '热度暂无'
      const stage = t.lifecycle ? LIFECYCLE_LABELS[t.lifecycle] ?? t.lifecycle : '未知'
      return (
        '[' + idx + '] 标题：' + t.title +
        ' ｜来源：' + sourceLabelOf(t.source_platform) +
        ' ｜热度：' + heat +
        ' ｜当前阶段：' + stage
      )
    })
    const user = [
      '请为下面 ' + batch.length + ' 条全网热点逐条评分。只输出 JSON 数组（不要 markdown 围栏、不要解释），',
      '每个输入热点恰好一项，idx 原样带回，格式：',
      '{"idx":0,"match_score":82,"platform_fit":75,"reason":"30字内依据","content_angle":"25字内角度含形式","lifecycle_advice":"15字内时机"}',
      '资料里没有依据的关联不要脑补，相关度宁给低分，reason 写明「资料不足」。',
      '',
      '热点列表：',
      ...lines
    ].join('\n')

    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  }

}

export function createHotScoreManager(options: HotScoreManagerOptions): HotScoreManager {
  return new HotScoreManager(options)
}

const SCORE_GUARDRAILS = [
  '你是本地生活商家的热点选题分析助手。任务：依据商家资料，为每条全网热点打两个分并给出选题建议。',
  '硬规则：',
  '1. match_score（商家相关度，0-100 整数）：热点与商家的行业、产品、客群、地域的相关程度。',
  '   只能依据下面给出的商家资料判断，资料中没有依据的关联一律视为不相关，严禁脑补商家不存在的业务/价格/承诺。',
  '2. platform_fit（平台适配度，0-100 整数）：该热点做成指定发布平台内容（小红书图文或抖音口播）的适配程度。',
  '3. reason：30 字内说明打分依据，必须引用商家资料中的具体事实（行业/产品/客群/地域/风格）；',
  '   资料不足以判断相关度时，分数给低并在 reason 开头写「资料不足」。',
  '4. content_angle：25 字内给具体切入角度，必须含内容形式（图文/口播/探店/教程/清单等）。',
  '5. lifecycle_advice：15 字内给跟发时机，结合热点当前阶段（新上榜/上升中/爆发/高热/降温）。',
  '6. 三个文本字段都使用中文，简短直接，不要承诺性文案，不要编造数据，不要输出多余字段。',
  '7. 只输出紧凑单行 JSON 数组（不要换行、不要空格美化），不要任何解释、前后缀或 markdown 围栏。'
].join('\n')
