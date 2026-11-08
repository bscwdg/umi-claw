// electron/main/character/stickerSender.ts —— QQ C2C 表情包直发（4.4）
//
// 链路（官方 API，和 qqVoice 同一条凭证/请求栈）：
//   1) POST /v2/users/{openid}/files  multipart：file_type=1（图片）+ file_data/file → file_info
//   2) POST /v2/users/{openid}/messages  msg_type=7 + media:{file_info}
//      - 主动消息：不带 msg_id / event_id / msg_seq
//      - 被动回复：带 msg_id（或 event_id）+ msg_seq
//
// 为什么复用 qqVoice 的 getAccessToken/fetchWithTimeout：凭据缓存、超时、Authorization
// 头只有一份真源；换渠道/换实现时不会出现「语音能发、图片发不出」的凭证漂移。
//
// 失败只返回明确 reason（不重试、不换通道）：上层（UI/主动消息）据此决定降级文案。
// 日志/返回值都不带 token 与 clientSecret。

import { readFileSync, statSync } from 'node:fs'

import {
  QQ_API_BASE,
  QQ_TOKEN_BASE,
  fetchWithTimeout,
  getAccessToken,
  type QqBotCreds
} from './qqVoice'
import { STICKER_MAX_BYTES, detectImageFormat, type StickerFormat } from './stickerStore'

export const QQ_STICKER_MSG_TYPE = 7
export const QQ_STICKER_FILE_TYPE = 1
export const STICKER_SEND_MAX_BYTES = STICKER_MAX_BYTES

const STICKER_MIME: Record<StickerFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export interface SendStickerInput {
  /** 与 qqVoice 同源（wiring 从 openclaw.json 的 qqbot 配置读取后注入） */
  creds: QqBotCreds | null
  /** 本地图片绝对路径（只由宿主给出，渲染端拿不到） */
  filePath: string
  /** 记录里的格式（实际以魔数为准，不一致直接拒绝） */
  format?: StickerFormat
  /** 上传时的文件名（默认取 filePath 的 basename） */
  fileName?: string
  /** 被动回复：消息 id（与 eventId 二选一） */
  msgId?: string
  /** 被动回复：事件 id（与 msgId 二选一） */
  eventId?: string
  /** 被动回复的消息序号（同一 msg_id 下递增；缺省 1） */
  msgSeq?: number
  fetchImpl?: typeof fetch
  apiBase?: string
  tokenBase?: string
}

export type StickerSendReason =
  | 'no-creds'
  | 'file-missing'
  | 'file-too-large'
  | 'format-mismatch'
  | 'upload-failed'
  | 'send-failed'

export interface SendStickerResult {
  ok: boolean
  reason?: StickerSendReason
  /** 明确原因的可读补充（HTTP 状态/后端 message），不含凭据 */
  detail?: string
  messageId?: string
  /** QQ 侧上传后返回的 file_info（排障用） */
  fileInfo?: string
}

/** 被动回复才需要 msg_id/event_id + msg_seq；主动消息一个都不带 */
export function isPassiveReply(input: { msgId?: string; eventId?: string }): boolean {
  return Boolean(input.msgId?.trim() || input.eventId?.trim())
}

/** 被动回复的 msg_seq 归一：非有限/<=0 一律按 1（QQ 要求同一 msg_id 下递增） */
export function normalizeMsgSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(1_000_000, Math.floor(value))
}

/**
 * 发一张表情包到 QQ（C2C）。ok=false 时 reason 一定非空；不抛异常（错误也走返回值），
 * 上层统一按 reason 决定降级文案。
 */
