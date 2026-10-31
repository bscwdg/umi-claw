// electron/main/character/manager.ts —— CharacterManager：生命周期 / 状态 / 设置 / 交互
//
// 纯 Node（不 import electron），便于接受验收脚本直接打真源码。
// 失败只降级自身：init 抛错由 wiring 捕获并记录，不影响宿主启动。

import {
  CHARACTER_ERROR_CODES,
  CharacterError,
  PET_SIZE_MAP,
  createDefaultCharacterState,
  mergeCharacterSettings,
  type CharacterEvent,
  type CharacterInteractInput,
  type CharacterPetState,
  type CharacterResetOptions,
  type CharacterSettings,
  type CharacterState,
  type CharacterStatus
} from './types'
import type { CharacterStore } from './store'
import type { BootstrapReport } from './bootstrap'
import {
  applyRelationshipEvent,
  toDateKey,
  type RelationshipApplyResult,
  type RelationshipEvent
} from './relationship'
import { composeLifeDay, renderLifeDoc, type LifeDay } from './life'
import type { LifeDeck } from './contentCards'
import {
  decideProactive,
  PROACTIVE_MIN_GAP_MS,
  type ProactiveDayState,
  type ProactiveDecision
} from './proactive'
import {
  buildMemoryPrompt,
  diaryObsidianRelPath,
  extractDiaryText,
  memoryDateFor,
  normalizeDiary,
  shouldRunMemory,
  validateDiary,
  type MemoryDayState,
  type MemoryGateReason
} from './memoryJob'
import { renderStateDoc } from './persona'

export interface CharacterManagerOptions {
  store: CharacterStore
  now?: () => number
  logger?: (message: string) => void
  onEvent?: (event: CharacterEvent) => void
  /** 桌宠位置夹取（wiring 注入屏幕工作区；缺省不夹） */
  clampPosition?: (x: number, y: number, width: number, height: number) => { x: number; y: number }
  /** 生活内容卡加载（resources/character/cards/life-cards.v1.json） */
  loadLifeDeck?: () => Promise<LifeDeck>
  /** 把「她的一天」写进 workspace（fish/LIFE.md） */
  writeLifeDoc?: (text: string) => Promise<void>
  /** 主动消息外发（C08 接 QQ；不提供则只做应用内气泡） */
  sendProactive?: (message: { text: string; channel: 'qq' | 'app' }) => Promise<boolean>
  /** 每日记忆（C07）：生成日记 + 双写（workspace / Obsidian） */
  generateDiary?: (prompt: string, meta: { date: string }) => Promise<string>
  readWorkspaceMemory?: (date: string) => Promise<string | null>
  writeWorkspaceMemory?: (date: string, text: string) => Promise<void>
  writeObsidianDiary?: (relPath: string, text: string) => Promise<void>
  /** Obsidian vault 是否可用（缺失时日记降级 workspace-only，不判失败） */
  obsidianAvailable?: () => boolean
}

export class CharacterManager {
  private readonly store: CharacterStore
  private readonly now: () => number
  private readonly logger: (message: string) => void
  private readonly onEvent?: (event: CharacterEvent) => void
  private readonly clampPosition?: (
    x: number,
    y: number,
    width: number,
    height: number
  ) => { x: number; y: number }
  private readonly loadLifeDeck?: () => Promise<LifeDeck>
  private readonly writeLifeDoc?: (text: string) => Promise<void>
  private readonly sendProactive?: (message: {
    text: string
    channel: 'qq' | 'app'
  }) => Promise<boolean>
  private readonly generateDiary?: (prompt: string, meta: { date: string }) => Promise<string>
  private readonly readWorkspaceMemory?: (date: string) => Promise<string | null>
  private readonly writeWorkspaceMemory?: (date: string, text: string) => Promise<void>
  private readonly writeObsidianDiary?: (relPath: string, text: string) => Promise<void>
  private readonly obsidianAvailable?: () => boolean
  private lifeDeckCache: LifeDeck | null = null
  private memoryInFlight: Promise<{ ran: boolean; reason: MemoryGateReason; errors?: string[] }> | null =
    null
  private proactiveInFlight = false
  private disposed = false

