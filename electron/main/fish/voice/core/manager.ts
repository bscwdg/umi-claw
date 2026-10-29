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
import { VOICE_RESOURCES } from './settings'
import { buildOpenClawTtsBlock, buildOpenClawTtsEnv } from './openclawTts'

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
  /** 设置/密钥变更后回调（主进程用它把 tts 块同步进 openclaw.json）。 */
  onSettingsChanged?: () => void
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
  /**
   * 同步快照：openclaw.json 的注入器是**同步**回调（配置写入路径不能 await），
   * 而设置与密钥读取是异步的。这里缓存一份，作为注入时的唯一同步数据源；
   * 每次 loadSettings / updateSettings / setKey / clearKey 后刷新。
   */
  private openClawTtsSnapshot: {
    settings: VoiceSettings
    hasTtsKey: boolean
    hasCloneKey: boolean
  } | null = null
  private readonly onSettingsChanged: () => void
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
    this.onSettingsChanged = options.onSettingsChanged ?? (() => undefined)
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
    await this.refreshOpenClawTtsSnapshot(this.settingsCache)
    return this.settingsCache
  }

  async cancel(jobId: string): Promise<void> {
    const controller = this.controllers.get(jobId)
    if (!controller) return
    controller.abort(new Error('cancelled by user'))
    this.controllers.delete(jobId)
  }

  /** 刷新同步快照（设置与 tts Key 状态）。 */
  /**
   * 刷新同步快照。
   *
   * `notify` 只在**真正改配置**时传 true：读设置（getSettings）也会走到这里，
   * 若每次都通知，页面每刷新一次就白跑一遍 openclaw 配置 CLI（实测可达数秒）。
   */
  private async refreshOpenClawTtsSnapshot(
    settings: VoiceSettings,
    notify = false
  ): Promise<void> {
    let hasTtsKey = false
    let hasCloneKey = false
    try {
      hasTtsKey = (await this.secrets.get('tts')) !== null
      hasCloneKey = (await this.secrets.get('clone')) !== null
    } catch {
      hasTtsKey = false
    }
    const previous = this.openClawTtsSnapshot
    this.openClawTtsSnapshot = { settings, hasTtsKey, hasCloneKey }
    if (!notify) return
    // 内容没变就不必惊动配置写入（重复 sync 会拖慢且可能撞上 CLI 争用）。
    if (previous && JSON.stringify(previous) === JSON.stringify(this.openClawTtsSnapshot)) {
      return
    }
    try {
      this.onSettingsChanged()
    } catch {
      // 回调失败不影响语音本身
    }
  }

  /**
   * 供 configManager 在写 openclaw.json 时**同步**取 tts 块。
   * 返回 null 表示「不要在配置里留 tts 段」（关闭或没密钥时整体下线）。
   * 注意：不含 apiKey —— 密钥只走网关启动时的环境变量。
   */
  /**
   * 按音色类型给出**正确的** resource。
   *
   * 预设音色合成用 seed-tts-*，克隆音色用 seed-icl-*。两者的 Key 产品线也不同：
   * 若把克隆 speaker 配着 seed-tts 的 resource 交给 OpenClaw，供应商侧会直接报错
   * （音色 ID 与资源不匹配）。所以这里不能一律用 ttsResourceId。
   */
  private resolveResourceFor(speaker: string): string {
    return isPresetVoice(speaker) ? this.catalogResource.preset : this.catalogResource.cloned
  }

  private get catalogResource(): { preset: string; cloned: string } {
    const settings = this.openClawTtsSnapshot?.settings
    return {
      preset: settings?.ttsResourceId ?? VOICE_RESOURCES.preset,
      cloned: settings?.cloneResourceId ?? VOICE_RESOURCES.cloned
    }
  }

  buildOpenClawTtsConfigSync(): Record<string, unknown> | null | undefined {
    const snap = this.openClawTtsSnapshot
    // 快照还没加载：状态未知，调用方必须原样不动（不能当成「关闭」去删配置）。
    if (!snap) return undefined
    if (snap.settings.conversationTts === 'off') return null
    // 预设音色要 TTS Key，克隆音色要语音服务 Key——两条产品线，不能互相顶替。
    const speaker = snap.settings.defaultSpeaker
    const hasKey = isPresetVoice(speaker) ? snap.hasTtsKey : snap.hasCloneKey
    if (!hasKey) return null
    return buildOpenClawTtsBlock({
      conversationTts: snap.settings.conversationTts,
      resourceId: this.resolveResourceFor(snap.settings.defaultSpeaker),
      speakerVoice: snap.settings.defaultSpeaker
    }) as unknown as Record<string, unknown>
  }

  /** 供网关启动时注入的 TTS 环境变量（密钥只在这里出现）。 */
  async buildOpenClawTtsEnv(): Promise<Record<string, string>> {
    // 单一实现在 openclawTts.ts；这里只管取当前设置与密钥。
    const settings = await this.loadSettings()
    const speaker = settings.defaultSpeaker
    const preset = isPresetVoice(speaker)
    // 预设走 Agent Plan Key，克隆走语音服务 Key：两者不是同一把，不能混用。
    const key = await this.secrets.get(preset ? 'tts' : 'clone')
    await this.refreshOpenClawTtsSnapshot(settings)
    return buildOpenClawTtsEnv(
      {
        conversationTts: settings.conversationTts,
        resourceId: this.resolveResourceFor(speaker),
        speakerVoice: speaker
      },
      key
    )
  }

  async getSettings(): Promise<VoiceSettingsView> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    await this.refreshOpenClawTtsSnapshot(settings)
    return withVoiceKeyStatus(settings, status)
  }

  async updateSettings(patch: unknown): Promise<VoiceSettingsView> {
    const current = await this.loadSettings()
    const next = applyVoiceSettingsPatch(current, patch, this.catalog)
    this.settingsCache = next
    await this.storage.set(SETTINGS_KEY, JSON.stringify(next))
    await this.refreshOpenClawTtsSnapshot(next, true)
    const status = await this.secrets.status()
    void this.cache.cleanup(next.cacheLimitMB * BYTES_PER_MB).catch(() => undefined)
    return withVoiceKeyStatus(next, status)
  }

  async setKey(kind: VoiceKeyKind, value: string): Promise<VoiceSettingsView> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    await this.secrets.set(kind, value)
    await this.refreshOpenClawTtsSnapshot(await this.loadSettings(), true)
    return this.getSettings()
  }

  async clearKey(kind: VoiceKeyKind): Promise<VoiceSettingsView> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    await this.secrets.clear(kind)
    await this.refreshOpenClawTtsSnapshot(await this.loadSettings(), true)
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
          route: input.route,
          // 复刻音色走官方 model 枚举（standard / expressive）；预设音色不传。
          cloneModel: this.settingsCache?.cloneModel,
          speedRatio: input.speedRatio,
          // 情绪（语音指令）只对豆包语音合成 2.0 音色（=预设音色）有效。
          // 官方限制：1) 仅当 speaker 为 2.0 音色时才支持语音指令；
          // 2) 克隆音色一旦指定 model 就不支持 context_texts。
          // 所以克隆路由一律不下发，避免发一个必然被忽略的参数。
          emotion: input.route === 'preset' ? input.emotion : '',
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
