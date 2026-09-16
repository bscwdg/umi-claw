// documentParsers.ts —— 文字层文档解析（docx / xlsx / pdf）（PLAN-2.0.md Commit 05a）
//
// 定位（§七「Commit 05 边界」）：**导入时本地确定性解析一次** → 文本进
// `knowledge_items.content`，原文件留 `data/projects/<id>/`；运行时不再解析，重导入覆盖。
//
// 为什么必须确定性抽取（§七 原文）：表格（价目表）若走模型识别可能串行/错读，
// **涉及价格的内容必须确定性抽取，不得走模型识别** —— 因此本模块只做本地解析，
// 全程不联网、不调用任何模型（多模态归 05b，且必须由用户显式触发）。
//
// 三个实测配方（依赖已由基线锁定：mammoth@1.12 / exceljs@4.4 / pdfjs-dist@3.11）：
//
//  1) docx —— `mammoth.extractRawText({ path })`
//     ⚠️ 陷阱（务必保留 test/knowledge.accept.mjs 里的 docx 断言）：仓库顶层是
//     `@xmldom/xmldom@0.9.10`（`docx` 包依赖它），而 mammoth 要 `^0.8.6`。
//     0.9 的 `parseFromString` **强制要求 mimeType**，mammoth 不传，于是抛
//     `DOMParser.parseFromString: the provided mimeType "undefined" is not valid.`
//     现状：仓库已在 `node_modules/mammoth/node_modules/@xmldom/xmldom` 放了一份 0.8.15，
//     因此现在可以跑。**这份嵌套副本是运行前提，不能被删**（验收脚本有 docx 断言守着）。
//
//  2) xlsx —— `exceljs` 按 sheet → Markdown 表。
//     取 `cell.text`（exceljs 的格式化文本）而不是 `cell.value`：`value` 可能是
//     Date / 富文本 / 公式对象 `{formula, result}`，直接 String() 会输出 `[object Object]`
//     或把日期变成时区漂移的字符串；`text` 是稳定、可读、**数字不串行**的形态。
//
//  3) pdf —— `pdfjs-dist/legacy/build/pdf.js`（v3 的 legacy CJS 构建；v4+ 是 ESM-only，
//     主进程 CJS 打包用不了）。**必须**带 cMap/standard_fonts，否则中文一个字都抽不出来：
//        pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true,
//          cMapUrl: <assets>/cmaps/, cMapPacked: true,
//          standardFontDataUrl: <assets>/standard_fonts/ })
//     实测量级：8 页中文国标 PDF → 764 个汉字（缺 cMap 时为 0）。
//     ⚠️ 装载方式（**不要改回静态 import**）：pdfjs 里有 `require("canvas")`（可选依赖，供渲染用），
//     打包器（esbuild / rollup）会在**打包期**直接报 `Could not resolve "canvas"`；而我们只要文字不要渲染。
//     因此 pdfjs 以**运行时资产**形式随包（`resources/pdfjs/build/pdf.js`），经 `createRequire`
//     按绝对路径加载 —— 打包器完全看不见它，dev 与安装包走同一份文件（见 `loadPdfjsModule`）。

import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { basename, extname, join } from 'node:path'
import { AppError, ERROR_CODES } from '../../database/errors'
import { asPdfjsDirUrl, type PdfjsAssets } from './pdfjsAssets'

/** pdfjs 模块形状（**类型**直接取官方 d.ts；运行时从资源里加载，不走打包器） */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.js')

// ── 类型与上限 ────────────────────────────────────────────────────────────────

/** 本模块能解析的文件类型（字面量与 §四 `knowledge_items.type` 枚举一致） */
export const PARSEABLE_FILE_TYPES = ['docx', 'xlsx', 'pdf'] as const
export type ParseableFileType = (typeof PARSEABLE_FILE_TYPES)[number]

/** 老版 Office 格式：v1 不支持，解析器明确拒绝并给「另存为」人话提示（§七 05a） */
export const LEGACY_OFFICE_EXTENSIONS: Record<string, string> = {
  '.doc': '.docx',
  '.xls': '.xlsx'
}

