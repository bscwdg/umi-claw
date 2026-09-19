// hotManager.ts —— 热点采集与浏览（PLAN-2.0.md Commit 11 / 热点雷达）
//
// 契约（§七 Commit 11 / §六热点中心架构 v1.7-v1.12 / §二硬规则 8、9、12 / §四 三表 / §五 IPC）：
//   - **采集独立于 Gateway**：本模块不调 AI、不发 AI 请求；只 spawn resources/collector/index.mjs
//     （短命子进程、只 stdout JSONL），解析后经 DB Worker 落库——collector **不写库**（硬规则 8/12）。
//   - **后台只在应用运行时工作**：每分钟 tick 由主进程定时器触发，但「是否采集」按
//     \`app_meta.hot_last_fetch_at\` 时间差判断（≥60 分钟才跑），不用 setInterval 直接计时
//     （防睡眠唤醒漂移/连跑）；系统唤醒(powerResume)/打开雷达页同样看时间差。
//   - **全局热点共享**：hot_topics 无 project_id（抓一次所有商家共享）；相关性评分
//     project_hot_topics 是 Commit 12 的事，本提交不写该表，只在雷达视图里 LEFT 关联已缓存的评分。
//   - **同源内去重**（v1.9 钉死）：fingerprint = source_platform + 标题归一化
//     （去特殊符号/小写/剥前缀词）；同源同指纹 upsert 一行并追加 sample；
//     **跨平台同一事件不物理合并**（各源各一行，才能回答「哪个平台最火」）。
//   - **生命周期由采样序列计算**：首次入库 'new'；≥2 次采样按热度/名次变化判
//     rising/breaking/peak/long_tail；节点日历（heat=null）不判生命周期。
//   - **采样保留 24 条/热点**；last_seen_at 超 7 天（落榜）整行删除并级联清 samples/评分；
//     **例外（v1.11）：被 contents 引用过的热点不删**（保三期溯源地基）。
//   - 本模块**不 import electron、不发 HTTP**：collector 路径/node 路径/配置全部注入，
//     esbuild bundle 后可纯 Node 验收（test/hot.accept.mjs 打这份真源码 + 真 collector + 真 Worker）。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { listAllRows, compareHeatRank } from './hotShared'

// ── 常量（§六 / §七 Commit 11） ───────────────────────────────────────────────

/** app_meta 白名单键（§四 app_meta 注释已预留 hot_* 三键） */
export const META_LAST_FETCH_AT = 'hot_last_fetch_at'
export const META_SOURCE_STATUS = 'hot_source_status'
export const META_SOURCE_ERROR = 'hot_source_error'

/** 采集最小间隔（主进程 tick / 唤醒 / 打开页都按这个时间差判断） */
export const FETCH_INTERVAL_MS = 60 * 60 * 1000
/** collector 子进程总超时（单请求 8s 在 collector 内部；这是整轮所有源的上限） */
export const COLLECTOR_TIMEOUT_MS = 45 * 1000
/** 雷达页时间窗：近 24h 在榜 */
export const RADAR_WINDOW_MS = 24 * 60 * 60 * 1000
/** 落榜保留：last_seen_at 超过 7 天的热点删除（被内容引用的除外） */
export const STALE_TOPIC_MS = 7 * 24 * 60 * 60 * 1000
/** 每热点最多保留的采样条数 */
export const MAX_SAMPLES_PER_TOPIC = 24

/** 生命周期（§六：≥2 次采样才判趋势；首次为 new） */
export const HOT_LIFECYCLES = ['new', 'rising', 'breaking', 'peak', 'long_tail'] as const
export type HotLifecycle = (typeof HOT_LIFECYCLES)[number]

/** 热度过载翻倍且冲进前 10 = breaking；普通上涨 15% = rising；下跌 15% = long_tail；其余 peak */
const BREAKING_HEAT_MULTIPLIER = 2
const BREAKING_TOP_RANK = 10
const RISING_RATIO = 1.15
const COOLING_RATIO = 0.85

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** collector stdout 一行的形状 */
export interface CollectorSource {
  source: string
  sourcePlatform: string
  origin: 'board' | 'calendar'
  ok: boolean
  error?: string
  items?: CollectorItem[]
}

export interface CollectorItem {
  title: string
  heat: number | null
  rank: number | null
  url: string | null
  /** 稳定身份覆盖（仅节点日历用 cal:<id>；榜单忽略，指纹由标题归一化生成） */
  fid?: string | null
}

