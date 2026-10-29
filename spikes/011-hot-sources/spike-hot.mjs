// spike-hot.mjs —— Commit 11 数据源 SPIKE（PLAN-2.0.md §七 Commit 11 SPIKE 清单 / v1.12 降级口径）
//
// 纯 Node、零依赖、**只发 GET 公开聚合源**（不登录、不 Cookie，红线）。
// 探测：候选公共实例 × 榜单路由的可用性、字段齐不齐（title/heat/rank/url）、
// 小红书路由是否存在（决定 v1.12 降级口径走哪条）。
// 结果写 spike-result.json（同目录），由人工读、结论回写 PLAN。
//
// 用法：node spikes/011-hot-sources/spike-hot.mjs [--base=https://...]

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// DailyHotApi 类公共实例（2026-09-19 实测清单：官方演示域名已 NXDOMAIN，逐一实测不假设存活）
const DEFAULT_BASES = [
  'https://api-hot.imsyy.top',
  'https://dailyhot.hkg1.zeabur.app',
  'https://hot.ilsmw.com',
  'https://dailyhot-api.vercel.app',
  'https://api-hot.efefee.cn',
  'https://api.codelife.cc'
]

// 一期雷达视角要的来源（发布视角双平台；其余作为「综合榜」喂语义判断）
const ROUTES = [
  { key: 'douyin', label: '抖音热点', want: true },
  { key: 'weibo', label: '微博热搜', want: true },
  { key: 'bilibili', label: 'B站热门', want: true },
  { key: 'zhihu', label: '知乎热榜', want: true },
  { key: 'toutiao', label: '头条热榜', want: true },
  { key: 'baidu', label: '百度热搜', want: true },
  { key: 'kuaishou', label: '快手热榜', want: true },
  { key: 'xiaohongshu', label: '小红书（预期无）', want: false }
]

const argBase = process.argv.find((a) => a.startsWith('--base='))
const bases = argBase ? [argBase.slice('--base='.length).replace(/\/$/, '')] : DEFAULT_BASES
const TIMEOUT_MS = 8000

// 平台公开 JSON 直连（不登录、不带 Cookie，守红线）。DailyHotApi 服务端抓的也是这类接口；
// 浏览器直连与服务端抓取的风控等级不同，所以要连打多次验稳定性，不能一次 200 就当可用。
const DIRECT_ROUTES = [
  { key: 'toutiao', label: '头条热榜', repeat: 2, build: () => 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
    pick: (j) => ({ count: Array.isArray(j.data) ? j.data.length : 0,
      sample: { title: j.data?.[0]?.Title ?? null, hot: j.data?.[0]?.HotValue ?? null, url: j.data?.[0]?.Url ?? null } }) },
  { key: 'bilibili', label: 'B站热门视频', repeat: 2, build: () => 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
    pick: (j) => ({ count: Array.isArray(j.data?.list) ? j.data.list.length : 0,
      sample: { title: j.data?.list?.[0]?.title ?? null, hot: j.data?.list?.[0]?.stat?.view ?? null, url: j.data?.list?.[0]?.short_link_v2 ?? null } }) },
  { key: 'douyin', label: '抖音热点（验频控）', repeat: 3, build: () => 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    pick: (j) => ({ count: Array.isArray(j.data?.word_list) ? j.data.word_list.length : 0,
      sample: { title: j.data?.word_list?.[0]?.word ?? null, hot: j.data?.word_list?.[0]?.hot_value ?? null, url: null } }) },
  { key: 'zhihu', label: '知乎热榜（预期 401）', repeat: 1, build: () => 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20',
    pick: (j) => ({ count: Array.isArray(j.data) ? j.data.length : 0, sample: { title: j.data?.[0]?.target?.title ?? null } }) },
  { key: 'weibo', label: '微博热搜（预期 403）', repeat: 1, build: () => 'https://weibo.com/ajax/side/hotSearch',
    pick: (j) => ({ count: Array.isArray(j.data?.realtime) ? j.data.realtime.length : 0, sample: { title: j.data?.realtime?.[0]?.word ?? null } }) }
]

