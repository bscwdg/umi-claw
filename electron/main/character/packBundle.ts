// electron/main/character/packBundle.ts —— 大肥鱼统一资料包 v1（人格/知识/主动消息/记忆 编排层）
//
// 为什么单独成文件：人格、知识、用户语料、记忆/日记本来各有自己的导入入口（persona.ts、
// knowledgeImport.ts、contentStore.ts、memoryAdmin.ts）。技能产出的「资料包」要一次导入这四类，
// 但**不能重复造这四套**——本模块只做「读包 → 校验 → 编排调用」，写盘语义仍由四个既有模块负责。
//
// 资料包契约 v1（目录或 zip，schema=umi-character-pack/1）：
//   manifest.json                    {schema, name, createdAt, source?, targets?}
//   persona.json                     PersonaPackage v1（可只含部分槽位）
//   proactive/topics.json            fish-topics/1 话题卡
//   proactive/lines.json             fish-lines/1 台词组
//   knowledge/<类别>/**/*.md          类别白名单：世界书 / 角色卡 / 关系/约定
//   memory/relations/<约定|大事记>/**/*.md
//   memory/diaries/YYYY-MM-DD.md
//
// 安全红线（对抗审查关注点）：
// - zip **绝不解压到磁盘**：只读进内存，逐条目校验条目名（zip-slip/绝对路径/反斜杠/盘符），
//   按「中央目录声明大小 > 实际字节数」双重校验，先拒 >32MB 的源文件与解压炸弹；
// - 整包 ≤32MB、单文件 ≤512KB、知识 ≤300 / 话题 ≤200 / 台词组 ≤50 / 关系 ≤400；
// - 文件名/类别/记忆 kind/日记日期全部白名单；任何 .md 含 NUL 直接拒；
// - 目录导入跳过符号链接；未知条目只警告不写盘（不把资料包当任意文件解码器）；
// - 导入同名不覆盖（知识/关系加序号；日记同日跳过并 warning）；导入前由 wiring 用
//   backupBundle 整包备份，备份失败中止导入；
// - 部分失败如实返回 errors 与已写入计数，不谎报全成功。
//
// 纯 Node（不 import electron），验收脚本可直接 bundle 真源码。
// zip 读写复用仓库既有 adm-zip 依赖（package.json 已有，不引入新依赖）。

import AdmZip from 'adm-zip'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  parseLineDeck,
  parseTopicDeck,
  type ContentDeck,
  type LineDeck,
  type TopicCard,
  type TopicDeck
} from './contentEngine'
import type { ImportLinesResult, ImportTopicsResult } from './contentStore'
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_MAX_FILE_BYTES,
  safeVaultPath,
  sanitizeKnowledgeName,
  writeKnowledgeFiles,
  type KnowledgeCategory,
  type KnowledgeFileInput
} from './knowledgeImport'
import {
  MEMORY_RELATION_KINDS,
  MEMORY_RELATION_ROOT,
  isValidMemoryDate,
  stripFrontmatter,
  type MemoryRelationKind
} from './memoryAdmin'
import {
  CHARACTER_HER_NAME,
  PERSONA_PACKAGE_SLOTS,
  importPersonaPackage,
  readPersonaFiles,
  type PersonaPackage,
  type PersonaSlot
} from './persona'
import { isSafeArchiveEntryName } from './backupBundle'
import { CharacterError, CHARACTER_ERROR_CODES } from './types'

/** 资料包 IPC（特性模块自持通道，命名按 <domain>:<entity>:<method>，与 backup/content 同口径） */
export const CHARACTER_PACK_CHANNELS = {
  export: 'character:pack:export',
  importFolder: 'character:pack:import-folder',
  importZip: 'character:pack:import-zip'
} as const

export const PACK_SCHEMA = 'umi-character-pack/1'
export const PACK_MANIFEST = 'manifest.json'
export const PACK_PERSONA = 'persona.json'
export const PACK_TOPICS = 'proactive/topics.json'
export const PACK_LINES = 'proactive/lines.json'
export const PACK_KNOWLEDGE_DIR = 'knowledge'
export const PACK_RELATIONS_DIR = 'memory/relations'
export const PACK_DIARIES_DIR = 'memory/diaries'
/** 导出时在用户选定目录下新建的子目录前缀（不直接往用户目录里散落文件） */
export const PACK_DIR_PREFIX = '大肥鱼资料包'

/** 契约上限（与 task-4 / skill 侧一致；改这里要同步 skill 的 validate_pack.py） */
export const PACK_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const PACK_MAX_FILE_BYTES = KNOWLEDGE_MAX_FILE_BYTES
export const PACK_MAX_KNOWLEDGE_FILES = 300
export const PACK_MAX_TOPICS = 200
export const PACK_MAX_LINE_GROUPS = 50
export const PACK_MAX_RELATIONS = 400
/** zip 条目数上限：正常包几百条，2000 足够且能拦住条目洪水 */
export const PACK_MAX_ENTRIES = 2000
/** JSON 条目（manifest/persona/topics/lines）单文件上限：话题 200 张 ≈ 几百 KB，留余量 */
export const PACK_MAX_JSON_BYTES = 4 * 1024 * 1024
export const PACK_MAX_MANIFEST_BYTES = 256 * 1024
export const PACK_WARNINGS_MAX = 40
/** 人格包上限与 persona.ts 同口径（那边常量未导出，这里复制同一数值，导入时 persona 会再校验一次） */
export const PACK_PERSONA_MAX_FILE_BYTES = 512 * 1024
export const PACK_PERSONA_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const PACK_TARGETS = ['persona', 'knowledge', 'proactive', 'memory'] as const

export interface CharacterPackManifest {
  schema: string
  name: string
  createdAt: string
  source?: string
  targets?: string[]
}

export interface PackKnowledgeItem {
  category: KnowledgeCategory
  /** 相对类别目录的文件名（可能带子目录，写入时由 sanitizeKnowledgeName 拍平） */
  name: string
  text: string
}

export interface PackRelationItem {
  kind: MemoryRelationKind
  name: string
  text: string
}

export interface PackDiaryItem {
  date: string
  text: string
}

/** 读包结果：所有内容已在内存里校验完毕，importPack 只按它写盘 */
export interface CharacterPackPlan {
  manifest: CharacterPackManifest
  persona: PersonaPackage | null
  topics: TopicDeck | null
  lines: LineDeck | null
  knowledge: PackKnowledgeItem[]
  relations: PackRelationItem[]
  diaries: PackDiaryItem[]
  warnings: string[]
  /** 包来源（目录路径或 zip 路径），只用于展示/日志 */
  source: string
  /** 包内白名单文件的总字节数（目录按 stat，zip 按中央目录声明） */
  bytes: number
}

