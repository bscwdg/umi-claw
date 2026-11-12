// electron/main/fish/voice/external/types.ts —— 本地 TTS 实例与协议类型
//
// 本地实例是用户自己部署或托管的兼容服务；本应用只保存连接信息和调用协议，
// 不安装、不启动、不守护对方进程。API Key 也不进这里的持久化结构。

import type { VoiceSpeakResult } from '../core/types'

export type ExternalTtsKind = 'openai-speech'
export type ExternalTtsFormat = 'mp3' | 'wav'
export type ExternalTtsVoiceType = 'preset' | 'cloned' | 'designed' | 'unknown'

export interface ExternalTtsService {
  id: string
  kind: ExternalTtsKind
  label: string
  baseUrl: string
  model: string
  voice: string
  responseFormat: ExternalTtsFormat
  /** 可选的音色查询地址：留空走默认 {根}/profiles；可填同主机路径或完整 http(s) URL */
  profilesPath?: string
  createdAt: number
  updatedAt: number
}

export interface ExternalTtsServiceInput {
  id?: string
  label?: unknown
  baseUrl?: unknown
  model?: unknown
  voice?: unknown
  responseFormat?: unknown
  /** 音色查询地址（路径或完整 URL）；传空串表示回落默认 /profiles */
  profilesPath?: unknown
  /** 保存时一并更新 Key；不传表示保持原样。 */
  apiKey?: unknown
  /** 显式清除该实例 Key。 */
  clearKey?: unknown
}

/** 查询回来的一条音色（兼容 voicebox /profiles 与 OpenAI /models 等不同返回形状） */
export interface ExternalTtsVoiceProfile {
  /** 合成时实际使用的稳定标识（voicebox 的 profile id） */
  id: string
  /** 界面显示名 */
  name: string
  voiceType: ExternalTtsVoiceType
  language?: string
  /** 按服务端字段派生的合成引擎，如 qwen_custom_voice / qwen */
  engine?: string
  /** 克隆 Base 模型需要的 model_size */
  modelSize?: string
  sampleCount?: number
  /** false 表示该音色当前不可合成（如克隆音色还没上传参考音频） */
  usable: boolean
  unavailableReason?: string
}

export interface ExternalTtsProfilesResult {
  profiles: ExternalTtsVoiceProfile[]
  detail: string
  /** 实际请求的查询地址 */
  sourceUrl: string
  /** true = 查询地址跨主机，本次请求不会携带实例 Key */
  crossHost: boolean
}

/** 未保存草稿上的音色查询（设置页「查询音色」用，不落盘、默认不写 Key） */
export interface ExternalTtsProfilesQueryInput {
  baseUrl?: unknown
  apiKey?: unknown
  profilesPath?: unknown
  /** 编辑已有实例时传 id：同主机且地址未变则复用已存 Key */
  id?: unknown
}

/** 未保存实例的草稿探测（设置页「测试连接」用，不落盘、不写 Key）。 */
export interface ExternalTtsDraftProbeInput {
  baseUrl?: unknown
  apiKey?: unknown
  /** 编辑已有实例时传 id：地址未变则复用已存 Key，避免误报鉴权失败。 */
  id?: unknown
}

export interface ExternalTtsServiceView extends ExternalTtsService {
  hasKey: boolean
  keyTail: string | null
  available: boolean
  cooldownUntil: number | null
}

export interface ExternalTtsProbeResult {
  /** true = 请求已完成且服务可达；强成功的判断必须同时看 weak */
  ok: boolean
  latencyMs: number
  detail: string
  /** 服务可达但 /models 不是 OpenAI 兼容面（如 Gradio/自定义 TTS），需试听确认 */
  weak?: boolean
}

export interface ExternalTtsTestResult {
  ok: true
  message: string
  audio?: VoiceSpeakResult
}

export interface ExternalTtsSynthesisInput {
  text: string
  voice: string
  speedRatio?: number
  /** 单次覆盖实例默认格式；角色语音条需要 wav 时使用。 */
  responseFormat?: ExternalTtsFormat
  signal?: AbortSignal
}

export interface ExternalTtsSynthesisResult {
  audio: Buffer
  mime: string
  extension: 'mp3' | 'wav'
  usage?: Record<string, unknown>
}
