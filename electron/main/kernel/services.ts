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

/** 真实服务名（不含 host）；availableServices 与解析共用这一份 */
export const SERVICE_NAMES = ['config', 'db', 'openclaw', 'notifications', 'voice'] as const
export type ServiceName = (typeof SERVICE_NAMES)[number]

/** 工厂入参：插件身份与目录（db 用它定位 migrations） */
export interface ServiceInfo {
  id: string
  dir: string
}

/**
 * 插件自己的数据库。
 *
 * Phase 1 WP2：每个插件一个 `<dataDir>/plugins/<id>/data.db`，迁移由插件自带的
 * `migrations/*.sql` 驱动，表白名单由同一批 SQL 解析生成——插件之间不共享表，
 * 也不允许裸 SQL（只能走这组参数化的 CRUD，宿主按白名单校验）。
 */
export interface PluginDbApi {
  /** 库文件绝对路径（排障用） */
  readonly path: string
  /** 应用插件 migrations（幂等；失败抛错） */
  migrate(): Promise<void>
  list<T = Record<string, unknown>>(table: string, query?: Record<string, unknown>): Promise<T[]>
  get<T = Record<string, unknown>>(table: string, id: unknown): Promise<T | null>
  create<T = Record<string, unknown>>(table: string, values: Record<string, unknown>): Promise<T>
  update(table: string, id: unknown, patch: Record<string, unknown>): Promise<{ changes: number }>
  remove(table: string, id: unknown): Promise<{ deleted: boolean }>
  /** 迁移前快照 */
  backup(reason: string): Promise<{ path: string }>
  /**
   * 释放该服务占用的资源（停用插件时由宿主调用）。
   *
   * 停用即释放是 Phase 1 的策略：插件库里可能有 worker 子进程，留着会白占内存；
   * 重新启用时服务工厂会重新创建。
   */
  dispose?(): Promise<void>
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
  config?: (info: ServiceInfo) => PluginConfigApi
  db?: (info: ServiceInfo) => PluginDbApi
  openclaw?: (info: ServiceInfo) => OpenClawApi
  notifications?: (info: ServiceInfo) => NotificationsApi
  voice?: (info: ServiceInfo) => VoiceApi
}

/** 服务名清单：注册期校验与实际解析用**同一份**（审查 R12） */
export function availableServices(factories: ServiceFactories): string[] {
  const ids = SERVICE_NAMES.filter((name) => typeof factories[name] === 'function')
  return ['host', ...ids]
}
