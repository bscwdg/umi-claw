import type {
  VoiceCatalogFile,
  VoiceKeyKind,
  VoiceSettings,
  VoiceSettingsView
} from './types'

export const VOICE_ENDPOINTS = {
  presetTts: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
  clonedTts: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  cloneTrain: 'https://openspeech.bytedance.com/api/v3/tts/voice_clone',
  cloneStatus: 'https://openspeech.bytedance.com/api/v3/tts/get_voice'
} as const

export const VOICE_RESOURCES = {
  preset: 'seed-tts-2.0',
  cloned: 'seed-icl-2.0'
} as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'volcengine',
  ttsEndpoint: VOICE_ENDPOINTS.presetTts,
  ttsResourceId: VOICE_RESOURCES.preset,
  cloneEndpoint: VOICE_ENDPOINTS.clonedTts,
  cloneResourceId: VOICE_RESOURCES.cloned,
  defaultSpeaker: 'zh_female_vv_uranus_bigtts',
  speedRatio: 1,
  emotion: '',
  format: 'mp3',
  sampleRate: 24000,
  autoSpeak: 'off',
  dailyCharLimit: 0,
  cacheLimitMB: 500,
  cloneMode: 'postpaid',
  cloneSpeakerId: ''
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function validCatalogSpeaker(catalog: VoiceCatalogFile, value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  // 允许已启用的克隆音色 ID（如 umi_voice_xxx）和预设音色；只做字符集/长度约束。
  if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id
  return catalog.voices.find((voice) => voice.isDefault)?.voiceType ||
    catalog.voices[0]?.voiceType ||
    DEFAULT_VOICE_SETTINGS.defaultSpeaker
}

export function normalizeVoiceSettings(
  raw: unknown,
  catalog: VoiceCatalogFile
): VoiceSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    provider: 'volcengine',
    ttsEndpoint: VOICE_ENDPOINTS.presetTts,
    ttsResourceId: VOICE_RESOURCES.preset,
    cloneEndpoint: VOICE_ENDPOINTS.clonedTts,
    cloneResourceId: VOICE_RESOURCES.cloned,
    defaultSpeaker: validCatalogSpeaker(catalog, src.defaultSpeaker),
    speedRatio: clampNumber(src.speedRatio, 0.2, 3, DEFAULT_VOICE_SETTINGS.speedRatio),
    emotion: typeof src.emotion === 'string' ? src.emotion.trim().slice(0, 64) : '',
    format: 'mp3',
    sampleRate: 24000,
    autoSpeak:
      src.autoSpeak === 'tagged' || src.autoSpeak === 'always' ? src.autoSpeak : 'off',
    dailyCharLimit: Math.floor(clampNumber(src.dailyCharLimit, 0, 10_000_000, 0)),
    cacheLimitMB: Math.floor(clampNumber(src.cacheLimitMB, 50, 5000, 500)),
    cloneMode: src.cloneMode === 'prepaid' ? 'prepaid' : 'postpaid',
    cloneSpeakerId:
      typeof src.cloneSpeakerId === 'string' ? src.cloneSpeakerId.trim().slice(0, 256) : ''
  }
}

export function applyVoiceSettingsPatch(
  current: VoiceSettings,
  patch: unknown,
  catalog: VoiceCatalogFile
): VoiceSettings {
  const src = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  const merged: VoiceSettings = {
    ...current,
    defaultSpeaker:
      src.defaultSpeaker === undefined
        ? current.defaultSpeaker
        : validCatalogSpeaker(catalog, src.defaultSpeaker),
    speedRatio:
      src.speedRatio === undefined
        ? current.speedRatio
        : clampNumber(src.speedRatio, 0.2, 3, current.speedRatio),
    emotion:
      src.emotion === undefined
        ? current.emotion
        : typeof src.emotion === 'string'
          ? src.emotion.trim().slice(0, 64)
          : '',
    autoSpeak:
      src.autoSpeak === undefined
        ? current.autoSpeak
        : src.autoSpeak === 'tagged' || src.autoSpeak === 'always'
          ? src.autoSpeak
          : 'off',
    dailyCharLimit:
      src.dailyCharLimit === undefined
        ? current.dailyCharLimit
        : Math.floor(clampNumber(src.dailyCharLimit, 0, 10_000_000, current.dailyCharLimit)),
    cacheLimitMB:
      src.cacheLimitMB === undefined
        ? current.cacheLimitMB
        : Math.floor(clampNumber(src.cacheLimitMB, 50, 5000, current.cacheLimitMB)),
    cloneMode:
      src.cloneMode === undefined
        ? current.cloneMode
        : src.cloneMode === 'prepaid'
          ? 'prepaid'
          : 'postpaid',
    cloneSpeakerId:
      src.cloneSpeakerId === undefined
        ? current.cloneSpeakerId
        : typeof src.cloneSpeakerId === 'string'
          ? src.cloneSpeakerId.trim().slice(0, 256)
          : ''
  }
  return normalizeVoiceSettings(merged, catalog)
}

export function withVoiceKeyStatus(
  settings: VoiceSettings,
  status: {
    encryptionAvailable: boolean
    tts: { hasKey: boolean; tail: string | null }
    clone: { hasKey: boolean; tail: string | null }
  }
): VoiceSettingsView {
  return {
    ...settings,
    hasTtsKey: status.tts.hasKey,
    hasCloneKey: status.clone.hasKey,
    ttsKeyTail: status.tts.tail,
    cloneKeyTail: status.clone.tail,
    encryptionAvailable: status.encryptionAvailable
  }
}

export function isVoiceKeyKind(value: unknown): value is VoiceKeyKind {
  return value === 'tts' || value === 'clone'
}
