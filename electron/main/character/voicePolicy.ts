// electron/main/character/voicePolicy.ts —— 语音发送策略（C08，纯逻辑）
//
// 优先级（PLAN-FISH-CHARACTER §5.7）：用户明确要求 > 阶段解锁 > 内容适配 > 免打扰。
// 失败降级文字，不重试（失败由调用方处理）。

export type VoiceDecisionReason =
  | 'disabled'
  | 'request-not-allowed'
  | 'not-unlocked'
  | 'quiet'
  | 'daily-cap'
  | 'too-long'
  | 'ok'

export interface VoiceDecision {
  send: boolean
  reason: VoiceDecisionReason
  /** 用户明确要求「发条语音」时为 true */
  requested: boolean
}

export interface VoicePolicyInput {
  voiceEnabled: boolean
  requestAllowed: boolean
  requested: boolean
  stage: number
  quiet: boolean
  usedToday: number
  dailyCap: number
  text: string
  textMaxChars?: number
}

/** 「发条语音 / 说句话 / 语音说」这类明确要求（正则预筛，模型二次判定由调用方做） */
export function isVoiceRequest(text: string): boolean {
  const raw = (text ?? '').trim()
  if (!raw) return false
  // 否定表达先排除（「我不想发语音」「别用声音」不是要求）
  if (/(不想|不要|不用|别)(发|来|用|听|说).{0,4}(语音|声音)/.test(raw)) return false
  if (/(发|来|出)(一?条|个|段)?(语音|声音|语音条)/.test(raw)) return true
  if (/语音(说|讲|回|发)/.test(raw)) return true
  if (/(用|拿)(你的)?声音/.test(raw)) return true
  if (/说句(话|话嘛|话听听)/.test(raw)) return true
  return false
}

export function decideVoice(input: VoicePolicyInput): VoiceDecision {
  const requested = Boolean(input.requested)
  const deny = (reason: VoiceDecisionReason): VoiceDecision => ({ send: false, reason, requested })
  if (!input.voiceEnabled) return deny('disabled')
  // §5.7 优先级：用户明确要求 > 阶段解锁 > 内容适配 > 免打扰
  if (requested) {
    if (!input.requestAllowed) return deny('request-not-allowed')
  } else {
    if (input.stage < 2) return deny('not-unlocked')
    if (input.quiet) return deny('quiet')
  }
  const max = input.textMaxChars ?? 120
  if ((input.text ?? '').length > max) return deny('too-long')
  if (input.usedToday >= Math.max(0, input.dailyCap)) return deny('daily-cap')
  return { send: true, reason: 'ok', requested }
}