/** hot_topics 表一行 */
export interface HotTopicRow {
  id: string
  source_platform: string
  source: string
  origin: string
  title: string
  url: string | null
  fingerprint: string
  heat: number | null
  rank: number | null
  lifecycle: string | null
  first_seen_at: number
  last_seen_at: number
}

export interface HotSampleRow {
  id: string
  topic_id: string
  sampled_at: number
  heat: number | null
  rank: number | null
}

export interface SourceStatus {
  source: string
  sourcePlatform: string
  origin: 'board' | 'calendar'
  ok: boolean
  count: number
  error?: string
}

export interface HotCollectStatus {
  fetchedAt: number
  durationMs: number
  sources: SourceStatus[]
  inserted: number
  updated: number
  samples: number
  expiredDeleted: number
  topicsTotal: number
}

export interface RadarTopic extends HotTopicRow {
  score: {
    match_score: number | null
    platform_fit: number | null
    reason: string | null
    content_angle: string | null
    lifecycle_advice: string | null
    scored_at: number | null
  } | null
}

export interface RadarView {
  /** 本轮采集状态；未到间隔（跳过）时为 null，UI 读 meta 里的上次状态 */
  collected: HotCollectStatus | null
  /** 上次成功采集的状态（meta 持久化；从未采集为 null） */
  lastStatus: HotCollectStatus | null
  lastError: string | null
  board: RadarTopic[]
  calendar: RadarTopic[]
}

export interface HotManagerOptions {
  database: DatabaseClient
  /** resources/collector/index.mjs 绝对路径（dev/安装包路径解析在主进程 wiring 里做） */
  collectorScriptPath: string
  /** 运行 collector 的 node（便携 Node；与 db worker 同口径） */
  nodePath: string
  logger?: (message: string) => void
  fetchIntervalMs?: number
  collectorTimeoutMs?: number
  radarWindowMs?: number
  staleTopicMs?: number
  maxSamples?: number
  /** 每次采集前按次读取 DailyHotApi base URL（v1.22 modelsResolver 同精神：改配置无需重启） */
  getDailyhotBase?: () => string | null
  /** 额外 collector 参数/环境（验收指向本地假服务） */
  extraArgs?: string[]
  extraEnv?: Record<string, string>
  now?: () => number
}

// ── 标题归一化（同源内去重，v1.9） ────────────────────────────────────────────

/**
 * 同源内标题归一化：统一小写 → 剥榜单/平台前缀词 → 压空白 → 只保留字母数字与
 * 中日韩表意字符（去掉标点/emoji/括号等噪声）。**只用于同源指纹**，不跨平台比较。
 */
export function normalizeTitle(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/^[\s#:：|丨·•\-—]*(?:热榜|热搜|热点|榜单|话题榜|实时热点)[\s#:：]*/, '')
    .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, '')
    .replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, '')
}

/** 同源批次内的「阈值合并」：归一化后短串(≥6)被长串完整包含时视为同一条，保留信息更全的一条 */
function mergeWithinBatch(items: CollectorItem[], keyOf: (it: CollectorItem) => string): CollectorItem[] {
  const picked: CollectorItem[] = []
  for (const item of items) {
    const key = keyOf(item)
    const dup = picked.find((p) => {
      const pk = keyOf(p)
      if (!key || !pk) return false
      if (key === pk) return true
      const long = key.length >= pk.length ? key : pk
      const short = key.length >= pk.length ? pk : key
      return short.length >= 6 && long.includes(short)
    })
    if (!dup) {
      picked.push(item)
      continue
    }
    // 保留更长的标题（信息更全）；热度/名次取更显著的一方
    if (item.title.length > dup.title.length) dup.title = item.title
    if (typeof item.heat === 'number' && (dup.heat === null || item.heat > dup.heat)) dup.heat = item.heat
    if (typeof item.rank === 'number' && (dup.rank === null || item.rank < dup.rank)) dup.rank = item.rank
  }
  return picked
}

