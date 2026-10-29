import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import type { VoiceAudioFormat } from '../core/types'
import { emotionInstruction } from '../core/emotionOptions'

export interface VolcengineTtsRequest {
  endpoint: string
  apiKey: string
  resourceId: string
  text: string
  speaker: string
  /** 合成路由：预设音色走 plan 接口，克隆音色走 ICL 资源。 */
  route?: 'preset' | 'cloned'
  /**
   * 复刻音色的 model。官方枚举只有两个：
   *   seed-tts-2.0-standard（标准版）
   *   seed-tts-2.0-expressive（表现力增强版）
   * 仅当 speaker 为复刻音色时应传；传了之后官方注明不支持 context_texts。
   * 预设音色必须不传。
   */
  cloneModel?: 'seed-tts-2.0-standard' | 'seed-tts-2.0-expressive'
  speedRatio: number
  emotion?: string
  format: VoiceAudioFormat
  sampleRate: number
  timeoutMs?: number
  signal?: AbortSignal
  returnUsage?: boolean
}

export interface VolcengineTtsResult {
  audio: Buffer
  usage: Record<string, unknown> | null
  logId: string | null
}

type FetchLike = typeof fetch

function errorFromCode(code: number, message: string): VoiceError {
  if (code === 401) {
    return new VoiceError(VOICE_ERROR_CODES.AUTH_ERROR, '语音鉴权失败，请检查 API Key', {
      providerCode: code
    })
  }
  if (code === 429) {
    return new VoiceError(VOICE_ERROR_CODES.RATE_LIMITED, '语音服务限流，请稍后重试', {
      providerCode: code
    })
  }
  return new VoiceError(VOICE_ERROR_CODES.PROVIDER_ERROR, message || `语音服务错误 ${code}`, {
    providerCode: code
  })
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function makeTimeoutSignal(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('voice timeout')), timeoutMs)
  const onAbort = (): void => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}

export class VolcengineTtsProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async synthesize(request: VolcengineTtsRequest): Promise<VolcengineTtsResult> {
    const timeoutMs = request.timeoutMs ?? 60_000
    const { signal, cleanup } = makeTimeoutSignal(timeoutMs, request.signal)
    // v3 单向流接口的 req_params/audio_params 里没有 emotion 字段（核对官方文档 2026-10）。
    // 官方 v3 控制情绪的方式是 req_params.context_texts：一句自然语言语音指令。
    // 旧实现把 emotion 塞进 audio_params，用户填了也不会生效（字段被服务端忽略）。
    // 官方《HTTP Chunked/SSE 单向流-V3》的路径（已逐条对齐）：
    //   req_params.text / speaker / model
    //   req_params.audio_params.format / sample_rate / speech_rate / loudness_rate
    //   req_params.audio_params.emotion / emotion_scale
    //   req_params.additions.context_texts（additions 必须是 JSON 序列化后的字符串）
    const isCloned = request.route === 'cloned'
    // 预设音色：emotion 与 context_texts 都可用（仅部分多情感音色支持 emotion）。
    // 复刻音色：官方注明「指定 model 后不支持 context_texts」，且不支持 emotion。
    const speechInstruction = isCloned
      ? null
      : emotionInstruction(request.emotion, false)
    const additions = speechInstruction
      ? JSON.stringify({ context_texts: [speechInstruction] })
      : undefined
    // 语速/音量：官方在 audio_params 下，取值 [-50,100]，100=2.0 倍、-50=0.5 倍。
    const speechRate = Math.round(Math.min(100, Math.max(-50, (request.speedRatio - 1) * 100)))
    const audioParams: Record<string, unknown> = {
      format: request.format,
      sample_rate: request.sampleRate,
      speech_rate: speechRate
    }
    if (!isCloned && request.emotion) {
      // emotion 是官方枚举值（happy/sad/angry…），位于 audio_params 下。
      audioParams.emotion = request.emotion
    }
    const body: Record<string, unknown> = {
      req_params: {
        text: request.text,
        speaker: request.speaker,
        // model 仅复刻音色需要，且必须是官方两个枚举之一（写错会报 45000001 InvalidModel）。
        ...(isCloned
          ? { model: request.cloneModel ?? 'seed-tts-2.0-standard' }
          : {}),
        ...(additions ? { additions } : {}),
        audio_params: audioParams
      }
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': request.apiKey,
      'X-Api-Resource-Id': request.resourceId
    }
    if (request.returnUsage) headers['X-Control-Require-Usage-Tokens-Return'] = '*'

    try {
      const response = await this.fetchImpl(request.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
      const logId = response.headers.get('x-tt-logid')
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let parsed: Record<string, unknown> | null = null
        try {
          parsed = JSON.parse(text) as Record<string, unknown>
        } catch {
          // 非 JSON 错误体按原始状态码处理
        }
        const code = Number(parsed?.code ?? response.status)
        const message = String(parsed?.message ?? text.slice(0, 300) ?? '')
        throw errorFromCode(code || response.status, message)
      }
      if (!response.body) {
        throw new VoiceError(VOICE_ERROR_CODES.PROVIDER_ERROR, '语音服务未返回响应体')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      const chunks: Buffer[] = []
      let remainder = ''
      let usage: Record<string, unknown> | null = null
      let finished = false

      const consumeLine = (line: string): void => {
        const event = parseJsonLine(line)
        if (!event) return
        const code = Number(event.code ?? 0)
        if (code === 0) {
          if (typeof event.data === 'string' && event.data) {
            chunks.push(Buffer.from(event.data, 'base64'))
          }
          return
        }
        if (code === 20_000_000) {
          finished = true
          if (event.usage && typeof event.usage === 'object') {
            usage = event.usage as Record<string, unknown>
          }
          return
        }
        throw errorFromCode(code, String(event.message ?? ''))
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        remainder += decoder.decode(value, { stream: true })
        let newline = remainder.indexOf('\n')
        while (newline >= 0) {
          const line = remainder.slice(0, newline).replace(/\r$/, '')
          remainder = remainder.slice(newline + 1)
          consumeLine(line)
          newline = remainder.indexOf('\n')
        }
      }
      remainder += decoder.decode()
      if (remainder.trim()) consumeLine(remainder)
      const audio = Buffer.concat(chunks)
      if (!audio.length) {
        throw new VoiceError(VOICE_ERROR_CODES.PROVIDER_ERROR, '语音服务没有返回音频数据', {
          finished
        })
      }
      return { audio, usage, logId }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      if (signal.aborted) {
        throw new VoiceError(VOICE_ERROR_CODES.TIMEOUT, '语音合成超时或已取消')
      }
      throw new VoiceError(
        VOICE_ERROR_CODES.PROVIDER_ERROR,
        error instanceof Error ? error.message : '语音合成失败'
      )
    } finally {
      cleanup()
    }
  }
}
