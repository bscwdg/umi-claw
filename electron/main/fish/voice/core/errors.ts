export const VOICE_ERROR_CODES = {
  INVALID_INPUT: 'VOICE_INVALID_INPUT',
  KEY_REQUIRED: 'VOICE_KEY_REQUIRED',
  ENCRYPTION_UNAVAILABLE: 'VOICE_ENCRYPTION_UNAVAILABLE',
  AUTH_ERROR: 'VOICE_AUTH_ERROR',
  BUDGET_EXCEEDED: 'VOICE_BUDGET_EXCEEDED',
  NOT_FOUND: 'VOICE_NOT_FOUND',
  RATE_LIMITED: 'VOICE_RATE_LIMITED',
  TIMEOUT: 'VOICE_TIMEOUT',
  CANCELLED: 'VOICE_CANCELLED',
  PROVIDER_ERROR: 'VOICE_PROVIDER_ERROR',
  CLONE_FAILED: 'VOICE_CLONE_FAILED',
  UNSUPPORTED: 'VOICE_UNSUPPORTED'
} as const

export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[keyof typeof VOICE_ERROR_CODES]

export class VoiceError extends Error {
  readonly code: VoiceErrorCode
  readonly details?: unknown

  constructor(code: VoiceErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'VoiceError'
    this.code = code
    this.details = details
  }
}

export interface VoiceErrorEnvelope {
  code: VoiceErrorCode
  message: string
  details?: unknown
}

export type VoiceIpcResult<T> = { ok: true; data: T } | { ok: false; error: VoiceErrorEnvelope }

export function toVoiceErrorEnvelope(error: unknown): VoiceErrorEnvelope {
  if (error instanceof VoiceError) {
    const out: VoiceErrorEnvelope = { code: error.code, message: error.message }
    if (error.details !== undefined) out.details = error.details
    return out
  }
  const maybe = error as { code?: unknown; message?: unknown; details?: unknown } | null
  if (
    maybe &&
    typeof maybe.code === 'string' &&
    Object.values(VOICE_ERROR_CODES).includes(maybe.code as VoiceErrorCode)
  ) {
    const out: VoiceErrorEnvelope = {
      code: maybe.code as VoiceErrorCode,
      message: typeof maybe.message === 'string' ? maybe.message : '语音请求失败'
    }
    if (maybe.details !== undefined) out.details = maybe.details
    return out
  }
  return {
    code: VOICE_ERROR_CODES.PROVIDER_ERROR,
    message: error instanceof Error && error.message ? error.message : '语音请求失败'
  }
}
