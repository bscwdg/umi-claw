// electron/main/character/qqVoice.ts —— QQ 语音条直连（C08）
//
// 链路：TTS 出 16k PCM(WAV) → 去 WAV 头 → SILK 编码 → 上传 file_type=3 → 发 msg_type=7。
// 约束（PLAN-FISH-CHARACTER §5.7 / §13.2）：
// - 不走 OpenClaw 插件 message(attachments)（会把语音发成文件且假成功）；
// - 失败降级文字，不重试、不换通道；
// - 凭据只读不写；日志不打印 token/secret。

export const QQ_VOICE_MSG_TYPE = 7
export const QQ_VOICE_FILE_TYPE = 3
export const QQ_API_BASE = 'https://api.sgroup.qq.com'
export const QQ_TOKEN_BASE = 'https://bots.qq.com'

export interface QqBotCreds {
  appId: string
  clientSecret: string
  openid: string
}

export interface QqVoiceDeps {
  fetchImpl?: typeof fetch
  apiBase?: string
  tokenBase?: string
  /** 注入 SILK 编码（测试用）；缺省动态加载 silk-wasm */
  encodeSilk?: (pcm: Uint8Array, sampleRate: number) => Promise<Uint8Array>
}

export interface DeliverVoiceInput extends QqVoiceDeps {
  text: string
  creds: QqBotCreds | null
  /** 用角色 TTS 合成（返回 WAV 字节；16k 单声道 16bit） */
  speakPcm: (text: string) => Promise<Uint8Array>
  /** 递增消息序号（同一会话必须递增） */
  seq: number
  /** 降级文案（失败/无凭据时返回，调用方负责发文字） */
}

export interface DeliverVoiceResult {
  delivered: boolean
  channel: 'qq' | 'text'
  seq: number
  error?: string
  messageId?: string
}

