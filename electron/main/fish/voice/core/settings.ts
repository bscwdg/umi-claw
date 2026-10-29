import { VOICE_ERROR_CODES, VoiceError } from './errors'
import { normalizeEmotion } from './emotionOptions'
import type {
  VoiceCatalogFile,
  VoiceKeyKind,
  VoiceSettings,
  VoiceSettingsView,
  OpenClawTtsAuto
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

/**
 * endpoint / resource 只放开到「火山 openSpeech 官方域名 + /api/v3/ 路径」这一层。
 * 这样用户升级模型只改 resource id，不必等发版；而 Key 无论如何都只会发往官方域名，
 * 避免「endpoint 自由可配 + 本地已存 Key」变成把 Key 外发到任意主机的通道。
 */
export const VOICE_ENDPOINT_HOST = 'https://openspeech.bytedance.com'
const VOICE_ENDPOINT_PATH_PREFIX = '/api/v3/'
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** UI 下拉建议值；不在此列表内的合法 resource id 仍可直接填写。 */
export const VOICE_RESOURCE_SUGGESTIONS = {
  preset: ['seed-tts-2.0'],
  cloned: ['seed-icl-2.0']
} as const

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'volcengine',
  ttsEndpoint: VOICE_ENDPOINTS.presetTts,
  ttsResourceId: VOICE_RESOURCES.preset,
  cloneEndpoint: VOICE_ENDPOINTS.clonedTts,
  cloneResourceId: VOICE_RESOURCES.cloned,
  cloneTrainEndpoint: VOICE_ENDPOINTS.cloneTrain,
  cloneStatusEndpoint: VOICE_ENDPOINTS.cloneStatus,
  defaultSpeaker: 'zh_female_vv_uranus_bigtts',
  speedRatio: 1,
  emotion: '',
  format: 'mp3',
  sampleRate: 24000,
  autoSpeak: 'off',
  conversationTts: 'off',
  dailyCharLimit: 0,
  cacheLimitMB: 500,
  cloneMode: 'postpaid',
  cloneModel: 'seed-tts-2.0-standard',
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

/**
 * 读取旧配置时的宽松清洗：非法值静默回落到默认，坏配置不该让整个语音页打不开。
 */
function sanitizeEndpoint(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return fallback
    if (url.origin !== VOICE_ENDPOINT_HOST) return fallback
    if (!url.pathname.startsWith(VOICE_ENDPOINT_PATH_PREFIX)) return fallback
    if (url.search || url.hash) return fallback
    return `${url.origin}${url.pathname}`
  } catch {
    return fallback
  }
}

function sanitizeResourceId(value: unknown, fallback: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return fallback
  return RESOURCE_ID_RE.test(id) ? id : fallback
}

/** 对话内语音开关：只接受 OpenClaw `tts.auto` 的四个官方取值，其余回落 off。 */
function normalizeOpenClawTtsAuto(value: unknown): OpenClawTtsAuto {
  return value === 'always' || value === 'inbound' || value === 'tagged' ? value : 'off'
}

/**
 * 用户显式提交时的严格校验：不合法直接报错，而不是悄悄存成默认值——
 * 否则用户以为改成功了，实际还在跑旧接口。
 */
function strictEndpoint(value: unknown, label: string): string {
  const sanitized = sanitizeEndpoint(value, '')
  if (sanitized) return sanitized
  throw new VoiceError(
    VOICE_ERROR_CODES.INVALID_INPUT,
    `${label}只支持火山官方域名 ${VOICE_ENDPOINT_HOST} 下的 /api/v3/ 接口`
  )
}

function strictResourceId(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (RESOURCE_ID_RE.test(id)) return id
  throw new VoiceError(
    VOICE_ERROR_CODES.INVALID_INPUT,
    `${label}格式不合法（1–64 位字母数字及 . _ -，字母数字开头）`
  )
}

/**
 * 用户显式提交情绪时的严格校验：非法值报错，而不是悄悄存成空值——
 * 否则用户以为设了情绪，实际一直在用音色默认情绪。空串表示「不指定」。
 */
