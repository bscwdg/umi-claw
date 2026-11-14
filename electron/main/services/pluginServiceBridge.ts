// pluginServiceBridge.ts —— 第三方插件 ctx.services 的宿主侧代理（PLAN-5.0 Phase 1 B3）
//
// 子进程只拿到 JSON RPC；真正的服务对象留在宿主。每次调用先过 B2 权限 broker，
// 再按 method 名调用宿主服务。禁止把宿主路径/对象直接返回给插件。

import { AppError, ERROR_CODES } from './errors'
import type { PermissionAction, PermissionBroker } from './pluginPermissions'

export interface PluginServiceBridgeOptions {
  /** 按插件 id + 服务名解析宿主服务对象（不存在返回 undefined） */
  resolveService: (pluginId: string, service: string) => unknown
  broker: Pick<PermissionBroker, 'check'>
  logger?: (line: string) => void
}

export interface PluginServiceBridge {
  call(pluginId: string, service: string, method: string, args: unknown[]): Promise<unknown>
}

const FORBIDDEN_METHODS = new Set(['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])
/** 服务级危险方法：第三方不得触达宿主路径/生命周期内部能力 */
const SERVICE_DENY: Record<string, Set<string>> = {
  db: new Set(['backup', 'forPlugin', 'dispose', 'shutdown', 'maintenance']),
  // status 会返回 host port/baseUrl；第三方只允许 chat/模型能力
  openclaw: new Set(['status', 'getStatus'])
}

export function createPluginServiceBridge(options: PluginServiceBridgeOptions): PluginServiceBridge {
  return {
    async call(pluginId, service, method, args) {
      const decision = options.broker.check(pluginId, { type: 'service', name: service } as PermissionAction)
      if (!decision.allowed) {
        throw new AppError(ERROR_CODES.PLUGIN_PERMISSION_DENIED, `服务未授权：${service}`, {
          pluginId,
          service,
          reason: decision.reason
        })
      }
      if (FORBIDDEN_METHODS.has(method) || method.startsWith('__')) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `非法服务方法：${service}.${method}`, { pluginId, service, method })
      }
      if (SERVICE_DENY[service]?.has(method)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `服务方法不对第三方开放：${service}.${method}`, {
          pluginId,
          service,
          method
        })
      }
      const target = options.resolveService(pluginId, service)
      if (!target || typeof target !== 'object') {
        throw new AppError(ERROR_CODES.NOT_FOUND, `宿主不提供该服务：${service}`, { pluginId, service })
      }
      let fn: unknown
      try {
        fn = (target as Record<string, unknown>)[method]
      } catch {
        throw new AppError(ERROR_CODES.NOT_FOUND, `服务方法读取失败：${service}.${method}`, {
          pluginId,
          service,
          method
        })
      }
      if (typeof fn !== 'function') {
        throw new AppError(ERROR_CODES.NOT_FOUND, `服务方法不存在：${service}.${method}`, {
          pluginId,
          service,
          method
        })
      }
      try {
        return await (fn as (...callArgs: unknown[]) => unknown).apply(target, args)
      } catch (e) {
        // 跨 bundle 时 instanceof 不可靠；按 AppError 的 code 形状透传
        const code = (e as { code?: unknown })?.code
        if (typeof code === 'string' && code in ERROR_CODES) throw e
        options.logger?.(`[plugin:${pluginId}] service ${service}.${method} 失败：${(e as Error)?.message ?? e}`)
        throw new AppError(
          ERROR_CODES.PLUGIN_OPERATION_FAILED,
          (e as Error)?.message ?? String(e),
          { pluginId, service, method }
        )
      }
    }
  }
}
