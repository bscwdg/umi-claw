// electron/main/character/petAppearance.ts —— 桌宠形象自定义（4.3 P4）
//
// 为什么需要它：内置 SVG 鱼的形象不可能让所有人满意；与其让 AI「画」，不如让用户直接导入自己的
// PNG/JPEG/WebP/GIF（动图会动）。这里只做**白名单栅格图**：不接 SVG（可带脚本）、限大小、按魔数
// 校验真实类型，文件落在 `<dataDir>/character/pet-appearance/`，元数据由调用方存 KV。
// 纯 Node（不 import electron），可直接单测。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CharacterError } from './types'

export const PET_APPEARANCE_MAX_BYTES = 8 * 1024 * 1024
export const PET_APPEARANCE_DIR = 'pet-appearance'

export type PetAppearanceMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface PetAppearanceMeta {
  /** 文件名（已消毒，落在 pet-appearance 目录内） */
  file: string
  mime: PetAppearanceMime
  importedAt: number
  bytes: number
}

export type PetAppearanceState =
  | { kind: 'builtin' }
  | { kind: 'image'; meta: PetAppearanceMeta; dataUrl: string }

/** 继承 CharacterError：IPC 信封才会透传 BAD_PAYLOAD/NOT_READY */
export class PetAppearanceError extends CharacterError {
  constructor(code: 'CHARACTER_BAD_PAYLOAD' | 'CHARACTER_NOT_READY', message: string) {
    super(code, message)
    this.name = 'CharacterError'
  }
}

/** 魔数嗅探：只认真正的栅格图，不信任客户端给的 mime/扩展名（SVG/HTML 一律拒绝）。
 * 按常见签名做完整校验（PNG 8 字节、GIF87a/89a、JPEG SOI、WebP RIFF+WEBP），属纵深防御。 */
export function sniffImageMime(buf: Buffer): PetAppearanceMime | null {
  if (buf.length < 12) return null
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  const gif = buf.toString('ascii', 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  const riff = buf.toString('ascii', 0, 4) === 'RIFF'
  const webp = buf.toString('ascii', 8, 12) === 'WEBP'
  if (riff && webp) return 'image/webp'
  return null
}

/** 文件名消毒：只留 basename 的安全字符，去掉 Windows 不接受的尾部点/空格，加时间戳防撞名 */
export function sanitizeAppearanceName(name: string, now: number): string {
  const raw = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim()
  const base = (raw || 'pet-image')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  const safe = base || 'pet-image'
  return `${now}-${safe}`
}

/** 解码 base64（接受 data URL 前缀），失败/空/超限都拒绝。
 * 长度预检放在正则/解码之前：恶意 renderer 传超大串时不能先分配几倍内存再拒绝。 */
export function decodeAppearanceBase64(raw: string): Buffer {
  const text = String(raw ?? '')
  const withoutPrefix = text.replace(/^data:[^;]+;base64,/, '').trim()
  if (!withoutPrefix) throw new PetAppearanceError('CHARACTER_BAD_PAYLOAD', '图片数据为空')
  const maxBase64Chars = Math.ceil(PET_APPEARANCE_MAX_BYTES / 3) * 4 + 8
  if (withoutPrefix.length > maxBase64Chars) {
    throw new PetAppearanceError('CHARACTER_BAD_PAYLOAD', '图片过大（最多 8MB）')
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(withoutPrefix)) {
    throw new PetAppearanceError('CHARACTER_BAD_PAYLOAD', '图片数据不是合法 base64')
  }
  const buf = Buffer.from(withoutPrefix, 'base64')
  if (buf.length <= 0) throw new PetAppearanceError('CHARACTER_BAD_PAYLOAD', '图片数据为空')
  if (buf.length > PET_APPEARANCE_MAX_BYTES) {
    throw new PetAppearanceError('CHARACTER_BAD_PAYLOAD', '图片过大（最多 8MB）')
  }
  return buf
}

/** 清空 pet-appearance 目录里的文件（保留 keep 指定的那一个；不递归、不越界） */
export function clearPetAppearanceDir(baseDir: string, keep: string | null = null): void {
  const dir = join(baseDir, PET_APPEARANCE_DIR)
  if (!existsSync(dir)) return
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (keep && name === keep) continue
    try {
      rmSync(join(dir, basename(name)), { force: true })
    } catch {
      /* 单个删除失败不影响其它 */
    }
  }
}

/** 校验 + 落盘；返回元数据（调用方负责存 KV） */
export function savePetAppearance(
  baseDir: string,
  input: { name: string; dataBase64: string; now: number }
): PetAppearanceMeta {
  const buf = decodeAppearanceBase64(input.dataBase64)
  const mime = sniffImageMime(buf)
  if (!mime) {
    throw new PetAppearanceError(
      'CHARACTER_BAD_PAYLOAD',
      '只支持 PNG / JPEG / WebP / GIF 图片（不支持 SVG）'
    )
  }
  const dir = join(baseDir, PET_APPEARANCE_DIR)
  mkdirSync(dir, { recursive: true })
  const file = sanitizeAppearanceName(input.name, input.now)
  writeFileSync(join(dir, file), buf)
  // 只保留最新一张：旧导入/切图不残留（避免目录无限增长 + 删除全部不彻底）
  clearPetAppearanceDir(baseDir, file)
  return { file, mime, importedAt: input.now, bytes: buf.length }
}

/** 读成 data URL 供渲染端展示；文件丢失/损坏返回内置形象 */
export function loadPetAppearance(baseDir: string, meta: PetAppearanceMeta | null): PetAppearanceState {
  if (!meta || !meta.file) return { kind: 'builtin' }
  // KV 可被本地编辑：mime 只接受白名单，避免被篡改成任意 MIME
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(meta.mime)) {
    return { kind: 'builtin' }
  }
  const abs = join(baseDir, PET_APPEARANCE_DIR, basename(meta.file))
  if (!existsSync(abs)) return { kind: 'builtin' }
  try {
    const size = statSync(abs).size
    if (size <= 0 || size > PET_APPEARANCE_MAX_BYTES) return { kind: 'builtin' }
    const buf = readFileSync(abs)
    if (buf.length <= 0 || buf.length > PET_APPEARANCE_MAX_BYTES) return { kind: 'builtin' }
    return { kind: 'image', meta, dataUrl: `data:${meta.mime};base64,${buf.toString('base64')}` }
  } catch {
    return { kind: 'builtin' }
  }
}

/** 删除自定义形象文件（清空 pet-appearance 目录内的文件，防历史残留/越界） */
export function removePetAppearanceFile(baseDir: string, meta: PetAppearanceMeta | null): void {
  // 即使 meta 丢了也清目录：恢复默认必须让磁盘干净
  clearPetAppearanceDir(baseDir, null)
  if (!meta?.file) return
  const abs = join(baseDir, PET_APPEARANCE_DIR, basename(meta.file))
  try {
    rmSync(abs, { force: true })
  } catch {
    /* 已删除/权限问题都不阻断恢复默认 */
  }
}
