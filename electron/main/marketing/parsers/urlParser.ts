// urlParser.ts —— url 类知识条目的「正文抽取」与「URL 抓取」（PLAN-2.0.md Commit 05a）
//
// §七 05a 原文：「url 类只做正文/HTML 到文本的轻量抽取」。
// 本模块只做两件事，**不做任何别的事**：
//   1) `extractTextFromHtml()`：纯字符串 → 纯文本（去 script/style/注释、块级标签转换行、
//      实体解码、空白归一）。零依赖、无 IO、可离线单测。
//   2) `fetchHtmlPage()`：按用户显式给出的 URL 做**一次** GET（跟随 http(s) 重定向）。
//
// 边界（硬规则 11 / 12，务必守住）：
//   - ❌ 不调用任何第三方正文抽取/转写 API（没有 readability 服务、没有 r.jina.ai 之类）；
//   - ❌ 不做爬虫：不抓站内链接、不遍历站点、不做队列重试；一个 URL 只取一次；
//   - ❌ 不携带 Cookie、不登录、不带任何凭据；不伪装 Referer；
//   - ✅ 只接受 http/https 绝对地址；限制体积（5MB）与时长（15s）；重定向仅 http(s) 且 ≤5 跳；
//   - ✅ 只有用户**显式**粘贴 URL 并点「导入」时才会走到这里（人工触发，不是后台采集）。
// 采集（热点雷达）是 Commit 11 的 collector adapter，与本模块无关。

import { AppError, ERROR_CODES } from '../../database/errors'

/** 单页体积上限（超出即断流，避免把整个视频站首页拖进内存） */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024
/** 抓取超时 */
export const FETCH_TIMEOUT_MS = 15_000
/** 重定向跳数上限 */
export const MAX_REDIRECTS = 5

/** 总时长上限：`req.setTimeout` 只盖住「socket 空闲」，慢滴站能一直拖着不老触发 → 再加一道总闸 */
export const FETCH_TOTAL_TIMEOUT_MS = 30_000

/**
 * 允许当正文导入的 Content-Type（2026-09-16 补强）。
 * 明确声明为非文本类型的（application/pdf、image/*、application/octet-stream…）直接拒，
 * 否则会把二进制当正文存进知识库（乱码且无法检索）。
 */
export const ACCEPTED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/xml',
  'application/xml'
] as const
/** 请求 UA（诚实标识自己，不做浏览器伪装） */
export const FETCH_USER_AGENT = 'UmiClaw/2.0 (knowledge-import; +local)'

export interface FetchedHtml {
  html: string
  /** 重定向后的最终地址（存进 source_path 用原始地址，最终地址只作元信息） */
  finalUrl: string
  status: number
  contentType: string
}

