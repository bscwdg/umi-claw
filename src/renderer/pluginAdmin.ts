// src/renderer/pluginAdmin.ts —— 插件管理页的纯逻辑（可单测，不依赖 Vue）
//
// 抽出来的原因：管理页最容易出错的不是样式，而是「什么时候要拦用户一下」——
// 停用一个正在被当前页面使用的插件，会直接把脚下页面拆掉（D5 决策）。

import type { PluginStatus } from '../../electron/main/kernel/lifecycle'

/** 规整路径：去尾斜杠、统一小写（vue-router 默认大小写不敏感） */
function normalize(path: string): string {
  const lower = path.toLowerCase()
  if (lower.length > 1 && lower.endsWith('/')) return lower.replace(/\/+$/, '')
  return lower
}

/** 当前路径是否落在该插件贡献的路由里（前缀匹配，`/hello` 命中 `/hello/x`） */
export function matchesPluginRoute(routes: string[] | undefined, path: string): boolean {
  if (!routes?.length) return false
  const target = normalize(path)
  return routes.some((route) => {
    const base = normalize(route)
    // 插件注册 `/` 等于「接管整个壳」，按命中处理（目前没有插件这么做）
    if (base === '/') return true
    return target === base || target.startsWith(base + '/')
  })
}

/** 停用这个插件是否会拆掉当前页面（必须同时是「启用中且已激活」） */
export function disablingBreaksCurrentPage(status: PluginStatus, path: string): boolean {
  return status.enabled && status.state === 'activated' && matchesPluginRoute(status.contributes?.routes, path)
}

/**
 * 是否需要停用前确认（D5）。
 *
 * 管理页本身在 `/plugins`，此刻「当前页面是否属于该插件」几乎永远为否；真正会丢掉
 * 用户手上东西的是「停用一个有页面的插件」——所以判定改为：已启用 + 已激活 + 有路由。
 */
export function shouldConfirmDisable(status: PluginStatus): boolean {
  return status.enabled && status.state === 'activated' && Boolean(status.contributes?.routes?.length)
}

/** 状态文案（中文，管理页与日志共用） */
export function stateLabel(status: PluginStatus): string {
  if (status.state === 'failed') return '加载失败'
  if (!status.enabled) return '已停用'
  switch (status.state) {
    case 'activated':
      return '运行中'
    case 'deactivated':
      return '已停用'
    case 'validated':
      return '待激活'
    default:
      return status.state
  }
}

/** 失败原因一句话（给列表用；完整信息在 error 里） */
export function errorSummary(status: PluginStatus): string {
  if (!status.error) return ''
  const stage = status.error.stage ? `（${status.error.stage}）` : ''
  return `${status.error.code}${stage}：${status.error.message}`
}

/** 列表排序：失败在前（需要人管），其余按 id */
export function sortForDisplay(list: PluginStatus[]): PluginStatus[] {
  return [...list].sort((a, b) => {
    const af = a.state === 'failed' ? 0 : 1
    const bf = b.state === 'failed' ? 0 : 1
    return af - bf || a.id.localeCompare(b.id)
  })
}

/** 「打开页面」只在真正可访问时给（否则点了是空白壳） */
export function openableRoute(status: PluginStatus): string {
  if (!status.enabled || status.state !== 'activated') return ''
  return status.contributes?.routes?.[0] ?? ''
}

/** 桥面返回值的防御：不是数组就当作错误，绝不把对象塞进 v-for */
export function normalizeListPayload(payload: unknown): PluginStatus[] {
  if (!Array.isArray(payload)) {
    throw new Error(`插件列表返回值不是数组：${typeof payload}`)
  }
  return payload as PluginStatus[]
}