/** 声明类型 → 允许的扩展名（大小写不敏感） */
export const FILE_TYPE_EXTENSIONS: Record<ParseableFileType, string[]> = {
  docx: ['.docx'],
  xlsx: ['.xlsx'],
  pdf: ['.pdf']
}

/** 单份文档的原文体积上限（>8MB 直接拒绝：解析要整份读进内存，价格表/套系单不该这么大） */
export const MAX_PARSE_FILE_BYTES = 8 * 1024 * 1024

/** PDF 扫描件检测：抽样页数上限（均匀抽样，首尾都覆盖） */
export const PDF_SCAN_SAMPLE_PAGES = 5
/** PDF 扫描件检测：抽样页「无文字」判据（去空白后字符数 < 此值视为该页没有文字层） */
export const PDF_SCAN_MIN_CHARS_PER_PAGE = 5
/** PDF 扫描件检测：整篇可用文本下限（低于此值同样判为扫描件/无文字层，不静默存空） */
export const PDF_MIN_USEFUL_CHARS = 20

export interface ParsedDocument {
  /** 抽取出的纯文本（已是 Markdown-ish 的可读形态：xlsx 为 Markdown 表） */
  content: string
  /** 解析元信息（进日志/details，不进库；用于排障与验收断言） */
  meta: {
    /** 解析器标识 */
    parser: ParseableFileType
    /** 原始文件字节数 */
    bytes: number
    /** 文本字符数（trim 后） */
    textLength: number
    /** docx: 段落数近似（换行块数）；xlsx: 工作表数；pdf: 页数 */
    units?: number
    /** pdf: 抽样页数 */
    sampledPages?: number
    /** pdf: 抽样页里有文字层的页数 */
    sampledPagesWithText?: number
    /** xlsx: 工作表名列表 */
    sheets?: string[]
  }
}

// ── 扩展名 / 类型判定 ─────────────────────────────────────────────────────────

export function extensionOf(filePath: string): string {
  return extname(filePath || '').toLowerCase()
}

/**
 * 校验「声明类型」与「文件扩展名」一致，并把老格式/未知扩展名翻译成人话。
 *
 * 这里**不查文件是否存在**（那是 FILE_NOT_FOUND 的活）：纯字符串判定，便于静态测试。
 */