export interface SnapshotCounts {
  persona: number
  topics: number
  lineGroups: number
  knowledge: number
  relations: number
  diaries: number
}

export interface SnapshotCurrentResult {
  /** 实际写出的资料包目录（<outputDir>/大肥鱼资料包-<YYYYMMDD-HHmmss>/） */
  dir: string
  manifestPath: string
  bytes: number
  counts: SnapshotCounts
  warnings: string[]
}

export interface SnapshotCurrentOptions {
  workspaceDir: string
  /** Obsidian vault；未配置时跳过知识与关系记忆（导出仍成功） */
  vaultDir?: string
  /** 应用数据目录（保留：资料包目前不引用它，便于将来把内置内容一并导出） */
  dataDir?: string
  /** 合并后的主动消息语料（含内置+用户）；不传则跳过 proactive/ 并 warning */
  deck?: ContentDeck
  /** 用户选定的导出位置；会在其中新建 大肥鱼资料包-<时间>/ 子目录 */
  outputDir: string
  now?: number
}

/** importPack 只依赖 contentStore 的这两个写入口（生产注入真 store，验收可注入假实现） */
export interface PackContentImporter {
  importTopics: (raw: unknown) => Promise<ImportTopicsResult>
  importLines: (raw: unknown) => Promise<ImportLinesResult>
}

export interface ImportPackOptions {
  workspaceDir: string
  vaultDir?: string
  plan: CharacterPackPlan
  content: PackContentImporter
  now?: number
  logger?: (message: string) => void
}

export interface ImportPackResult {
  source: string
  counts: {
    persona: PersonaSlot[]
    topics: ImportTopicsResult | null
    lines: ImportLinesResult | null
    knowledge: number
    relations: number
    diaries: number
    /** 同日已存在而跳过（不是失败）的日记数 */
    diariesSkipped: number
  }
  /** 非失败提示：未知条目/重复 id/截断/同名跳过等 */
  warnings: string[]
  /** 单目标失败原因：部分失败时其它目标照常写入，由调用方如实展示 */
  errors: string[]
  /** 人格导入前自动备份目录（persona.ts 的 .persona-backup/<ts>） */
  personaBackupDir: string | null
  written: {
    knowledge: string[]
    relations: string[]
    diaries: string[]
  }
}

interface PackEntrySource {
  /** posix 风格相对路径（目录导入时由 walk 生成） */
  name: string
  size: number
  read: () => Buffer
}

interface MarkdownFileRef {
  /** 相对扫描根目录的 posix 路径 */
  rel: string
  abs: string
  size: number
}

function makeWarn(warnings: string[]): (message: string) => void {
  return (message: string): void => {
    if (warnings.length < PACK_WARNINGS_MAX) warnings.push(message)
    else if (warnings.length === PACK_WARNINGS_MAX) warnings.push('…警告过多，后续已省略')
  }
}

function toPosix(rel: string): string {
  return rel.split('\\').join('/')
}

/** 原子写文本：临时文件 + rename（包读到一半崩掉不会留半截文件） */
function writeAtomic(absPath: string, content: string | Buffer): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content)
  try {
    renameSync(tmp, absPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    writeFileSync(absPath, content)
  }
}

function readJsonString(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `${label} 不是合法 JSON`)
  }
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `${label} 格式不正确：应为 JSON 对象`)
  }
  return value as Record<string, unknown>
}

function badPayload(message: string): CharacterError {
  return new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, message)
}

// ── 读包：目录与 zip 共用同一个 buildPlan ────────────────────────────────────

function readEntryText(entry: PackEntrySource): string {
  if (entry.size > PACK_MAX_FILE_BYTES) {
    throw badPayload(
      `资料包条目 ${entry.name} 超过单文件上限 512KB（${entry.size} 字节）`
    )
  }
  const bytes = entry.read()
  if (bytes.byteLength > PACK_MAX_FILE_BYTES) {
    throw badPayload(`资料包条目 ${entry.name} 解包后超过单文件上限 512KB`)
  }
  if (bytes.includes(0)) {
    throw badPayload(`资料包条目 ${entry.name} 含非法 NUL 字符`)
  }
  return bytes.toString('utf8')
}

function readEntryJson(
  byName: Map<string, PackEntrySource>,
  name: string,
  maxBytes: number
): unknown {
  const entry = byName.get(name)
  if (!entry) throw badPayload(`资料包缺少 ${name}`)
  if (entry.size > maxBytes) {
    throw badPayload(`${name} 过大（${entry.size} 字节，上限 ${maxBytes}）`)
  }
  const bytes = entry.read()
  if (bytes.byteLength > maxBytes) {
    throw badPayload(`${name} 解包后过大（上限 ${maxBytes} 字节）`)
  }
  return readJsonString(bytes, name)
}

/** 校验 manifest：schema 必须精确匹配，name/createdAt 缺失只警告（兼容手写包） */
function parseManifest(raw: unknown, warn: (m: string) => void): CharacterPackManifest {
  const manifest = assertPlainObject(raw, '资料包 manifest.json')
  if (manifest.schema !== PACK_SCHEMA) {
    throw badPayload(
      `资料包 schema 不支持：当前只接受 ${PACK_SCHEMA}（实际 ${String(manifest.schema)}）`
    )
  }
  const name =
    typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim().slice(0, 80)
      : (warn('manifest.name 缺失，使用默认名称'), '未命名资料包')
  const createdAtRaw = typeof manifest.createdAt === 'string' ? manifest.createdAt.trim() : ''
  const createdAt = createdAtRaw && !Number.isNaN(Date.parse(createdAtRaw))
    ? createdAtRaw
    : (warn('manifest.createdAt 缺失或不是合法 ISO 时间，已用当前时间'), new Date().toISOString())
  const out: CharacterPackManifest = { schema: PACK_SCHEMA, name, createdAt }
  if (typeof manifest.source === 'string' && manifest.source.trim()) {
    out.source = manifest.source.trim().slice(0, 200)
  }
  if (manifest.targets !== undefined) {
    if (!Array.isArray(manifest.targets)) {
      warn('manifest.targets 不是数组，已忽略')
    } else {
      const targets: string[] = []
      for (const item of manifest.targets) {
        if (typeof item !== 'string') continue
        if (!(PACK_TARGETS as readonly string[]).includes(item)) {
          warn(`manifest.targets 含未知目标，已忽略：${item}`)
          continue
        }
        if (!targets.includes(item)) targets.push(item)
      }
      if (targets.length) out.targets = targets
    }
  }
  return out
}

