// electron/main/character/chat.ts —— 聊天流（C04）
//
// 职责：会话键（conv:fish:<session>:<gen>）+ 流式增量 + [emotion:*] 标记剥离 + 会话轮换。
// 纯 Node（不 import electron），gateway 调用与事件通道都从外部注入，便于验收。
// 不建本地消息表：上下文靠 OpenClaw sticky 会话，面板只保留本次会话气泡。

import type { CharacterChatSession } from './types'

export const CHAT_SESSIONS: CharacterChatSession[] = ['main', 'night']
const MAX_INPUT_LENGTH = 4000

export interface CharacterChatDelta {
  index: number
  delta: string
}

export interface CharacterChatHandle {
  iterator: AsyncIterable<CharacterChatDelta>
  result: Promise<{ aborted: boolean; text: string }>
  cancel(): void
}

export interface CharacterChatRequest {
  conversationKey: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  stream: true
}

export type CharacterChatFn = (
  input: CharacterChatRequest
) => CharacterChatHandle | Promise<CharacterChatHandle>

export interface CharacterChatStreamEvent {
  runId: string
  kind: 'chunk' | 'done' | 'error'
  text?: string
  emotion?: string
  error?: string
  aborted?: boolean
}

export interface CharacterChatServiceOptions {
  chat: CharacterChatFn
  store: {
    readChatGeneration(): Promise<number>
    writeChatGeneration(gen: number): Promise<void>
  }
  onEmotion?: (emotion: string, visualState: string) => void
  now?: () => number
  logger?: (message: string) => void
}

/** `[emotion:开心]` / `[emotion：开心]` 标记；模型输出里剥离后再展示 */
const EMOTION_MARKER = /\[\s*emotion\s*[:：]\s*([^\]\s]{1,12})\s*\]/g

/** 情绪 → 六态（与 resources/character/emotions.v1.json 对齐） */
const EMOTION_TO_STATE: Record<string, string> = {
  开心: 'happy',
  喜欢: 'happy',
  害羞: 'happy',
  得意: 'happy',
  打招呼: 'happy',
  卖萌: 'happy',
  难过: 'sulk',
  委屈: 'sulk',
  生气: 'sulk',
  拒绝: 'sulk',
  疲惫: 'sleepy',
  搞怪: 'caught',
  惊: 'caught',
  疑惑: 'idle',
  无语: 'idle',
  其他: 'idle'
}

export function mapEmotionToState(emotion: string, text = ''): string {
  const mapped = EMOTION_TO_STATE[emotion] ?? 'idle'
  // 吃到/端着饭碗的语境优先「吃白饭」态
  if (mapped === 'happy' && /白饭|开饭|吃饭|投喂|吃饱|饭碗/.test(text)) return 'eat'
  return mapped
}

export function stripEmotionMarkers(text: string): { text: string; emotion?: string } {
  let emotion: string | undefined
  const cleaned = text.replace(EMOTION_MARKER, (_m, captured: string) => {
    if (!emotion) emotion = captured
    return ''
  })
  return { text: cleaned, emotion }
}

/**
 * 流式情绪标记过滤器：跨 chunk 的标记不能被拆开展示给用户。
 * - 完整标记：吞掉并记 emotion
 * - 末尾疑似标记前缀：挂起到下一块
 */
export class EmotionStreamFilter {
  private pending = ''
  private emotion: string | undefined

  push(chunk: string): { text: string; emotion?: string } {
    this.pending += chunk
    let out = ''
    for (;;) {
      EMOTION_MARKER.lastIndex = 0
      const match = EMOTION_MARKER.exec(this.pending)
      if (!match || match.index === undefined) break
      if (!this.emotion) this.emotion = match[1]
      out += this.pending.slice(0, match.index)
      this.pending = this.pending.slice(match.index + match[0].length)
    }
    // 末尾有半截标记：挂起
    const open = this.pending.lastIndexOf('[')
    if (open >= 0) {
      const tail = this.pending.slice(open)
      if (!tail.includes(']') && tail.length <= 40) {
        out += this.pending.slice(0, open)
        this.pending = tail
        return { text: out, emotion: this.emotion }
      }
    }
    out += this.pending
    this.pending = ''
    return { text: out, emotion: this.emotion }
  }

  flush(): { text: string; emotion?: string } {
    const rest = this.pending.replace(EMOTION_MARKER, '')
    this.pending = ''
    return { text: rest, emotion: this.emotion }
  }

  currentEmotion(): string | undefined {
    return this.emotion
  }
}

export class CharacterChatService {
  private gen = 1
  private seq = 0
  private readonly active = new Map<string, CharacterChatHandle>()

  constructor(private readonly options: CharacterChatServiceOptions) {}

  async init(): Promise<void> {
    this.gen = await this.options.store.readChatGeneration()
  }

  getGeneration(): number {
    return this.gen
  }

  conversationKey(session: CharacterChatSession): string {
    const safe = CHAT_SESSIONS.includes(session) ? session : 'main'
    return `conv:fish:${safe}:${this.gen}`
  }

  async send(
    input: { text?: unknown; session?: unknown },
    emit: (event: CharacterChatStreamEvent) => void
  ): Promise<{ runId: string; conversationKey: string }> {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (!text) throw new Error('消息不能为空')
    if (text.length > MAX_INPUT_LENGTH) throw new Error(`消息过长（上限 ${MAX_INPUT_LENGTH} 字）`)
    const session = (input?.session as CharacterChatSession) ?? 'main'
    const conversationKey = this.conversationKey(session)
    const runId = `chat-${this.options.now?.() ?? Date.now()}-${(this.seq += 1)}`

    const handle = await this.options.chat({
      conversationKey,
      messages: [{ role: 'user', content: text }],
      stream: true
    })
    this.active.set(runId, handle)
    void this.pump(runId, handle, emit)
    return { runId, conversationKey }
  }

  cancel(runId: string): boolean {
    const handle = this.active.get(runId)
    if (!handle) return false
    try {
      handle.cancel()
    } catch {
      /* ignore */
    }
    return true
  }

  cancelAll(): void {
    for (const runId of [...this.active.keys()]) this.cancel(runId)
  }

  async clear(): Promise<{ gen: number }> {
    this.cancelAll()
    this.gen += 1
    await this.options.store.writeChatGeneration(this.gen)
    return { gen: this.gen }
  }

  private async pump(
    runId: string,
    handle: CharacterChatHandle,
    emit: (event: CharacterChatStreamEvent) => void
  ): Promise<void> {
    const filter = new EmotionStreamFilter()
    let full = ''
    try {
      for await (const delta of handle.iterator) {
        const part = filter.push(delta?.delta ?? '')
        if (part.text) {
          full += part.text
          emit({ runId, kind: 'chunk', text: part.text })
        }
      }
      const rest = filter.flush()
      if (rest.text) {
        full += rest.text
        emit({ runId, kind: 'chunk', text: rest.text })
      }
      const result = await handle.result
      const emotion = rest.emotion ?? filter.currentEmotion()
      const visualState = mapEmotionToState(emotion ?? '', full)
      if (emotion) this.options.onEmotion?.(emotion, visualState)
      emit({
        runId,
        kind: 'done',
        text: full,
        emotion,
        aborted: Boolean(result?.aborted)
      })
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      this.options.logger?.(`[character] 聊天流失败: ${message}`)
      emit({ runId, kind: 'error', error: message })
    } finally {
      this.active.delete(runId)
    }
  }
}