export function assertFileTypeMatchesPath(declaredType: string, filePath: string): ParseableFileType {
  const ext = extensionOf(filePath)
  if (!ext) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `文件没有扩展名，无法判断格式: ${basename(filePath)}`, {
      field: 'filePath',
      declaredType,
      extension: ext
    })
  }
  if (LEGACY_OFFICE_EXTENSIONS[ext]) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `暂不支持老版 Office 格式（${ext}）：请先用 Office/WPS 打开并「另存为」${LEGACY_OFFICE_EXTENSIONS[ext]}，再重新导入`,
      { field: 'filePath', extension: ext, saveAs: LEGACY_OFFICE_EXTENSIONS[ext] }
    )
  }
  const key = declaredType as ParseableFileType
  const allowed = FILE_TYPE_EXTENSIONS[key]
  if (!allowed) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的文件类型: ${declaredType}`, {
      field: 'type',
      declaredType,
      allowed: [...PARSEABLE_FILE_TYPES]
    })
  }
  if (!allowed.includes(ext)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `文件格式与所选类型不符：类型 ${declaredType} 应为 ${allowed.join('/')}，实际 ${ext}`,
      { field: 'filePath', declaredType, extension: ext, allowed }
    )
  }
  return key
}

/** 文件存在性 + 体积检查（不存在 → FILE_NOT_FOUND；过大 → VALIDATION_ERROR） */
function assertReadableFile(filePath: string): number {
  let size = 0
  try {
    const st = statSync(filePath)
    if (!st.isFile()) {
      throw new AppError(ERROR_CODES.FILE_NOT_FOUND, `不是文件: ${filePath}`, { path: filePath })
    }
    size = st.size
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError(ERROR_CODES.FILE_NOT_FOUND, `原始文件不存在或不可读: ${filePath}`, {
      path: filePath,
      cause: e instanceof Error ? e.message : String(e)
    })
  }
  if (size > MAX_PARSE_FILE_BYTES) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `文件过大（${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_PARSE_FILE_BYTES / 1024 / 1024}MB），请拆分后再导入`,
      { path: filePath, bytes: size, max: MAX_PARSE_FILE_BYTES }
    )
  }
  return size
}

/** 统一的解析失败包装：原始错误信息保留在 details（排障用），对外只有 FILE_PARSE_ERROR */
export function parseErrorOf(kind: string, filePath: string, e: unknown, extra?: Record<string, unknown>): AppError {
  return new AppError(
    ERROR_CODES.FILE_PARSE_ERROR,
    `文件解析失败（${kind}）: ${basename(filePath)} — ${e instanceof Error ? e.message : String(e)}`,
    { path: filePath, kind, cause: e instanceof Error ? e.message : String(e), ...(extra ?? {}) }
  )
}

// ── docx ─────────────────────────────────────────────────────────────────────

export async function parseDocxFile(filePath: string): Promise<ParsedDocument> {
  const bytes = assertReadableFile(filePath)
  let raw = ''
  try {
    const result = await mammoth.extractRawText({ path: filePath })
    raw = String(result?.value ?? '')
  } catch (e) {
    throw parseErrorOf('docx', filePath, e)
  }
  const content = normalizeBlankLines(raw)
  if (!content) {
    // 空 docx 与「扫描件」同性质：不能静默入库（§七 05a）
    throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `docx 没有抽取到任何文字: ${basename(filePath)}`, {
      path: filePath,
      kind: 'docx',
      reason: 'empty-text'
    })
  }
  return {
    content,
    meta: {
      parser: 'docx',
      bytes,
      textLength: content.length,
      units: content.split(/\n\s*\n/).length
    }
  }
}

// ── xlsx ─────────────────────────────────────────────────────────────────────

/** 单元格 → 文本（`cell.text` 是 exceljs 的格式化文本：数字/日期都不串行） */
function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return ''
  const text = (cell as { text?: unknown }).text
  if (typeof text === 'string') return text.replace(/\s+/g, ' ').trim()
  const value = (cell as { value?: unknown }).value
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 工作表 → Markdown 表（首行当表头；空表给一行说明，避免「解析成功但内容为空」） */
export function sheetToMarkdown(sheet: ExcelJS.Worksheet): string {
  const rows: string[][] = []
  const columnCount = Math.max(1, Number(sheet.columnCount) || 1)
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    for (let c = 1; c <= columnCount; c++) {
      cells.push(escapeMarkdownCell(cellText(row.getCell(c))))
    }
    // 整行空白（只有格式没有内容）不算数据行
    if (cells.some((t) => t !== '')) rows.push(cells)
  })

  const head = `# 工作表：${sheet.name}`
  if (!rows.length) return `${head}\n\n（空工作表）`

  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const [header, ...body] = rows
  const lines = [
    head,
    '',
    '| ' + pad(header).join(' | ') + ' |',
    '| ' + Array(width).fill('---').join(' | ') + ' |',
    ...body.map((r) => '| ' + pad(r).join(' | ') + ' |')
  ]
  return lines.join('\n')
}

export async function parseXlsxFile(filePath: string): Promise<ParsedDocument> {
  const bytes = assertReadableFile(filePath)
  let content = ''
  let sheets: string[] = []
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const list = workbook.worksheets ?? []
    sheets = list.map((ws) => ws.name)
    content = list.map((ws) => sheetToMarkdown(ws)).join('\n\n')
  } catch (e) {
    throw parseErrorOf('xlsx', filePath, e)
  }
  content = normalizeBlankLines(content)
  if (!content) {
    throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `xlsx 没有抽取到任何内容: ${basename(filePath)}`, {
      path: filePath,
      kind: 'xlsx',
      reason: 'empty-text'
    })
  }
  return {
    content,
    meta: { parser: 'xlsx', bytes, textLength: content.length, units: sheets.length, sheets }
  }
}