/** 由上次与本次采样推断生命周期；sampleCount<2 恒为 new；heat 缺失保持原状 */
export function classifyLifecycle(
  prevLifecycle: string | null,
  sampleCount: number,
  heatNow: number | null,
  heatPrev: number | null,
  rankNow: number | null
): HotLifecycle | null {
  if (heatNow === null) return (prevLifecycle as HotLifecycle | null) ?? null
  if (sampleCount < 2) return 'new'
  // 上一条采样缺热度（接口字段波动）不等于「新上榜」：保留既有阶段，避免把
  // rising/breaking 莫名打回 new；从未判过阶段的才落 new。
  if (typeof heatPrev !== 'number' || heatPrev <= 0) {
    return (prevLifecycle as HotLifecycle | null) ?? 'new'
  }
  if (rankNow !== null && rankNow <= BREAKING_TOP_RANK && heatNow >= heatPrev * BREAKING_HEAT_MULTIPLIER) {
    return 'breaking'
  }
  if (heatNow > heatPrev * RISING_RATIO) return 'rising'
  if (heatNow < heatPrev * COOLING_RATIO) return 'long_tail'
  return 'peak'
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class HotManager {
  private readonly database: DatabaseClient
  private readonly collectorScriptPath: string
  private readonly nodePath: string
  private readonly logger?: (message: string) => void
  private readonly fetchIntervalMs: number
  private readonly collectorTimeoutMs: number
  private readonly radarWindowMs: number
  private readonly staleTopicMs: number
  private readonly maxSamples: number
  private readonly getDailyhotBase?: () => string | null
  private readonly extraArgs: string[]
  private readonly extraEnv: Record<string, string>
  private readonly now: () => number

  private inFlight: Promise<HotCollectStatus> | null = null
  private activeChild: ChildProcess | null = null

  constructor(options: HotManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotManager 缺少依赖: database')
    }
    for (const [name, value] of [
      ['collectorScriptPath', options.collectorScriptPath],
      ['nodePath', options.nodePath]
    ] as const) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'HotManager 缺少依赖: ' + name, { field: name })
      }
    }
    this.database = options.database
    this.collectorScriptPath = options.collectorScriptPath
    this.nodePath = options.nodePath
    this.logger = options.logger
    this.fetchIntervalMs = options.fetchIntervalMs ?? FETCH_INTERVAL_MS
    this.collectorTimeoutMs = options.collectorTimeoutMs ?? COLLECTOR_TIMEOUT_MS
    this.radarWindowMs = options.radarWindowMs ?? RADAR_WINDOW_MS
    this.staleTopicMs = options.staleTopicMs ?? STALE_TOPIC_MS
    this.maxSamples = options.maxSamples ?? MAX_SAMPLES_PER_TOPIC
    this.getDailyhotBase = options.getDailyhotBase
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : []
    this.extraEnv = options.extraEnv || {}
    this.now = options.now ?? (() => Date.now())
  }

  private log(message: string): void {
    this.logger?.('[hot] ' + message)
  }

  // ── 调度入口 ─────────────────────────────────────────────────────────────

  /** 主进程每分钟 tick / 系统唤醒调用：到间隔才采集，未到返回 null（并发共用同一个 Promise） */
  async tickDue(): Promise<HotCollectStatus | null> {
    return this.collect(false)
  }

  /** 「立即刷新」：忽略时间差强制采集 */
  async refresh(): Promise<HotCollectStatus> {
    const status = await this.collect(true)
    if (!status) throw new AppError(ERROR_CODES.HOT_SOURCE_ERROR, '刷新未产出状态（不应该发生）')
    return status
  }

  /**
   * 采集一轮。force=false 时先看 app_meta 时间差；同一时刻只允许一轮
   * （single-flight：定时器、打开页面、手动刷新撞上时共用在途 Promise）。
   */
  async collect(force = false): Promise<HotCollectStatus | null> {
    if (this.inFlight) return this.inFlight
    if (!force) {
      const due = await this.isDue()
      if (!due) return null
      // await 期间可能已有定时器/打开页先开跑：复查一次，复用在途 Promise（防双采集）
      if (this.inFlight) return this.inFlight
    }
    const p = this.runCollect().finally(() => {
      if (this.inFlight === p) this.inFlight = null
    })
    this.inFlight = p
    return p
  }

  /** 应用退出时杀掉在途 collector（短命进程，正常几秒内自己结束） */
  cancelActiveCollectors(): number {
    if (!this.activeChild || this.activeChild.killed) {
      this.activeChild = null
      return 0
    }
    try {
      this.activeChild.kill()
    } catch {
      /* 尽力 */
    }
    this.activeChild = null
    return 1
  }

  private async isDue(): Promise<boolean> {
    const row = await this.database.request<{ value: string } | null>('app_meta.get', {
      keys: { key: META_LAST_FETCH_AT }
    })
    const ts = Number(row?.value)
    if (!Number.isFinite(ts) || ts <= 0) return true
    // 未来时间戳（时钟回拨）也按「到点」处理，避免被一个坏值永久卡住
    return this.now() - ts >= this.fetchIntervalMs || ts > this.now()
  }

  // ── collector 子进程 ───────────────────────────────────────────────────────

  /** spawn collector，解析 stdout JSONL；任一源失败不影响其它源（allSettled 在 collector 内） */
  private runCollector(): Promise<CollectorSource[]> {
    if (!existsSync(this.collectorScriptPath)) {
      return Promise.reject(
        new AppError(ERROR_CODES.FILE_NOT_FOUND, 'collector 脚本不存在: ' + this.collectorScriptPath, {
          path: this.collectorScriptPath
        })
      )
    }
    const args = [this.collectorScriptPath, '--timeout-ms', '8000', ...this.extraArgs]
    const base = this.getDailyhotBase ? this.getDailyhotBase() : null
    if (base && typeof base === 'string' && base.trim()) args.push('--base', base.trim())

    // 只透传必需环境（obsidian indexer 同口径：不把整包 env/密钥泄漏给子进程），
    // 验收覆盖地址走 extraEnv。
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...this.extraEnv
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(this.nodePath, args, { env, windowsHide: true, shell: false })
      } catch (e) {
        reject(new AppError(ERROR_CODES.SETUP_REQUIRED, '无法启动热点采集进程: ' + ((e as Error)?.message || e), {
          reason: 'collector-spawn-failed'
        }))
        return
      }
      this.activeChild = child
      let stdoutBuf = ''
      let stderrTail = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        try { child.kill() } catch { /* 尽力 */ }
        finish(
          new AppError(ERROR_CODES.HOT_SOURCE_ERROR, '热点采集超时（>' + this.collectorTimeoutMs + 'ms）', {
            reason: 'collector-timeout'
          })
        )
      }, this.collectorTimeoutMs)

      const finish = (err: Error | null, sources?: CollectorSource[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.activeChild === child) this.activeChild = null
        if (err) reject(err)
        else resolve(sources || [])
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
        this.log('(collector) ' + String(chunk).trim())
      })
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          finish(
            new AppError(ERROR_CODES.SETUP_REQUIRED, '未找到 Node.js 运行时，热点采集无法启动: ' + this.nodePath, {
              reason: 'node-not-found'
            })
          )
          return
        }
        finish(new AppError(ERROR_CODES.HOT_SOURCE_ERROR, '采集进程启动失败: ' + err.message))
      })
      // 用 'close' 而非 'exit'：'exit' 触发时 stdio 尾部可能尚未 flush，
      // 会间歇丢掉最后一行 JSON（表现为「未返回任何数据源」的随机失败）。
      child.on('close', (code) => {
        if (code !== 0) {
          finish(
            new AppError(ERROR_CODES.HOT_SOURCE_ERROR, 'collector 退出码 ' + code + (stderrTail ? '：' + stderrTail : ''))
          )
          return
        }
        const sources: CollectorSource[] = []
        for (const line of stdoutBuf.split(/\r?\n/)) {
          const t = line.trim()
          if (!t.startsWith('{')) continue
          try {
            const obj = JSON.parse(t) as CollectorSource
            if (obj && typeof obj.sourcePlatform === 'string' && (obj.origin === 'board' || obj.origin === 'calendar')) {
              sources.push(obj)
            }
          } catch {
            /* 非 JSON 行忽略（stdout 只应有 JSON，容错不炸整轮） */
          }
        }
        if (!sources.length) {
          finish(new AppError(ERROR_CODES.HOT_SOURCE_ERROR, 'collector 未返回任何数据源', { stderr: stderrTail }))
          return
        }
        finish(null, sources)
      })
    })
  }

  // ── 落库 ─────────────────────────────────────────────────────────────────

  private async runCollect(): Promise<HotCollectStatus> {
    const startedAt = this.now()
    if (!existsSync(this.nodePath)) {
      throw new AppError(ERROR_CODES.SETUP_REQUIRED, '便携 Node 不存在，热点采集无法启动: ' + this.nodePath, {
        reason: 'node-not-found'
      })
    }
    const sources = await this.runCollector()
    const okSources = sources.filter((s) => s.ok)
    const failedSources = sources.filter((s) => !s.ok)

    let inserted = 0
    let updated = 0
    let sampleCount = 0

    for (const source of okSources) {
      const stats = await this.persistSource(source)
      inserted += stats.inserted
      updated += stats.updated
      sampleCount += stats.samples
    }

    const expiredDeleted = await this.cleanupExpired()
    const topicsTotal = Number(
      (await this.database.request<{ count: number }>('hot_topics.count', {})).count
    )

    const status: HotCollectStatus = {
      fetchedAt: this.now(),
      durationMs: this.now() - startedAt,
      sources: sources.map((s) => ({
        source: s.source,
        sourcePlatform: s.sourcePlatform,
        origin: s.origin,
        ok: !!s.ok,
        count: s.ok ? (Array.isArray(s.items) ? s.items.length : 0) : 0,
        ...(s.ok ? {} : { error: String(s.error || 'unknown') })
      })),
      inserted,
      updated,
      samples: sampleCount,
      expiredDeleted,
      topicsTotal
    }

    if (!okSources.length) {
      // 全部源失败：**不推进 last_fetch**（允许下次 tick/打开页立即重试），只写错误状态
      await this.writeMeta(META_SOURCE_ERROR,
        '全部数据源不可用：' + failedSources.map((s) => s.source + '(' + (s.error || '?') + ')').join('；'))
      this.log('全部数据源失败，不更新 last_fetch_at')
      throw new AppError(ERROR_CODES.HOT_SOURCE_ERROR, '全部热点数据源不可用', {
        sources: status.sources
      })
    }

    await this.writeMeta(META_LAST_FETCH_AT, String(status.fetchedAt))
    await this.writeMeta(META_SOURCE_STATUS, JSON.stringify(status))
    if (failedSources.length) {
      await this.writeMeta(
        META_SOURCE_ERROR,
        '部分数据源失败：' + failedSources.map((s) => s.source + '(' + (s.error || '?') + ')').join('；')
      )
    } else {
      await this.writeMeta(META_SOURCE_ERROR, '')
    }
    this.log(
      '采集完成 +' + inserted + ' ~' + updated + ' samples=' + sampleCount +
      ' expired=' + expiredDeleted + ' total=' + topicsTotal +
      (failedSources.length ? ' failed=' + failedSources.length : '')
    )
    return status
  }

  /** 一个来源的批次落库：同源去重 → upsert 热点 → 追加 sample → 裁剪 → 生命周期 */
  private async persistSource(source: CollectorSource): Promise<{ inserted: number; updated: number; samples: number }> {
    const rawItems = Array.isArray(source.items) ? source.items : []
    const origin: 'board' | 'calendar' = source.origin === 'calendar' ? 'calendar' : 'board'
    const keyOf = (it: CollectorItem): string =>
      origin === 'calendar' ? 'cal:' + String(it.fid || normalizeTitle(it.title)) : normalizeTitle(it.title)
    const items = mergeWithinBatch(
      rawItems.filter((it) => it && String(it.title || '').trim()),
      keyOf
    )

    // 分页拉全（C1：limit 5000 截断后旧指纹走 INSERT 必撞 UNIQUE，整轮采集永久卡死）
    const existingRows = await listAllRows<HotTopicRow>(this.database, 'hot_topics', {
      source_platform: source.sourcePlatform
    })
    const byFingerprint = new Map<string, HotTopicRow>()
    for (const row of Array.isArray(existingRows) ? existingRows : []) {
      byFingerprint.set(row.fingerprint, row)
    }

    let inserted = 0
    let updated = 0
    let samples = 0
    const now = this.now()
    const seenFingerprints = new Set<string>()

    for (const item of items) {
      const fingerprint = keyOf(item)
      if (!fingerprint || fingerprint === 'cal:') continue
      seenFingerprints.add(fingerprint)
      const heatObserved = typeof item.heat === 'number' && Number.isFinite(item.heat) ? item.heat : null
      const rankObserved = typeof item.rank === 'number' && item.rank >= 1 ? Math.trunc(item.rank) : null
      const urlObserved = typeof item.url === 'string' && item.url ? item.url : null
      const existed = byFingerprint.get(fingerprint)
      let row: HotTopicRow
      let wasInserted = false

      if (existed) {
        // A3：本轮缺失的观测值不覆盖旧值（接口偶尔缺 heat/rank/url 字段，
        // 一旦写成 null，排序与生命周期趋势全被砸回未知）
        const heat = heatObserved ?? (typeof existed.heat === 'number' ? existed.heat : null)
        const rank = rankObserved ?? (typeof existed.rank === 'number' ? existed.rank : null)
        const url = urlObserved ?? existed.url
        row = (
          await this.database.request<{ row: HotTopicRow }>('hot_topics.update', {
            keys: { id: existed.id },
            data: {
              title: item.title,
              url,
              heat,
              rank,
              last_seen_at: now
            }
          })
        ).row
        byFingerprint.set(fingerprint, row)
        updated += 1
      } else {
        const payload = {
          id: randomUUID(),
          source_platform: source.sourcePlatform,
          source: source.source,
          origin,
          title: item.title,
          url: urlObserved,
          fingerprint,
          heat: heatObserved,
          rank: rankObserved,
          lifecycle: origin === 'board' ? 'new' : null,
          first_seen_at: now,
          last_seen_at: now
        }
        try {
          row = (await this.database.request<{ row: HotTopicRow }>('hot_topics.create', { data: payload })).row
          wasInserted = true
        } catch (e) {
          // C1 防线：分页之外仍有并发/异常漏网时，UNIQUE 冲突回退「按指纹查存量→更新」，不炸整轮
          if (!(e as { code?: string })?.code || (e as { code: string }).code !== 'CONFLICT') throw e
          const dup = await listAllRows<HotTopicRow>(this.database, 'hot_topics', {
            source_platform: source.sourcePlatform,
            fingerprint
          })
          const existing = dup[0]
          if (!existing) throw e
          const heat = heatObserved ?? (typeof existing.heat === 'number' ? existing.heat : null)
          const rank = rankObserved ?? (typeof existing.rank === 'number' ? existing.rank : null)
          row = (
            await this.database.request<{ row: HotTopicRow }>('hot_topics.update', {
              keys: { id: existing.id },
              data: {
                title: item.title,
                url: urlObserved ?? existing.url,
                heat,
                rank,
                last_seen_at: now
              }
            })
          ).row
          updated += 1
        }
        byFingerprint.set(fingerprint, row)
        if (wasInserted) inserted += 1
      }

      // 时间序列采样（每次见到都追加一行；落榜/趋势判定都靠它）。
      // 复查问题 1：缺测轮必须如实写 null——用旧值补一条「假采样」会让本轮
      // heatNow===heatPrev 误判 peak（上升热点被砸成高热），且 classifyLifecycle
      // 的 heatNow===null 保阶段分支永远走不到。行上的 heat/rank 沿用旧值（A3，
      // 保展示与排序），但采样序列不伪造。
      await this.database.request('hot_topic_samples.create', {
        data: { id: randomUUID(), topic_id: row.id, sampled_at: now, heat: heatObserved, rank: rankObserved }
      })
      samples += 1

      if (origin === 'board') {
        const lifecycle = await this.recomputeLifecycle(row, heatObserved, rankObserved)
        if (lifecycle && lifecycle !== row.lifecycle) {
          const updatedRow = await this.database.request<{ row: HotTopicRow }>('hot_topics.update', {
            keys: { id: row.id },
            data: { lifecycle }
          })
          byFingerprint.set(fingerprint, updatedRow.row)
        }
      }

      await this.pruneSamples(row.id)
    }

    // C3：日历源只返回当前在提前量窗口内的节点；本轮没见到的旧节点（节日已过）
    // 立即下线——把 last_seen_at 打到清理阈值之前，本轮 cleanupExpired 即收敛出 24h 雷达。
    // 被 contents 引用的节点同样享受 v1.11 豁免（溯源不断，只是不再上雷达）。
    if (origin === 'calendar') {
      const expiredAt = this.now() - this.staleTopicMs - 1
      for (const old of existingRows) {
        if (seenFingerprints.has(old.fingerprint)) continue
        if (Number(old.last_seen_at) <= expiredAt) continue
        await this.database.request('hot_topics.update', {
          keys: { id: old.id },
          data: { last_seen_at: expiredAt }
        })
      }
    }
    return { inserted, updated, samples }
  }

  /**
   * 按采样序列重判生命周期（复查问题 5：不再全量拉采样表）。
   * 缺测轮 heatNow=null 时直接保阶段（classify 的 null 分支），零查询；
   * 否则只取最近 3 条采样，heatPrev 取其中「本轮之前最近的一条非空热度」
   * （跳过中间缺测轮，保证一次缺测不会让趋势判定永久停摆）。
   */
  private async recomputeLifecycle(row: HotTopicRow, heatNow: number | null, rankNow: number | null): Promise<string | null> {
    if (heatNow === null) {
      return classifyLifecycle(row.lifecycle, 2, null, null, rankNow)
    }
    const { count } = await this.database.request<{ count: number }>('hot_topic_samples.count', {
      where: { topic_id: row.id }
    })
    const LOOKBACK = 3
    const samples = await this.database.request<HotSampleRow[]>('hot_topic_samples.list', {
      where: { topic_id: row.id },
      order: ['sampled_at'],
      limit: LOOKBACK,
      offset: Math.max(0, Number(count) - LOOKBACK)
    })
    const list = Array.isArray(samples) ? samples : []
    // 末条是本轮刚写入的；向前找最近的非空热度
    const earlier = list.slice(0, -1).reverse()
    const prev = earlier.find((s) => typeof s.heat === 'number')
    return classifyLifecycle(row.lifecycle, Number(count), heatNow, prev ? prev.heat : null, rankNow)
  }

  /** 每热点只留最近 maxSamples 条采样（复查问题 5：count 后只拉溢出的旧行，不全表读） */
  private async pruneSamples(topicId: string): Promise<void> {
    const { count } = await this.database.request<{ count: number }>('hot_topic_samples.count', {
      where: { topic_id: topicId }
    })
    const overflow = Number(count) - this.maxSamples
    if (overflow <= 0) return
    // 升序最前面的就是最旧行，limit=overflow 精确取待删行
    const stale = await this.database.request<HotSampleRow[]>('hot_topic_samples.list', {
      where: { topic_id: topicId },
      order: ['sampled_at'],
      limit: overflow
    })
    for (const s of Array.isArray(stale) ? stale : []) {
      await this.database.request('hot_topic_samples.delete', { keys: { id: s.id } })
    }
  }

  /** 落榜清理：last_seen_at 超 7 天删除；被 contents.source_topic_id 引用的保留（v1.11） */
  private async cleanupExpired(): Promise<number> {
    const cutoff = this.now() - this.staleTopicMs
    const all = await listAllRows<HotTopicRow>(this.database, 'hot_topics')
    const expired = (Array.isArray(all) ? all : []).filter((r) => Number(r.last_seen_at) < cutoff)
    if (!expired.length) return 0

    // 引用集合：worker 只支持等值/IS NULL、不支持列裁剪，这里取全量 contents 行
    // （含 content 正文字段，无法只读 source_topic_id；复查问题 6：α 阶段内容量级小，
    // 每小时一轮可接受；若后期内容量上万，应给 worker 加列投影或单独的引用 id 方法）。
    // C2：分页拉全——5000 截断会漏判最新内容的引用，击穿 v1.11「被引用热点不删」例外
    const contents = await listAllRows<{ source_topic_id: string | null }>(this.database, 'contents')
    const referenced = new Set(
      (Array.isArray(contents) ? contents : [])
        .map((c) => c.source_topic_id)
        .filter((v): v is string => typeof v === 'string' && !!v)
    )

    let deleted = 0
    for (const topic of expired) {
      if (referenced.has(topic.id)) continue
      await this.database.request('hot_topics.delete', { keys: { id: topic.id } }) // samples/评分随 FK 级联
      deleted += 1
    }
    return deleted
  }

  private async writeMeta(key: string, value: string): Promise<void> {
    await this.database.request('app_meta.upsert', { data: { key, value } })
  }

  // ── 读取（雷达页） ────────────────────────────────────────────────────────

  /**
   * 雷达视图：打开页时看时间差决定是否立即采集（force=true 强制），
   * 再返回近 24h 在榜热点（board）+ 当前生效的节点日历（calendar），
   * 并按 project × 发布平台 LEFT 关联 12 的缓存评分（未评分时 score=null）。
   */
  async listRadar(
    projectId: string,
    // skipCollect=true：只读库不触发采集（「立即刷新」已强制采过一轮，避免全源失败时
    // last_fetch 未推进又立刻起第二轮，双倍连打端点、按钮卡 ~90s）。
    // windowHours：雷达展示窗（v1.11：默认 24h，可切 72/168）；评分候选窗固定 7 天，与此无关。
    options: { platform?: string | null; force?: boolean; skipCollect?: boolean; windowHours?: number } = {}
  ): Promise<RadarView> {
    const pid = typeof projectId === 'string' ? projectId.trim() : ''
    if (!pid) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'listRadar 需要 projectId', { field: 'projectId' })
    }
    let platform: string | null = null
    if (options.platform !== undefined && options.platform !== null && String(options.platform).trim()) {
      platform = String(options.platform).trim()
      if (platform !== 'xiaohongshu' && platform !== 'douyin') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, '不支持的发布平台: ' + platform, { field: 'platform' })
      }
    }

    let collected: HotCollectStatus | null = null
    if (!options.skipCollect) {
      try {
        collected = await this.collect(options.force === true)
      } catch (e) {
        // 全源失败不阻塞浏览（§六：失败降级为裸榜）；错误从 meta 带给状态条
        this.log('打开雷达时采集失败，沿用库内已有热点：' + ((e as Error)?.message || e))
      }
    }

    const wh = Number(options.windowHours)
    const windowMs =
      wh === 72 || wh === 168 ? wh * 60 * 60 * 1000 : this.radarWindowMs
    const since = this.now() - windowMs
    const rows = await listAllRows<HotTopicRow>(this.database, 'hot_topics')
    const fresh = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.last_seen_at) >= since)

    const scoreWhere: Record<string, string> = { project_id: pid }
    if (platform) scoreWhere.platform = platform
    const scoreRows = await listAllRows<{
      topic_id: string
      match_score: number | null
      platform_fit: number | null
      reason: string | null
      content_angle: string | null
      lifecycle_advice: string | null
      scored_at: number
    }>(this.database, 'project_hot_topics', scoreWhere)
    const scoreByTopic = new Map<string, RadarTopic['score']>()
    for (const s of Array.isArray(scoreRows) ? scoreRows : []) {
      scoreByTopic.set(s.topic_id, {
        match_score: s.match_score ?? null,
        platform_fit: s.platform_fit ?? null,
        reason: s.reason ?? null,
        content_angle: s.content_angle ?? null,
        lifecycle_advice: s.lifecycle_advice ?? null,
        scored_at: s.scored_at ?? null
      })
    }

    const toRadar = (r: HotTopicRow): RadarTopic => ({ ...r, score: scoreByTopic.get(r.id) ?? null })

    const board = fresh.filter((r) => r.origin !== 'calendar').sort(compareHeatRank).map(toRadar)
    const calendar = fresh
      .filter((r) => r.origin === 'calendar')
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
      .map(toRadar)

    return {
      collected,
      lastStatus: await this.readLastStatus(),
      lastError: await this.readLastError(),
      board,
      calendar
    }
  }

  /** 单条热点（带去 Content Center 前的存在性预检用；不存在 → NOT_FOUND） */
  async getTopic(topicId: string): Promise<HotTopicRow> {
    const id = typeof topicId === 'string' ? topicId.trim() : ''
    if (!id) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'getTopic 需要 topicId', { field: 'topicId' })
    const row = await this.database.request<HotTopicRow | null>('hot_topics.get', {
      keys: { id },
      required: true
    })
    return row as HotTopicRow
  }

  /** 数据源状态条（不触发采集） */
  async getStatus(): Promise<{ lastStatus: HotCollectStatus | null; lastError: string | null; due: boolean }> {
    return {
      lastStatus: await this.readLastStatus(),
      lastError: await this.readLastError(),
      due: await this.isDue()
    }
  }

  private async readLastStatus(): Promise<HotCollectStatus | null> {
    const row = await this.database.request<{ value: string } | null>('app_meta.get', {
      keys: { key: META_SOURCE_STATUS }
    })
    if (!row?.value) return null
    try {
      return JSON.parse(row.value) as HotCollectStatus
    } catch {
      return null
    }
  }

  private async readLastError(): Promise<string | null> {
    const row = await this.database.request<{ value: string } | null>('app_meta.get', {
      keys: { key: META_SOURCE_ERROR }
    })
    return row?.value || null
  }
}

export function createHotManager(options: HotManagerOptions): HotManager {
  return new HotManager(options)
}
