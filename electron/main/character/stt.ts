// electron/main/character/stt.ts —— 入站语音转写（C08）
//
// 用户发的 QQ 语音条在插件侧只是 .amr/.silk 文件；没有 STT 就没有文字。
// 约定：有 STT 就转写；没有/失败就诚实说「没听清/还没学会」，不假装听懂。

export const STT_MAX_BYTES = 10 * 1024 * 1024
export const STT_FALLBACK_MESSAGE = '本鱼还没学会听语音，你打字给我吧'

export interface TranscribeInput {
  /** 已拿到的音频字节（与 download 二选一） */
  audio?: Uint8Array | null
  /** 需要时再去下载（惰性） */
  download?: () => Promise<Uint8Array | null>
  /** 注入的 STT 模型调用（缺省视为不可用） */
  transcribe?: (audio: Uint8Array) => Promise<string>
  maxBytes?: number
}

export interface TranscribeResult {
  ok: boolean
  text: string
  error?: string
  /** 失败时给用户看的诚实文案（调用方直接发这句） */
  fallbackMessage?: string
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 入站语音转写：大小校验 → 下载 → 转写；任何失败都给诚实文案，不抛错 */
export async function transcribeInbound(input: TranscribeInput): Promise<TranscribeResult> {
  const max = input.maxBytes ?? STT_MAX_BYTES
  try {
    if (!input.transcribe) {
      return { ok: false, text: '', error: 'STT 未配置', fallbackMessage: STT_FALLBACK_MESSAGE }
    }
    const audio = input.audio ?? (input.download ? await input.download() : null)
    if (!audio || audio.byteLength === 0) {
      return { ok: false, text: '', error: '音频为空', fallbackMessage: STT_FALLBACK_MESSAGE }
    }
    if (audio.byteLength > max) {
      return {
        ok: false,
        text: '',
        error: `音频过大（${formatBytes(audio.byteLength)} > ${formatBytes(max)}）`,
        fallbackMessage: '这段语音太长了，本鱼听不完，你打字吧'
      }
    }
    const text = (await input.transcribe(audio)).trim()
    if (!text) {
      return { ok: false, text: '', error: '转写结果为空', fallbackMessage: STT_FALLBACK_MESSAGE }
    }
    return { ok: true, text: text.slice(0, 2000) }
  } catch (error) {
    return {
      ok: false,
      text: '',
      error: (error as Error)?.message ?? String(error),
      fallbackMessage: STT_FALLBACK_MESSAGE
    }
  }
}