  private settings: CharacterSettings | null = null
  private state: CharacterState | null = null
  private initialized = false
  private bootstrapRunner: (() => Promise<BootstrapReport>) | null = null
  private lastBootstrap: BootstrapReport | null = null
  private bootstrapInFlight: Promise<BootstrapReport> | null = null
  private personaSyncRunner: (() => Promise<void>) | null = null
  private personaSyncTimer: NodeJS.Timeout | null = null
  private mutationQueue: Promise<void> = Promise.resolve()
  private dependencyStatus: Omit<
    CharacterStatus,
    'enabled' | 'ready' | 'storeReady'
  > = {
    agentReady: false,
    gatewayReady: false,
    obsidianReady: false,
    qqReady: false,
    ttsReady: false,
    sttReady: false,
    memorySearchReady: false
  }

  constructor(options: CharacterManagerOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? (() => undefined)
    this.onEvent = options.onEvent
    this.clampPosition = options.clampPosition
    this.loadLifeDeck = options.loadLifeDeck
    this.writeLifeDoc = options.writeLifeDoc
    this.sendProactive = options.sendProactive
    this.generateDiary = options.generateDiary
    this.readWorkspaceMemory = options.readWorkspaceMemory
    this.writeWorkspaceMemory = options.writeWorkspaceMemory
    this.writeObsidianDiary = options.writeObsidianDiary
    this.obsidianAvailable = options.obsidianAvailable
  }

  async init(): Promise<void> {
    if (this.initialized) return
    const existingSettings = await this.store.readSettings()
    this.settings = existingSettings
    this.state = await this.store.readState()
    // 首启落一份默认值，避免每次读到「不存在」都重新推导
    await this.store.writeSettings(existingSettings)
    await this.store.writeState(this.state)
    await this.store.prune()
    this.initialized = true
    this.logger(`[character] 初始化完成（enabled=${existingSettings.enabled}）`)
  }

  /** C02/C08 完成后由 wiring 回填依赖就绪态 */
  setDependencyStatus(patch: Partial<CharacterStatus>): void {
    this.dependencyStatus = {
      ...this.dependencyStatus,
      agentReady:
        typeof patch.agentReady === 'boolean' ? patch.agentReady : this.dependencyStatus.agentReady,
      gatewayReady:
        typeof patch.gatewayReady === 'boolean'
          ? patch.gatewayReady
          : this.dependencyStatus.gatewayReady,
      obsidianReady:
        typeof patch.obsidianReady === 'boolean'
          ? patch.obsidianReady
          : this.dependencyStatus.obsidianReady,
      qqReady: typeof patch.qqReady === 'boolean' ? patch.qqReady : this.dependencyStatus.qqReady,
      ttsReady: typeof patch.ttsReady === 'boolean' ? patch.ttsReady : this.dependencyStatus.ttsReady,
      sttReady: typeof patch.sttReady === 'boolean' ? patch.sttReady : this.dependencyStatus.sttReady,
      memorySearchReady:
        typeof patch.memorySearchReady === 'boolean'
          ? patch.memorySearchReady
          : this.dependencyStatus.memorySearchReady
    }
  }

  isEnabled(): boolean {
    return Boolean(this.settings?.enabled)
  }

  getStatus(): CharacterStatus {
    const enabled = this.isEnabled()
    return {
      enabled,
      ready: this.initialized && enabled,
      storeReady: this.initialized,
      ...this.dependencyStatus
    }
  }

  async getState(): Promise<CharacterState> {
    this.assertInitialized()
    if (!this.state) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色状态尚未加载')
    return { ...this.state }
  }