/** 校验 persona.json：槽位白名单、字符串、无 NUL、单文件 512KB / 总量 2MB（与 persona.ts 同口径） */
function parsePersonaJson(
  raw: unknown,
  warn: (m: string) => void,
  now: number
): PersonaPackage {
  const pkg = assertPlainObject(raw, '资料包 persona.json')
  if (pkg.version !== 1) {
    throw badPayload('资料包 persona.json 版本不支持：当前只接受 version=1')
  }
  const filesRaw = assertPlainObject(pkg.files, '资料包 persona.json 缺少 files')
  const files: Partial<Record<PersonaSlot, string>> = {}
  let total = 0
  for (const [key, value] of Object.entries(filesRaw)) {
    if (!(PERSONA_PACKAGE_SLOTS as readonly string[]).includes(key)) {
      warn(`persona.json 含未知槽位，已忽略：${key}`)
      continue
    }
    if (typeof value !== 'string') {
      throw badPayload(`persona.json ${key} 内容必须是字符串`)
    }
    if (value.includes('\u0000')) {
      throw badPayload(`persona.json ${key} 含非法 NUL 字符`)
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > PACK_PERSONA_MAX_FILE_BYTES) {
      throw badPayload(`persona.json ${key} 超过 512KB（${bytes} 字节）`)
    }
    total += bytes
    if (total > PACK_PERSONA_MAX_TOTAL_BYTES) {
      throw badPayload('persona.json 总体积超过 2MB')
    }
    files[key as PersonaSlot] = value
  }
  if (Object.keys(files).length === 0) {
    throw badPayload('persona.json 没有可导入的文件（SOUL/IDENTITY/AGENTS/USER）')
  }
  return {
    version: 1,
    herName:
      typeof pkg.herName === 'string' && pkg.herName.trim()
        ? pkg.herName.trim().slice(0, 20)
        : CHARACTER_HER_NAME,
    exportedAt: Number.isFinite(pkg.exportedAt as number)
      ? Math.floor(pkg.exportedAt as number)
      : now,
    files
  }
}

function parseTopicsJson(
  raw: unknown,
  warn: (m: string) => void
): TopicDeck {
  const src = assertPlainObject(raw, '资料包 proactive/topics.json')
  if (src.schema !== undefined && src.schema !== 'fish-topics/1') {
    throw badPayload(
      `话题文件 schema 不支持：只接受 fish-topics/1（实际 ${String(src.schema)}）`
    )
  }
  if (src.schema === undefined) warn('proactive/topics.json 缺少 schema 字段，按 fish-topics/1 解析')
  const parsed = parseTopicDeck(raw)
  const rawCount = Array.isArray(src.topics) ? src.topics.length : 0
  if (rawCount > parsed.topics.length) {
    warn(`话题文件有 ${rawCount - parsed.topics.length} 张卡片缺少 id 或 sample/hooks，已忽略`)
  }
  if (parsed.topics.length === 0) {
    throw badPayload('proactive/topics.json 没有合法话题卡（每张卡至少要有 id 与 sample/hooks）')
  }
  const deduped: TopicCard[] = []
  const seen = new Set<string>()
  for (const card of parsed.topics) {
    if (seen.has(card.id)) {
      warn(`话题 id 重复，已忽略后者：${card.id}`)
      continue
    }
    seen.add(card.id)
    deduped.push(card)
  }
  if (deduped.length > PACK_MAX_TOPICS) {
    throw badPayload(`话题卡 ${deduped.length} 张，超过上限 ${PACK_MAX_TOPICS}`)
  }
  return {
    schema: 'fish-topics/1',
    version: typeof src.version === 'string' && src.version.trim() ? src.version.trim() : '1.0.0',
    topics: deduped
  }
}

function parseLinesJson(raw: unknown, warn: (m: string) => void): LineDeck {
  const src = assertPlainObject(raw, '资料包 proactive/lines.json')
  if (src.schema !== undefined && src.schema !== 'fish-lines/1') {
    throw badPayload(
      `台词文件 schema 不支持：只接受 fish-lines/1（实际 ${String(src.schema)}）`
    )
  }
  if (src.schema === undefined) warn('proactive/lines.json 缺少 schema 字段，按 fish-lines/1 解析')
  const parsed = parseLineDeck(raw)
  const rawGroups =
    src.groups && typeof src.groups === 'object' && !Array.isArray(src.groups)
      ? Object.keys(src.groups as Record<string, unknown>)
      : []
  const dropped = rawGroups.filter((name) => !(name in parsed.groups))
  if (dropped.length) {
    warn(`台词组名不合法或没有有效句子，已忽略：${dropped.slice(0, 5).join('、')}`)
  }
  const groupCount = Object.keys(parsed.groups).length
  if (groupCount === 0) {
    throw badPayload('proactive/lines.json 没有合法台词组（组名需为小写短横线，每组至少一句）')
  }
  if (groupCount > PACK_MAX_LINE_GROUPS) {
    throw badPayload(`台词组 ${groupCount} 组，超过上限 ${PACK_MAX_LINE_GROUPS}`)
  }
  return {
    schema: 'fish-lines/1',
    version: typeof src.version === 'string' && src.version.trim() ? src.version.trim() : '1.0.0',
    groups: parsed.groups
  }
}

/** 类别目录映射：knowledge/<类别>/...；'关系/约定' 本身带斜杠，所以用 startsWith 精确匹配 */
function matchCategory(rel: string): { category: KnowledgeCategory; inner: string } | null {
  for (const category of KNOWLEDGE_CATEGORIES) {
    const prefix = `${category}/`
    if (rel.startsWith(prefix) && rel.length > prefix.length) {
      return { category, inner: rel.slice(prefix.length) }
    }
  }
  return null
}

function matchRelationKind(rel: string): { kind: MemoryRelationKind; inner: string } | null {
  for (const kind of MEMORY_RELATION_KINDS) {
    const prefix = `${kind}/`
    if (rel.startsWith(prefix) && rel.length > prefix.length) {
      return { kind, inner: rel.slice(prefix.length) }
    }
  }
  return null
}

