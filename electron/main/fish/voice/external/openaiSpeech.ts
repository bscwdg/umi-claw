// electron/main/fish/voice/external/openaiSpeech.ts —— OpenAI Audio Speech 兼容适配器
//
// 这一层只认识 /v1/audio/speech 协议，不认识实例来自本机、局域网还是远端。
// 这样用户自己部署的 vLLM-Omni、MOSS、Qwen3-TTS 或其他兼容服务都能走同一入口。

import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import type {
  ExternalTtsProfilesResult,
  ExternalTtsProbeResult,
  ExternalTtsService,
  ExternalTtsSynthesisInput,
  ExternalTtsSynthesisResult,
  ExternalTtsVoiceProfile,
  ExternalTtsVoiceType
} from './types'

type FetchLike = typeof fetch

function invalid(message: string, details?: unknown): VoiceError {
  return new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, message, details)
}

function trimRequired(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalid(`${label}必须是字符串`)
  const text = value.trim()
  if (!text) throw invalid(`${label}不能为空`)
  if (text.length > maxLength) throw invalid(`${label}过长（上限 ${maxLength} 字符）`)
  return text
}

export function normalizeExternalBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw invalid('服务地址必须是字符串')
  let raw = value.trim()
  if (!raw) throw invalid('服务地址不能为空')
  // 本机/局域网服务常被直接填成 `192.168.31.36:7860`（无协议头）。
  // 注意不能只看 `://`：`http:/example.com`、`http:example.com` 是合法 http 写法，
  // 误补成 `http://http:/...` 会把 host 变成 "http"，带 Key 时会发到错误主机。
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (!scheme) {
    raw = `http://${raw}`
  } else if (scheme[1].toLowerCase() !== 'http' && scheme[1].toLowerCase() !== 'https') {
    // `localhost:7860` 这类 host:port 会被上面的正则误认成 scheme，端口前面是纯数字；
    // 其余如 `mailto:`、`ftp://` 明确拒绝，避免用户把协议写错却看到「用户名/密码」提示。
    const rest = raw.slice(scheme[0].length)
    if (/^\d+(?:[/?#]|$)/.test(rest)) raw = `http://${raw}`
    else throw invalid('服务地址只支持 http:// 或 https://')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('服务地址不是合法 URL（示例：192.168.31.36:7860 或 http://192.168.31.36:7860）')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('服务地址只支持 http:// 或 https://')
  }
  if (url.username || url.password) {
    throw invalid('服务地址不能包含用户名或密码，请把 Key 填在独立密钥框')
  }
  if (url.search || url.hash) {
    throw invalid('服务地址不能包含查询参数或锚点')
  }
  const path = url.pathname.replace(/\/+$/, '')
  const basePath = path.toLowerCase().endsWith('/v1') ? path : `${path}/v1`
  return `${url.origin}${basePath.replace(/\/{2,}/g, '/')}`
}

export function externalSpeechUrl(baseUrl: string): string {
  return `${normalizeExternalBaseUrl(baseUrl)}/audio/speech`
}

export function externalModelsUrl(baseUrl: string): string {
  return `${normalizeExternalBaseUrl(baseUrl)}/models`
}

/** Voicebox 原生接口在根路径，不在 /v1 下 */
function nativeRoot(baseUrl: string): string {
  return normalizeExternalBaseUrl(baseUrl).replace(/\/v1$/i, '')
}

function nativeProfilesUrl(baseUrl: string): string {
  return `${nativeRoot(baseUrl)}/profiles`
}

function nativeGenerateUrl(baseUrl: string): string {
  return `${nativeRoot(baseUrl)}/generate/stream`
}

/**
 * 归一化用户填写的音色查询地址：
 * - 空 → ''（调用方回落默认 {根}/profiles）
 * - 以 / 开头 → 同主机路径
 * - 其余必须是完整 http(s) URL（允许跨主机；跨主机请求不带 Key）
 */
export function normalizeProfilesPath(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalid('音色查询地址必须是字符串')
  const raw = value.trim()
  if (!raw) return ''
  if (raw.length > 512) throw invalid('音色查询地址过长（上限 512 字符）')
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) {
      throw invalid('音色查询路径不能以 // 开头；跨主机请填完整 http(s) 地址')
    }
    return raw
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('音色查询地址需是以 / 开头的路径，或完整 http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('音色查询地址只支持 http:// 或 https://')
  }
  if (url.username || url.password) {
    throw invalid('音色查询地址不能包含用户名或密码')
  }
  return url.toString()
}

/** 解析实际查询 URL，并判断是否跨主机（跨主机不携带实例 Key） */
export function resolveProfilesUrl(
  baseUrl: string,
  profilesPath: unknown
): { url: string; crossHost: boolean } {
  const normalized = normalizeProfilesPath(profilesPath)
  if (!normalized) return { url: nativeProfilesUrl(baseUrl), crossHost: false }
  if (normalized.startsWith('/')) {
    return { url: `${nativeRoot(baseUrl)}${normalized}`, crossHost: false }
  }
  const target = new URL(normalized)
  const instance = new URL(nativeRoot(baseUrl))
  return { url: target.toString(), crossHost: target.origin !== instance.origin }
}

interface ResolvedVoiceProfile {
  id: string
  name: string
  voiceType: ExternalTtsVoiceType
  language?: string
  presetEngine?: string
  defaultEngine?: string
  sampleCount?: number
  usable: boolean
  unavailableReason?: string
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pickFirstString(src: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = trimmedString(src[key])
    if (value) return value
  }
  return ''
}

function normalizeVoiceType(value: unknown): ExternalTtsVoiceType {
  const type = trimmedString(value).toLowerCase()
  if (type === 'preset' || type === 'cloned' || type === 'designed') return type
  return 'unknown'
}

/** 从不同后端返回里抽取音色数组：裸数组 / {data} / {voices} / {profiles} / {models} / {items} */
function extractProfileArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const src = raw as Record<string, unknown>
    for (const key of ['data', 'voices', 'profiles', 'models', 'items']) {
      if (Array.isArray(src[key])) return src[key] as unknown[]
    }
  }
  return []
}