/** 校验 URL：必须是 http/https 绝对地址（`javascript:` / `file:` / `data:` 一律拒绝） */
export function assertImportableUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'url 类条目需要 url', { field: 'url' })
  }
  const raw = url.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不是合法的 URL: ${raw}`, { field: 'url', value: raw })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `只支持 http/https 链接，收到 ${parsed.protocol}`, {
      field: 'url',
      value: raw
    })
  }
  return raw
}

// ── HTML → 纯文本（零依赖） ───────────────────────────────────────────────────

/** 只解码常见的命名实体 + 数字实体（够用且确定；不引第三方实体表） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  deg: '°',
  yen: '¥',
  euro: '€',
  pound: '£',
  sect: '§',
  para: '¶'
}

export function decodeEntities(text: string): string {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

/** `<title>` 文本（作为 url 条目的默认标题） */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  if (!m) return null
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return title || null
}

/**
 * HTML → 纯文本。
 * - 先整块丢掉 `script`/`style`/`noscript`/`svg`/`template`/注释（否则 JS 会混进正文）
 * - 块级标签（p/div/li/tr/h1-6/br…）→ 换行；`li` 带 `- ` 前缀
 * - 再剥剩余标签、解码实体、按行 trim、压掉连续空行
 */
export function extractTextFromHtml(html: string): { title: string | null; text: string } {
  const source = String(html ?? '')
  const title = extractHtmlTitle(source)
  let work = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[^>]*\/?>/gi, ' ')

  work = work
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6]|p|div|section|article|header|footer|tr|table|ul|ol|blockquote|pre|figure|main|aside|nav|dd|dt|form|fieldset|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(h[1-6]|p|div|section|article|header|footer|tr|table|ul|ol|blockquote|pre|figure|main|aside|nav|dd|dt|form|fieldset)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/?(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')

  const text = decodeEntities(work)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
  return { title, text }
}

// ── 抓取（一次 GET，无 Cookie 无伪装） ────────────────────────────────────────

/** 按 content-type charset 解码（GBK 等中文站点很常见；Node 24 自带 full-icu 可解） */
export function decodeHtmlBuffer(buffer: Buffer, contentType: string): string {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')
  const charset = (m?.[1] || 'utf-8').toLowerCase()
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

export type HtmlFetcher = (url: string) => Promise<FetchedHtml>

/**
 * Content-Type 守卫：
 * - 缺失 Content-Type → 放行（部分老站不返回；正文抽取的「空正文」兜底会拦住真的空页）
 * - 明确声明为非文本类型 → `FILE_PARSE_ERROR` + `reason=unsupported-content-type`
 */
export function assertSupportedContentType(contentType: string, url: string): void {
  const mime = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!mime) return
  if ((ACCEPTED_CONTENT_TYPES as readonly string[]).includes(mime)) return
  throw new AppError(
    ERROR_CODES.FILE_PARSE_ERROR,
    `这个链接返回的是 ${mime}，不是网页正文，暂不支持导入: ${url}`,
    { url, contentType: mime, reason: 'unsupported-content-type', accepted: [...ACCEPTED_CONTENT_TYPES] }
  )
}

/**
 * 默认抓取器：`node:http` / `node:https`（**故意不引第三方 HTTP 库**）。
 *
 * 换取的是「用户粘了自家官网/公众号文章链接就能进知识库」这一点可用性；
 * 代价是主进程会发出一次出站请求（已在文件头写明边界）。
 * 需要离线/可测时由调用方注入 `htmlFetcher`（验收脚本就是这么做的）。
 */
export const fetchHtmlPage: HtmlFetcher = async (rawUrl: string) => {
  const { request } = await import('node:https')
  const http = await import('node:http')

  const url = assertImportableUrl(rawUrl)

  const once = (target: string, redirectsLeft: number): Promise<FetchedHtml> =>
    new Promise<FetchedHtml>((resolve, reject) => {
      const client = target.startsWith('https:') ? request : http.request
      const req = client(
        target,
        {
          method: 'GET',
          headers: {
            'User-Agent': FETCH_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5'
          }
        },
        (res) => {
          const status = Number(res.statusCode || 0)
          const location = res.headers.location
          if (status >= 300 && status < 400 && location) {
            res.resume()
            if (redirectsLeft <= 0) {
              reject(
                new AppError(ERROR_CODES.FILE_PARSE_ERROR, `URL 重定向次数超过 ${MAX_REDIRECTS}: ${rawUrl}`, {
                  url: rawUrl
                })
              )
              return
            }
            let next: string
            try {
              next = new URL(location, target).toString()
            } catch {
              reject(new AppError(ERROR_CODES.FILE_PARSE_ERROR, `重定向地址非法: ${location}`, { url: rawUrl }))
              return
            }
            if (!/^https?:/i.test(next)) {
              reject(
                new AppError(ERROR_CODES.FILE_PARSE_ERROR, `重定向到非 http(s) 地址，已拒绝: ${next}`, {
                  url: rawUrl,
                  location: next
                })
              )
              return
            }
            once(next, redirectsLeft - 1).then(resolve, reject)
            return
          }
          if (status < 200 || status >= 300) {
            res.resume()
            reject(
              new AppError(ERROR_CODES.FILE_PARSE_ERROR, `抓取失败：HTTP ${status} ${target}`, {
                url: target,
                status
              })
            )
            return
          }
          const contentType = String(res.headers['content-type'] || '')
          try {
            assertSupportedContentType(contentType, target)
          } catch (e) {
            res.destroy()
            reject(e)
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          res.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > MAX_FETCH_BYTES) {
              res.destroy()
              reject(
                new AppError(
                  ERROR_CODES.FILE_PARSE_ERROR,
                  `页面过大（>${MAX_FETCH_BYTES / 1024 / 1024}MB），已中止: ${target}`,
                  { url: target, bytes: total, max: MAX_FETCH_BYTES }
                )
              )
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            resolve({
              html: decodeHtmlBuffer(Buffer.concat(chunks), contentType),
              finalUrl: target,
              status,
              contentType
            })
          })
          res.on('error', (e) => reject(parseFetchError(target, e)))
        }
      )
      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy(new Error(`抓取超时（${FETCH_TIMEOUT_MS}ms）`))
      })
      // 总时长总闸：慢滴站（每次都有数据、但永远传不完）也会被切断
      const totalTimer = setTimeout(() => {
        try {
          req.destroy(new Error(`抓取总时长超限（${FETCH_TOTAL_TIMEOUT_MS}ms）`))
        } catch {
          /* 已结束 */
        }
      }, FETCH_TOTAL_TIMEOUT_MS)
      req.on('close', () => clearTimeout(totalTimer))
      req.on('error', (e) => reject(parseFetchError(target, e)))
      req.end()
    })

  return once(url, MAX_REDIRECTS)
}

function parseFetchError(url: string, e: unknown): AppError {
  if (e instanceof AppError) return e
  return new AppError(
    ERROR_CODES.FILE_PARSE_ERROR,
    `抓取失败: ${url} — ${e instanceof Error ? e.message : String(e)}`,
    { url, cause: e instanceof Error ? e.message : String(e) }
  )
}