/** 目录与 zip 的唯一解析入口：白名单 + 上限 + schema 校验都在这里，坏包抛 BAD_PAYLOAD */
function buildPlan(
  entries: PackEntrySource[],
  source: string,
  bytes: number,
  baseWarnings: string[],
  now: number
): CharacterPackPlan {
  const warnings = [...baseWarnings]
  const warn = makeWarn(warnings)
  if (bytes > PACK_MAX_TOTAL_BYTES) {
    throw badPayload(
      `资料包过大（${bytes} 字节，上限 ${PACK_MAX_TOTAL_BYTES}）：请先压缩知识/日记再导入`
    )
  }
  if (entries.length > PACK_MAX_ENTRIES) {
    throw badPayload(`资料包条目数 ${entries.length} 超过上限 ${PACK_MAX_ENTRIES}`)
  }

  const byName = new Map<string, PackEntrySource>()
  for (const entry of entries) {
    if (!isSafeArchiveEntryName(entry.name)) {
      throw badPayload(`资料包条目路径非法（疑似路径穿越/zip-slip），已拒绝：${entry.name}`)
    }
    if (byName.has(entry.name)) {
      warn(`重复条目已忽略：${entry.name}`)
      continue
    }
    byName.set(entry.name, entry)
  }

  if (!byName.has(PACK_MANIFEST)) {
    throw badPayload('资料包缺少 manifest.json（不是 umi-character-pack/1 资料包）')
  }
  const manifest = parseManifest(
    readEntryJson(byName, PACK_MANIFEST, PACK_MAX_MANIFEST_BYTES),
    warn
  )

  let persona: PersonaPackage | null = null
  if (byName.has(PACK_PERSONA)) {
    persona = parsePersonaJson(
      readEntryJson(byName, PACK_PERSONA, PACK_MAX_JSON_BYTES),
      warn,
      now
    )
  }

  let topics: TopicDeck | null = null
  if (byName.has(PACK_TOPICS)) {
    topics = parseTopicsJson(readEntryJson(byName, PACK_TOPICS, PACK_MAX_JSON_BYTES), warn)
  }

  let lines: LineDeck | null = null
  if (byName.has(PACK_LINES)) {
    lines = parseLinesJson(readEntryJson(byName, PACK_LINES, PACK_MAX_JSON_BYTES), warn)
  }

  const knowledge: PackKnowledgeItem[] = []
  const relations: PackRelationItem[] = []
  const diaries: PackDiaryItem[] = []
  const known = new Set([PACK_MANIFEST, PACK_PERSONA, PACK_TOPICS, PACK_LINES])

  for (const name of [...byName.keys()].sort()) {
    if (known.has(name)) continue
    const entry = byName.get(name) as PackEntrySource
    if (name.startsWith(`${PACK_KNOWLEDGE_DIR}/`)) {
      const rel = name.slice(PACK_KNOWLEDGE_DIR.length + 1)
      const matched = matchCategory(rel)
      if (!matched) {
        warn(`忽略未知知识类别：${name}`)
        continue
      }
      if (!/\.md$/i.test(matched.inner)) {
        warn(`忽略非 .md 知识文件：${name}`)
        continue
      }
      const text = readEntryText(entry)
      if (!text.trim()) {
        warn(`忽略空知识文件：${name}`)
        continue
      }
      knowledge.push({ category: matched.category, name: matched.inner, text })
      continue
    }
    if (name.startsWith(`${PACK_RELATIONS_DIR}/`)) {
      const rel = name.slice(PACK_RELATIONS_DIR.length + 1)
      const matched = matchRelationKind(rel)
      if (!matched) {
        warn(`忽略未知关系记忆类别（只认约定/大事记）：${name}`)
        continue
      }
      if (!/\.md$/i.test(matched.inner)) {
        warn(`忽略非 .md 关系记忆文件：${name}`)
        continue
      }
      const text = readEntryText(entry)
      if (!text.trim()) {
        warn(`忽略空关系记忆文件：${name}`)
        continue
      }
      relations.push({ kind: matched.kind, name: matched.inner, text })
      continue
    }
    if (name.startsWith(`${PACK_DIARIES_DIR}/`)) {
      const rel = name.slice(PACK_DIARIES_DIR.length + 1)
      const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(rel)
      if (!match) {
        warn(`忽略无法识别的日记条目（需要 YYYY-MM-DD.md）：${name}`)
        continue
      }
      if (!isValidMemoryDate(match[1])) {
        warn(`忽略非法日记日期：${name}`)
        continue
      }
      const text = readEntryText(entry)
      if (!text.trim()) {
        warn(`忽略空日记：${name}`)
        continue
      }
      diaries.push({ date: match[1], text })
      continue
    }
    warn(`忽略未知条目：${name}`)
  }

  if (knowledge.length > PACK_MAX_KNOWLEDGE_FILES) {
    throw badPayload(`知识笔记 ${knowledge.length} 篇，超过上限 ${PACK_MAX_KNOWLEDGE_FILES}`)
  }
  if (relations.length > PACK_MAX_RELATIONS) {
    throw badPayload(`关系记忆 ${relations.length} 篇，超过上限 ${PACK_MAX_RELATIONS}`)
  }

  if (
    !persona &&
    !topics &&
    !lines &&
    knowledge.length === 0 &&
    relations.length === 0 &&
    diaries.length === 0
  ) {
    throw badPayload('资料包没有可导入的内容（人格/主动消息/知识/记忆都为空）')
  }

  return {
    manifest,
    persona,
    topics,
    lines,
    knowledge,
    relations,
    diaries,
    warnings,
    source,
    bytes
  }
}

/** 目录条目收集：跳过符号链接（避免把外部敏感文件读进资料包），返回 posix 相对路径 */
function collectDirEntries(
  rootDir: string,
  warn: (message: string) => void
): PackEntrySource[] {
  const out: PackEntrySource[] = []
  const walk = (absDir: string, relDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(absDir).sort()
    } catch {
      return
    }
    for (const name of names) {
      const abs = join(absDir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      let info
      try {
        info = lstatSync(abs)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        warn(`忽略符号链接条目：${rel}`)
        continue
      }
      if (info.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!info.isFile()) continue
      out.push({
        name: rel,
        size: info.size,
        read: () => readFileSync(abs)
      })
    }
  }
  walk(rootDir, '')
  return out
}

export function readPackDir(packDir: string): CharacterPackPlan {
  const raw = String(packDir ?? '').trim()
  if (!raw) throw badPayload('缺少资料包目录')
  const abs = resolve(raw)
  let info
  try {
    info = statSync(abs)
  } catch {
    throw badPayload('资料包目录不存在或不可读')
  }
  if (!info.isDirectory()) throw badPayload('资料包路径不是文件夹')
  const warnings: string[] = []
  const entries = collectDirEntries(abs, makeWarn(warnings))
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  return buildPlan(entries, abs, bytes, warnings, Date.now())
}

