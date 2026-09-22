// work/knowledgeManager.ts —— 工作知识库（PLAN-3.0.md §十 / §6.3 / §14 knowledge）
//
// 复用 2.0 的解析管线（documentParsers / urlParser），数据源换成全局 `knowledge` 表
// （3.0 无 project 维度：去掉 project_id）。
//
// 操作：list / get / create(手输 text/markdown/faq) / import(url 与文件，解析+原件落盘)
//      update / delete(幂等) / search(LIKE，仅 ready)
//
// 原件落 `data/knowledge/`（2.0 是 data/projects/<id>/；3.0 无 project）。
// 重导入同一份文件按 UNIQUE(source_path) upsert 覆盖。
//
// 预算内全量优先（§6.3）由 ContextEngine 消费本表实现；本模块只负责存取与解析。
//
// 本模块不 import electron；DB 注入，htmlFetcher 可注入，纯 Node 可测。

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import {
  FILE_TYPE_EXTENSIONS,
  LEGACY_OFFICE_EXTENSIONS,
  PARSEABLE_FILE_TYPES,
  TEXT_FILE_EXTENSIONS,
  assertFileTypeMatchesPath,
  extensionOf,
  parseDocumentFile,
  parseTextFile
} from './parsers/documentParsers'
import {
  assertImportableUrl,
  extractTextFromHtml,
  fetchHtmlPage,
  type HtmlFetcher
} from './parsers/urlParser'
import type { PdfjsAssets } from './parsers/pdfjsAssets'

export const KNOWLEDGE_TYPES = ['text', 'markdown', 'url', 'faq', 'docx', 'xlsx', 'pdf'] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

export const KNOWLEDGE_MANUAL_TYPES = ['text', 'markdown', 'faq'] as const

export const KNOWLEDGE_STATUS_READY = 'ready'
export const KNOWLEDGE_TITLE_MAX_LENGTH = 120
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 2_000_000
export const CONTENT_TRUNCATE_MARKER = '\n\n（内容过长已截断，完整原文请查看原始文件）'
export const KNOWLEDGE_QUERY_MAX_LENGTH = 200
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 200
export const DEFAULT_LIST_LIMIT = 500
export const FALLBACK_TITLE = '未命名资料'

export const KNOWLEDGE_SUBDIR = 'knowledge'

/** knowledge 行（与 schema DDL / worker 白名单对应） */
export interface KnowledgeRow {
  id: string
  title: string
  type: string
  source_path: string | null
  source_name: string | null
  content: string
  status: string
  created_at: number
  updated_at: number
}

export interface CreateKnowledgeInput {
  type: 'text' | 'markdown' | 'faq'
  content: string
  title?: string | null
}

export interface ImportKnowledgeInput {
  /** url / docx / xlsx / pdf / text / markdown */
  type: KnowledgeType
  title?: string | null
  /** url 类必填 */
  url?: string
  /** 文件类必填（须来自主进程 pickFile 并复核，硬规则 23） */
  filePath?: string
  /** text/markdown 无文件时直接给文本 */
  text?: string
}

export interface UpdateKnowledgeInput {
  title?: string
  content?: string
}

export interface KnowledgeSearchHit {
  id: string
  title: string
  snippet: string
}

export interface ListKnowledgeParams {
  status?: string
  limit?: number
}

export interface KnowledgeManagerOptions {
  database: DatabaseClient
  /** 原件落点根目录（data）；本 manager 写 data/knowledge/ */
  dataDir: string
  pdfjsAssets: PdfjsAssets
  htmlFetcher?: HtmlFetcher
  listLimit?: number
  logger?: (message: string) => void
  newId?: () => string
}

export class KnowledgeManager {
  private readonly database: DatabaseClient
  private readonly knowledgeDir: string
  private readonly pdfjsAssets: PdfjsAssets
  private readonly htmlFetcher: HtmlFetcher
  private readonly listLimit: number
  private readonly logger?: (message: string) => void
  private readonly newId: () => string

