// gatewayClient.ts —— Gateway Client（PLAN-3.0.md Commit 01）
//
// 契约（§14.1 / §6.4 / §6.5 / 硬规则 3）：
//   - **硬规则 3**：`GATEWAY_TOKEN` 与 Gateway HTTP 调用**只存在于主进程**。本模块是应用里
//     唯一发 Gateway HTTP 请求的地方；渲染进程永不持有 token、永不直连 `127.0.0.1:3213`。
//   - **纯 Node 可测**：baseUrl / token / 超时 / logger / 「拉起函数（starter）」/ 会话键解析
//     全部**注入**；本文件**不 import electron**，也不引入任何新依赖（只用 node 内置的
//     全局 fetch / AbortController / TextDecoder）。
//   - **探活 → 按需自动拉起 → 就绪轮询**：探活（`GET /health` 200）失败才叫
//     starter **一次且只一次**（starter 实现在主进程 wiring 里复用 clawManager 的启停）。
//   - **SSE → IPC 透传**：`createChatStream()` 给出增量迭代器 + `cancel()`，
//     `forwardGatewayStream(webContents, runId, iterator)` 把增量按事件推给渲染进程。
//   - **会话隔离**：请求体 `user` = 调用方给的**完整会话键**（§6.4）——
//     `conv:work:qa` / `conv:work:tool:{toolId}` / `conv:work:report:{type}:{period}`。
//     本模块只做**形状校验**（必须 `conv:` 开头、无空白/换行，防注入），不再拼装 projectId。
//   - **多模态模型选择**：`model` 取值只能是 `openclaw` 或 `openclaw/<agentId>`。
//     含图请求走 `multimodal` 模型；**未配置多模态模型时明确报错（不静默降级）**。
//   - 错误沿 §14.2 码透传，判定上游错误用 `errorCodeOf()` 而不是 `instanceof`
//     （跨 bundle 会假阴性）。
//   - **唯一 ID 是 `runId`（v0.7 拍板，无 `streamId`）**：业务层一次执行的唯一 ID
//     同时就是本次 SSE 流的 ID；事件、`abort*`、`forwardGatewayStream` 全走它。
//
// 与 §14 的关系：本模块只提供 `work:gateway:{status,ensureReady}` 两条只读/幂等通道
// （见 ipc/gateway.ts）；业务流通道（qa / tools / reports）归各自 Commit，本模块不预建。

import { AppError, ERROR_CODES, errorCodeOf, type ErrorEnvelope } from './database/errors'

// ── 端点与事件名（§六 已实测事实） ────────────────────────────────────────────

/** §六 实测：`GET /health` → 200 {"ok":true,"status":"live"}；OpenAI 兼容面在 /v1/* */
export const GATEWAY_ENDPOINTS = {
  health: '/health',
  models: '/v1/models',
  chatCompletions: '/v1/chat/completions'
} as const

/**
 * SSE → IPC 透传的事件名（主进程 → 渲染进程）。
 *
 * 08/09 的渲染端按 `runId` 归并自己的流：chunk* → done | error。
 * `cancel` 刻意**没有**事件：中止由渲染端发起，它自己知道，不需要回执。
 */
export const GATEWAY_STREAM_EVENTS = {
  chunk: 'work:stream:chunk',
  done: 'work:stream:done',
  error: 'work:stream:error'
} as const

/** §六 实测：`model` 取值是 `openclaw`（默认 agent）或 `openclaw/<agentId>` */
export const GATEWAY_MODEL_DEFAULT = 'openclaw'

/** `openclaw` / `openclaw/<agentId>`；agentId 段不允许再出现 `/`（`model` 是路由键，不是路径） */
export const GATEWAY_MODEL_PATTERN = /^openclaw(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/

/** §6.4 会话隔离键前缀：`conv:work:qa` / `conv:work:tool:{toolId}` / `conv:work:report:{type}:{period}` */
export const CONVERSATION_USER_PREFIX = 'conv:'

/**
 * §6.4 会话键合法形状（三类键的交集）：`conv:` 开头，后跟小写字母/数字/下划线/冒号/连字符。
 *
 * 防注入：空白、换行、大写、其他符号一律拒——任一非法字符都能伪造出别人的会话边界。
 */
export const CONVERSATION_KEY_PATTERN = /^conv:[a-z0-9][a-z0-9:_-]*$/

/** abort（用户点「停止生成」）在 `details.reason` 上的判别值 —— §五 无专用码，见汇报「待拍板」 */
export const GATEWAY_ABORT_REASON = 'aborted'

/** 超时/连接失败的 `details.reason` 判别值（前端按 code + reason 分支，不解析 message） */
export const GATEWAY_TIMEOUT_REASONS = {
  request: 'timeout',
  idle: 'idle-timeout',
  connect: 'connect-failed',
  endpointDisabled: 'endpoint-disabled',
  startFailed: 'start-failed',
  streamTruncated: 'stream-truncated',
  upstream: 'upstream-error'
} as const

/** §六：SSE 首字 1.27s / 非流式冷启动 80.3s → 默认值按「控制面短、数据面等得起」来定 */
export const GATEWAY_DEFAULT_TIMEOUTS = {
  /** `GET /health`（实测 97ms；控制面超时短，避免 UI 卡住） */
  healthTimeoutMs: 2_000,
  /** `GET /v1/models` */
  modelsTimeoutMs: 3_000,
  /** 非流式 chat 的**整体**超时（冷启动实测 80.3s，默认给 120s） */
  requestTimeoutMs: 120_000,
  /** 流式：等响应头 + 每个 chunk 之间的空闲超时（首字实测 1.27s） */
  streamIdleTimeoutMs: 120_000,
  /** 就绪轮询总预算：网关进程起来到监听端口之间的窗口 */
  readyTimeoutMs: 90_000,
  /** 就绪轮询间隔 */
  readyPollIntervalMs: 500
} as const

// ── 类型：请求体 ──────────────────────────────────────────────────────────────

export type GatewayContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | GatewayContentPart[]
}

/** `usage` 恒为 0（§六 实测）—— 只做透传，绝不据此做预算或计费 */
export interface GatewayUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

/** 模型选择配置（写死规则见 `selectGatewayModel`） */
export interface GatewayModels {
  /** 纯文本默认模型（`openclaw` / `openclaw/<agentId>`） */
  text: string
  /** 含图请求使用的多模态模型；null/undefined = 当前配置不支持图片输入 */
  multimodal?: string | null
}

