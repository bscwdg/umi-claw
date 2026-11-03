// electron/main/services/gateway/types.ts —— Gateway 的共享类型（4.2 B4）
//
// 为什么要有这个文件：
//   插件（work/marketing）需要 GatewayClient 的**类型**，但契约规定插件只能 import
//   `electron/main/kernel` 与 `electron/main/services`。此前它们直接 `import type ... from
//   '../../../electron/main/gatewayClient'`——门禁只数「值引用」所以放过了，
//   但类型依赖同样把插件与宿主实现绑死：宿主换实现，插件就编译不过。
//
// 现在类型实体在这里（白名单内），gatewayClient 反向 re-export 保持既有引用面不变。
//
// **不含任何运行时值**：纯类型文件，插件引用它不会把 gateway 实现拖进包里。

import type { ErrorEnvelope } from '../errors'
import type { GatewayContentPart } from './parts'
import type { GatewayStreamDelta } from './stream'

/** 一条对话消息（`content` 可以是纯文本或多模态分片） */
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
  /**
   * §6.4 完整会话键：`conv:work:qa` / `conv:work:tool:{toolId}` / `conv:work:report:{type}:{period}`
   *
   * 2.0 营销域可只给短键（`<conversation_key>`），此时必须同时给 `projectId`，由
   * `buildConversationUser()` 拼成 `conv:<projectId>:<conversation_key>`。
   */
  conversationKey?: string
  /**
   * 2.0 营销域的当前 Project（硬规则 9：显式传参，禁止全局推断）。
   * work 域没有 Project 概念，不传。
   */
  projectId?: string
  messages: GatewayChatMessage[]
  /** true = SSE 流式（产品必须走流式：§6.5 首字 ≤3s vs 冷启动 80.3s） */
  stream?: boolean
  /** 显式指定模型（仍受形态白名单约束）；不给则按 text/multimodal 规则选 */
  model?: string
  temperature?: number
  /** 外部中止信号（组件卸载 / 切换会话）；与 `handle.cancel()` 等价 */
  signal?: AbortSignal
}

export interface GatewayStreamResult {
  text: string
  chunks: number
  usage: GatewayUsage | null
  model: string | null
  /** 客户端主动中止（用户点「停止生成」）时为 true */
  aborted: boolean
  ms: number
  /**
   * 结构化产物的可读交付文本（2.0 shooting_script：版本行 JSON 渲染出的分镜清单）；
   * 其它流为缺省 / null。
   */
  deliverable?: string | null
}

export interface GatewayStreamHandle {
  iterator: AsyncIterable<GatewayStreamDelta>
  /** 流结束（或失败）时 settle；`aborted:true` 时也 resolve，只有真错误才 reject */
  result: Promise<GatewayStreamResult>
  /** 中止：断开**上游**连接并停止产出（之后不再有任何增量/事件） */
  cancel(): void
}

export interface GatewayStatusSnapshot {
  /** 只有「探活通过 **且** OpenAI 兼容面已开启」才算就绪（否则 AI 调用链必失败） */
  ready: boolean
  port: number
  baseUrl: string
  endpointsEnabled: boolean
  lastError: ErrorEnvelope | null
}

/**
 * 插件侧使用的 GatewayClient 窄接口（4.2 B4）。
 *
 * 插件只需要这 4 个方法（实测：chat / createChatStream / ensureReady / getStatus），
 * 不应当依赖整个 GatewayClient 类（它带探活、拉起、端口解析等宿主内部细节）。
 * 用接口而非类类型，还能让测试注入 fake 实现。
 */
export interface GatewayApi {
  getStatus(): Promise<GatewayStatusSnapshot>
  ensureReady(opts?: { readyTimeoutMs?: number }): Promise<GatewayStatusSnapshot>
  chat(input: GatewayChatInput): Promise<GatewayStreamResult>
  createChatStream(input: GatewayChatInput): GatewayStreamHandle
}

/**
 * 兼容别名（4.2 B4）。
 *
 * 插件既有代码按 `GatewayClient` 引用这个类型，但实际只需要 4 个方法。
 * 用别名而不是把整个类类型递出去：宿主换实现时插件的编译不会跟着断，
 * 也让测试能注入 fake 实现。
 */
export type GatewayClient = GatewayApi
