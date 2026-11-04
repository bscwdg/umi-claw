// electron/main/character/memoryAdmin.ts —— 记忆/关系管理（4.3 P3）
//
// 为什么需要它：日记/约定/大事记虽然能被她召回，但用户只能「全部删除」，无法查看/修正/单条清理。
// 这里提供宿主侧只读列表 + 单条读取 + 日记编辑 + 单条归档删除；全部走固定白名单（日期/扫描到的
// 关系文件），渲染端永远拿不到任意路径。纯 Node（不 import electron），可直接单测。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { CharacterError } from './types'

export const MEMORY_DIARY_DIR = 'memory'
export const MEMORY_RELATION_ROOT = join('大肥鱼', '关系')
export const MEMORY_RELATION_KINDS = ['约定', '大事记'] as const
export type MemoryRelationKind = (typeof MEMORY_RELATION_KINDS)[number]

export const MEMORY_MAX_READ_BYTES = 64 * 1024
export const MEMORY_MAX_SAVE_CHARS = 20_000

export interface MemoryDiaryEntry {
  date: string
  chars: number
  excerpt: string
  source: 'workspace' | 'obsidian'
}

export interface MemoryRelationEntry {
  kind: MemoryRelationKind
  /** 稳定 id：单文件=kind，目录=kind/文件名（均由宿主扫描产生，渲染端不可构造路径） */
  id: string
  chars: number
  excerpt: string
}

export interface MemoryListResult {
  diaries: MemoryDiaryEntry[]
  relations: MemoryRelationEntry[]
}

/** 继承 CharacterError：IPC 信封才会透传 BAD_PAYLOAD/NOT_READY，而不是一律退化成 STORE_IO */
export class MemoryAdminError extends CharacterError {
  constructor(code: 'CHARACTER_BAD_PAYLOAD' | 'CHARACTER_NOT_READY' | 'CHARACTER_STORE_IO', message: string) {
    super(code, message)
    this.name = 'CharacterError'
  }
}

