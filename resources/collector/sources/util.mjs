// collector/sources/util.mjs —— 各 adapter 共享的零依赖工具（只做 HTTP/解析，不写库）
//
// 红线（PLAN-2.0.md §七 Commit 11）：只用公开聚合端点，**不登录、不带 Cookie、不绕风控**；
// 任何鉴权/签名要求一律按「该源不可用」处理并在 ok=false 里写明。

/** 延时（重试退避用） */
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

/**
 * 带超时的 GET → JSON；非 2xx / 非 JSON / 超时都抛错（由调用方归入该源的 ok=false）。
 *
 * 有限重试（PLAN #6）：仅对**瞬时错误**重试——超时(AbortError)、网络层错误(TypeError)、5xx；
 * 默认再试 2 次（共 3 次），指数退避 + 抖动。
 * 4xx / 非 JSON / 鉴权类（401/403）**不重试**（重试也无意义，且不碰任何登录态操作，守红线）。
 */
export async function fetchJson(url, timeoutMs, headers, retries) {
  const maxAttempts = (Number.isFinite(Number(retries)) ? Number(retries) : 2) + 1
  let lastError
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(function () { ctrl.abort() }, timeoutMs)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: Object.assign({ accept: 'application/json' }, headers || {})
      })
      const text = await res.text()
      if (!res.ok) {
        const err = new Error('http ' + res.status)
        // 5xx 视为瞬时可重试；其余（含 401/403）直接失败
        if (res.status >= 500) err.retryable = true
        throw err
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('non-json response (' + text.length + ' chars)')
      }
    } catch (e) {
      lastError = e
      const isAbort = e && e.name === 'AbortError'
      const isNetwork = e && e.name === 'TypeError'
      const canRetry = (isAbort || isNetwork || e && e.retryable === true) && attempt < maxAttempts - 1
      if (!canRetry) throw e
    } finally {
      clearTimeout(timer)
    }
    // 指数退避 + 抖动：300ms、600ms …（多源并发同时失败时避免齐刷刷重试）
    const backoff = 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
    await sleep(backoff)
  }
  throw lastError
}

/** 热度字段形态不一（数字 / 带逗号字符串 / null）：统一成 number|null，非法值不编造成 0 */
export function toHeat(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const s = String(value).replace(/[,，\s]/g, '')
  // 「123.4万」「1.2亿」这类文案口径也兜住（DailyHotApi 多数源已转数字，直连源偶尔留文案）
  const wan = /^([0-9]+(?:\.[0-9]+)?)万$/.exec(s)
  if (wan) return Math.round(Number(wan[1]) * 10000)
  const yi = /^([0-9]+(?:\.[0-9]+)?)亿$/.exec(s)
  if (yi) return Math.round(Number(yi[1]) * 100000000)
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 取第一个非空字段 */
export function pickFirst() {
  for (const v of arguments) {
    if (v !== null && v !== undefined && String(v).trim() !== '') return v
  }
  return null
}

/** adapter 返回的一条热点（manager 负责最终归一与指纹） */
export function makeItem(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  return {
    title,
    heat: toHeat(input.heat),
    rank: Number.isInteger(input.rank) && input.rank >= 1 ? input.rank : null,
    url: typeof input.url === 'string' && input.url ? input.url : null,
    fid: input.fid !== undefined ? input.fid : null
  }
}

/** 去掉空标题并补名次（名次从 1 起；接口已给名次则保留其数值） */
export function finalizeItems(items) {
  const out = []
  items.forEach(function (it, i) {
    if (!it || !it.title) return
    if (!it.rank) it.rank = out.length + 1
    out.push(it)
  })
  return out
}

