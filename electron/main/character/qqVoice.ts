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

/** 从 WAV 里取 PCM 数据块与采样率；不是 RIFF 时按原始 PCM 处理 */
export function extractWavPcm(bytes: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const sampleRate = view.getUint32(24, true) || 16000
    let offset = 12
    while (offset + 8 <= bytes.byteLength) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
      const size = view.getUint32(offset + 4, true)
      if (id === 'data') {
        const start = offset + 8
        return { pcm: bytes.slice(start, Math.min(bytes.byteLength, start + size)), sampleRate }
      }
      offset += 8 + size + (size % 2)
    }
  }
  return { pcm: bytes, sampleRate: 16000 }
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

async function getAccessToken(creds: QqBotCreds, deps: QqVoiceDeps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = deps.tokenBase ?? QQ_TOKEN_BASE
  const res = await fetchImpl(`${base}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.clientSecret })
  })
  const json = (await res.json().catch(() => null)) as { access_token?: string; message?: string } | null
  if (!res.ok || !json?.access_token) {
    throw new Error(`QQ access_token 获取失败（HTTP ${res.status}）`)
  }
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
    const upload = await fetchImpl(`${base}/v2/users/${encodeURIComponent(input.creds.openid)}/files`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}` },
      body: form
    })
    const uploaded = (await upload.json().catch(() => null)) as {
      file_info?: string
      file_uuid?: string
      message?: string
    } | null
    const fileInfo = uploaded?.file_info ?? uploaded?.file_uuid
    if (!upload.ok || !fileInfo) {
      throw new Error(`QQ 语音上传失败（HTTP ${upload.status}）`)
    }
    const send = await fetchImpl(
      `${base}/v2/users/${encodeURIComponent(input.creds.openid)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '',
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
