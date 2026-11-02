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
  /**
   * 裁剪模式下的候选顺序（已按域侧规则排好：LIKE 命中优先 / 时间）。
   *
   * **惰性**：只有真的进入裁剪分支才会调用。旧实现同理——mode=full 时不查
   * `searchKnowledge`，传数组会让满量场景白跑一次 DB 查询。
   *
   * `info` 由内核原样带回（营销用它填 `pack.retrieval`），内核不解读。
   */
  ranked: () =>
    | { entries: LoopCandidate<T>[]; info?: unknown }
    | Promise<{ entries: LoopCandidate<T>[]; info?: unknown }>
  /**
   * 强制走 truncated（不看全量是否装得下）。
   *
   * 用途：marketing 的 `businessOverBudget`（固定开销已超预算）会让 mode 直接落到
   * truncated。内核不判断「谁超了」，只接受调用方的结论——避免内核里出现域分支。
   */
  forceTruncated?: boolean
  /**
   * 渲染完整文本。**必须包含调用方认为要计入预算的全部内容**
   * （含固定段与「未注入清单」），否则预算账与实际渲染不同源。
   */
  /**
   * 用量测量：给定当前选择与 dropped，返回**真实渲染后的** token 数。
   *
   * 为什么不是「渲染成字符串再 measure」：marketing 的测量是「渲染整个 ContextPack
   * 再估算」（estimateTokens(renderContextPackText(pack))），拿不到可比的字符串；
   * 强行让它拼一个假串会给账本引入偏差。所以内核只问「现在占多少」，不问怎么算的。
   *
   * 契约：本函数必须与 renderFinal 同源（同一渲染函数），否则账不对。
   * mode 必须被使用：两域渲染都依赖它（marketing 用它决定「全部注入」还是
   * 「已按相关度裁剪 N/M 条」）。
   */
  measureSelection(chosen: R[], dropped: DroppedEntry[], mode: PackMode): number
  /**
   * 收尾渲染：返回最终文本与实际用量。
   * usedTokens 必须等于 measureSelection(chosen, dropped, mode) 的结果（同源）。
   */
  renderFinal(chosen: R[], dropped: DroppedEntry[], mode: PackMode): { text: string; usedTokens: number }
  /** 打包一条：truncate=true 时按 sliceBudget 截断正文 */
  /**
   * 打包一条：候选 T → 结果 R（可以是不同类型，如 KnowledgeRow → PackedKnowledge）。
   * truncate=true 时按 sliceBudget 截断正文。
   */
  include(item: T, opts: { truncate: boolean; sliceBudget?: number; matched?: boolean }): R
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
  /** 最终渲染文本 */
  text: string
  /** 裁剪时用到的候选项信息（`ranked().info` 原样带回；full 模式为 undefined） */
  rankedInfo?: unknown
}

/**
 * 按「全量优先、超预算则逐条准入 + 截断 + 保险丝」的方式取舍。
 *
 * 纯函数（除了调用方注入的 render/measure/include），可重复调用、无副作用。
 */
export async function assembleLoop<T, R>(
  opts: AssembleLoopOptions<T, R>
): Promise<AssembleLoopResult<R>> {
  const initial = opts.initialDropped ?? []

  // ── 1. 全量能否装下 ──
  const allPacked = opts.allCandidates.map((item) =>
    opts.include(item, { truncate: false, matched: false })
  )
  const fullTokens = opts.measureSelection(allPacked, initial, 'full')
  const mode: PackMode = fullTokens <= opts.budgetTokens ? 'full' : 'truncated'

  if (mode === 'full') {
    const final = opts.renderFinal(allPacked, initial, 'full')
    return {
      mode,
      chosen: allPacked,
      dropped: [...initial],
      usedTokens: final.usedTokens,
      text: final.text,
      rankedInfo: undefined
    }
  }

  // ── 2. 逐条准入 + 截断 ──
  const ranked = await opts.ranked()
  const rankedEntries = ranked.entries
  const chosen: R[] = []
  for (let i = 0; i < rankedEntries.length; i++) {
    const entry = rankedEntries[i]
    // 尚未轮到的一律先按「落选」计入探针——渲染出的未注入清单也占预算
    const rest = rankedEntries.slice(i + 1).map((e) => opts.toDropped(e.item, 'budget'))
    const probeDropped = [...initial, ...rest]

    const packed = opts.include(entry.item, { truncate: false, matched: entry.matched })
    if (opts.measureSelection([...chosen, packed], probeDropped, 'truncated') <= opts.budgetTokens) {
      chosen.push(packed)
      continue
    }

    // 放不下整条：剩余空间够一段有意义的内容就截断收入，否则收手
    const sliceBudget =
      opts.budgetTokens -
      opts.measureSelection(chosen, probeDropped, 'truncated') -
      opts.overheadTokens -
      opts.markerTokens -
      opts.titleTokens(entry.item)
    if (sliceBudget >= opts.minSliceTokens) {
      chosen.push(
        opts.include(entry.item, { truncate: true, sliceBudget, matched: entry.matched })
      )
    }
    break
  }

  // ── 3. 保险丝：估算与渲染的极小差值也不许越界，按同序从尾部让位 ──
  let count = chosen.length
  const rebuildDropped = (): DroppedEntry[] => [
    ...initial,
    ...rankedEntries.slice(count).map((e) => opts.toDropped(e.item, 'budget'))
  ]
  let dropped = rebuildDropped()
  while (count > 0 && opts.measureSelection(chosen.slice(0, count), dropped, 'truncated') > opts.budgetTokens) {
    count -= 1
    dropped = rebuildDropped()
  }

  const finalChosen = chosen.slice(0, count)
  const final = opts.renderFinal(finalChosen, dropped, mode)
  return {
    mode,
    chosen: finalChosen,
    dropped,
    usedTokens: final.usedTokens,
    text: final.text,
    rankedInfo: ranked.info
  }
}
