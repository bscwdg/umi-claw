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
    if (!raw) return clone(DEFAULT_CHARACTER_SETTINGS)
    return mergeCharacterSettings(DEFAULT_CHARACTER_SETTINGS, raw)
  }

  async writeSettings(settings: CharacterSettings): Promise<void> {
    await this.kv.set(FISH_KEYS.settings, JSON.stringify(settings))
  }

  async readMeta(): Promise<CharacterMeta> {
    const raw = await this.readJson<Partial<CharacterMeta>>(FISH_KEYS.meta)
    if (!raw || typeof raw !== 'object') {
      return { schemaVersion: CHARACTER_SCHEMA_VERSION, days: [] }
    }
    return {
      schemaVersion:
        typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CHARACTER_SCHEMA_VERSION,
      days: Array.isArray(raw.days)
        ? raw.days.filter((x): x is string => typeof x === 'string').slice(-400)
        : []
    }
  }

  async writeMeta(meta: CharacterMeta): Promise<void> {
    await this.kv.set(FISH_KEYS.meta, JSON.stringify(meta))
  }

  /** 记录某天有数据（用于按日键的 GC；KV 无法枚举键，所以维护日期索引） */
  async noteDay(date: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    const meta = await this.readMeta()
    if (meta.days.includes(date)) return
    const candidates = [...meta.days, date]
    meta.days = this.pruneDates(candidates, this.dayRetentionDays)
    // 索引被清掉的日期（含刚写入但已超期的），其 day 键一并删除
    const keep = new Set(meta.days)
    for (const candidate of candidates) {
      if (!keep.has(candidate)) await this.kv.set(FISH_KEYS.day(candidate), null)
    }
    await this.writeMeta(meta)
  }

  /** 按保留策略清理旧 day/life 键；返回被清理的日期 */
  async prune(): Promise<{ removedDays: string[]; removedLife: string[] }> {
    const now = this.now()
    const meta = await this.readMeta()
    const keepDays = new Set(this.dateWindow(now, this.dayRetentionDays))
    const removedDays: string[] = []
    for (const date of meta.days) {
      if (!keepDays.has(date)) {
        await this.kv.set(FISH_KEYS.day(date), null)
        removedDays.push(date)
      }
    }
    meta.days = meta.days.filter((d) => keepDays.has(d))
    await this.writeMeta(meta)

    // life 键没有独立索引：用 day 索引的并集 + 今天，按 lifeRetention 判断
    const removedLife: string[] = []
    const keepLife = new Set(this.dateWindow(now, this.lifeRetentionDays))
    for (const date of keepDays) {
      if (!keepLife.has(date)) await this.kv.set(FISH_KEYS.life(date), null)
    }
    return { removedDays, removedLife }
  }

  async readDay<T = Record<string, unknown>>(date: string): Promise<T | null> {
    return this.readJson<T>(FISH_KEYS.day(date))
  }

  async writeDay(date: string, value: unknown): Promise<void> {
    await this.kv.set(FISH_KEYS.day(date), JSON.stringify(value))
    await this.noteDay(date)
  }

  async readLife<T = Record<string, unknown>>(date: string): Promise<T | null> {
    return this.readJson<T>(FISH_KEYS.life(date))
  }

  async writeLife(date: string, value: unknown): Promise<void> {
    await this.kv.set(FISH_KEYS.life(date), JSON.stringify(value))
  }

  async readPet(): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown>>(FISH_KEYS.pet)
  }

  async writePet(value: unknown): Promise<void> {
    await this.kv.set(FISH_KEYS.pet, JSON.stringify(value))
  }

  /** 清理角色数据（scope 语义见 CharacterResetOptions；agent/Obsidian 由 C09 处理） */
  async reset(scope: 'values' | 'memory' | 'all' = 'values'): Promise<void> {
    const meta = await this.readMeta()
    const dates = [...meta.days]
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
    }
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key)
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