// ── pdf ──────────────────────────────────────────────────────────────────────

/** 抽样页页码（1 基）：≤5 页全取；更多则首尾 + 均分取 5 页（确定性，便于断言与排障） */
export function samplePageNumbers(numPages: number, maxSamples = PDF_SCAN_SAMPLE_PAGES): number[] {
  const total = Math.max(0, Math.floor(numPages) || 0)
  if (total <= maxSamples) return Array.from({ length: total }, (_, i) => i + 1)
  const picks = new Set<number>()
  for (let i = 0; i < maxSamples; i++) {
    picks.add(Math.round((i * (total - 1)) / (maxSamples - 1)) + 1)
  }
  return [...picks].sort((a, b) => a - b)
}

export interface PdfParseOptions {
  /** pdfjs 运行时资产（cmaps / standard_fonts / worker / pdf.js 本体），缺 cMap 时中文会全丢 */
  assets?: PdfjsAssets | null
  /** 装载 pdfjs 模块（默认从资源里按绝对路径 `createRequire` 加载） */
  loadPdfjs?: (assets: PdfjsAssets) => PdfjsModule
}

/**
 * 运行时加载 pdfjs 模块（**故意绕开打包器**）。
 *
 * - pdfjs 里 `require("canvas")` 是可选依赖，打包器会在打包期解析失败（我们也不需要它：只抽文字不渲染）；
 * - 按绝对路径加载 `resources/pdfjs/build/pdf.js`（随包资产），dev 与安装包同一份文件，
 *   不存在「dev 能跑、打包后模块找不到」的错位；
 * - pdfjs 自己的 `eval("require")(workerSrc)` 走 fake worker（Node 下没有 DOM worker），
 *   因此 workerSrc 也要指到随包的 `pdf.worker.js`。
 */