/** 剥离 YAML frontmatter（读给 UI 编辑时只给正文；保存时也再剥一次防重复拼接） */
export function stripFrontmatter(text: string): string {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 校验真实日期（拒绝 2026-02-30/2026-13-01） */
export function isValidMemoryDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = date.split('-').map((n) => Number(n))
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function excerpt(text: string, maxChars = 80): string {
  const clean = String(text ?? '')
    .replace(/^\uFEFF?/, '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, maxChars)
}

function readTextBounded(abs: string): string {
  try {
    if (statSync(abs).size > MEMORY_MAX_READ_BYTES) return ''
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

/** 最近 days 天（含今天）的日期键 */
function recentDateKeys(now: number, days: number): string[] {
  const list: string[] = []
  const count = Math.min(60, Math.max(1, Math.floor(Number.isFinite(days) ? days : 30)))
  const base = new Date(now)
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    list.push(`${y}-${m}-${day}`)
  }
  return list
}

/** 列出日记（workspace 优先，缺失看 Obsidian）与约定/大事记（单文件 + 目录形态） */
export function listMemories(input: {
  workspaceDir: string
  vaultPath?: string
  now: number
  days?: number
}): MemoryListResult {
  const vault = String(input.vaultPath ?? '').trim()
  const days = input.days ?? 30
  const keys = recentDateKeys(input.now, days)
  const diaries: MemoryDiaryEntry[] = []
  for (const date of keys) {
    const wsAbs = join(input.workspaceDir, MEMORY_DIARY_DIR, `${date}.md`)
    const obAbs = vault ? join(vault, '大肥鱼', '日记', `${date}.md`) : ''
    let text = ''
    let source: MemoryDiaryEntry['source'] = 'workspace'
    if (existsSync(wsAbs)) text = readTextBounded(wsAbs)
    else if (obAbs && existsSync(obAbs)) {
      text = readTextBounded(obAbs)
      source = 'obsidian'
    }
    if (!text.trim()) continue
    diaries.push({ date, chars: text.length, excerpt: excerpt(text), source })
  }

  const relations: MemoryRelationEntry[] = []
  if (vault) {
    for (const kind of MEMORY_RELATION_KINDS) {
      const base = join(vault, MEMORY_RELATION_ROOT, kind)
      const fileAbs = `${base}.md`
      const fileText = existsSync(fileAbs) ? readTextBounded(fileAbs) : ''
      if (fileText.trim()) {
        relations.push({ kind, id: kind, chars: fileText.length, excerpt: excerpt(fileText) })
      }
      if (existsSync(base)) {
        let names: string[] = []
        try {
          names = readdirSync(base)
            .filter((name) => /\.md$/i.test(name) && !name.startsWith('.'))
            .sort()
        } catch {
          names = []
        }
        for (const name of names) {
          const text = readTextBounded(join(base, name))
          if (!text.trim()) continue
          relations.push({
            kind,
            id: `${kind}/${name}`,
            chars: text.length,
            excerpt: excerpt(text)
          })
        }
      }
    }
  }
  return { diaries, relations }
}

/** 读取单条：id 必须来自列表白名单（日期或扫描到的关系文件），不拼任意路径 */
export function readMemory(
  input: { workspaceDir: string; vaultPath?: string; now: number; days?: number },
  target: { kind: 'diary'; id: string } | { kind: 'relation'; id: string }
): { kind: 'diary' | 'relation'; id: string; content: string; source: 'workspace' | 'obsidian' } {
  const vault = String(input.vaultPath ?? '').trim()
  if (target.kind === 'diary') {
    const date = String(target.id ?? '')
    if (!isValidMemoryDate(date)) {
      throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '非法日期')
    }
    const wsAbs = join(input.workspaceDir, MEMORY_DIARY_DIR, `${date}.md`)
    if (existsSync(wsAbs)) {
      const content = readTextBounded(wsAbs)
      if (!content.trim()) throw new MemoryAdminError('CHARACTER_NOT_READY', '该日记不可读')
      return { kind: 'diary', id: date, content: stripFrontmatter(content), source: 'workspace' }
    }
    if (vault) {
      const obAbs = join(vault, '大肥鱼', '日记', `${date}.md`)
      if (existsSync(obAbs)) {
        const content = readTextBounded(obAbs)
        if (!content.trim()) throw new MemoryAdminError('CHARACTER_NOT_READY', '该日记不可读')
        return { kind: 'diary', id: date, content: stripFrontmatter(content), source: 'obsidian' }
      }
    }
    throw new MemoryAdminError('CHARACTER_NOT_READY', '没有这一天的记忆')
  }

  const id = String(target.id ?? '')
  const found = listMemories(input).relations.find((r) => r.id === id)
  if (!found) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '未知的关系记忆')
  if (!vault) throw new MemoryAdminError('CHARACTER_NOT_READY', '未配置 Obsidian vault')
  const [kind, name] = id.split('/')
  const abs = name ? join(vault, MEMORY_RELATION_ROOT, kind, name) : join(vault, MEMORY_RELATION_ROOT, kind + '.md')
  const content = readTextBounded(abs)
  if (!content.trim()) throw new MemoryAdminError('CHARACTER_NOT_READY', '该笔记不可读')
  return { kind: 'relation', id, content: stripFrontmatter(content), source: 'obsidian' }
}

/** 保存日记正文（只写本地 workspace；Obsidian 原始日记不动，避免覆盖用户笔记） */
export function saveMemoryDiary(
  workspaceDir: string,
  date: string,
  content: string
): { date: string; chars: number } {
  if (!isValidMemoryDate(date)) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '非法日期')
  // 编辑器只给正文；这里再剥一次 frontmatter，防止调用方把带 frontmatter 的原文传回来造成重复
  const text = stripFrontmatter(String(content ?? ''))
  if (!text.trim()) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '内容不能为空')
  if (text.length > MEMORY_MAX_SAVE_CHARS) {
    throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '内容过长（最多 20000 字）')
  }
  if (text.includes('\u0000')) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '内容含非法字符')
  const dir = join(workspaceDir, MEMORY_DIARY_DIR)
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, `${date}.md`)
  // 保留原 frontmatter（如果有），只替换正文：memoryJob 的 frontmatter 带 date/tags，丢了会破坏格式
  let front = ''
  try {
    const old = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
    const m = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)/.exec(old)
    if (m) front = m[1]
  } catch {
    front = ''
  }
  writeFileSync(abs, front + text, 'utf8')
  return { date, chars: text.length }
}

