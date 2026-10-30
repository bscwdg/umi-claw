// kernel/lifecycle.ts —— 插件生命周期：activate / deactivate / dispose（PLAN-4.0 §4.3）
//
// 状态机：validated → activated → deactivated / disabled；任一步抛错 → failed。
// 三条硬约束：
//   1. 注册物（IPC / 定时器 / 插件自报清理）一律进 disposer 栈，**LIFO** 清理；
//   2. 单个插件失败只影响它自己：宿主记录错误、保留数据、继续跑；
//   3. 停用后不留 handler / 定时器（验收会断言 handler 真的被 removeHandler）。

import { pluginIpcChannel, type PluginContext, type PluginJobs, type PluginModule } from './plugin'
import type { PluginRecord, PluginRegistry } from './registry'
import type { PluginServiceBag, ServiceFactories } from './services'

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
  error?: { code: string; stage?: string; message: string; field?: string }
  ipcMethods: string[]
  /** 租约命名空间下注册的通道（Phase 2 装箱用） */
  channels: string[]
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
  /** 宿主路径（透传给 ctx.host.paths；缺省回落到 dataDir） */
  paths?: { appPath: string; resourcesPath: string; isPackaged: boolean; nodePath: string }
  /**
   * 宿主提供的服务工厂（PLAN-4.0 §4.2）。
   *
   * 只有这里注册的服务才可能被注入；每个插件的 `manifest.inject` 必须落在
   * `availableServices(factories)` 里，否则激活时抛「服务未注入」。
   */
  services?: ServiceFactories
  /** 插件配置持久化（缺省仅内存；config 服务工厂优先） */
  persistConfig?: (pluginId: string, values: Record<string, unknown>) => void | Promise<void>
  /** 激活超时，默认 5000ms */
  activationTimeoutMs?: number
  logger?: (line: string) => void
  onStatusChange?: (status: PluginStatus) => void
}

interface ActivePlugin {
  pluginId: string
  module: PluginModule
  disposers: Array<{ label: string; run: () => void | Promise<void> }>
  timers: Set<ReturnType<typeof setTimeout>>
  config: Record<string, unknown>
  /**
   * 该次激活尝试是否已关闭（失败 / 超时 / 停用）。
   *
   * 为什么需要它：activate 超时后插件代码仍在跑，它随后调 ctx.registerIpc / jobs.every
   * 若被接受，就会留下「宿主以为没激活、插件却在跑」的 handler 与定时器（审查 P0）。
   * 关闭后所有注册入口一律 reject，迟到的 cleanup 也会被执行。
   */
  closed: boolean
}

/** ipc 面 → (通道 → 插件 id)。用 WeakMap 让它随 ipc 生命周期回收 */
const CHANNEL_OWNERS = new WeakMap<object, Map<string, string>>()

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5000
/** 单个清理动作的上限：disposer 永不 settle 时不能让启停卡死（审查 P2） */
const CLEANUP_TIMEOUT_MS = 2000

