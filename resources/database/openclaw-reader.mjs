// openclaw-reader.mjs —— 一次性只读查询 OpenClaw 会话记录（零依赖，仅 node:sqlite）
//
// 由 openclawImportManager 用便携 Node 拉起（Electron 30 自带 Node 20 无 node:sqlite）。
// 只读打开 agent 库，按行 created_at 增量取新增的 user/assistant 文本消息。
//
// 时钟口径（与 importManager 的水位线同一域，绝不混用）：
//   - 增量与水位线一律用行 created_at（OpenClaw 写库时间，基本单调）；
//     内嵌 message.timestamp 只作「重启重写守卫」，绝不参与增量过滤
//   - OpenClaw 重启会把历史 transcript 的 created_at 重写为当前时间，但内嵌
//     时间不变——内嵌时间早于窗口起点的行是旧对话，直接丢弃；
//     无内嵌时间戳的行无法判定，按新消息保留（宁可小概率重复提炼、由用户
//     确认环节兜底，不可因兜底误判让某个渠道的内容静默丢失）
//   - 不引入 SKEW 重叠窗口：重叠重读会把已提炼内容反复送进模型，而
//     recordManager 的 30 分钟去重窗口兜不住模型措辞差异；created_at 单调
//     + keyset 全序化下，严格增量（> 水位）不会漏行
//
// 三层安全预算（异常刷量时一律降级，不会卡死或撑爆主进程）：
//   - MAX_TOTAL_ROWS：单轮最多读 20000 行；页边界停止，未读行下轮继续
//   - OUTPUT_TEXT_LIMIT：输出文本累计上限；按页粒度判定，超限在页尾停止翻页。
//     页内所有行都已决定（收录或有意丢弃）并计入水位——绝不在行中途截断，
//     否则截断点与水位之间的内容会永久丢失
//   - 行级上限：assistant 1500 / user 8000 字
//
// 跨午夜：水位停在昨天（上轮失败未推进）时窗口从昨天水位起补扫（最早昨天 0 点）。
// 水位收敛：maxCreatedAt 覆盖「所有已读行」的 created_at（含被过滤/丢弃的行）——
// 已读行都已决定，越过它们不会丢任何内容，也不会被弃行卡住水位空转。
//
// SQL：message / work 自会话 / cron 确定性下推 WHERE；created_at 下界 =
// 当天增量直接用水位（不做 0 点起的全天重读）。keyset 分页 ASC 读完整个窗口。
//
// 用法：node openclaw-reader.mjs <dbPath> <sinceMs> <dayStartMs>
// stdout：{ messages:[{ts,role,text,sessionKey,channel}], maxCreatedAt, truncated?, unavailable?, reason? }

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const [dbPath, sinceRaw, dayStartRaw] = process.argv.slice(2)
const sinceMs = Number(sinceRaw)
const dayStartMs = Number(dayStartRaw)

if (!dbPath || !Number.isFinite(sinceMs) || !Number.isFinite(dayStartMs)) {
  process.stderr.write('[openclaw-reader] 需要参数：<dbPath> <sinceMs> <dayStartMs>\n')
  process.exit(1)
}

// 库从未产生（OpenClaw 未启动）不是错误：没有可提取的东西。
// 输出后等 flush 完成再退出——大 JSON 写管道是异步的，process.exit 会丢缓冲
if (!existsSync(dbPath)) {
  process.stdout.write(JSON.stringify({ messages: [], maxCreatedAt: sinceMs, unavailable: true }), () => process.exit(0))
}

/** 单页行数（keyset 分页，仅控制单次查询） */
const PAGE_SIZE = 1000
/** 单轮行数上限：异常刷量降级，页边界停止，未读部分下轮继续 */
const MAX_TOTAL_ROWS = 20000
/**
 * 输出文本累计字符上限（页粒度判定）：保证 stdout 远低于主进程 64MB 限额。
 * 最坏情况 = 上限 + 一整页（1000 行 × 8000 字 = 8M 字符）；
 * 6M + 8M = 14M 字符，中文 UTF-8 最坏 ×3 ≈ 42MB < 64MB
 */
const OUTPUT_TEXT_LIMIT = 6 * 1024 * 1024
/** 跨午夜补扫最早回到昨天 0 点（再旧的失败不无限回溯） */
const PREV_DAY_MS = 24 * 3600 * 1000

/** assistant 单条文本上限（控制提炼 prompt 体积） */
const ASSISTANT_TEXT_LIMIT = 1500
/** user 单条文本上限：防止超大粘贴经 stdout 撑爆主进程内存 */
const USER_TEXT_LIMIT = 8000

// 窗口下界：水位停在昨天 → 从昨天水位（最早昨天 0 点）起；否则今天 0 点
const windowStartMs =
  sinceMs > 0 && sinceMs < dayStartMs
    ? Math.max(sinceMs, dayStartMs - PREV_DAY_MS)
    : dayStartMs
// SQL 下界：当天增量直接用水位（== 水位的行上一轮已决定，由 JS 过滤防边界重提）
const sqlFloorMs = sinceMs >= dayStartMs && sinceMs > 0 ? sinceMs : windowStartMs

/** 取消息纯文本：user 多为字符串；assistant 为 parts 数组，只留 text */
function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

