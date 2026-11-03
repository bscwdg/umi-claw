// electron/main/character/knowledgeImport.ts —— 角色知识导入（4.3）
//
// 为什么写到 Obsidian vault 而不是新建知识库：PLAN-FISH-CHARACTER 红线 9 明确「不新增知识库」，
// 角色问答/世界书/约定一律走既有 Obsidian（MCP 检索）。这里只负责把用户选的文件变成
// `大肥鱼/<类别>/<标题>.md`（带 frontmatter 与 tags），写完由渲染端提示去重建索引。
//
// 纯 Node（不 import electron），便于验收脚本直接打真源码。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { CharacterError, CHARACTER_ERROR_CODES } from './types'

export const KNOWLEDGE_CATEGORIES = ['世界书', '角色卡', '关系/约定'] as const
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number]

export const KNOWLEDGE_MAX_FILES = 20
export const KNOWLEDGE_MAX_FILE_BYTES = 512 * 1024
export const KNOWLEDGE_MAX_TOTAL_BYTES = 2 * 1024 * 1024

export interface KnowledgeFileInput {
  name: string
  text: string
}

/** 文件名消毒：去路径分隔符/控制符/前导点与 ..，补 .md，限 80 字符；空则「未命名」 */
export function sanitizeKnowledgeName(raw: unknown, fallback = '未命名'): string {
  const value = typeof raw === 'string' ? raw : ''
  const base = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\.\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  const name = base || fallback
  const withoutDoubleExt = name.replace(/\.md\.md$/i, '.md')
  const withExt = /\.md$/i.test(withoutDoubleExt) ? withoutDoubleExt : `${withoutDoubleExt}.md`
  // Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9/CLOCK$/CONIN$/CONOUT$）不能作为文件名：
  // Windows 按第一个点前的段判断，所以 CON.txt.md / COM1.foo.md / "CON .md" 也要拦
  const firstSegment = withExt
    .split('.')[0]
    .trim()
    .replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)$/i.test(firstSegment)
    ? `_${withExt}`
    : withExt
}

/** 标题 = 去掉 .md 后缀的安全文件名 */
export function knowledgeTitle(name: string): string {
  return name.replace(/\.md$/i, '') || '未命名'
}

/** 生成笔记正文（frontmatter + 原文）；tags 用 Obsidian 标签格式，便于按 `大肥鱼/<类别>` 检索 */
export function buildKnowledgeNote(input: {
  name: string
  text: string
  category: KnowledgeCategory
  date: string
}): string {
  const title = knowledgeTitle(input.name)
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `tags: [大肥鱼, 大肥鱼/${input.category}]`,
    'source: character-import',
    `created: ${input.date}`,
    '---',
    '',
    input.text.trimEnd(),
    ''
  ].join('\n')
}

/**
 * 校验导入请求：类别必须白名单、文件数/单文件/总量限流、文本必须非空。
 * 返回清洗后的文件名与正文（不含 frontmatter，写入时再拼）。
 */
export function validateKnowledgeImport(raw: unknown): {
  category: KnowledgeCategory
  files: KnowledgeFileInput[]
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '知识导入参数不正确')
  }
  const payload = raw as Record<string, unknown>
  const categoryRaw = payload.category
  if (
    typeof categoryRaw !== 'string' ||
    !(KNOWLEDGE_CATEGORIES as readonly string[]).includes(categoryRaw)
  ) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '知识类别不支持（只能是世界书/角色卡/关系/约定）')
  }
  const category = categoryRaw as KnowledgeCategory
  const rawFiles = payload.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '没有选择要导入的文件')
  }
  if (rawFiles.length > KNOWLEDGE_MAX_FILES) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `一次最多导入 ${KNOWLEDGE_MAX_FILES} 个文件`)
  }
  let total = 0
  const files: KnowledgeFileInput[] = []
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object') throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '文件内容不正确')
    const record = item as Record<string, unknown>
    const text = record.text
    if (typeof text !== 'string' || !text.trim()) throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '文件内容为空')
    if (text.includes('\u0000')) throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '文件内容含非法 NUL 字符')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > KNOWLEDGE_MAX_FILE_BYTES) throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '单个文件超过 512KB')
    total += bytes
    files.push({ name: sanitizeKnowledgeName(record.name), text })
  }
  if (total > KNOWLEDGE_MAX_TOTAL_BYTES) throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '本次导入总体积超过 2MB')
  return { category, files }
}

/** 唯一文件名：已存在则依次加 -2/-3…（不覆盖用户已有笔记） */
function uniqueFileName(dir: string, name: string): string {
  const stem = name.replace(/\.md$/i, '')
  let candidate = name
  let n = 2
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}-${n}.md`
    n += 1
  }
  return candidate
}

/**
 * 写入 vault 的 `大肥鱼/<类别>/`；返回相对 vault 的路径列表。
 * 目标目录不存在会自动建；同名不覆盖（加序号），避免毁掉用户已有笔记。
 */
export function writeKnowledgeFiles(
  vaultDir: string,
  category: KnowledgeCategory,
  files: KnowledgeFileInput[],
  now = Date.now()
): { written: string[] } {
  if (!vaultDir) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '未配置 Obsidian vault')
  if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(category)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '知识类别不支持（只能是世界书/角色卡/关系/约定）')
  }
  const d = new Date(now)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const targetDir = safeVaultPath(vaultDir, join('大肥鱼', category))
  mkdirSync(targetDir, { recursive: true })
  const written: string[] = []
  for (const file of files) {
    // 即使调用方绕过 validateKnowledgeImport，也把文件名重新消毒（防路径穿越）
    const safeName = sanitizeKnowledgeName(file.name)
    const name = uniqueFileName(targetDir, safeName)
    const abs = join(targetDir, name)
    const content = buildKnowledgeNote({ name, text: file.text, category, date })
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, abs)
    written.push(`大肥鱼/${category}/${name}`)
  }
  return { written }
}

/** 读回一篇笔记（验收/预览用；不存在返回 null） */
export function readKnowledgeNote(vaultDir: string, relPath: string): string | null {
  try {
    return readFileSync(safeVaultPath(vaultDir, relPath), 'utf8')
  } catch {
    return null
  }
}

/** vault 内安全路径：绝对路径或 .. 穿越一律拒绝（IPC 已校验，这里是文件写 API 的兜底） */
export function safeVaultPath(vaultDir: string, rel: string): string {
  const base = resolve(vaultDir)
  const abs = resolve(base, rel)
  const root = base.endsWith(sep) ? base : base + sep
  if (abs !== base && !abs.startsWith(root)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '知识笔记路径越界')
  }
  // 词法检查挡不住 symlink/junction：对已存在的父目录做 realpath containment
  try {
    const rootReal = existsSync(base) ? realpathSync(base) : base
    const parent = dirname(abs)
    if (existsSync(parent)) {
      const parentReal = realpathSync(parent)
      const realRoot = rootReal.endsWith(sep) ? rootReal : rootReal + sep
      if (parentReal !== rootReal && !parentReal.startsWith(realRoot)) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '知识笔记路径越界（软链）')
      }
    }
  } catch (e) {
    if (e instanceof CharacterError) throw e
    // realpath 失败（权限/竞态）时退回词法结果，不阻断已通过词法校验的路径
  }
  return abs
}
