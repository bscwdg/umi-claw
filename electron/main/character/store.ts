// electron/main/character/store.ts —— fish:v2:* 读写（注入 KV，纯 Node 可测）
//
// 与 voice 同口径：数据只在宿主 app_meta（work.db），不新增表。
// 坏值一律回落默认值并记 owner 错误，不抛给调用方（除显式 IO 错误）。

import {
  CHARACTER_SCHEMA_VERSION,
  DEFAULT_CHARACTER_SETTINGS,
  FISH_KEYS,
  createDefaultCharacterState,
  mergeCharacterSettings,
  type CharacterKv,
  type CharacterMeta,
  type CharacterSettings,
  type CharacterState
} from './types'

export interface CharacterStoreOptions {
  kv: CharacterKv
  now?: () => number
  /** 保留多少天的 day/life 记录（默认 90 / 30） */
  dayRetentionDays?: number
  lifeRetentionDays?: number
}

export class CharacterStore {
  private readonly kv: CharacterKv
  private readonly now: () => number
  private readonly dayRetentionDays: number
  private readonly lifeRetentionDays: number
  private metaQueue: Promise<void> = Promise.resolve()

  constructor(options: CharacterStoreOptions) {
    this.kv = options.kv
    this.now = options.now ?? Date.now
    this.dayRetentionDays = options.dayRetentionDays ?? 90
    this.lifeRetentionDays = options.lifeRetentionDays ?? 30
  }

  async readState(): Promise<CharacterState> {
    const raw = await this.readJson<Partial<CharacterState>>(FISH_KEYS.state)
    const base = createDefaultCharacterState(this.now())
    if (!raw || typeof raw !== 'object') return base
    return sanitizeState(raw, base)
  }

  async writeState(state: CharacterState): Promise<void> {
    await this.kv.set(FISH_KEYS.state, JSON.stringify(state))
  }

  async readSettings(): Promise<CharacterSettings> {
    const raw = await this.readJson<unknown>(FISH_KEYS.settings)
    // 始终以「默认值的深拷贝」为基底：坏值回退不会让调用方拿到模块级默认对象本体
    if (!raw) return clone(DEFAULT_CHARACTER_SETTINGS)
    return mergeCharacterSettings(clone(DEFAULT_CHARACTER_SETTINGS), raw)
  }

  async writeSettings(settings: CharacterSettings): Promise<void> {
    await this.kv.set(FISH_KEYS.settings, JSON.stringify(settings))
  }

  async readMeta(): Promise<CharacterMeta> {
    const raw = await this.readJson<Partial<CharacterMeta>>(FISH_KEYS.meta)
    if (!raw || typeof raw !== 'object') {
      return { schemaVersion: CHARACTER_SCHEMA_VERSION, days: [], lifeDays: [] }
    }
    return {
      schemaVersion:
        typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CHARACTER_SCHEMA_VERSION,
      days: Array.isArray(raw.days)
        ? raw.days.filter((x): x is string => typeof x === 'string' && isDateKey(x)).slice(-400)
        : [],
      lifeDays: Array.isArray(raw.lifeDays)
        ? raw.lifeDays
            .filter((x): x is string => typeof x === 'string' && isDateKey(x))
            .slice(-400)
        : []
    }
  }

  async writeMeta(meta: CharacterMeta): Promise<void> {
    await this.kv.set(FISH_KEYS.meta, JSON.stringify(meta))
  }

