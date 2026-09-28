// work/openclawImportManager.ts —— OpenClaw 使用记录 → 工作记录候选
//
// 日报补充来源：扫描用户今天在 OpenClaw（桌面对话 / 微信 / 飞书）的会话，
// AI 从对话中提炼「实际做了什么」→ 走 record 候选管线（硬规则 4：
// AI 产出不自动成为事实，用户确认后才进日报）。
//
// 两种模式（开关存 app_meta，不新增表）：
//   - 自动（开）：渲染端进入「新的一天」时调一次 + 定时增量扫描
//   - 手动（关）：今日页显示按钮，点击才扫描
//
// 增量水位线（app_meta，每个 agent 库各存一份，键按库路径哈希区分）：
// 上次处理到的最大消息时间；reader 只返回更新的消息。
// 模型调用 + 候选全部落库成功才推进水位——中途失败不推进，重扫靠确定性去重键兜底。
// 跨午夜补扫：失败后水位停在昨天时，reader 从昨天水位继续读（见 openclaw-reader.mjs）。
// 自动模式重试预算：任何自动失败（解析 / 读库 / 网关 / 全库不可读）按指数退避
//（10→20→40→80 分钟，最多 5 次），超限后自动轮询不再调模型，等用户手动触发——
// 防止同一批转录无限烧钱。
// 候选不重复的三重防线：
//   ① reader 严格增量（同域 created_at，无 SKEW 重读）；
//   ② 候选键锚定源消息身份（同批源消息重扫命中同键）；
//   ③ 「已提议集合」按会话键记录本水位时代已提议的条目——失败重试间隔超过
//      recordManager 的 30 分钟去重窗口、或候选已被用户确认/忽略后，不再重复提议。
// 重试预算覆盖自动模式的一切故障（解析失败 / 读库失败 / 网关异常 / 全库不可读）。
// 自动调度跑在主进程（startAutoScheduler，每 10 分钟），不依赖渲染端页面是否存活。
//
// 本模块不 import electron；reader / gateway / DB 全注入，纯 Node 可测。

import { createHash } from 'crypto'
import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import type { GatewayClient } from '../gatewayClient'
import type { RecordManager } from './recordManager'
import { dateOf } from './todoManager'

const META_AUTO = 'openclaw_import_auto'
const META_WATERMARK = 'openclaw_import_watermark'
const META_RETRY = 'openclaw_import_retry'
/** 已提议集合（app_meta）：本水位时代已提议的会话键 → 提议时间（防重复提议第三道防线） */
const META_PROPOSED = 'openclaw_import_proposed'

/** 自动模式连续解析失败的最大次数：达到后自动轮询跳过，需手动触发 */
const AUTO_RETRY_MAX = 5
/** 自动模式退避基数：第 n 次失败后等待 10min * 2^(n-1)，第 4 次失败后最长 80 分钟 */
const AUTO_BACKOFF_BASE_MS = 10 * 60_000
/** 已提议集合条目 TTL：超过后惰性清除，防止长期不成功时无限累积 */
const PROPOSED_TTL_MS = 48 * 3600_000
/** 主进程自动调度间隔 */
const AUTO_SCAN_INTERVAL_MS = 10 * 60_000

type ImportTrigger = 'manual' | 'auto'

/** reader 输出的单条会话消息 */
export interface OpenClawSessionMessage {
  ts: number
  role: 'user' | 'assistant'
  text: string
  sessionKey: string
  channel: string | null
}

/** 只读查询器（生产实现 = spawn 便携 Node 跑 resources/database/openclaw-reader.mjs） */
export type OpenClawReader = (params: {
  dbPath: string
  sinceMs: number
  dayStartMs: number
}) => Promise<{
  messages: OpenClawSessionMessage[]
  maxCreatedAt: number
  unavailable?: boolean
  /** unavailable 时的原因（库被占用/损坏/缺表等），仅用于日志 */
  reason?: string
}>

export interface ImportTodayResult {
  /** 本次扫到的新增消息条数 */
  scanned: number
  /** 实际入队候选条数（被质量门槛挡下的不计） */
  extracted: number
  /** 被质量门槛挡下的条数 */
  filtered: number
  /** 命中已有候选被覆盖更新（非新增）的条数，不计入 extracted */
  deduped: number
  candidateIds: string[]
  /** true=自动模式处于退避/上限期，本轮未调用模型（手动触发不会出现） */
  skipped?: boolean
  /** skipped 时的原因：backoff=退避等待中（会自动恢复）；exhausted=重试已耗尽（需手动） */
  skipReason?: 'backoff' | 'exhausted'
}