  constructor(options: KnowledgeManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'KnowledgeManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'KnowledgeManager 缺少依赖: database')
    }
    if (!options.dataDir) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '缺少 dataDir')
    if (!options.pdfjsAssets) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '缺少 pdfjsAssets')
    this.database = options.database
    this.knowledgeDir = join(options.dataDir, KNOWLEDGE_SUBDIR)
    this.pdfjsAssets = options.pdfjsAssets
    this.htmlFetcher = options.htmlFetcher ?? fetchHtmlPage
    this.listLimit = clamp(options.listLimit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT, 1, 5000)
    this.logger = options.logger
    this.newId = options.newId ?? (() => randomUUID())
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  // ── 读 ─────────────────────────────────────────────────────────────────────

  async list(params: ListKnowledgeParams = {}): Promise<KnowledgeRow[]> {
    const where: Record<string, unknown> = {}
    if (params.status) where.status = params.status
    return this.database.request<KnowledgeRow[]>('knowledge.list', {
      where,
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: clamp(params.limit ?? this.listLimit, this.listLimit, 1, 5000)
    })
  }

  async get(id: string): Promise<KnowledgeRow> {
    const row = await this.database.request<KnowledgeRow | null>('knowledge.get', {
      keys: { id: requireText(id, 'id') }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `知识条目不存在: ${id}`)
    return row
  }

  // ── 手工录入（text/markdown/faq；source_path=NULL）──
  async create(input: CreateKnowledgeInput): Promise<KnowledgeRow> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'create 需要入参对象')
    }
    if (!KNOWLEDGE_MANUAL_TYPES.includes(input.type)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `手工录入只支持 text/markdown/faq（实际 ${input.type}）`, {
        field: 'type'
      })
    }
    const raw = requireContent(input.content)
    const content = input.type === 'faq' ? normalizeFaqText(raw) : raw
    const title = normalizeTitle(input.title, firstLine(content)) ?? FALLBACK_TITLE
    const id = this.newId()
    const now = Date.now()
    await this.database.request('knowledge.create', {
      data: {
        id,
        title,
        type: input.type,
        source_path: null,
        source_name: null,
        content: truncateContent(content, this.logger),
        status: KNOWLEDGE_STATUS_READY,
        created_at: now,
        updated_at: now
      }
    })
    return this.get(id)
  }

  // ── 导入（url / 文件；先解析后落盘）──
  async importKnowledge(input: ImportKnowledgeInput): Promise<KnowledgeRow> {
    const type = requireImportType(input?.type)
    const explicitTitle = normalizeTitle(input?.title, null)

    let content: string
    let sourcePath: string | null = null
    let sourceName: string | null = null
    let title = explicitTitle

    if (type === 'url') {
      const url = assertImportableUrl(input?.url)
      const fetched = await this.htmlFetcher(url)
      const { title: pageTitle, text } = extractTextFromHtml(fetched.html)
      content = text
      if (!content) {
        throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `页面没有抽取到正文: ${url}`, {
          kind: 'url',
          reason: 'empty-text'
        })
      }
      sourcePath = url
      sourceName = url
      title ??= normalizeTitle(pageTitle, defaultUrlTitle(url))
      this.log(`[knowledge] url 导入 ${url}（${content.length} 字，HTTP ${fetched.status}）`)
    } else if (PARSEABLE_FILE_TYPES.includes(type as (typeof PARSEABLE_FILE_TYPES)[number])) {
      const filePath = requireText(input?.filePath, 'filePath')
      assertFileTypeMatchesPath(type, filePath)
      const parsed = await parseDocumentFile(
        type as (typeof PARSEABLE_FILE_TYPES)[number],
        filePath,
        { assets: this.pdfjsAssets }
      )
      content = parsed.content
      const copied = this.copySourceFile(filePath)
      sourcePath = copied.relPath
      sourceName = copied.name
      title ??= normalizeTitle(null, nameWithoutExtension(copied.name))
      this.log(`[knowledge] ${type} 导入 ${copied.relPath}（${content.length} 字）`)
    } else {
      // text/markdown：可给文件（同 docx 口径落盘），也可直接给文本
      const filePath = optionalPath(input?.filePath)
      if (filePath) {
        const parsed = await parseTextFile(type as 'text' | 'markdown', filePath)
        content = parsed.content
        const copied = this.copySourceFile(filePath)
        sourcePath = copied.relPath
        sourceName = copied.name
        title ??= normalizeTitle(null, nameWithoutExtension(copied.name))
        this.log(`[knowledge] ${type} 文件导入 ${copied.relPath}`)
      } else {
        const raw = requireContent(input?.text)
        content = raw
        title ??= normalizeTitle(null, firstLine(content))
      }
    }

    return this.upsertBySource({
      title: title ?? FALLBACK_TITLE,
      type,
      source_path: sourcePath,
      source_name: sourceName,
      content: truncateContent(content, this.logger)
    })
  }

  // ── 更新（仅 title/content；白名单）──
  async update(id: string, patch: UpdateKnowledgeInput): Promise<KnowledgeRow> {
    const existing = await this.get(id)
    if (!patch || typeof patch !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'update 需要 patch 对象', { field: 'patch' })
    }
    const unknown = Object.keys(patch).filter((k) => k !== 'title' && k !== 'content')
    if (unknown.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不允许更新的字段: ${unknown.join(', ')}（仅 title, content）`)
    }
    const data: Record<string, unknown> = {}
    let changed = false
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      const t = normalizeTitle(patch.title, null)
      if (!t) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '标题不能为空', { field: 'title' })
      data.title = t
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
      data.content = truncateContent(requireContent(patch.content), this.logger)
      changed = true
    }
    if (!changed) return existing
    await this.database.request('knowledge.update', {
      keys: { id: existing.id },
      data,
      required: true
    })
    return this.get(existing.id)
  }

  /** 删除（幂等：不存在/已删 → deleted:false 不报错）；磁盘原件保留（事实来源，更安全） */
  async delete(id: string): Promise<{ id: string; deleted: boolean }> {
    const kid = requireText(id, 'id')
    const row = await this.database.request<KnowledgeRow | null>('knowledge.get', { keys: { id: kid } })
    if (!row) return { id: kid, deleted: false }
    await this.database.request('knowledge.delete', { keys: { id: kid } })
    return { id: kid, deleted: true }
  }

  // ── 检索（LIKE，仅 ready；空白 query 报错）──
  async search(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<KnowledgeSearchHit[]> {
    const keyword = requireQuery(query)
    const rows = await this.database.request<Array<Record<string, unknown>>>('knowledge.search', {
      query: keyword,
      limit: clamp(limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
      status: KNOWLEDGE_STATUS_READY
    })
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: String(row?.id ?? ''),
      title: String(row?.title ?? ''),
      snippet: String(row?.snippet ?? '')
    }))
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 拷原件进 data/knowledge/<id>/，返回相对/文件名（source_path 存相对，可溯源） */
  private copySourceFile(absFilePath: string): { relPath: string; name: string } {
    const name = sanitizeFileName(basename(absFilePath))
    const id = this.newId()
    const destDir = join(this.knowledgeDir, id)
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, name)
    copyFileSync(absFilePath, dest)
    // source_path 存 data/knowledge/<id>/<name> 的相对（相对 dataDir），与 2.0 口径一致
    return { relPath: join(KNOWLEDGE_SUBDIR, id, name), name }
  }

  /** 有 source_path → 按 UNIQUE(source_path) upsert；无 → create */
  private async upsertBySource(seed: {
    title: string
    type: string
    source_path: string | null
    source_name: string | null
    content: string
  }): Promise<KnowledgeRow> {
    if (!seed.source_path) {
      const id = this.newId()
      const now = Date.now()
      await this.database.request('knowledge.create', {
        data: { id, ...seed, status: KNOWLEDGE_STATUS_READY, created_at: now, updated_at: now }
      })
      return this.get(id)
    }
    // 读既有（同 source_path）
    const existingList = await this.database.request<KnowledgeRow[]>('knowledge.list', {
      where: { source_path: seed.source_path },
      limit: 1
    })
    const existing = existingList[0]
    if (existing) {
      await this.database.request('knowledge.update', {
        keys: { id: existing.id },
        data: {
          title: seed.title,
          type: seed.type,
          source_name: seed.source_name,
          content: seed.content
        },
        required: true
      })
      return this.get(existing.id)
    }
    const id = this.newId()
    const now = Date.now()
    await this.database.request('knowledge.create', {
      data: { id, ...seed, status: KNOWLEDGE_STATUS_READY, created_at: now, updated_at: now }
    })
    return this.get(id)
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function clamp(v: number, dflt: number, lo: number, hi: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

function requireText(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 不能为空`, { field })
  return s
}

