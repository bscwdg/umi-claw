// errors.ts —— 统一错误码与错误信封（PLAN-2.0.md §五）
//
// 渲染端按 `code` 分支，**禁止**用 `error.message.includes()` 判断。
// IPC 失败统一信封：{ code, message, details? }

/** §五 错误码表（唯一的 code 真相来源） */
export const ERROR_CODES = {
  /** 参数不合法 */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 资源不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** 冲突（如 business 已存在） */
  CONFLICT: 'CONFLICT',
  /** Worker 查询失败（重试后仍败） */
  DB_ERROR: 'DB_ERROR',
  /** 便携 Node 不存在，Worker 无法启动 */
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  /** Gateway 探活/拉起失败（Commit 07） */
  OPENCLAW_NOT_READY: 'OPENCLAW_NOT_READY',
  /** 调用超时（Commit 07） */
  OPENCLAW_TIMEOUT: 'OPENCLAW_TIMEOUT',
  /** Gateway token 鉴权失败（Commit 07） */
  OPENCLAW_AUTH_ERROR: 'OPENCLAW_AUTH_ERROR',
  /** 原始文件缺失 */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** 原始文件解析失败 */
  FILE_PARSE_ERROR: 'FILE_PARSE_ERROR'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** IPC 失败信封 */
export interface ErrorEnvelope {
  code: ErrorCode
  message: string
  details?: unknown
}

/**
 * 应用级错误：Manager / Database 客户端抛出的统一类型。
 * IPC 层把它翻译成 ErrorEnvelope；未知错误兜底为 DB_ERROR。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/** 任意异常 → 统一信封（未知异常兜底 DB_ERROR，不把原始堆栈泄漏给渲染端） */
export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (isAppError(e)) {
    const env: ErrorEnvelope = { code: e.code, message: e.message }
    if (e.details !== undefined) env.details = e.details
    return env
  }
  const message = e instanceof Error ? e.message : String(e)
  return { code: ERROR_CODES.DB_ERROR, message }
}