/**
 * 删除单条（归档，不物理删除）：
 * - 日记：workspace → memory-archive/<ts>/<date>.md；Obsidian 日记 → 大肥鱼/归档/<ts>/日记-<date>.md
 * - 关系笔记：整体移到 大肥鱼/归档/<ts>/<kind>-<name>
 */
export function deleteMemory(
  input: { workspaceDir: string; vaultPath?: string; now: number },
  target: { kind: 'diary'; id: string } | { kind: 'relation'; id: string }
): { archivedTo: string } {
  const vault = String(input.vaultPath ?? '').trim()
  const ts = String(input.now)
  const archiveDir = join(input.workspaceDir, 'memory-archive', ts)
  if (target.kind === 'diary') {
    const date = String(target.id ?? '')
    if (!isValidMemoryDate(date)) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '非法日期')
    let archivedTo = ''
    const wsAbs = join(input.workspaceDir, MEMORY_DIARY_DIR, `${date}.md`)
    if (existsSync(wsAbs)) {
      mkdirSync(archiveDir, { recursive: true })
      const dest = join(archiveDir, `${date}.md`)
      renameSync(wsAbs, dest)
      archivedTo = dest
    }
    if (vault) {
      const obAbs = join(vault, '大肥鱼', '日记', `${date}.md`)
      if (existsSync(obAbs)) {
        const obArchive = join(vault, '大肥鱼', '归档', ts)
        mkdirSync(obArchive, { recursive: true })
        const dest = join(obArchive, `日记-${date}.md`)
        renameSync(obAbs, dest)
        archivedTo = archivedTo || dest
      }
    }
    if (!archivedTo) throw new MemoryAdminError('CHARACTER_NOT_READY', '没有可删除的记忆')
    return { archivedTo }
  }

  if (!vault) throw new MemoryAdminError('CHARACTER_NOT_READY', '未配置 Obsidian vault')
  const id = String(target.id ?? '')
  const found = listMemories({ workspaceDir: input.workspaceDir, vaultPath: vault, now: input.now }).relations.find(
    (r) => r.id === id
  )
  if (!found) throw new MemoryAdminError('CHARACTER_BAD_PAYLOAD', '未知的关系记忆')
  const obArchive = join(vault, '大肥鱼', '归档', ts)
  mkdirSync(obArchive, { recursive: true })
  const [kind, name] = id.split('/')
  const src = name ? join(vault, MEMORY_RELATION_ROOT, kind, name) : join(vault, MEMORY_RELATION_ROOT, kind + '.md')
  if (!existsSync(src)) throw new MemoryAdminError('CHARACTER_NOT_READY', '该笔记已不存在')
  const dest = join(obArchive, name ? basename(name) : kind + '.md')
  // 同一时间戳下同名归档不覆盖：加数字后缀
  let finalDest = dest
  for (let i = 2; existsSync(finalDest); i += 1) {
    finalDest = name ? join(obArchive, `${basename(name, '.md')}-${i}.md`) : join(obArchive, `${kind}-${i}.md`)
  }
  renameSync(src, finalDest)
  return { archivedTo: finalDest }
}

/**
 * 批量删除前归档 workspace 日记（4.3 数据安全修复）。
 *
 * 语义：把 `<workspace>/memory/` 整体移到 `<workspace>/memory-archive/<ts>/memory/`，
 * 返回归档目录；没有 memory 目录返回 null（幂等、无副作用）。
 * 单条删除走 deleteMemory()，这里只服务「删除日记与关系」的批量路径，
 * 避免出现「单条归档、批量硬删」的不一致（复核发现的无 vault 用户数据丢失风险）。
 */
export function archiveWorkspaceMemory(
  workspaceDir: string,
  now: number = Date.now()
): string | null {
  const src = join(workspaceDir, MEMORY_DIARY_DIR)
  if (!existsSync(src)) return null
  const archiveRoot = join(workspaceDir, 'memory-archive')
  const archiveDir = join(archiveRoot, String(now))
  let target = join(archiveDir, MEMORY_DIARY_DIR)
  for (let i = 2; existsSync(target); i += 1) target = join(archiveDir, `${MEMORY_DIARY_DIR}-${i}`)
  mkdirSync(archiveDir, { recursive: true })
  renameSync(src, target)
  return target
}