function parseVoiceProfiles(raw: unknown): ResolvedVoiceProfile[] {
  const out: ResolvedVoiceProfile[] = []
  for (const item of extractProfileArray(raw)) {
    if (!item || typeof item !== 'object') continue
    const src = item as Record<string, unknown>
    const id = pickFirstString(src, ['id', 'voice_id', 'voiceId', 'model', 'name'])
    if (!id) continue
    const name = pickFirstString(src, ['name', 'display_name', 'displayName', 'title', 'id']) || id
    const voiceType = normalizeVoiceType(src.voice_type ?? src.voiceType)
    const presetEngine = trimmedString(src.preset_engine) || undefined
    const defaultEngine = trimmedString(src.default_engine) || undefined
    const language = trimmedString(src.language) || undefined
    let sampleCount: number | undefined
    if (typeof src.sample_count === 'number' && Number.isFinite(src.sample_count)) {
      sampleCount = src.sample_count
    }
    let usable = true
    let unavailableReason: string | undefined
    // 口径：只把数值 0 视为「没传参考音频」。字段缺失（undefined）按可用处理——
    // 文档契约里 sample_count 恒存在，缺字段属于服务端契约外的脏数据，fail-closed
    // 会让正常服务偶发漏字段时整个克隆列表不可选；字符串 "0" 等非数值同样不拦。
    if ((voiceType === 'cloned' || voiceType === 'designed') && sampleCount === 0) {
      usable = false
      unavailableReason = '该克隆音色还没上传参考音频（sample_count=0），暂不可用'
    }
    out.push({
      id,
      name,
      voiceType,
      language,
      presetEngine,
      defaultEngine,
      sampleCount,
      usable,
      unavailableReason
    })
  }
  return out
}

