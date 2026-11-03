// kernel/services.ts —— 插件可注入的宿主能力（PLAN-4.0 §4.2 / Phase 1 WP1）
//
// 设计原则：
//   1. **接口在这里，实现在宿主的 services 层**：插件只认这里的结构类型，
//      不 import 任何 manager（否则插件与宿主实现耦合，装箱/换实现就炸）。
//   2. **按 manifest.inject 注入**：没声明的服务在 ctx 上不存在，运行期拿不到。
//   3. 每个服务都是「窄接口」：宁可少给方法，也不把 manager 整个递出去（拒绝上帝 ctx）。

import type { PluginConfigApi } from './plugin'

/** 真实服务名（不含 host）；availableServices 与解析共用这一份 */
export const SERVICE_NAMES = [
  'config',
  'db',
  'openclaw',
  'notifications',
  'voice',
  'secrets',
  'kv',
  'consent',
  'abort',
  'hostOps',
  'legacyDb'
] as const
export type ServiceName = (typeof SERVICE_NAMES)[number]

/**
 * 可注入的服务名（`host` 是伪服务：对应 ctx.host 元信息，保留以兼容早期清单）。
 * 从 SERVICE_NAMES 派生，避免再出现「类型里少了 hostOps/legacyDb」的漂移。
 */
export type ServiceId = 'host' | ServiceName

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
 * 插件密钥（PLAN-4.0 §8.2 / §4.2）。
 *
 * 兑现 §18.3 登记的欠账：契约里一直没有 secrets，插件只能用宿主私有通道。
 * 按 `plugin:<id>:<key>` 命名空间隔离——插件拿不到别的插件的密钥。
 * 只走 safeStorage；加密不可用时拒绝写入（不静默降级成明文）。
 */
export interface PluginSecretsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  clear(key: string): Promise<void>
  /** 已设置的 key 列表（不返回值本体） */
  keys(): Promise<string[]>
  /** 当前环境是否支持加密（false 时 set 会抛错） */
  available(): boolean
}

/**
 * 插件键值偏好（替代直接把宿主 app_meta 的 metaGet/metaSet 递出去）。
 *
 * 与 db.metaGet/metaSet 的区别：那是「插件自己库里的 app_meta」，
 * 这是「宿主持久化的偏好」，由宿主保证命名空间隔离与并发安全。
 */
export interface PluginKvApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<void>
  keys(): Promise<string[]>
}

/**
 * 用户协议共识（4.1.1：宿主单源）。
 *
 * 为什么放进契约：work 插件的 wizardManager 原本自己读写 `wizard_consent`，
 * 而宿主闸门也读同一批键——两边一旦不同步就是「撤销失效」这类真缺陷。
 * 现在权威只有宿主一份，插件通过这个窄接口读写，**不再碰自己的库**。
 *
 * 未注入时插件必须回落自身 db（保持 `test/wizard.accept.mjs` 直接构造 Manager 的用法）。
 */
export interface PluginConsentApi {
  status(): Promise<{ consent: boolean; consentAt: number | null; revokedAt: number | null }>
  grant(): Promise<{ consent: true; consentAt: number }>
  revoke(): Promise<{ consent: false }>
}

/**
 * 后台任务中止登记（4.2 B3）。
 *
 * 为什么放进契约：宿主的退出流程原先直接从 `ipc/index.ts` 取 4 个 `abort*` 函数
 * （实体在 plugins/marketing/main/ipc/*）——宿主反向依赖插件内部实现。
 * 现在改为插件在 activate 时自注册「中止我的后台任务」，停用时自动摘除。
 *
 * 用法：`ctx.onDispose(ctx.services.abort.register(pluginId, fn))`
 */
export interface PluginAbortApi {
  /** 登记中止函数，返回摘除函数（适合直接交给 ctx.onDispose） */
  register(pluginId: string, abort: () => number): () => void
}

/**
 * 宿主副作用集合（过渡服务，Phase 4 会拆细）。
 *
 * work 装箱时遇到的三类宿主能力：系统通知、渠道外发（spawn OpenClaw CLI）、旧库只读定位。
 * 它们都需要 electron / openclaw 环境，插件侧自己实现不了，所以由宿主以窄方法暴露。
 */

/**
 * 旧库只读入口（Phase 2/3 数据迁移）：插件 activate 时把自己的旧库数据搬进插件库。
 * 宿主只暴露「按域读旧库」，写与迁移策略归插件。
 */
export interface LegacyDbApi {
  list<T = unknown>(table: string, params?: { limit?: number; offset?: number }): Promise<T>
}

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
  /**
   * 当前配置的模型是否支持多模态（按次读配置，与网关同源）。
   * 扫描件识别用它做「栅格化前预检」：没配多模态模型就别先花几秒解码 PDF。
   */
  isMultimodalConfigured(): boolean
}

/** 注入给插件的服务袋：只有 manifest.inject 里声明的键会出现 */
export interface PluginServiceBag {
  config?: PluginConfigApi
  db?: PluginDbApi
  openclaw?: OpenClawApi
  notifications?: NotificationsApi
  voice?: VoiceApi
  secrets?: PluginSecretsApi
  kv?: PluginKvApi
  consent?: PluginConsentApi
  abort?: PluginAbortApi
  hostOps?: HostOpsApi
  legacyDb?: LegacyDbApi
}

/** 宿主实际提供的服务名（由 ServiceFactories 的键推导，避免两处写死） */
export interface ServiceFactories {
  config?: (info: ServiceInfo) => PluginConfigApi
  db?: (info: ServiceInfo) => PluginDbApi
  openclaw?: (info: ServiceInfo) => OpenClawApi
  notifications?: (info: ServiceInfo) => NotificationsApi
  voice?: (info: ServiceInfo) => VoiceApi
  secrets?: (info: ServiceInfo) => PluginSecretsApi
  kv?: (info: ServiceInfo) => PluginKvApi
  consent?: (info: ServiceInfo) => PluginConsentApi
  abort?: (info: ServiceInfo) => PluginAbortApi
  hostOps?: (info: ServiceInfo) => HostOpsApi
  legacyDb?: (info: ServiceInfo) => LegacyDbApi
}

/** 服务名清单：注册期校验与实际解析用**同一份**（审查 R12） */
export function availableServices(factories: ServiceFactories): string[] {
  const ids = SERVICE_NAMES.filter((name) => typeof factories[name] === 'function')
  return ['host', ...ids]
}
