// pluginProcessProtocol.ts —— 第三方插件子进程 RPC 协议（PLAN-5.0 Phase 1 B1）
//
// 设计约束：
// - 只传 JSON（structured clone 会静默丢函数/类，插件会拿到「看起来有值但调不了」的对象）；
// - 子进程永远不直接碰 Electron / ipcMain / 宿主路径；所有能力经宿主代理；
// - 消息都带 `type`，未知 type 由两端显式拒绝，避免「新字段旧端静默忽略」。

export type PluginProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'disabled'

export interface PluginProcessSpec {
  pluginId: string
  /** 子进程入口（dist-electron/main/pluginProcessChild.js） */
  entry: string
  /** 插件 main 的绝对路径 */
  mainPath: string
  /** 插件自己的数据目录（不是宿主 dataDir） */
  dataDir: string
  hostVersion: string
  /** 子进程 cwd（权限 NODE_OPTIONS 用相对路径，避开空格） */
  cwd?: string
  /** manifest.inject 声明的服务名；子进程按此建 ctx.services 代理 */
  services?: string[]
  /** 额外 env 白名单（B2 权限注入用；不得透传整份 process.env） */
  env?: Record<string, string>
}

export interface PluginInitMessage {
  type: 'init'
  pluginId: string
  mainPath: string
  dataDir: string
  hostVersion: string
  config?: unknown
  services?: string[]
}

export interface PluginActivateMessage {
  type: 'activate'
}

export interface PluginDeactivateMessage {
  type: 'deactivate'
}

export interface PluginPingMessage {
  type: 'ping'
  id: number
}

export interface PluginInvokeMessage {
  type: 'invoke'
  id: number
  method: string
  payload?: unknown
}

export interface PluginShutdownMessage {
  type: 'shutdown'
}

export interface PluginServiceMessage {
  type: 'service'
  id: number
  service: string
  method: string
  /** 位置参数；JSON 可序列化（ctx.services.kv.set('k','v') 必须两个实参） */
  args: unknown[]
}

export type HostToChildMessage =
  | PluginInitMessage
  | PluginActivateMessage
  | PluginDeactivateMessage
  | PluginPingMessage
  | PluginInvokeMessage
  | PluginServiceResultMessage
  | PluginShutdownMessage

export interface PluginReadyMessage {
  type: 'ready'
  version: string
}

export interface PluginActivatedMessage {
  type: 'activated'
}

export interface PluginDeactivatedMessage {
  type: 'deactivated'
}

export interface PluginPongMessage {
  type: 'pong'
  id: number
}

export interface PluginResultMessage {
  type: 'result'
  id: number
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface PluginLogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface PluginEventMessage {
  type: 'event'
  name: string
  payload?: unknown
}

export interface PluginServiceResultMessage {
  type: 'service-result'
  id: number
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export type ChildToHostMessage =
  | PluginReadyMessage
  | PluginActivatedMessage
  | PluginDeactivatedMessage
  | PluginPongMessage
  | PluginResultMessage
  | PluginServiceMessage
  | PluginServiceResultMessage
  | PluginLogMessage
  | PluginEventMessage

export const PLUGIN_PROCESS_CHANNEL = 'umi-plugin-process'

export function isHostToChildMessage(value: unknown): value is HostToChildMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'init' ||
    type === 'activate' ||
    type === 'deactivate' ||
    type === 'ping' ||
    type === 'invoke' ||
    type === 'service-result' ||
    type === 'shutdown'
  )
}

export function isChildToHostMessage(value: unknown): value is ChildToHostMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'ready' ||
    type === 'activated' ||
    type === 'deactivated' ||
    type === 'pong' ||
    type === 'result' ||
    type === 'service' ||
    type === 'service-result' ||
    type === 'log' ||
    type === 'event'
  )
}
