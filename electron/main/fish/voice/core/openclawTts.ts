// OpenClaw 对话内语音（TTS）的桥接逻辑——纯函数，无 Node/electron 依赖，便于验收。
//
// 设计口径（硬规则 25「底座打通」）：
// - 语音能力走 OpenClaw 自带的 tts 配置块与 /tts 命令族，不另造第二套对话语音路由。
// - **密钥不进 openclaw.json**：apiKey 只存在于 safeStorage，网关启动时以
//   VOLCENGINE_TTS_API_KEY 环境变量注入。写进 json 等于把密钥从加密存储挪到明文文件。
import type { VoiceSettings, OpenClawTtsAuto } from './types'

/** OpenClaw `tts.auto` 的合法取值（official：off / always / inbound / tagged）。 */
export type { OpenClawTtsAuto }

/** 应用内会朗读的提醒级别：tagged 档只读「被标记」的事件。 */
export interface SpeakGate {
  mode: VoiceSettings['conversationTts'] | VoiceSettings['autoSpeak']
  /** 该事件是否属于「被标记」级别（如待办到点提醒）。 */
  taggedEligible: boolean
}

/**
 * 应用内短提示是否该朗读。
 *
 * 旧实现的缺陷：`if (autoSpeak === 'off') return` —— tagged 与 always 同行为，
 * 于是「仅标记事件」这一档在 UI 上存在、实际完全失效。这里把它补成真三态。
 */
export function shouldSpeakInApp(gate: SpeakGate): boolean {
  if (gate.mode === 'off') return false
  if (gate.mode === 'always') return true
  if (gate.mode === 'tagged') return gate.taggedEligible
  // inbound 是 OpenClaw 侧语义（收到语音消息才回语音），应用内提醒不适用。
  return false
}

export interface OpenClawTtsBlock {
  auto: OpenClawTtsAuto
  provider: 'volcengine'
  providers: {
    volcengine: {
      resourceId: string
      speakerVoice: string
    }
  }
}

/**
 * 生成注入 openclaw.json 的 tts 段。
 *
 * 注意：**故意不含 apiKey**——密钥走环境变量，见文件头。
 * 只把「用哪个音色、哪个资源」这类非密信息落盘。
 */
export interface OpenClawTtsInput {
  conversationTts: OpenClawTtsAuto
  /** 已按音色类型解析好的资源 ID：预设→seed-tts-*，克隆→seed-icl-*。 */
  resourceId: string
  speakerVoice: string
}

export function buildOpenClawTtsBlock(input: OpenClawTtsInput): OpenClawTtsBlock {
  return {
    auto: input.conversationTts,
    provider: 'volcengine',
    providers: {
      volcengine: {
        resourceId: input.resourceId,
        speakerVoice: input.speakerVoice
      }
    }
  }
}

/** 网关启动时要注入的环境变量（密钥只在这里出现，不进文件）。 */
export function buildOpenClawTtsEnv(
  input: OpenClawTtsInput,
  apiKey: string | null
): Record<string, string> {
  if (!apiKey) return {}
  // 关闭对话内语音时连密钥都不注入：能力整体下线，而不是「配好了但不用」。
  if (input.conversationTts === 'off') return {}
  return {
    VOLCENGINE_TTS_API_KEY: apiKey,
    VOLCENGINE_TTS_RESOURCE_ID: input.resourceId,
    VOLCENGINE_TTS_VOICE: input.speakerVoice
  }
}