/** 从 WAV 里取 PCM 数据块与采样率；不是合法 RIFF/WAVE 或不是单声道16bit 直接拒绝 */
export function extractWavPcm(bytes: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  if (bytes.byteLength < 44) throw new Error('WAV 过短')
  const isRiff =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  if (!isRiff) throw new Error('不是合法 WAV（缺少 RIFF/WAVE 头）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true) || 0
      bits = view.getUint16(offset + 22, true)
      if (format !== 1 && format !== 0xfffe) throw new Error(`不支持的 WAV 编码（format=${format}）`)
      if (channels !== 1) throw new Error(`语音条只支持单声道（实际 ${channels} 声道）`)
      if (bits !== 16) throw new Error(`语音条只支持 16bit（实际 ${bits}bit）`)
    }
    if (id === 'data') {
      if (!sampleRate || !channels || !bits) throw new Error('WAV 缺少有效 fmt 块')
      const start = offset + 8
      const pcm = bytes.slice(start, Math.min(bytes.byteLength, start + size))
      if (pcm.byteLength === 0) throw new Error('WAV 数据为空')
      return { pcm, sampleRate }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV 缺少 data 块')
}

export function nextMsgSeq(prev: number): number {
  const base = Number.isFinite(prev) && prev > 0 ? Math.floor(prev) : 0
  return Math.min(1_000_000, base + 1)
}

/** 默认 SILK 编码：动态加载 silk-wasm（未安装/打包缺失时抛明确错误，由调用方降级） */
async function defaultEncodeSilk(pcm: Uint8Array, sampleRate: number): Promise<Uint8Array> {
  try {
    // 用字符串动态 import，避免 bundler 在未安装依赖时硬失败
    const loader = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    const mod = (await loader('silk-wasm')) as {
      encode?: (input: Uint8Array, sampleRate: number) => Promise<{ data: Uint8Array }>
    }
    if (!mod?.encode) throw new Error('encoder-missing')
    const result = await mod.encode(pcm, sampleRate)
    return result.data
  } catch {
    throw new Error('SILK_ENCODER_UNAVAILABLE（silk-wasm 未安装或资源路径不可用）')
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/**
 * 带超时的 fetch（表情包发图也复用它，别在两处各写一套）。
 * 导出而不是复制：凭证/超时/请求头只有这一份真源。
 */
export function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms = 15_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const signal = controller.signal
  return fetchImpl(url, { ...init, signal }).finally(() => clearTimeout(timer))
}

/** 取 QQ access_token（带进程内缓存）；导出给 stickerSender 复用，不重写一套凭证逻辑 */
export async function getAccessToken(creds: QqBotCreds, deps: QqVoiceDeps): Promise<string> {
  const cacheKey = creds.appId
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = deps.tokenBase ?? QQ_TOKEN_BASE
  const res = await fetchWithTimeout(fetchImpl, `${base}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.clientSecret })
  })
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; message?: string }
    | null
  if (!res.ok || !json?.access_token) {
    throw new Error(`QQ access_token 获取失败（HTTP ${res.status}）`)
  }
  const ttl = Math.max(120, Math.min(3600, Number(json.expires_in) || 3600))
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttl * 1000 })
  return json.access_token
}

/**
 * 发送 QQ 语音条。失败一律降级文字（由调用方展示），不重试。
 */
export async function deliverVoice(input: DeliverVoiceInput): Promise<DeliverVoiceResult> {
  const seq = nextMsgSeq(input.seq)
  if (!input.creds || !input.creds.appId || !input.creds.clientSecret || !input.creds.openid) {
    return { delivered: false, channel: 'text', seq, error: 'QQ 凭据不完整' }
  }
  try {
    const wav = await input.speakPcm(input.text)
    const { pcm, sampleRate } = extractWavPcm(wav)
    if (pcm.byteLength === 0) throw new Error('TTS 返回空音频')
    const encode = input.encodeSilk ?? defaultEncodeSilk
    const silk = await encode(pcm, sampleRate)
    if (!silk || silk.byteLength === 0) throw new Error('SILK 编码结果为空')

    const fetchImpl = input.fetchImpl ?? fetch
    const base = input.apiBase ?? QQ_API_BASE
    const token = await getAccessToken(input.creds, input)
    const form = new FormData()
    form.append('file_type', String(QQ_VOICE_FILE_TYPE))
    form.append('srv_send_msg', 'false')
    const silkBuffer = silk.buffer.slice(
      silk.byteOffset,
      silk.byteOffset + silk.byteLength
    ) as ArrayBuffer
    form.append('file', new Blob([silkBuffer]), 'voice.silk')
    const upload = await fetchWithTimeout(
      fetchImpl,
      `${base}/v2/users/${encodeURIComponent(input.creds.openid)}/files`,
      {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}` },
        body: form
      }
    )
    const uploaded = (await upload.json().catch(() => null)) as {
      file_info?: string
      file_uuid?: string
      message?: string
    } | null
    const fileInfo = uploaded?.file_info ?? uploaded?.file_uuid
    if (!upload.ok || !fileInfo) {
      throw new Error(`QQ 语音上传失败（HTTP ${upload.status}）`)
    }
    const send = await fetchWithTimeout(
      fetchImpl,
      `${base}/v2/users/${encodeURIComponent(input.creds.openid)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 计划要求：语音条不带 content / msg_id
          msg_type: QQ_VOICE_MSG_TYPE,
          media: { file_info: fileInfo },
          msg_seq: seq
        })
      }
    )
    const sent = (await send.json().catch(() => null)) as { id?: string; message?: string } | null
    if (!send.ok) throw new Error(`QQ 语音发送失败（HTTP ${send.status}）`)
    return { delivered: true, channel: 'qq', seq, messageId: sent?.id }
  } catch (error) {
    return {
      delivered: false,
      channel: 'text',
      seq,
      error: (error as Error)?.message ?? String(error)
    }
  }
}
