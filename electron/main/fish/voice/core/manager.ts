import { randomUUID } from 'crypto'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { VOICE_ERROR_CODES, VoiceError } from './errors'
import { wrapPcmAsWav } from './audio'
import { VoiceAudioCache, voiceCacheKey, voiceAudioId } from './cache'
import { VoiceBudget } from './budget'
import {
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
  VoiceSettings,
  VoiceSettingsView,
  VoiceSpeakInput,
  VoiceSpeakResult,
  VoiceTestResult,
  VoiceUsageDay,
  OpenClawTtsChannel,
  VoiceOpenClawStatus,
  VoiceOpenClawTestResult
} from './types'
import type { VoiceSecretStore } from '../secretStore'
import { VolcengineCloneProvider } from '../providers/volcengineClone'
import { getVoiceCatalog, isPresetVoice } from '../providers/volcengineCatalog'
import { VolcengineTtsProvider } from '../providers/volcengineTts'
import { VOICE_RESOURCES } from './settings'
import { buildOpenClawTtsBlock, buildOpenClawTtsEnv } from './openclawTts'
import { resolveSpeakEngine } from './route'
import type { ExternalServiceStore } from '../external/externalServiceStore'
import { isExternalServiceId } from '../external/externalServiceStore'
import type { ExternalVoiceSecretStore } from '../external/localSecretStore'
import {
  ExternalAvailabilityTracker,
  createExternalAvailabilityTracker
} from '../external/availability'
import {
  createOpenAISpeechProvider,
  normalizeExternalBaseUrl,
  normalizeProfilesPath
} from '../external/openaiSpeech'
import type {
  ExternalTtsDraftProbeInput,
  ExternalTtsProfilesQueryInput,
  ExternalTtsProfilesResult,
  ExternalTtsProbeResult,
  ExternalTtsService,
  ExternalTtsServiceInput,
  ExternalTtsServiceView,
  ExternalTtsTestResult
} from '../external/types'

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
  /** bridge 模式下 volc-tts.mjs 的绝对路径。 */
  bridgeScriptPath?: string
  /** bridge 模式的热更设置文件（音色/资源 ID 写这里，bridge 每次合成时读）。 */
  bridgeSettingsPath?: string
  /** 本地 TTS 实例与独立密钥；缺省时仅保留火山云能力。 */
  externalServices?: ExternalServiceStore
  externalSecrets?: ExternalVoiceSecretStore
  externalAvailability?: ExternalAvailabilityTracker
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

