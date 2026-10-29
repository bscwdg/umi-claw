import { VOICE_ERROR_CODES, VoiceError } from './errors'
import { wrapPcmAsWav } from './audio'
import { VoiceAudioCache, voiceCacheKey, voiceAudioId } from './cache'
import { VoiceBudget } from './budget'
import {
  VOICE_ENDPOINTS,
  applyVoiceSettingsPatch,
  isVoiceKeyKind,
  normalizeVoiceSettings,
  withVoiceKeyStatus
} from './settings'
import { splitVoiceText } from './text'
import type { VoiceStorage } from './storage'
import type {
  VoiceAudioPayload,
  VoiceCatalogFile,
  VoiceKeyKind,
  VoiceRoute,
  VoiceSettings,
  VoiceSettingsView,
  VoiceSpeakInput,
  VoiceSpeakResult,
  VoiceTestResult,
  VoiceUsageDay
} from './types'
import type { VoiceSecretStore } from '../secretStore'
import { VolcengineCloneProvider } from '../providers/volcengineClone'
import { getVoiceCatalog, isPresetVoice } from '../providers/volcengineCatalog'
import { VolcengineTtsProvider } from '../providers/volcengineTts'

const SETTINGS_KEY = 'voice:v1:settings'
const BYTES_PER_MB = 1024 * 1024

type FetchLike = typeof fetch

export interface VoiceManagerOptions {
  storage: VoiceStorage
  secrets: VoiceSecretStore
  cacheDir: string
  catalog?: VoiceCatalogFile
  fetchImpl?: FetchLike
  now?: () => number
  logger?: (message: string) => void
  onProgress?: (event: import('./types').VoiceProgressEvent) => void
}

function mergeUsage(
  current: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!current) return incoming
  if (!incoming) return current
  const out: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    const a = Number(out[key])
    const b = Number(value)
    out[key] = Number.isFinite(a) && Number.isFinite(b) ? a + b : value
  }
  return out
}

function clampSpeed(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(3, Math.max(0.2, n))
}

export class VoiceManager {
  private readonly storage: VoiceStorage
  private readonly secrets: VoiceSecretStore
  private readonly catalog: VoiceCatalogFile
  private readonly cache: VoiceAudioCache
  private readonly budget: VoiceBudget
  private readonly ttsProvider: VolcengineTtsProvider
  private readonly cloneProvider: VolcengineCloneProvider
  private readonly now: () => number
  private readonly logger: (message: string) => void
  private readonly onProgress: (event: import('./types').VoiceProgressEvent) => void
  private settingsCache: VoiceSettings | null = null
  private readonly inflight = new Map<string, Promise<VoiceSpeakResult>>()
  private readonly controllers = new Map<string, AbortController>()
  private cloneGate:
    | ((speaker: string) => Promise<{ ok: boolean; message?: string }>)
    | null = null

  constructor(options: VoiceManagerOptions) {
    this.storage = options.storage
    this.secrets = options.secrets
    this.catalog = options.catalog ?? getVoiceCatalog()
    this.cache = new VoiceAudioCache(options.cacheDir)
    this.now = options.now ?? (() => Date.now())
    this.budget = new VoiceBudget(this.storage, this.now)
    const fetchImpl = options.fetchImpl ?? fetch
    this.ttsProvider = new VolcengineTtsProvider(fetchImpl)
    this.cloneProvider = new VolcengineCloneProvider(fetchImpl)
    this.logger = options.logger ?? ((message) => console.log(message))
    this.onProgress = options.onProgress ?? (() => undefined)
  }

  getCatalog(): VoiceCatalogFile {
    return JSON.parse(JSON.stringify(this.catalog)) as VoiceCatalogFile
  }

  setCloneGate(
    gate: ((speaker: string) => Promise<{ ok: boolean; message?: string }>) | null
  ): void {
    this.cloneGate = gate
  }

  private async loadSettings(): Promise<VoiceSettings> {
    if (this.settingsCache) return this.settingsCache
    const raw = await this.storage.get(SETTINGS_KEY)
    let parsed: unknown = null
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    this.settingsCache = normalizeVoiceSettings(parsed, this.catalog)
    return this.settingsCache
  }

