// electron/main/character/backupBundle.ts —— 大肥鱼单文件备份/导入（4.4）
//
// 为什么是 zip 而不是一堆文件：用户换机器时只想拷一个文件。包内结构固定：
//   manifest.json       版本/时间/平台（导入前先校验）
//   character/kv.json   settings / state / meta / day:*（角色数据真源）
//   persona/            workspace 受管人格文件（SOUL/IDENTITY/AGENTS/USER）
//   memory/             workspace 记忆日记（<YYYY-MM-DD>.md）
//   stickers/ + stickers.json  表情包图片 + 元数据
//
// 红线：
// - **绝不含密钥/token/截图/日志**：只按白名单打包上面几类，kv 也只取白名单键；
// - 路径安全：解包/写入前校验每个条目名（拒绝绝对路径、`..`、反斜杠、盘符），
//   写入一律 safeJoin 到固定根目录 → zip-slip 无效；
// - 导入先备份现有数据（自动 export 一份 pre-import zip），失败回滚；
// - 不碰 Obsidian 外部文件：只恢复 workspace（vault 里的笔记由用户手动回填）。
//
// 纯 Node（不 import electron），验收脚本可直接打真源码；zip 读写复用仓库既有
// adm-zip 依赖（package.json 已有，不引入新依赖）。

import AdmZip from 'adm-zip'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { CharacterError, CHARACTER_ERROR_CODES } from './types'
import {
  MANAGED_MANIFEST,
  PERSONA_PACKAGE_SLOTS,
  normalizeAgentsDoc,
  readManifest
} from './persona'
import {
  STICKER_DIR,
  STICKER_MAX_BYTES,
  STICKER_MAX_COUNT,
  STICKER_META_FILE,
  detectImageFormat,
  sanitizeStickerRecord,
  sha256Bytes,
  stickerPaths,
  type StickerRecord
} from './stickerStore'

/** 备份 IPC（与 stickerStore 同口径：通道常量先由特性模块自持，避免 types.ts 并行冲突） */
export const CHARACTER_BACKUP_CHANNELS = {
  export: 'character:backup:export',
  import: 'character:backup:import'
} as const

export const BACKUP_KIND = 'umi-claw-character-backup'
export const BACKUP_VERSION = 1
export const BACKUP_DIR = 'backups'
export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_KV_ENTRY = 'character/kv.json'
export const BACKUP_STICKER_META_ENTRY = STICKER_META_FILE
/** 源 zip 上限：本地备份包不该有几十上百 MB（表情包 200×10MB 是理论上限，这里留 400MB） */
export const BACKUP_SOURCE_MAX_BYTES = 400 * 1024 * 1024
export const BACKUP_MANIFEST_MAX_BYTES = 256 * 1024
export const BACKUP_KV_MAX_BYTES = 16 * 1024 * 1024
export const BACKUP_STICKER_META_MAX_BYTES = 16 * 1024 * 1024
export const BACKUP_PERSONA_MAX_FILE_BYTES = 512 * 1024
export const BACKUP_PERSONA_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const BACKUP_MEMORY_MAX_FILES = 400
export const BACKUP_MEMORY_MAX_FILE_BYTES = 512 * 1024
export const BACKUP_MEMORY_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const BACKUP_KV_EXPORT_KEYS = [
  'fish:v2:settings',
  'fish:v2:state',
  'fish:v2:meta',
  'fish:v2:unlocks',
  'fish:v2:pet',
  'fish:v2:dedup'
]
export const BACKUP_KV_EXPORT_PREFIXES = ['fish:v2:day:', 'fish:v2:life:']
export const BACKUP_WARNINGS_MAX = 20

export interface CharacterBackupManifest {
  kind: string
  version: number
  createdAt: string
  createdAtMs: number
  platform: string
  arch: string
}

/** 角色 KV 批量读写（生产用 CharacterKvStore.readAll/writeMany；测试可注入假实现） */
export interface BackupKvBridge {
  readAll: () => Promise<Record<string, string | null>>
  /** 合并写入；value=null 表示删除（回滚需要删掉导入新增的键） */
  writeMany: (entries: Record<string, string | null>) => Promise<unknown>
}

