// pluginSupervisor.ts —— 第三方插件进程 supervisor（PLAN-5.0 Phase 1 B1）
//
// 目标：单插件单进程；宿主只通过 JSON RPC 与子进程交互。
// 关键约束（B0 实测）：
// - 不能用 child-process-gone 监督 utilityProcess，只监听 UtilityProcess.exit；
// - kill 与正常退出在 Windows 都可能是 code 0 → 必须记录「是否主动终止」；
// - 死循环不会退出 → 应用层心跳（ping/pong）超时后 kill；
// - 启动失败/权限配置错误直接 disabled，不做无限重启。
//
// 依赖注入 fork，便于纯 Node 验收覆盖状态机；生产默认用 Electron utilityProcess。

import { EventEmitter } from 'node:events'
import type { PluginProcessSpec, PluginProcessState, HostToChildMessage, ChildToHostMessage } from './pluginProcessProtocol'

export interface ChildProcessLike extends EventEmitter {
  postMessage(message: HostToChildMessage): void
  kill(): boolean | void
  pid?: number
}

export type ForkPluginProcess = (spec: PluginProcessSpec) => ChildProcessLike

export interface PluginSupervisorOptions {
  fork: ForkPluginProcess
  readyTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  backoffMs?: readonly number[]
  crashWindowMs?: number
  crashLimit?: number
  stopTimeoutMs?: number
  logger?: (line: string) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_BACKOFF = [1000, 2000, 4000]

export class PluginSupervisor extends EventEmitter {
  private readonly opts: Required<Omit<PluginSupervisorOptions, 'logger'>> & Pick<PluginSupervisorOptions, 'logger'>
  private child: ChildProcessLike | null = null
  private spec: PluginProcessSpec | null = null
  private _state: PluginProcessState = 'stopped'
  private intentionalExit = false
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null
  private activateWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatDeadline: NodeJS.Timeout | null = null
  private heartbeatId = 0
  private restartTimer: NodeJS.Timeout | null = null
  private readonly crashAt: number[] = []
  private stoppedResolve: (() => void) | null = null

  constructor(options: PluginSupervisorOptions) {
    super()
    this.opts = {
      readyTimeoutMs: 10_000,
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 2_000,
      backoffMs: DEFAULT_BACKOFF,
      crashWindowMs: 5 * 60_000,
      crashLimit: 3,
      stopTimeoutMs: 3000,
      ...options
    }
  }

  get state(): PluginProcessState {
    return this._state
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  private setState(next: PluginProcessState): void {
    if (this._state === next) return
    this._state = next
    this.opts.logger?.(`[plugin-process] ${this.spec?.pluginId ?? '-'} → ${next}`)
    this.emit('state', next)
  }

  async start(spec: PluginProcessSpec): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') return
    if (this._state === 'disabled') throw new Error('插件进程已熔断（disabled），需手动恢复')
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.spec = spec
    this.setState('starting')
    this.intentionalExit = false
    const child = this.opts.fork(spec)
    this.child = child
    // 监听器闭包绑定本次 fork 的 child：旧 generation 的迟到 exit/message 一律忽略
    child.on('message', (message: unknown) => {
      if (this.child !== child) return
      this.onMessage(message)
    })
    child.on('exit', (code: number) => {
      if (this.child !== child) return
      this.onExit(code)
    })
    child.on('error', (error: Error) => this.opts.logger?.(`[plugin-process] fork 失败：${error.message}`))

    try {
      await this.waitReady(child, spec)
      await this.waitActivated(child)
      this.setState('running')
      this.startHeartbeat()
    } catch (e) {
      this.setState('disabled')
      // 启动失败主动 kill：标记 intentional，避免 exit 被当成 crash 触发重启
      this.intentionalExit = true
      this.killChild()
      throw e
    }
  }

