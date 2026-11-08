// electron/main/character/qqProactiveText.ts —— QQ 主动文本直发（不依赖 OpenClaw CLI）
//
// 为什么需要它：OpenClaw CLI 的 `message send --channel` 目前不认 qqbot
// （CLI 帮助列表没有 qqbot），主动消息走 CLI 会失败/挂起，最后只剩应用内气泡。
// 这里复用语音条同源的 QQBot 凭据与 token，直接调 C2C 发消息接口。
//
// 只发主动文本（msg_type=0），不处理被动回复/发送序号；失败返回明确原因、不重试。

import {
  QQ_API_BASE,
  QQ_TOKEN_BASE,
  fetchWithTimeout,
  getAccessToken,
  type QqBotCreds
} from './qqVoice'

export type QqProactiveTextReason =
  | 'no-creds'
  | 'unsupported-target'
  | 'empty-text'
  | 'auth-failed'
  | 'send-failed'

export interface SendQqProactiveTextInput {
  creds: QqBotCreds | null
  /** OpenClaw delivery target，如 qqbot:c2c:OPENID 或 channel:c2c:OPENID */
  target: string
  text: string
  fetchImpl?: typeof fetch
  apiBase?: string
  tokenBase?: string
}

export interface SendQqProactiveTextResult {
  ok: boolean
  reason?: QqProactiveTextReason
  detail?: string
}

/** 从 OpenClaw target 提取 C2C openid；群聊/频道格式暂不支持主动直发 */
export function parseQqC2cOpenid(target: string): string | null {
  const match = /^(?:qqbot|channel):c2c:(.+)$/i.exec(String(target ?? '').trim())
  return match?.[1]?.trim() || null
}

export async function sendQqProactiveText(
  input: SendQqProactiveTextInput
): Promise<SendQqProactiveTextResult> {
  const text = String(input.text ?? '').trim().slice(0, 2000)
  if (!text) return { ok: false, reason: 'empty-text' }
  if (!input.creds) return { ok: false, reason: 'no-creds' }
  const openid = parseQqC2cOpenid(input.target)
  if (!openid) return { ok: false, reason: 'unsupported-target' }

  const fetchImpl = input.fetchImpl ?? fetch
  const apiBase = input.apiBase ?? QQ_API_BASE
  const tokenBase = input.tokenBase ?? QQ_TOKEN_BASE

  let token: string
  try {
    token = await getAccessToken(input.creds, { fetchImpl, tokenBase })
  } catch (error) {
    return {
      ok: false,
      reason: 'auth-failed',
      detail: (error as Error)?.message ?? String(error)
    }
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/v2/users/${encodeURIComponent(openid)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ msg_type: 0, content: text })
      },
      15_000
    )
    const body = (await response.json().catch(() => null)) as
      | { id?: string; message?: string }
      | null
    if (!response.ok) {
      return {
        ok: false,
        reason: 'send-failed',
        detail: `HTTP ${response.status}${body?.message ? `：${body.message}` : ''}`
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'send-failed',
      detail: (error as Error)?.message ?? String(error)
    }
  }
}