function optionalPath(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s || null
}

function requireContent(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '内容不能为空', { field: 'content' })
  return s
}

function requireImportType(v: unknown): KnowledgeType {
  if (!KNOWLEDGE_TYPES.includes(v as KnowledgeType)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法或缺失 type: ${String(v)}`, { field: 'type' })
  }
  return v as KnowledgeType
}

function requireQuery(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '检索词不能为空', { field: 'query' })
  if (s.length > KNOWLEDGE_QUERY_MAX_LENGTH) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `检索词不能超过 ${KNOWLEDGE_QUERY_MAX_LENGTH} 字`)
  }
  return s
}

function normalizeTitle(v: unknown, fallback: string | null): string | null {
  if (v === null || v === undefined) return fallback
  if (typeof v !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '标题必须是字符串')
  }
  const s = v.trim()
  if (!s) return fallback
  if (s.length > KNOWLEDGE_TITLE_MAX_LENGTH) return s.slice(0, KNOWLEDGE_TITLE_MAX_LENGTH)
  return s
}

function truncateContent(content: string, logger?: (m: string) => void): string {
  if (content.length <= KNOWLEDGE_CONTENT_MAX_LENGTH) return content
  logger?.(`[knowledge] 内容超过 ${KNOWLEDGE_CONTENT_MAX_LENGTH} 字，已截断`)
  return content.slice(0, KNOWLEDGE_CONTENT_MAX_LENGTH) + CONTENT_TRUNCATE_MARKER
}

function firstLine(content: string): string {
  const line = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? ''
  return line.slice(0, KNOWLEDGE_TITLE_MAX_LENGTH)
}

function nameWithoutExtension(name: string): string {
  const ext = extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

export function sanitizeFileName(name: string): string {
  // 防路径穿越：只保留基名，剥掉非法字符
  const base = basename(String(name))
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'unnamed'
}

/** faq 结构化：Q/A 行规整（沿用 2.0 口径，保证两入口一致） */
export function normalizeFaqText(text: string): string {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/g, ''))
  const out: string[] = []
  let pendingQ = false
  for (const line of lines) {
    if (/^\s*Q\s*[:：]/.test(line)) {
      out.push(line.replace(/^\s*Q\s*[:：]\s*/, 'Q：').trim())
      pendingQ = true
    } else if (/^\s*A\s*[:：]/.test(line)) {
      out.push(line.replace(/^\s*A\s*[:：]\s*/, 'A：').trim())
      pendingQ = false
    } else if (line.trim()) {
      out.push((pendingQ ? 'A：' : 'Q：') + line.trim())
      pendingQ = !pendingQ
    }
  }
  return out.join('\n')
}

function defaultUrlTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || FALLBACK_TITLE
  } catch {
    return FALLBACK_TITLE
  }
}

export function createKnowledgeManager(options: KnowledgeManagerOptions): KnowledgeManager {
  return new KnowledgeManager(options)
}

// 保持引用（避免未使用告警；这些常量供主进程/校验参考）
void existsSync
void readFileSync
void LEGACY_OFFICE_EXTENSIONS
void FILE_TYPE_EXTENSIONS
void TEXT_FILE_EXTENSIONS
void extensionOf