export interface OpenClawImportManagerOptions {
  database: DatabaseClient
  records: RecordManager
  gateway: GatewayClient
  reader: OpenClawReader
  /** OpenClaw agent 库绝对路径（可传多个，全部扫描）；或惰性解析函数（每次扫描时求值） */
  dbPath: string | string[] | (() => string | string[])
  newId?: () => string
  now?: () => number
  logger?: (message: string) => void
}

/** 单批注入 prompt 的对话文本上限；超出时切成多批分别提炼，不漏早间消息 */
const TRANSCRIPT_MAX_CHARS = 24_000

export class OpenClawImportManager {
  private readonly database: DatabaseClient
  private readonly records: RecordManager
  private readonly gateway: GatewayClient
  private readonly reader: OpenClawReader
  /** 单个/多个 agent 库路径，或惰性解析函数（如按 agent 目录动态枚举） */
  private readonly dbPath: string | string[] | (() => string | string[])
  private readonly newId: () => string
  private readonly now: () => number
  private readonly logger?: (message: string) => void

  /** 在途扫描（自动轮询与手动点击并发时复用，不重复调模型） */
  private inflight: Promise<ImportTodayResult> | null = null
  /** 在途扫描的触发来源（不同触发不共用结果） */
  private inflightTrigger: ImportTrigger | null = null
  /** 主进程自动调度定时器（startAutoScheduler 创建） */
  private autoTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: OpenClawImportManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'OpenClawImportManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['database', options.database, 'metaGet'],
      ['records', options.records, 'proposeCandidate'],
      ['gateway', options.gateway, 'chat']
    ] as const) {
      if (typeof dep !== 'function' && (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function')) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `OpenClawImportManager 缺少依赖: ${name}`)
      }
    }
    if (typeof options.reader !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'OpenClawImportManager 缺少依赖: reader')
    }
    // dbPath 允许传解析函数（如按 agent 目录惰性枚举库），调用时才求值
    const dbPath = options.dbPath
    const validPath = (p: unknown): p is string => typeof p === 'string' && !!p.trim()
    const pathsOk =
      typeof dbPath === 'function' ||
      validPath(dbPath) ||
      (Array.isArray(dbPath) && dbPath.length > 0 && dbPath.every(validPath))
    if (!pathsOk) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'OpenClawImportManager 缺少 dbPath')
    }
    this.database = options.database
    this.records = options.records
    this.gateway = options.gateway
    this.reader = options.reader
    this.dbPath = dbPath
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 自动提取开关（默认关） */
  async isAutoEnabled(): Promise<boolean> {
    return (await this.database.metaGet(META_AUTO)) === '1'
  }

  async setAutoEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    const value = enabled === true
    await this.database.metaSet(META_AUTO, value ? '1' : '0')
    this.log(`[openclaw-import] 自动提取 → ${value ? '开' : '关'}`)
    return { enabled: value }
  }

  /** 自动模式连续失败状态（null=无）：{count 连续次数, firstAt 首次, lastAt 最近} */
  private async readRetryState(): Promise<{ count: number; firstAt: number; lastAt: number } | null> {
    const raw = await this.database.metaGet(META_RETRY)
    if (!raw || raw === '0') return null
    try {
      const parsed = JSON.parse(raw) as { count?: number; firstAt?: number; lastAt?: number }
      if (!Number.isFinite(parsed.count) || !parsed.count) return null
      return {
        count: Number(parsed.count),
        firstAt: Number(parsed.firstAt) || 0,
        lastAt: Number(parsed.lastAt) || 0
      }
    } catch {
      return null
    }
  }

  /** 记录一次自动模式解析失败（连续累加；退避时长由 count 推导） */
  private async noteAutoFailure(now: number): Promise<void> {
    const prev = await this.readRetryState()
    const next = {
      count: (prev?.count ?? 0) + 1,
      firstAt: prev?.firstAt || now,
      lastAt: now
    }
    await this.database.metaSet(META_RETRY, JSON.stringify(next))
  }

  /** 成功后清零：仅在确有失败记录时才写，避免每轮成功扫描都产生一次冗余 metaSet */
  private async clearRetryState(): Promise<void> {
    const raw = await this.database.metaGet(META_RETRY)
    if (raw && raw !== '0') await this.database.metaSet(META_RETRY, '0')
  }

  /** 读取已提议集合：会话键 → 提议时间（损坏/缺失按空处理） */
  private async readProposedMap(): Promise<Record<string, number>> {
    const raw = await this.database.metaGet(META_PROPOSED)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const map: Record<string, number> = {}
      for (const [key, value] of Object.entries(parsed)) {
        const ts = Number(value)
        if (key && Number.isFinite(ts)) map[key] = ts
      }
      return map
    } catch {
      return {}
    }
  }

  private async saveProposedMap(map: Record<string, number>): Promise<void> {
    await this.database.metaSet(META_PROPOSED, JSON.stringify(map))
  }

  /**
   * 扫描今天的 OpenClaw 使用记录并提炼候选。
   * 0 条新消息不调模型；模型调用成功后推进增量水位线。
   * trigger=auto 时受重试预算与指数退避约束；manual（默认）不受限，
   * 并会在成功后清掉自动失败计数。
   */
  async importToday(trigger: ImportTrigger = 'manual'): Promise<ImportTodayResult> {
    for (;;) {
      if (this.inflight) {
        // 在途复用仅限同一触发来源：手动撞上在途自动扫描时，
        // 不能把 auto 的 skipped/退避结果当作手动扫描结果返回
        if (this.inflightTrigger === trigger) return this.inflight
        // 跨触发：等在途一轮结束；该轮若是真实扫描成功（非退避跳过/失败），
        // 结果对手动同样有效——直接复用，不重复扫描。否则重判后再起自己的轮次。
        // 循环重判保证多个等待者恢复时最多只有一个新轮次，绝不并发起两轮。
        const finished = await this.inflight.then(
          (result) => ({ ok: true as const, result }),
          () => ({ ok: false as const })
        )
        if (finished.ok && !finished.result.skipped) return finished.result
        continue
      }
      const run = this.runImport(trigger)
        .catch(async (error) => {
          // 自动模式的一切失败（解析 / 读库 / 网关 / 全库不可读）都计入重试预算：
          // 否则 token 过期等非解析故障会绕过退避无限烧钱
          if (trigger === 'auto') {
            try {
              await this.noteAutoFailure(this.now())
            } catch {
              /* 计数写入失败不掩盖原始故障 */
            }
          }
          throw error
        })
        .finally(() => {
          this.inflight = null
          this.inflightTrigger = null
        })
      this.inflight = run
      this.inflightTrigger = trigger
      return run
    }
  }

  /**
   * 启动主进程自动调度：每 10 分钟一轮 auto，并立即补跑一次。
   * 调度在主进程后，用户不打开「新的一天」页面扫描也照常进行。重复调用幂等。
   */
  startAutoScheduler(): void {
    if (this.autoTimer) return
    this.autoTimer = setInterval(() => {
      this.importToday('auto').catch((e) => {
        this.log(`[openclaw-import] 自动调度轮次失败: ${(e as Error)?.message ?? e}`)
      })
    }, AUTO_SCAN_INTERVAL_MS)
    this.log('[openclaw-import] 主进程自动调度已启动')
    void this.importToday('auto').catch(() => {})
  }

  /** 停止主进程自动调度（开关关闭时调用） */
  stopAutoScheduler(): void {
    if (!this.autoTimer) return
    clearInterval(this.autoTimer)
    this.autoTimer = null
    this.log('[openclaw-import] 主进程自动调度已停止')
  }

  private async runImport(trigger: ImportTrigger): Promise<ImportTodayResult> {
    const now = this.now()
    const date = dateOf(now)
    const dayStartMs = startOfDayMs(now)
    const resolved = typeof this.dbPath === 'function' ? this.dbPath() : this.dbPath
    const dbPaths = Array.isArray(resolved) ? resolved : [resolved]

    if (!dbPaths.length) {
      return { scanned: 0, extracted: 0, filtered: 0, deduped: 0, candidateIds: [] }
    }

    // 自动模式重试闸门（必须在 reader 扫描之前：退避期最长 80 分钟，
    // 放在读库之后会导致退避期内仍每 10 分钟 spawn 便携 Node 空读各库）
    if (trigger === 'auto') {
      const retry = await this.readRetryState()
      if (retry) {
        if (retry.count >= AUTO_RETRY_MAX) {
          this.log('[openclaw-import] 自动重试已达上限，本轮跳过，请手动触发')
          return { scanned: 0, extracted: 0, filtered: 0, deduped: 0, candidateIds: [], skipped: true, skipReason: 'exhausted' }
        }
        const backoffMs = AUTO_BACKOFF_BASE_MS * 2 ** (retry.count - 1)
        const remainingMs = backoffMs - (now - retry.lastAt)
        if (remainingMs > 0) {
          this.log(`[openclaw-import] 退避中（还需约 ${Math.round(remainingMs / 60_000)} 分钟），本轮跳过读库与模型调用`)
          return { scanned: 0, extracted: 0, filtered: 0, deduped: 0, candidateIds: [], skipped: true, skipReason: 'backoff' }
        }
      }
    }

    // 每个 agent 库各自的水位线（键按库路径哈希区分）。新键从 0 开始——
    // 不用旧全局键做种子：残留的「今天」时间戳会让新库跳过今日早间消息；
    // 候选有确定性去重键兜底，从 0 重扫不会产生重复。
    // 逐库容错：任一库 reader reject（超时/spawn 失败）不影响其它库提炼。
    const scanResults = await Promise.all(
      dbPaths.map(async (dbPath) => {
        const wmKey = `${META_WATERMARK}:${shortHash(dbPath)}`
        try {
          const stored = await this.database.metaGet(wmKey)
          const sinceMs = Number(stored) || 0
          const result = await this.reader({ dbPath, sinceMs, dayStartMs })
          if (result.unavailable) {
            this.log(`[openclaw-import] ${dbPath} 不可用，本轮跳过${result.reason ? `: ${result.reason}` : ''}`)
          }
          return { ok: true as const, wmKey, ...result }
        } catch (error) {
          const message = (error as Error)?.message ?? String(error)
          this.log(`[openclaw-import] ${dbPath} 读取失败，本轮跳过该库: ${message}`)
          return { ok: false as const, dbPath, error }
        }
      })
    )
    const scans = scanResults.filter((s) => s.ok)
    if (!scans.length) {
      throw new AppError(ERROR_CODES.OPENCLAW_NOT_READY, '所有 agent 库都无法读取，本轮未提炼')
    }
    // reader 成功返回但全部标记 unavailable（如 OpenClaw 运行中独占库）：
    // 这是「读不了」而不是「没有内容」——不能静默返回 0 条，
    // 否则手动点击会误报「没有新的可记录内容」
    if (scans.every((s) => s.unavailable)) {
      throw new AppError(ERROR_CODES.OPENCLAW_NOT_READY, '所有 agent 库都暂时不可读（可能正被 OpenClaw 占用），本轮未提炼')
    }

    const messages = scans.flatMap((s) => s.messages).sort((a, b) => a.ts - b.ts)
    if (!messages.length) {
      // 0 条新消息也要清退避：重试耗尽后手动触发若恰好无新内容，
      // 不清状态会导致 UI 横幅已清、持久化退避仍在，下轮又冒出来（闪烁）
      await this.clearRetryState()
      return { scanned: 0, extracted: 0, filtered: 0, deduped: 0, candidateIds: [] }
    }

    // 已提议集合（第三道去重防线）：会话键 → 提议时间。
    // 水位不推进的失败重试中，重试间隔可能超过 recordManager 的 30 分钟去重窗口、
    // 或候选已被用户确认/忽略（窗口内不再有 candidate 状态可撞）——
    // 此时按会话键跳过已提议条目，不重复提议。条目按 TTL 惰性过期。
    const proposedMap = await this.readProposedMap()
    const proposedHadEntries = Object.keys(proposedMap).length > 0
    for (const key of Object.keys(proposedMap)) {
      if (now - proposedMap[key] > PROPOSED_TTL_MS) delete proposedMap[key]
    }
    let proposedDirty = false

    // 分批提炼：对话量超预算时切成多批各调一次模型，避免只保留最近消息而漏掉早间工作
    const batches = splitIntoBatches(messages, TRANSCRIPT_MAX_CHARS)
    const candidateIds: string[] = []
    /** 已处理过的行文本：同批/跨批的模型自我重复只走一次，不各成候选 */
    const seenLines = new Set<string>()
    let extracted = 0
    let filtered = 0
    let deduped = 0
    try {
      for (const batch of batches) {
        const runId = this.newId()
        const result = await this.gateway.chat({
          conversationKey: `conv:work:openclaw-import:${date}:${runId}`,
          messages: [
            { role: 'system', content: buildImportPrompt(renderTranscript(batch)) },
            { role: 'user', content: '请按规则提炼今天的工作记录。' }
          ],
          stream: false
        })
        if (result.aborted) {
          throw new AppError(ERROR_CODES.OPENCLAW_NOT_READY, '工作记录提炼已中止')
        }
        const text = String(result.text ?? '')
        const batchItems = parseRecordLines(text)
        // 0 条时：整段是明确的「无内容」标记才放过；空响应与无法识别同属失败，
        // 不推进水位（空响应绝不能当「明确无」，否则该批消息静默丢失）。
        // 失败计数统一由 importToday 的 auto 包装处理（一切故障同口径）
        if (batchItems.length === 0 && (!text.trim() || !isExplicitEmpty(text))) {
          throw new AppError(
            ERROR_CODES.OPENCLAW_INVALID_OUTPUT,
            text.trim()
              ? '工作记录提炼结果无法识别，将在下次自动重试'
              : '工作记录提炼返回空内容，将在下次自动重试',
            { reason: text.trim() ? 'unparseable-output' : 'empty-output' }
          )
        }
        // 候选键锚定源消息：date + 本批源消息身份哈希 + 批内行序。
        // 同一批源消息重扫（失败重试）时命中同键，被已提议集合/去重窗口兜住
        const sourceAnchor = shortHash(
          batch.map((message) => `${message.ts}:${message.sessionKey}`).join('|')
        )
        for (let index = 0; index < batchItems.length; index++) {
          const content = batchItems[index]
          if (seenLines.has(content)) continue
          seenLines.add(content)
          const conversationKey = `conv:work:openclaw-import:${date}:${sourceAnchor}:${index}`
          if (proposedMap[`ck:${conversationKey}`] !== undefined) {
            // 本水位时代已提议过该键：跳过（计 deduped=非新增），不重复提议
            deduped += 1
            continue
          }
          const proposed = await this.records.proposeCandidate({
            content,
            outputType: 'openclaw_activity',
            conversationKey
          })
          proposedMap[`ck:${conversationKey}`] = now
          proposedDirty = true
          if (proposed.candidate) {
            // deduped=true 是命中覆盖更新，不是新提取：
            // 不计入 extracted（否则 toast 虚报），id 也不重复入列
            if (proposed.deduped) {
              deduped += 1
            } else {
              extracted += 1
              candidateIds.push(proposed.candidate.id)
            }
          } else if (proposed.filteredReason) {
            filtered += 1
          }
        }
      }

      // 模型调用与候选全部落库成功后，才推进各库自己的水位线
      for (const s of scans) {
        await this.database.metaSet(s.wmKey, String(s.maxCreatedAt))
      }
    } catch (error) {
      // 失败时持久化已提议集合：水位不推进，下轮重试靠它跳过本轮已提议的条目
      if (proposedDirty) {
        try {
          await this.saveProposedMap(proposedMap)
        } catch {
          /* 持久化失败不掩盖原始故障 */
        }
      }
      throw error
    }
    // 成功收敛：清掉自动失败计数（手动成功也会清除，之后自动调度恢复正常）；
    // 水位已推进，已提议集合整体清空（仅确有内容时写，避免每轮冗余 metaSet）
    await this.clearRetryState()
    if (proposedDirty || proposedHadEntries) await this.saveProposedMap({})
    this.log(
      `[openclaw-import] 扫描 ${messages.length} 条消息（${scans.length} 个 agent 库）→ 新候选 ${extracted}，覆盖 ${deduped}，门槛过滤 ${filtered}`
    )
    return { scanned: messages.length, extracted, filtered, deduped, candidateIds }
  }
}

