// electron/main/character/stickerStore.ts —— 表情包库（4.4）
//
// 为什么单独一个文件：表情包是「图片文件 + 元数据」的组合（图片落 <dataDir>/character/stickers/，
// 名称/情绪/标签/enabled 落 stickers.json），和 kv.json 里的角色状态不是一回事；
// QQ 发图（stickerSender）要按情绪挑一张，验收脚本也要能直接打真源码，所以保持纯 Node。
//
// 数据安全（与 memoryAdmin/persona 同口径）：
// - 只认魔数，不认扩展名/MIME（Windows 上 file.type 常为空，扩展名可以骗人）；
// - sha256 去重，最多 200 张、单张 ≤10MB（QQ 图片软限 20MB，这里留一半余量）；
// - 删除 = 归档到 <dataDir>/character/stickers-archive/<ts>/，不硬删；
// - 导入/恢复时文件名一律由宿主生成（<hash16>.<format>），不接受渲染端传入的路径。
//
// 通道常量为什么放这里而不是 types.ts：types.ts 正在被并行的 4.4 主动性改动占用，
// 这里先由特性模块自持，等合并后可以并回 CHARACTER_CHANNELS（IPC 名字本身已按
// `<domain>:<entity>:<method>` 规范）。

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { CharacterError, CHARACTER_ERROR_CODES } from './types'

/** 表情包 IPC（手动测试发送也走这里；主动消息接表情包由 manager/proactive 侧接线） */
export const CHARACTER_STICKER_CHANNELS = {
  list: 'character:stickers:list',
  preview: 'character:stickers:preview',
  import: 'character:stickers:import',
  pickImport: 'character:stickers:pickImport',
  update: 'character:stickers:update',
  delete: 'character:stickers:delete',
  send: 'character:stickers:send'
} as const

export const STICKER_DIR = 'stickers'
export const STICKER_META_FILE = 'stickers.json'
export const STICKER_ARCHIVE_DIR = 'stickers-archive'
export const STICKER_MAX_COUNT = 200
export const STICKER_MAX_BYTES = 10 * 1024 * 1024
/** 一次 IPC 最多带多少条（渲染端多选/路径数组）：只是防呆，不是业务上限 */
export const STICKER_MAX_IMPORT_BATCH = 500
export const STICKER_NAME_MAX = 40
export const STICKER_EMOTION_MAX = 20
export const STICKER_TAGS_MAX = 12
export const STICKER_TAG_MAX = 20

export type StickerFormat = 'png' | 'jpg' | 'gif' | 'webp'
export const STICKER_FORMATS: readonly StickerFormat[] = ['png', 'jpg', 'gif', 'webp']
/** 聊天/主动消息按情绪挑图时用的情绪词（自由文本仍允许，这里只做提示） */
export const STICKER_EMOTIONS = ['happy', 'shy', 'angry', 'sad', 'surprised', 'miss', 'sleepy'] as const

export interface StickerRecord {
  /** 稳定 id（sha256 前 16 位；同时是文件名主干） */
  id: string
  name: string
  /** stickers 目录内的文件名（宿主生成，渲染端不可构造） */
  file: string
  format: StickerFormat
  size: number
  hash: string
  /** 情绪词（如 happy/shy）；空 = 不参与情绪挑选 */
  emotion: string
  tags: string[]
  /** 使用次数（发送成功 +1，供「用得太少」挑选策略） */
  use: number
  enabled: boolean
  createdAt: number
  lastUsedAt: number
  /** 冷却到期时间（保留字段：主动消息侧接入后用它避免连续发同一张） */
  cooldownUntil: number
}

export interface StickerImportFailure {
  /** 原始文件名（失败也要让用户知道是哪张） */
  name: string
  reason: string
}

export interface StickerImportResult {
  imported: StickerRecord[]
  failed: StickerImportFailure[]
  /** 导入后的总数（含已存在的） */
  total: number
}

export interface StickerImportInput {
  /** 本地文件路径（优先；渲染端通过宿主文件选择框拿到） */
  paths?: string[]
  /** base64（兜底：无法拿到真实路径时用；不含 data: 前缀也可以） */
  files?: Array<{ name?: string; dataBase64?: string }>
}

export interface StickerUpdatePatch {
  name?: unknown
  emotion?: unknown
  tags?: unknown
  enabled?: unknown
}

export interface StickerStoreOptions {
  /** 应用数据目录（<dataDir>/character/ 下存） */
  dataDir: string
  now?: () => number
}

