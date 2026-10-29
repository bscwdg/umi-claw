// collector/sources/dailyhot.mjs —— DailyHotApi 聚合协议 adapter（PLAN-2.0.md §七 Commit 11 原计划供给线）
//
// 协议：GET <base>/<route> → { code, data: [{ name|title, hot, index|rank, url|mobileUrl }] }
// base URL **必须由外部给**（参数/环境变量）：2026-09-19 SPIKE 实测官方演示域名
// api-hot.imsyy.top 已 NXDOMAIN、公共镜像全灭，因此默认不配置就**跳过**（ok 记 skipped 而非失败）；
// 用户自部署（Docker/Vercel，默认 6688）或将来公共实例恢复，在配置里填 base 即插即用。
// 不做任何要求登录/Cookie 的抓取——路由返回 401/403 一律按该源失败处理。

import { fetchJson, makeItem, finalizeItems, pickFirst } from './util.mjs'

/**
 * 默认聚合路由（v1.32 SPIKE 后）：头条/B站已有更稳的免鉴权直连 adapter，
 * 这里只补直连覆盖不到的长尾（抖音/微博/知乎/百度/快手），避免同平台双线重复抓。
 * 用户显式传 --routes 时不做过滤（自部署实例想抓什么由用户决定）。
 */
export const DEFAULT_ROUTES = ['douyin', 'weibo', 'zhihu', 'baidu', 'kuaishou']

export async function collectDailyHotRoute(route, opts) {
  const base = String(opts.base || '').replace(/\/$/, '')
  const json = await fetchJson(base + '/' + route, opts.timeoutMs)
  const list = Array.isArray(json && json.data) ? json.data : null
  if (!list) throw new Error('data 非数组（code=' + String(json && json.code) + '）')
  const items = list.map(function (row, i) {
    return makeItem({
      title: pickFirst(row.name, row.title, row.word, row.query),
      heat: row.hot,
      rank: pickFirst(row.index, row.rank, i + 1),
      url: pickFirst(row.url, row.mobileUrl, row.mobil_url)
    })
  })
  let host = base
  try { host = new URL(base).host } catch { /* 保留原串 */ }
  return {
    source: 'dailyhot:' + host,
    sourcePlatform: route,
    origin: 'board',
    items: finalizeItems(items)
  }
}
