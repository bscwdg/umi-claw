// knowledgeManager.ts —— Knowledge（知识库）导入 / 检索（PLAN-2.0.md Commit 05a）
//
// 契约（§一 定位 / §二 硬规则 9 / §四 Schema / §五 IPC / §七「Commit 05 边界」/ §十 概念备忘）：
//   - 知识库是**一级能力**，不是 BusinessBrain 的子功能（§十）。存的是「商家事实知识」：
//     套系单、价目表、话术、常见问答、自家官网文章……
//   - **External Intelligence ≠ Merchant Knowledge**（§十）：热点雷达等外部情报永不自动写入知识库，
//     只有老板人工采纳的事实才进来。本模块因此**没有任何自动写入路径**：每一个条目都来自
//     一次显式的 `importKnowledge` / `createKnowledge` 调用（人在跟前点的）。
//   - 每个业务方法**显式接收 projectId**，绝不读全局 currentProject 做隐式推断（硬规则 9）。
//   - 隔离：`getKnowledge` / `updateKnowledge` / `deleteKnowledge` 一律校验 `row.project_id`，
//     跨 Project 的 id 视同不存在（NOT_FOUND），杜绝「换个商家还能看到别家资料」。
//
//   ⚠️ 本模块**绝不采集**（硬规则 11/12）：不爬站、不遍历站点、不建队列、无任何后台定时写入；
//     采集/抓取只属于 Commit 11 的 collector adapter，与本模块无关。
//     唯一的出站动作是 url 类导入时对**用户显式粘贴的 URL** 发一次 GET（见 parsers/urlParser.ts）
//     —— 那是人工触发的「把这篇自家文章存进知识库」，不是采集。
//
// 导入语义（§七 05a 原文，逐字落实）：
//   导入时本地确定性解析一次 → 文本存 `knowledge_items.content`，
//   原文件留 `data/projects/<id>/`、库存 `source_path`；**运行时不再解析，重导入覆盖**。
//   - 重导入的 upsert 键 = `UNIQUE(project_id, source_path)`（§四）。本模块先按该键查既有行，
//     再用既有 `id` 走 `knowledge_items.upsert`（`ON CONFLICT(id) DO UPDATE`）——与
//     businessManager 处理 `UNIQUE(project_id)` 的手法一致；首次插入撞键时回落更新路径重试一次。
//   - `source_path` 存**相对 dataDir 的路径**（`projects/<id>/<文件名>`，正斜杠），
//     理由：本项目是**便携**应用，`data/` 会随安装目录搬移；绝对路径一旦搬移就全部失效，
//     而相对路径可随时用 `join(dataDir, source_path)` 还原。URL 类条目的 `source_path` = 原始 URL。
//   - text/markdown/faq 的 `source_path` 为 `null`（§四 注释：NULL 互不冲突 → 每次都是新条目）。
//   - 多模态/扫描件 AI 识别属 **05b**，本期不做（`image` 类型在本模块直接被拒并提示）。
//
// 解析失败一律 `FILE_PARSE_ERROR`，**不落任何行、不拷任何文件**：
//   - 解析在「拷贝 + 写库」之前，失败即中断 → 库里不会出现空内容行（§七 05a 硬要求），
//     磁盘上也不会留下没人引用的孤儿文件；
//   - 扫描件（无文字层 PDF）走同一路径，错误码 FILE_PARSE_ERROR + `details.reason='scanned-pdf'`，
//     UI 据此把这一条标红并给「重新导入」入口（条目标红属 UI 状态，不是库里的行）。
//
// 设计约束：本模块**不 import electron**（依赖 database / dataDir / pdfjs 资产 / 抓取器全部注入），
// 因此可在纯 Node 下被 esbuild bundle 后直接测试（test/knowledge.accept.mjs）。

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { AppError, ERROR_CODES, errorCodeOf } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { PROJECTS_SUBDIR } from './projectManager'
import {
  PARSEABLE_FILE_TYPES,
  assertFileTypeMatchesPath,
  parseDocumentFile,
  type ParseableFileType
} from './parsers/documentParsers'
import { assertImportableUrl, extractTextFromHtml, fetchHtmlPage, type HtmlFetcher } from './parsers/urlParser'
import type { PdfjsAssets } from './parsers/pdfjsAssets'