  async cancel(jobId: string): Promise<void> {
    const controller = this.controllers.get(jobId)
    if (!controller) return
    controller.abort(new Error('cancelled by user'))
    this.controllers.delete(jobId)
  }

  async getSettings(): Promise<VoiceSettingsView> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    return withVoiceKeyStatus(settings, status)
  }

  async updateSettings(patch: unknown): Promise<VoiceSettingsView> {
    const current = await this.loadSettings()
    const next = applyVoiceSettingsPatch(current, patch, this.catalog)
    this.settingsCache = next
    await this.storage.set(SETTINGS_KEY, JSON.stringify(next))
    const status = await this.secrets.status()
    void this.cache.cleanup(next.cacheLimitMB * BYTES_PER_MB).catch(() => undefined)
    return withVoiceKeyStatus(next, status)
  }

  async setKey(kind: VoiceKeyKind, value: string): Promise<VoiceSettingsView> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    await this.secrets.set(kind, value)
    return this.getSettings()
  }

  async clearKey(kind: VoiceKeyKind): Promise<VoiceSettingsView> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    await this.secrets.clear(kind)
    return this.getSettings()
  }

  async test(kind: VoiceKeyKind): Promise<VoiceTestResult> {
    if (kind === 'clone') {
      const key = await this.secrets.get('clone')
      if (!key) {
        throw new VoiceError(VOICE_ERROR_CODES.KEY_REQUIRED, '请先保存语音服务 Key')
      }
      const result = await this.cloneProvider.testAuth(VOICE_ENDPOINTS.cloneStatus, key)
      return { kind, ok: true, message: result.message }
    }
    const settings = await this.loadSettings()
    // 「测试 TTS」始终用预设音色，避免默认音色是克隆时误走克隆 Key。
    const presetSpeaker =
      this.catalog.voices.find((voice) => voice.isDefault)?.voiceType ||
      this.catalog.voices[0]?.voiceType ||
      settings.defaultSpeaker
    const audio = await this.speak({
      text: '你好，我是大肥鱼。',
      options: { speaker: presetSpeaker }
    })
    return { kind, ok: true, message: 'TTS 鉴权与合成正常', audio }
  }

  async speak(input: VoiceSpeakInput): Promise<VoiceSpeakResult> {
    return this.speakInternal(input, false)
  }

  /**
   * 仅供克隆向导在用户明确确认槽位费后调用。
   * 不暴露成普通 IPC，避免渲染端绕过首次合成闸门。
   */
  async speakForCloneActivation(input: VoiceSpeakInput): Promise<VoiceSpeakResult> {
    // 激活必须真实请求供应商（不能命中缓存），否则可能未转正就标记已启用。
    return this.speakInternal(input, true, true)
  }

  private async speakInternal(
    input: VoiceSpeakInput,
    bypassCloneGate: boolean,
    bypassCache = false
  ): Promise<VoiceSpeakResult> {
    const settings = await this.loadSettings()
    const split = splitVoiceText(input?.text)
    const requestedSpeaker =
      typeof input?.options?.speaker === 'string' && input.options.speaker.trim()
        ? input.options.speaker.trim()
        : settings.defaultSpeaker
    const route: VoiceRoute = isPresetVoice(requestedSpeaker) ? 'preset' : 'cloned'
    if (route === 'cloned' && !bypassCloneGate && this.cloneGate) {
      const gate = await this.cloneGate(requestedSpeaker)
      if (!gate.ok) {
        throw new VoiceError(
          VOICE_ERROR_CODES.CLONE_FAILED,
          gate.message ?? '该克隆音色尚未完成首次正式合成确认'
        )
      }
    }
    const keyKind: VoiceKeyKind = route === 'preset' ? 'tts' : 'clone'
    const key = await this.secrets.get(keyKind)
    if (!key) {
      throw new VoiceError(
        VOICE_ERROR_CODES.KEY_REQUIRED,
        route === 'preset'
          ? '请先配置 Agent Plan TTS Key'
          : '克隆音色需要语音服务 Key'
      )
    }
    const speedRatio = clampSpeed(input?.options?.speedRatio, settings.speedRatio)
    const emotion =
      typeof input?.options?.emotion === 'string'
        ? input.options.emotion.trim().slice(0, 64)
        : settings.emotion
    const format = split.segments.length > 1 ? 'pcm' : 'mp3'
    const endpoint = route === 'preset' ? settings.ttsEndpoint : settings.cloneEndpoint
    const resourceId =
      route === 'preset' ? settings.ttsResourceId : settings.cloneResourceId
    const hash = voiceCacheKey([
      'voice-v1',
      route,
      endpoint,
      resourceId,
      requestedSpeaker,
      split.text,
      emotion,
      speedRatio,
      format,
      settings.sampleRate
    ])
    const audioId = voiceAudioId(hash, format === 'pcm' ? 'wav' : 'mp3')
    const cached = bypassCache ? null : await this.cache.get(audioId)
    if (cached) {
      return {
        audioId,
        chars: split.chars,
        cached: true,
        route,
        mime: cached.mime,
        usage: null
      }
    }

    const existing = bypassCache ? undefined : this.inflight.get(hash)
    if (existing) return existing

    const controller = input.jobId ? new AbortController() : null
    if (controller && input.jobId) this.controllers.set(input.jobId, controller)

    const task = this.generate({
      key,
      endpoint,
      resourceId,
      speaker: requestedSpeaker,
      text: split.text,
      segments: split.segments,
      chars: split.chars,
      speedRatio,
      emotion,
      format,
      sampleRate: settings.sampleRate,
      route,
      hash,
      jobId: input.jobId,
      signal: controller?.signal,
      dailyCharLimit: settings.dailyCharLimit,
      cacheLimitBytes: settings.cacheLimitMB * BYTES_PER_MB
    }).finally(() => {
      this.inflight.delete(hash)
      if (input.jobId) this.controllers.delete(input.jobId)
    })
    this.inflight.set(hash, task)
    return task
  }

  private async generate(input: {
    key: string
    endpoint: string
    resourceId: string
    speaker: string
    text: string
    segments: string[]
    chars: number
    speedRatio: number
    emotion: string
    format: 'mp3' | 'pcm'
    sampleRate: number
    route: VoiceRoute
    hash: string
    jobId?: string
    signal?: AbortSignal
    dailyCharLimit: number
    cacheLimitBytes: number
  }): Promise<VoiceSpeakResult> {
    await this.budget.check(input.dailyCharLimit, input.chars)
    try {
      const chunks: Buffer[] = []
      let usage: Record<string, unknown> | null = null
      for (let index = 0; index < input.segments.length; index += 1) {
        const segment = input.segments[index]
        this.onProgress({ jobId: input.jobId ?? '', index: index + 1, total: input.segments.length })
        const result = await this.ttsProvider.synthesize({
          endpoint: input.endpoint,
          apiKey: input.key,
          resourceId: input.resourceId,
          text: segment,
          speaker: input.speaker,
          speedRatio: input.speedRatio,
          emotion: input.emotion,
          format: input.format,
          sampleRate: input.sampleRate,
          signal: input.signal,
          returnUsage: input.route === 'preset'
        })
        chunks.push(result.audio)
        usage = mergeUsage(usage, result.usage)
        if (result.logId) this.logger(`[voice] provider logid=${result.logId}`)
      }
      const raw = Buffer.concat(chunks)
      const audio = input.format === 'pcm' ? wrapPcmAsWav(raw, input.sampleRate) : raw
      const extension = input.format === 'pcm' ? 'wav' : 'mp3'
      const saved = await this.cache.put(input.hash, extension, audio)
      await this.budget.recordSuccess(input.chars, usage)
      void this.cache.cleanup(input.cacheLimitBytes).catch(() => undefined)
      return {
        audioId: saved.audioId,
        chars: input.chars,
        cached: false,
        route: input.route,
        mime: saved.mime,
        usage
      }
    } catch (error) {
      await this.budget.recordFailure().catch(() => undefined)
      throw error
    }
  }

  async readAudio(audioId: string): Promise<VoiceAudioPayload> {
    const audio = await this.cache.read(audioId)
    if (!audio) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '语音缓存不存在或已被清理')
    }
    return audio
  }

  async getBudget(date?: string): Promise<VoiceUsageDay> {
    return this.budget.get(date)
  }

  async clearCache(): Promise<{ freedBytes: number }> {
    return { freedBytes: await this.cache.clear() }
  }
}

export function createVoiceManager(options: VoiceManagerOptions): VoiceManager {
  return new VoiceManager(options)
}
