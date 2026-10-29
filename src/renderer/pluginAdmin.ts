// src/renderer/pluginAdmin.ts —— 插件管理页的纯逻辑（可单测，不依赖 Vue）
//
// 抽出来的原因：管理页最容易出错的不是样式，而是「什么时候要拦用户一下」——
// 停用一个正在被当前页面使用的插件，会直接把脚下页面拆掉（D5 决策）。

import type { PluginStatus } from '../../electron/main/kernel/lifecycle'

/** 当前路径是否落在该插件贡献的路由里（前缀匹配，`/hello` 命中 `/hello/xxx`） */
export function matchesPluginRoute(routes: string[] | undefined, path: string): boolean {
  if (!routes?.length) return false
  return routes.some((route) => path === route || path.startsWith(route.endsWith('/') ? route : route + '/'))
}

/** 停用这个插件是否会拆掉当前页面 */
export function disablingBreaksCurrentPage(status: PluginStatus, path: string): boolean {
  return status.state === 'activated' && matchesPluginRoute(status.contributes?.routes, path)
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
