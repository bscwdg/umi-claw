// collector/sources/bilibili.mjs —— B站热门视频「平台公开 JSON 直连」adapter（Commit 11 v1.32）
//
// SPIKE 实测（2026-09-19）：api.bilibili.com/x/web-interface/popular 免鉴权、
// 免 Cookie，连打稳定返回 20 条（title / stat.view / short_link_v2 齐全）。
// 只取公开热门榜，不碰需要 wbi 签名的接口。

import { fetchJson, makeItem, finalizeItems } from './util.mjs'

export const BILIBILI_DEFAULT_URL = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'

export async function collectBilibili(opts) {
  const url = opts.url || BILIBILI_DEFAULT_URL
  const json = await fetchJson(url, opts.timeoutMs, {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    referer: 'https://www.bilibili.com/'
  })
  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : []
  if (!list.length) throw new Error('data.list 为空')
  const items = list.map(function (row, i) {
    const url = row.short_link_v2 || (row.bvid ? 'https://www.bilibili.com/video/' + row.bvid : null)
    return makeItem({ title: row.title, heat: row.stat && row.stat.view, rank: i + 1, url })
  })
  return {
    source: 'bilibili-web',
    sourcePlatform: 'bilibili',
    origin: 'board',
    items: finalizeItems(items)
  }
}

