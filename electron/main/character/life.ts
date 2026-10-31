// electron/main/character/life.ts —— 「她的一天」生成与 LIFE.md 渲染（纯逻辑）
//
// 每天 0 点或首启生成；错过不补多天；同一日期只生成一次（幂等）。

import { drawLifeCards, type LifeCard, type LifeDeck } from './contentCards'

export interface LifeDay {
  date: string
  cardIds: string[]
  activity: string
  mood: string
  goal: string
  progress: number
  generatedAt: number
}

export interface ComposeLifeOptions {
  deck: LifeDeck
  stage: number
  date: string
  now: number
  recentIds?: string[]
  rng?: () => number
}

export interface ComposedLife {
  day: LifeDay
  cards: LifeCard[]
  doc: string
}

export function composeLifeDay(options: ComposeLifeOptions): ComposedLife {
  const cards = drawLifeCards(options.deck, {
    stage: options.stage,
    date: options.date,
    recentIds: options.recentIds,
    count: 3,
    rng: options.rng
  })
  const primary = cards[0]
  const day: LifeDay = {
    date: options.date,
    cardIds: cards.map((c) => c.id),
    activity: primary?.activity ?? '发了一整天呆',
    mood: primary?.mood ?? '平静',
    goal: primary?.goal ?? '',
    progress: 0,
    generatedAt: options.now
  }
  return { day, cards, doc: renderLifeDoc(day, cards) }
}

export function renderLifeDoc(day: LifeDay, cards: LifeCard[]): string {
  const lines: string[] = [`# 她的一天（${day.date}）`]
  const slots: Array<{ slot: string; label: string }> = [
    { slot: 'morning', label: '上午' },
    { slot: 'noon', label: '中午' },
    { slot: 'afternoon', label: '下午' },
    { slot: 'evening', label: '晚上' },
    { slot: 'night', label: '深夜' }
  ]
  const used = new Set<string>()
  for (const { slot, label } of slots) {
    const card = cards.find((c) => c.slots.includes(slot as LifeCard['slots'][number]) && !used.has(c.id))
    if (!card) continue
    used.add(card.id)
    lines.push(`- ${label}：${card.activity}（${card.mood}）`)
  }
  for (const card of cards) {
    if (used.has(card.id)) continue
    lines.push(`- ${card.activity}（${card.mood}）`)
  }
  if (day.goal) lines.push(`- 小目标：${day.goal}（${day.progress}）`)
  lines.push('')
  return lines.join('\n')
}

/** 「她的一天」是否与聊天内容矛盾（C07 校验用；这里只做最小实现） */
export function lifeConflictsWith(day: LifeDay, text: string): boolean {
  if (!text) return false
  // 反例：LIFE 说她睡了一整天，回复却说"今天出门逛街"
  const out = /出门|逛街|上班|开会/
  const atHome = /睡|发呆|摸鱼|房间/
  return atHome.test(day.activity) && out.test(text)
}
