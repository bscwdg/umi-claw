// pluginProcessChild.ts —— 第三方插件子进程入口（CJS canonical，由 electron-vite 单独打包）
//
// 这个文件只依赖 Node，不 import electron：utilityProcess 通过 `process.parentPort` 通信；
// 纯 Node 验收用 `process.send` 通信，两条 transport 共用同一套协议。
// 安全边界在 B2 才接权限 allowlist；B1 先保证「插件崩溃/死循环不拖垮宿主 + 生命周期可控」。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type {
  ChildToHostMessage,
  HostToChildMessage
} from './pluginProcessProtocol'
import { isHostToChildMessage } from './pluginProcessProtocol'

type SendFn = (message: ChildToHostMessage) => void

export interface ChildTransport {
  send(message: ChildToHostMessage): void
  onMessage(handler: (message: unknown) => void): () => void
  exit(code: number): void
}

export interface ChildRuntimeOptions {
  send: SendFn
  /** 默认按 .cjs/.js → require，其它 → 动态 import；测试可注入 */
  loadMain?: (mainPath: string) => Promise<Record<string, unknown>>
  hostVersion?: string
  config?: unknown
  onExit?: (code: number) => void
}

export interface ChildRuntime {
  handle(message: unknown): Promise<void>
  dispose(): void
}

const require = createRequire(__filename)

async function defaultLoadMain(mainPath: string): Promise<Record<string, unknown>> {
  try {
    const loaded = require(mainPath) as Record<string, unknown>
    return (loaded?.default ?? loaded) as Record<string, unknown>
  } catch (e) {
    // ESM 入口（.mjs / type=module）不能被 require：回退动态 import（B0 E4 实测可行）
    if ((e as { code?: string })?.code !== 'ERR_REQUIRE_ESM' && (e as { code?: string })?.code !== 'ERR_REQUIRE_ASYNC_MODULE') {
      throw e
    }
    const mod = (await import(pathToFileURL(mainPath).href)) as Record<string, unknown>
    return (mod?.default ?? mod) as Record<string, unknown>
  }
}

