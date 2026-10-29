// kernel/lifecycle.ts —— 插件生命周期：activate / deactivate / dispose（PLAN-4.0 §4.3）
//
// 状态机：validated → activated → deactivated / disabled；任一步抛错 → failed。
// 三条硬约束：
//   1. 注册物（IPC / 定时器 / 插件自报清理）一律进 disposer 栈，**LIFO** 清理；
//   2. 单个插件失败只影响它自己：宿主记录错误、保留数据、继续跑；
//   3. 停用后不留 handler / 定时器（验收会断言 handler 真的被 removeHandler）。

import { pluginIpcChannel, type PluginContext, type PluginJobs, type PluginModule } from './plugin'
import type { PluginRecord, PluginRegistry } from './registry'

/** 宿主注入的 IPC 面（真实 electron.ipcMain 或测试假件） */
export interface KernelIpc {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
  removeHandler(channel: string): void
}

export interface PluginStatus {
  id: string
  name: string
  version: string
  state: PluginRecord['state']
  enabled: boolean
  error?: { code: string; message: string }
  ipcMethods: string[]
  jobCount: number
  /** 清单贡献点（渲染端注册用） */
  contributes: PluginRecord['manifest']['contributes']
}

export interface PluginHostOptions {
  registry: PluginRegistry
  ipc: KernelIpc
  hostVersion: string
  dataDir: string
  platform?: string
  /** 插件配置持久化（缺省仅内存） */
  persistConfig?: (pluginId: string, values: Record<string, unknown>) => void | Promise<void>
  /** 激活超时，默认 5000ms */
  activationTimeoutMs?: number
  logger?: (line: string) => void
  onStatusChange?: (status: PluginStatus) => void
}

interface ActivePlugin {
  module: PluginModule
  disposers: Array<{ label: string; run: () => void | Promise<void> }>
  timers: Set<ReturnType<typeof setTimeout>>
  config: Record<string, unknown>
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5000

export class PluginHost {
  private readonly registry: PluginRegistry
  private readonly ipc: KernelIpc
  private readonly opts: PluginHostOptions
  private readonly active = new Map<string, ActivePlugin>()

  constructor(opts: PluginHostOptions) {
    this.opts = opts
    this.registry = opts.registry
    this.ipc = opts.ipc
  }

  statuses(): PluginStatus[] {
    return this.registry.list().map((record) => this.statusOf(record))
  }

  statusOf(record: PluginRecord): PluginStatus {
    return {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      state: record.state,
      enabled: record.enabled,
      error: record.error,
      ipcMethods: [...record.ipcMethods].sort(),
      jobCount: record.jobCount,
      contributes: record.manifest.contributes
    }
  }

  /** 激活所有「启用且未激活」的插件；单个失败不影响其它 */
  async activateAll(): Promise<PluginStatus[]> {
    const results: PluginStatus[] = []
    for (const record of this.registry.activationTargets()) {
      results.push(await this.activate(record.manifest.id))
    }
    return results
  }

  async activate(id: string): Promise<PluginStatus> {
    const record = this.requireRecord(id)
    if (record.state === 'activated') return this.statusOf(record)

    const active: ActivePlugin = {
      module: { activate: () => undefined },
      disposers: [],
      timers: new Set(),
      config: {}
    }

    try {
      const mod = await this.loadWithTimeout(record)
      active.module = mod
      const ctx = this.createContext(record, active)

      const result = await this.runWithTimeout(() => mod.activate(ctx))
      if (typeof result === 'function') {
        active.disposers.push({ label: 'activate() 返回的 cleanup', run: result })
      }

      this.active.set(id, active)
      record.state = 'activated'
      record.error = undefined
      this.log(record, `已激活（ipc=${record.ipcMethods.size} jobs=${record.jobCount}）`)
    } catch (e) {
      // 失败隔离：回滚已注册的东西，标记 failed，宿主继续跑
      await this.rollback(record, active)
      record.state = 'failed'
      record.error = { code: errorCodeOf(e), message: errorMessage(e) }
      this.log(record, `激活失败：${record.error.message}`)
    }

    const status = this.statusOf(record)
    this.opts.onStatusChange?.(status)
    return status
  }

  async deactivate(id: string): Promise<PluginStatus> {
    const record = this.requireRecord(id)
    const active = this.active.get(id)
    if (active) {
      await this.rollback(record, active)
      this.active.delete(id)
      try {
        await active.module.deactivate?.()
      } catch (e) {
        this.log(record, `deactivate 抛错（已忽略）：${errorMessage(e)}`)
      }
    }
    record.state = record.enabled ? 'deactivated' : 'disabled'
    const status = this.statusOf(record)
    this.opts.onStatusChange?.(status)
    return status
  }