export function loadPdfjsModule(assets: PdfjsAssets): PdfjsModule {
  const modulePath = assets.modulePath || join(assets.root, 'build', 'pdf.js')
  try {
    // createRequire 的 base 只用于解析相对路径；这里给的是绝对路径，base 取任意绝对文件即可
    const requireFrom = createRequire(join(assets.root, 'noop.cjs'))
    return requireFrom(modulePath) as PdfjsModule
  } catch (e) {
    throw new AppError(
      ERROR_CODES.FILE_PARSE_ERROR,
      `pdfjs 运行时模块加载失败（应位于 ${modulePath}，请确认 resources/pdfjs 已随包）: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { path: modulePath, reason: 'pdfjs-module-missing' }
    )
  }
}

/**
 * 抽取 PDF 文字层。
 *
 * **扫描件检测（§七 05a 硬要求）**：抽样页面文字量 ≈0 → `FILE_PARSE_ERROR`，
 * 条目标红待 05b 的 AI 识别，**绝不静默存入空内容**。
 * 两个判据（任一成立即判为无文字层）：
 *   a) 抽样页**全部**没有文字（每页去空白后 < PDF_SCAN_MIN_CHARS_PER_PAGE）
 *   b) 整篇可用文本 < PDF_MIN_USEFUL_CHARS
 */
export async function parsePdfFile(filePath: string, options: PdfParseOptions = {}): Promise<ParsedDocument> {
  const bytes = assertReadableFile(filePath)
  const assets = options.assets
  if (!assets) {
    // 没有随包资产就无法保证中文抽取（缺 cMap 时中文全丢），宁可明确报错也不静默存残缺内容
    throw new AppError(
      ERROR_CODES.FILE_PARSE_ERROR,
      `PDF 解析缺少 pdfjs 运行时资产（resources/pdfjs）: ${basename(filePath)}`,
      { path: filePath, kind: 'pdf', reason: 'pdfjs-assets-missing' }
    )
  }
  const pdfjs = (options.loadPdfjs ?? loadPdfjsModule)(assets)

  const { readFileSync, existsSync } = await import('node:fs')
  const data = new Uint8Array(readFileSync(filePath))
  const init: Record<string, unknown> = {
    data,
    // Node/主进程：字体走系统度量、不做 canvas 渲染（我们只要文字，不要排版）
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    cMapUrl: asPdfjsDirUrl(assets.cmapsDir),
    cMapPacked: true,
    standardFontDataUrl: asPdfjsDirUrl(assets.standardFontsDir)
  }
  // Node 下 pdfjs 走 fake worker（`eval("require")(workerSrc)`）；只有文件真存在才指过去，
  // 否则保留 pdfjs 自带的 fallbackWorkerSrc，避免 require 抛错把整个解析带崩。
  if (existsSync(assets.workerPath)) {
    pdfjs.GlobalWorkerOptions.workerSrc = assets.workerPath
  }

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
  const pages: string[] = []
  let numPages = 0
  try {
    doc = await pdfjs.getDocument(init as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise
    numPages = doc.numPages
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i)
      const textContent = await page.getTextContent()
      // 按 item 拼行：`hasEOL` 是 pdfjs 给出的换行信号，丢掉它整页会挤成一行
      let line = ''
      const lines: string[] = []
      for (const item of textContent.items as Array<{ str?: string; hasEOL?: boolean }>) {
        line += typeof item.str === 'string' ? item.str : ''
        if (item.hasEOL) {
          lines.push(line)
          line = ''
        }
      }
      if (line) lines.push(line)
      pages.push(lines.join('\n').trim())
      page.cleanup()
    }
  } catch (e) {
    throw parseErrorOf('pdf', filePath, e, { pages: numPages })
  } finally {
    try {
      await doc?.destroy()
    } catch {
      /* 关闭失败不影响解析结果 */
    }
  }

  const sampled = samplePageNumbers(numPages)
  const counts = sampled.map((p) => (pages[p - 1] ?? '').replace(/\s+/g, '').length)
  const withText = counts.filter((n) => n >= PDF_SCAN_MIN_CHARS_PER_PAGE).length
  const totalChars = pages.join('').replace(/\s+/g, '').length

  if (!sampled.length || withText === 0 || totalChars < PDF_MIN_USEFUL_CHARS) {
    throw new AppError(
      ERROR_CODES.FILE_PARSE_ERROR,
      `PDF 未检测到文字层（扫描件/图片型 PDF）: ${basename(filePath)}；` +
        `文字层识别（AI 兜底）属 05b，本期请另存为文字版或先转成 docx/xlsx 再导入`,
      {
        path: filePath,
        kind: 'pdf',
        reason: 'scanned-pdf',
        pages: numPages,
        sampledPages: sampled,
        sampledPagesWithText: withText,
        textLength: totalChars
      }
    )
  }

  const content = normalizeBlankLines(
    pages
      .map((text, i) => (numPages > 1 ? `【第 ${i + 1} 页】\n${text}` : text))
      .filter((t) => t.replace(/【第 \d+ 页】/, '').trim())
      .join('\n\n')
  )
  if (!content) {
    throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `PDF 没有抽取到任何文字: ${basename(filePath)}`, {
      path: filePath,
      kind: 'pdf',
      reason: 'empty-text'
    })
  }
  return {
    content,
    meta: {
      parser: 'pdf',
      bytes,
      textLength: content.length,
      units: numPages,
      sampledPages: sampled.length,
      sampledPagesWithText: withText
    }
  }
}

// ── 通用 ─────────────────────────────────────────────────────────────────────

/** 多余空行压成单空行 + 首尾 trim（docx/xlsx/pdf 三条链路统一，避免内容形态各异） */
export function normalizeBlankLines(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按类型分发（调用方已用 assertFileTypeMatchesPath 校验过类型/扩展名） */
export async function parseDocumentFile(
  type: ParseableFileType,
  filePath: string,
  options: PdfParseOptions = {}
): Promise<ParsedDocument> {
  if (type === 'docx') return parseDocxFile(filePath)
  if (type === 'xlsx') return parseXlsxFile(filePath)
  if (type === 'pdf') return parsePdfFile(filePath, options)
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的文件类型: ${type}`, {
    field: 'type',
    allowed: [...PARSEABLE_FILE_TYPES]
  })
}