export async function sendSticker(input: SendStickerInput): Promise<SendStickerResult> {
  const creds = input.creds
  if (!creds || !creds.appId || !creds.clientSecret || !creds.openid) {
    return { ok: false, reason: 'no-creds', detail: 'QQ 凭据不完整（appId/clientSecret/openid）' }
  }

  let bytes: Buffer
  try {
    const info = statSync(input.filePath)
    if (!info.isFile()) return { ok: false, reason: 'file-missing', detail: '不是普通文件' }
    if (info.size > STICKER_SEND_MAX_BYTES) {
      return {
        ok: false,
        reason: 'file-too-large',
        detail: `图片 ${info.size} 字节超过 ${STICKER_SEND_MAX_BYTES} 字节上限`
      }
    }
    bytes = readFileSync(input.filePath)
  } catch {
    return { ok: false, reason: 'file-missing', detail: '图片文件不存在或不可读' }
  }
  if (bytes.byteLength === 0) return { ok: false, reason: 'file-missing', detail: '图片文件为空' }
  if (bytes.byteLength > STICKER_SEND_MAX_BYTES) {
    return { ok: false, reason: 'file-too-large', detail: `图片超过 ${STICKER_SEND_MAX_BYTES} 字节` }
  }
  const actualFormat = detectImageFormat(bytes)
  if (!actualFormat) {
    return { ok: false, reason: 'format-mismatch', detail: '不是 PNG/JPEG/GIF/WebP 图片' }
  }
  if (input.format && input.format !== actualFormat) {
    return {
      ok: false,
      reason: 'format-mismatch',
      detail: `记录格式 ${input.format} 与图片实际格式 ${actualFormat} 不一致`
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const apiBase = input.apiBase ?? QQ_API_BASE
  const tokenBase = input.tokenBase ?? QQ_TOKEN_BASE
  const fileName = input.fileName?.trim() || `sticker.${actualFormat}`

  let token: string
  try {
    token = await getAccessToken(creds, { fetchImpl, tokenBase })
  } catch (error) {
    return {
      ok: false,
      reason: 'upload-failed',
      detail: `access_token 获取失败：${(error as Error)?.message ?? String(error)}`
    }
  }

  let fileInfo = ''
  try {
    const form = new FormData()
    form.append('file_type', String(QQ_STICKER_FILE_TYPE))
    // srv_send_msg=false：只上传不自动发，拿到 file_info 后再自行控制 msg_id/msg_seq
    form.append('srv_send_msg', 'false')
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    form.append('file', new Blob([buffer], { type: STICKER_MIME[actualFormat] }), fileName)
    const upload = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/v2/users/${encodeURIComponent(creds.openid)}/files`,
      {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}` },
        body: form
      }
    )
    const uploaded = (await upload.json().catch(() => null)) as
      | { file_info?: string; file_uuid?: string; message?: string }
      | null
    fileInfo = uploaded?.file_info ?? uploaded?.file_uuid ?? ''
    if (!upload.ok || !fileInfo) {
      return {
        ok: false,
        reason: 'upload-failed',
        detail: `HTTP ${upload.status}${uploaded?.message ? `：${uploaded.message}` : ''}`
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'upload-failed',
      detail: (error as Error)?.message ?? String(error)
    }
  }

  const passive = isPassiveReply(input)
  const payload: Record<string, unknown> = {
    msg_type: QQ_STICKER_MSG_TYPE,
    media: { file_info: fileInfo }
  }
  if (passive) {
    if (input.msgId?.trim()) payload.msg_id = input.msgId.trim()
    else if (input.eventId?.trim()) payload.event_id = input.eventId.trim()
    payload.msg_seq = normalizeMsgSeq(input.msgSeq)
  }

  try {
    const send = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/v2/users/${encodeURIComponent(creds.openid)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    )
    const sent = (await send.json().catch(() => null)) as
      | { id?: string; message?: string }
      | null
    if (!send.ok) {
      return {
        ok: false,
        reason: 'send-failed',
        detail: `HTTP ${send.status}${sent?.message ? `：${sent.message}` : ''}`,
        fileInfo
      }
    }
    return {
      ok: true,
      messageId: sent?.id,
      fileInfo
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'send-failed',
      detail: (error as Error)?.message ?? String(error),
      fileInfo
    }
  }
}
