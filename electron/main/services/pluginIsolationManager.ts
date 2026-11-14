// pluginIsolationManager.ts —— 第三方隔离插件生命周期管理器（PLAN-5.0 Phase 2 P1）
//
// 为什么抽出来：Phase 1 只有 PluginSupervisor（单进程状态机）和测试探针；
// 生产 runtime 需要一个「按插件 id 管理多进程 + 服务桥 + 权限 env」的窄层。
// 这里不直接依赖 electron：fork / env / service 调用由调用方注入，便于单测与换实现。

import { dirname } from 'node:path'
import {
  createPluginSupervisor,
  type ForkPluginProcess,
  type PluginProcessState,
  type PluginSupervisor
} from '../kernel'
import type { PluginPermissions } from '../kernel/manifest'
import { findReparsePoint } from './pluginPermissions'

export interface IsolatedPluginSpec {
  pluginId: string
  name?: string
  version?: string
  /** child 入口（dist-electron/main/pluginProcessChild.js） */
  entry: string
  /** 插件 main.js 绝对路径 */
  mainPath: string
  /** 解包后的插件目录（权限读根） */
  packageDir: string
  /** 插件自己的数据目录 */
  dataDir: string
  services?: string[]
  permissions?: PluginPermissions
  config?: unknown
  serviceTimeoutMs?: number
}

export interface IsolatedPluginStatus {
  pluginId: string
  name: string
  version: string
  state: PluginProcessState
}

export interface PluginIsolationManagerOptions {
  fork: ForkPluginProcess
  hostVersion: string
  buildEnv: (spec: IsolatedPluginSpec) => Record<string, string>
  serviceCall: (pluginId: string, service: string, method: string, args: unknown[]) => Promise<unknown>
  readyTimeoutMs?: number
  serviceTimeoutMs?: number
  logger?: (line: string) => void
}

export interface PluginIsolationManager {
  start(spec: IsolatedPluginSpec): Promise<void>
  stop(pluginId: string): Promise<void>
  stopAll(): Promise<void>
  invoke(pluginId: string, method: string, payload?: unknown): Promise<unknown>
  statuses(): IsolatedPluginStatus[]
}

export function createPluginIsolationManager(
  options: PluginIsolationManagerOptions
): PluginIsolationManager {
  const supervisors = new Map<string, PluginSupervisor>()
  const specs = new Map<string, IsolatedPluginSpec>()

  const get = (pluginId: string): PluginSupervisor => {
    const supervisor = supervisors.get(pluginId)
    if (!supervisor) {
      throw Object.assign(new Error(`隔离插件未启动：${pluginId}`), { code: 'PLUGIN_OPERATION_FAILED' })
    }
    return supervisor
  }

  return {
    async start(spec) {
      if (supervisors.has(spec.pluginId)) {
        throw Object.assign(new Error(`隔离插件已启动：${spec.pluginId}`), { code: 'PLUGIN_OPERATION_FAILED' })
      }
      const reparse = findReparsePoint(spec.packageDir) ?? findReparsePoint(spec.dataDir)
      if (reparse) {
        throw Object.assign(new Error(`插件包包含 reparse point，拒绝启动：${reparse}`), {
          code: 'PLUGIN_PERMISSION_CONFIG_INVALID'
        })
      }
      const supervisor = createPluginSupervisor({
        fork: options.fork,
        readyTimeoutMs: options.readyTimeoutMs,
        serviceTimeoutMs: options.serviceTimeoutMs,
        logger: options.logger,
        onService: (pluginId, service, method, args) =>
          options.serviceCall(pluginId, service, method, args)
      })
      supervisors.set(spec.pluginId, supervisor)
      specs.set(spec.pluginId, spec)
      try {
        await supervisor.start({
          pluginId: spec.pluginId,
          entry: spec.entry,
          mainPath: spec.mainPath,
          dataDir: spec.dataDir,
          hostVersion: options.hostVersion,
          cwd: dirname(spec.mainPath),
          services: spec.services ?? [],
          serviceTimeoutMs: spec.serviceTimeoutMs,
          config: spec.config,
          env: options.buildEnv(spec)
        })
      } catch (e) {
        supervisors.delete(spec.pluginId)
        specs.delete(spec.pluginId)
        await supervisor.stop().catch(() => undefined)
        options.logger?.(`[plugin:${spec.pluginId}] 隔离启动失败：${(e as Error)?.message ?? e}`)
        throw e
      }
    },

    async stop(pluginId) {
      const supervisor = supervisors.get(pluginId)
      if (!supervisor) return
      supervisors.delete(pluginId)
      specs.delete(pluginId)
      await supervisor.stop().catch((e) => {
        options.logger?.(`[plugin:${pluginId}] 隔离停止失败：${(e as Error)?.message ?? e}`)
      })
    },

    async stopAll() {
      const entries = [...supervisors.entries()]
      supervisors.clear()
      specs.clear()
      const results = await Promise.allSettled(entries.map(([, supervisor]) => supervisor.stop()))
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          options.logger?.(
            `[plugin:${entries[index][0]}] 隔离停止失败：${(result.reason as Error)?.message ?? result.reason}`
          )
        }
      }
    },

    invoke(pluginId, method, payload) {
      return get(pluginId).invoke(method, payload)
    },

    statuses() {
      return [...supervisors.entries()].map(([pluginId, supervisor]) => {
        const spec = specs.get(pluginId)
        return {
          pluginId,
          name: spec?.name ?? pluginId,
          version: spec?.version ?? '',
          state: supervisor.state
        }
      })
    }
  }
}