export interface StickerStore {
  list(): Promise<StickerRecord[]>
  get(id: string): Promise<StickerRecord | null>
  import(input: StickerImportInput): Promise<StickerImportResult>
  update(id: string, patch: StickerUpdatePatch): Promise<StickerRecord>
  remove(id: string): Promise<{ archivedTo: string }>
  /** 渲染端缩略图用：返回绝对路径（不把大图 base64 塞进 list） */
  previewTarget(id: string): Promise<{ filePath: string; name: string; format: StickerFormat; size: number } | null>
  /** 按情绪挑一张（enabled + 未在冷却；优先用得少、最近没用过的） */
  pickByEmotion(emotion: string): Promise<StickerRecord | null>
  markUsed(id: string, now?: number): Promise<void>
  /** 表情包根路径（备份/导入复用，避免两份路径推导逻辑） */
  paths(): { dir: string; metaPath: string; archiveRoot: string }
}

/** 角色目录下的表情包路径：stickers/ + stickers.json + stickers-archive/ */
export function stickerPaths(dataDir: string): {
  characterDir: string
  dir: string
  metaPath: string
  archiveRoot: string
} {
  const characterDir = join(dataDir, 'character')
  return {
    characterDir,
    dir: join(characterDir, STICKER_DIR),
    metaPath: join(characterDir, STICKER_META_FILE),
    archiveRoot: join(characterDir, STICKER_ARCHIVE_DIR)
  }
}

/** 魔数识别：只认真正的栅格图（PNG/JPEG/GIF/WebP），扩展名/MIME 都不算数 */
export function detectImageFormat(bytes: Uint8Array): StickerFormat | null {
  if (!bytes || bytes.byteLength < 12) return null
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'png'
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 显示名消毒：去控制符/路径分隔符/花括号，压空白，限长；空则回退「表情」 */
export function sanitizeStickerName(raw: unknown, fallback = '表情'): string {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[\\/:*?"<>|{}#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STICKER_NAME_MAX)
  return cleaned || fallback
}

/** 情绪词消毒：小写、去空白/特殊符号；允许自由文本（不强制枚举） */
export function sanitizeEmotion(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[{}#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, STICKER_EMOTION_MAX)
}

/** 标签消毒：数组或逗号字符串 → 去重、去空、限个数 */
export function sanitizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[，,]/)
      : []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = item
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
      .replace(/[{}#]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, STICKER_TAG_MAX)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= STICKER_TAGS_MAX) break
  }
  return out
}

/** 显示名：文件名去扩展名再消毒（「开心.png」→「开心」；没有名字时回退「表情」） */
function stickerDisplayName(rawName: string): string {
  const base = basename(String(rawName ?? ''))
  const ext = extname(base)
  const stem = ext ? base.slice(0, base.length - ext.length) : base
  return sanitizeStickerName(stem, '表情')
}

/** 文件名白名单：只接受 basename 形态的 `<id>.<ext>`（备份/恢复时也不接受任何路径） */
export function sanitizeStickerFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name !== basename(name)) return null
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null
  const ext = extname(name).slice(1).toLowerCase()
  if (!STICKER_FORMATS.includes(ext as StickerFormat)) return null
  const stem = name.slice(0, name.length - ext.length - 1)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stem)) return null
  return `${stem}.${ext}`
}

/**
 * 元数据记录校验（读盘 / 备份导入共用）。
 * 校验不过的记录直接丢弃：坏记录留着会让 UI 指向不存在的文件，比少一张更糟。
 */
export function sanitizeStickerRecord(raw: unknown): StickerRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const id = typeof src.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(src.id) ? src.id : ''
  const file = sanitizeStickerFileName(src.file)
  const format = file ? (extname(file).slice(1).toLowerCase() as StickerFormat) : null
  const hash = typeof src.hash === 'string' && /^[0-9a-f]{64}$/i.test(src.hash) ? src.hash.toLowerCase() : ''
  const size = typeof src.size === 'number' && Number.isFinite(src.size) && src.size >= 0 ? Math.floor(src.size) : -1
  if (!id || !file || !format || !hash || size < 0) return null
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  return {
    id,
    name: sanitizeStickerName(src.name, '表情'),
    file,
    format,
    size,
    hash,
    emotion: sanitizeEmotion(src.emotion),
    tags: sanitizeTags(src.tags),
    use: num(src.use),
    enabled: src.enabled !== false,
    createdAt: num(src.createdAt),
    lastUsedAt: num(src.lastUsedAt),
    cooldownUntil: num(src.cooldownUntil)
  }
}

/** 原子写文本（临时文件 + rename），避免半截 json 把表情包库写坏 */
function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, absPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    writeFileSync(absPath, content, 'utf8')
  }
}

