// electron/main/fish/voice/core/route.ts —— 应用内朗读的 cloud/external/auto 路由
//
// local 模式不偷偷回云；只有 auto 会在外部实例缺失、未配置或冷却时回落。
// 路由只做纯决策，真正的 provider 调用仍由 VoiceManager 负责。

import { VOICE_ERROR_CODES, VoiceError } from './errors'
import type { VoiceEngine, VoiceSpeakRoute } from './types'

export interface ResolveSpeakEngineInput {
  requested?: VoiceSpeakRoute
  configured: VoiceSpeakRoute
  providerId: string
  externalConfigured: boolean
  externalAvailable: boolean
}

export interface ResolveSpeakEngineResult {
  engine: VoiceEngine
  providerId?: string
  fallbackReason?: string
}

export function resolveSpeakEngine(
  input: ResolveSpeakEngineInput
): ResolveSpeakEngineResult {
  const mode = input.requested ?? input.configured
  if (mode === 'cloud') return { engine: 'cloud' }
  if (!input.providerId) {
    if (mode === 'auto') return { engine: 'cloud', fallbackReason: '未选择外部 TTS 实例' }
    throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '请先在语音设置中选择外部 TTS 实例')
  }
  if (!input.externalConfigured) {
    if (mode === 'auto') return { engine: 'cloud', fallbackReason: '外部 TTS 实例不存在' }
    throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '外部 TTS 实例不存在')
  }
  if (!input.externalAvailable) {
    if (mode === 'auto') return { engine: 'cloud', fallbackReason: '外部 TTS 正在失败冷却' }
    throw new VoiceError(VOICE_ERROR_CODES.EXTERNAL_COOLDOWN, '外部 TTS 正在失败冷却')
  }
  return { engine: 'external', providerId: input.providerId }
}