export interface BackupBundleOptions {
  dataDir: string
  /** 角色 workspace（<dataDir>/config/.openclaw/workspace-feiyu） */
  workspaceDir: string
  kv: BackupKvBridge
  now?: () => number
  platform?: string
  arch?: string
  /** 备份目录（默认 <dataDir>/backups） */
  backupRoot?: string
  logger?: (message: string) => void
}

export interface BackupExportResult {
  path: string
  bytes: number
  counts: {
    kv: number
    persona: number
    memory: number
    stickers: number
  }
}

export interface BackupImportResult {
  path: string
  restored: {
    kv: string[]
    persona: string[]
    memory: string[]
    stickers: number
  }
  warnings: string[]
  /** 导入前自动备份的 zip（失败/后悔时用它回滚） */
  backupPath: string
  /** kv 恢复后 manager 的内存态要重启才完全一致（表情包/人格/日记立即生效） */
  restartRequired: boolean
}

export interface BackupBundle {
  /** 默认导出路径（<dataDir>/backups/character-<ts>.zip） */
  defaultExportPath: () => string
  exportTo: (targetPath?: string) => Promise<BackupExportResult>
  importFrom: (sourcePath: string) => Promise<BackupImportResult>
}

/** 时间戳：20261108-131245Z（可排序、无冒号，Windows 文件名安全） */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** 只打包白名单键：settings/state/meta + 按日 day:*（不含 petAppearance/密钥之类的本地引用） */
export function pickKvForBackup(
  entries: Record<string, unknown> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (typeof value !== 'string') continue
    const allow =
      BACKUP_KV_EXPORT_KEYS.includes(key) ||
      BACKUP_KV_EXPORT_PREFIXES.some((prefix) => key.startsWith(prefix))
    if (allow) out[key] = value
  }
  return out
}

/**
 * 条目名安全校验（zip-slip 的第一道门）。
 * 拒绝：空名、反斜杠（Windows 路径混入）、绝对路径、盘符、`..` 段、空段（含 `a//b`）。
 */
export function isSafeArchiveEntryName(name: string): boolean {
  if (typeof name !== 'string' || !name || name.length > 512) return false
  if (name.includes('\u0000') || name.includes('\\')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  const parts = name.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  return true
}

/** 根目录内安全拼接（与 persona.safeJoin 同语义；这里独立实现，避免依赖其相对路径校验细节） */
export function safeJoinRoot(rootDir: string, rel: string): string {
  const root = resolve(rootDir)
  const target = resolve(root, rel)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `备份条目路径越界：${rel}`)
  }
  return target
}

/** 原子写字节：临时文件 + rename（导入恢复用；半截写入比失败更糟） */
function writeAtomicBytes(absPath: string, bytes: Buffer): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, bytes)
  try {
    renameSync(tmp, absPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    writeFileSync(absPath, bytes)
  }
}

/**
 * 解包单条目并做 zip 炸弹防护：先看中央目录声明的解压后大小，再校验真实字节数。
 * （源 zip 体积上限挡不住「小体积高压缩比」炸弹，必须按解压后大小再拦一道。）
 */
function readBoundedEntry(
  entry: { header?: { size?: unknown; compressedSize?: unknown }; getData: () => Buffer },
  maxBytes: number,
  label: string
): Buffer {
  const declared = Number(entry?.header?.size ?? 0)
  const compressed = Number(entry?.header?.compressedSize ?? 0)
  // declared=0 但实际有压缩数据 = 中央目录谎报大小，adm-zip 会无上限 inflate，直接拒绝
  if (!Number.isFinite(declared) || declared < 0 || (declared === 0 && compressed > 0)) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      `备份包 ${label} 的解压大小非法，已拒绝`
    )
  }
  if (declared > maxBytes) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      `备份包 ${label} 解包后过大（${declared} 字节，上限 ${maxBytes}）`
    )
  }
  const bytes = entry.getData()
  if (!bytes || bytes.byteLength > maxBytes || bytes.byteLength !== declared) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      `备份包 ${label} 解包后大小不符/过大（上限 ${maxBytes} 字节）`
    )
  }
  return bytes
}

