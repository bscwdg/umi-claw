// kernel/plugin.ts —— 插件契约（main 侧）：上下文、模块形状、definePlugin
//
// 插件拿到的**不是** electron，而是一个受限上下文：能力经 ctx 暴露，注册物在停用时
// 由宿主 LIFO 清理（PLAN-4.0 §4.2 / §4.3）。这样停用不会留 IPC handler 或定时器。

import type { PluginId } from './manifest'
import type { PluginServiceBag } from './services'

export interface PluginLogger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export interface PluginJobs {
  /** 周期任务；返回取消函数（宿主停用时也会统一清理） */
  every(intervalMs: number, fn: () => void | Promise<void>, opts?: { name?: string }): () => void
  /** 一次性延时任务；返回取消函数 */
  timeout(delayMs: number, fn: () => void | Promise<void>, opts?: { name?: string }): () => void
  /** 当前存活任务数（插件管理页展示 / 验收断言） */
  count(): number
}

export interface PluginConfigApi {
  get<T = unknown>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  all(): Record<string, unknown>
}

export interface PluginHostInfo {
  /** 宿主版本（4.x.y） */
  version: string
  /** 数据目录（插件自己的数据应放 `<dataDir>/plugins/<id>/`） */
  dataDir: string
  platform: string
}

/**
 * 通道处理函数。第二个参数是**原始 IPC 事件**（Electron 的 IpcMainInvokeEvent）。
 * 之所以透传：work/marketing 的流式通道需要 vent.sender 往渲染端推增量，
 * 内核不解读它，只原样传递，保持与 electron 解耦。
 */
export type PluginIpcHandler = (
  payload?: unknown,
  event?: unknown,
  args?: unknown[]
) => unknown | Promise<unknown>

export interface PluginContext {
  readonly id: PluginId
  readonly version: string
  readonly host: PluginHostInfo
  readonly logger: PluginLogger
  readonly jobs: PluginJobs
  /**
   * 插件配置：**只有 manifest.inject 含 `config` 时才存在**（别名，等价于 services.config）。
   * 没声明就是 undefined——插件不能靠别名绕过注入门禁。
   */
  readonly config?: PluginConfigApi
  /** 按 manifest.inject 注入的宿主能力：没声明的不存在 */
  readonly services: PluginServiceBag
  /** 注册 `plugin:<id>:<method>` 通道（停用自动 removeHandler） */
  registerIpc(method: string, handler: PluginIpcHandler): void
  /**
   * 注册**租约命名空间**下的通道（Phase 2 装箱用，如 `work:records:list`）。
   *
   * 为什么要它：work/marketing 的渲染端已按 `work:*` / `marketing:*` 写死，统一改名
   * 要动 200+ 调用点。租约保留了历史通道名，同时由宿主保证「跨插件唯一 + 仅激活期存在」。
   * 通道必须以 manifest.channels 里的某个命名空间开头，否则拒绝。
   */
  registerChannelIpc(channel: string, handler: PluginIpcHandler): void
  /** 登记额外清理动作（与注册物一起 LIFO 执行；抛错不影响其它清理） */
  onDispose(fn: () => void | Promise<void>): void
}

export interface PluginModule {
  /** 激活：可返回清理函数；抛错 → 插件进入 failed，宿主继续运行 */
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>
  /** 停用钩子（在注册物清理**之后**调用，用于释放插件自己持有的外部资源） */
  deactivate?(): void | Promise<void>
}

export const PLUGIN_IPC_PREFIX = 'plugin:'

/** 通道名唯一来源：`plugin:<id>:<method>` */
export function pluginIpcChannel(id: PluginId, method: string): string {
  // 方法名不允许空白与冒号：通道按 `:` 分三段，方法里再出现 `:` 会让
  // 「plugin:x:a:b」无法判断属于哪个插件（也便于日志/调试解析）。
  if (!method || /[\s:]/.test(method)) {
    throw new Error(`插件方法名非法：${JSON.stringify(method)}（不允许空白与冒号）`)
  }
  return `${PLUGIN_IPC_PREFIX}${id}:${method}`
}

export function definePlugin(mod: PluginModule): PluginModule {
  return mod
}