/** §四 `knowledge_items.type`：05a 支持的全部取值（`image` 属 05b，不在其中） */
export const KNOWLEDGE_TYPES = ['text', 'markdown', 'url', 'faq', 'docx', 'xlsx', 'pdf'] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

/** 手工录入类（`source_path` 为 NULL，不参与重导入 upsert） */
export const KNOWLEDGE_MANUAL_TYPES = ['text', 'markdown', 'faq'] as const

/** 文件类（必须给 filePath，走本地确定性解析） */
export const KNOWLEDGE_FILE_TYPES = PARSEABLE_FILE_TYPES

/** 条目状态：05a 只有 `ready`（解析失败不入库，故库里不存在失败态行） */
export const KNOWLEDGE_STATUS_READY = 'ready'

/** 标题长度上限（`knowledge_items.title` NOT NULL） */
export const KNOWLEDGE_TITLE_MAX_LENGTH = 120
/** 正文长度上限（超出截断并标记：防单条超大文档把库撑爆） */
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 2_000_000
/** 超长截断标记（不静默丢数据） */
export const CONTENT_TRUNCATE_MARKER = '\n\n（内容过长已截断，完整原文请查看原始文件）'
/** 检索关键词长度上限 */
export const KNOWLEDGE_QUERY_MAX_LENGTH = 200
/** 检索默认/最大返回条数（§四 检索策略：α 阶段 LIKE） */
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 200
/** 列表默认条数（worker 上限 5000） */
export const DEFAULT_LIST_LIMIT = 500

/** 未命名条目的兜底标题（title NOT NULL，不能为空串） */
export const FALLBACK_TITLE = '未命名资料'

/** `knowledge_items` 表一行 */
export interface KnowledgeRow {
  id: string
  project_id: string
  title: string
  type: string
  source_path: string | null
  source_name: string | null
  content: string | null
  status: string
  created_at: number
  updated_at: number
}

/** 导入入参（§七 05a：text/markdown/url/faq 用 text/url，docx/xlsx/pdf 用 filePath） */
export interface ImportKnowledgeInput {
  type: string
  title?: string | null
  text?: string | null
  url?: string | null
  filePath?: string | null
}

/** §五 `knowledge.create(projectId, data)`：手工录入（text/markdown/faq） */
export interface CreateKnowledgeInput {
  title: string
  type: string
  content: string
}

/** §五 `knowledge.update`：只允许改标题与正文（type/source_path 是身份，不可改） */
export interface UpdateKnowledgeInput {
  title?: string
  content?: string
}

/** 检索命中（§五 `knowledge.search` → UI 只展示这三列） */
export interface KnowledgeSearchHit {
  id: string
  title: string
  /** 命中片段（worker 侧 substr(content,1,400)） */
  snippet: string
}

export interface KnowledgeManagerOptions {
  /** DB Worker 客户端（唯一的数据访问通道，硬规则 8） */
  database: DatabaseClient
  /** 应用数据目录（约定 `.../data`）；原文落在 `data/projects/<id>/` */
  dataDir: string
  /** pdfjs 运行时资产（cmaps / standard_fonts / worker）；缺失时 PDF 中文会抽不出来 */
  pdfjsAssets?: PdfjsAssets | null
  /** url 类抓取器（默认 `fetchHtmlPage`；测试注入假实现即可完全离线） */
  htmlFetcher?: HtmlFetcher
  /** 日志（默认静默） */
  logger?: (message: string) => void
  /** 列表默认条数 */
  listLimit?: number
}

export class KnowledgeManager {
  private readonly database: DatabaseClient
  private readonly dataDir: string
  private readonly pdfjsAssets: PdfjsAssets | null
  private readonly htmlFetcher: HtmlFetcher
  private readonly logger?: (message: string) => void
  private readonly listLimit: number

