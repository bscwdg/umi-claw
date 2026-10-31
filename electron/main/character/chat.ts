// electron/main/character/chat.ts —— 聊天流（C04）
//
// 职责：会话键（conv:fish:<session>:<gen>）+ 流式增量 + [emotion:*] 标记剥离 + 会话轮换。
// 纯 Node（不 import electron），gateway 调用与事件通道都从外部注入，便于验收。
// 不建本地消息表：上下文靠 OpenClaw sticky 会话，面板只保留本次会话气泡。

import {
  CHARACTER_ERROR_CODES,
  CharacterError,
  type CharacterChatSession
} from './types'
import { CHARACTER_AGENT_MODEL } from './agentConfig'

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
  /** 显式路由到角色 agent（openclaw/feiyu）；不传会落到默认模型，人格/记忆全部空转 */
  model?: string
}

export type CharacterChatFn = (
  input: CharacterChatRequest
) => CharacterChatHandle | Promise<CharacterChatHandle>

export interface CharacterChatStreamEvent {
  runId: string
  /** 会话代际：clear() 之后旧代际的事件必须被渲染端丢弃 */
  gen: number
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
  /** 角色 agent 的模型路由（缺省 openclaw/feiyu，由 wiring 注入） */
  model?: string
  /** 每轮注入的短上下文（STATE/LIFE 摘要，≤300 字）；只拼在 user 内容前，不落 sticky */
  contextProvider?: () => Promise<string | null>
  /** 一轮聊天成功结束：交给关系引擎记账（refId=runId 保证幂等） */
  onMessage?: (text: string, refId: string) => void
  onEmotion?: (emotion: string, visualState: string) => void
  now?: () => number
  logger?: (message: string) => void
}

/** `[emotion:开心]` / `[emotion：开心]` 标记；模型输出里剥离后再展示 */
const EMOTION_MARKER = /\[\s*emotion\s*[:：]\s*([^\]\n]{1,24})\s*\]/g

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
    // 多个标记时取最后一个（模型常以后置标记为准）
    emotion = String(captured ?? '').trim() || emotion
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
      this.emotion = String(match[1] ?? '').trim() || this.emotion
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
  private readonly cancelled = new Set<string>()

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
  ): Promise<{ runId: string; conversationKey: string; gen: number }> {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (!text) throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '消息不能为空')
    if (text.length > MAX_INPUT_LENGTH) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.BAD_PAYLOAD,
        `消息过长（上限 ${MAX_INPUT_LENGTH} 字）`
      )
    }
    const session = (input?.session as CharacterChatSession) ?? 'main'
    const conversationKey = this.conversationKey(session)
    const runId = `chat-${this.options.now?.() ?? Date.now()}-${(this.seq += 1)}`

    let handle: CharacterChatHandle
    let context = ''
    if (this.options.contextProvider) {
      try {
        context = (await this.options.contextProvider()) ?? ''
      } catch {
        context = ''
      }
    }
    const content = context ? `【本鱼状态】${context}\n\n${text}` : text
    try {
      handle = await this.options.chat({
        conversationKey,
        messages: [{ role: 'user', content }],
        stream: true,
        // 兜底路由到角色 agent：调用方忘传 model 也不能静默退回默认模型
        model: this.options.model ?? CHARACTER_AGENT_MODEL
      })
    } catch (error) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.NOT_READY,
        `聊天网关不可用：${(error as Error)?.message ?? String(error)}`
      )
    }
    this.active.set(runId, handle)
    void this.pump(runId, handle, emit)
    return { runId, conversationKey, gen: this.gen }
  }

  cancel(runId: string): boolean {
    const handle = this.active.get(runId)
    if (!handle) return false
    this.cancelled.add(runId)
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

  /** reset('all') 之后重新读取代际（旧上下文不得复活） */
  async reloadGeneration(): Promise<number> {
    this.gen = await this.options.store.readChatGeneration()
    return this.gen
  }

  /** 事件推送不得抛错：窗口销毁竞态下 webContents.send 会抛，抛出去就是 unhandledRejection */
  private safeEmit(
    emit: (event: CharacterChatStreamEvent) => void,
    event: CharacterChatStreamEvent
  ): void {
    try {
      emit(event)
    } catch (error) {
      this.options.logger?.(`[character] 流事件推送失败: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  private async pump(
    runId: string,
    handle: CharacterChatHandle,
    emit: (event: CharacterChatStreamEvent) => void
  ): Promise<void> {
    const filter = new EmotionStreamFilter()
    const gen = this.gen
    let full = ''
    try {
      for await (const delta of handle.iterator) {
        // 用户已取消：不再展示任何增量（上游可能还会吐几帧）
        if (this.cancelled.has(runId)) break
        const part = filter.push(delta?.delta ?? '')
        if (part.text) {
          full += part.text
          this.safeEmit(emit, { runId, gen, kind: 'chunk', text: part.text })
        }
      }
      const cancelled = this.cancelled.has(runId)
      const rest = cancelled ? { text: '', emotion: undefined } : filter.flush()
      if (rest.text) {
        full += rest.text
        this.safeEmit(emit, { runId, gen, kind: 'chunk', text: rest.text })
      }
      const result = await handle.result.catch(() => null)
      const fallbackText =
        typeof result?.text === 'string' ? stripEmotionMarkers(result.text).text : ''
      const finalText = cancelled ? full : full || fallbackText
      const emotion = rest.emotion ?? filter.currentEmotion()
      const visualState = mapEmotionToState(emotion ?? '', finalText)
      if (emotion && !cancelled) this.options.onEmotion?.(emotion, visualState)
      this.safeEmit(emit, {
        runId,
        gen,
        kind: 'done',
        text: finalText,
        emotion,
        aborted: cancelled || Boolean(result?.aborted)
      })
      if (!cancelled) {
        try {
          this.options.onMessage?.(finalText, runId)
        } catch (error) {
          this.options.logger?.(
            `[character] 关系记账失败: ${(error as Error)?.message ?? String(error)}`
          )
        }
      }
    } catch (error) {
      if (!this.cancelled.has(runId)) {
        const message = (error as Error)?.message ?? String(error)
        this.options.logger?.(`[character] 聊天流失败: ${message}`)
        this.safeEmit(emit, { runId, gen, kind: 'error', error: message })
      }
    } finally {
      this.active.delete(runId)
      this.cancelled.delete(runId)
    }
  }
}
