// electron/main/fish/voice/external/types.ts —— 本地 TTS 实例与协议类型
//
// 本地实例是用户自己部署或托管的兼容服务；本应用只保存连接信息和调用协议，
// 不安装、不启动、不守护对方进程。API Key 也不进这里的持久化结构。

import type { VoiceSpeakResult } from '../core/types'

export type ExternalTtsKind = 'openai-speech'
export type ExternalTtsFormat = 'mp3' | 'wav'

export interface ExternalTtsService {
  id: string
  kind: ExternalTtsKind
  label: string
  baseUrl: string
  model: string
  voice: string
  responseFormat: ExternalTtsFormat
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
  /** 保存时一并更新 Key；不传表示保持原样。 */
  apiKey?: unknown
  /** 显式清除该实例 Key。 */
  clearKey?: unknown
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
  ok: boolean
  latencyMs: number
  detail: string
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