export function readPackZip(zipPath: string): CharacterPackPlan {
  const raw = String(zipPath ?? '').trim()
  if (!raw) throw badPayload('缺少资料包 zip 路径')
  const abs = resolve(raw)
  let info
  try {
    info = statSync(abs)
  } catch {
    throw badPayload('资料包 zip 不存在或不可读')
  }
  if (!info.isFile()) throw badPayload('资料包路径不是文件')
  // 先按源文件体积拒一次（32MB 上限），再按解压后声明大小拒解压炸弹
  if (info.size > PACK_MAX_TOTAL_BYTES) {
    throw badPayload(`资料包 zip 过大（${info.size} 字节，上限 ${PACK_MAX_TOTAL_BYTES}）`)
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(readFileSync(abs))
  } catch {
    throw badPayload('不是有效的 zip 资料包')
  }
  const zipEntries = zip.getEntries()
  if (zipEntries.length > PACK_MAX_ENTRIES) {
    throw badPayload(`资料包条目数 ${zipEntries.length} 超过上限 ${PACK_MAX_ENTRIES}`)
  }
  const warnings: string[] = []
  const rawEntries: Array<{
    entry: (typeof zipEntries)[number]
    name: string
    declared: number
  }> = []
  let declaredTotal = 0
  for (const entry of zipEntries) {
    if (entry.isDirectory) continue
    // Windows 工具可能把 zip 条目写成反斜杠：先规范成 `/` 再做安全校验与路径映射
    const normalized = entry.entryName.split('\\').join('/')
    // 规范化后以 `/` 结尾的是目录条目（部分工具目录条目不带 isDirectory 标记）
    if (!normalized || normalized.endsWith('/')) continue
    if (!isSafeArchiveEntryName(normalized)) {
      throw badPayload(`资料包条目路径非法（疑似路径穿越/zip-slip），已拒绝：${normalized}`)
    }
    const declared = Number(entry.header?.size ?? 0)
    const compressed = Number(entry.header?.compressedSize ?? 0)
    // declared=0 但有压缩数据 = 中央目录谎报大小，adm-zip 会无上限 inflate：直接拒
    if (!Number.isFinite(declared) || declared < 0 || (declared === 0 && compressed > 0)) {
      throw badPayload(`资料包条目 ${normalized} 的解压大小非法，已拒绝`)
    }
    // STORED（method=0）不压缩：压缩大小必须等于声明大小。否则中央目录谎报时
    // adm-zip 按声明值截断 getData 结果，byteLength 校验又恰好对不上，内容会被
    // 静默截断（对抗审查 P2-1 已用伪造 CRC 的 STORED 包实测复现）。
    if (Number(entry.header?.method) === 0 && compressed !== declared) {
      throw badPayload(`资料包条目 ${normalized} 的 STORED 大小不一致，已拒绝（疑似伪造/截断）`)
    }
    if (declared > PACK_MAX_JSON_BYTES) {
      throw badPayload(`资料包条目 ${normalized} 解压后过大（${declared} 字节）`)
    }
    declaredTotal += declared
    if (declaredTotal > PACK_MAX_TOTAL_BYTES) {
      throw badPayload(`资料包解压后总体积超过上限 ${PACK_MAX_TOTAL_BYTES}`)
    }
    rawEntries.push({ entry, name: normalized, declared })
  }
  if (rawEntries.length === 0) throw badPayload('资料包 zip 没有可读条目')

  // zip 兼容：skill 侧允许「整个包套一层顶层目录」（如 示例资料包/manifest.json）。
  // 仅当根级没有 manifest.json、恰好只有一个顶层目录且该目录下有 manifest.json 时剥前缀；
  // 多顶层/无 manifest 仍是坏包（不猜）。
  let prefix = ''
  const names = rawEntries.map((item) => item.name)
  if (!names.includes(PACK_MANIFEST)) {
    const rootFiles = names.filter((name) => !name.includes('/'))
    const topDirs = new Set<string>()
    for (const name of names) {
      const index = name.indexOf('/')
      if (index > 0) topDirs.add(name.slice(0, index))
    }
    const top = topDirs.size === 1 ? [...topDirs][0] : ''
    const wrapped =
      rootFiles.length === 0 &&
      Boolean(top) &&
      names.includes(`${top}/${PACK_MANIFEST}`) &&
      names.every((name) => name.startsWith(`${top}/`))
    if (!wrapped) {
      if (rootFiles.length === 0 && topDirs.size > 1) {
        throw badPayload(
          `资料包 zip 有多个顶层目录且根级没有 manifest.json：${[...topDirs].slice(0, 3).join('、')}`
        )
      }
      throw badPayload('资料包 zip 根级缺少 manifest.json（不是 umi-character-pack/1 资料包）')
    }
    prefix = `${top}/`
    warnings.push(`zip 套了一层顶层目录「${top}」，已自动忽略该前缀`)
  }

  const entries: PackEntrySource[] = []
  for (const item of rawEntries) {
    const name = prefix ? item.name.slice(prefix.length) : item.name
    if (!name) continue
    // 剥前缀后再校验一次（防御性：前缀剥离不能制造越界名）
    if (!isSafeArchiveEntryName(name)) {
      throw badPayload(`资料包条目路径非法（疑似路径穿越/zip-slip），已拒绝：${name}`)
    }
    entries.push({
      name,
      size: item.declared,
      read: () => {
        let data: Buffer
        try {
          data = item.entry.getData()
        } catch {
          throw badPayload(`资料包条目 ${item.name} 解压失败（zip 损坏）`)
        }
        if (data.byteLength !== item.declared) {
          throw badPayload(
            `资料包条目 ${item.name} 解压后大小不符（声明 ${item.declared}，实际 ${data.byteLength}）`
          )
        }
        return data
      }
    })
  }
  return buildPlan(entries, abs, declaredTotal, warnings, Date.now())
}

// ── 导出：把当前（含内置合并后）内容写成资料包目录 ──────────────────────────