export interface GatewayChatInput {
  /** §6.4 完整会话键：`conv:work:qa` / `conv:work:tool:{toolId}` / `conv:work:report:{type}:{period}` */
  conversationKey: string
  messages: GatewayChatMessage[]
  /** true = SSE 流式（产品必须走流式：§6.5 首字 ≤3s vs 冷启动 80.3s） */
  stream?: boolean
  /** 显式指定模型（仍受形态白名单约束）；不给则按 text/multimodal 规则选 */
  model?: string
  temperature?: number
  /** 外部中止信号（组件卸载 / 切换会话）；与 `handle.cancel()` 等价 */
  signal?: AbortSignal
}

export interface GatewayStreamDelta {
  /** 增量序号（从 1 开始，顺序即 SSE 顺序） */
  index: number
  /** 本次增量文本（可能为空串——只有 usage/finish 帧时） */
  delta: string
}

export interface GatewayStreamResult {
  text: string
  chunks: number
  usage: GatewayUsage | null
  model: string | null
  /** 客户端主动中止（用户点「停止生成」）时为 true */
  aborted: boolean
  ms: number
}

export interface GatewayStreamHandle {
  iterator: AsyncIterable<GatewayStreamDelta>
  /** 流结束（或失败）时 settle；`aborted:true` 时也 resolve，只有真错误才 reject */
  result: Promise<GatewayStreamResult>
  /** 中止：断开**上游**连接并停止产出（之后不再有任何增量/事件） */
  cancel(): void
}

/** 拉起结果：`started=false` 表示无需拉起（已在跑 / 启动被忽略），调用方继续轮询就绪 */
export interface GatewayStarterResult {
  started: boolean
  reason?: string
}

/**
 * 自动拉起函数（注入）。语义：
 *   - 正常返回 → 客户端继续**轮询**就绪（返回途中网关可能还在冷启动）
 *   - **抛错** → 视为硬失败，映射为 `OPENCLAW_NOT_READY` + `details.reason='start-failed'`
 * 生产实现复用 `clawManager` 的启停（见 main/index.ts），不另起炉灶。
 */
export type GatewayStarter = () => Promise<GatewayStarterResult> | GatewayStarterResult

/**
 * 解析网关**实际监听端口**（注入）。
 *
 * 为什么需要：OpenClaw 在配置端口（默认 3213）被占用时会自动退让到下一端口（实测退让到
 * 3214），并把实际 pid/port 写进 tmp/openclaw/gateway.*.lock。客户端若只探配置端口，
 * 会把「已启动但换了端口」误判成「未启动」。
 *   - 返回有效端口 → 配置端口不就绪时跟随该端口
 *   - 返回 null/undefined 或抛错 → 忽略，继续只探配置端口（绝不因读锁失败阻断调用）
 * 生产实现见 main/index.ts：读锁文件并校验 PID 存活 + stateDir 匹配。
 */
export type GatewayActualPortResolver = () => Promise<number | undefined | null> | number | undefined | null

/** `work:gateway:status` / `ensureReady` 的只读快照（IPC 面契约） */
export interface GatewayStatusSnapshot {
  /** 只有「探活通过 **且** OpenAI 兼容面已开启」才算就绪（否则 AI 调用链必失败） */
  ready: boolean
  port: number
  baseUrl: string
  endpointsEnabled: boolean
  lastError: ErrorEnvelope | null
}

// ── 类型：可注入的 fetch（默认全局 fetch；注入让验收能拿假服务端/假崩溃） ──────

export interface GatewayResponseLike {
  status: number
  ok: boolean
  body?: GatewayReadableLike | null
  text(): Promise<string>
  json(): Promise<any>
}

export interface GatewayReadableLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel?(reason?: unknown): Promise<void>
    releaseLock?(): void
  }
}

export type GatewayFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<GatewayResponseLike>

export interface GatewayClientOptions {
  /** 形如 `http://127.0.0.1:3213`（§六 实测只绑 127.0.0.1） */
  baseUrl: string
  /** `GATEWAY_TOKEN`（硬规则 13：只许出现在主进程） */
  token: string
  /** 端口（快照里回显）；不给则从 baseUrl 解析 */
  port?: number
  /** 模型选择（text / multimodal）—— 构造时快照；要跟随配置变化请用 `modelsResolver` */
  models?: Partial<GatewayModels>
  /**
   * **按次惰性**解析模型选择（优先于 `models`）。
   *
   * 为什么需要：模型能力属于「运行中会变的配置」——全新安装时客户端先于 Setup 构造（providers 为空），
   * 用户在 Setup 里选了支持图片的模型后只走渲染端 reload（主进程不重启），
   * 若把能力做成启动快照，`multimodal` 会一直停在 null，05b 的扫描件识别被
   * `multimodal-model-not-configured` 直接拒掉，直到用户完全重启 App；运行中换 provider 同理。
   * 生产实现在 main/index.ts：每次调用重读 `configManager.getConfig()`。
   */
  modelsResolver?: () => Partial<GatewayModels>
  /** 自动拉起（复用 clawManager 启停）；不给 = 不自动拉起，只探活+轮询 */
  starter?: GatewayStarter
  /**
   * 解析网关实际监听端口（配置端口被占时 OpenClaw 自动退让）；不给 = 只探配置端口。
   * 见 GatewayActualPortResolver。
   */
  actualPortResolver?: GatewayActualPortResolver
  /** 会话键解析（不给则要求调用方显式传 `conversationKey`；硬规则 3） */
  conversationKeyResolver?: (conversationKey?: string) => Promise<string> | string
  /** 日志（默认静默）；探活/拉起/轮询/中止都走这里 */
  logger?: (message: string) => void
  /** 可注入的 fetch（默认全局 fetch） */
  fetchImpl?: GatewayFetch
  timers?: Partial<typeof GATEWAY_DEFAULT_TIMEOUTS>
  /** 就绪轮询用的 sleep（默认 setTimeout；注入让验收不必真等） */
  sleepImpl?: (ms: number) => Promise<void>
  /** 取当前时间（默认 Date.now；注入让验收断言耗时可控） */
  now?: () => number
}

// ── 纯函数：模型选择规则（写死） ──────────────────────────────────────────────

