// collector/sources/toutiao.mjs —— 头条热榜「平台公开 JSON 直连」adapter（Commit 11 v1.32 新增供给线）
//
// SPIKE 实测（2026-09-19，spikes/011-hot-sources）：该端点免鉴权、免 Cookie、
// 连打稳定返回 50 条，字段 Title/HotValue/Url 齐全。浏览器公开页面同源使用，
// 与 DailyHotApi 服务端抓取的是同一类公开聚合数据；不做任何登录态操作。

import { fetchJson, makeItem, finalizeItems } from './util.mjs'

export const TOUTIAO_DEFAULT_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc'

export async function collectToutiao(opts) {
  const url = opts.url || TOUTIAO_DEFAULT_URL
  const json = await fetchJson(url, opts.timeoutMs, {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  })
  const list = Array.isArray(json && json.data) ? json.data : []
  if (!list.length) throw new Error('data 为空')
  const items = list.map(function (row, i) {
    return makeItem({ title: row.Title, heat: row.HotValue, rank: i + 1, url: row.Url || null })
  })
  return {
    source: 'toutiao-web',
    sourcePlatform: 'toutiao',
    origin: 'board',
    items: finalizeItems(items)
  }
}