/** 复刻音色 model 只接受官方两个枚举，其余回落标准版。 */
function normalizeCloneModel(value: unknown): VoiceSettings['cloneModel'] {
  return value === 'seed-tts-2.0-expressive'
    ? 'seed-tts-2.0-expressive'
    : 'seed-tts-2.0-standard'
}

function strictEmotion(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  const normalized = normalizeEmotion(raw)
  if (!normalized) {
    throw new VoiceError(
      VOICE_ERROR_CODES.INVALID_INPUT,
      `不支持的情绪值「${raw}」，请从下拉列表中选择`
    )
  }
  return normalized
}

export function normalizeVoiceSettings(
  raw: unknown,
  catalog: VoiceCatalogFile
): VoiceSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    provider: 'volcengine',
    ttsEndpoint: sanitizeEndpoint(src.ttsEndpoint, VOICE_ENDPOINTS.presetTts),
    ttsResourceId: sanitizeResourceId(src.ttsResourceId, VOICE_RESOURCES.preset),
    cloneEndpoint: sanitizeEndpoint(src.cloneEndpoint, VOICE_ENDPOINTS.clonedTts),
    cloneResourceId: sanitizeResourceId(src.cloneResourceId, VOICE_RESOURCES.cloned),
    cloneTrainEndpoint: sanitizeEndpoint(src.cloneTrainEndpoint, VOICE_ENDPOINTS.cloneTrain),
    cloneStatusEndpoint: sanitizeEndpoint(src.cloneStatusEndpoint, VOICE_ENDPOINTS.cloneStatus),
    defaultSpeaker: validCatalogSpeaker(catalog, src.defaultSpeaker),
    speedRatio: clampNumber(src.speedRatio, 0.2, 3, DEFAULT_VOICE_SETTINGS.speedRatio),
    // 只接受官方枚举值；历史自由文本一律回落为空（等于用音色默认情绪）。
    emotion: normalizeEmotion(src.emotion),
    format: 'mp3',
    sampleRate: 24000,
    autoSpeak:
      src.autoSpeak === 'tagged' || src.autoSpeak === 'always' ? src.autoSpeak : 'off',
    conversationTts: normalizeOpenClawTtsAuto(src.conversationTts),
    dailyCharLimit: Math.floor(clampNumber(src.dailyCharLimit, 0, 10_000_000, 0)),
    cacheLimitMB: Math.floor(clampNumber(src.cacheLimitMB, 50, 5000, 500)),
    cloneMode: src.cloneMode === 'prepaid' ? 'prepaid' : 'postpaid',
    cloneModel: normalizeCloneModel(src.cloneModel),
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
    ttsEndpoint:
      src.ttsEndpoint === undefined
        ? current.ttsEndpoint
        : strictEndpoint(src.ttsEndpoint, '预设 TTS 接口'),
    ttsResourceId:
      src.ttsResourceId === undefined
        ? current.ttsResourceId
        : strictResourceId(src.ttsResourceId, '预设 Resource'),
    cloneEndpoint:
      src.cloneEndpoint === undefined
        ? current.cloneEndpoint
        : strictEndpoint(src.cloneEndpoint, '克隆音色合成接口'),
    cloneResourceId:
      src.cloneResourceId === undefined
        ? current.cloneResourceId
        : strictResourceId(src.cloneResourceId, '克隆 Resource'),
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
        : strictEmotion(src.emotion),
    autoSpeak:
      src.autoSpeak === undefined
        ? current.autoSpeak
        : src.autoSpeak === 'tagged' || src.autoSpeak === 'always'
          ? src.autoSpeak
          : 'off',
    conversationTts:
      src.conversationTts === undefined
        ? current.conversationTts
        : normalizeOpenClawTtsAuto(src.conversationTts),
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
    cloneModel:
      src.cloneModel === undefined
        ? current.cloneModel
        : normalizeCloneModel(src.cloneModel),
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
