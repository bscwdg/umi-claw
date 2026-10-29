// work/factAggregator.ts —— 确定性事实聚合（PLAN-3.0.md §2.4 / §2.5）
//
// 日报不是 AI 创作：原始事件 → confirmed 记录 → **事实聚合（确定性代码，不用模型）** → AI 表达。
// AI 只负责「怎么说」，不负责「发生了什么」。
//
// 本模块是**纯函数**（不 import electron / DB / HTTP），给定 confirmed 记录集 → 固定结构，可断言。
// 聚合一律按 `occurred_date`（A10），`created_at` 只作审计。

import { normalizeForCompare } from './recordManager'

/** 聚合输入记录（已由调用方按周期筛好的 confirmed 行，形状同 activity_log 精简） */
export interface FactRecord {
  id: string
  content: string
  occurred_date: string
  occurred_time: string | null
  matter_id: string | null
}

/** 附带事项名/颜色（调用方从 matters 表 join 进来） */
export interface FactMatterInfo {
  id: string
  name: string
  color: string | null
}

export interface FactItem {
  id: string
  time: string | null
  content: string
  /** A7：被降级为「进展」子项（较晚的重复） */
  isProgress?: boolean
  /** A7：跨日期完全同文本的重复次数（×N） */
  repeatCount?: number
}

export interface FactSection {
  matter_id: string | null
  matter_name: string
  color: string | null
  items: FactItem[]
  /** A8：同事项本周 ≥3 条 → 阶段性成果，周报排最前 */
  is_focus: boolean
  /** 组内最新记录时间（A2 分节排序用；无时间用日期） */
  latestSortKey: string
}

export interface FactStats {
  total: number
  by_matter: Record<string, number>
  time_missing: number
}

export interface FactAggregation {
  type: 'daily' | 'weekly'
  sections: FactSection[]
  other: FactSection
  stats: FactStats
  /** A4：0 条 → 不调模型，返回结构化提示 */
  empty: boolean
  /** A5：1-2 条 → 草稿顶部提示偏薄 */
  thin: boolean
}

/** 聚合主入口 */
export function aggregateFacts(
  type: 'daily' | 'weekly',
  records: FactRecord[],
  matters: FactMatterInfo[]
): FactAggregation {
  const matterMap = new Map(matters.map((m) => [m.id, m]))
  // A9：只统计 confirmed（调用方已保证）；防御性再过滤一次空内容
  const valid = records.filter((r) => r && typeof r.content === 'string' && r.content.trim())

  const empty = valid.length === 0
  const thin = !empty && valid.length <= 2

  // A1：分组维度 = 事项优先；无事项一律 other（不猜、不让模型归类）
  const groups = new Map<string, FactRecord[]>()
  for (const rec of valid) {
    const key = rec.matter_id ?? '__other__'
    const list = groups.get(key)
    if (list) list.push(rec)
    else groups.set(key, [rec])
  }

  const sections: FactSection[] = []
  let other: FactSection | null = null

  for (const [key, list] of groups) {
    let section: FactSection
    if (key === '__other__') {
      section = buildSection(null, '其他', null, list, type)
      other = section
    } else {
      const info = matterMap.get(key)
      section = buildSection(key, info?.name ?? '未命名事项', info?.color ?? null, list, type)
      sections.push(section)
    }
  }
  if (!other) {
    other = {
      matter_id: null,
      matter_name: '其他',
      color: null,
      items: [],
      is_focus: false,
      latestSortKey: ''
    }
  }

  // A8：focus 判定（同事项 ≥3 条；纯计数，不用模型判重要性）
  for (const s of sections) s.is_focus = s.items.length >= 3

  // A2：分节顺序 —— focus 最前（A8），其余按组内最新记录倒序；other 恒在最后
  sections.sort((a, b) => {
    if (a.is_focus !== b.is_focus) return a.is_focus ? -1 : 1
    return a.latestSortKey < b.latestSortKey ? 1 : a.latestSortKey > b.latestSortKey ? -1 : 0
  })

  // 统计
  const by_matter: Record<string, number> = {}
  let time_missing = 0
  const countItems = (s: FactSection): void => {
    for (const it of s.items) {
      if (!it.time) time_missing += 1
    }
  }
  for (const s of sections) {
    by_matter[s.matter_id ?? 'unknown'] = s.items.length
    countItems(s)
  }
  by_matter.other = other.items.length
  countItems(other)

  return {
    type,
    sections,
    other,
    stats: { total: valid.length, by_matter, time_missing },
    empty,
    thin
  }
}