/** 按文档规则派生合成引擎：preset→qwen_custom_voice；cloned/designed→qwen + 1.7B */
function deriveVoiceboxEngine(
  profile: ResolvedVoiceProfile
): { engine: string; modelSize?: string } | null {
  if (profile.voiceType === 'preset') {
    return { engine: profile.presetEngine || 'qwen_custom_voice' }
  }
  if (profile.voiceType === 'cloned' || profile.voiceType === 'designed') {
    const engine = profile.defaultEngine || 'qwen'
    return engine === 'qwen' ? { engine, modelSize: '1.7B' } : { engine }
  }
  // unknown：优先信任服务端给的引擎字段，保证只有 preset_engine 的老数据不回归
  if (profile.presetEngine) return { engine: profile.presetEngine }
  if (profile.defaultEngine) {
    return profile.defaultEngine === 'qwen'
      ? { engine: 'qwen', modelSize: '1.7B' }
      : { engine: profile.defaultEngine }
  }
  return null
}

function toExternalProfile(profile: ResolvedVoiceProfile): ExternalTtsVoiceProfile {
  const derived = deriveVoiceboxEngine(profile)
  return {
    id: profile.id,
    name: profile.name,
    voiceType: profile.voiceType,
    ...(profile.language ? { language: profile.language } : {}),
    ...(derived?.engine ? { engine: derived.engine } : {}),
    ...(derived?.modelSize ? { modelSize: derived.modelSize } : {}),
    ...(typeof profile.sampleCount === 'number' ? { sampleCount: profile.sampleCount } : {}),
    usable: profile.usable,
    ...(profile.unavailableReason ? { unavailableReason: profile.unavailableReason } : {})
  }
}

function pickVoiceboxProfile(
  profiles: ResolvedVoiceProfile[],
  voice: string
): ResolvedVoiceProfile | null {
  const target = voice.trim().toLowerCase()
  if (!target) return null
  const exact = profiles.find((p) => p.id.toLowerCase() === target || p.name.toLowerCase() === target)
  if (exact) return exact
  // 只做前缀匹配，避免名字「女声」把任意含它的音色都选中；多个候选时宁可报错
  const prefix = profiles.filter(
    (p) => p.id.toLowerCase().startsWith(target) || p.name.toLowerCase().startsWith(target)
  )
  return prefix.length === 1 ? prefix[0] : null
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
  timedOut: () => boolean
} {
  const controller = new AbortController()
  let timeoutHit = false
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timeoutHit = true
    controller.abort(new Error('external tts timeout'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
    timedOut: () => timeoutHit
  }
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim().replace(/\s+/g, ' ')
    return text.slice(0, 300)
  } catch {
    return ''
  }
}

function mapHttpError(status: number, detail: string): VoiceError {
  if (status === 401 || status === 403) {
    return new VoiceError(VOICE_ERROR_CODES.AUTH_ERROR, `本地 TTS 鉴权失败：HTTP ${status}`, {
      status,
      detail
    })
  }
  if (status === 429) {
    return new VoiceError(VOICE_ERROR_CODES.RATE_LIMITED, '本地 TTS 请求过于频繁', {
      status,
      detail
    })
  }
  return new VoiceError(VOICE_ERROR_CODES.PROVIDER_ERROR, `本地 TTS 返回 HTTP ${status}`, {
    status,
    detail
  })
}

function mapFetchError(
  error: unknown,
  timedOut: () => boolean,
  signal: AbortSignal | undefined
): VoiceError {
  if (timedOut()) {
    return new VoiceError(VOICE_ERROR_CODES.TIMEOUT, '本地 TTS 请求超时')
  }
  if (signal?.aborted) {
    return new VoiceError(VOICE_ERROR_CODES.CANCELLED, '本地 TTS 请求已取消')
  }
  if (error instanceof TypeError) {
    return new VoiceError(
      VOICE_ERROR_CODES.EXTERNAL_UNREACHABLE,
      '无法连接本地 TTS 服务，请检查地址、网络和服务状态'
    )
  }
  return new VoiceError(
    VOICE_ERROR_CODES.PROVIDER_ERROR,
    error instanceof Error ? error.message : '本地 TTS 请求失败'
  )
}