  /** 记录某天有数据（用于按日键的 GC；KV 无法枚举键，所以维护日期索引） */
  async noteDay(date: string): Promise<void> {
    await this.withMetaLock(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
      const meta = await this.readMeta()
      if (meta.days.includes(date)) return
      const candidates = [...meta.days, date]
      meta.days = this.pruneDates(candidates, this.dayRetentionDays)
      const keep = new Set(meta.days)
      for (const candidate of candidates) {
        if (!keep.has(candidate)) await this.kv.set(FISH_KEYS.day(candidate), null)
      }
      await this.writeMeta(meta)
    })
  }

  /** 按保留策略清理旧 day/life 键；返回被清理的日期 */
  async prune(): Promise<{ removedDays: string[]; removedLife: string[] }> {
    return this.withMetaLock(async () => {
      const now = this.now()
      const meta = await this.readMeta()
      const keepDays = new Set(this.dateWindow(now, this.dayRetentionDays))
      const keepLife = new Set(this.dateWindow(now, this.lifeRetentionDays))
      const removedDays: string[] = []
      for (const date of meta.days) {
        if (!keepDays.has(date)) {
          await this.kv.set(FISH_KEYS.day(date), null)
          removedDays.push(date)
        }
      }
      const removedLife: string[] = []
      // 老版本没有 lifeDays 索引：用 days 与今天补齐后再按 life 保留期清理
      const lifeCandidates = new Set([...meta.lifeDays, ...meta.days, formatDate(now)])
      for (const date of lifeCandidates) {
        if (!keepLife.has(date)) {
          await this.kv.set(FISH_KEYS.life(date), null)
          removedLife.push(date)
        }
      }
      meta.days = meta.days.filter((d) => keepDays.has(d))
      meta.lifeDays = [...lifeCandidates].filter((d) => keepLife.has(d))
      await this.writeMeta(meta)
      return { removedDays, removedLife }
    })
  }

  async readDay<T = Record<string, unknown>>(date: string): Promise<T | null> {
    return this.readJson<T>(FISH_KEYS.day(date))
  }

  async writeDay(date: string, value: unknown): Promise<void> {
    if (!isDateKey(date)) throw new Error(`非法日期: ${date}`)
    // 超出保留窗口的日期不写（否则刚写完就被 GC 静默删掉，反而是数据丢失）
    const keep = new Set(this.dateWindow(this.now(), this.dayRetentionDays))
    if (!keep.has(date)) throw new Error(`日期超出保留窗口（${this.dayRetentionDays} 天）: ${date}`)
    await this.kv.set(FISH_KEYS.day(date), JSON.stringify(value))
    await this.noteDay(date)
  }

  async readLife<T = Record<string, unknown>>(date: string): Promise<T | null> {
    return this.readJson<T>(FISH_KEYS.life(date))
  }

  async writeLife(date: string, value: unknown): Promise<void> {
    if (!isDateKey(date)) throw new Error(`非法日期: ${date}`)
    const keep = new Set(this.dateWindow(this.now(), this.lifeRetentionDays))
    if (!keep.has(date)) {
      throw new Error(`日期超出保留窗口（${this.lifeRetentionDays} 天）: ${date}`)
    }
    await this.withMetaLock(async () => {
      await this.kv.set(FISH_KEYS.life(date), JSON.stringify(value))
      const meta = await this.readMeta()
      if (!meta.lifeDays.includes(date)) meta.lifeDays.push(date)
      const keepNow = new Set(this.dateWindow(this.now(), this.lifeRetentionDays))
      const dropped = meta.lifeDays.filter((d) => !keepNow.has(d))
      for (const d of dropped) await this.kv.set(FISH_KEYS.life(d), null)
      meta.lifeDays = meta.lifeDays.filter((d) => keepNow.has(d))
      await this.writeMeta(meta)
    })
  }

  async readPet(): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown>>(FISH_KEYS.pet)
  }

  async writePet(value: unknown): Promise<void> {
    await this.kv.set(FISH_KEYS.pet, JSON.stringify(value))
  }

  /** 聊天会话代际：清空聊天 = 轮换代际（旧上下文自然失效，日记/记忆不受影响） */
  async readChatGeneration(): Promise<number> {
    const raw = await this.readJson<{ gen?: number }>(FISH_KEYS.chatGen)
    const gen = typeof raw?.gen === 'number' && Number.isFinite(raw.gen) ? Math.floor(raw.gen) : 1
    return gen >= 1 ? gen : 1
  }

  async writeChatGeneration(gen: number): Promise<void> {
    const safe = Number.isFinite(gen) && gen >= 1 ? Math.floor(gen) : 1
    await this.kv.set(FISH_KEYS.chatGen, JSON.stringify({ gen: safe }))
  }

  /** 清理角色数据（scope 语义见 CharacterResetOptions；agent/Obsidian 由 C09 处理） */
  async reset(scope: 'values' | 'memory' | 'all' = 'values'): Promise<void> {
    const meta = await this.readMeta()
    const dates = [...new Set([...meta.days, ...meta.lifeDays])]
    if (scope === 'values') {
      await this.kv.set(FISH_KEYS.state, null)
      return
    }
    await this.kv.set(FISH_KEYS.state, null)
    await this.kv.set(FISH_KEYS.dedup, null)
    await this.kv.set(FISH_KEYS.unlocks, null)
    for (const date of dates) {
      await this.kv.set(FISH_KEYS.day(date), null)
      await this.kv.set(FISH_KEYS.life(date), null)
    }
    await this.kv.set(FISH_KEYS.meta, null)
    if (scope === 'all') {
      await this.kv.set(FISH_KEYS.settings, null)
      await this.kv.set(FISH_KEYS.pet, null)
      // 清空全部 = 上下文也不该复活：轮换聊天代际
      await this.kv.set(FISH_KEYS.chatGen, null)
    }
  }

  /** meta 读改写串行化：并发 noteDay/writeLife 不会互相覆盖索引 */
  private async withMetaLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.metaQueue.then(fn, fn)
    this.metaQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async readJson<T>(key: string): Promise<T | null> {    const raw = await this.kv.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private pruneDates(dates: string[], retentionDays: number): string[] {
    const keep = new Set(this.dateWindow(this.now(), retentionDays))
    return dates.filter((d) => keep.has(d))
  }

  private dateWindow(now: number, retentionDays: number): string[] {
    const out: string[] = []
    for (let i = 0; i < retentionDays; i += 1) {
      out.push(formatDate(now - i * 86_400_000))
    }
    return out
  }
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function sanitizeState(raw: Partial<CharacterState>, base: CharacterState): CharacterState {
  const n = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const stage = n(raw.stage, base.stage)
  return {
    bornAt: n(raw.bornAt, base.bornAt),
    stage: (Math.min(4, Math.max(0, Math.round(stage))) as CharacterState['stage']),
    familiarity: Math.min(100, Math.max(0, Math.round(n(raw.familiarity, 0)))),
    intimacy: Math.min(100, Math.max(0, Math.round(n(raw.intimacy, 0)))),
    streakDays: Math.max(0, Math.round(n(raw.streakDays, 0))),
    lastInteractionAt: Math.max(0, n(raw.lastInteractionAt, 0)),
    addressForm: typeof raw.addressForm === 'string' && raw.addressForm.trim() ? raw.addressForm.trim().slice(0, 40) : base.addressForm,
    mood: typeof raw.mood === 'string' ? raw.mood.slice(0, 40) : base.mood,
    updatedAt: n(raw.updatedAt, base.updatedAt)
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
