// errors.ts —— 统一错误码与错误信封（PLAN-3.0.md §14.2）
//
// 渲染端按 `code` 分支，**禁止**用 `error.message.includes()` 判断。
// IPC 失败统一信封：{ code, message, details? }
//
// 3.0 相对 2.0 的两处差异（§14.2）：
//   - 去掉与 3.0 无关的 HOT_SOURCE_ERROR（营销热点采集专属）
//   - 新增 STREAM_TRUNCATED：流式响应体已开始后的传输中断（2.0 v1.21 已从 connect-failed 拆出）

/** §14.2 错误码表（唯一的 code 真相来源，共 11 项） */
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
  FILE_PARSE_ERROR: 'FILE_PARSE_ERROR',
  /** 流式响应体已开始后的传输中断（应保留已得内容 + 提供重试，而非当作连接失败） */
  STREAM_TRUNCATED: 'STREAM_TRUNCATED'
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

/**
 * 提取 §14.2 错误码，**不依赖 `instanceof`**。
 *
 * `AppError` 的类身份取决于模块实例：生产构建里 rollup 可能把 `errors.ts` 拆进不同 chunk，
 * 测试里各模块也各自 bundle —— 那些情况下 `instanceof` 会**假阴性**，把上游的
 * SETUP_REQUIRED / NOT_FOUND 静默降级成 DB_ERROR；而渲染端是**按 code 分支**的（§五），
 * 前端会因此丢掉「去环境初始化」「该商家不存在」这些分支。
 *
 * 因此以「§五 合法码」作为判据，`instanceof` 只作为第一优先。
 */
export function errorCodeOf(e: unknown): ErrorCode | null {
  if (isAppError(e)) return e.code
  const code = (e as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    return code as ErrorCode
  }
  return null
}

/** 任意异常 → 统一信封（未知异常兜底 DB_ERROR，不把原始堆栈泄漏给渲染端） */
export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  const code = errorCodeOf(e)
  if (code) {
    const env: ErrorEnvelope = {
      code,
      message: e instanceof Error && e.message ? e.message : String(e)
    }
    const details = (e as { details?: unknown } | null | undefined)?.details
    if (details !== undefined) env.details = details
    return env
  }
  const message = e instanceof Error ? e.message : String(e)
  return { code: ERROR_CODES.DB_ERROR, message }
}
