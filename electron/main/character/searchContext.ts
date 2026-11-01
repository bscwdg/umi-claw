// electron/main/character/searchContext.ts —— 宿主侧预检索（性能：砍掉模型发现工具的多轮链路）
//
// 背景：让模型自己 tool_search → search_notes → 再回答，实测首字 43–52s；
// 宿主直接调 Obsidian 检索（200–500ms），把 top 片段注入本轮上下文，
// 模型只需引用，不再走工具链。

export interface KnowledgeHit {
  path: string
  content: string
  score: number
}

/** 看起来像在问「过去/笔记/设定」的问题才预检索，避免每轮都加 0.5s */
const RECALL_PATTERN =
  /(之前|上次|以前|那次|那天|记过|记得|笔记|写过|说过|提到过|约定|设定|生日|喜欢|讨厌|习惯|怎么做|是什么|哪个|回忆|回顾|查一下|找一下|咱们|我们.{0,6}(聊|说)过)/

export function looksLikeRecallQuery(text: string): boolean {
  const raw = (text ?? '').trim()
  if (raw.length < 2) return false
  return RECALL_PATTERN.test(raw)
}

export interface FormatSearchOptions {
  minScore?: number
  maxHits?: number
  perHitChars?: number
  totalChars?: number
}

/** 把检索命中格式化成注入片段（低分丢弃、单条截断、总量截断） */
export function formatSearchContext(
  hits: KnowledgeHit[],
  options: FormatSearchOptions = {}
): string {
  const minScore = options.minScore ?? 0.45
  const maxHits = options.maxHits ?? 3
  const perHit = options.perHitChars ?? 220
  const total = options.totalChars ?? 900
  const picked = (hits ?? [])
    .filter((hit) => hit && typeof hit.content === 'string' && hit.content.trim())
    .filter((hit) => Number.isFinite(hit.score) && hit.score >= minScore)
    .slice(0, maxHits)
  if (picked.length === 0) return ''
  const lines = picked.map((hit, index) => {
    const file = (hit.path || '未知笔记').replace(/[\\/]+/g, '/')
    const body = hit.content.replace(/\s+/g, ' ').trim().slice(0, perHit)
    return `[${index + 1}] ${file}（相似度 ${hit.score.toFixed(2)}）\n${body}`
  })
  const text = `【笔记检索（宿主已预检索，直接引用；不必再调用检索工具）】\n${lines.join('\n')}`
  return text.slice(0, total)
}

/** 超时返回 null：预检索失败/太慢时不影响正常聊天 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}