export class PluginHost {
  private readonly registry: PluginRegistry
  private readonly ipc: KernelIpc
  private readonly opts: PluginHostOptions
  private readonly active = new Map<string, ActivePlugin>()
  /** 进行中的激活（并发 setEnabled 去重） */
  private readonly inflight = new Map<string, Promise<PluginStatus>>()
  /** 租约通道 → 插件 id；**按 ipc 面共享**（同一 ipcMain 上多个宿主实例也不该撞通道） */
  private owners(): Map<string, string> {
    let map = CHANNEL_OWNERS.get(this.ipc)
    if (!map) {
      map = new Map<string, string>()
      CHANNEL_OWNERS.set(this.ipc, map)
    }
    return map
  }
  /** 进行中的激活尝试（可被停用打断：置 closed 后迟到注册被拒） */
  private readonly attempts = new Map<string, ActivePlugin>()

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
      channels: [...record.channels].sort(),
      jobCount: record.jobCount,
      contributes: record.manifest.contributes
    }
  }

  /**
   * 激活所有「启用且未激活」的插件；单个失败不影响其它。
   *
   * **并行**：每个插件的激活彼此独立（各自的 attempt/disposers/超时），串行会把
   * 「spawn 便携 node + 建库迁移」的耗时叠加到首屏。用 allSettled 保证一个挂掉/超时
   * 不拖累其它，返回顺序仍按登记顺序，便于 UI 稳定展示。
   */
  async activateAll(): Promise<PluginStatus[]> {
    const targets = this.registry.activationTargets()
    const settled = await Promise.allSettled(
      targets.map((record) => this.activate(record.manifest.id))
    )
    return settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      // activate 自身只在「记录不存在」这类异常时 reject：兜成 failed 状态，不能让一个插件炸穿启动
      const id = targets[index].manifest.id
      return {
        id,
        name: targets[index].manifest.name,
        version: targets[index].manifest.version,
        state: 'failed' as const,
        enabled: targets[index].enabled,
        error: {
          code: 'PLUGIN_ACTIVATION_FAILED',
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        },
        ipcMethods: [],
        channels: [],
        jobCount: 0,
        contributes: targets[index].manifest.contributes
      }
    })
  }

  async activate(id: string): Promise<PluginStatus> {
    const record = this.requireRecord(id)

    // 停用的插件不加载：`activateAll` 已过滤，但直接调 activate 也必须守住这条，
    // 否则「设置里关掉的插件」仍可能被别处误激活（探针用例 A1 抓到的缺陷）。
    if (!record.enabled) {
      this.log(record, '未启用，跳过激活')
      return this.statusOf(record)
    }

    if (record.state === 'activated') return this.statusOf(record)

    // 并发去重：两次 setEnabled(true) 同时进来时只能加载/激活一次，
    // 否则第二次会重复 registerIpc（真实 ipcMain 直接抛 second handler）
    const inflight = this.inflight.get(id)
    if (inflight) return inflight

    const task = this.doActivate(record).finally(() => this.inflight.delete(id))
    this.inflight.set(id, task)
    return task
  }

  private async doActivate(record: PluginRecord): Promise<PluginStatus> {
    const id = record.manifest.id

    const active: ActivePlugin = {
      pluginId: id,
      module: { activate: () => undefined },
      disposers: [],
      timers: new Set(),
      config: {},
      closed: false
    }
    this.attempts.set(id, active)

    try {
      const mod = await this.loadWithTimeout(record)
      if (active.closed) throw new PluginCancelledError('激活过程中被停用')
      active.module = mod
      const ctx = this.createContext(record, active)

      const result = await this.runWithTimeout(() => mod.activate(ctx))
      // 超时 / 停用发生在 activate 进行中：迟到返回的 cleanup 也要执行，状态不能前进
      if (active.closed) {
        if (typeof result === 'function') await safeRun(result, CLEANUP_TIMEOUT_MS)
        throw new PluginCancelledError('激活过程中被停用')
      }
      if (typeof result === 'function') {
        active.disposers.push({ label: 'activate() 返回的 cleanup', run: result })
      }

      this.active.set(id, active)
      record.state = 'activated'
      record.error = undefined
      this.log(record, `已激活（ipc=${record.ipcMethods.size} jobs=${record.jobCount}）`)
    } catch (e) {
      // 失败隔离：关闭该次尝试（迟到注册一律拒绝）→ 回滚已注册的东西 → 标记 failed
      active.closed = true
      await this.rollback(record, active)
      record.state = record.enabled ? 'failed' : 'disabled'
      record.error = {
        code: errorCodeOf(e),
        stage: activationStage(e),
        message: errorMessage(e)
      }
      this.log(record, `激活失败：${record.error.message}`)
    } finally {
      if (this.attempts.get(id) === active) this.attempts.delete(id)
    }

    const status = this.statusOf(record)
    this.opts.onStatusChange?.(status)
    return status
  }

  async deactivate(id: string): Promise<PluginStatus> {
    const record = this.requireRecord(id)

    // 先关掉「在途激活」：否则 activate 在 await 之后继续注册，会留下宿主以为
    // 已停用、实际仍在服务的 handler/定时器（审查 P0 / 对抗用例 A7）。
    const pending = this.attempts.get(id)
    if (pending) pending.closed = true

    const active = this.active.get(id)
    if (active) {
      active.closed = true
      await this.rollback(record, active)
      this.active.delete(id)
      try {
        await active.module.deactivate?.()
      } catch (e) {
        this.log(record, `deactivate 抛错（已忽略）：${errorMessage(e)}`)
      }
    }
    // 从未激活过就别说「deactivated」：保持 validated，只有显式停用才是 disabled
    if (active || !record.enabled) record.state = 'disabled'
    else if (record.state === 'activated') record.state = 'deactivated'
    const status = this.statusOf(record)
    this.opts.onStatusChange?.(status)
    return status
  }

  /** 启停开关：启用 → 立即激活；停用 → 卸载所有注册物 */
  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    const record = this.requireRecord(id)

    // 幂等短路：已经是「启用且激活」时再点一次不该重新走 activate
    // （否则会重复 registerIpc → 撞 second handler，状态被打成 failed 但仍在服务）
    if (enabled && record.enabled && record.state === 'activated') return this.statusOf(record)

    this.registry.setEnabled(id, enabled)
    if (!enabled) return this.deactivate(id)
    if (record.state !== 'validated') {
      record.state = 'validated'
      record.error = undefined
    }
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
        assertOpen(active, id)
        const timer = setInterval(() => {
          void Promise.resolve()
            .then(fn)
            .catch((e) => host.log(record, `定时任务 ${opts?.name ?? ''} 抛错：${errorMessage(e)}`))
        }, intervalMs)
        return host.trackTimer(record, active, timer, opts?.name)
      },
      timeout(delayMs, fn, opts) {
        assertOpen(active, id)
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

    // ── 服务注入：只注入 manifest.inject 里声明的，未声明的不存在 ──────────────
    const services: PluginServiceBag = {}
    for (const name of record.manifest.inject) {
      if (name === 'host') continue
      const value = this.resolveService(name, record)
      if (value === undefined || value === null) {
        const err = new Error(`插件 ${id} 声明的服务不可用：${name}`)
        ;(err as { code?: string }).code = 'SERVICE_NOT_INJECTED'
        throw err
      }
      ;(services as Record<string, unknown>)[name] = value
    }
    // ctx.config 只是 services.config 的别名，必须同样受 inject 门禁（审查 R2）：
    // 没声明 config 的插件不该能读写持久化配置。
    // 停用即释放：插件库的 worker 子进程不该在插件停用后继续占着
    if (services.db?.dispose) {
      const db = services.db
      active.disposers.push({ label: 'db service dispose', run: () => db.dispose!() })
    }

    const injectedConfig = services.config

    return {
      id,
      version: record.manifest.version,
      host: {
        version: this.opts.hostVersion,
        dataDir: this.opts.dataDir,
        platform: this.opts.platform ?? process.platform,
        paths: this.opts.paths ?? {
          appPath: this.opts.dataDir,
          resourcesPath: this.opts.dataDir,
          isPackaged: false,
          nodePath: process.execPath
        }
      },
      logger: {
        info: (m, meta) => this.log(record, `[info] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`),
        warn: (m, meta) => this.log(record, `[warn] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`),
        error: (m, meta) => this.log(record, `[error] ${m}${meta === undefined ? '' : ' ' + safeJson(meta)}`)
      },
      jobs,
      config: injectedConfig,
      services,
      registerIpc: (method, handler) => {
        assertOpen(active, id)
        if (record.ipcMethods.has(method)) {
          throw new Error(`插件 ${id} 重复注册方法：${method}`)
        }
        const channel = pluginIpcChannel(id, method)
        this.ipc.removeHandler(channel)
        // 第三个参数是原始参数数组：work/marketing 的通道有 (id, patch) 这种多参形态
        this.ipc.handle(channel, (event, ...args) => handler(args[0], event, args))
        record.ipcMethods.add(method)
        active.disposers.push({
          label: `ipc ${channel}`,
          run: () => {
            this.ipc.removeHandler(channel)
            record.ipcMethods.delete(method)
          }
        })
      },
      registerChannelIpc: (channel, handler) => {
        assertOpen(active, id)
        const ns = channel.split(':')[0]
        if (!record.manifest.channels.includes(ns)) {
          const err = new Error(
            `插件 ${id} 没有租用通道命名空间 ${JSON.stringify(ns)}（已租：${record.manifest.channels.join(', ') || '无'}）`
          )
          ;(err as { code?: string }).code = 'CHANNEL_NOT_LEASED'
          throw err
        }
        if (channel.startsWith('plugin:')) {
          throw new Error('plugin: 前缀是宿主保留通道，插件请用 registerIpc / 自有租约')
        }
        const owner = this.owners().get(channel)
        if (owner && owner !== id) {
          const err = new Error(`通道 ${channel} 已被插件 ${owner} 占用`)
          ;(err as { code?: string }).code = 'CHANNEL_CONFLICT'
          throw err
        }
        this.owners().set(channel, id)
        this.ipc.removeHandler(channel)
        // 第三个参数是原始参数数组：work/marketing 的通道有 (id, patch) 这种多参形态
        this.ipc.handle(channel, (event, ...args) => handler(args[0], event, args))
        record.channels.add(channel)
        active.disposers.push({
          label: `channel ${channel}`,
          run: () => {
            this.ipc.removeHandler(channel)
            if (this.owners().get(channel) === id) this.owners().delete(channel)
            record.channels.delete(channel)
          }
        })
      },
      onDispose: (fn) => {
        // 迟到的 onDispose 不能静默接受（审查 P2-10）：closed 后直接执行一次并记日志，
        // 否则插件以为清理登记成功、实际永远不会被调用。
        if (active.closed) {
          void Promise.resolve()
            .then(fn)
            .catch((e) => this.log(record, `迟到 onDispose 执行失败：${errorMessage(e)}`))
          this.log(record, '激活已结束，onDispose 立即执行（不再入栈）')
          return
        }
        active.disposers.push({ label: `onDispose(${id})`, run: fn })
      }
    }
  }

  /** 服务解析：每次激活现取（工厂返回单例则由宿主保证） */
  /**
   * 服务解析：**只查 factories 的同名键**（审查 R12）。
   *
   * 早期版本是手写 switch，与 availableServices 是两份真相：新增服务漏改 switch 会
   * 「注册期通过、激活期报不可用」。现在注册期校验与实际解析走同一份键集合。
   */
  private resolveService(name: string, record: PluginRecord): unknown {
    const factories = this.opts.services as Record<string, ((info: { id: string; dir: string }) => unknown) | undefined> | undefined
    const factory = factories?.[name]
    if (typeof factory !== 'function') return undefined
    return factory({ id: record.manifest.id, dir: record.dir })
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

  /** LIFO 清理：单个清理项抛错/卡死都不影响其它项 */
  private async rollback(record: PluginRecord, active: ActivePlugin): Promise<void> {
    const disposers = active.disposers.splice(0).reverse()
    for (const d of disposers) {
      try {
        await withTimeout(
          Promise.resolve().then(d.run),
          CLEANUP_TIMEOUT_MS,
          `清理超时（>${CLEANUP_TIMEOUT_MS}ms）`
        )
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
  // 迟到的 reject 不能变成 unhandledRejection：race 已经结束的 promise 也要有人接住
  promise.catch(() => undefined)
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

/** 已关闭的激活尝试上再注册 → 明确拒绝（迟到回调不能留下永久 handler） */
function assertOpen(active: ActivePlugin, id: string): void {
  if (!active.closed) return
  const err = new Error(`插件 ${id} 的激活已结束（超时/停用/失败），拒绝后续注册`)
  ;(err as { code?: string }).code = 'PLUGIN_ACTIVATION_CLOSED'
  throw err
}

/** 单次激活被停用打断（不是插件自身的错误，对外表现为 disabled） */
class PluginCancelledError extends Error {
  readonly code = 'PLUGIN_ACTIVATION_CANCELLED'
  constructor(message: string) {
    super(message)
    this.name = 'PluginCancelledError'
  }
}

/** 错误发生在哪一步：load（入口加载）/ activate（插件代码）/ unknown */
function activationStage(e: unknown): string {
  if (e instanceof PluginCancelledError) return 'cancelled'
  const stage = (e as { stage?: unknown } | null)?.stage
  if (typeof stage === 'string') return stage
  const message = errorMessage(e)
  if (message.includes('加载插件入口')) return 'load'
  if (message.includes('激活超时')) return 'activate-timeout'
  if (message.includes('拒绝后续注册')) return 'late-register'
  return 'activate'
}

/** 执行插件返回的 cleanup，带超时保护 */
async function safeRun(fn: () => void | Promise<void>, ms: number): Promise<void> {
  try {
    await withTimeout(Promise.resolve().then(fn), ms, `cleanup 超时（>${ms}ms）`)
  } catch {
    // cleanup 失败不影响状态机
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