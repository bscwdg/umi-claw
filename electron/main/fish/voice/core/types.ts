export type VoiceKeyKind = 'tts' | 'clone'
export type VoiceRoute = 'preset' | 'cloned' | 'external'
export type VoiceSpeakRoute = 'cloud' | 'external' | 'auto'
export type VoiceEngine = 'cloud' | 'external'
export type VoiceAutoSpeak = 'off' | 'tagged' | 'always'
/**
 * OpenClaw `tts.auto` 的取值。与应用内 autoSpeak 三态不同：多一个 `inbound`
 * （只在收到语音消息后才回语音）。
 */
export type OpenClawTtsAuto = 'off' | 'always' | 'inbound' | 'tagged'
/** 对话内语音的两条通道：本地桥接（Agent Plan）或 OpenClaw 标准 provider（语音控制台）。 */
export type OpenClawTtsChannel = 'bridge' | 'volcengine'
export type OpenClawTtsChannelSetting = 'auto' | OpenClawTtsChannel
export type VoiceAudioFormat = 'mp3' | 'pcm'

export interface VoiceCatalogVoice {
  order: number
  name: string
  voiceType: string
  scene: string
  gender: 'female' | 'male' | 'unknown'
  languageSummary: string
  capabilities: string[]
  isDefault: boolean
}

export interface VoiceCatalogFile {
  version: string
  updatedAt: string
  provider: string
  model: string
  endpoint: string
  source: {
    title: string
    url: string
  }
  selectionPolicy: string[]
  voices: VoiceCatalogVoice[]
}

export interface VoiceSettings {
  provider: 'volcengine'
  ttsEndpoint: string
  ttsResourceId: string
  cloneEndpoint: string
  cloneResourceId: string
  /** 克隆训练接口（voice_clone）。官方文档：只需 X-Api-Key，不带 Resource 头。 */
  cloneTrainEndpoint: string
  /** 克隆状态查询接口（get_voice）。同样只需 X-Api-Key。 */
  cloneStatusEndpoint: string
  defaultSpeaker: string
  speedRatio: number
  emotion: string
  format: 'mp3'
  sampleRate: 24000
  autoSpeak: VoiceAutoSpeak
  /** 应用内朗读路由：现有火山云 / 用户外部实例 / 自动回落。 */
  speakRoute: VoiceSpeakRoute
  /** speakRoute=external/auto 时选中的外部实例；为空表示没有配置。 */
  externalProviderId: string
  /**
   * 对话内语音（走 OpenClaw 的 tts 配置块与 /tts 命令族）。
   * 与 autoSpeak 相互独立：这个管「在对话里回语音」，那个管「弹提醒时读一句」。
   */
  conversationTts: OpenClawTtsAuto
  /** 对话内语音走哪条通道；auto 按 Key 与默认音色自动选。 */
  conversationChannel: OpenClawTtsChannelSetting
  dailyCharLimit: number
  cacheLimitMB: number
  /**
   * 复刻音色的 model（官方仅两个枚举）：
   *   seed-tts-2.0-standard   标准版
   *   seed-tts-2.0-expressive 表现力增强版（控制台里那个「表现力增强版」）
   * 仅克隆路由生效；预设音色不传 model。
   */
  cloneModel: 'seed-tts-2.0-standard' | 'seed-tts-2.0-expressive'
  cloneMode: 'postpaid' | 'prepaid'
  cloneSpeakerId: string
}

export interface VoiceKeyStatus {
  hasKey: boolean
  tail: string | null
}

export interface VoiceSettingsView extends VoiceSettings {
  hasTtsKey: boolean
  hasCloneKey: boolean
  ttsKeyTail: string | null
  cloneKeyTail: string | null
  encryptionAvailable: boolean
}

export interface VoiceSpeakOptions {
  speaker?: string
  speedRatio?: number
  emotion?: string
  /** 单次覆盖朗读路由；设置页测试/预览和内部自检用。 */
  engine?: VoiceSpeakRoute
  /** 单次覆盖外部实例 ID。 */
  providerId?: string
  /** 输出格式覆盖（角色语音条需要 pcm/16k）；缺省按单段 mp3、多段 pcm */
  format?: 'mp3' | 'pcm'
  sampleRate?: number
}