/** 构造一个分组（含 A3 组内排序、A6 单事项、A7 周报去重） */
function buildSection(
  matterId: string | null,
  matterName: string,
  color: string | null,
  list: FactRecord[],
  type: 'daily' | 'weekly'
): FactSection {
  // A3：组内排序 —— occurred_time 升序；无时间排同日有时间之后
  const sorted = [...list].sort((a, b) => {
    const keyA = sortKeyOf(a)
    const keyB = sortKeyOf(b)
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  })

  let items: FactItem[]
  if (type === 'weekly') {
    items = dedupeWeekly(sorted)
  } else {
    items = sorted.map((r) => ({ id: r.id, time: r.occurred_time, content: r.content }))
  }

  // latestSortKey：组内「日期+时间」最大者（A2）；无时间用日期末
  let latest = ''
  for (const r of sorted) {
    const k = `${r.occurred_date} ${r.occurred_time ?? '99:99'}`
    if (k > latest) latest = k
  }

  return {
    matter_id: matterId,
    matter_name: matterName,
    color,
    items,
    is_focus: false,
    latestSortKey: latest
  }
}

/** A3 排序键：无时间（IS NULL）排到同日有时间之后 */
function sortKeyOf(r: FactRecord): string {
  // 有时间：日期 T 时间；无时间：日期 T ~（波浪号 > 数字 ASCII，确保排在后）
  return r.occurred_time ? `${r.occurred_date}T${r.occurred_time}` : `${r.occurred_date}T~`
}

/**
 * A7 周报去重（确定性，不让模型自由发挥）：
 *  - 同事项内一条文本归一化后是另一条的子串 → 保留较早，较晚降级为「进展」子项
 *  - 跨日期完全同文本 → 只保留最早 + 标 ×N
 */
function dedupeWeekly(sorted: FactRecord[]): FactItem[] {
  const items: FactItem[] = []
  // 完全同文本计数（归一化）
  const seenExact = new Map<string, FactItem>()

  for (const r of sorted) {
    const norm = normalizeForCompare(r.content)
    const existing = seenExact.get(norm)
    if (existing) {
      existing.repeatCount = (existing.repeatCount ?? 1) + 1
      continue
    }
    const item: FactItem = { id: r.id, time: r.occurred_time, content: r.content, repeatCount: 1 }
    seenExact.set(norm, item)

    // 子串关系：与某个更早 item 互含 → **较晚这条**一律降级为进展（A7）
    // 不论较晚的是更短还是更长：规则只区分先后，「保留较早，较晚降级」。
    let isSub = false
    for (const kept of items) {
      const keptNorm = normalizeForCompare(kept.content)
      if (norm !== keptNorm && (keptNorm.includes(norm) || norm.includes(keptNorm))) {
        item.isProgress = true
        isSub = true
        break
      }
    }
    void isSub
    items.push(item)
  }
  // repeatCount=1 不展示标记
  for (const it of items) if (it.repeatCount === 1) delete it.repeatCount
  return items
}

/** 把聚合结构渲染为给 AI 的「事实清单」文本（这是 prompt 的事实部分，不是最终日报） */
export function renderFactSheet(agg: FactAggregation): string {
  if (agg.empty) return '（今天还没有已确认记录）'
  const renderSection = (s: FactSection): string[] => {
    const head = `# ${s.matter_name}${s.is_focus ? '（本周重点）' : ''}`
    const lines = s.items.map((it) => {
      const t = it.time ?? '时间未记'
      const progress = it.isProgress ? '〔进展〕' : ''
      const rep = it.repeatCount && it.repeatCount > 1 ? ` ×${it.repeatCount}` : ''
      return `- [${t}] ${progress}${it.content}${rep}`
    })
    return [head, ...lines]
  }
  const parts: string[] = []
  for (const s of agg.sections) parts.push(...renderSection(s), '')
  if (agg.other.items.length) parts.push(...renderSection(agg.other))
  return parts.join('\n').trim()
}