async function probeDirect(route) {
  const tries = []
  for (let i = 0; i < route.repeat; i++) {
    const url = route.build()
    const t0 = Date.now()
    const one = { httpStatus: null, ms: 0, count: 0, sample: null, error: null }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
      } })
      one.httpStatus = res.status
      one.ms = Date.now() - t0
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { one.error = 'non-json' }
      if (json) {
        const got = route.pick(json)
        one.count = got.count
        one.sample = got.sample
        if (res.status !== 200) one.error = String(json.message || json.error || ('http ' + res.status))
      }
    } catch (e) {
      one.ms = Date.now() - t0
      one.error = e.name === 'AbortError' ? 'timeout>' + TIMEOUT_MS : String(e.message)
    } finally {
      clearTimeout(timer)
    }
    tries.push(one)
    process.stdout.write((one.httpStatus === 200 && one.count > 0 ? 'OK  ' : 'XX  ') + 'direct/' + route.key +
      '#' + (i + 1) + ' status=' + String(one.httpStatus) + ' n=' + one.count + ' ' + (one.error || '') + '\n')
    if (i + 1 < route.repeat) await new Promise((r) => setTimeout(r, 600))
  }
  const okTries = tries.filter((t) => t.httpStatus === 200 && t.count > 0)
  return { route: route.key, label: route.label, tries,
    reliable: okTries.length === tries.length,
    flaky: okTries.length > 0 && okTries.length < tries.length,
    count: okTries.length ? okTries[0].count : 0,
    sample: okTries.length ? okTries[0].sample : null }
}

async function probeRoute(base, route) {
  const url = base.replace(/\/$/, '') + '/' + route.key
  const t0 = Date.now()
  const out = { route: route.key, label: route.label, url, httpStatus: null, ms: 0, ok: false,
    shape: null, count: 0, fields: null, sample: null, error: null }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    out.httpStatus = res.status
    out.ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 照实记 */ }
    if (res.status === 200 && json && Array.isArray(json.data)) {
      out.ok = true
      out.count = json.data.length
      const first = json.data[0] || {}
      out.fields = Object.keys(first)
      // 只取判定字段，不落全量隐私/冗余数据
      out.sample = {
        title: first.title ?? null,
        hot: first.hot ?? null,
        rank: first.rank ?? first.index ?? null,
        url: first.url ?? first.mobileUrl ?? first.mobil_url ?? null
      }
      out.shape = { code: json.code ?? null, name: json.name ?? null, dataIsArray: true }
    } else if (res.status === 200 && json) {
      out.shape = { code: json.code ?? null, name: json.name ?? null, dataIsArray: Array.isArray(json.data) }
      out.error = json.message || json.msg || '200 但 data 非数组'
    } else {
      out.error = (text || '').slice(0, 120)
    }
  } catch (e) {
    out.ms = Date.now() - t0
    out.error = e.name === 'AbortError' ? 'timeout>' + TIMEOUT_MS + 'ms' : String(e && e.message || e)
  } finally {
    clearTimeout(timer)
  }
  return out
}

const startedAt = new Date().toISOString()
const results = []
for (const base of bases) {
  const entry = { base, reachable: false, routes: [] }
  for (const route of ROUTES) {
    const r = await probeRoute(base, route)
    entry.routes.push(r)
    if (r.ok) entry.reachable = true
    process.stdout.write((r.ok ? 'OK  ' : 'XX  ') + base + '/' + route.key +
      ' status=' + String(r.httpStatus) + ' n=' + r.count + ' ' + (r.error || '') + '\n')
  }
  results.push(entry)
}

// ── 平台直连组 ──
const directResults = []
for (const route of DIRECT_ROUTES) {
  directResults.push(await probeDirect(route))
}

// 结论机器可读汇总（最终结论仍由人回写 PLAN）
const primary = results.find((e) => e.reachable) || null
const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  timeoutMs: TIMEOUT_MS,
  basesTried: bases,
  primaryBase: primary ? primary.base : null,
  routes: ROUTES.map((route) => {
    const hit = primary ? primary.routes.find((r) => r.route === route.key) : null
    return { key: route.key, label: route.label, ok: !!(hit && hit.ok), count: hit ? hit.count : 0,
      hasTitle: !!(hit && hit.sample && hit.sample.title),
      hasHeat: !!(hit && hit.sample && hit.sample.hot != null),
      hasUrl: !!(hit && hit.sample && hit.sample.url) }
  }),
  xiaohongshu: primary ? !!primary.routes.find((r) => r.route === 'xiaohongshu' && r.ok) : false
  ,
  // 官方 DailyHotApi 源清单（master README）50+ 路由不含 xiaohongshu：降级口径的上游证据
  dailyHotApiUpstreamHasXiaohongshu: false,
  direct: Object.fromEntries(directResults.map((d) => [d.route, {
    label: d.label, reliable: d.reliable, flaky: d.flaky, count: d.count, sample: d.sample
  }]))
}

mkdirSync(here, { recursive: true })
writeFileSync(join(here, 'spike-result.json'), JSON.stringify({ summary, aggregateBases: results, direct: directResults }, null, 2), 'utf8')
process.stdout.write('\nprimary=' + summary.primaryBase +
  ' xiaohongshu=' + summary.xiaohongshu +
  ' direct.reliable=' + directResults.filter((d) => d.reliable).map((d) => d.route).join(',') +
  '\n结果已写 spikes/011-hot-sources/spike-result.json\n')