  private waitReady(child: ChildProcessLike, spec: PluginProcessSpec): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null
        reject(new Error(`插件进程启动超时（${this.opts.readyTimeoutMs}ms）`))
      }, this.opts.readyTimeoutMs)
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer)
          this.readyWaiter = null
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          this.readyWaiter = null
          reject(e)
        }
      }
      child.postMessage({
        type: 'init',
        pluginId: spec.pluginId,
        mainPath: spec.mainPath,
        dataDir: spec.dataDir,
        hostVersion: spec.hostVersion
      })
    })
  }

  private waitActivated(child: ChildProcessLike): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activateWaiter = null
        reject(new Error('插件 activate 超时'))
      }, this.opts.readyTimeoutMs)
      this.activateWaiter = {
        resolve: () => {
          clearTimeout(timer)
          this.activateWaiter = null
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          this.activateWaiter = null
          reject(e)
        }
      }
      child.postMessage({ type: 'activate' })
    })
  }

  private onMessage(raw: unknown): void {
    const message = raw as ChildToHostMessage
    switch (message?.type) {
      case 'ready':
        this.readyWaiter?.resolve()
        break
      case 'activated':
        this.activateWaiter?.resolve()
        break
      case 'deactivated':
        break
      case 'pong':
        // 只接受当前心跳 id：错误/迟到 pong 不能续命
        if (message.id !== this.heartbeatId) break
        if (this.heartbeatDeadline) {
          clearTimeout(this.heartbeatDeadline)
          this.heartbeatDeadline = null
        }
        break
      case 'result': {
        const pending = this.pending.get(message.id)
        if (!pending) break
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.ok) pending.resolve(message.data)
        else pending.reject(new Error(message.error?.message ?? '插件调用失败'))
        break
      }
      case 'log':
        this.opts.logger?.(`[plugin:${this.spec?.pluginId ?? '?'}] ${message.message}`)
        this.emit('log', message)
        break
      case 'event':
        this.emit('plugin-event', message)
        break
      default:
        this.opts.logger?.(`[plugin-process] 未知子进程消息：${JSON.stringify(message)}`)
    }
  }

  private onExit(code: number): void {
    const wasIntentional = this.intentionalExit
    const wasStarting = this._state === 'starting'
    this.child = null
    this.stopHeartbeat()
    this.rejectPending(new Error('插件进程已退出'))
    this.readyWaiter?.reject(new Error('插件进程启动时退出'))
    this.activateWaiter?.reject(new Error('插件进程激活时退出'))
    if (wasIntentional) {
      // 启动失败时先置 disabled，kill 后的 exit 不能把终态改写回 stopped
      if (this._state !== 'disabled') this.setState('stopped')
      this.stoppedResolve?.()
      this.stoppedResolve = null
      return
    }
    this.opts.logger?.(`[plugin-process] ${this.spec?.pluginId ?? '?'} 异常退出 code=${code}`)
    // 启动阶段就退出（入口不存在/权限 allowlist 配错/语法错误）→ 直接 disabled，不重启
    if (wasStarting) {
      this.setState('disabled')
      return
    }
    this.setState('crashed')
    if (this.exceededCrashBudget()) {
      this.setState('disabled')
      return
    }
    const attempt = this.crashAt.length
    const delay = this.opts.backoffMs[Math.min(attempt - 1, this.opts.backoffMs.length - 1)] ?? 4000
    this.opts.logger?.(`[plugin-process] ${delay}ms 后重启（第 ${attempt} 次）`)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.spec) {
        void this.start(this.spec).catch((e) => {
          this.opts.logger?.(`[plugin-process] 重启失败：${(e as Error).message}`)
        })
      }
    }, delay)
  }

  private exceededCrashBudget(): boolean {
    const now = Date.now()
    this.crashAt.push(now)
    while (this.crashAt.length && now - this.crashAt[0] > this.opts.crashWindowMs) this.crashAt.shift()
    return this.crashAt.length >= this.opts.crashLimit
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== 'running' || !this.child) return
      const id = this.nextRequestId++
      this.heartbeatId = id
      try {
        this.child.postMessage({ type: 'ping', id })
      } catch (e) {
        this.opts.logger?.(`[plugin-process] 心跳发送失败：${(e as Error).message}，按 hang 处理`)
        this.intentionalExit = false
        this.killChild()
        return
      }
      if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
      this.heartbeatDeadline = setTimeout(() => {
        this.heartbeatDeadline = null
        this.opts.logger?.(`[plugin-process] ${this.spec?.pluginId ?? '?'} 心跳超时，判定 hang`)
        this.intentionalExit = false
        this.killChild()
      }, this.opts.heartbeatTimeoutMs)
    }, this.opts.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
    this.heartbeatTimer = null
    this.heartbeatDeadline = null
  }

  private killChild(): void {
    try {
      this.child?.kill()
    } catch {
      /* 已退出 */
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async invoke(method: string, payload?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this._state !== 'running' || !this.child) throw new Error('插件进程未运行')
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件调用超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.postMessage({ type: 'invoke', id, method, payload })
    })
  }

  async stop(): Promise<void> {
    // 先取消待重启/心跳：crashed 状态下 child 已为 null，但 restartTimer 可能还在排队
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.intentionalExit = true
    this.stopHeartbeat()
    if (!this.child) {
      // disabled 是终态，stop 不能把它洗成 stopped 让 start 绕过熔断
      if (this._state !== 'disabled') this.setState('stopped')
      return
    }
    this.setState('stopping')
    const done = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve
    })
    try {
      this.child.postMessage({ type: 'shutdown' })
    } catch {
      this.killChild()
    }
    await Promise.race([
      done,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          this.killChild()
          resolve()
        }, this.opts.stopTimeoutMs)
      )
    ])
    this.stoppedResolve = null
    if (this._state !== 'disabled') this.setState('stopped')
  }

  /** 显式恢复：清空崩溃窗口后允许从 disabled 重新 start */
  reset(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.crashAt.length = 0
    this.stopHeartbeat()
    this.intentionalExit = true
    this.killChild()
    this.setState('stopped')
  }

  async dispose(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.stopHeartbeat()
    this.intentionalExit = true
    this.killChild()
    this.setState('stopped')
  }
}

export function createPluginSupervisor(options: PluginSupervisorOptions): PluginSupervisor {
  return new PluginSupervisor(options)
}