function readStickerRecordsFromDisk(dataDir: string): StickerRecord[] {
  const { metaPath } = stickerPaths(dataDir)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return []
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { stickers?: unknown }).stickers)
      ? ((parsed as { stickers: unknown[] }).stickers as unknown[])
      : []
  const out: StickerRecord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const record = sanitizeStickerRecord(item)
    if (!record || seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
}

export function createBackupBundle(options: BackupBundleOptions): BackupBundle {
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const backupRoot = options.backupRoot ?? join(options.dataDir, BACKUP_DIR)
  const stickers = stickerPaths(options.dataDir)
  const logger = options.logger ?? (() => undefined)

  const defaultExportPath = (): string =>
    join(backupRoot, `character-${backupStamp(now())}.zip`)

  const uniquePath = (base: string): string => {
    let target = base
    let suffix = 1
    while (existsSync(target)) {
      target = base.replace(/\.zip$/i, `-${suffix}.zip`)
      suffix += 1
    }
    return target
  }

  /** 收集 workspace 记忆日记（只认 <YYYY-MM-DD>.md，最多 400 篇） */
  const collectMemory = (): Array<{ date: string; bytes: Buffer }> => {
    const dir = join(options.workspaceDir, 'memory')
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: Array<{ date: string; bytes: Buffer }> = []
    for (const name of names.sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      const date = name.slice(0, 10)
      if (!isDateKey(date)) continue
      const abs = join(dir, name)
      try {
        const info = statSync(abs)
        if (!info.isFile() || info.size > BACKUP_MEMORY_MAX_FILE_BYTES) continue
        out.push({ date, bytes: readFileSync(abs) })
      } catch {
        /* 单篇读失败不影响整包 */
      }
      if (out.length >= BACKUP_MEMORY_MAX_FILES) break
    }
    return out
  }

  const collectPersona = (): Array<{ slot: string; bytes: Buffer }> => {
    const out: Array<{ slot: string; bytes: Buffer }> = []
    for (const slot of PERSONA_PACKAGE_SLOTS) {
      const abs = safeJoinRoot(options.workspaceDir, slot)
      try {
        const info = statSync(abs)
        if (!info.isFile() || info.size > BACKUP_PERSONA_MAX_FILE_BYTES) continue
        out.push({ slot, bytes: readFileSync(abs) })
      } catch {
        /* 不存在就跳过 */
      }
    }
    return out
  }

  const exportTo = async (targetPath?: string): Promise<BackupExportResult> => {
    const at = now()
    const raw = String(targetPath ?? '').trim()
    const target = raw ? resolve(raw) : defaultExportPath()
    const finalTarget = /\.zip$/i.test(target) ? target : `${target}.zip`
    if (existsSync(finalTarget) && statSync(finalTarget).isDirectory()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '导出路径是目录，请指定 .zip 文件')
    }

    const manifest: CharacterBackupManifest = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      createdAt: new Date(at).toISOString(),
      createdAtMs: at,
      platform,
      arch
    }
    const zip = new AdmZip()
    zip.addFile(BACKUP_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))

    const kvEntries = pickKvForBackup(await options.kv.readAll())
    zip.addFile(BACKUP_KV_ENTRY, Buffer.from(`${JSON.stringify(kvEntries, null, 2)}\n`, 'utf8'))

    const persona = collectPersona()
    for (const item of persona) {
      zip.addFile(`persona/${item.slot}`, item.bytes)
    }

    const memory = collectMemory()
    for (const item of memory) {
      zip.addFile(`memory/${item.date}.md`, item.bytes)
    }

    // 表情包：元数据引用的文件必须真实存在；缺文件的记录不进包（避免导入后全是坏记录）
    const stickerRecords = readStickerRecordsFromDisk(options.dataDir)
    const packedStickers: StickerRecord[] = []
    for (const record of stickerRecords) {
      const abs = join(stickers.dir, record.file)
      try {
        const info = statSync(abs)
        if (!info.isFile() || info.size > STICKER_MAX_BYTES) continue
        zip.addFile(`${STICKER_DIR}/${record.file}`, readFileSync(abs))
        packedStickers.push(record)
      } catch {
        logger(`[character] 备份跳过缺失的表情包文件：${record.file}`)
      }
      if (packedStickers.length >= STICKER_MAX_COUNT) break
    }
    zip.addFile(
      BACKUP_STICKER_META_ENTRY,
      Buffer.from(`${JSON.stringify(packedStickers, null, 2)}\n`, 'utf8')
    )

    const buffer = zip.toBuffer()
    mkdirSync(dirname(finalTarget), { recursive: true })
    const tmp = `${finalTarget}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, buffer)
    try {
      renameSync(tmp, finalTarget)
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      writeFileSync(finalTarget, buffer)
    }
    logger(
      `[character] 备份已导出：${basename(finalTarget)}（kv ${Object.keys(kvEntries).length} / 人格 ${
        persona.length
      } / 日记 ${memory.length} / 表情包 ${packedStickers.length}）`
    )
    return {
      path: finalTarget,
      bytes: buffer.byteLength,
      counts: {
        kv: Object.keys(kvEntries).length,
        persona: persona.length,
        memory: memory.length,
        stickers: packedStickers.length
      }
    }
  }

  const importFrom = async (sourcePath: string): Promise<BackupImportResult> => {
    const rawSource = String(sourcePath ?? '').trim()
    if (!rawSource) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '缺少备份文件路径')
    }
    const source = resolve(rawSource)
    let info
    try {
      info = statSync(source)
    } catch {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '备份文件不存在或不可读')
    }
    if (!info.isFile()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份路径不是文件')
    }
    if (info.size > BACKUP_SOURCE_MAX_BYTES) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.BAD_PAYLOAD,
        `备份文件过大（${info.size} 字节，上限 ${BACKUP_SOURCE_MAX_BYTES}）`
      )
    }

    let zip: AdmZip
    try {
      zip = new AdmZip(readFileSync(source))
    } catch {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '不是有效的 zip 备份文件')
    }
    const entries = zip.getEntries()
    const warnings: string[] = []
    const warn = (message: string): void => {
      if (warnings.length < BACKUP_WARNINGS_MAX) warnings.push(message)
    }

    // zip-slip 防护：先全量校验条目名，任何一条越界就整包拒绝（不「跳过危险条目继续导」）
    for (const entry of entries) {
      if (entry.isDirectory) continue
      if (!isSafeArchiveEntryName(entry.entryName)) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          `备份包条目路径非法（疑似 zip-slip），已拒绝导入：${entry.entryName}`
        )
      }
    }
    const byName = new Map<string, (typeof entries)[number]>()
    for (const entry of entries) {
      if (entry.isDirectory) continue
      byName.set(entry.entryName, entry)
    }

    const manifestEntry = byName.get(BACKUP_MANIFEST)
    if (!manifestEntry) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包缺少 manifest.json')
    }
    let manifest: Partial<CharacterBackupManifest>
    try {
      manifest = JSON.parse(
        readBoundedEntry(manifestEntry, BACKUP_MANIFEST_MAX_BYTES, 'manifest.json').toString('utf8')
      ) as Partial<CharacterBackupManifest>
    } catch {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包 manifest.json 不是合法 JSON')
    }
    if (manifest?.version !== BACKUP_VERSION) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.BAD_PAYLOAD,
        `备份包版本不支持：当前只接受 version=${BACKUP_VERSION}（实际 ${String(manifest?.version)}）`
      )
    }
    if (typeof manifest.kind === 'string' && manifest.kind !== BACKUP_KIND) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '不是大肥鱼角色备份包（manifest.kind 不符）')
    }

    // ── 解析包内容（只认白名单条目，其余只提示忽略） ──
    let kvEntries: Record<string, string> = {}
    const kvEntry = byName.get(BACKUP_KV_ENTRY)
    if (kvEntry) {
      let parsed: unknown
      try {
        parsed = JSON.parse(
          readBoundedEntry(kvEntry, BACKUP_KV_MAX_BYTES, BACKUP_KV_ENTRY).toString('utf8')
        )
      } catch {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包 character/kv.json 不是合法 JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包 character/kv.json 格式不正确')
      }
      const picked = pickKvForBackup(parsed as Record<string, unknown>)
      kvEntries = picked
      for (const key of Object.keys(parsed as Record<string, unknown>)) {
        if (!(key in picked)) warn(`kv 键不在备份白名单内，已忽略：${key}`)
      }
    } else {
      warn('备份包没有 character/kv.json：只恢复人格/记忆/表情包')
    }

    const personaFiles: Array<{ slot: string; bytes: Buffer }> = []
    let personaTotal = 0
    for (const slot of PERSONA_PACKAGE_SLOTS) {
      const entry = byName.get(`persona/${slot}`)
      if (!entry) continue
      const bytes = readBoundedEntry(entry, BACKUP_PERSONA_MAX_FILE_BYTES, `persona/${slot}`)
      personaTotal += bytes.byteLength
      if (personaTotal > BACKUP_PERSONA_MAX_TOTAL_BYTES) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包人格文件总体积超过 2MB')
      }
      if (bytes.includes(0)) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `备份包 persona/${slot} 含非法 NUL 字符`)
      }
      personaFiles.push({ slot, bytes })
    }

    const memoryFiles: Array<{ date: string; bytes: Buffer }> = []
    let memoryTotal = 0
    for (const [name, entry] of byName) {
      if (!name.startsWith('memory/')) continue
      const match = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/.exec(name)
      if (!match || !isDateKey(match[1])) {
        warn(`忽略无法识别的记忆条目：${name}`)
        continue
      }
      let bytes: Buffer
      try {
        bytes = readBoundedEntry(entry, BACKUP_MEMORY_MAX_FILE_BYTES, name)
      } catch {
        warn(`忽略过大的日记 ${name}`)
        continue
      }
      memoryTotal += bytes.byteLength
      if (memoryTotal > BACKUP_MEMORY_MAX_TOTAL_BYTES) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包记忆日记总体积超过 16MB')
      }
      if (memoryFiles.length >= BACKUP_MEMORY_MAX_FILES) {
        warn('记忆日记超过上限，部分未恢复')
        break
      }
      memoryFiles.push({ date: match[1], bytes })
    }

    // 表情包：元数据 + 实际文件都要校验（文件按魔数认格式，hash/size 以实际字节重算）
    let stickerRecords: StickerRecord[] = []
    let hasStickerMeta = false
    const stickerMetaEntry = byName.get(BACKUP_STICKER_META_ENTRY)
    if (stickerMetaEntry) {
      hasStickerMeta = true
      let parsed: unknown
      try {
        parsed = JSON.parse(
          readBoundedEntry(
            stickerMetaEntry,
            BACKUP_STICKER_META_MAX_BYTES,
            BACKUP_STICKER_META_ENTRY
          ).toString('utf8')
        )
      } catch {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '备份包 stickers.json 不是合法 JSON')
      }
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { stickers?: unknown }).stickers)
          ? ((parsed as { stickers: unknown[] }).stickers as unknown[])
          : []
      const seenHash = new Set<string>()
      const seenId = new Set<string>()
      for (const item of list) {
        const record = sanitizeStickerRecord(item)
        if (!record) {
          warn('备份包含无效的表情包元数据记录，已忽略')
          continue
        }
        if (seenHash.has(record.hash) || seenId.has(record.id)) continue
        const entry = byName.get(`${STICKER_DIR}/${record.file}`)
        if (!entry) {
          warn(`备份包缺少表情包文件，已忽略记录：${record.file}`)
          continue
        }
        let bytes: Buffer
        try {
          bytes = readBoundedEntry(entry, STICKER_MAX_BYTES, `${STICKER_DIR}/${record.file}`)
        } catch {
          warn(`表情包文件大小异常，已忽略：${record.file}`)
          continue
        }
        if (bytes.byteLength === 0) {
          warn(`表情包文件为空，已忽略：${record.file}`)
          continue
        }
        const format = detectImageFormat(bytes)
        if (!format) {
          warn(`表情包文件不是支持格式，已忽略：${record.file}`)
          continue
        }
        if (format !== record.format) {
          warn(`表情包记录格式与文件不符，已忽略：${record.file}`)
          continue
        }
        if (record.format !== 'jpg' && !record.file.endsWith(`.${record.format}`)) {
          warn(`表情包文件名后缀与格式不符，已忽略：${record.file}`)
          continue
        }
        const hash = sha256Bytes(bytes)
        if (seenHash.has(hash)) continue
        seenHash.add(hash)
        seenId.add(record.id)
        stickerRecords.push({ ...record, size: bytes.byteLength, hash })
        if (stickerRecords.length >= STICKER_MAX_COUNT) break
      }
    } else {
      warn('备份包没有 stickers.json：表情包保持不变')
    }

    // 只认预期条目；未知条目提示后忽略（不写盘，避免把备份包当任意文件解包器）
    for (const name of byName.keys()) {
      if (
        name === BACKUP_MANIFEST ||
        name === BACKUP_KV_ENTRY ||
        name === BACKUP_STICKER_META_ENTRY ||
        name.startsWith('persona/') ||
        name.startsWith('memory/') ||
        name.startsWith(`${STICKER_DIR}/`)
      ) {
        continue
      }
      warn(`忽略未知备份条目：${name}`)
    }

    // ── 导入前备份现有数据（失败即中止，不动现有数据） ──
    const preImportPath = uniquePath(
      join(backupRoot, `character-pre-import-${backupStamp(now())}.zip`)
    )
    try {
      await exportTo(preImportPath)
    } catch (error) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.STORE_IO,
        `导入前备份现有数据失败，已中止导入：${(error as Error)?.message ?? String(error)}`
      )
    }

    // ── 应用 + 逐项登记回滚 ──
    const undo: Array<() => void | Promise<void>> = []
    const writeRestoredFile = (absPath: string, content: Buffer): void => {
      const prev = existsSync(absPath) ? readFileSync(absPath) : null
      writeAtomicBytes(absPath, content)
      undo.push(() => {
        if (prev) writeAtomicBytes(absPath, prev)
        else rmSync(absPath, { force: true })
      })
    }
    const restoredKvKeys = Object.keys(kvEntries)
    const restoredPersona: string[] = []
    const restoredMemory: string[] = []
    let restoredStickers = 0

    try {
      if (restoredKvKeys.length) {
        const previousKv = await options.kv.readAll()
        await options.kv.writeMany(kvEntries)
        undo.push(async () => {
          // 回滚：导入新增的键删掉，改过的键写回旧值
          const rollback: Record<string, string | null> = {}
          for (const key of restoredKvKeys) {
            rollback[key] = key in previousKv ? previousKv[key] : null
          }
          await options.kv.writeMany(rollback)
        })
      }

      if (personaFiles.length) {
        for (const item of personaFiles) {
          const abs = safeJoinRoot(options.workspaceDir, item.slot)
          let content = item.bytes
          // AGENTS.md 的边界硬段（诚实承认 AI / 危机转介）不随备份包被移除
          if (item.slot === 'AGENTS.md') {
            const normalized = normalizeAgentsDoc(content.toString('utf8'), '')
            content = Buffer.from(normalized, 'utf8')
          }
          writeRestoredFile(abs, content)
          restoredPersona.push(item.slot)
        }
        // 恢复进来的人格视为用户手写：从受管 manifest 删掉这些槽位，避免下次设置变更被模板覆盖
        const manifestPath = safeJoinRoot(options.workspaceDir, MANAGED_MANIFEST)
        const previousManifest = readManifest(manifestPath)
        const nextFiles = { ...previousManifest.files }
        let changed = false
        for (const slot of restoredPersona) {
          if (slot in nextFiles) {
            delete nextFiles[slot]
            changed = true
          }
        }
        if (changed) {
          writeRestoredFile(
            manifestPath,
            Buffer.from(`${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`, 'utf8')
          )
        }
      }

      for (const item of memoryFiles) {
        const abs = safeJoinRoot(options.workspaceDir, join('memory', `${item.date}.md`))
        writeRestoredFile(abs, item.bytes)
        restoredMemory.push(item.date)
      }

      if (hasStickerMeta) {
        const incomingDir = `${stickers.dir}.incoming-${process.pid}-${now()}`
        const oldDir = `${stickers.dir}.pre-import-${process.pid}-${now()}`
        const metaPrev = existsSync(stickers.metaPath) ? readFileSync(stickers.metaPath) : null
        let movedOld = false
        let swapped = false
        try {
          mkdirSync(incomingDir, { recursive: true })
          for (const record of stickerRecords) {
            const entry = byName.get(`${STICKER_DIR}/${record.file}`)
            if (!entry) continue
            writeFileSync(
              join(incomingDir, record.file),
              readBoundedEntry(entry, STICKER_MAX_BYTES, `${STICKER_DIR}/${record.file}`)
            )
          }
          if (existsSync(stickers.dir)) {
            renameSync(stickers.dir, oldDir)
            movedOld = true
          }
          renameSync(incomingDir, stickers.dir)
          swapped = true
          writeAtomicBytes(
            stickers.metaPath,
            Buffer.from(`${JSON.stringify(stickerRecords, null, 2)}\n`, 'utf8')
          )
          // 元数据写成功后才登记回滚（此前失败由下面的 catch 自行还原，避免双份回滚互踩）
          undo.push(() => {
            try {
              rmSync(stickers.dir, { recursive: true, force: true })
            } catch {
              /* 失败也要继续恢复其它数据 */
            }
            try {
              if (movedOld) renameSync(oldDir, stickers.dir)
            } catch {
              /* 旧目录可能已被移动/占用 */
            }
            try {
              if (metaPrev) writeAtomicBytes(stickers.metaPath, metaPrev)
              else rmSync(stickers.metaPath, { force: true })
            } catch {
              /* 元数据原本可能不是普通文件（如被占用/被改成目录）：尽力还原，不掩盖原始错误 */
            }
          })
          // 成功路径：旧表情包目录只在这份 pre-import zip 里留档
          try {
            if (movedOld) rmSync(oldDir, { recursive: true, force: true })
          } catch {
            /* 旧目录清理失败不影响导入结果 */
          }
          restoredStickers = stickerRecords.length
        } catch (error) {
          try {
            rmSync(incomingDir, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
          if (swapped) {
            try {
              rmSync(stickers.dir, { recursive: true, force: true })
            } catch {
              /* ignore */
            }
          }
          if (movedOld) {
            try {
              renameSync(oldDir, stickers.dir)
            } catch {
              /* ignore */
            }
          }
          try {
            if (metaPrev) writeAtomicBytes(stickers.metaPath, metaPrev)
            else rmSync(stickers.metaPath, { force: true })
          } catch {
            /* 同上：还原失败不掩盖真正的导入失败原因 */
          }
          throw error
        }
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const fn of [...undo].reverse()) {
        try {
          await fn()
        } catch (rollbackError) {
          rollbackErrors.push((rollbackError as Error)?.message ?? String(rollbackError))
        }
      }
      const suffix = rollbackErrors.length
        ? `；回滚也有 ${rollbackErrors.length} 项失败，可从 ${preImportPath} 手动恢复：${rollbackErrors.join('；')}`
        : `；已回滚到导入前状态（备份：${preImportPath}）`
      throw new CharacterError(
        CHARACTER_ERROR_CODES.STORE_IO,
        `备份导入失败：${(error as Error)?.message ?? String(error)}${suffix}`
      )
    }

    logger(
      `[character] 备份已导入：kv ${restoredKvKeys.length} / 人格 ${restoredPersona.length} / 日记 ${
        restoredMemory.length
      } / 表情包 ${restoredStickers}`
    )
    return {
      path: source,
      restored: {
        kv: restoredKvKeys,
        persona: restoredPersona,
        memory: restoredMemory,
        stickers: restoredStickers
      },
      warnings,
      backupPath: preImportPath,
      // kv.json 已恢复，但 manager/CharacterKvStore 都有内存态：重启后设置/状态才完全一致
      restartRequired: restoredKvKeys.length > 0
    }
  }

  return { defaultExportPath, exportTo, importFrom }
}