function isExternalServiceFailure(error: unknown): error is VoiceError {
  if (!(error instanceof VoiceError)) return false
  return (
    error.code === VOICE_ERROR_CODES.PROVIDER_ERROR ||
    error.code === VOICE_ERROR_CODES.AUTH_ERROR ||
    error.code === VOICE_ERROR_CODES.RATE_LIMITED ||
    error.code === VOICE_ERROR_CODES.TIMEOUT ||
    error.code === VOICE_ERROR_CODES.EXTERNAL_UNREACHABLE ||
    error.code === VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE
  )
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
  private readonly bridgeScriptPath: string | undefined
  private readonly bridgeSettingsPath: string | undefined
  private readonly externalServices: ExternalServiceStore | undefined
  private readonly externalSecrets: ExternalVoiceSecretStore | undefined
  private readonly externalAvailability: ExternalAvailabilityTracker
  private readonly fetchImpl: FetchLike
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
    this.fetchImpl = fetchImpl
    this.ttsProvider = new VolcengineTtsProvider(fetchImpl)
    this.cloneProvider = new VolcengineCloneProvider(fetchImpl)
    this.logger = options.logger ?? ((message) => console.log(message))
    this.onProgress = options.onProgress ?? (() => undefined)
    this.onSettingsChanged = options.onSettingsChanged ?? (() => undefined)
    this.bridgeScriptPath = options.bridgeScriptPath
    this.bridgeSettingsPath = options.bridgeSettingsPath
    this.externalServices = options.externalServices
    this.externalSecrets = options.externalSecrets
    this.externalAvailability =
      options.externalAvailability ?? createExternalAvailabilityTracker(this.now)
  }

  getCatalog(): VoiceCatalogFile {
    return JSON.parse(JSON.stringify(this.catalog)) as VoiceCatalogFile
  }

  private async externalServiceView(
    service: ExternalTtsService
  ): Promise<ExternalTtsServiceView> {
    const key = this.externalSecrets ? await this.externalSecrets.status(service.id) : {
      hasKey: false,
      tail: null
    }
    const availability = this.externalAvailability.snapshot(service.id)
    return {
      ...service,
      hasKey: key.hasKey,
      keyTail: key.tail,
      available: availability.available,
      cooldownUntil: availability.cooldownUntil
    }
  }

  private async requireExternalService(id: string): Promise<ExternalTtsService> {
    if (!this.externalServices) {
      throw new VoiceError(VOICE_ERROR_CODES.UNSUPPORTED, '当前构建未启用本地 TTS')
    }
    const service = await this.externalServices.get(id)
    if (!service) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '本地 TTS 实例不存在')
    }
    return service
  }

  private externalProvider(service: ExternalTtsService, key: string | null) {
    return createOpenAISpeechProvider(service, key, this.fetchImpl)
  }

  async listExternalServices(): Promise<ExternalTtsServiceView[]> {
    if (!this.externalServices) return []
    const services = await this.externalServices.list()
    return Promise.all(services.map((service) => this.externalServiceView(service)))
  }

  async saveExternalService(input: ExternalTtsServiceInput): Promise<ExternalTtsServiceView> {
    if (!this.externalServices) {
      throw new VoiceError(VOICE_ERROR_CODES.UNSUPPORTED, '当前构建未启用本地 TTS')
    }
    const previous = input?.id ? await this.externalServices.get(input.id) : null
    const newKey = typeof input?.apiKey === 'string' && input.apiKey.trim()
    if (newKey && !this.externalSecrets) {
      throw new VoiceError(VOICE_ERROR_CODES.UNSUPPORTED, '当前构建未启用本地 TTS 密钥存储')
    }
    if (newKey && !this.externalSecrets?.canPersist()) {
      throw new VoiceError(
        VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
        '系统安全存储不可用，本地 TTS Key 无法持久化'
      )
    }
    const service = await this.externalServices.save(input ?? {})
    try {
      const addressChanged = !!previous && previous.baseUrl !== service.baseUrl
      if (input?.clearKey === true || (addressChanged && !newKey)) {
        // 地址变了还沿用旧 Key，会把旧凭据发往新主机；宁可让用户重新填写。
        await this.externalSecrets?.delete(service.id)
      } else if (newKey) {
        await this.externalSecrets?.set(service.id, input.apiKey)
      }
      // 改地址或改 Key 后通常是“修好服务再来试”，不能继续被旧冷却挡住。
      this.externalAvailability.recordSuccess(service.id)
    } catch (error) {
      let rollbackError: unknown = null
      if (previous) {
        rollbackError = await this.externalServices
          .save(previous)
          .then(() => null)
          .catch((e) => e)
      } else {
        rollbackError = await this.externalServices
          .remove(service.id)
          .then(() => null)
          .catch((e) => e)
      }
      if (rollbackError) {
        this.logger(
          `[voice] 本地 TTS 实例回滚失败（可能需要重开页面核对）: ${
            rollbackError instanceof Error ? rollbackError.message : rollbackError
          }`
        )
      }
      throw error
    }
    return this.externalServiceView(service)
  }

  async removeExternalService(id: string): Promise<{ removed: true }> {
    if (!this.externalServices) {
      throw new VoiceError(VOICE_ERROR_CODES.UNSUPPORTED, '当前构建未启用本地 TTS')
    }
    const service = await this.externalServices.get(id)
    if (!service) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '本地 TTS 实例不存在')
    }
    // 先删 Key 再删实例：Key 删除失败时保留实例，避免用户看到“删除失败”但实例已消失。
    const oldKey = this.externalSecrets ? await this.externalSecrets.get(id) : null
    if (this.externalSecrets) await this.externalSecrets.delete(id)
    const removed = await this.externalServices.remove(id).catch(async (error) => {
      if (this.externalSecrets && oldKey) {
        await this.externalSecrets.set(id, oldKey).catch(() => undefined)
      }
      throw error
    })
    if (!removed) {
      if (this.externalSecrets && oldKey) {
        await this.externalSecrets.set(id, oldKey).catch(() => undefined)
      }
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '本地 TTS 实例不存在')
    }
    this.externalAvailability.recordSuccess(id)
    const settings = await this.loadSettings()
    if (settings.externalProviderId === id) {
      const next = applyVoiceSettingsPatch(
        settings,
        { speakRoute: 'cloud', externalProviderId: '' },
        this.catalog
      )
      this.settingsCache = next
      await this.storage.set(SETTINGS_KEY, JSON.stringify(next))
      await this.refreshOpenClawTtsSnapshot(next)
    }
    return { removed: true }
  }

  async probeExternalService(id: string): Promise<ExternalTtsProbeResult> {
    const service = await this.requireExternalService(id)
    const key = this.externalSecrets ? await this.externalSecrets.get(id) : null
    return this.externalProvider(service, key).probe()
  }

  /**
   * 设置页「测试连接」：用表单草稿直接探活，不保存实例、不写 Key。
   * 这样用户不必先猜对「必填项」才能确认地址/Key 是否可达。
   */
  async probeExternalDraft(input: ExternalTtsDraftProbeInput): Promise<ExternalTtsProbeResult> {
    const baseUrl = normalizeExternalBaseUrl(input?.baseUrl)
    let key =
      typeof input?.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : null
    if (key && key.length > 2048) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, 'API Key 过长（上限 2048 字符）')
    }
    // 编辑已有实例时若 Key 留空，允许复用该实例已存的 Key；
    // 但地址变了就不复用（不能把旧主机的凭据发到新主机）。
    if (!key && isExternalServiceId(input?.id) && this.externalSecrets) {
      const existing = await this.externalServices?.get(input.id)
      if (existing && existing.baseUrl === baseUrl) {
        key = await this.externalSecrets.get(input.id)
      }
    }
    const draft: ExternalTtsService = {
      id: 'ext:00000000-0000-4000-8000-000000000000',
      kind: 'openai-speech',
      label: 'draft',
      baseUrl,
      model: '',
      voice: '',
      responseFormat: 'mp3',
      createdAt: 0,
      updatedAt: 0
    }
    return this.externalProvider(draft, key).probe()
  }

  /**
   * 设置页「查询音色」：用表单草稿直接查询，不保存实例、不写 Key。
   * 查询地址留空走默认 {根}/profiles；跨主机查询由适配器剥离 Key，避免凭据外发。
   */
  async queryExternalProfiles(
    input: ExternalTtsProfilesQueryInput
  ): Promise<ExternalTtsProfilesResult> {
    const baseUrl = normalizeExternalBaseUrl(input?.baseUrl)
    const profilesPath = normalizeProfilesPath(input?.profilesPath) || undefined
    let key =
      typeof input?.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : null
    if (key && key.length > 2048) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, 'API Key 过长（上限 2048 字符）')
    }
    // 与草稿探活同一把尺子：编辑已有实例且地址未变时复用已存 Key，地址变了绝不外发旧凭据。
    if (!key && isExternalServiceId(input?.id) && this.externalSecrets) {
      const existing = await this.externalServices?.get(input.id)
      if (existing && existing.baseUrl === baseUrl) {
        key = await this.externalSecrets.get(input.id)
      }
    }
    const draft: ExternalTtsService = {
      id: 'ext:00000000-0000-4000-8000-000000000000',
      kind: 'openai-speech',
      label: 'draft',
      baseUrl,
      model: '',
      voice: '',
      responseFormat: 'mp3',
      ...(profilesPath ? { profilesPath } : {}),
      createdAt: 0,
      updatedAt: 0
    }
    return this.externalProvider(draft, key).listProfiles(profilesPath)
  }

  async testExternalService(id: string): Promise<ExternalTtsTestResult> {
    // 试听必须真实打一次本地服务；命中旧缓存无法判断当前服务是否可用。
    this.externalAvailability.recordSuccess(id)
    const audio = await this.speakInternal(
      {
        text: '你好，我是大肥鱼。',
        options: { engine: 'external', providerId: id }
      },
      false,
      true
    )
    return { ok: true, message: '本地 TTS 合成正常', audio }
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
    // 只有真正会走 bridge 的配置才需要热更文件；其它情况清掉，避免留下误导性的陈旧音色
    const hotResolved = this.resolveConversationChannel({ settings, hasTtsKey, hasCloneKey })
    if (hotResolved.channel === 'bridge') {
      void this.writeBridgeSettingsFile(settings)
    } else {
      void this.clearBridgeSettingsFile()
    }
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
   * 写「bridge 热更设置」文件：音色 / 资源 ID 每次合成时由 volc-tts.mjs 重新读取，
   * 因此改音色无需重启网关（密钥仍只走网关进程环境变量；Key 变更仍需重启）。
   * 失败只记日志，不影响语音本身（bridge 会回退到环境变量）。
   */
  private async writeBridgeSettingsFile(settings: VoiceSettings): Promise<void> {
    const target = this.bridgeSettingsPath
    if (!target) return
    const tmp = `${target}.tmp-${process.pid}`
    try {
      const payload = {
        version: 1,
        speaker: settings.defaultSpeaker,
        resourceId: this.resolveResourceFor(settings.defaultSpeaker),
        updatedAt: new Date(this.now()).toISOString()
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
      await rename(tmp, target)
    } catch (e) {
      this.logger(`[voice] 写 bridge 热更设置失败（回退环境变量）: ${(e as Error)?.message || e}`)
    } finally {
      // rename 成功时 tmp 已不存在；失败/并发时清掉，避免长期留垃圾
      try {
        await unlink(tmp)
      } catch {
        /* 已不存在即预期 */
      }
    }
  }

  /** 当前不走 bridge：清掉热更文件，避免 volc-tts.mjs 读到过期音色 */
  private async clearBridgeSettingsFile(): Promise<void> {
    const target = this.bridgeSettingsPath
    if (!target) return
    try {
      await unlink(target)
    } catch {
      /* 不存在即预期 */
    }
  }
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

  private resolveConversationChannel(snap: {
    settings: VoiceSettings
    hasTtsKey: boolean
    hasCloneKey: boolean
  }): { channel: OpenClawTtsChannel | null; reason: string } {
    const settings = snap.settings
    if (settings.conversationTts === 'off') {
      return { channel: null, reason: '对话内语音已关闭' }
    }
    const preset = isPresetVoice(settings.defaultSpeaker)
    const setting = settings.conversationChannel

    if (setting === 'bridge') {
      if (!preset) return { channel: null, reason: '克隆音色只能走标准接口，不能走本地桥接' }
      if (!snap.hasTtsKey) return { channel: null, reason: '未配置 Agent Plan TTS Key' }
      if (!this.bridgeScriptPath) return { channel: null, reason: '内置桥接脚本路径缺失' }
      return { channel: 'bridge', reason: '本地桥接（Agent Plan Key → Plan 接口）' }
    }

    if (setting === 'volcengine') {
      if (!snap.hasCloneKey) return { channel: null, reason: '未配置语音控制台 Key' }
      return { channel: 'volcengine', reason: 'OpenClaw 标准接口（语音控制台 Key）' }
    }

    // auto：有语音控制台 Key 时优先官方标准接口；否则预设音色才允许走 bridge。
    if (snap.hasCloneKey) {
      return { channel: 'volcengine', reason: '自动选择：标准接口（已配置语音控制台 Key）' }
    }
    if (preset && snap.hasTtsKey && this.bridgeScriptPath) {
      return { channel: 'bridge', reason: '自动选择：本地桥接（仅有 Agent Plan Key）' }
    }
    return { channel: null, reason: '没有可用 Key：需要 Agent Plan Key 或语音控制台 Key' }
  }

  /**
   * 供 configManager 在写 openclaw.json 时**同步**取 tts 块。
   * 返回 null 表示「不要在配置里留 tts 段」（关闭或没密钥时整体下线）。
   * 注意：不含 apiKey —— 密钥只走网关启动时的环境变量。
   */
  buildOpenClawTtsConfigSync(): Record<string, unknown> | null | undefined {
    const snap = this.openClawTtsSnapshot
    // 快照还没加载：状态未知，调用方必须原样不动（不能当成「关闭」去删配置）。
    if (!snap) return undefined
    const resolved = this.resolveConversationChannel(snap)
    if (!resolved.channel) return null
    try {
      return buildOpenClawTtsBlock({
        conversationTts: snap.settings.conversationTts,
        channel: resolved.channel,
        resourceId: this.resolveResourceFor(snap.settings.defaultSpeaker),
        speakerVoice: snap.settings.defaultSpeaker,
        bridgeScriptPath: this.bridgeScriptPath
      }) as unknown as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** 供网关启动时注入的 TTS 环境变量（密钥只在这里出现）。 */
  async buildOpenClawTtsEnv(): Promise<Record<string, string>> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    const resolved = this.resolveConversationChannel({
      settings,
      hasTtsKey: status.tts.hasKey,
      hasCloneKey: status.clone.hasKey
    })
    // 网关启动前确保热更文件存在且是最新音色（仅 bridge 需要；其它情况清掉，避免读到过期音色）
    if (resolved.channel === 'bridge') {
      await this.writeBridgeSettingsFile(settings)
    } else {
      await this.clearBridgeSettingsFile()
    }
    if (!resolved.channel) return {}
    const key = await this.secrets.get(resolved.channel === 'bridge' ? 'tts' : 'clone')
    return buildOpenClawTtsEnv(
      {
        conversationTts: settings.conversationTts,
        channel: resolved.channel,
        resourceId: this.resolveResourceFor(settings.defaultSpeaker),
        speakerVoice: settings.defaultSpeaker,
        bridgeScriptPath: this.bridgeScriptPath,
        bridgeSettingsPath: this.bridgeSettingsPath
      },
      key
    )
  }

  async getOpenClawStatus(): Promise<VoiceOpenClawStatus> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    const resolved = this.resolveConversationChannel({
      settings,
      hasTtsKey: status.tts.hasKey,
      hasCloneKey: status.clone.hasKey
    })
    return {
      setting: settings.conversationChannel,
      effective: resolved.channel,
      reason: resolved.reason
    }
  }

  /**
   * 自检当前对话内语音通道：bridge 走一次真实 Plan 合成；volcengine 只做一次标准接口鉴权探测。
   * 不实际发消息，避免测试消息打扰用户。
   */
  async testOpenClawChannel(): Promise<VoiceOpenClawTestResult> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    const resolved = this.resolveConversationChannel({
      settings,
      hasTtsKey: status.tts.hasKey,
      hasCloneKey: status.clone.hasKey
    })
    if (!resolved.channel) {
      return { ok: false, channel: null, message: resolved.reason }
    }
    if (resolved.channel === 'bridge') {
      try {
        const audio = await this.speak({
          text: '你好，我是大肥鱼。',
          options: { speaker: settings.defaultSpeaker, engine: 'cloud' }
        })
        return {
          ok: true,
          channel: 'bridge',
          message: '本地桥接可用：Plan 接口合成成功',
          audio
        }
      } catch (error) {
        return {
          ok: false,
          channel: 'bridge',
          message: error instanceof Error ? error.message : '本地桥接合成失败'
        }
      }
    }
    const key = await this.secrets.get('clone')
    if (!key) {
      return { ok: false, channel: 'volcengine', message: '未配置语音控制台 Key' }
    }
    try {
      const response = await this.fetchImpl(settings.cloneEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': key,
          'X-Api-Resource-Id': this.resolveResourceFor(settings.defaultSpeaker),
          'X-Api-Request-Id': randomUUID()
        },
        body: JSON.stringify({
          req_params: {
            text: '你好',
            speaker: settings.defaultSpeaker,
            audio_params: { format: 'mp3', sample_rate: 24000 }
          }
        })
      })
      if (!response.ok) {
        return {
          ok: false,
          channel: 'volcengine',
          message: `标准接口鉴权失败：HTTP ${response.status}`
        }
      }
      return {
        ok: true,
        channel: 'volcengine',
        message: '标准接口鉴权通过：语音控制台 Key 可用'
      }
    } catch (error) {
      return {
        ok: false,
        channel: 'volcengine',
        message: error instanceof Error ? error.message : '标准接口探测失败'
      }
    }
  }

  async getSettings(): Promise<VoiceSettingsView> {
    const settings = await this.loadSettings()
    const status = await this.secrets.status()
    await this.refreshOpenClawTtsSnapshot(settings)
    return withVoiceKeyStatus(settings, status)
  }

  private async validateExternalSettings(settings: VoiceSettings): Promise<void> {
    if (settings.speakRoute === 'external' && !settings.externalProviderId) {
      throw new VoiceError(
        VOICE_ERROR_CODES.INVALID_INPUT,
        '本地 TTS 路由必须先选择一个本地实例'
      )
    }
    if (settings.externalProviderId) {
      if (!this.externalServices) {
        throw new VoiceError(VOICE_ERROR_CODES.UNSUPPORTED, '当前构建未启用本地 TTS')
      }
      const service = await this.externalServices.get(settings.externalProviderId)
      if (!service) {
        throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '选中的本地 TTS 实例不存在')
      }
    }
  }

  async updateSettings(patch: unknown): Promise<VoiceSettingsView> {
    const current = await this.loadSettings()
    const next = applyVoiceSettingsPatch(current, patch, this.catalog)
    await this.validateExternalSettings(next)
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
      // 与训练/查询走同一份配置：用户把「克隆状态查询接口」改到自定义值（如代理域名）时，
      // 测试必须打同一个地址，否则测试通过 ≠ 实际链路可用。
      const settings = await this.loadSettings()
      const result = await this.cloneProvider.testAuth(settings.cloneStatusEndpoint, key)
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
      options: { speaker: presetSpeaker, engine: 'cloud' }
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
    return this.speakInternal(input, true, true, true)
  }

  private async speakInternal(
    input: VoiceSpeakInput,
    bypassCloneGate: boolean,
    bypassCache = false,
    forceCloud = false
  ): Promise<VoiceSpeakResult> {
    const settings = await this.loadSettings()
    const split = splitVoiceText(input?.text)
    const rawRequestedEngine = forceCloud ? 'cloud' : input?.options?.engine
    if (
      rawRequestedEngine !== undefined &&
      rawRequestedEngine !== 'cloud' &&
      rawRequestedEngine !== 'external' &&
      rawRequestedEngine !== 'auto'
    ) {
      throw new VoiceError(
        VOICE_ERROR_CODES.INVALID_INPUT,
        '单次朗读路由只支持 cloud、external 或 auto'
      )
    }
    const requestedEngine = rawRequestedEngine
    const providerId =
      typeof input?.options?.providerId === 'string' && input.options.providerId.trim()
        ? input.options.providerId.trim()
        : settings.externalProviderId
    if (
      input?.options?.providerId !== undefined &&
      input.options.providerId !== '' &&
      !isExternalServiceId(input.options.providerId)
    ) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '本地 TTS 实例 ID 不合法')
    }
    const speedRatio = clampSpeed(input?.options?.speedRatio, settings.speedRatio)
    const format =
      input?.options?.format === 'pcm' || input?.options?.format === 'mp3'
        ? input.options.format
        : split.segments.length > 1
          ? 'pcm'
          : 'mp3'
    const sampleRate =
      typeof input?.options?.sampleRate === 'number' && Number.isFinite(input.options.sampleRate)
        ? Math.max(8000, Math.min(48000, Math.round(input.options.sampleRate)))
        : settings.sampleRate
    const externalConfigured = providerId
      ? !!(this.externalServices && (await this.externalServices.get(providerId)))
      : false
    const externalAvailable = providerId
      ? this.externalAvailability.isAvailable(providerId)
      : false
    const engineResolution = resolveSpeakEngine({
      requested: requestedEngine,
      configured: settings.speakRoute,
      providerId,
      externalConfigured,
      externalAvailable
    })
    let fallbackReason = engineResolution.fallbackReason
    if (engineResolution.engine === 'external') {
      try {
        return await this.speakExternal({
          input,
          settings,
          text: split.text,
          chars: split.chars,
          providerId: engineResolution.providerId ?? providerId,
          speedRatio,
          format,
          sampleRate,
          bypassCache
        })
      } catch (error) {
        const mode = requestedEngine ?? settings.speakRoute
        if (mode !== 'auto' || !isExternalServiceFailure(error)) throw error
        fallbackReason = error.message
      }
    }
    const requestedSpeaker =
      typeof input?.options?.speaker === 'string' && input.options.speaker.trim()
        ? input.options.speaker.trim()
        : settings.defaultSpeaker
    const route: 'preset' | 'cloned' = isPresetVoice(requestedSpeaker) ? 'preset' : 'cloned'
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
    const emotion =
      typeof input?.options?.emotion === 'string'
        ? input.options.emotion.trim().slice(0, 64)
        : settings.emotion
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
      sampleRate
    ])
    const audioId = voiceAudioId(hash, format === 'pcm' ? 'wav' : 'mp3')
    const cached = bypassCache ? null : await this.cache.get(audioId)
    if (cached) {
      return {
        audioId,
        chars: split.chars,
        cached: true,
        route,
        engine: 'cloud',
        fallback: fallbackReason
          ? { reason: fallbackReason }
          : undefined,
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
      sampleRate,
      route,
      fallbackReason,
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

  private async speakExternal(input: {
    input: VoiceSpeakInput
    settings: VoiceSettings
    text: string
    chars: number
    providerId: string
    speedRatio: number
    format: 'mp3' | 'pcm'
    sampleRate: number
    bypassCache: boolean
  }): Promise<VoiceSpeakResult> {
    const service = await this.requireExternalService(input.providerId)
    const key = this.externalSecrets
      ? await this.externalSecrets.get(input.providerId)
      : null
    const requestedExtension = input.format === 'pcm' ? 'wav' : null
    const hash = voiceCacheKey([
      'external-v1',
      input.providerId,
      service.baseUrl,
      service.model,
      service.voice,
      input.text,
      input.speedRatio,
      input.format,
      input.sampleRate,
      requestedExtension ?? service.responseFormat
    ])
    if (!input.bypassCache) {
      const extensions = requestedExtension
        ? ([requestedExtension] as const)
        : (['mp3', 'wav'] as const)
      for (const extension of extensions) {
        const cached = await this.cache.get(voiceAudioId(hash, extension))
        if (cached) {
          return {
            audioId: cached.audioId,
            chars: input.chars,
            cached: true,
            route: 'external',
            engine: 'external',
            providerId: input.providerId,
            mime: cached.mime,
            usage: null
          }
        }
      }
    }

    const existing = input.bypassCache ? undefined : this.inflight.get(hash)
    if (existing) return existing

    const controller = input.input.jobId ? new AbortController() : null
    if (controller && input.input.jobId) {
      this.controllers.set(input.input.jobId, controller)
    }
    const provider = this.externalProvider(service, key)
    const task = (async (): Promise<VoiceSpeakResult> => {
      this.onProgress({
        jobId: input.input.jobId ?? '',
        index: 1,
        total: 1
      })
      try {
        const result = await provider.synthesize({
          text: input.text,
          voice: service.voice,
          speedRatio: input.speedRatio,
          responseFormat: requestedExtension ?? undefined,
          signal: controller?.signal
        })
        this.externalAvailability.recordSuccess(input.providerId)
        const saved = await this.cache.put(hash, result.extension, result.audio)
        void this.cache
          .cleanup(input.settings.cacheLimitMB * BYTES_PER_MB)
          .catch(() => undefined)
        return {
          audioId: saved.audioId,
          chars: input.chars,
          cached: false,
          route: 'external',
          engine: 'external',
          providerId: input.providerId,
          mime: saved.mime,
          usage: result.usage ?? null
        }
      } catch (error) {
        if (isExternalServiceFailure(error)) {
          this.externalAvailability.recordFailure(input.providerId)
        }
        throw error
      }
    })().finally(() => {
      this.inflight.delete(hash)
      if (input.input.jobId) this.controllers.delete(input.input.jobId)
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
    route: 'preset' | 'cloned'
    fallbackReason?: string
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
        engine: 'cloud',
        fallback: input.fallbackReason ? { reason: input.fallbackReason } : undefined,
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