/**
 * `model` 形态校验（§六 实测：只能是 `openclaw` 或 `openclaw/<agentId>`）。
 * 非法值 → VALIDATION_ERROR（不静默替换成默认值：那会把「配错了」变成「AI 变笨了」）。
 */
export function normalizeGatewayModel(value: unknown, field = 'model'): string {
  const model = typeof value === 'string' ? value.trim() : ''
  if (!model) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 不能为空`, {
      field,
      allowed: [GATEWAY_MODEL_DEFAULT, `${GATEWAY_MODEL_DEFAULT}/<agentId>`]
    })
  }
  if (!GATEWAY_MODEL_PATTERN.test(model)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `${field} 不合法：${model}（只能取 openclaw 或 openclaw/<agentId>，见 §六 实测）`,
      { field, value: model, allowed: [GATEWAY_MODEL_DEFAULT, `${GATEWAY_MODEL_DEFAULT}/<agentId>`] }
    )
  }
  return model
}

export function isValidGatewayModel(value: unknown): boolean {
  return typeof value === 'string' && GATEWAY_MODEL_PATTERN.test(value.trim())
}

/**
 * 从 provider 预设模型的 `input` 能力位判断「当前配置能否吃图片」。
 * 写死规则：`input` 含 `'image'` 才算多模态（OpenClaw 预设里 input 就是 `["text"]` / `["text","image"]`）。
 * 映射不到预设（自定义模型/未配置）时返回 false —— 宁可报「未配置多模态模型」，
 * 也不要把图发出去让模型假装看不见。
 */
export function detectMultimodalCapability(model: { input?: unknown } | null | undefined): boolean {
  const input = model?.input
  if (!Array.isArray(input)) return false
  return input.some((v) => typeof v === 'string' && v.trim().toLowerCase() === 'image')
}

/**
 * 模型选择（写死规则）：
 *   - 含图请求 → `multimodal`（必须已配置且形态合法）
 *   - 纯文本   → `text`
 * 含图但 `multimodal` 未配置 → VALIDATION_ERROR + `details.reason='multimodal-model-not-configured'`。
 */
export function selectGatewayModel(
  models: Partial<GatewayModels> | undefined,
  hasImages: boolean
): string {
  const textModel = normalizeGatewayModel(models?.text ?? GATEWAY_MODEL_DEFAULT, 'models.text')
  if (!hasImages) return textModel
  if (models?.multimodal === null || models?.multimodal === undefined || models?.multimodal === '') {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      '当前模型未配置图片输入能力（多模态），已拒绝发送含图请求；请在配置里选择支持图片的模型',
      { reason: 'multimodal-model-not-configured', field: 'models.multimodal' }
    )
  }
  return normalizeGatewayModel(models.multimodal, 'models.multimodal')
}

// ── 纯函数：消息部件 ──────────────────────────────────────────────────────────

export function textPart(text: string): GatewayContentPart {
  return { type: 'text', text: String(text ?? '') }
}

/**
 * 图片部件（data URI）。
 *
 * 为什么默认走 data URI：OpenClaw 的 `gateway.http.endpoints.chatCompletions.images.allowUrl`
 * **默认 false**（「data URIs remain supported」），传 http(s) 链接会被网关拒绝；
 * 05b 的扫描件识别必须用 base64 内联。
 */
export function imageDataPart(dataUri: string): GatewayContentPart {
  const url = typeof dataUri === 'string' ? dataUri.trim() : ''
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '图片必须是 data:image/*;base64,... 形式的 data URI', {
      field: 'image_url.url',
      reason: 'invalid-image-data-uri'
    })
  }
  return { type: 'image_url', image_url: { url } }
}

/** 图片部件（外链）。默认网关 **不允许** 服务端拉取 URL，故这里只做形态校验 + 由调用方自担风险 */
export function imageUrlPart(url: string): GatewayContentPart {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!/^https?:\/\//i.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '图片 URL 必须是 http(s) 地址', {
      field: 'image_url.url',
      reason: 'invalid-image-url'
    })
  }
  return { type: 'image_url', image_url: { url: value } }
}

/** 该消息是否含图片部件（模型选择规则的输入） */
export function messageHasImages(message: GatewayChatMessage): boolean {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some((part) => part?.type === 'image_url')
}

/** 消息里是否有 http(s) 图片链接（网关默认不拉取 URL，命中即需要配置 `images.allowUrl`） */
export function hasRemoteImageUrl(messages: GatewayChatMessage[]): boolean {
  return messages.some((m) => {
    const content = m?.content
    if (!Array.isArray(content)) return false
    return content.some(
      (part) => part?.type === 'image_url' && /^https?:\/\//i.test(String(part.image_url?.url ?? ''))
    )
  })
}

/** §6.4 会话键形状校验（防注入）：必须 `conv:` 开头，且只允许小写字母/数字/下划线/冒号/连字符 */
export function assertConversationKey(conversationKey: string): string {
  const key = typeof conversationKey === 'string' ? conversationKey.trim() : ''
  if (!key) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '缺少 conversationKey（会话隔离键必须在主进程拼装）', {
      field: 'conversationKey'
    })
  }
  if (!CONVERSATION_KEY_PATTERN.test(key)) {
    // 含空白/换行/大写/非法字符都能伪造出别人的会话边界，必须拒
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `conversationKey 形状非法（应形如 conv:work:qa）: ${JSON.stringify(key)}`,
      { field: 'conversationKey' }
    )
  }
  return key
}

/** abort 判别（前端据此区分「我停的」与「超时」） */
export function isGatewayAbortedError(e: unknown): boolean {
  const details = (e as { details?: { reason?: unknown } } | null | undefined)?.details
  return details?.reason === GATEWAY_ABORT_REASON
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

/** 单次请求的中止域：区分「用户中止」「超时」「连接失败」，并支持流式逐帧重新计时 */
class RequestScope {
  readonly controller = new AbortController()
  cancelled = false
  timedOut = false
  phase: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly external?: AbortSignal
  private readonly onExternalAbort?: () => void

  constructor(external?: AbortSignal) {
    if (external) {
      this.external = external
      if (external.aborted) {
        this.cancelled = true
        this.controller.abort()
      } else {
        this.onExternalAbort = () => {
          this.cancelled = true
          this.controller.abort()
        }
        external.addEventListener('abort', this.onExternalAbort, { once: true })
      }
    }
  }

  arm(ms: number, phase: string): void {
    this.clear()
    const wait = Number.isFinite(ms) && ms > 0 ? ms : 1
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.phase = phase
      this.controller.abort()
    }, wait)
    // 不让这个定时器独自 ref 住事件循环（流式结束后进程该能退出）
    ;(this.timer as unknown as { unref?: () => void })?.unref?.()
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.controller.abort()
  }

  dispose(): void {
    this.clear()
    if (this.external && this.onExternalAbort) {
      this.external.removeEventListener('abort', this.onExternalAbort)
    }
  }
}

/** 异步事件队列：SSE 解析（生产者）→ 迭代器（消费者），支持失败传播与结束 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiters: Array<{
    resolve: (r: IteratorResult<T>) => void
    reject: (e: unknown) => void
  }> = []
  private closed = false
  private failure: unknown = null

  push(item: T): void {
    if (this.closed || this.failure) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: item, done: false })
    else this.buffer.push(item)
  }

  close(): void {
    if (this.closed || this.failure) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as never, done: true })
  }

  fail(e: unknown): void {
    if (this.closed || this.failure) return
    this.failure = e
    for (const waiter of this.waiters.splice(0)) waiter.reject(e)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift() as T
        continue
      }
      if (this.failure) throw this.failure
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve, reject) =>
        this.waiters.push({ resolve, reject })
      )
      if (next.done) return
      yield next.value
    }
  }
}

function asErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

// ── GatewayClient ─────────────────────────────────────────────────────────────

export class GatewayClient {
  baseUrl: string
  port: number
  private readonly token: string
  private readonly models: Partial<GatewayModels>
  private readonly modelsResolver?: () => Partial<GatewayModels>
  private readonly starter?: GatewayStarter
  private readonly actualPortResolver?: GatewayActualPortResolver
  private readonly conversationKeyResolver?: (conversationKey?: string) => Promise<string> | string
  private readonly logger?: (message: string) => void
  private readonly fetchImpl: GatewayFetch
  private readonly timers: typeof GATEWAY_DEFAULT_TIMEOUTS
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly now: () => number
  /** 最近一次失败的统一信封（`status()` 只读回显；成功即清空） */
  private lastError: ErrorEnvelope | null = null
  /** 单飞：并发的 ensureReady 共享同一个在途 promise（starter 只可能被调一次） */
  private inflightEnsure: Promise<GatewayStatusSnapshot> | null = null

  constructor(options: GatewayClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'GatewayClient 需要注入式依赖配置')
    }
    const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.trim().replace(/\/+$/, '') : ''
    if (!baseUrl) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'GatewayClient 缺少依赖: baseUrl')
    }
    if (typeof options.token !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'GatewayClient 缺少依赖: token')
    }
    this.baseUrl = baseUrl
    this.port = Number(options.port) > 0 ? Number(options.port) : parsePort(baseUrl)
    this.token = options.token
    this.models = options.models ?? { text: GATEWAY_MODEL_DEFAULT }
    this.modelsResolver = options.modelsResolver
    this.starter = options.starter
    this.actualPortResolver = options.actualPortResolver
    this.conversationKeyResolver = options.conversationKeyResolver
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? ((globalThis.fetch as unknown) as GatewayFetch)
    this.timers = { ...GATEWAY_DEFAULT_TIMEOUTS, ...(options.timers ?? {}) }
    this.sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    this.now = options.now ?? (() => Date.now())
    if (typeof this.fetchImpl !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'GatewayClient 缺少依赖: fetch（本机 fetch 不可用且未注入）')
    }
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /** 当前生效的模型选择：优先按次解析（跟随配置），否则用构造快照 */
  private currentModels(): Partial<GatewayModels> {
    return this.modelsResolver ? this.modelsResolver() : this.models
  }

  /**
   * 任何一次「没成」的调用都让缓存的 ready 快照作废。
   *
   * 为什么：`ensureReady` 只在 ready 时写缓存，而网关进程可能中途挂掉——不主动作废的话，
   * 之后每次 `ensureReady()` 都会直接回那个陈旧快照、连 starter 都不调（复审实测）。
   * 这里**不**自动重试：重试 POST /v1/chat/completions 会再生成一次、白花 token，
   * 让调用方（08/09）显式决定何时重试，而 08 的「重试」按钮会走 ensureReady → 重新探活/拉起。
   */
  private invalidateReadyCache(reason: string): void {
    if (!this.readyCache) return
    this.readyCache = null
    this.log(`[gateway] 就绪缓存作废（${reason}）——下次 ensureReady 会重新探活/拉起`)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /** 把 fetch 层异常/超时/中止翻译成 §五 码（不解析 message） */
  private mapTransferError(e: unknown, scope: RequestScope, path: string): AppError {
    if (scope.cancelled) {
      return new AppError(ERROR_CODES.OPENCLAW_TIMEOUT, 'Gateway 调用已中止', {
        reason: GATEWAY_ABORT_REASON,
        path
      })
    }
    if (scope.timedOut) {
      const idle = scope.phase === 'idle'
      this.invalidateReadyCache('timeout')
      return new AppError(
        ERROR_CODES.OPENCLAW_TIMEOUT,
        idle ? 'Gateway 流式响应空闲超时' : 'Gateway 请求超时',
        { reason: idle ? GATEWAY_TIMEOUT_REASONS.idle : GATEWAY_TIMEOUT_REASONS.request, path, phase: scope.phase }
      )
    }
    const code = errorCodeOf(e)
    if (code) return e as AppError
    this.invalidateReadyCache('connect-failed')
    return new AppError(
      ERROR_CODES.OPENCLAW_NOT_READY,
      `无法连接 OpenClaw Gateway（${this.baseUrl}）：${asErrorMessage(e)}`,
      { reason: GATEWAY_TIMEOUT_REASONS.connect, path, cause: asErrorMessage(e) }
    )
  }

  /** HTTP 状态码 → §五 码（§六 实测：401 unauthorized / 400 invalid_request_error 都是结构化 JSON） */
  private mapHttpError(status: number, rawBody: string, path: string): AppError {
    // 401/403/404/429/5xx 都说明「刚才的 ready」不作数了（token 变了 / 端点被关 / 上游挂了）
    if (status === 401 || status === 403 || status === 404 || status === 429 || status >= 500) {
      this.invalidateReadyCache(`HTTP ${status}`)
    }
    const upstream = parseUpstreamError(rawBody)
    const details = {
      status,
      path,
      upstreamType: upstream?.type ?? null,
      upstreamMessage: upstream?.message ?? (rawBody ? rawBody.slice(0, 500) : null)
    }
    if (status === 401 || status === 403) {
      return new AppError(ERROR_CODES.OPENCLAW_AUTH_ERROR, 'Gateway 鉴权失败（GATEWAY_TOKEN 不匹配）', details)
    }
    if (status === 404) {
      // §六 实测：OpenAI 兼容面默认关闭时 `GET /v1/models` 就是 404
      return new AppError(
        ERROR_CODES.OPENCLAW_NOT_READY,
        'Gateway 的 OpenAI 兼容端点未开启（gateway.http.endpoints.chatCompletions.enabled）',
        { ...details, reason: GATEWAY_TIMEOUT_REASONS.endpointDisabled }
      )
    }
    if (status === 429) {
      return new AppError(ERROR_CODES.OPENCLAW_NOT_READY, 'Gateway 限流（429），请稍后重试', {
        ...details,
        reason: 'rate-limited'
      })
    }
    if (status >= 500) {
      return new AppError(ERROR_CODES.OPENCLAW_NOT_READY, `Gateway 上游错误（HTTP ${status}）`, {
        ...details,
        reason: GATEWAY_TIMEOUT_REASONS.upstream
      })
    }
    return new AppError(ERROR_CODES.VALIDATION_ERROR, `Gateway 拒绝了请求（HTTP ${status}）`, details)
  }

  /**
   * **已经进入响应体之后**的传输中断 → 一律按「响应被截断」而不是「连不上网关」。
   *
   * 理由：网关明明在跑、流到一半断掉，如果把 reason 报成 `connect-failed`，
   * 前端按 §五 的引导会显示「去环境初始化」——既误导，又丢掉「其实已经收到了一部分」这个事实。
   * 超时与主动中止仍按各自语义优先（mapTransferError 里已先行判定）。
   */
  private mapStreamBodyError(e: unknown, scope: RequestScope): AppError {
    const mapped = this.mapTransferError(e, scope, GATEWAY_ENDPOINTS.chatCompletions)
    const details = (mapped.details ?? {}) as Record<string, unknown>
    if (
      mapped.code === ERROR_CODES.OPENCLAW_NOT_READY &&
      details.reason === GATEWAY_TIMEOUT_REASONS.connect
    ) {
      return new AppError(
        ERROR_CODES.OPENCLAW_NOT_READY,
        'SSE 流在收到 [DONE] 之前断开（响应被截断）',
        { ...details, reason: GATEWAY_TIMEOUT_REASONS.streamTruncated }
      )
    }
    return mapped
  }

  private async send(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    scope: RequestScope,
    timeoutMs: number,
    phase = 'request'
  ): Promise<GatewayResponseLike> {
    scope.arm(timeoutMs, phase)
    try {
      return await this.fetchImpl(this.url(path), { ...init, signal: scope.controller.signal })
    } catch (e) {
      throw this.mapTransferError(e, scope, path)
    } finally {
      scope.clear()
    }
  }

  private async readBody(res: GatewayResponseLike): Promise<string> {
    try {
      return await res.text()
    } catch {
      return ''
    }
  }

  // ── 探活 / 端点开关 ────────────────────────────────────────────────────────

  /** `GET /health`：§六 实测 200 + `{"ok":true,"status":"live"}` 即就绪 */
  async probe(): Promise<{ ok: boolean; status: number | null; ms: number; error: ErrorEnvelope | null }> {
    const scope = new RequestScope()
    const startedAt = this.now()
    try {
      const res = await this.send(
        GATEWAY_ENDPOINTS.health,
        { method: 'GET', headers: this.headers({ Accept: 'application/json' }) },
        scope,
        this.timers.healthTimeoutMs,
        'health'
      )
      const ms = this.now() - startedAt
      if (!res.ok) {
        const err = this.mapHttpError(res.status, await this.readBody(res), GATEWAY_ENDPOINTS.health)
        this.log(`[gateway] 探活失败：HTTP ${res.status}（${ms}ms）`)
        return { ok: false, status: res.status, ms, error: toEnvelope(err) }
      }
      return { ok: true, status: res.status, ms, error: null }
    } catch (e) {
      const envelope = toEnvelope(e)
      this.log(`[gateway] 探活失败：${envelope.code} ${envelope.message}`)
      return { ok: false, status: null, ms: this.now() - startedAt, error: envelope }
    } finally {
      scope.dispose()
    }
  }

  /**
   * `GET /v1/models`：既是「OpenAI 兼容面是否开启」的判据（§六：开关关闭时 404），
   * 也是模型清单来源（实测返回 `openclaw` / `openclaw/default` / `openclaw/main`）。
   */
  async listModels(): Promise<{ enabled: boolean; models: string[]; error: ErrorEnvelope | null }> {
    const scope = new RequestScope()
    try {
      const res = await this.send(
        GATEWAY_ENDPOINTS.models,
        { method: 'GET', headers: this.headers({ Accept: 'application/json' }) },
        scope,
        this.timers.modelsTimeoutMs,
        'models'
      )
      if (!res.ok) {
        const err = this.mapHttpError(res.status, await this.readBody(res), GATEWAY_ENDPOINTS.models)
        return { enabled: false, models: [], error: toEnvelope(err) }
      }
      const json = await parseJsonSafe(res)
      if (!json || !Array.isArray(json.data)) {
        // 200 但结构不对（非 JSON / 缺 data）不能当「已开启」——否则就绪判定会把废物当绿灯
        return {
          enabled: false,
          models: [],
          error: {
            code: ERROR_CODES.OPENCLAW_NOT_READY,
            message: '模型清单响应结构不符合预期（缺 data 数组）',
            details: { status: res.status, path: GATEWAY_ENDPOINTS.models, reason: 'unexpected-response' }
          }
        }
      }
      const list = json.data
      return {
        enabled: true,
        models: list.map((m: any) => String(m?.id ?? '')).filter(Boolean),
        error: null
      }
    } catch (e) {
      return { enabled: false, models: [], error: toEnvelope(e) }
    } finally {
      scope.dispose()
    }
  }

  // ── 就绪快照 / 自动拉起 ────────────────────────────────────────────────────

  /**
   * 只读快照（`work:gateway:status`）：**只发 GET /health + GET /v1/models，零 token**，
   * 绝不触发自动拉起、绝不调 chat。就绪 = 探活通过 **且** 兼容面已开。
   */
  async getStatus(): Promise<GatewayStatusSnapshot> {
    const first = await this.checkReadyAtCurrentPort()
    if (first.ready) return first
    // 配置端口不就绪：OpenClaw 可能因端口被占退让到了别的端口（实测 3213→3214），
    // 从锁文件解析实际端口并跟随一次；解析不到则维持配置端口的事实快照
    const actualPort = await this.resolveActualPort()
    if (actualPort && this.switchPort(actualPort)) {
      this.log(`[gateway] 配置端口未就绪，跟随锁文件实际端口 ${actualPort}`)
      return this.checkReadyAtCurrentPort()
    }
    return first
  }

  /** 按当前 baseUrl 探活 + 查兼容面，构造就绪快照 */
  private async checkReadyAtCurrentPort(): Promise<GatewayStatusSnapshot> {
    const probe = await this.probe()
    if (!probe.ok) {
      this.lastError = probe.error
      return this.snapshot(false, false, probe.error)
    }
    const models = await this.listModels()
    const ready = models.enabled
    this.lastError = ready ? null : models.error
    return this.snapshot(ready, models.enabled, models.error)
  }

  /** 读实际端口；解析器缺失/抛错一律视为「解析不到」，绝不阻断调用 */
  private async resolveActualPort(): Promise<number | null> {
    if (!this.actualPortResolver) return null
    try {
      const port = Number(await this.actualPortResolver())
      return port > 0 ? port : null
    } catch (e) {
      this.log(`[gateway] 实际端口解析失败（忽略）：${asErrorMessage(e)}`)
      return null
    }
  }

  /**
   * 切换到新端口；同端口或非法值返回 false。
   * 用 URL 级改写（不是字符串尾匹配）：带路径的 baseUrl 只换端口、路径原样保留；
   * URL 解析失败或无显式端口 → 不切换，port 与 baseUrl 绝不分叉。
   */
  private switchPort(port: number): boolean {
    const next = Number(port)
    if (!(next > 0) || next === this.port) return false
    let parsed: URL
    try {
      parsed = new URL(this.baseUrl)
    } catch {
      return false
    }
    if (!parsed.port) return false
    parsed.port = String(next)
    this.baseUrl = parsed.toString().replace(/\/+$/, '')
    this.port = next
    return true
  }

  private snapshot(
    ready: boolean,
    endpointsEnabled: boolean,
    error: ErrorEnvelope | null
  ): GatewayStatusSnapshot {
    return {
      ready,
      port: this.port,
      baseUrl: this.baseUrl,
      endpointsEnabled,
      lastError: error ?? null
    }
  }

  /**
   * 探活 → 按需自动拉起（starter **一次且只一次**）→ 就绪轮询 → 快照。
   *
   * 幂等 + 单飞：并发调用共享同一个在途 promise；已经就绪时**不**调 starter。
   * 拉起后仍未就绪（轮询预算用尽）→ `OPENCLAW_TIMEOUT`；starter 抛错 → `OPENCLAW_NOT_READY`。
   */
  async ensureReady(): Promise<GatewayStatusSnapshot> {
    if (this.readyCache?.ready) return this.readyCache
    if (this.inflightEnsure) return this.inflightEnsure
    const run = this.ensureReadyInternal().finally(() => {
      this.inflightEnsure = null
    })
    this.inflightEnsure = run
    return run
  }

  /** 就绪快照缓存（只在 ready 时缓存，避免「探活一半」状态被当成事实） */
  private readyCache: GatewayStatusSnapshot | null = null

  private async ensureReadyInternal(): Promise<GatewayStatusSnapshot> {
    const first = await this.getStatus()
    if (first.ready) {
      this.readyCache = first
      return first
    }

    if (this.starter) {
      let started: GatewayStarterResult
      try {
        started = await this.starter()
      } catch (e) {
        const code = errorCodeOf(e)
        const err = new AppError(
          code ?? ERROR_CODES.OPENCLAW_NOT_READY,
          `自动拉起 OpenClaw 失败：${asErrorMessage(e)}`,
          { reason: (e as { details?: { reason?: string } })?.details?.reason ?? GATEWAY_TIMEOUT_REASONS.startFailed }
        )
        this.lastError = toEnvelope(err)
        this.log(`[gateway] 自动拉起失败：${err.message}`)
        throw err
      }
      this.log(`[gateway] 自动拉起结果：${JSON.stringify(started)}`)
    } else {
      this.log('[gateway] 探活失败且未注入 starter，直接进入就绪轮询')
    }

    const deadline = this.now() + this.timers.readyTimeoutMs
    let last: GatewayStatusSnapshot = first
    let polls = 0
    while (this.now() < deadline) {
      await this.sleepImpl(this.timers.readyPollIntervalMs)
      polls += 1
      last = await this.getStatus()
      if (last.ready) {
        this.log(`[gateway] 就绪（轮询 ${polls} 次）`)
        this.readyCache = last
        return last
      }
    }

    const err = new AppError(
      ERROR_CODES.OPENCLAW_TIMEOUT,
      `OpenClaw Gateway 在 ${this.timers.readyTimeoutMs}ms 内未就绪`,
      {
        reason: GATEWAY_TIMEOUT_REASONS.request,
        baseUrl: this.baseUrl,
        polls,
        lastError: last.lastError
      }
    )
    this.lastError = toEnvelope(err)
    this.readyCache = null
    throw err
  }

  // ── 会话隔离键 ────────────────────────────────────────────────────────────

  /** 解析会话键：显式给了就用（形状校验），否则走注入的解析器 */
  async resolveConversationUser(input: GatewayChatInput): Promise<string> {
    const explicit = typeof input?.conversationKey === 'string' ? input.conversationKey.trim() : ''
    if (explicit) return assertConversationKey(explicit)
    if (!this.conversationKeyResolver) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        '缺少 conversationKey 且未注入 conversationKeyResolver（会话隔离键必须在主进程拼装）',
        { field: 'conversationKey' }
      )
    }
    const key = await this.conversationKeyResolver(undefined)
    return assertConversationKey(String(key ?? ''))
  }

  // ── chat：请求体组装 ──────────────────────────────────────────────────────

  private async buildChatBody(input: GatewayChatInput, stream: boolean): Promise<Record<string, unknown>> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'chat 需要一个入参对象')
    }
    const messages = normalizeMessages(input.messages)
    const hasImages = messages.some(messageHasImages)
    if (hasImages && hasRemoteImageUrl(messages)) {
      // 网关默认 `images.allowUrl=false`（data URI 才无条件支持）——显式告警而不是静默失败
      this.log('[gateway] ⚠️ 含 http(s) 图片链接：网关 images.allowUrl 默认 false，建议改用 data URI（05b）')
    }
    const model =
      input.model === undefined || input.model === null || input.model === ''
        ? selectGatewayModel(this.currentModels(), hasImages)
        : normalizeGatewayModel(input.model)
    const user = await this.resolveConversationUser(input)
    const body: Record<string, unknown> = { model, messages, stream, user }
    if (input.temperature !== undefined && input.temperature !== null) {
      // 超范围/非法值 → VALIDATION_ERROR，不静默丢弃：
      // 静默丢会把「配置写错了」变成「参数设了没反应」的幽灵 bug（与 businessManager 同口径）
      const temperature = Number(input.temperature)
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `temperature 必须在 0~2 之间（实际 ${String(input.temperature)}）`,
          { field: 'temperature', value: input.temperature, min: 0, max: 2 }
        )
      }
      body.temperature = temperature
    }
    return body
  }

  /** 非流式调用（一次性拿全文；冷启动实测 80.3s，产品主路径仍应走流式） */
  async chat(input: GatewayChatInput): Promise<GatewayStreamResult> {
    const startedAt = this.now()
    const body = await this.buildChatBody({ ...input, stream: false }, false)
    const scope = new RequestScope(input?.signal)
    try {
      const res = await this.send(
        GATEWAY_ENDPOINTS.chatCompletions,
        {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          body: JSON.stringify(body)
        },
        scope,
        this.timers.requestTimeoutMs,
        'request'
      )
      if (!res.ok) throw this.mapHttpError(res.status, await this.readBody(res), GATEWAY_ENDPOINTS.chatCompletions)
      const json = await parseJsonSafe(res)
      const content = json?.choices?.[0]?.message?.content ?? ''
      const text = typeof content === 'string' ? content : ''
      return {
        text,
        chunks: text ? 1 : 0,
        usage: (json?.usage ?? null) as GatewayUsage | null,
        model: typeof json?.model === 'string' ? json.model : null,
        aborted: false,
        ms: this.now() - startedAt
      }
    } finally {
      scope.dispose()
    }
  }

  /**
   * SSE 流式调用：立刻返回 handle（迭代器 + `result` + `cancel()`）。
   *
   * - abort 语义（**下游**）：`cancel()` 或外部 `signal` → 立刻停止产出，之后不再有增量。
   * - abort 语义（**上游**）：`AbortController.abort()` 让 undici **销毁 socket**，
   *   不只是停止读取 —— 服务端会看到连接关闭（验收在假服务端侧断言到了这一点）。
   *   客户端侧拿到的是可识别的「已中止」（`details.reason='aborted'`），不是超时。
   */
  createChatStream(input: GatewayChatInput): GatewayStreamHandle {
    const queue = new AsyncEventQueue<GatewayStreamDelta>()
    const scope = new RequestScope(input?.signal)
    const startedAt = this.now()
    let chunks = 0
    let text = ''
    let usage: GatewayUsage | null = null
    let model: string | null = null

    const result: Promise<GatewayStreamResult> = (async () => {
      try {
        const body = await this.buildChatBody({ ...input, stream: true }, true)
        const res = await this.send(
          GATEWAY_ENDPOINTS.chatCompletions,
          {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
            body: JSON.stringify(body)
          },
          scope,
          this.timers.streamIdleTimeoutMs,
          'idle'
        )
        if (!res.ok) {
          throw this.mapHttpError(res.status, await this.readBody(res), GATEWAY_ENDPOINTS.chatCompletions)
        }
        const bodyStream = res.body
        if (!bodyStream) {
          throw new AppError(ERROR_CODES.OPENCLAW_NOT_READY, 'Gateway 未返回 SSE 响应体', {
            reason: GATEWAY_TIMEOUT_REASONS.streamTruncated
          })
        }
        const consumed = await this.consumeSse(bodyStream, scope, (delta) => {
          chunks += 1
          text += delta.delta
          queue.push(delta)
        })
        usage = consumed.usage
        model = consumed.model
        if (!consumed.done && !consumed.aborted) {
          throw new AppError(
            ERROR_CODES.OPENCLAW_NOT_READY,
            'SSE 流在收到 [DONE] 之前结束（响应被截断）',
            { reason: GATEWAY_TIMEOUT_REASONS.streamTruncated, chunks }
          )
        }
        queue.close()
        return {
          text,
          chunks,
          usage,
          model,
          aborted: consumed.aborted,
          ms: this.now() - startedAt
        }
      } catch (e) {
        if (scope.cancelled) {
          // 主动中止（用户点「停止生成」/ 组件卸载）：**无论中止发生在响应头之前还是之后**
          // 一律按契约 resolve `{ aborted: true }`。
          // 否则调用方直接 await result 时，得同时处理「resolve 的 aborted」和「reject 的中止」
          // 两种时序，很容易漏一个（外部复审指出，已用 G23 固定住）
          queue.close()
          return { text, chunks, usage, model, aborted: true, ms: this.now() - startedAt }
        }
        const err = errorCodeOf(e) ? e : this.mapTransferError(e, scope, GATEWAY_ENDPOINTS.chatCompletions)
        queue.fail(err)
        throw err
      } finally {
        scope.dispose()
      }
    })()
    // 调用方可能只消费迭代器而从不 await result：这里吞掉「无人接收」的 rejection
    result.catch(() => undefined)

    return {
      iterator: queue,
      result,
      cancel: () => {
        scope.cancel()
        queue.close()
      }
    }
  }

  /** 解析 SSE 帧 → 增量回调；返回是否收到 `[DONE]` 与统计 */
  private async consumeSse(
    body: GatewayReadableLike,
    scope: RequestScope,
    onDelta: (delta: GatewayStreamDelta) => void
  ): Promise<{ done: boolean; aborted: boolean; usage: GatewayUsage | null; model: string | null }> {
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let index = 0
    let done = false
    let aborted = false
    let usage: GatewayUsage | null = null
    let model: string | null = null

    try {
      while (!done) {
        scope.arm(this.timers.streamIdleTimeoutMs, 'idle')
        let chunk: { done: boolean; value?: Uint8Array }
        try {
          chunk = await reader.read()
        } catch (e) {
          if (scope.cancelled) {
            aborted = true
            break
          }
          throw this.mapStreamBodyError(e, scope)
        } finally {
          scope.clear()
        }
        if (chunk.done) break
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '')
          if (!line || line.startsWith(':')) continue
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            done = true
            break
          }
          let frame: any
          try {
            frame = JSON.parse(payload)
          } catch {
            this.log(`[gateway] 跳过无法解析的 SSE 帧：${payload.slice(0, 120)}`)
            continue
          }
          if (frame?.error) {
            const upstream = frame.error
            throw new AppError(
              ERROR_CODES.OPENCLAW_NOT_READY,
              `Gateway 流内错误：${upstream?.message ?? 'unknown'}`,
              { reason: GATEWAY_TIMEOUT_REASONS.upstream, upstreamType: upstream?.type ?? null }
            )
          }
          if (frame?.usage) usage = frame.usage as GatewayUsage
          if (typeof frame?.model === 'string') model = frame.model
          const choice = Array.isArray(frame?.choices) ? frame.choices[0] : null
          const delta = choice?.delta?.content ?? choice?.message?.content ?? ''
          if (typeof delta === 'string' && delta.length > 0) {
            index += 1
            onDelta({ index, delta })
          }
        }
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        /* 忽略 */
      }
    }
    return { done, aborted, usage, model }
  }

  /** 读快照里的 lastError（诊断用；`status()` 也会回显） */
  getLastError(): ErrorEnvelope | null {
    return this.lastError
  }
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  return new GatewayClient(options)
}

// ── SSE → IPC 透传助手（07 交付、08/09 使用） ──────────────────────────────────

/** 只需要 `send` 的结构化 webContents（不 import electron：纯 Node 可测，假对象只打点 send） */
export interface GatewayStreamSink {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
  /** 可选：渲染进程销毁时自动中止上游（避免白烧 token） */
  once?(event: string, listener: () => void): void
}

function isStreamHandle(source: unknown): source is GatewayStreamHandle {
  return Boolean(source) && typeof (source as GatewayStreamHandle).cancel === 'function'
}

/**
 * 把流式增量按事件名推给渲染进程（**07 只提供助手，不注册业务流通道**；通道归 08/09）。
 *
 * - `work:stream:chunk` → `{ runId, index, delta }`
 * - `work:stream:done`  → `{ runId, chunks, text, aborted }`
 * - `work:stream:error` → `{ runId, error: { code, message, details? } }`
 * - `cancel()`：**先中止上游，再停止推送**；cancel 之后一个事件都不再发（UI 自己知道是它停的）
 */
export function forwardGatewayStream(
  webContents: GatewayStreamSink,
  runId: string,
  source: AsyncIterable<GatewayStreamDelta> | GatewayStreamHandle
): { cancel: () => void; done: Promise<void> } {
  const id = String(runId)
  let cancelled = false
  const handle = isStreamHandle(source) ? source : null
  const iterator: AsyncIterable<GatewayStreamDelta> = handle ? handle.iterator : (source as AsyncIterable<GatewayStreamDelta>)

  const done = (async () => {
    let chunks = 0
    try {
      for await (const delta of iterator) {
        if (cancelled) break
        if (webContents.isDestroyed?.()) {
          cancelled = true
          handle?.cancel()
          break
        }
        chunks += 1
        webContents.send(GATEWAY_STREAM_EVENTS.chunk, {
          runId: id,
          index: delta.index,
          delta: delta.delta
        })
      }
      if (cancelled) return
      const res = handle ? await handle.result.catch(() => null) : null
      if (cancelled) return
      webContents.send(GATEWAY_STREAM_EVENTS.done, {
        runId: id,
        chunks: res?.chunks ?? chunks,
        text: res?.text ?? null,
        aborted: res?.aborted ?? false
      })
    } catch (e) {
      if (cancelled) return
      webContents.send(GATEWAY_STREAM_EVENTS.error, { runId: id, error: toEnvelope(e) })
    }
  })()
  done.catch(() => undefined)

  const cancelStream = (): void => {
    if (cancelled) return
    cancelled = true
    handle?.cancel()
  }
  // 渲染进程销毁 → 立刻中止上游（冷启动静默期实测最长 80s，窗口关了还在生成＝白烧 token）。
  // 只靠「每个 chunk 到达时查 isDestroyed()」不够：冷启动静默期根本没有 chunk 到达（复审指出）。
  webContents.once?.('destroyed', cancelStream)

  return {
    cancel: cancelStream,
    done
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

function parsePort(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl)
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 0
  }
}

async function parseJsonSafe(res: GatewayResponseLike): Promise<any> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function parseUpstreamError(raw: string): { type?: string; message?: string } | null {
  if (!raw) return null
  try {
    const json = JSON.parse(raw)
    const err = json?.error ?? json
    if (err && typeof err === 'object') {
      return {
        type: typeof err.type === 'string' ? err.type : undefined,
        message: typeof err.message === 'string' ? err.message : undefined
      }
    }
  } catch {
    /* 非 JSON：交给调用方用 rawBody 兜底 */
  }
  return null
}

function toEnvelope(e: unknown): ErrorEnvelope {
  const code = errorCodeOf(e) ?? ERROR_CODES.OPENCLAW_NOT_READY
  const message = e instanceof Error && e.message ? e.message : String(e)
  const details = (e as { details?: unknown } | null | undefined)?.details
  const envelope: ErrorEnvelope = { code, message }
  if (details !== undefined) envelope.details = details
  return envelope
}

function normalizeMessages(messages: unknown): GatewayChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'messages 必须是非空数组', { field: 'messages' })
  }
  return messages.map((raw: any, i: number) => {
    const role = raw?.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `messages[${i}].role 非法`, { field: `messages[${i}].role` })
    }
    const content = raw?.content
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `messages[${i}].content 必须是字符串或部件数组`, {
        field: `messages[${i}].content`
      })
    }
    return { role, content } as GatewayChatMessage
  })
}
