// electron/main/services/conversationKeyRegistry.ts —— 插件会话键解析器的宿主注册表
//
// 为什么要有它：营销插件把 `projectId` 传给宿主 gateway 时，宿主需要
// `conv:<projectId>:<conversation_key>` 的 key。以前宿主直接读插件库 `projects` 表，
// 这是 host→plugin 数据反向依赖（PLAN-5.0 A3a 明确要拆）。
//
// 现在由插件在 activate 时注册 resolver（能读自己的库），停用自动摘除；
// 宿主只负责按 projectId 询问，不认插件内部 schema。

import { AppError, ERROR_CODES } from './errors'

type Resolver = (projectId: string) => Promise<string>

const resolvers = new Map<string, Resolver>()

/** 插件注册自己的会话键解析器；返回摘除函数（适合直接交给 ctx.onDispose） */
export function registerConversationKeyResolver(pluginId: string, fn: Resolver): () => void {
  resolvers.set(pluginId, fn)
  return () => {
    if (resolvers.get(pluginId) === fn) resolvers.delete(pluginId)
  }
}

/**
 * 解析 projectId 对应的会话键。
 *
 * 只问当前已注册的插件；没有任何 resolver（插件未启用/未激活/已停用）时返回
 * OPENCLAW_NOT_READY，而不是回落到宿主直读插件库。
 */
export async function resolveConversationKey(projectId: string): Promise<string> {
  let lastError: unknown = null
  for (const fn of resolvers.values()) {
    try {
      const key = await fn(projectId)
      if (key) return key
    } catch (e) {
      lastError = e
    }
  }
  if (lastError instanceof AppError) throw lastError
  throw new AppError(
    ERROR_CODES.OPENCLAW_NOT_READY,
    lastError instanceof Error
      ? `营销域插件未启用或解析会话键失败：${lastError.message}`
      : '营销域插件未启用：无法派生 Project 会话键'
  )
}
