// collector/sources/calendar.mjs —— 节点日历 adapter（自建 JSON，零抓取/零鉴权/零失效）
//
// PLAN-2.0.md §七 Commit 11（v1.12 三条供给线之 2）：节日 / 换季 / 大促 / 场景季，
// 带提前量（leadDays）——老板要在节点**之前**发内容，所以从「节点前 N 天」起就在雷达里。
// 农历节日没有稳定公式，按年写死公历日期（2026/2027），每年随包更新 JSON 即可。
// origin='calendar'，与榜单走同一张 hot_topics 表、同一评分管线（Commit 12）。

import { readFileSync } from 'node:fs'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 把 'MM-DD' / 'YYYY-MM-DD' 解析成指定年份的**当地零点**。
 * A4：此前用 UTC 构造，东八区用户在节点当天 00:00-08:00 打开时，UTC 仍是前一天，
 * 节日的提前量窗口会错一位。日历面向本地老板，一律按本地日历日解释。
 */
function parseDate(text, year) {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(text || ''))
  if (!m) return null
  const y = m[1] ? Number(m[1]) : year
  return new Date(y, Number(m[2]) - 1, Number(m[3]))
}

/** 节点是否在「提前量窗口 ~ 节点当天」（区间型到 end 当天） */
function withinLead(entry, now) {
  const leadDays = Number(entry.leadDays) > 0 ? Number(entry.leadDays) : 0
  const year = now.getFullYear()
  if (entry.date) {
    const candidates = [parseDate(entry.date, year), parseDate(entry.date, year + 1)]
    return candidates.some(function (d) {
      if (!d) return false
      return now.getTime() >= d.getTime() - leadDays * DAY_MS && now.getTime() <= d.getTime() + DAY_MS - 1
    })
  }
  if (entry.start && entry.end) {
    for (const y of [year, year + 1]) {
      const s = parseDate(entry.start, y)
      const e = parseDate(entry.end, y)
      if (!s || !e) continue
      if (now.getTime() >= s.getTime() - leadDays * DAY_MS && now.getTime() <= e.getTime() + DAY_MS - 1) return true
    }
  }
  return false
}

export function activeCalendarEntries(entries, now) {
  return entries.filter(function (e) {
    if (!e || !e.id || !e.title) return false
    return withinLead(e, now)
  })
}

export async function collectCalendar(opts) {
  const raw = readFileSync(opts.calendarPath, 'utf8')
  let entries
  try {
    entries = JSON.parse(raw)
  } catch (e) {
    throw new Error('calendar.json 解析失败: ' + e.message)
  }
  if (!Array.isArray(entries)) throw new Error('calendar.json 顶层必须是数组')
  const now = opts.now ? new Date(opts.now) : new Date()
  const items = activeCalendarEntries(entries, now).map(function (e) {
    return { title: String(e.title).trim(), heat: null, rank: null, url: null, fid: String(e.id) }
  })
  return {
    source: 'builtin-calendar',
    sourcePlatform: 'calendar',
    origin: 'calendar',
    items
  }
}