/**
 * epoch 数值归一化为毫秒：
 * 数量级 < 1e11（毫秒值约公元 5138 年以前）视为秒级时间戳 ×1000。
 * 否则秒级时间戳算出 1970 年，守卫会把所有消息误当旧内容丢弃。
 */
function normalizeEpoch(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e11 ? n * 1000 : n
}

/**
 * 事件内嵌时间（ms，兼容秒级）：message.timestamp 或 event.timestamp（ISO）。
 * 只用于「重启重写守卫」，绝不作为增量时钟；两者都缺失返回 null（按新消息保留）。
 */
function embeddedTs(event, message) {
  const raw = normalizeEpoch(message?.timestamp)
  if (raw !== null) return raw
  const iso = Date.parse(event?.timestamp ?? '')
  return Number.isFinite(iso) ? iso : null
}

let paged
try {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  // 过滤下推 SQL：只留 message 事件，并排除 work 自会话 / cron 会话——
  // 确定性排除行不进结果，既不挤占行预算，也不会每轮被重复捞出。
  paged = db.prepare(
    `SELECT t.created_at  AS ts,
            t.session_id  AS sid,
            t.seq         AS seq,
            t.event_json  AS json,
            w.session_key AS session_key,
            w.channel     AS channel
       FROM transcript_events t
       JOIN session_windows  w ON w.session_id = t.session_id
      WHERE t.created_at >= ?
        AND (t.created_at > ?
              OR (t.created_at = ? AND (t.session_id > ?
                  OR (t.session_id = ? AND t.seq > ?))))
        AND t.event_json LIKE '%"type":"message"%'
        AND w.session_key NOT LIKE '%:conv:work:%'
        AND w.session_key NOT LIKE '%:cron:%'
      ORDER  BY t.created_at ASC, t.session_id ASC, t.seq ASC
      LIMIT ?`
  )
} catch (e) {
  // 库被独占 / 损坏 / 缺表：unavailable，本轮跳过、水位不动，下轮自动重试
  const reason = `无法读取 agent 库: ${(e && e.message) || e}`
  process.stderr.write(`[openclaw-reader] ${reason}\n`)
  process.stdout.write(JSON.stringify({ messages: [], maxCreatedAt: sinceMs, unavailable: true, reason }), () => process.exit(0))
}

const messages = []
/** 已读行（全部已决定）的最大 created_at：即本轮的水位候选 */
let maxCreatedAt = sinceMs
let totalRows = 0
let outputChars = 0
let truncated = false

function processPage(page) {
  for (const row of page) {
    // 增量过滤（与 SQL 同域 created_at）：== 水位的行上一轮已决定，防边界重提
    if (row.ts <= sinceMs) continue
    if (row.ts > maxCreatedAt) maxCreatedAt = row.ts

    let event
    try {
      event = JSON.parse(row.json)
    } catch {
      continue
    }
    if (event.type !== 'message') continue
    const message = event.message
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue

    // 重启重写守卫：内嵌时间早于窗口起点的行是历史对话被重写进今天，丢弃
    const embedded = embeddedTs(event, message)
    if (embedded !== null && embedded < windowStartMs) continue

    const sessionKey = String(row.session_key ?? '')
    // 排除本应用 work 域自己的对话（提取会自我循环）
    if (sessionKey.includes(':conv:work:')) continue
    // 排除 cron 定时任务（新闻推送等不是用户的主动工作）
    if (/^agent:[^:]+:cron:/.test(sessionKey)) continue

    let text = extractText(message.content).trim()
    if (!text) continue
    const textLimit = message.role === 'assistant' ? ASSISTANT_TEXT_LIMIT : USER_TEXT_LIMIT
    if (text.length > textLimit) text = text.slice(0, textLimit)

    outputChars += text.length
    messages.push({
      ts: row.ts,
      role: message.role,
      text,
      sessionKey,
      channel: row.channel ?? null
    })
  }
}

// keyset 分页；预算超限在页边界截断——页内所有行都已决定并计入水位
let cursor = { ts: 0, sid: '', seq: 0 }
for (;;) {
  let page
  try {
    page = paged.all(
      sqlFloorMs,
      cursor.ts, cursor.ts, cursor.sid, cursor.sid, cursor.seq,
      PAGE_SIZE
    )
  } catch (e) {
    const reason = `无法读取 agent 库: ${(e && e.message) || e}`
    process.stderr.write(`[openclaw-reader] ${reason}\n`)
    process.stdout.write(JSON.stringify({ messages: [], maxCreatedAt: sinceMs, unavailable: true, reason }), () => process.exit(0))
  }
  processPage(page)
  totalRows += page.length
  if (page.length < PAGE_SIZE || totalRows >= MAX_TOTAL_ROWS) break
  if (outputChars > OUTPUT_TEXT_LIMIT) {
    truncated = true
    break
  }
  const last = page[page.length - 1]
  cursor = { ts: last.ts, sid: last.sid, seq: last.seq }
}

const result = { messages, maxCreatedAt }
if (truncated) result.truncated = true
// 大输出写管道是异步的：等 flush 完成再退出，否则 process.exit 丢缓冲，
// 父进程拿到截断 JSON 会误报「输出损坏」（越是大批量日越容易踩中）
process.stdout.write(JSON.stringify(result), () => process.exit(0))