/** epoch ms（本地时区）→ 当天 0 点 */
function startOfDayMs(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** 渲染一批对话片段（调用方已按字符预算分好批；单条超长已在分批时截断） */
function renderTranscript(messages: OpenClawSessionMessage[]): string {
  return messages.map(renderBlock).join('\n\n')
}

/**
 * 按时间从早到晚把消息切成多批，每批渲染后不超 maxChars（不漏早间工作）。
 * 单条消息自身超限时截断该条独占一批：若整条丢弃，该段内容会随水位推进被永久跳过。
 */
function splitIntoBatches(messages: OpenClawSessionMessage[], maxChars: number): OpenClawSessionMessage[][] {
  const batches: OpenClawSessionMessage[][] = []
  let current: OpenClawSessionMessage[] = []
  let currentSize = 0
  const flush = (): void => {
    if (current.length) {
      batches.push(current)
      current = []
      currentSize = 0
    }
  }
  for (const message of messages) {
    let block = renderBlock(message)
    if (block.length > maxChars) {
      flush()
      // 预留 100 字符给「用户：」等前缀，截断后独占一批
      const truncated: OpenClawSessionMessage = { ...message, text: message.text.slice(0, maxChars - 100) }
      batches.push([truncated])
      continue
    }
    const separator = current.length ? 2 : 0 // join('\n\n') 的真实开销，计量须与渲染一致
    if (currentSize + separator + block.length > maxChars) flush()
    current.push(message)
    currentSize += (current.length > 1 ? 2 : 0) + block.length
  }
  flush()
  return batches
}

/** 单条消息渲染块（与 renderTranscript 同口径，分批计量必须和最终渲染一致） */
function renderBlock(message: OpenClawSessionMessage): string {
  const who = message.role === 'user' ? '用户' : '助手'
  const channel = message.channel ? `（${message.channel}）` : ''
  return `${who}${channel}：${message.text}`
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

/** 整行是否为「无内容」标记（无 / 暂无内容 / 暂无可记录内容 等变体） */
function isEmptyMarker(text: string): boolean {
  return EMPTY_MARKER_PHRASES.has(normalizeMarker(text))
}

/**
 * 模型整体明确表示「没有可记录内容」。
 * 空串/纯空白不算——空响应按失败处理（见 runImport），不能借这里静默丢内容。
 * 容忍「好的，分析如下：」之类的前后缀散文：只要任一行是「无内容」标记
 *（含 `- （无）`），模型本意就是无内容，不能因散文行而误判无法识别。
 */
function isExplicitEmpty(text: string): boolean {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.some((line) => isEmptyMarker(line.replace(/^[-·*]\s+/, '')))
}

/** 内容短哈希（确定性，跨重启稳定）：用作候选去重键的一部分 */
function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function buildImportPrompt(transcript: string): string {
  return [
    '你是工作助手。下面是用户今天通过 OpenClaw（桌面对话 / 微信 / 飞书等渠道）与 AI 的对话片段，可能不完整。',
    '请识别用户实际完成或推进的业务工作，提炼为简明工作记录（每条一句话、动宾结构，可直接作为日报事实）。',
    '',
    '规则：',
    '1. 只依据对话内容，不得编造；不确定的不要写。',
    '2. 忽略闲聊、问候、新闻播报等定时推送，以及让 AI 写日报/周报/纪要等「关于工作流本身」的操作。',
    '3. 同一事项的多次来回只保留一条最终进展。',
    '4. 每条单独一行，以「- 」开头；不要编号、标题或其他解释。',
    '5. 没有值得记录的内容时，只输出一行：- （无）',
    '',
    '【对话片段】',
    transcript
  ].join('\n')
}

/** 解析模型输出：每行 `- 内容` 为一条记录；「无内容」标记与解释文字忽略 */
function parseRecordLines(text: string): string[] {
  const items: string[] = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^[-·*]\s+(.+)$/.exec(line)
    if (!match) continue
    const content = match[1].trim()
    // 「- （无）」「- 无。」「- 暂无可记录内容」等变体都不是工作记录，
    // 必须在此挡下——isExplicitEmpty 只在整段 0 条时才被咨询，挡不到逐行变体
    if (content && !isEmptyMarker(content)) items.push(content)
  }
  return items
}

export function createOpenClawImportManager(options: OpenClawImportManagerOptions): OpenClawImportManager {
  return new OpenClawImportManager(options)
}
