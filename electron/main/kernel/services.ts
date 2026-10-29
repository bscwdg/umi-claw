// kernel/services.ts —— 插件可注入的宿主能力（PLAN-4.0 §4.2 / Phase 1 WP1）
//
// 设计原则：
//   1. **接口在这里，实现在宿主的 services 层**：插件只认这里的结构类型，
//      不 import 任何 manager（否则插件与宿主实现耦合，装箱/换实现就炸）。
//   2. **按 manifest.inject 注入**：没声明的服务在 ctx 上不存在，运行期拿不到。
//   3. 每个服务都是「窄接口」：宁可少给方法，也不把 manager 整个递出去（拒绝上帝 ctx）。

import type { PluginConfigApi } from './plugin'

/** 可注入的服务名（`host` 是伪服务：对应 ctx.host 元信息，保留以兼容早期清单） */
export type ServiceId = 'host' | 'config' | 'db' | 'openclaw' | 'notifications' | 'voice'

/**
 * 插件自己的数据库。
 *
 * Phase 1 WP2 落地：每个插件一个 `<dataDir>/plugins/<id>/data.db`，
 * 迁移由插件自带的 migrations 驱动；插件之间不共享表。
 */
export interface PluginDbApi {
  /** 库文件绝对路径（排障用，不允许跨插件读写） */
  readonly path: string
  /** 执行插件 migrations（幂等；失败抛错） */
  migrate(): Promise<void>
  /** 通用查询：只允许插件自己白名单里的表（宿主校验） */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  /** 通用写入（INSERT/UPDATE/DELETE），返回影响行数 */
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>
  /** 迁移前快照（宿主实现，插件通常不需要直接调） */
  backup(reason: string): Promise<{ path: string }>
}

/** OpenClaw 能力：只给「聊天 / 流式 / 就绪」，不给网关进程控制权 */
export interface OpenClawChatInput {
  /** 完整会话键（`conv:` 开头）或配合 conversationKey + project 语义由宿主解析 */
  conversationKey?: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  stream?: boolean
  model?: string
  temperature?: number
  signal?: AbortSignal
}

export interface OpenClawStatus {
  ready: boolean
  port: number | null
  baseUrl: string | null
  endpointsEnabled: boolean
  lastError?: unknown
}

export interface OpenClawStreamDelta {
  index: number
  delta: string
}

export interface OpenClawStreamHandle {
  iterator: AsyncIterable<OpenClawStreamDelta>
  result: Promise<{ text: string; chunks: number; aborted: boolean }>
  cancel(): void
}

export interface OpenClawApi {
  status(): Promise<OpenClawStatus>
  ensureReady(): Promise<OpenClawStatus>
  chat(input: OpenClawChatInput): Promise<{ text: string; model: string | null }>
  stream(input: OpenClawChatInput): OpenClawStreamHandle
}

/** 系统通知：插件只能发「标题 + 正文」，不能自定义行为 */
export interface NotificationsApi {
  show(input: { title: string; body: string; silent?: boolean }): void
}

/** 语音：跨域能力（work 播报 / marketing 配音都要用），Phase 1 只给朗读 */
export interface VoiceApi {
  speak(input: { text: string; voiceId?: string }): Promise<void>
}

/** 注入给插件的服务袋：只有 manifest.inject 里声明的键会出现 */
export interface PluginServiceBag {
  config?: PluginConfigApi
  db?: PluginDbApi
  openclaw?: OpenClawApi
  notifications?: NotificationsApi
  voice?: VoiceApi
}

/** 宿主实际提供的服务名（由 ServiceFactories 的键推导，避免两处写死） */
export interface ServiceFactories {
  config?: (pluginId: string) => PluginConfigApi
  db?: (pluginId: string) => PluginDbApi
  openclaw?: () => OpenClawApi
  notifications?: () => NotificationsApi
  voice?: () => VoiceApi
}

export function availableServices(factories: ServiceFactories): string[] {
  const ids = Object.keys(factories).filter((k) => typeof (factories as Record<string, unknown>)[k] === 'function')
  return ['host', ...ids]
}
