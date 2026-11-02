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
//   `importAllFromLegacy()` 从宿主的 `fish:v2:*` 键搬过来，用**标记文件**保证只跑一次。
//   首次导入以旧库为权威：目标里已有的同名键会被旧值覆盖——因为 4.0 开发期曾有一版
//   先写默认值再（本该）导入的顺序，目标可能已被默认值污染；只跳过会让旧记忆永远搬不过来。
//   读旧库失败时不写标记，下次启动重试（宁可重读，不可漏搬）。
//   首次导入前会把现有 kv.json 备份为 `kv.json.pre-import.bak`（覆盖是有意的：旧库是权威，
//   但开发期旧构建可能已写入新进度，留一份可人工找回）。
//   旧键保留只读一个版本（不删），出问题时可回滚。

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

/** 一次性导入标记（与 kv.json 同目录）：存在即不再从旧库读 */
const LEGACY_IMPORT_MARKER = 'legacy-import.json'

export interface LegacyImportResult {
  /** 本次真正写入的键 */
  imported: string[]
  /** 旧库没有值 / 与目标已一致的键 */
  skipped: string[]
  /** 标记文件已存在，本次完全跳过 */
  alreadyDone: boolean
}

export class CharacterKvStore implements CharacterKv {
  private readonly filePath: string
  private readonly markerPath: string
  private cache: KvMap | null = null
  private readonly legacy?: LegacyCharacterKv
  private readonly logger: (message: string) => void

  constructor(options: CharacterKvStoreOptions) {
    this.filePath = join(options.dataDir, 'character', 'kv.json')
    this.markerPath = join(options.dataDir, 'character', LEGACY_IMPORT_MARKER)
    this.legacy = options.legacy
    this.logger = options.logger ?? ((m) => console.log(m))
  }

  /** 一次性导入是否已完成（排障 / 验收用） */
  hasImportedLegacy(): boolean {
    return existsSync(this.markerPath)
  }

  private writeImportMarker(imported: string[]): void {
    const dir = dirname(this.markerPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = this.markerPath + '.tmp'
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, importedAt: new Date().toISOString(), imported }, null, 2),
      'utf8'
    )
    renameSync(tmp, this.markerPath)
  }

  /** 读取导入标记（排障：标记里记着导入过哪些键，用来判断 kv.json 是否被弄丢） */
  private readMarker(): { imported: string[] } | null {
    try {
      const parsed = JSON.parse(readFileSync(this.markerPath, 'utf8')) as { imported?: unknown }
      return {
        imported: Array.isArray(parsed.imported)
          ? parsed.imported.filter((k): k is string => typeof k === 'string')
          : []
      }
    } catch {
      return null
    }
  }

  /** 首导会覆盖目标键，先留一份被覆盖前的 kv.json（备份失败不阻断导入） */
  private backupBeforeImport(): void {
    if (!existsSync(this.filePath)) return
    try {
      copyFileSync(this.filePath, this.filePath + '.pre-import.bak')
    } catch (e) {
      this.logger(
        `[character] 导入前备份 kv.json 失败（继续导入）: ${(e as Error)?.message ?? String(e)}`
      )
    }
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
   * 把旧库里的角色数据整体搬入（一次性；标记文件保证只跑一次）。
   *
   * 为什么不能只搬「已知常量键」：`day:` / `life:` 是按日期生成的，
   * 日期列表本身存在 `meta` 的 days / lifeDays 字段里。所以先读 meta，
   * 解析出日期，再拼出完整键清单。
   *
   * 为什么是「旧库值覆盖目标」而不是「目标已有就跳过」：
   * 4.0 开发期有一版先读默认值再导入的顺序，目标 json 可能已被默认值占住；
   * 若跳过，旧记忆永远搬不过来（2026-11-02 实测本机 work.db 有 8 个旧键、
   * kv.json 只有 3 个默认键）。首次导入以旧库为权威，之后靠标记文件不再覆盖。
   *
   * 读旧库失败时不写标记：宁可下次重读，不可把「临时故障」变成「永久漏搬」。
   */
  async importAllFromLegacy(): Promise<LegacyImportResult> {
    const legacy = this.legacy
    if (!legacy) return { imported: [], skipped: [], alreadyDone: false }
    if (existsSync(this.markerPath)) {
      // 标记存在但 kv.json 被删/清空：不能永久跳过，否则旧数据永远回不来
      const marker = this.readMarker()
      const current = this.load()
      const lost =
        marker !== null &&
        marker.imported.length > 0 &&
        marker.imported.every((key) => !(key in current))
      if (!lost) return { imported: [], skipped: [], alreadyDone: true }
      this.logger('[character] 导入标记存在但 kv.json 已丢失/清空，重新执行一次导入')
    }

    const map = { ...this.load() }
    const imported: string[] = []
    const skipped: string[] = []
    let readErrors = 0

    const adopt = async (key: string): Promise<void> => {
      let value: string | null = null
      try {
        value = (await legacy.get(key)) ?? null
      } catch (e) {
        readErrors++
        this.logger(
          `[character] 旧数据键 ${key} 读取失败，本次不写导入标记（下次启动重试）：${
            (e as Error)?.message ?? String(e)
          }`
        )
        return
      }
      if (value === null) {
        skipped.push(key)
        return
      }
      if (map[key] === value) {
        skipped.push(key)
        return
      }
      map[key] = value
      imported.push(key)
    }

    // meta 优先：日期列表在它里面
    await adopt('fish:v2:meta')
    const source = map['fish:v2:meta']
    let days: string[] = []
    let lifeDays: string[] = []
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

    for (const k of ['state', 'settings', 'unlocks', 'dedup', 'pet', 'chatgen']) {
      await adopt('fish:v2:' + k)
    }
    for (const d of days) await adopt('fish:v2:day:' + d)
    for (const d of lifeDays) await adopt('fish:v2:life:' + d)

    if (imported.length) {
      this.backupBeforeImport()
      this.flush(map)
    }
    if (readErrors === 0) this.writeImportMarker(imported)
    return { imported, skipped, alreadyDone: false }
  }

  /** 已存在的键（排障 / 验收用） */
  async keys(): Promise<string[]> {
    return Object.keys(this.load()).sort()
  }
}
