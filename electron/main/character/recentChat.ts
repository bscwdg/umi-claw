// electron/main/character/recentChat.ts —— 读取最近真实聊天（只读 OpenClaw agent 库）
//
// 主动消息不能凭空换话题：先看用户最近说了什么，再做话题匹配/敏感话题触发。
// 只读 transcript_events 的 user/assistant 文本，不读工具参数、不读 thinking。

import { execFile } from 'node:child_process'

export interface RecentChatMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface ReadRecentChatOptions {
  nodePath: string
  dbPath: string
  limit?: number
  timeoutMs?: number
}

const DEFAULT_LIMIT = 8

function parseContent(content: unknown): string {
  if (typeof content === 'string') return content.trim().slice(0, 500)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const src = item as Record<string, unknown>
    if (src.type !== 'text' || typeof src.text !== 'string') continue
    const text = src.text.trim()
    if (text) parts.push(text)
  }
  return parts.join('\n').trim().slice(0, 500)
}

export function parseRecentChatRows(rows: unknown): RecentChatMessage[] {
  if (!Array.isArray(rows)) return []
  const out: RecentChatMessage[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const src = row as Record<string, unknown>
    const raw = typeof src.event_json === 'string' ? src.event_json : ''
    const at = typeof src.created_at === 'number' ? src.created_at : 0
    if (!raw) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type !== 'message' || !event.message || typeof event.message !== 'object') continue
    const message = event.message as Record<string, unknown>
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = parseContent(message.content)
    if (!text) continue
    out.push({ role, text, at })
  }
  // DB 按 seq 倒序取，输出按时间正序，最后几条才是最近
  return out.reverse()
}

/**
 * 读最近 N 条真实聊天；失败返回空数组（主动消息降级为纯话题池，不阻断发送）。
 */
export function readRecentChat(options: ReadRecentChatOptions): Promise<RecentChatMessage[]> {
  const limit = Math.max(1, Math.min(20, options.limit ?? DEFAULT_LIMIT))
  const script = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1], { readOnly: true })
const session = db.prepare(
  "SELECT sc.session_id FROM session_conversations sc JOIN conversations c ON c.conversation_id = sc.conversation_id WHERE c.channel = 'qqbot' AND c.kind = 'direct' ORDER BY sc.last_seen_at DESC LIMIT 1"
).get() || db.prepare(
  "SELECT session_id FROM transcript_events WHERE event_json IS NOT NULL AND message_role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1"
).get()
if (!session) { console.log('[]'); process.exit(0) }
const rows = db.prepare(
  "SELECT event_json, created_at FROM transcript_events WHERE session_id = ? AND event_json IS NOT NULL AND message_role IN ('user','assistant') ORDER BY seq DESC LIMIT 1000"
).all(session.session_id)
console.log(JSON.stringify(rows))
`
  return new Promise((resolve) => {
    execFile(
      options.nodePath,
      ['-e', script, options.dbPath],
      { timeout: options.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        try {
          const parsed = parseRecentChatRows(JSON.parse(String(stdout || '[]')))
          resolve(parsed.slice(-limit))
        } catch {
          resolve([])
        }
      }
    )
  })
}
