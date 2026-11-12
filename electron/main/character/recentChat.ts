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

export interface RecentChatSnapshot {
  messages: RecentChatMessage[]
  /** 该会话最后一条用户消息时间（不受 messages 截取条数影响） */
  lastUserMessageAt: number
  /** 产生最后一条用户消息的 direct conversation；发送器用它锁同一会话 */
  conversationId: string
}

export interface ReadRecentChatOptions {
  nodePath: string
  dbPath: string
  limit?: number
  timeoutMs?: number
  /** 只接受不晚于该时间的用户消息（默认 Date.now），时钟异常时不误判成“刚回复” */
  now?: number
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

function latestUserAt(messages: RecentChatMessage[]): number {
  return messages.reduce((latest, message) => {
    if (message.role !== 'user' || !Number.isFinite(message.at) || message.at <= 0) return latest
    return Math.max(latest, message.at)
  }, 0)
}

/**
 * 读最近 N 条真实聊天 + 最后一条用户消息时间；失败返回空快照（主动消息降级为纯话题池，不阻断发送）。
 * lastUserMessageAt 单独查询，避免一条用户消息后跟很多工具/助手事件时被 messages 窗口截掉。
 */
export function readRecentChat(options: ReadRecentChatOptions): Promise<RecentChatSnapshot> {
  const limit = Math.max(1, Math.min(20, options.limit ?? DEFAULT_LIMIT))
  const cutoff =
    typeof options.now === 'number' && Number.isFinite(options.now) && options.now > 0
      ? Math.round(options.now)
      : Date.now()
  const script = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1], { readOnly: true })
const cutoff = Number(process.env.UMI_RECENT_CHAT_CUTOFF) || Date.now()
// agent 库里出现过的 direct conversation 本身就是 feiyu 收过的会话；按最近活跃跨渠道选一个，
// 与主动发送器“最近聊过的渠道优先”保持同口径。群聊/公开频道不参与回复解除。
// 时间查询不要求 event_json：tool/上下文压缩后只保留 event_zstd 的用户事件同样算真实回复。
// 一个 conversation 可能轮换多个 session，必须跨 session 聚合，不能只取最新 session。
const latestUser = db.prepare(
  "SELECT sc.conversation_id, t.created_at AS last_user_at FROM transcript_events t JOIN session_conversations sc ON sc.session_id = t.session_id JOIN conversations c ON c.conversation_id = sc.conversation_id WHERE c.kind = 'direct' AND t.message_role = 'user' AND (t.event_json IS NOT NULL OR t.event_zstd IS NOT NULL) AND t.created_at <= ? ORDER BY t.created_at DESC, t.seq DESC, sc.session_id ASC, sc.conversation_id ASC LIMIT 1"
).get(cutoff)
if (!latestUser) {
  console.log(JSON.stringify({ messages: [], lastUserMessageAt: 0, conversationId: '' }))
  process.exit(0)
}
const conversationId = String(latestUser.conversation_id || '')
const rows = db.prepare(
  "SELECT t.event_json, t.created_at FROM transcript_events t JOIN session_conversations sc ON sc.session_id = t.session_id WHERE sc.conversation_id = ? AND t.event_json IS NOT NULL AND t.message_role IN ('user','assistant') AND t.created_at <= ? ORDER BY t.created_at DESC, t.seq DESC LIMIT 1000"
).all(conversationId, cutoff)
console.log(JSON.stringify({
  messages: rows,
  lastUserMessageAt: Number(latestUser.last_user_at) || 0,
  conversationId
}))
`
  return new Promise((resolve) => {
    execFile(
      options.nodePath,
      ['-e', script, options.dbPath],
      {
        timeout: options.timeoutMs ?? 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, UMI_RECENT_CHAT_CUTOFF: String(cutoff) }
      },
      (error, stdout) => {
        if (error) {
          resolve({ messages: [], lastUserMessageAt: 0, conversationId: '' })
          return
        }
        try {
          const raw = JSON.parse(String(stdout || '{}')) as Record<string, unknown>
          const messages = parseRecentChatRows(raw.messages).slice(-limit)
          const conversationId =
            typeof raw.conversationId === 'string' ? raw.conversationId.trim() : ''
          const reported =
            typeof raw.lastUserMessageAt === 'number' && Number.isFinite(raw.lastUserMessageAt)
              ? Math.max(0, raw.lastUserMessageAt)
              : 0
          resolve({
            messages,
            lastUserMessageAt: Math.max(reported, latestUserAt(messages)),
            conversationId
          })
        } catch {
          resolve({ messages: [], lastUserMessageAt: 0, conversationId: '' })
        }
      }
    )
  })
}