export interface VoiceSpeakInput {
  text: string
  options?: VoiceSpeakOptions
  /** 渲染端生成的任务 ID，用于取消；不传则不可取消。 */
  jobId?: string
}

export interface VoiceProgressEvent {
  jobId: string
  index: number
  total: number
}

export interface VoiceSpeakResult {
  audioId: string
  chars: number
  cached: boolean
  route: VoiceRoute
  engine: VoiceEngine
  providerId?: string
  fallback?: { reason: string }
  mime: string
  usage?: Record<string, unknown> | null
}

export interface VoiceAudioPayload {
  mime: string
  bytes: Uint8Array
}

export interface VoiceUsageDay {
  date: string
  chars: number
  requests: number
  failures: number
  usageTokens: number
}

export interface VoiceTestResult {
  kind: VoiceKeyKind
  ok: true
  audio?: VoiceSpeakResult
  message: string
}

export interface VoiceOpenClawStatus {
  setting: OpenClawTtsChannelSetting
  effective: OpenClawTtsChannel | null
  /** 人能看懂的一句话，说明为什么选中/未选中。 */
  reason: string
}

export interface VoiceOpenClawTestResult {
  ok: boolean
  channel: OpenClawTtsChannel | null
  message: string
  audio?: VoiceSpeakResult
}

export type VoiceCloneStatus = 'training' | 'success' | 'failed' | 'active' | 'not_found'

export interface VoiceCloneDemo {
  modelType: number
  fileName: string
  mime: string
  downloadedAt: number
}

export interface VoiceCloneRecord {
  speakerId: string
  displayName: string
  status: VoiceCloneStatus
  remoteStatus: number | null
  createdAt: number
  updatedAt: number
  consentAt: number
  sampleHash: string
  sampleFileName: string
  language: number
  modelTypes: number[]
  demos: VoiceCloneDemo[]
  activated: boolean
  activatedAt: number | null
  expiresAt: number | null
  availableTrainingTimes: number | null
  lastError: string | null
}

export interface VoiceCloneSample {
  token: string
  fileName: string
  sizeBytes: number
  format: string
}

export interface VoiceCloneValidation {
  token: string
  fileName: string
  sizeBytes: number
  format: string
  ok: boolean
  warnings: string[]
}

export interface VoiceCloneTrainInput {
  token: string
  consent: boolean
  displayName: string
  text?: string
  language?: number
  /** 试听文本（4–300 字）；必须与 language 同语种。缺省按语种取内置短句。 */
  demoText?: string
  /** 样本噪声较大时建议开启降噪。 */
  enableAudioDenoise?: boolean
  /** 关闭音量归一化：合成音量更贴近样本，相似度更高。 */
  disableVolumeNormalization?: boolean
}

export interface VoiceCloneActivateInput {
  speakerId: string
  confirmSlotFee: boolean
  text?: string
}

/** 对账结论：本地记录与远端实际状态的一致性判定。 */
export type VoiceReconcileVerdict =
  | 'remote-ok'        // 远端存在且状态与本地一致
  | 'remote-missing'   // 远端已不存在（被删 / 过期回收）
  | 'remote-failed'    // 远端训练失败
  | 'remote-changed'   // 远端状态比本地更新（需刷新）
  | 'unknown'

/** 单条音色的对账结果。 */
export interface VoiceReconcileItem {
  speakerId: string
  displayName: string
  localStatus: VoiceCloneStatus
  verdict: VoiceReconcileVerdict
  /** 远端返回的原始 status 码（0/1/2/3/4）；查询失败时为 null */
  remoteStatus: number | null
  /** 远端 speaker_status[] 里的 model_type 集合 */
  remoteModelTypes: number[]
  /** 本地已有、但远端新出现的 model_type（提示「远端有新试听」） */
  newModelTypes: number[]
  /** 远端 available_training_times */
  availableTrainingTimes: number | null
  /** 人能看懂的一句话结论 */
  message: string
}
