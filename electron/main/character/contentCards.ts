// electron/main/character/contentCards.ts —— 内容卡加载/校验/加权抽取（纯逻辑）
//
// 卡按 stage/slot/weight 抽取；同一张卡 7 天内不重复；新卡只追加版本号文件。

export type LifeSlot = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'

export interface LifeCard {
  id: string
  slots: LifeSlot[]
  minStage: number
  activity: string
  mood: string
  goal: string
  hook: string
  weight: number
}

export interface LifeDeck {
  schema: string
  version: string
  cards: LifeCard[]
}

const SLOTS: LifeSlot[] = ['morning', 'noon', 'afternoon', 'evening', 'night']

export function parseLifeDeck(raw: unknown): LifeDeck {
  const src = (raw ?? {}) as Record<string, unknown>
  const cards: LifeCard[] = []
  const list = Array.isArray(src.cards) ? src.cards : []
  for (const item of list) {
    const card = parseCard(item)
    if (card) cards.push(card)
  }
  return {
    schema: typeof src.schema === 'string' ? src.schema : 'fish-life-cards/1',
    version: typeof src.version === 'string' ? src.version : '0.0.0',
    cards
  }
}

function parseCard(raw: unknown): LifeCard | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const id = typeof src.id === 'string' ? src.id.trim() : ''
  const activity = typeof src.activity === 'string' ? src.activity.trim() : ''
  if (!id || !activity) return null
  const slots = Array.isArray(src.slots)
    ? src.slots.filter((s): s is LifeSlot => typeof s === 'string' && SLOTS.includes(s as LifeSlot))
    : []
  return {
    id,
    slots: slots.length > 0 ? slots : [...SLOTS],
    minStage: typeof src.minStage === 'number' ? Math.max(0, Math.min(4, Math.round(src.minStage))) : 0,
    activity,
    mood: typeof src.mood === 'string' ? src.mood : '平静',
    goal: typeof src.goal === 'string' ? src.goal : '',
    hook: typeof src.hook === 'string' ? src.hook : activity,
    weight: typeof src.weight === 'number' && src.weight > 0 ? Math.min(10, src.weight) : 1
  }
}

export function slotForHour(hour: number): LifeSlot {
  const h = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 12
  if (h < 10) return 'morning'
  if (h < 13) return 'noon'
  if (h < 18) return 'afternoon'
  if (h < 22) return 'evening'
  return 'night'
}

/** 确定性随机（按日期 + 阶段；同一天重跑得到同一套卡，避免状态抖动） */
export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DrawOptions {
  stage: number
  date: string
  /** 最近 7 天已用过的卡 id（不重复） */
  recentIds?: string[]
  /** 画几张（默认 3） */
  count?: number
  rng?: () => number
}

export function drawLifeCards(deck: LifeDeck, options: DrawOptions): LifeCard[] {
  const recent = new Set(options.recentIds ?? [])
  const rng = options.rng ?? seededRandom(`${options.date}:${options.stage}`)
  const eligible = deck.cards.filter((c) => c.minStage <= options.stage)
  const fresh = eligible.filter((c) => !recent.has(c.id))
  const picked: LifeCard[] = []
  const target = Math.max(1, options.count ?? 3)
  // 卡池不够时逐级放宽：先忽略 7 天去重，再从全部卡里兜底，保证每天都有「她的一天」
  const pools = [fresh, eligible, [...deck.cards]]
  for (const pool of pools) {
    const rest = pool.filter((c) => !picked.some((p) => p.id === c.id))
    while (picked.length < target && rest.length > 0) {
      const total = rest.reduce((sum, c) => sum + c.weight, 0)
      let r = rng() * total
      let index = 0
      for (let i = 0; i < rest.length; i += 1) {
        r -= rest[i].weight
        if (r <= 0) {
          index = i
          break
        }
      }
      picked.push(rest[index])
      rest.splice(index, 1)
    }
    if (picked.length >= target) break
  }
  return picked
}