function formatPackStamp(now: number): string {
  const d = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`
}

/** 扫描目录下所有 .md（递归，跳过符号链接）；返回相对扫描根的 posix 路径 */
function collectMarkdown(
  rootDir: string,
  warn: (message: string) => void
): MarkdownFileRef[] {
  const out: MarkdownFileRef[] = []
  const walk = (absDir: string, relDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(absDir).sort()
    } catch {
      return
    }
    for (const name of names) {
      const abs = join(absDir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      let info
      try {
        info = lstatSync(abs)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        warn(`忽略符号链接：${rel}`)
        continue
      }
      if (info.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!info.isFile() || !/\.md$/i.test(name)) continue
      out.push({ rel: toPosix(rel), abs, size: info.size })
    }
  }
  walk(rootDir, '')
  return out
}

/** 读一篇 .md：超 512KB 或含 NUL 时跳过并警告（导出要保证产物一定能再导入） */
function readMarkdownForSnapshot(
  file: MarkdownFileRef,
  label: string,
  warn: (message: string) => void
): Buffer | null {
  if (file.size > PACK_MAX_FILE_BYTES) {
    warn(`${label} 超过 512KB，已跳过：${file.rel}`)
    return null
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(file.abs)
  } catch {
    warn(`${label} 读取失败，已跳过：${file.rel}`)
    return null
  }
  if (bytes.byteLength > PACK_MAX_FILE_BYTES) {
    warn(`${label} 超过 512KB，已跳过：${file.rel}`)
    return null
  }
  if (bytes.includes(0)) {
    warn(`${label} 含 NUL 字符，已跳过：${file.rel}`)
    return null
  }
  return bytes
}

function listRootMarkdown(rootDir: string): MarkdownFileRef[] {
  let names: string[]
  try {
    names = readdirSync(rootDir).sort()
  } catch {
    return []
  }
  const out: MarkdownFileRef[] = []
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue
    const abs = join(rootDir, name)
    try {
      const info = statSync(abs)
      if (!info.isFile()) continue
      out.push({ rel: name, abs, size: info.size })
    } catch {
      /* 单篇读不到不影响整包 */
    }
  }
  return out
}

export function snapshotCurrent(options: SnapshotCurrentOptions): SnapshotCurrentResult {
  const now = Number.isFinite(options.now) ? Math.floor(options.now as number) : Date.now()
  const workspaceDir = String(options.workspaceDir ?? '').trim()
  if (!workspaceDir) throw badPayload('缺少角色 workspace 目录')
  const outputDir = String(options.outputDir ?? '').trim()
  if (!outputDir) throw badPayload('缺少资料包导出目录')
  const vault = String(options.vaultDir ?? '').trim()
  const warnings: string[] = []
  const warn = makeWarn(warnings)
  const files: Array<{ rel: string; data: Buffer }> = []
  const counts: SnapshotCounts = {
    persona: 0,
    topics: 0,
    lineGroups: 0,
    knowledge: 0,
    relations: 0,
    diaries: 0
  }

  // 目标目录：只在其下新建 大肥鱼资料包-<时间>/，绝不清空/覆盖用户目录里的其它文件
  let outAbs
  try {
    outAbs = statSync(resolve(outputDir))
  } catch {
    throw badPayload('资料包导出位置不存在或不可读')
  }
  if (!outAbs.isDirectory()) throw badPayload('资料包导出位置不是文件夹')
  const stamp = formatPackStamp(now)
  let dir = join(resolve(outputDir), `${PACK_DIR_PREFIX}-${stamp}`)
  for (let i = 2; existsSync(dir); i += 1) {
    dir = join(resolve(outputDir), `${PACK_DIR_PREFIX}-${stamp}-${i}`)
  }

  // 1) 人格：未初始化时跳过并 warning（不整体失败），与 Lead 补充契约一致
  const personaRaw = readPersonaFiles(workspaceDir)
  const personaFiles: Partial<Record<PersonaSlot, string>> = {}
  let personaTotal = 0
  for (const slot of PERSONA_PACKAGE_SLOTS) {
    const text = personaRaw[slot]
    if (typeof text !== 'string') continue
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > PACK_PERSONA_MAX_FILE_BYTES) {
      warn(`人格文件 ${slot} 超过 512KB，已跳过`)
      continue
    }
    if (personaTotal + bytes > PACK_PERSONA_MAX_TOTAL_BYTES) {
      warn(`人格文件总体积超过 2MB，${slot} 及后续槽位已跳过`)
      break
    }
    personaTotal += bytes
    personaFiles[slot] = text
  }
  const personaSlots = Object.keys(personaFiles) as PersonaSlot[]
  if (personaSlots.length === 0) {
    warn('人格文件尚未初始化或全部超限，persona.json 已跳过')
  } else {
    const pkg: PersonaPackage = {
      version: 1,
      herName: CHARACTER_HER_NAME,
      exportedAt: now,
      files: personaFiles
    }
    counts.persona = personaSlots.length
    files.push({
      rel: PACK_PERSONA,
      data: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    })
  }

  // 2) 主动消息：必须是合并后的 deck（含内置），不能只读用户语料文件
  if (!options.deck) {
    warn('未提供合并后的主动消息语料（content deck），proactive/ 已跳过')
  } else {
    const topNodes = options.deck.topics.topics
    const topicCards = topNodes.slice(0, PACK_MAX_TOPICS)
    if (topNodes.length > topicCards.length) {
      warn(`话题卡超过 ${PACK_MAX_TOPICS} 张，已截断到 ${PACK_MAX_TOPICS} 张`)
    }
    if (topicCards.length === 0) {
      warn('没有可导出的话题卡，proactive/topics.json 已跳过')
    } else {
      const deck: TopicDeck = {
        schema: 'fish-topics/1',
        version: options.deck.topics.version || '1.0.0',
        topics: topicCards
      }
      counts.topics = topicCards.length
      files.push({
        rel: PACK_TOPICS,
        data: Buffer.from(`${JSON.stringify(deck, null, 2)}\n`, 'utf8')
      })
    }
    const allGroups = Object.keys(options.deck.lines.groups).sort()
    const groupNames = allGroups.slice(0, PACK_MAX_LINE_GROUPS)
    if (allGroups.length > groupNames.length) {
      warn(`台词组超过 ${PACK_MAX_LINE_GROUPS} 组，已截断到 ${PACK_MAX_LINE_GROUPS} 组`)
    }
    const groups: Record<string, string[]> = {}
    for (const name of groupNames) {
      const lines = options.deck.lines.groups[name] ?? []
      if (lines.length) groups[name] = [...lines]
    }
    if (Object.keys(groups).length === 0) {
      warn('没有可导出的台词组，proactive/lines.json 已跳过')
    } else {
      const deck: LineDeck = {
        schema: 'fish-lines/1',
        version: options.deck.lines.version || '1.0.0',
        groups
      }
      counts.lineGroups = Object.keys(groups).length
      files.push({
        rel: PACK_LINES,
        data: Buffer.from(`${JSON.stringify(deck, null, 2)}\n`, 'utf8')
      })
    }
  }

  // 3) 知识与关系记忆：从既有 Obsidian vault 白名单目录扫描，正文原样（导入时剥 frontmatter 再写）
  if (!vault) {
    warn('未配置 Obsidian vault，知识与关系记忆已跳过')
  } else if (!existsSync(vault)) {
    warn('Obsidian vault 目录不存在，知识与关系记忆已跳过')
  } else {
    const knowledgeRefs: Array<{ category: KnowledgeCategory; file: MarkdownFileRef }> = []
    for (const category of KNOWLEDGE_CATEGORIES) {
      for (const file of collectMarkdown(join(vault, '大肥鱼', category), warn)) {
        knowledgeRefs.push({ category, file })
      }
    }
    const pickedKnowledge = knowledgeRefs.slice(0, PACK_MAX_KNOWLEDGE_FILES)
    if (knowledgeRefs.length > pickedKnowledge.length) {
      warn(
        `知识笔记 ${knowledgeRefs.length} 篇，超过 ${PACK_MAX_KNOWLEDGE_FILES} 篇上限，已截断到 ${PACK_MAX_KNOWLEDGE_FILES} 篇`
      )
    }
    for (const item of pickedKnowledge) {
      const bytes = readMarkdownForSnapshot(item.file, '知识笔记', warn)
      if (!bytes) continue
      counts.knowledge += 1
      files.push({
        rel: `${PACK_KNOWLEDGE_DIR}/${item.category}/${item.file.rel}`,
        data: bytes
      })
    }

    const relationRefs: Array<{ kind: MemoryRelationKind; name: string; file: MarkdownFileRef }> = []
    for (const kind of MEMORY_RELATION_KINDS) {
      const base = join(vault, '大肥鱼', '关系')
      // 目录形态（约定/*.md）与单文件形态（约定.md）都收：memoryAdmin 两种都认
      for (const file of collectMarkdown(join(base, kind), warn)) {
        relationRefs.push({ kind, name: file.rel, file })
      }
      const single = join(base, `${kind}.md`)
      try {
        const info = statSync(single)
        if (info.isFile()) relationRefs.push({ kind, name: `${kind}.md`, file: { rel: `${kind}.md`, abs: single, size: info.size } })
      } catch {
        /* 没有单文件形态就跳过 */
      }
    }
    const pickedRelations = relationRefs.slice(0, PACK_MAX_RELATIONS)
    if (relationRefs.length > pickedRelations.length) {
      warn(
        `关系记忆 ${relationRefs.length} 篇，超过 ${PACK_MAX_RELATIONS} 篇上限，已截断到 ${PACK_MAX_RELATIONS} 篇`
      )
    }
    for (const item of pickedRelations) {
      const bytes = readMarkdownForSnapshot(item.file, '关系记忆', warn)
      if (!bytes) continue
      counts.relations += 1
      files.push({
        rel: `${PACK_RELATIONS_DIR}/${item.kind}/${item.name}`,
        data: bytes
      })
    }
  }

  // 4) 日记：workspace memory/ 优先，vault 大肥鱼/日记/ 补缺（都不存在则跳过）
  const diaries = new Map<string, MarkdownFileRef>()
  for (const file of listRootMarkdown(join(workspaceDir, 'memory'))) {
    const date = file.rel.replace(/\.md$/i, '')
    if (isValidMemoryDate(date) && !diaries.has(date)) diaries.set(date, file)
  }
  if (vault && existsSync(vault)) {
    for (const file of listRootMarkdown(join(vault, '大肥鱼', '日记'))) {
      const date = file.rel.replace(/\.md$/i, '')
      if (!isValidMemoryDate(date) || diaries.has(date)) continue
      diaries.set(date, file)
    }
  }
  for (const date of [...diaries.keys()].sort()) {
    const file = diaries.get(date) as MarkdownFileRef
    const bytes = readMarkdownForSnapshot(file, '日记', warn)
    if (!bytes) continue
    counts.diaries += 1
    files.push({ rel: `${PACK_DIARIES_DIR}/${date}.md`, data: bytes })
  }

  // 5) manifest（targets 只列实际写出的类别）+ 总量复核，再统一落盘
  // memory 只声明关系记忆/日记；知识里的「关系/约定」属于 knowledge 目标，不据此声明 memory
  const targets: string[] = []
  if (counts.persona > 0) targets.push('persona')
  if (counts.relations > 0 || counts.diaries > 0) targets.push('memory')
  if (counts.topics > 0 || counts.lineGroups > 0) targets.push('proactive')
  if (counts.knowledge > 0) targets.push('knowledge')
  const manifest: CharacterPackManifest = {
    schema: PACK_SCHEMA,
    name: `${PACK_DIR_PREFIX} ${stamp}`,
    createdAt: new Date(now).toISOString(),
    source: 'umi-claw-snapshot',
    targets
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  let totalBytes = manifestBytes.byteLength
  for (const file of files) totalBytes += file.data.byteLength
  if (totalBytes > PACK_MAX_TOTAL_BYTES) {
    throw badPayload(
      `当前内容超过资料包上限 32MB（${totalBytes} 字节）：请先清理知识/日记后再导出`
    )
  }

  try {
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeAtomic(join(dir, file.rel), file.data)
    writeAtomic(join(dir, PACK_MANIFEST), manifestBytes)
  } catch (error) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.STORE_IO,
      `资料包写入失败：${(error as Error)?.message ?? String(error)}`
    )
  }

  return {
    dir,
    manifestPath: join(dir, PACK_MANIFEST),
    bytes: totalBytes,
    counts,
    warnings
  }
}

// ── 导入：先整包校验（readPack* 已完成），再逐目标写入，部分失败如实报告 ────────

function uniqueMarkdownName(dir: string, name: string): string {
  const stem = name.replace(/\.md$/i, '') || '未命名'
  let candidate = `${stem}.md`
  let n = 2
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}-${n}.md`
    n += 1
  }
  return candidate
}

