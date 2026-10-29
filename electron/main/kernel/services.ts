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
export const SERVICE_NAMES = ['config', 'db', 'openclaw', 'notifications', 'voice', 'hostOps'] as const
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
  /**
   * 底层方法调用（装箱用逃生门）。`table.op` 形式由 worker 白名单校验，`migrate` / `schema.info` 等
   * 内置方法也走这里——work/marketing 的 Manager 只依赖 database.request，装箱时可以直接复用。
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  /** app_meta 读写（偏好类配置；work/marketing 的提醒与外发开关都落这里） */
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
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

/**
 * 宿主副作用集合（过渡服务，Phase 4 会拆细）。
 *
 * work 装箱时遇到的三类宿主能力：系统通知、渠道外发（spawn OpenClaw CLI）、旧库只读定位。
 * 它们都需要 electron / openclaw 环境，插件侧自己实现不了，所以由宿主以窄方法暴露。
 */
export interface HostOpsApi {
  notify(id: string, payload: { title: string; body: string }): void
  push(
    id: string,
    payload: { title: string; body: string },
    dest: { channel: string; target: string }
  ): Promise<unknown>
  listPushChannels(): Promise<unknown[]>
  listPushTargets(channel: string): Promise<unknown[]>
  locateOldDbs(): unknown[]
  readOldDb(info: unknown): Promise<unknown>
}

/** 注入给插件的服务袋：只有 manifest.inject 里声明的键会出现 */
export interface PluginServiceBag {
  config?: PluginConfigApi
  db?: PluginDbApi
  openclaw?: OpenClawApi
  notifications?: NotificationsApi
  voice?: VoiceApi
  hostOps?: HostOpsApi
}

/** 宿主实际提供的服务名（由 ServiceFactories 的键推导，避免两处写死） */
export interface ServiceFactories {
  config?: (info: ServiceInfo) => PluginConfigApi
  db?: (info: ServiceInfo) => PluginDbApi
  openclaw?: (info: ServiceInfo) => OpenClawApi
  notifications?: (info: ServiceInfo) => NotificationsApi
  voice?: (info: ServiceInfo) => VoiceApi
  hostOps?: (info: ServiceInfo) => HostOpsApi
}

/** 服务名清单：注册期校验与实际解析用**同一份**（审查 R12） */
export function availableServices(factories: ServiceFactories): string[] {
  const ids = SERVICE_NAMES.filter((name) => typeof factories[name] === 'function')
  return ['host', ...ids]
}