  async getSettings(): Promise<CharacterSettings> {
    this.assertInitialized()
    if (!this.settings) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色设置尚未加载')
    }
    return clone(this.settings)
  }

  async updateSettings(patch: unknown): Promise<CharacterSettings> {
    return this.withMutation(() => this.updateSettingsImpl(patch))
  }

  private async updateSettingsImpl(patch: unknown): Promise<CharacterSettings> {
    this.assertInitialized()
    if (!this.settings) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色设置尚未加载')
    }
    const wasEnabled = Boolean(this.settings?.enabled)
    const next = mergeCharacterSettings(this.settings, patch)
    this.settings = next
    await this.store.writeSettings(next)
    // 从关到开：自动跑一次引导（幂等；失败只记日志，不影响宿主）
    if (next.enabled && !wasEnabled && this.bootstrapRunner) {
      void this.runBootstrap().catch((error) => {
        this.logger(`[character] 启用后引导失败: ${(error as Error)?.message ?? String(error)}`)
      })
    }
    this.emit({ type: 'settings', payload: clone(next), at: this.now() })
    this.schedulePersonaSync()
    return clone(next)
  }

  /** 关系事件入口（聊天/语音/里程碑等；每日上限与幂等在引擎里） */
  async applyRelationshipEvent(event: RelationshipEvent): Promise<RelationshipApplyResult> {
    return this.withMutation(() => this.applyRelationshipEventImpl(event))
  }

  private async applyRelationshipEventImpl(
    event: RelationshipEvent,
    mood?: string
  ): Promise<RelationshipApplyResult> {
    this.assertInitialized()
    if (!this.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    const state = await this.getState()
    const now = this.now()
    const dedup = await this.store.readDedup()
    const result = applyRelationshipEvent(
      state,
      { ...event, at: event.at ?? now },
      { now, today: toDateKey(now), dedup }
    )
    if (!result.applied) return result
    const next = result.state
    if (mood) next.mood = mood
    await this.store.writeState(next)
    await this.store.writeDedup(result.dedup)
    this.state = next
    // day 事件（记日记时当素材）：与 activeSent 等共用同一 day 键，必须在锁内合并
    const date = toDateKey(now)
    const time = new Date(now).toTimeString().slice(0, 5)
    await this.patchDayUnlocked(date, (day) => {
      const events = Array.isArray(day.events) ? (day.events as unknown[]) : []
      return {
        ...day,
        events: [...events, `${time} ${event.type}`].slice(-50)
      }
    })
    if (result.unlocked.length > 0) {
      const before = await this.store.readUnlocks()
      const merged = [...before]
      for (const item of result.unlocked) if (!merged.includes(item)) merged.push(item)
      await this.store.writeUnlocks(merged)
    }
    this.emit({ type: 'state', payload: clone(next), at: now })
    if (result.unlocked.length > 0) {
      this.emit({
        type: 'bubble',
        payload: { text: `解锁：${result.unlocked.join('、')}` },
        at: now
      })
    }
    this.schedulePersonaSync()
    return result
  }

  async interact(input: CharacterInteractInput): Promise<CharacterState> {
    return this.withMutation(() => this.interactImpl(input))
  }

  private async interactImpl(input: CharacterInteractInput): Promise<CharacterState> {
    this.assertInitialized()
    if (!this.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    const state = await this.getState()
    const kind = input?.kind
    if (kind !== 'pat' && kind !== 'feed' && kind !== 'dismiss') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的互动类型')
    }
    if (kind === 'dismiss') return { ...state }
    const result = await this.applyRelationshipEventImpl(
      { type: kind === 'pat' ? 'interact.pat' : 'interact.feed' },
      kind === 'pat' ? '被摸头了' : '吃饱了'
    )
    return { ...result.state }
  }

  /** 确保当天「她的一天」已生成（幂等；错过不补多天） */
  async ensureDailyLife(
    now = this.now()
  ): Promise<{ day: LifeDay; doc: string; generated: boolean }> {
    this.assertInitialized()
    return this.withMutation(() => this.ensureDailyLifeImpl(now))
  }

  private async ensureDailyLifeImpl(
    now: number
  ): Promise<{ day: LifeDay; doc: string; generated: boolean }> {
    const date = toDateKey(now)
    const existing = await this.store.readLife<LifeDay>(date)
    const deck = await this.getLifeDeck()
    if (existing && existing.date === date) {
      const doc = renderLifeDoc(existing, this.cardsFor(deck, existing.cardIds ?? []))
      // 文件可能被用户删掉/首写失败：每次 ensure 都补写一次（幂等）
      await this.writeLifeDocSafe(doc)
      return { day: existing, doc, generated: false }
    }
    const state = await this.getState()
    const recent = await this.recentCardIds(date, now)
    const composed = composeLifeDay({
      deck,
      // 初识（stage 0）还没有专属卡：用 stage 1 的日常卡兜底，别让她「没有生活」
      stage: Math.max(1, state.stage),
      date,
      now,
      recentIds: recent
    })
    await this.store.writeLife(date, composed.day)
    await this.writeLifeDocSafe(composed.doc)
    // 每日剪枝：长跑进程也要按保留策略清理（§13.1-3）
    void this.store.prune().catch(() => undefined)
    return { day: composed.day, doc: composed.doc, generated: true }
  }

  private async writeLifeDocSafe(doc: string): Promise<void> {
    if (!this.writeLifeDoc) return
    try {
      await this.writeLifeDoc(doc)
    } catch (error) {
      this.logger(`[character] LIFE.md 写入失败: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  /** 读某天「她的一天」（缺省今天） */
  async getLife(
    date?: string,
    now = this.now()
  ): Promise<{ day: LifeDay | null; doc: string | null }> {
    this.assertInitialized()
    const target = date ?? toDateKey(now)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '日期格式应为 YYYY-MM-DD')
    }
    const day = await this.store.readLife<LifeDay>(target)
    if (!day) return { day: null, doc: null }
    const deck = await this.getLifeDeck()
    return { day, doc: renderLifeDoc(day, this.cardsFor(deck, day.cardIds)) }
  }

  /** 主动性判定（不发送）：返回决策 + 候选文案 */
  async evaluateProactive(
    now = this.now()
  ): Promise<{ decision: ProactiveDecision; message: string; day: LifeDay | null }> {
    this.assertInitialized()
    const settings = await this.getSettings()
    const state = await this.getState()
    const date = toDateKey(now)
    const day = (await this.store.readDay<ProactiveDayState>(date)) ?? {}
    const decision = decideProactive({
      settings,
      state,
      day,
      now,
      today: date,
      fallbackStartAt: state.lastInteractionAt
    })
    if (!decision.send) return { decision, message: '', day: null }
    const life = await this.ensureDailyLife(now)
    const deck = await this.getLifeDeck()
    const primary = deck.cards.find((c) => c.id === life.day.cardIds[0])
    return { decision, message: primary?.hook ?? life.day.activity, day: life.day }
  }

  /** 记一次主动发送（含降级通道）；用于日上限与状态展示 */
  async markProactiveSent(channel: 'qq' | 'app', now = this.now()): Promise<number> {
    this.assertInitialized()
    const date = toDateKey(now)
    const time = new Date(now).toTimeString().slice(0, 5)
    const next = await this.patchDay(date, (day) => ({
      ...day,
      activeSent: (typeof day.activeSent === 'number' ? day.activeSent : 0) + 1,
      lastActiveAt: now,
      events: [
        ...(Array.isArray(day.events) ? (day.events as unknown[]) : []),
        `${time}:${channel}`
      ].slice(-50)
    }))
    return typeof next.activeSent === 'number' ? next.activeSent : 0
  }

  /**
   * 主动性 tick：原子预留额度 → 外发（可选）→ 失败降级应用内气泡。
   * 不重试、不换通道；tick 重入被 in-flight 挡住，额度在发送前已计入。
   */
  async runProactiveTick(
    now = this.now()
  ): Promise<{ decision: ProactiveDecision; message?: string; delivered?: boolean }> {
    this.assertInitialized()
    if (this.proactiveInFlight) {
      return { decision: { send: false, reason: 'min-interval', channel: 'app' } }
    }
    this.proactiveInFlight = true
    try {
      const { decision, message } = await this.evaluateProactive(now)
      if (!decision.send || !message) return { decision }
      const claimed = await this.claimProactiveSlot(now)
      if (!claimed) {
        return { decision: { ...decision, send: false, reason: 'daily-cap' } }
      }
      let delivered = false
      if (this.sendProactive) {
        try {
          delivered = await this.sendProactive({ text: message, channel: decision.channel })
        } catch (error) {
          this.logger(`[character] 主动消息外发失败: ${(error as Error)?.message ?? String(error)}`)
        }
      }
      // 外发成功就不要再发应用内气泡（避免双通知）；失败才降级
      if (!delivered) {
        this.emit({ type: 'bubble', payload: { text: message }, at: now })
      }
      return { decision, message, delivered }
    } finally {
      this.proactiveInFlight = false
    }
  }

  /** 发送前预留额度（锁内二次校验上限与最小间隔，防并发超发） */
  private async claimProactiveSlot(now: number): Promise<boolean> {
    const date = toDateKey(now)
    const time = new Date(now).toTimeString().slice(0, 5)
    return this.withMutation(async () => {
      const settings = await this.getSettings()
      const day = (await this.store.readDay<ProactiveDayState>(date)) ?? {}
      const cap = Math.max(0, Math.min(10, Math.round(settings.proactive.dailyCap)))
      if ((day.activeSent ?? 0) >= cap) return false
      if (day.lastActiveAt && now - day.lastActiveAt < PROACTIVE_MIN_GAP_MS) return false
      const next: ProactiveDayState = {
        ...day,
        activeSent: (day.activeSent ?? 0) + 1,
        lastActiveAt: now,
        events: [...(day.events ?? []), `${time}:reserve`].slice(-50)
      }
      await this.store.writeDay(date, next)
      return true
    })
  }

  private async getLifeDeck(): Promise<LifeDeck> {
    if (!this.lifeDeckCache) {
      try {
        this.lifeDeckCache = this.loadLifeDeck
          ? await this.loadLifeDeck()
          : { schema: 'fish-life-cards/1', version: '0.0.0', cards: [] }
      } catch (error) {
        // 坏卡文件不能每 30s 刷日志：缓存空 deck 并只记一次
        this.logger(
          `[character] 生活卡加载失败，降级为空卡池: ${(error as Error)?.message ?? String(error)}`
        )
        this.lifeDeckCache = { schema: 'fish-life-cards/1', version: '0.0.0', cards: [] }
      }
    }
    return this.lifeDeckCache
  }

  private cardsFor(deck: LifeDeck, ids: string[]) {
    return ids
      .map((id) => deck.cards.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
  }

  private async recentCardIds(date: string, now: number): Promise<string[]> {
    const meta = await this.store.readMeta()
    const cutoff = now - 7 * 86_400_000
    const out: string[] = []
    for (const day of meta.lifeDays) {
      if (day === date) continue
      const ts = new Date(`${day}T00:00:00`).getTime()
      if (!Number.isFinite(ts) || ts < cutoff) continue
      const life = await this.store.readLife<LifeDay>(day)
      if (life?.cardIds) out.push(...life.cardIds)
    }
    return out
  }

  /** 每日记忆状态（设置页展示；不含日记正文） */
  async getMemoryStatus(now = this.now()): Promise<
    MemoryDayState & { date: string; reason?: MemoryGateReason }
  > {
    this.assertInitialized()
    const date = toDateKey(now)
    const day = (await this.store.readDay<{ memory?: MemoryDayState }>(date)) ?? {}
    return { date, ...(day.memory ?? {}) }
  }

  /**
   * 23:00 窗口的自动触发（tick 调用）：满足窗口/冷却/尝试次数才跑。
   * manual=true 时跳过窗口与冷却（设置页「现在写一篇」）。
   */
  async maybeRunDailyMemory(
    now = this.now(),
    manual = false
  ): Promise<{ ran: boolean; reason: MemoryGateReason; errors?: string[] }> {
    this.assertInitialized()
    // 生成常 >30s：tick 与手动可能同时进入；单飞锁必须在第一个 await 之前同步占位
    if (this.memoryInFlight) return this.memoryInFlight
    const task = (async () => {
      const date = manual ? toDateKey(now) : memoryDateFor(now)
      const settings = await this.getSettings()
      const day = (await this.store.readDay<{ memory?: MemoryDayState }>(date)) ?? {}
      const gate = shouldRunMemory({ now, day: day.memory ?? {}, settings, manual })
      if (!gate.run) return { ran: false, reason: gate.reason }
      return this.runDailyMemoryImpl(now, manual, date)
    })()
    this.memoryInFlight = task.finally(() => {
      this.memoryInFlight = null
    })
    return this.memoryInFlight
  }

  private async runDailyMemoryImpl(
    now: number,
    _manual: boolean,
    date: string
  ): Promise<{ ran: boolean; reason: MemoryGateReason; errors?: string[] }> {
    const base =
      (await this.store.readDay<{ memory?: MemoryDayState; events?: string[] }>(date)) ?? {}
    const memory: MemoryDayState = { ...(base.memory ?? {}) }
    memory.attempts = (memory.attempts ?? 0) + 1
    memory.lastAttemptAt = now
    // 先落 attempts：并发/崩溃后冷却与上限才有意义
    await this.mergeDayMemory(date, memory)
    try {
      if (!this.generateDiary || !this.writeWorkspaceMemory || !this.writeObsidianDiary) {
        throw new Error('记忆生成链路未接线')
      }
      let cleaned = memory.pendingText ?? ''
      if (!cleaned) {
        const settings = await this.getSettings()
        const state = await this.getState()
        const life = await this.ensureDailyLife(now)
        const workspaceMemory = this.readWorkspaceMemory
          ? await this.readWorkspaceMemory(date).catch(() => null)
          : null
        const prompt = buildMemoryPrompt({
          date,
          address: settings.relationship.address,
          stage: state.stage,
          stateDoc: renderStateDoc(state, settings),
          lifeDoc: life.doc,
          workspaceMemory: workspaceMemory ?? '',
          recentEvents: base.events ?? []
        })
        const raw = await this.generateDiary(prompt, { date })
        // 先规范化（frontmatter 白名单 + 正文脱敏），再校验/落盘
        cleaned = normalizeDiary(extractDiaryText(raw), date)
        const validation = validateDiary(cleaned, date)
        if (!validation.ok) {
          throw new Error(`日记校验失败：${validation.errors.join('；')}`)
        }
        memory.pendingText = cleaned
        await this.mergeDayMemory(date, memory)
      } else {
        const validation = validateDiary(cleaned, date)
        if (!validation.ok) {
          throw new Error(`复用日记校验失败：${validation.errors.join('；')}`)
        }
      }
      // 先写 workspace（宿主可回滚），再写 Obsidian 日记目录
      await this.writeWorkspaceMemory(date, cleaned)
      memory.memoryFile = `memory/${date}.md`
      const obsidianReady = this.obsidianAvailable ? this.obsidianAvailable() : true
      if (!obsidianReady) {
        // 未配置 vault 是合法状态：降级 workspace-only，不判失败、不重复生成
        memory.done = true
        memory.partial = false
        memory.lastError = undefined
        memory.pendingText = undefined
        memory.obsidianPath = undefined
        await this.mergeDayMemory(date, memory)
        this.emit({
          type: 'bubble',
          payload: { text: `日记写好了（${date}，未配置 Obsidian，只存本机）` },
          at: now
        })
        return { ran: true, reason: 'ok' }
      }
      memory.partial = true
      await this.mergeDayMemory(date, memory)
      const relPath = diaryObsidianRelPath(date)
      await this.writeObsidianDiary(relPath, cleaned)
      memory.done = true
      memory.partial = false
      memory.lastError = undefined
      memory.pendingText = undefined
      memory.obsidianPath = relPath
      await this.mergeDayMemory(date, memory)
      this.emit({ type: 'bubble', payload: { text: `日记写好了（${date}）` }, at: now })
      return { ran: true, reason: 'ok' }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      memory.lastError = message
      await this.mergeDayMemory(date, memory)
      this.logger(`[character] 每日记忆失败（第 ${memory.attempts} 次）: ${message}`)
      return { ran: false, reason: 'failed', errors: [message] }
    }
  }

  /** 只合并 memory 字段并加锁：避免长生成回来用旧 day 快照覆盖 activeSent/events */
  private async mergeDayMemory(date: string, memory: MemoryDayState): Promise<void> {
    await this.withMutation(async () => {
      const fresh = (await this.store.readDay<Record<string, unknown>>(date)) ?? {}
      await this.store.writeDay(date, { ...fresh, memory })
    })
  }

  async reset(options: CharacterResetOptions = {}): Promise<{ scope: string }> {
    return this.withMutation(() => this.resetImpl(options))
  }

  private async resetImpl(options: CharacterResetOptions): Promise<{ scope: string }> {
    this.assertInitialized()
    const scope = options.scope ?? 'values'
    if (scope !== 'values' && scope !== 'memory' && scope !== 'all') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的重置范围')
    }
    await this.store.reset(scope)
    if (scope === 'all') {
      this.settings = await this.store.readSettings()
    }
    this.state = await this.store.readState()
    if (this.state.bornAt === 0) this.state = createDefaultCharacterState(this.now())
    this.emit({ type: 'state', payload: clone(this.state), at: this.now() })
    this.emit({ type: 'reset', payload: { scope }, at: this.now() })
    if (scope === 'all' && this.settings) {
      // 全量重置读到的是默认设置：广播一次，桌宠/页面才能同步收起
      this.emit({ type: 'settings', payload: clone(this.settings), at: this.now() })
    }
    this.schedulePersonaSync()
    return { scope }
  }

  /** wiring 注入：真正执行引导（宿主路径 / 官方 CLI / 依赖就绪探测都由 wiring 提供） */
  setBootstrapRunner(runner: () => Promise<BootstrapReport>): void {
    this.bootstrapRunner = runner
  }

  /** wiring 注入：轻量人格同步（只重写受管文件，不跑 CLI 引导） */
  setPersonaSyncRunner(runner: () => Promise<void>): void {
    this.personaSyncRunner = runner
  }

  /** 释放：清理防抖定时器 */
  dispose(): void {
    this.disposed = true
    if (this.personaSyncTimer) clearTimeout(this.personaSyncTimer)
    this.personaSyncTimer = null
  }

  async runBootstrap(): Promise<BootstrapReport> {
    this.assertInitialized()
    if (!this.bootstrapRunner) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色引导尚未接线')
    }
    // 并发引导会重复跑 config patch / 受管写入（manifest 竞态），同一时刻只允许一次
    if (this.bootstrapInFlight) return this.bootstrapInFlight
    const run = this.bootstrapRunner()
      .then((report) => {
        this.lastBootstrap = report
        this.setDependencyStatus({
          agentReady: report.status.agentReady,
          gatewayReady: report.status.gatewayReady,
          obsidianReady: report.status.obsidianReady,
          qqReady: report.status.qqReady,
          ttsReady: report.status.ttsReady,
          memorySearchReady: report.status.memorySearchReady
        })
        return report
      })
      .finally(() => {
        this.bootstrapInFlight = null
      })
    this.bootstrapInFlight = run
    return run
  }

  getBootstrapStatus(): BootstrapReport | null {
    return this.lastBootstrap ? clone(this.lastBootstrap) : null
  }

  /** 桌宠状态：尺寸/穿透/可见跟随设置，位置来自上一次记忆 */
  async getPetState(): Promise<CharacterPetState> {
    this.assertInitialized()
    const settings = await this.getSettings()
    const raw = (await this.store.readPet()) ?? {}
    const size = PET_SIZE_MAP[settings.pet.size] ?? PET_SIZE_MAP.medium
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      x: num(raw.x),
      y: num(raw.y),
      width: size.width,
      height: size.height,
      clickThrough: Boolean(settings.pet.clickThrough),
      visible: Boolean(settings.enabled && settings.pet.visible),
      saved: Boolean(raw.saved)
    }
  }

  async savePetState(patch: Partial<CharacterPetState>): Promise<CharacterPetState> {
    return this.withMutation(() => this.savePetStateImpl(patch))
  }

  private async savePetStateImpl(patch: Partial<CharacterPetState>): Promise<CharacterPetState> {
    this.assertInitialized()
    const current = await this.getPetState()
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
    let x = num(patch.x, current.x)
    let y = num(patch.y, current.y)
    if (this.clampPosition) {
      const clamped = this.clampPosition(x, y, current.width, current.height)
      x = clamped.x
      y = clamped.y
    }
    const next: CharacterPetState = {
      x,
      y,
      width: current.width,
      height: current.height,
      clickThrough:
        typeof patch.clickThrough === 'boolean' ? patch.clickThrough : current.clickThrough,
      visible: typeof patch.visible === 'boolean' ? patch.visible : current.visible,
      saved: true
    }
    await this.store.writePet(next)
    return next
  }

  /** 聊天情绪：更新心情并广播（桌宠换表情由渲染端消费） */
  async applyChatEmotion(emotion: string, visualState: string): Promise<CharacterState> {
    return this.withMutation(() => this.applyChatEmotionImpl(emotion, visualState))
  }

  private async applyChatEmotionImpl(
    emotion: string,
    visualState: string
  ): Promise<CharacterState> {
    this.assertInitialized()
    const state = await this.getState()
    state.mood = (emotion || '平静').slice(0, 40)
    state.updatedAt = this.now()
    await this.store.writeState(state)
    this.state = state
    this.emit({ type: 'emotion', payload: { emotion, visualState }, at: state.updatedAt })
    // STATE.md 的「她的心情」是最高频变更，必须跟着重写
    this.schedulePersonaSync()
    return { ...state }
  }

  private assertInitialized(): void {
    if (this.disposed) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '大肥鱼已停用')
    }
    if (!this.initialized) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '大肥鱼尚未初始化')
    }
  }

  /** day 记录读改写（走同一串行队列，避免 memory/proactive/events 互相覆盖） */
  private async patchDay(
    date: string,
    fn: (day: Record<string, unknown>) => Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.withMutation(async () => {
      const fresh = (await this.store.readDay<Record<string, unknown>>(date)) ?? {}
      const next = fn({ ...fresh })
      await this.store.writeDay(date, next)
      return next
    })
  }

  /** 已在 mutation 队列内时使用：只读改写、不再次加锁 */
  private async patchDayUnlocked(
    date: string,
    fn: (day: Record<string, unknown>) => Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const fresh = (await this.store.readDay<Record<string, unknown>>(date)) ?? {}
    const next = fn({ ...fresh })
    await this.store.writeDay(date, next)
    return next
  }

  /** 串行化状态写：并发 interact/savePetState 不会互相覆盖（桌宠连点） */
  private async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 状态/设置变化后 ≤300ms 合并重写人格受管文件（STATE.md 即时；SOUL/AGENTS 用户改过则保留） */
  private schedulePersonaSync(): void {
    if (!this.personaSyncRunner) return
    // D8：未启用时不碰 workspace（避免「关着也在写人格文件」）
    if (!this.isEnabled()) return
    if (this.personaSyncTimer) clearTimeout(this.personaSyncTimer)
    this.personaSyncTimer = setTimeout(() => {
      this.personaSyncTimer = null
      void this.personaSyncRunner?.().catch((error) => {
        this.logger(
          `[character] 人格文件同步失败: ${(error as Error)?.message ?? String(error)}`
        )
      })
    }, 300)
  }

  private emit(event: CharacterEvent): void {
    try {
      this.onEvent?.(event)
    } catch (error) {
      this.logger(`[character] 事件推送失败: ${(error as Error)?.message ?? String(error)}`)
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
