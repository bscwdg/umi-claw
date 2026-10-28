import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import type { VoiceAudioFormat } from '../core/types'

export interface VolcengineTtsRequest {
  endpoint: string
  apiKey: string
  resourceId: string
  text: string
  speaker: string
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
    const body = {
      req_params: {
        text: request.text,
        speaker: request.speaker,
        audio_params: {
          format: request.format,
          sample_rate: request.sampleRate,
          speed_ratio: request.speedRatio,
          loudness_ratio: 1,
          ...(request.emotion ? { emotion: request.emotion } : {})
        }
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