  /** 启停开关：启用 → 立即激活；停用 → 卸载所有注册物 */
  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    const record = this.requireRecord(id)
    this.registry.setEnabled(id, enabled)
    if (!enabled) return this.deactivate(id)
    record.state = 'validated'
    record.error = undefined
    return this.activate(id)
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.active.keys()]) await this.deactivate(id)
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private requireRecord(id: string): PluginRecord {
    const record = this.registry.get(id)
    if (!record) throw new Error(`未注册的插件：${id}`)
    return record
  }

  private createContext(record: PluginRecord, active: ActivePlugin): PluginContext {
    const id = record.manifest.id
    const host = this

    const jobs: PluginJobs = {
      every(intervalMs, fn, opts) {
        const timer = setInterval(() => {
          void Promise.resolve()
            .then(fn)
            .catch((e) => host.log(record, `定时任务 ${opts?.name ?? ''} 抛错：${errorMessage(e)}`))
        }, intervalMs)
        return host.trackTimer(record, active, timer, opts?.name)
      },
      timeout(delayMs, fn, opts) {
        const timer = setTimeout(() => {
          active.timers.delete(timer)
          record.jobCount = active.timers.size
          void Promise.resolve()
            .then(fn)
            .catch((e) => host.log(record, `延时任务 ${opts?.name ?? ''} 抛错：${errorMessage(e)}`))
        }, delayMs)
        return host.trackTimer(record, active, timer, opts?.name)
      },
      count: () => active.timers.size
    }

    return {
      id,
      version: record.manifest.version,
      host: {
        version: this.opts.hostVersion,
        dataDir: this.opts.dataDir,
        platform: this.opts.platform ?? process.platform
      },
      logger: {
        info: (m, meta) => this.log(record, `[info] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`),
        warn: (m, meta) => this.log(record, `[warn] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`),
        error: (m, meta) => this.log(record, `[error] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`)
      },
      jobs,
      config: {
        get: <T,>(key: string, fallback?: T) =>
          (key in active.config ? (active.config[key] as T) : fallback) as T | undefined,
        set: (key, value) => {
          active.config[key] = value
          void this.opts.persistConfig?.(id, { ...active.config })
        },
        all: () => ({ ...active.config })
      },
      registerIpc: (method, handler) => {
        if (record.ipcMethods.has(method)) {
          throw new Error(`插件 ${id} 重复注册方法：${method}`)
        }
        const channel = pluginIpcChannel(id, method)
        this.ipc.removeHandler(channel)
        this.ipc.handle(channel, (_event, payload) => handler(payload))
        record.ipcMethods.add(method)
        active.disposers.push({
          label: `ipc ${channel}`,
          run: () => {
            this.ipc.removeHandler(channel)
            record.ipcMethods.delete(method)
          }
        })
      },
      onDispose: (fn) => {
        active.disposers.push({ label: `onDispose(${id})`, run: fn })
      }
    }
  }

  private trackTimer(
    record: PluginRecord,
    active: ActivePlugin,
    timer: ReturnType<typeof setTimeout>,
    name?: string
  ): () => void {
    // 定时器不阻止进程退出
    ;(timer as unknown as { unref?: () => void }).unref?.()
    active.timers.add(timer)
    record.jobCount = active.timers.size
    active.disposers.push({
      label: `timer ${name ?? ''}`.trim(),
      run: () => {
        clearInterval(timer)
        clearTimeout(timer)
        active.timers.delete(timer)
        record.jobCount = active.timers.size
      }
    })
    return () => {
      clearInterval(timer)
      clearTimeout(timer)
      active.timers.delete(timer)
      record.jobCount = active.timers.size
    }
  }

  private async loadWithTimeout(record: PluginRecord): Promise<PluginModule> {
    const timeout = this.opts.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS
    const loaded = await withTimeout(record.loadMain(), timeout, `加载插件入口超时（>${timeout}ms）`)
    const mod = (loaded as { default?: PluginModule })?.default ?? (loaded as PluginModule)
    if (!mod || typeof mod.activate !== 'function') {
      throw new Error('插件入口必须导出 { activate(ctx) }（或 default 导出）')
    }
    return mod
  }

  private async runWithTimeout<T>(fn: () => T | Promise<T>): Promise<T> {
    const timeout = this.opts.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS
    return await withTimeout(Promise.resolve().then(fn), timeout, `激活超时（>${timeout}ms）`)
  }

  /** LIFO 清理：单个清理项抛错不影响其它项 */
  private async rollback(record: PluginRecord, active: ActivePlugin): Promise<void> {
    const disposers = active.disposers.splice(0).reverse()
    for (const d of disposers) {
      try {
        await d.run()
      } catch (e) {
        this.log(record, `清理失败 ${d.label}：${errorMessage(e)}`)
      }
    }
    for (const timer of active.timers) {
      clearInterval(timer)
      clearTimeout(timer)
    }
    active.timers.clear()
    record.jobCount = 0
    record.ipcMethods.clear()
  }

  private log(record: PluginRecord, line: string): void {
    this.opts.logger?.(`[plugin:${record.manifest.id}] ${line}`)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      // 注意：这个守卫定时器**不能 unref**。插件 activate 若永不 settle，事件循环里
      // 只剩这个定时器；unref 掉就等于「谁都不会叫醒它」，超时守卫永远不触发（实测卡死）。
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : safeJson(e)
}

function errorCodeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'PLUGIN_ACTIVATION_FAILED'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