function parseAudioResponse(response: Response, expected?: 'mp3' | 'wav'): {
  mime: string
  extension: 'mp3' | 'wav'
} {
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  let parsed: { mime: string; extension: 'mp3' | 'wav' }
  if (contentType === 'audio/mpeg' || contentType === 'audio/mp3') {
    parsed = { mime: 'audio/mpeg', extension: 'mp3' }
  } else if (
    contentType === 'audio/wav' ||
    contentType === 'audio/wave' ||
    contentType === 'audio/x-wav'
  ) {
    parsed = { mime: 'audio/wav', extension: 'wav' }
  } else {
    throw new VoiceError(
      VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
      `本地 TTS 返回的不是受支持的音频（Content-Type=${contentType || '缺失'}）`,
      { contentType }
    )
  }
  if (expected && parsed.extension !== expected) {
    throw new VoiceError(
      VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
      `本地 TTS 请求 ${expected} 但返回 ${parsed.extension}`,
      { expected, actual: parsed.extension, contentType }
    )
  }
  return parsed
}

function isPlausibleAudio(bytes: Buffer, extension: 'mp3' | 'wav'): boolean {
  if (bytes.length < 4) return false
  if (extension === 'wav') {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    )
  }
  let offset = 0
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    if (bytes.length < 10) return false
    const tagSize =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f)
    offset = 10 + tagSize
  }
  if (offset + 4 > bytes.length) return false
  const b0 = bytes[offset]
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  if ((b0 & 0xff) !== 0xff || (b1 & 0xe0) !== 0xe0) return false
  const version = (b1 >> 3) & 0x03
  const layer = (b1 >> 1) & 0x03
  const bitrate = (b2 >> 4) & 0x0f
  const sampleRate = (b2 >> 2) & 0x03
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3
}

