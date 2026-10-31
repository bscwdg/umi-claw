// OpenClaw 对话内语音（TTS）的桥接逻辑——纯函数，无 Node/electron 依赖，便于验收。
//
// 设计口径：
// - 预设音色有两条通道：
//   1) bridge：OpenClaw `tts-local-cli` → 内置 `volc-tts.mjs` → 火山 Plan 接口（Agent Plan Key）
//   2) volcengine：OpenClaw 自带 volcengine provider → 火山标准接口（语音控制台 Key）
// - 克隆音色只能走 volcengine（标准接口 + seed-icl），因为 Plan 接口不提供复刻音色。
// - **密钥不进 openclaw.json**：apiKey 只存在 safeStorage，网关启动时以环境变量注入。
import type { OpenClawTtsAuto, OpenClawTtsChannel } from './types'

/** OpenClaw `tts.auto` 的合法取值（official：off / always / inbound / tagged）。 */
export type { OpenClawTtsAuto }

/** 应用内会朗读的提醒级别：tagged 档只读「被标记」的事件。 */
export interface SpeakGate {
  mode: 'off' | 'tagged' | 'always' | 'inbound'
  /** 该事件是否属于「被标记」级别（如待办到点提醒）。 */
  taggedEligible: boolean
}

/**
 * 应用内短提示是否该朗读。
 *
 * `tagged` 只读「被标记」事件；`inbound` 是 OpenClaw 侧语义，应用内提醒不适用。
 */
export function shouldSpeakInApp(gate: SpeakGate): boolean {
  if (gate.mode === 'off') return false
  if (gate.mode === 'always') return true
  if (gate.mode === 'tagged') return gate.taggedEligible
  return false
}

export interface OpenClawTtsBlock {
  auto: OpenClawTtsAuto
  provider: 'volcengine' | 'tts-local-cli'
  providers: Record<string, Record<string, unknown>>
}

export interface OpenClawTtsInput {
  conversationTts: OpenClawTtsAuto
  channel: OpenClawTtsChannel
  /** 已按音色类型解析好的资源 ID：预设→seed-tts-*，克隆→seed-icl-*。 */
  resourceId: string
  speakerVoice: string
  /** bridge 模式下的内置脚本绝对路径。 */
  bridgeScriptPath?: string
  /** bridge 模式下「运行时热更设置」文件路径（音色/资源 ID 每次合成时读取）。 */
  bridgeSettingsPath?: string
}

export function buildOpenClawTtsBlock(input: OpenClawTtsInput): OpenClawTtsBlock {
  if (input.channel === 'bridge') {
    if (!input.bridgeScriptPath) {
      throw new Error('本地桥接脚本路径未配置')
    }
    return {
      auto: input.conversationTts,
      provider: 'tts-local-cli',
      providers: {
        'tts-local-cli': {
          command: 'node',
          args: [input.bridgeScriptPath, '{{Text}}', '{{OutputPath}}'],
          outputFormat: 'mp3',
          timeoutMs: 120000
        }
      }
    }
  }
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

/**
 * 网关启动时要注入的环境变量（密钥只在这里出现，不进文件）。
 *
 * bridge 模式走 Plan 接口，用 Agent Plan Key；volcengine 模式走标准接口，用语音控制台 Key。
 */
export function buildOpenClawTtsEnv(
  input: OpenClawTtsInput,
  apiKey: string | null
): Record<string, string> {
  if (!apiKey) return {}
  if (input.conversationTts === 'off') return {}
  if (input.channel === 'bridge') {
    return {
      UMI_VOICE_PLAN_KEY: apiKey,
      UMI_VOICE_RESOURCE_ID: input.resourceId,
      UMI_VOICE_SPEAKER: input.speakerVoice,
      // 音色/资源 ID 的热更文件：bridge 每次合成时重新读取（改音色不必重启网关）
      ...(input.bridgeSettingsPath ? { UMI_VOICE_SETTINGS_FILE: input.bridgeSettingsPath } : {})
    }
  }
  return {
    VOLCENGINE_TTS_API_KEY: apiKey,
    VOLCENGINE_TTS_RESOURCE_ID: input.resourceId,
    VOLCENGINE_TTS_VOICE: input.speakerVoice
  }
}