export async function importPack(options: ImportPackOptions): Promise<ImportPackResult> {
  const plan = options.plan
  const workspaceDir = String(options.workspaceDir ?? '').trim()
  if (!workspaceDir) throw badPayload('缺少角色 workspace 目录')
  if (!plan || typeof plan !== 'object') throw badPayload('缺少资料包解析结果')
  const vault = String(options.vaultDir ?? '').trim()
  const now = Number.isFinite(options.now) ? Math.floor(options.now as number) : Date.now()
  const logger = options.logger ?? (() => undefined)
  const warnings = [...plan.warnings]
  const warn = makeWarn(warnings)
  const errors: string[] = []
  const result: ImportPackResult = {
    source: plan.source,
    counts: {
      persona: [],
      topics: null,
      lines: null,
      knowledge: 0,
      relations: 0,
      diaries: 0,
      diariesSkipped: 0
    },
    warnings,
    errors,
    personaBackupDir: null,
    written: { knowledge: [], relations: [], diaries: [] }
  }
  const fail = (label: string, error: unknown): void => {
    const message = (error as Error)?.message ?? String(error)
    errors.push(`${label}失败：${message}`)
    logger(`[character] 资料包${label}失败: ${message}`)
  }

  // 1) 人格：复用 persona.importPersonaPackage（自带旧人格备份 + 边界硬段 + manifest 去记录）
  if (plan.persona) {
    try {
      const written = importPersonaPackage(workspaceDir, plan.persona, now)
      result.counts.persona = written.written
      result.personaBackupDir = written.backupDir ?? null
    } catch (error) {
      fail('人格导入', error)
    }
  }

  // 2) 主动消息：复用 contentStore 的合并语义（同 id 覆盖、台词组追加去重）
  if (plan.topics) {
    try {
      result.counts.topics = await options.content.importTopics(plan.topics)
    } catch (error) {
      fail('话题导入', error)
    }
  }
  if (plan.lines) {
    try {
      result.counts.lines = await options.content.importLines(plan.lines)
    } catch (error) {
      fail('台词导入', error)
    }
  }

  // 3) 知识与关系：写既有 Obsidian vault（不新增知识库）；同名不覆盖
  const needsVault = plan.knowledge.length > 0 || plan.relations.length > 0
  const vaultUsable = Boolean(vault) && existsSync(vault)
  if (needsVault && !vaultUsable) {
    errors.push('未配置 Obsidian vault（或目录不存在），知识与关系记忆未导入')
    logger('[character] 资料包知识/关系导入跳过：未配置 Obsidian vault')
  } else if (vaultUsable) {
    // 「大肥鱼/关系/约定」既是知识类别也是关系记忆 kind：本机导出的资料包会同时包含
    // knowledge/关系/约定 与 memory/relations/约定 两处同一篇笔记。内容完全相同就只按
    // 关系记忆（原文写入、不重生成 frontmatter）落一次，避免导入后同目录出现两份副本。
    const relationTexts = new Set(
      plan.relations.map((item) => stripFrontmatter(item.text).trim())
    )
    const byCategory = new Map<KnowledgeCategory, KnowledgeFileInput[]>()
    // 「关系/约定」知识写成文件后，同包内的关系记忆用同名基名就跳过（不生成 -2）
    const relationStemsByCategory = new Map<KnowledgeCategory, string[]>()
    for (const item of plan.knowledge) {
      const body = stripFrontmatter(item.text).trim()
      if (!body) {
        warn(`知识笔记正文为空，已跳过：${item.name}`)
        continue
      }
      if (item.category === '关系/约定' && relationTexts.has(body)) {
        warn(`知识「关系/约定」与关系记忆内容重复，已按关系记忆导入：${item.name}`)
        continue
      }
      const text = `${body}\n`
      const list = byCategory.get(item.category) ?? []
      list.push({ name: item.name, text })
      byCategory.set(item.category, list)
      if (item.category === '关系/约定') {
        const stems = relationStemsByCategory.get(item.category) ?? []
        stems.push(`大肥鱼/关系/约定/${sanitizeKnowledgeName(item.name).replace(/\.md$/i, '')}`)
        relationStemsByCategory.set(item.category, stems)
      }
    }
    const writtenRelationStems = new Set<string>()
    for (const [category, files] of byCategory) {
      try {
        const written = writeKnowledgeFiles(vault, category, files, now)
        result.counts.knowledge += written.written.length
        result.written.knowledge.push(...written.written)
        if (category === '关系/约定') {
          for (const stem of relationStemsByCategory.get(category) ?? []) {
            writtenRelationStems.add(stem)
          }
        }
      } catch (error) {
        fail(`知识（${category}）写入`, error)
      }
    }
    // 同包内 knowledge/关系/约定/X.md 与 memory/relations/约定/X.md 会落到同一目标目录：
    // 知识已经写了同名基名就跳过关系那条并提示，不再生成 X-2.md（用户已有文件仍走加序号，不覆盖）
    for (const item of plan.relations) {
      try {
        const stem = sanitizeKnowledgeName(item.name).replace(/\.md$/i, '')
        if (writtenRelationStems.has(`大肥鱼/关系/${item.kind}/${stem}`)) {
          warn(`资料包内知识与关系记忆同名同目标，关系记忆已跳过（不生成 -2）：${item.name}`)
          continue
        }
        const targetDir = safeVaultPath(vault, join(MEMORY_RELATION_ROOT, item.kind))
        mkdirSync(targetDir, { recursive: true })
        const name = uniqueMarkdownName(targetDir, sanitizeKnowledgeName(item.name))
        writeAtomic(join(targetDir, name), item.text)
        result.counts.relations += 1
        result.written.relations.push(`大肥鱼/关系/${item.kind}/${name}`)
      } catch (error) {
        fail(`关系记忆（${item.kind}）写入`, error)
      }
    }
  }

  // 4) 日记：只写本地 workspace memory/；同日已存在跳过（不覆盖用户当天日记）
  for (const item of plan.diaries) {
    const abs = join(workspaceDir, 'memory', `${item.date}.md`)
    if (existsSync(abs)) {
      warn(`日记 ${item.date} 已存在，已跳过（不覆盖）`)
      result.counts.diariesSkipped += 1
      continue
    }
    try {
      writeAtomic(abs, item.text)
      result.counts.diaries += 1
      result.written.diaries.push(item.date)
    } catch (error) {
      fail(`日记 ${item.date} 写入`, error)
    }
  }

  // 5) 全目标失败才抛错；部分成功照样返回（计数 + errors 如实展示）
  const successCount =
    result.counts.persona.length +
    (result.counts.topics ? 1 : 0) +
    (result.counts.lines ? 1 : 0) +
    result.counts.knowledge +
    result.counts.relations +
    result.counts.diaries
  if (errors.length > 0 && successCount === 0) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.STORE_IO,
      `资料包导入失败，未写入任何内容：${errors.join('；')}`
    )
  }
  // 没有任何失败、但也没写进东西（例如日记全部已存在）：明确提示，避免「已导入」的错觉
  if (errors.length === 0 && successCount === 0) {
    warn('没有写入任何内容：包内条目全部已存在或被跳过')
  }

  logger(
    `[character] 资料包已导入：人格 ${result.counts.persona.length} / 话题 ${
      result.counts.topics?.added ?? 0
    } 张新增 / 台词 ${result.counts.lines?.linesAdded ?? 0} 句 / 知识 ${
      result.counts.knowledge
    } 篇 / 关系 ${result.counts.relations} 篇 / 日记 ${result.counts.diaries} 篇` +
      (errors.length ? `；${errors.length} 项失败` : '')
  )
  return result
}