function decodeBase64(input: string): Buffer {
  const raw = String(input ?? '').replace(/^data:[^;]*;base64,/i, '').trim()
  if (!raw) return Buffer.alloc(0)
  // Node 对非法字符是「尽力解码」：解码后长度会明显偏小，仍交给魔数/大小校验兜底
  return Buffer.from(raw, 'base64')
}

export function createStickerStore(options: StickerStoreOptions): StickerStore {
  const now = options.now ?? Date.now
  const paths = stickerPaths(options.dataDir)
  /** 写读串行化：两个 IPC 同时改表情包库时不互相覆盖（读改写 json 是典型竞态） */
  let queue: Promise<unknown> = Promise.resolve()

  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const readAllSync = (): StickerRecord[] => {
    let raw = ''
    try {
      raw = readFileSync(paths.metaPath, 'utf8')
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { stickers?: unknown }).stickers)
        ? ((parsed as { stickers: unknown[] }).stickers as unknown[])
        : []
    const seen = new Set<string>()
    const out: StickerRecord[] = []
    for (const item of list) {
      const record = sanitizeStickerRecord(item)
      if (!record) continue
      if (seen.has(record.id)) continue
      seen.add(record.id)
      out.push(record)
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    return out
  }

  const writeAllSync = (list: StickerRecord[]): void => {
    writeAtomic(paths.metaPath, `${JSON.stringify(list, null, 2)}\n`)
  }

  const filePathOf = (record: StickerRecord): string => join(paths.dir, record.file)

  const uniqueArchiveDir = (stamp: number): string => {
    let target = join(paths.archiveRoot, String(stamp))
    let suffix = 1
    while (existsSync(target)) {
      target = join(paths.archiveRoot, `${stamp}-${suffix}`)
      suffix += 1
    }
    return target
  }

  const importOne = (
    existing: StickerRecord[],
    seenHashes: Set<string>,
    seenIds: Set<string>,
    item: { name: string; bytes: Uint8Array }
  ): { record?: StickerRecord; reason?: string } => {
    const bytes = item.bytes
    if (!bytes || bytes.byteLength === 0) return { reason: '文件为空或无法读取' }
    if (bytes.byteLength > STICKER_MAX_BYTES) {
      return { reason: `超过 ${STICKER_MAX_BYTES / 1024 / 1024}MB 上限` }
    }
    const format = detectImageFormat(bytes)
    if (!format) return { reason: '不是支持的图片（只认 PNG/JPEG/GIF/WebP 魔数）' }
    const hash = sha256Bytes(bytes)
    if (seenHashes.has(hash)) return { reason: '重复（相同 sha256 已存在）' }
    if (existing.length >= STICKER_MAX_COUNT) {
      return { reason: `已达到 ${STICKER_MAX_COUNT} 张上限` }
    }
    let id = hash.slice(0, 16)
    let salt = 1
    while (seenIds.has(id)) {
      // 理论碰撞才会走到这里：后缀换一段 hash，仍保证文件名安全
      id = hash.slice(salt * 4, salt * 4 + 16)
      salt += 1
      if (salt > 8) return { reason: '生成 id 失败（hash 冲突异常）' }
    }
    const file = `${id}.${format}`
    const abs = join(paths.dir, file)
    try {
      mkdirSync(paths.dir, { recursive: true })
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, bytes)
      renameSync(tmp, abs)
    } catch (error) {
      return { reason: `写入失败：${(error as Error)?.message ?? String(error)}` }
    }
    const record: StickerRecord = {
      id,
      name: sanitizeStickerName(item.name, '表情'),
      file,
      format,
      size: bytes.byteLength,
      hash,
      emotion: '',
      tags: [],
      use: 0,
      enabled: true,
      createdAt: now(),
      lastUsedAt: 0,
      cooldownUntil: 0
    }
    return { record }
  }

  return {
    paths() {
      return { dir: paths.dir, metaPath: paths.metaPath, archiveRoot: paths.archiveRoot }
    },

    async list() {
      return readAllSync()
    },

    async get(id: string) {
      if (typeof id !== 'string' || !id) return null
      return readAllSync().find((record) => record.id === id) ?? null
    },

    import(input: StickerImportInput) {
      return withLock(async () => {
        const pathsIn = Array.isArray(input?.paths)
          ? input.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : []
        const filesIn = Array.isArray(input?.files) ? input.files : []
        if (pathsIn.length + filesIn.length > STICKER_MAX_IMPORT_BATCH) {
          throw new CharacterError(
            CHARACTER_ERROR_CODES.BAD_PAYLOAD,
            `一次最多导入 ${STICKER_MAX_IMPORT_BATCH} 个文件，请分批`
          )
        }
        const existing = readAllSync()
        const seenHashes = new Set(existing.map((record) => record.hash))
        const seenIds = new Set(existing.map((record) => record.id))
        const imported: StickerRecord[] = []
        const failed: StickerImportFailure[] = []

        for (const filePath of pathsIn) {
          const displayName = stickerDisplayName(filePath)
          let bytes: Buffer
          try {
            const info = statSync(filePath)
            if (!info.isFile()) {
              failed.push({ name: displayName, reason: '不是文件' })
              continue
            }
            if (info.size > STICKER_MAX_BYTES) {
              failed.push({
                name: displayName,
                reason: `超过 ${STICKER_MAX_BYTES / 1024 / 1024}MB 上限`
              })
              continue
            }
            bytes = readFileSync(filePath)
          } catch {
            failed.push({ name: displayName, reason: '文件不存在或不可读' })
            continue
          }
          const result = importOne(
            [...existing, ...imported],
            seenHashes,
            seenIds,
            { name: displayName, bytes }
          )
          if (result.record) {
            imported.push(result.record)
            seenHashes.add(result.record.hash)
            seenIds.add(result.record.id)
          } else {
            failed.push({ name: displayName, reason: result.reason ?? '导入失败' })
          }
        }

        for (const file of filesIn) {
          const displayName =
            typeof file?.name === 'string' ? stickerDisplayName(file.name) : '表情'
          const bytes = decodeBase64(String(file?.dataBase64 ?? ''))
          const result = importOne(
            [...existing, ...imported],
            seenHashes,
            seenIds,
            { name: displayName, bytes }
          )
          if (result.record) {
            imported.push(result.record)
            seenHashes.add(result.record.hash)
            seenIds.add(result.record.id)
          } else {
            failed.push({ name: displayName, reason: result.reason ?? '导入失败' })
          }
        }

        if (imported.length) writeAllSync([...existing, ...imported])
        return { imported, failed, total: existing.length + imported.length }
      })
    },

    update(id: string, patch: StickerUpdatePatch) {
      return withLock(async () => {
        const list = readAllSync()
        const index = list.findIndex((record) => record.id === id)
        if (index < 0) {
          throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '表情包不存在（可能已被删除）')
        }
        const current = list[index]
        const next: StickerRecord = { ...current }
        if (patch && typeof patch === 'object') {
          if (patch.name !== undefined) next.name = sanitizeStickerName(patch.name, current.name)
          if (patch.emotion !== undefined) next.emotion = sanitizeEmotion(patch.emotion)
          if (patch.tags !== undefined) next.tags = sanitizeTags(patch.tags)
          if (patch.enabled !== undefined) next.enabled = patch.enabled === true
        }
        list[index] = next
        writeAllSync(list)
        return next
      })
    },

    remove(id: string) {
      return withLock(async () => {
        const list = readAllSync()
        const index = list.findIndex((record) => record.id === id)
        if (index < 0) {
          throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '表情包不存在（可能已被删除）')
        }
        const record = list[index]
        const archiveDir = uniqueArchiveDir(now())
        mkdirSync(archiveDir, { recursive: true })
        try {
          const abs = filePathOf(record)
          if (existsSync(abs)) renameSync(abs, join(archiveDir, record.file))
        } catch (error) {
          throw new CharacterError(
            CHARACTER_ERROR_CODES.STORE_IO,
            `归档表情包文件失败（未删除记录）：${(error as Error)?.message ?? String(error)}`
          )
        }
        writeAtomic(join(archiveDir, STICKER_META_FILE), `${JSON.stringify([record], null, 2)}\n`)
        list.splice(index, 1)
        writeAllSync(list)
        return { archivedTo: archiveDir }
      })
    },

    async previewTarget(id: string) {
      const record = await this.get(id)
      if (!record) return null
      return {
        filePath: filePathOf(record),
        name: record.name,
        format: record.format,
        size: record.size
      }
    },

    async pickByEmotion(emotion: string) {
      const target = sanitizeEmotion(emotion)
      if (!target) return null
      const at = now()
      const candidates = readAllSync().filter(
        (record) => record.enabled && record.emotion === target && record.cooldownUntil <= at
      )
      if (!candidates.length) return null
      candidates.sort((a, b) => a.use - b.use || a.lastUsedAt - b.lastUsedAt)
      return candidates[0]
    },

    markUsed(id: string, at?: number) {
      return withLock(async () => {
        const list = readAllSync()
        const record = list.find((item) => item.id === id)
        if (!record) return
        record.use += 1
        record.lastUsedAt = typeof at === 'number' && Number.isFinite(at) ? Math.floor(at) : now()
        writeAllSync(list)
      })
    }
  }
}