export function createChildRuntime(options: ChildRuntimeOptions): ChildRuntime {
  const send = options.send
  const loadMain = options.loadMain ?? defaultLoadMain
  const disposers: Array<() => void> = []
  let handlers = new Map<string, (payload: unknown) => unknown>()
  let cleanup: (() => void) | null = null
  let plugin: Record<string, unknown> | null = null
  let disposed = false
  let nextServiceId = 1
  const servicePending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  const callService = (service: string, method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextServiceId++
      const timer = setTimeout(() => {
        servicePending.delete(id)
        const error = new Error(`服务调用超时：${service}.${method}`)
        ;(error as Error & { code?: string }).code = 'PLUGIN_OPERATION_FAILED'
        reject(error)
      }, 30_000)
      servicePending.set(id, { resolve, reject, timer })
      send({ type: 'service', id, service, method, args })
    })

  const serviceProxy = (service: string): Record<string, (...args: unknown[]) => Promise<unknown>> =>
    new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
      get(_target, method) {
        // await ctx.services.kv 不能把代理当 thenable（否则永久挂起）
        if (method === 'then') return undefined
        if (typeof method !== 'string') return undefined
        return (...args: unknown[]) => callService(service, method, args)
      }
    })

  const ctx = {
    pluginId: '',
    host: { version: options.hostVersion ?? '0.0.0', platform: process.platform },
    config: options.config,
    logger: {
      info: (message: unknown) => send({ type: 'log', level: 'info', message: String(message) }),
      warn: (message: unknown) => send({ type: 'log', level: 'warn', message: String(message) }),
      error: (message: unknown) => send({ type: 'log', level: 'error', message: String(message) })
    },
    jobs: {
      every(intervalMs: number, fn: () => unknown, opts?: { name?: string }) {
        const timer = setInterval(() => {
          try {
            void fn()
          } catch (e) {
            send({ type: 'log', level: 'error', message: `[${opts?.name ?? 'job'}] ${(e as Error)?.message ?? e}` })
          }
        }, intervalMs)
        disposers.push(() => clearInterval(timer))
        return () => clearInterval(timer)
      }
    },
    registerIpc(method: string, handler: (payload: unknown) => unknown): void {
      if (!/^[A-Za-z][\w.-]*$/.test(method)) throw new Error(`非法 IPC 方法名：${method}`)
      handlers.set(method, handler)
    },
    services: {} as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
  }

  async function handleInit(message: Extract<HostToChildMessage, { type: 'init' }>): Promise<void> {
    if (plugin) throw new Error('重复 init')
    ctx.pluginId = message.pluginId
    ctx.config = message.config
    ctx.host.version = message.hostVersion
    ctx.services = Object.fromEntries((message.services ?? []).map((name) => [name, serviceProxy(name)]))
    plugin = await loadMain(message.mainPath)
    const mod = plugin as unknown as {
      activate?: unknown
      default?: { activate?: unknown; deactivate?: unknown }
    }
    if (typeof mod.activate !== 'function' && typeof mod.default?.activate !== 'function') {
      throw new Error('插件缺少 activate')
    }
    send({ type: 'ready', version: ctx.host.version })
  }

  async function handleActivate(): Promise<void> {
    if (!plugin) throw new Error('未 init 就 activate')
    const mod = plugin as unknown as {
      activate?: unknown
      default?: { activate?: unknown; deactivate?: unknown }
    }
    const activate = (typeof mod.activate === 'function' ? mod.activate : mod.default?.activate) as
      | ((context: unknown) => unknown)
      | undefined
    if (typeof activate !== 'function') throw new Error('插件缺少 activate')
    const result = await activate(ctx)
    if (typeof result === 'function') cleanup = result as () => void
    send({ type: 'activated' })
  }

  async function handleDeactivate(): Promise<void> {
    try {
      const mod = plugin as unknown as {
        deactivate?: unknown
        default?: { deactivate?: unknown }
      } | null
      const deactivate = (typeof mod?.deactivate === 'function' ? mod.deactivate : mod?.default?.deactivate) as
        | (() => unknown)
        | undefined
      if (typeof deactivate === 'function') await deactivate()
    } finally {
      if (cleanup) {
        try {
          cleanup()
        } finally {
          cleanup = null
        }
      }
      for (const d of disposers.splice(0)) d()
      handlers = new Map()
      plugin = null
      send({ type: 'deactivated' })
    }
  }

  async function handleInvoke(message: Extract<HostToChildMessage, { type: 'invoke' }>): Promise<void> {
    const handler = handlers.get(message.method)
    if (!handler) {
      send({
        type: 'result',
        id: message.id,
        ok: false,
        error: { code: 'PLUGIN_NOT_FOUND', message: `插件未注册方法 ${message.method}` }
      })
      return
    }
    try {
      const data = await handler(message.payload)
      send({ type: 'result', id: message.id, ok: true, data })
    } catch (e) {
      send({
        type: 'result',
        id: message.id,
        ok: false,
        error: {
          code: (e as { code?: string })?.code ?? 'PLUGIN_OPERATION_FAILED',
          message: (e as Error)?.message ?? String(e)
        }
      })
    }
  }

  async function handle(message: unknown): Promise<void> {
    if (disposed) return
    if (!isHostToChildMessage(message)) {
      send({ type: 'log', level: 'warn', message: `未知消息：${JSON.stringify(message)}` })
      return
    }
    try {
      switch (message.type) {
        case 'init':
          await handleInit(message)
          break
        case 'activate':
          await handleActivate()
          break
        case 'deactivate':
          await handleDeactivate()
          break
        case 'ping':
          send({ type: 'pong', id: message.id })
          break
        case 'invoke':
          await handleInvoke(message)
          break
        case 'service-result': {
          const pending = servicePending.get(message.id)
          if (pending) {
            servicePending.delete(message.id)
            clearTimeout(pending.timer)
            if (message.ok) pending.resolve(message.data)
            else {
              const error = new Error(message.error?.message ?? '服务调用失败')
              ;(error as Error & { code?: string }).code = message.error?.code ?? 'PLUGIN_OPERATION_FAILED'
              pending.reject(error)
            }
          }
          break
        }
        case 'shutdown':
          await handleDeactivate().catch(() => undefined)
          dispose()
          ;(options.onExit ?? ((code: number) => process.exit(code)))(0)
          break
        default: {
          const neverMessage: never = message
          send({ type: 'log', level: 'warn', message: `未处理：${JSON.stringify(neverMessage)}` })
        }
      }
    } catch (e) {
      send({ type: 'log', level: 'error', message: (e as Error)?.stack ?? String(e) })
      // 启动/激活失败必须让进程退出，supervisor 才能归因（不能半死卡住）
      dispose()
      ;(options.onExit ?? ((code: number) => process.exit(code)))(1)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    // 不 reject pending：插件进程正在退出，插件作者未必 await 每个调用；
    // reject 会制造 unhandledRejection 并可能把退出码搞乱。
    for (const [, pending] of servicePending) clearTimeout(pending.timer)
    servicePending.clear()
    for (const d of disposers.splice(0)) d()
    handlers = new Map()
    if (cleanup) {
      try {
        cleanup()
      } catch {
        /* cleanup 失败不掩盖退出 */
      }
      cleanup = null
    }
  }

  // 显式引用类型，避免 tsc 把未使用 import 当错误
  return { handle, dispose }
}

/** Electron utilityProcess 入口 / Node fork 入口自动接线 */
export function startPluginProcessChild(): void {
  const parentPort = (process as unknown as { parentPort?: { on: (e: string, cb: (m: unknown) => void) => void; postMessage: (m: unknown) => void } }).parentPort
  let transport: ChildTransport
  if (parentPort) {
    transport = {
      send: (message) => parentPort.postMessage(message),
      onMessage: (handler) => {
        // Electron child 侧 parentPort 的 message 是 MessageEvent，payload 在 .data；
        // 主进程 UtilityProcess.on('message') 才是裸 payload（electron.d.ts 已对照）。
        parentPort.on('message', (event: unknown) => {
          const data = (event as { data?: unknown })?.data
          handler(data === undefined ? event : data)
        })
        return () => undefined
      },
      exit: (code) => process.exit(code)
    }
  } else if (typeof process.send === 'function') {
    transport = {
      send: (message) => process.send?.(message),
      onMessage: (handler) => {
        const listener = (message: unknown): void => handler(message)
        process.on('message', listener)
        return () => process.off('message', listener)
      },
      exit: (code) => process.exit(code)
    }
  } else {
    throw new Error('pluginProcessChild 必须在 utilityProcess 或 child_process.fork 中运行')
  }

  const runtime = createChildRuntime({
    send: transport.send,
    onExit: transport.exit
  })
  transport.onMessage((message) => {
    void runtime.handle(message)
  })
  process.on('disconnect', () => runtime.dispose())
}

// 只有作为 utilityProcess 入口时才自动启动；Node fork 测试由 wrapper 显式调用 startPluginProcessChild()
if ((process as unknown as { parentPort?: unknown }).parentPort) {
  try {
    startPluginProcessChild()
  } catch (e) {
    process.stderr.write(`CHILD_START_ERROR ${(e as Error)?.stack ?? String(e)}\n`)
    process.exit(1)
  }
}
