// electron/main/services/characterKv.ts —— 角色数据的独立存储（WP4 C4.2）
//
// 为什么单独一个库：角色数据原先落宿主 `work.db` 的 `app_meta`（键前缀 `fish:v2:`），
// 但 work 域数据早在 Phase 2 就搬到了 `plugins/work/data.db`，宿主 `work.db` 只为
// voice + character + wizard 活着——「每插件独立库」在这里是半吊子。
//
// 现在角色有自己的 `<dataDir>/character/kv.json`：
//   - 与 work 域、voice 完全解耦（work 插件停用/重装不影响角色记忆）
//   - 仍是纯 KV（角色数据量小：state/settings/meta/unlocks/dedup/pet/chatgen + 按日的
//     day:/life:），不引入 SQLite 依赖
//
// 旧数据迁移（C4.2 的一次性导入）:
//   `importFromLegacy()` 从宿主的 `fish:v2:*` 键搬过来，**幂等**：目标键已存在就跳过。
//   旧键保留只读一个版本（不删），出问题时可回滚。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { CharacterKv } from '../character/types'

/** 旧数据来源：宿主 work.db 的 app_meta 读取器 */
export interface LegacyCharacterKv {
  get(key: string): Promise<string | null>
}

export interface CharacterKvStoreOptions {
  dataDir: string
  /** 旧库读取器（一次性导入用；缺省表示全新安装） */
  legacy?: LegacyCharacterKv
  logger?: (message: string) => void
}

type KvMap = Record<string, string>

const FISH_PREFIX = 'fish:v2:'

export class CharacterKvStore implements CharacterKv {
  private readonly filePath: string
  private cache: KvMap | null = null
  private readonly legacy?: LegacyCharacterKv
  private readonly logger: (message: string) => void

  constructor(options: CharacterKvStoreOptions) {
    this.filePath = join(options.dataDir, 'character', 'kv.json')
    this.legacy = options.legacy
    this.logger = options.logger ?? ((m) => console.log(m))
  }

  private load(): KvMap {
    if (this.cache) return this.cache
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const out: KvMap = {}
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v
        }
      }
      this.cache = out
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private flush(map: KvMap): void {
    this.cache = map
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  async get(key: string): Promise<string | null> {
    if (!key) throw new Error('get 需要 key')
    const map = this.load()
    const value = map[key]
    return typeof value === 'string' ? value : null
  }

  async set(key: string, value: string | null): Promise<{ changes: number }> {
    if (!key) throw new Error('set 需要 key')
    const map = { ...this.load() }
    if (value === null) {
      delete map[key]
    } else {
      map[key] = value
    }
    this.flush(map)
    return { changes: 1 }
  }

  /**
   * 把旧库里的角色数据整体搬入（幂等）。
   *
   * 为什么不能只搬「已知常量键」：`day:` / `life:` 是按日期生成的，
   * 日期列表本身存在 `meta` 的 days / lifeDays 字段里。所以先读 meta，
   * 解析出日期，再拼出完整键清单。
   */
  async importAllFromLegacy(): Promise<{ imported: string[]; skipped: string[] }> {
    if (!this.legacy) return { imported: [], skipped: [] }

    const map = { ...this.load() }
    const keys: string[] = []
    const firstImported: string[] = []
    const base = ['meta', 'state', 'settings', 'unlocks', 'dedup', 'pet', 'chatgen']

    // meta 优先：日期列表在它里面
    let metaRaw: string | null = null
    if (!('fish:v2:meta' in map)) {
      try {
        metaRaw = await this.legacy.get('fish:v2:meta')
      } catch {
        metaRaw = null
      }
      if (metaRaw) {
        map['fish:v2:meta'] = metaRaw
        firstImported.push('fish:v2:meta')
      }
    }

    let days: string[] = []
    let lifeDays: string[] = []
    const source = metaRaw ?? map['fish:v2:meta']
    if (source) {
      try {
        const parsed = JSON.parse(source) as { days?: unknown; lifeDays?: unknown }
        if (Array.isArray(parsed.days)) days = parsed.days.filter((d) => typeof d === 'string')
        if (Array.isArray(parsed.lifeDays)) {
          lifeDays = parsed.lifeDays.filter((d) => typeof d === 'string')
        }
      } catch {
        this.logger('[character] 旧 meta 无法解析，仅迁移常量键与已有日期键')
      }
    }

    for (const k of base) if (k !== 'meta') keys.push('fish:v2:' + k)
    for (const d of days) keys.push('fish:v2:day:' + d)
    for (const d of lifeDays) keys.push('fish:v2:life:' + d)

    // 若 meta 已在首次读取时搬走，这里只处理其余键
    const imported: string[] = [...firstImported]
    const skipped: string[] = []
    for (const key of keys) {
      if (key in map) {
        skipped.push(key)
        continue
      }
      try {
        const value = await this.legacy.get(key)
        if (value === null || value === undefined) continue
        map[key] = value
        imported.push(key)
      } catch (e) {
        this.logger(
          `[character] 旧数据键 ${key} 迁移失败，使用默认值：${(e as Error)?.message ?? String(e)}`
        )
      }
    }
    if (imported.length) this.flush(map)
    return { imported, skipped }
  }

  /** 已存在的键（排障 / 验收用） */
  async keys(): Promise<string[]> {
    return Object.keys(this.load()).sort()
  }

  /**
   * 一次性从宿主 work.db 的 `fish:v2:*` 搬入（幂等）。
   *
   * 幂等策略：目标已有该键就跳过——重复调用不会覆盖用户在角色启用后产生的新状态。
   * 返回搬运明细，供 PROGRESS / 排障使用。
   */
  async importFromLegacy(keys: string[]): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = []
    const skipped: string[] = []
    if (!this.legacy) return { imported, skipped }

    const map = { ...this.load() }
    for (const key of keys) {
      if (!key.startsWith(FISH_PREFIX)) continue
      if (key in map) {
        skipped.push(key)
        continue
      }
      try {
        const value = await this.legacy.get(key)
        if (value === null || value === undefined) continue
        map[key] = value
        imported.push(key)
      } catch (e) {
        // 单键失败不阻断整体：角色照常可用，缺的那一项走默认值
        this.logger(
          `[character] 旧数据键 ${key} 迁移失败，使用默认值：${(e as Error)?.message ?? String(e)}`
        )
      }
    }
    if (imported.length) this.flush(map)
    return { imported, skipped }
  }
}