  constructor(options: KnowledgeManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'KnowledgeManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'KnowledgeManager 缺少依赖: database')
    }
    if (typeof options.dataDir !== 'string' || !options.dataDir) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'KnowledgeManager 缺少依赖: dataDir')
    }
    this.database = options.database
    this.dataDir = options.dataDir
    this.pdfjsAssets = options.pdfjsAssets ?? null
    this.htmlFetcher = options.htmlFetcher ?? fetchHtmlPage
    this.logger = options.logger
    this.listLimit = clamp(options.listLimit, DEFAULT_LIST_LIMIT, 1, 5000)
  }

  // ── 只读辅助 ────────────────────────────────────────────────────────────────

  /** `data/projects/<id>/`（与 projectManager 的落点一致；本模块只是往里放原文） */
  projectDir(projectId: string): string {
    return join(this.dataDir, PROJECTS_SUBDIR, requireId(projectId, 'projectDir'))
  }

  /** `source_path`（相对 dataDir）→ 绝对路径 */
  absolutePathOf(sourcePath: string): string {
    if (typeof sourcePath !== 'string' || !sourcePath) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'absolutePathOf 需要 sourcePath', {
        field: 'sourcePath'
      })
    }
    return join(this.dataDir, sourcePath)
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 列表 / 单条 ─────────────────────────────────────────────────────────────

  /** 该 Project 的知识条目（**新导入的排前面**；同刻按 id 收敛，排序稳定 UI 不抖） */
  async listKnowledge(projectId: string, options: { limit?: number } = {}): Promise<KnowledgeRow[]> {
    const id = requireId(projectId, 'listKnowledge')
    const limit = clamp(options.limit, this.listLimit, 1, 5000)
    const rows = await this.database.request<KnowledgeRow[]>('knowledge_items.list', {
      where: { project_id: id },
      order: ['created_at', 'id'],
      limit
    })
    const list = Array.isArray(rows) ? rows : []
    return list.slice().sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * 单条；不存在**或属于别的 Project** → NOT_FOUND。
   * 跨 Project 的 id 当作不存在：知识库按 Project 隔离（§十），
   * 「这个 id 存在但不归你」不该通过任何形式的成功返回泄漏出去。
   */
  async getKnowledge(projectId: string, id: string): Promise<KnowledgeRow> {
    const pid = requireId(projectId, 'getKnowledge')
    const kid = requireText(id, 'getKnowledge', 'id')
    const row = await this.database.request<KnowledgeRow | null>('knowledge_items.get', { keys: { id: kid } })
    if (!row || row.project_id !== pid) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `知识条目不存在: ${kid}`, { projectId: pid, id: kid })
    }
    return row
  }

  // ── 手工录入（§五 knowledge.create：text / markdown / faq） ──────────────────

  /**
   * 手工新建文本类条目。`source_path` 为 NULL（§四：NULL 互不冲突 → 每次都是新条目）。
   * 文件类/URL 类**不走这里**：它们必须经过 `importKnowledge` 的解析 + 原文落盘。
   */
  async createKnowledge(projectId: string, input: CreateKnowledgeInput): Promise<KnowledgeRow> {
    const pid = requireId(projectId, 'createKnowledge')
    const type = normalizeManualType(input?.type)
    const raw = requireContent(input?.content, 'createKnowledge')
    // faq 与 importKnowledge 走同一套结构化口径（§七 05a「faq 存结构化文本」）——
    // 两条入口必须产出一致的形态，否则同一份问答从不同入口进来会长得不一样
    const content = type === 'faq' ? normalizeFaqText(raw) : raw
    const title = normalizeTitle(input?.title, firstLine(content))
    await assertProjectExists(this.database, pid)
    return this.insertRow(pid, {
      title: title ?? FALLBACK_TITLE,
      type,
      source_path: null,
      source_name: null,
      content: truncateContent(content, this.logger)
    })
  }

  // ── 导入（§七 05a 主路径） ───────────────────────────────────────────────────

  /**
   * 导入一条知识：**本地确定性解析一次** → 写 `content`；原文件拷进 `data/projects/<id>/`。
   *
   * 顺序刻意是「先解析、后落盘/入库」：
   *   解析失败（含扫描件）→ 抛 `FILE_PARSE_ERROR`，磁盘与库都保持原样，
   *   既不会出现空内容行，也不会留下孤儿文件。
   */
  async importKnowledge(projectId: string, input: ImportKnowledgeInput): Promise<KnowledgeRow> {
    const pid = requireId(projectId, 'importKnowledge')
    const type = requireImportType(input?.type)
    const explicitTitle = normalizeTitle(input?.title, null)
    await assertProjectExists(this.database, pid)

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
        throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `页面没有抽取到任何正文: ${url}`, {
          kind: 'url',
          reason: 'empty-text',
          url
        })
      }
      // source_path = 用户给出的原始 URL（重导入按 UNIQUE(project_id, source_path) 覆盖同一条）
      sourcePath = url
      sourceName = url
      if (!title) title = normalizeTitle(pageTitle, defaultUrlTitle(url))
      this.log(`[knowledge] url 导入成功 ${url}（${content.length} 字，HTTP ${fetched.status}）`)
    } else if (isFileType(type)) {
      const filePath = requireText(input?.filePath, 'importKnowledge', 'filePath')
      assertFileTypeMatchesPath(type, filePath) // 老格式/扩展名不符在这里被翻译成人话
      const parsed = await parseDocumentFile(type, filePath, { assets: this.pdfjsAssets })
      content = parsed.content
      const copied = this.copySourceFile(pid, filePath)
      sourcePath = copied.relPath
      sourceName = copied.name
      if (!title) title = normalizeTitle(null, nameWithoutExtension(copied.name))
      this.log(
        `[knowledge] ${type} 导入成功 ${copied.relPath}（${content.length} 字，` +
          `${(parsed.meta.bytes / 1024).toFixed(1)}KB → data/projects/${pid}/）`
      )
    } else {
      const raw = requireContent(input?.text, 'importKnowledge')
      content = type === 'faq' ? normalizeFaqText(raw) : raw
      if (!title) title = normalizeTitle(null, firstLine(content))
    }

    return this.upsertRow(pid, {
      title: title ?? FALLBACK_TITLE,
      type,
      source_path: sourcePath,
      source_name: sourceName,
      content: truncateContent(content, this.logger)
    })
  }

  // ── 更新 / 删除 ─────────────────────────────────────────────────────────────

  /**
   * 改标题/正文（白名单）。未知字段 → VALIDATION_ERROR（静默丢弃会变成「改了但没生效」的幽灵 bug）。
   * 空 patch → 原样返回，**不刷 updated_at**（无意义的写入会让排序与时间戳漂移）。
   */
  async updateKnowledge(projectId: string, id: string, patch: UpdateKnowledgeInput): Promise<KnowledgeRow> {
    const pid = requireId(projectId, 'updateKnowledge')
    const existing = await this.getKnowledge(pid, id)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'updateKnowledge 需要一个 patch 对象', {
        field: 'patch'
      })
    }
    const unknown = Object.keys(patch).filter((k) => k !== 'title' && k !== 'content')
    if (unknown.length) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `不允许更新的字段: ${unknown.join(', ')}（可更新: title, content）`,
        { fields: unknown, allowed: ['title', 'content'] }
      )
    }

    const data: Record<string, unknown> = { id: existing.id, project_id: pid }
    let changed = false
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      data.title = normalizeTitle(patch.title, null)
      if (!data.title) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, '标题不能为空', { field: 'title' })
      }
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
      data.content = truncateContent(requireContent(patch.content, 'updateKnowledge'), this.logger)
      changed = true
    }
    if (!changed) return existing

    // 走 `update`（而不是 upsert）：这里确定行已存在，且 upsert 的 INSERT 分支需要提供
    // 全部 NOT NULL 列（type 等），少给一列会直接撞 `NOT NULL constraint failed`。
    // updated_at 由 worker 的 opUpdate 自动刷新，这里显式给出以便响应体里立刻可读。
    data.updated_at = Date.now()
    const res = await this.database.request<{ row: KnowledgeRow }>('knowledge_items.update', {
      keys: { id: existing.id },
      data
    })
    const saved = res?.row ?? (await this.getKnowledge(pid, existing.id))
    if (!saved) throw new AppError(ERROR_CODES.DB_ERROR, '知识条目写入后读回失败', { id: existing.id })
    this.log(`[knowledge] 已更新 ${existing.id}（project_id=${pid}）`)
    return saved
  }

  /**
   * 删除条目（**幂等**：不存在/已删 → `deleted:false`，不报错）。
   * 磁盘上的原文**保留**：原文是用户资料的事实来源，删条目不删文件更安全（孤儿文件不可见、无侧效应）；
   * 重导入同一份文件会重新建条目。
   */
  async deleteKnowledge(
    projectId: string,
    id: string
  ): Promise<{ projectId: string; id: string; deleted: boolean }> {
    const pid = requireId(projectId, 'deleteKnowledge')
    const kid = requireText(id, 'deleteKnowledge', 'id')
    const row = await this.database.request<KnowledgeRow | null>('knowledge_items.get', { keys: { id: kid } })
    if (!row || row.project_id !== pid) return { projectId: pid, id: kid, deleted: false }
    await this.database.request('knowledge_items.delete', { keys: { id: kid } })
    this.log(`[knowledge] 已删除 ${kid}（project_id=${pid}）`)
    return { projectId: pid, id: kid, deleted: true }
  }

  // ── 检索（§四 检索策略：α 阶段 SQLite LIKE 关键词） ──────────────────────────

  /**
   * 关键词检索（LIKE，中文友好）。返回 `{ id, title, snippet }`。
   *
   * 只检索 `status='ready'` 的条目（AI 上下文只该吃到可用资料）；空白 query → VALIDATION_ERROR
   * （静默返回全表会让调用方以为「搜到了」）。
   */
  async searchKnowledge(projectId: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<KnowledgeSearchHit[]> {
    const pid = requireId(projectId, 'searchKnowledge')
    const keyword = requireQuery(query)
    const rows = await this.database.request<Array<Record<string, unknown>>>('knowledge.search', {
      projectId: pid,
      query: keyword,
      limit: clamp(limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
      status: KNOWLEDGE_STATUS_READY
    })
    const list = Array.isArray(rows) ? rows : []
    return list.map((row) => ({
      id: String(row?.id ?? ''),
      title: String(row?.title ?? ''),
      snippet: String(row?.snippet ?? '')
    }))
  }

  // ── 内部：落库 ──────────────────────────────────────────────────────────────

  /** 新建行（手输条目；source_path 为 NULL，不存在 upsert 目标） */
  private async insertRow(
    projectId: string,
    seed: Omit<KnowledgeRow, 'id' | 'project_id' | 'status' | 'created_at' | 'updated_at'>
  ): Promise<KnowledgeRow> {
    const now = Date.now()
    const row: KnowledgeRow = {
      id: randomUUID(),
      project_id: projectId,
      ...seed,
      status: KNOWLEDGE_STATUS_READY,
      created_at: now,
      updated_at: now
    }
    const res = await this.database.request<{ row: KnowledgeRow }>('knowledge_items.create', { data: row })
    const saved = res?.row ?? (await this.getKnowledge(projectId, row.id))
    if (!saved) throw new AppError(ERROR_CODES.DB_ERROR, '知识条目写入后读回失败', { projectId })
    return saved
  }

  /**
   * 有 `source_path` 时按 `UNIQUE(project_id, source_path)` upsert（**重导入覆盖**）。
   *
   * 与 businessManager 的 upsert 同构：worker 的 upsert 冲突目标是主键 `id`，打不到
   * `UNIQUE(project_id, source_path)`，因此先按该键读出既有行 → 用它的 `id` 走
   * `INSERT … ON CONFLICT(id) DO UPDATE`；没有既有行则 create，若撞上并发插入的同一
   * `source_path`（worker 把 UNIQUE 映射为 CONFLICT）回落更新路径重试一次。
   */
  private async upsertRow(
    projectId: string,
    seed: Omit<KnowledgeRow, 'id' | 'project_id' | 'status' | 'created_at' | 'updated_at'>
  ): Promise<KnowledgeRow> {
    const sourcePath = seed.source_path
    for (let attempt = 1; attempt <= 2; attempt++) {
      const existing = sourcePath ? await this.findBySource(projectId, sourcePath) : null
      if (!existing) {
        try {
          return await this.insertRow(projectId, seed)
        } catch (e) {
          if (errorCodeOf(e) === ERROR_CODES.CONFLICT && attempt < 2) {
            this.log(`[knowledge] source_path=${sourcePath} 并发写入冲突，回落覆盖路径重试`)
            continue
          }
          throw e
        }
      }
      const data: KnowledgeRow = {
        id: existing.id,
        project_id: projectId,
        ...seed,
        status: KNOWLEDGE_STATUS_READY,
        // created_at 必须显式带回，否则每次重导入都把「首次导入时间」刷成现在
        created_at: existing.created_at,
        updated_at: Date.now()
      }
      const res = await this.database.request<{ row: KnowledgeRow }>('knowledge_items.upsert', { data })
      const saved = res?.row ?? (await this.getKnowledge(projectId, existing.id))
      if (!saved) throw new AppError(ERROR_CODES.DB_ERROR, '知识条目写入后读回失败', { projectId })
      this.log(`[knowledge] 重导入覆盖 ${existing.id}（source_path=${sourcePath}）`)
      return saved
    }
    throw new AppError(ERROR_CODES.DB_ERROR, '知识条目保存失败（并发重试后仍未成功）', { projectId })
  }

  /** 按 (project_id, source_path) 查既有行（重导入的 upsert 键，§四 UNIQUE） */
  private async findBySource(projectId: string, sourcePath: string): Promise<KnowledgeRow | null> {
    const rows = await this.database.request<KnowledgeRow[]>('knowledge_items.list', {
      where: { project_id: projectId, source_path: sourcePath },
      order: ['created_at', 'id'],
      limit: 2
    })
    const list = Array.isArray(rows) ? rows : []
    if (list.length > 1) {
      this.log(`[knowledge] ⚠️ source_path=${sourcePath} 有 ${list.length} 行（UNIQUE 应保证唯一）`)
    }
    return list[0] ?? null
  }

  // ── 内部：原文落盘 ──────────────────────────────────────────────────────────

  /**
   * 把原始文件拷进 `data/projects/<id>/`，返回 `source_path`（**相对 dataDir**，正斜杠）。
   *
   * 文件名按原名净化（去掉路径分隔符与 Windows 非法字符），同名即同一条——
   * 这正是「同一份文件重导入 = 覆盖」的物理基础。
   */
  private copySourceFile(projectId: string, filePath: string): { relPath: string; name: string; target: string } {
    const dir = this.projectDir(projectId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = sanitizeFileName(basename(filePath))
    const target = join(dir, name)
    try {
      // 源与目标同一路径（用户直接选了库里的副本）时跳过拷贝，避免自拷贝截断文件
      if (resolve(target) !== resolve(filePath)) copyFileSync(filePath, target)
    } catch (e) {
      throw new AppError(
        ERROR_CODES.DB_ERROR,
        `原始文件拷贝失败: ${filePath} → ${target} — ${e instanceof Error ? e.message : String(e)}`,
        { path: filePath, target, reason: 'source-copy-failed' }
      )
    }
    return { relPath: toPosixRelative(join(PROJECTS_SUBDIR, projectId, name)), name, target }
  }
}

/** 工厂（与 DatabaseClient / ProjectManager 同风格；便于纯 Node 测试与主进程 wiring） */
export function createKnowledgeManager(options: KnowledgeManagerOptions): KnowledgeManager {
  return new KnowledgeManager(options)
}

// ── 校验辅助（全部抛 §五 的 VALIDATION_ERROR） ────────────────────────────────

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

function requireText(value: unknown, method: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 ${field}`, { field })
  }
  return value.trim()
}

/** 正文（保留原始换行，只判空与长度；trim 掉首尾空白） */
function requireContent(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要非空内容`, { field: 'content' })
  }
  return value
}

function requireQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'searchKnowledge 需要非空检索词', { field: 'query' })
  }
  const q = value.trim()
  if (q.length > KNOWLEDGE_QUERY_MAX_LENGTH) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `检索词过长（${q.length} > ${KNOWLEDGE_QUERY_MAX_LENGTH}）`,
      { field: 'query', max: KNOWLEDGE_QUERY_MAX_LENGTH, length: q.length }
    )
  }
  return q
}

/** 导入类型：非法值一律 VALIDATION_ERROR，并把「05b 的 image」与「老格式」翻译成人话 */
function requireImportType(value: unknown): KnowledgeType {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'importKnowledge 需要 type', {
      field: 'type',
      allowed: [...KNOWLEDGE_TYPES]
    })
  }
  const type = value.trim()
  if (type === 'image') {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      '图片/扫描件识别属 05b（AI 兜底），本期请先提供文字版资料',
      { field: 'type', value: type, allowed: [...KNOWLEDGE_TYPES] }
    )
  }
  if (!(KNOWLEDGE_TYPES as readonly string[]).includes(type)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的知识类型: ${type}`, {
      field: 'type',
      value: type,
      allowed: [...KNOWLEDGE_TYPES]
    })
  }
  return type as KnowledgeType
}

/** 手工录入类型：只接受 text/markdown/faq（§五 knowledge.create） */
function normalizeManualType(value: unknown): string {
  const type = typeof value === 'string' ? value.trim() : ''
  if (!(KNOWLEDGE_MANUAL_TYPES as readonly string[]).includes(type)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `createKnowledge 只支持手工类型 ${KNOWLEDGE_MANUAL_TYPES.join('/')}（文件/URL 类请走 importKnowledge）`,
      { field: 'type', value: type, allowed: [...KNOWLEDGE_MANUAL_TYPES] }
    )
  }
  return type
}

function isFileType(type: string): type is ParseableFileType {
  return (KNOWLEDGE_FILE_TYPES as readonly string[]).includes(type)
}

/** 标题归一：trim + 单行 + 截断；空值回落 `fallbackText`（再空则 null，由调用方给兜底标题） */
function normalizeTitle(value: unknown, fallbackText: string | null): string | null {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  let title = raw.replace(/\s+/g, ' ').trim()
  if (!title && fallbackText) title = fallbackText.replace(/\s+/g, ' ').trim()
  if (!title) return null
  return title.length > KNOWLEDGE_TITLE_MAX_LENGTH ? title.slice(0, KNOWLEDGE_TITLE_MAX_LENGTH) : title
}

/** 首行当标题（去掉 markdown 标题符与列表符） */
function firstLine(content: string): string | null {
  const line = String(content ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .find((l) => l.length > 0)
  return line ?? null
}

/** 文件名去扩展名（默认标题来源） */
function nameWithoutExtension(name: string): string {
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  return base.trim() || name
}

/** URL 类默认标题：host + 路径末段 */
function defaultUrlTitle(url: string): string {
  try {
    const parsed = new URL(url)
    const seg = parsed.pathname.split('/').filter(Boolean).pop()
    return seg ? `${parsed.host} · ${decodeURIComponent(seg)}` : parsed.host
  } catch {
    return url
  }
}

/**
 * faq → 结构化文本（§七 05a「faq 存结构化文本」）。
 * 识别 `Q:` / `问：` / `A:` / `答：` 标记（半角全角冒号都认），统一输出成
 * `Q: 问题\nA: 答案` 的多段形态；**没有任何标记时原样保留**（宽松回退，不做猜测式改写）。
 */
export function normalizeFaqText(text: string): string {
  const blocks = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)

  const out: string[] = []
  let matched = false
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim())
    const q = lines[0].match(/^(?:Q|问|问题)\s*[:：.、]\s*(.+)$/i)
    if (!q) {
      out.push(lines.join('\n'))
      continue
    }
    matched = true
    const answer: string[] = []
    for (const line of lines.slice(1)) {
      const a = line.match(/^(?:A|答|答案)\s*[:：.、]\s*(.*)$/i)
      if (a) answer.push(a[1].trim())
      else if (line) answer.push(line)
    }
    out.push(`Q: ${q[1].trim()}\nA: ${answer.join('\n').trim()}`)
  }
  if (!matched) return String(text ?? '').trim()
  return out.join('\n\n')
}

/** 超长截断（带显式标记，不静默丢内容） */
function truncateContent(content: string, logger?: (m: string) => void): string {
  if (content.length <= KNOWLEDGE_CONTENT_MAX_LENGTH) return content
  logger?.(
    `[knowledge] ⚠️ 内容过长已截断 ${content.length} → ${KNOWLEDGE_CONTENT_MAX_LENGTH} 字符（完整原文在原始文件里）`
  )
  return content.slice(0, KNOWLEDGE_CONTENT_MAX_LENGTH) + CONTENT_TRUNCATE_MARKER
}

/** 文件名净化：去路径分隔符 / Windows 非法字符 / 控制字符，保留中文 */
export function sanitizeFileName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file'
  if (cleaned.length <= 120) return cleaned
  const ext = extname(cleaned)
  return cleaned.slice(0, Math.max(1, 120 - ext.length)) + ext
}

function toPosixRelative(path: string): string {
  return path.split('\\').join('/')
}

function clamp(value: unknown, def: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.max(Math.floor(n), min), max)
}

/** projectId 必须真实存在——写一个不存在的 project 只会留下孤儿行 */
async function assertProjectExists(database: DatabaseClient, projectId: string): Promise<void> {
  const row = await database.request<{ id: string } | null>('projects.get', { keys: { id: projectId } })
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Project 不存在: ${projectId}`, { projectId })
  }
}
