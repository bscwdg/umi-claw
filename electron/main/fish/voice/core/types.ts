export type VoiceKeyKind = 'tts' | 'clone'
export type VoiceRoute = 'preset' | 'cloned'
export type VoiceAutoSpeak = 'off' | 'tagged' | 'always'
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
  defaultSpeaker: string
  speedRatio: number
  emotion: string
  format: 'mp3'
  sampleRate: 24000
  autoSpeak: VoiceAutoSpeak
  dailyCharLimit: number
  cacheLimitMB: number
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
}

export interface VoiceSpeakInput {
  text: string
  options?: VoiceSpeakOptions
}

export interface VoiceSpeakResult {
  audioId: string
  chars: number
  cached: boolean
  route: VoiceRoute
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
}

export interface VoiceCloneActivateInput {
  speakerId: string
  confirmSlotFee: boolean
  text?: string
}
