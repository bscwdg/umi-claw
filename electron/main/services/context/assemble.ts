// electron/main/services/context/assemble.ts —— 取舍循环的内核（W2-c）
//
// 设计依据（读 HEAD 的两域实现后定，不是凭想象）：
//   两个引擎的取舍循环**结构相同**，差异只在「测量哪段文本」与「怎么渲染」：
//
//     mode = 全量渲染是否超预算
//     for 每条候选：
//       rest = 剩余候选（先按落选计入探针，因为「未注入清单」也占预算）
//       if 放入后仍在预算内 → 收下，continue
//       else → 算剩余空间 sliceBudget；够一段有意义内容就截断收入；然后收手
//     保险丝：渲染与估算的极小差值也不许越界，按同一顺序从尾部让位
//
//   所以内核只提供**循环与记账**，把「渲染成文本」「怎么打包一条」「怎么变成 dropped」
//   交给调用方。这样两域共用一套循环，而不必在内核里写 `if (domain)`。
//
// 不做的事：
//   - 不分配每段 token 额度（现有实现是「先渲染后测量」，不是「先分配」）
//   - 不读库、不碰网关、不依赖 tokens.ts（测量函数由调用方注入）

import type { DroppedEntry, DroppedReason, PackMode } from './types'

export interface LoopCandidate<T> {
  item: T
  /** 命中检索词（只影响 pack 里的标记与排序，内核不解读） */
  matched?: boolean
}

export interface AssembleLoopOptions<T, R> {
  budgetTokens: number
  /** 单条被截断时，额外要算进去的标记成本（ITEM_TRUNCATE_MARKER 的 token 数） */
  markerTokens: number
  /**
   * Pack 固定开销（work 48 / marketing 64）。
   * 两域旧实现的 sliceBudget 都会**再减一次**它（见营销 502 行、work 429 行），
   * 内核必须同样减，否则截断收入的那条会多出若干 token。
   */
  overheadTokens: number
  /** 剩余空间低于这个值就不值得截断收入（塞半句不如明说「还有更多」） */
  minSliceTokens: number
  /** 全量候选（用于判断 mode） */
  allCandidates: T[]
  /** 裁剪模式下的候选顺序（已按域侧规则排好：LIKE 命中优先 / 时间） */
  ranked: LoopCandidate<T>[]
  /**
   * 渲染完整文本。**必须包含调用方认为要计入预算的全部内容**
   * （含固定段与「未注入清单」），否则预算账与实际渲染不同源。
   */
  renderText(chosen: R[], dropped: DroppedEntry[]): string
  /** 测量文本的 token 数（通常就是 estimateTokens） */
  measure(text: string): number
  /** 打包一条：truncate=true 时按 sliceBudget 截断正文 */
  /**
   * 打包一条：候选 T → 结果 R（可以是不同类型，如 KnowledgeRow → PackedKnowledge）。
   * truncate=true 时按 sliceBudget 截断正文。
   */
  include(item: T, opts: { truncate: boolean; sliceBudget?: number }): R
  /** 候选项 → dropped 条目（用于「未注入清单」与账本） */
  toDropped(item: T, reason: DroppedReason): DroppedEntry
  /** 标题的 token 成本（算 sliceBudget 用） */
  titleTokens(item: T): number
  /** 预置的 dropped（如 empty-content，装配前就筛出来的） */
  initialDropped?: DroppedEntry[]
}

export interface AssembleLoopResult<R> {
  mode: PackMode
  chosen: R[]
  dropped: DroppedEntry[]
  usedTokens: number
  /** 最终渲染文本（= renderText(chosen, dropped) 的结果，与 usedTokens 同源） */
  text: string
}

/**
 * 按「全量优先、超预算则逐条准入 + 截断 + 保险丝」的方式取舍。
 *
 * 纯函数（除了调用方注入的 render/measure/include），可重复调用、无副作用。
 */
export function assembleLoop<T, R>(opts: AssembleLoopOptions<T, R>): AssembleLoopResult<R> {
  const initial = opts.initialDropped ?? []

  // ── 1. 全量能否装下 ──
  const allPacked = opts.allCandidates.map((item) => opts.include(item, { truncate: false }))
  const fullText = opts.renderText(allPacked, initial)
  const mode: PackMode = opts.measure(fullText) <= opts.budgetTokens ? 'full' : 'truncated'

  if (mode === 'full') {
    return {
      mode,
      chosen: allPacked,
      dropped: [...initial],
      usedTokens: opts.measure(fullText),
      text: fullText
    }
  }

  // ── 2. 逐条准入 + 截断 ──
  const chosen: R[] = []
  for (let i = 0; i < opts.ranked.length; i++) {
    const entry = opts.ranked[i]
    // 尚未轮到的一律先按「落选」计入探针——渲染出的未注入清单也占预算
    const rest = opts.ranked.slice(i + 1).map((e) => opts.toDropped(e.item, 'budget'))
    const probeDropped = [...initial, ...rest]

    const packed = opts.include(entry.item, { truncate: false })
    if (opts.measure(opts.renderText([...chosen, packed], probeDropped)) <= opts.budgetTokens) {
      chosen.push(packed)
      continue
    }

    // 放不下整条：剩余空间够一段有意义的内容就截断收入，否则收手
    const sliceBudget =
      opts.budgetTokens -
      opts.measure(opts.renderText(chosen, probeDropped)) -
      opts.overheadTokens -
      opts.markerTokens -
      opts.titleTokens(entry.item)
    if (sliceBudget >= opts.minSliceTokens) {
      chosen.push(opts.include(entry.item, { truncate: true, sliceBudget }))
    }
    break
  }

  // ── 3. 保险丝：估算与渲染的极小差值也不许越界，按同序从尾部让位 ──
  let count = chosen.length
  const rebuildDropped = (): DroppedEntry[] => [
    ...initial,
    ...opts.ranked.slice(count).map((e) => opts.toDropped(e.item, 'budget'))
  ]
  let dropped = rebuildDropped()
  while (count > 0 && opts.measure(opts.renderText(chosen.slice(0, count), dropped)) > opts.budgetTokens) {
    count -= 1
    dropped = rebuildDropped()
  }

  const finalChosen = chosen.slice(0, count)
  const text = opts.renderText(finalChosen, dropped)
  return { mode, chosen: finalChosen, dropped, usedTokens: opts.measure(text), text }
}