export class OpenAISpeechProvider {
  constructor(
    private readonly service: ExternalTtsService,
    private readonly apiKey: string | null,
    private readonly fetchImpl: FetchLike
  ) {}

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
  }

  async probe(signal?: AbortSignal): Promise<ExternalTtsProbeResult> {
    const started = performance.now()
    const timeout = withTimeout(signal, 10_000)
    try {
      const response = await this.fetchImpl(externalModelsUrl(this.service.baseUrl), {
        method: 'GET',
        headers: this.authHeaders(),
        signal: timeout.signal
      })
      if (response.status === 404 || response.status === 405) {
        // 先尝试 Voicebox 原生接口：/profiles 可用就说明不是 OpenAI 兼容面，但可直接合成
        try {
          const native = await this.fetchImpl(nativeProfilesUrl(this.service.baseUrl), {
            method: 'GET',
            signal: timeout.signal
          })
          if (!native.ok) {
            // 401/403/5xx 是真实故障，不能报“可达”后让试听才失败
            if (native.status === 401 || native.status === 403 || native.status >= 500) {
              throw mapHttpError(native.status, await responseDetail(native))
            }
          }
          const profiles = native.ok ? parseVoiceProfiles(await native.json().catch(() => null)) : []
          if (profiles.length > 0) {
            return {
              ok: true,
              latencyMs: Math.round(performance.now() - started),
              detail: `服务可达，Voicebox 原生接口（${profiles.length} 个音色）`
            }
          }
        } catch (error) {
          if (error instanceof VoiceError) throw error
          // 原生接口也不可用：继续按 weak 处理
        }
        return {
          ok: true,
          weak: true,
          latencyMs: Math.round(performance.now() - started),
          detail: `服务可达，但 /models 不可用（HTTP ${response.status}），请用试听确认`
        }
      }
      if (!response.ok) throw mapHttpError(response.status, await responseDetail(response))
      if (response.status === 204) {
        return {
          ok: true,
          weak: true,
          latencyMs: Math.round(performance.now() - started),
          detail: '服务可达，但 /models 返回 204（无法判断兼容性），请用试听确认'
        }
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!contentType.includes('application/json')) {
        return {
          ok: true,
          weak: true,
          latencyMs: Math.round(performance.now() - started),
          detail: '服务可达，但 /models 未返回 JSON，请用试听确认'
        }
      }
      const text = await response.text()
      if (!text.trim()) {
        return {
          ok: true,
          weak: true,
          latencyMs: Math.round(performance.now() - started),
          detail: '服务可达，但 /models 返回空内容，请用试听确认'
        }
      }
      try {
        JSON.parse(text)
      } catch {
        return {
          ok: true,
          weak: true,
          latencyMs: Math.round(performance.now() - started),
          detail: '服务可达，但 /models 返回坏 JSON，请用试听确认'
        }
      }
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        detail: '服务可达，/models 返回有效 JSON'
      }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      throw mapFetchError(error, timeout.timedOut, signal)
    } finally {
      timeout.cleanup()
    }
  }

  async synthesize(input: ExternalTtsSynthesisInput): Promise<ExternalTtsSynthesisResult> {
    const text = trimRequired(input.text, '合成文本', 8000)
    const voice = trimRequired(input.voice, '音色', 256)
    const speed =
      typeof input.speedRatio === 'number' && Number.isFinite(input.speedRatio)
        ? Math.max(0.25, Math.min(4, input.speedRatio))
        : null
    const body: Record<string, unknown> = {
      model: this.service.model,
      input: text,
      voice,
      response_format: input.responseFormat ?? this.service.responseFormat
    }
    if (speed !== null && Math.abs(speed - 1) > 0.001) body.speed = speed

    const timeout = withTimeout(input.signal, 60_000)
    try {
      const response = await this.fetchImpl(externalSpeechUrl(this.service.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders()
        },
        body: JSON.stringify(body),
        signal: timeout.signal
      })
      if (response.status === 404 || response.status === 405) {
        // 先保留原 OpenAI 接口错误；原生 fallback 失败时用户仍能看到真正的失败原因
        const originalDetail = await responseDetail(response).catch(() => '')
        try {
          return await this.synthesizeVoicebox(text, voice, input.signal)
        } catch (error) {
          if (error instanceof VoiceError && error.code === VOICE_ERROR_CODES.AUTH_ERROR) throw error
          const reason = error instanceof Error ? error.message : String(error)
          throw new VoiceError(
            VOICE_ERROR_CODES.PROVIDER_ERROR,
            `OpenAI 兼容接口不可用（HTTP ${response.status}${originalDetail ? `：${originalDetail}` : ''}）；Voicebox 原生接口也不可用：${reason}`
          )
        }
      }
      if (!response.ok) throw mapHttpError(response.status, await responseDetail(response))
      const expected = input.responseFormat
      const parsed = parseAudioResponse(response, expected)
      const audio = Buffer.from(await response.arrayBuffer())
      if (audio.length === 0) {
        throw new VoiceError(
          VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
          '本地 TTS 返回了空音频'
        )
      }
      if (!isPlausibleAudio(audio, parsed.extension)) {
        throw new VoiceError(
          VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
          `本地 TTS 返回的 ${parsed.extension} 内容不是可识别音频`
        )
      }
      return { audio, mime: parsed.mime, extension: parsed.extension }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      throw mapFetchError(error, timeout.timedOut, input.signal)
    } finally {
      timeout.cleanup()
    }
  }

  /**
   * 查询音色列表（设置页「查询音色」）：走实例配置的查询地址，跨主机不带 Key。
   * 兼容裸数组与 {data|voices|profiles|models|items} 等包裹结构。
   */
  async listProfiles(
    profilesPath: string | undefined,
    signal?: AbortSignal
  ): Promise<ExternalTtsProfilesResult> {
    const resolved = resolveProfilesUrl(this.service.baseUrl, profilesPath)
    const timeout = withTimeout(signal, 10_000)
    try {
      const headers: Record<string, string> = resolved.crossHost ? {} : this.authHeaders()
      const response = await this.fetchImpl(resolved.url, {
        method: 'GET',
        headers,
        signal: timeout.signal
      })
      if (!response.ok) {
        const httpError = mapHttpError(response.status, await responseDetail(response))
        // 跨主机查询刻意不带实例 Key；此时 401/403 不是本机 Key 错了，别误导用户
        if (resolved.crossHost && (response.status === 401 || response.status === 403)) {
          throw new VoiceError(
            httpError.code,
            `跨主机音色查询被拒绝（HTTP ${response.status}）；该查询不会携带本机实例的 API Key，请确认查询地址是否需要单独授权`
          )
        }
        throw httpError
      }
      const profiles = parseVoiceProfiles(await response.json().catch(() => null)).map(
        toExternalProfile
      )
      if (profiles.length === 0) {
        throw new VoiceError(
          VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
          '音色查询接口没有返回可用音色，请检查查询地址或返回结构'
        )
      }
      return {
        profiles,
        detail: `查询到 ${profiles.length} 个音色`,
        sourceUrl: resolved.url,
        crossHost: resolved.crossHost
      }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      throw mapFetchError(error, timeout.timedOut, signal)
    } finally {
      timeout.cleanup()
    }
  }

  /**
   * Voicebox 原生 /generate/stream：/v1/audio/speech 不存在时兜底。
   * 音色填 profile id 或名称；preset 走 qwen_custom_voice，克隆/设计走 qwen + 1.7B。
   */
  private async synthesizeVoicebox(
    text: string,
    voice: string,
    signal: AbortSignal | undefined
  ): Promise<ExternalTtsSynthesisResult> {
    const timeout = withTimeout(signal, 120_000)
    try {
      const profilesTarget = resolveProfilesUrl(this.service.baseUrl, this.service.profilesPath)
      const profilesResponse = await this.fetchImpl(profilesTarget.url, {
        method: 'GET',
        headers: profilesTarget.crossHost ? {} : this.authHeaders(),
        signal: timeout.signal
      })
      if (!profilesResponse.ok) {
        throw mapHttpError(profilesResponse.status, await responseDetail(profilesResponse))
      }
      const profiles = parseVoiceProfiles(await profilesResponse.json().catch(() => null))
      if (profiles.length === 0) {
        throw new VoiceError(
          VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
          'Voicebox 原生接口没有返回可用音色'
        )
      }
      const profile = pickVoiceboxProfile(profiles, voice)
      if (!profile) {
        throw invalid(
          `Voicebox 里找不到唯一音色「${voice}」；可用：${profiles.map((p) => p.name).join('、')}`
        )
      }
      if (!profile.usable) {
        throw invalid(profile.unavailableReason || `Voicebox 音色「${profile.name}」当前不可用`)
      }
      const derived = deriveVoiceboxEngine(profile)
      if (!derived) {
        throw invalid(
          `Voicebox 音色「${profile.name}」缺少引擎信息（preset_engine/default_engine），无法合成`
        )
      }
      const body: Record<string, unknown> = {
        profile_id: profile.id,
        text,
        language: profile.language || 'zh',
        engine: derived.engine
      }
      if (derived.modelSize) body.model_size = derived.modelSize
      const response = await this.fetchImpl(nativeGenerateUrl(this.service.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeout.signal
      })
      if (!response.ok) throw mapHttpError(response.status, await responseDetail(response))
      const parsed = parseAudioResponse(response, 'wav')
      const audio = Buffer.from(await response.arrayBuffer())
      if (audio.length === 0 || !isPlausibleAudio(audio, parsed.extension)) {
        throw new VoiceError(
          VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE,
          'Voicebox 返回的音频不可识别'
        )
      }
      return { audio, mime: parsed.mime, extension: parsed.extension }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      throw mapFetchError(error, timeout.timedOut, signal)
    } finally {
      timeout.cleanup()
    }
  }
}

export function createOpenAISpeechProvider(
  service: ExternalTtsService,
  apiKey: string | null,
  fetchImpl: FetchLike
): OpenAISpeechProvider {
  return new OpenAISpeechProvider(service, apiKey, fetchImpl)
}
