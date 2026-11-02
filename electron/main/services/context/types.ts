// electron/main/services/context/types.ts —— Context 内核的接口（W2-b）
//
// 只定义形状，不含实现、不接调用方。目的：把「域侧声明什么」与「内核怎么驱动」
// 先冻结，再逐个域切换（PLAN-4.1-DEBT WP2 的 W2-b…W2-f）。
//
// 三个设计约束（来自 review_wp2_plan 的阻断项）：
//   1. Section 必须返回**结构化结果**：域要用逐条 items 组装 ContextPack，
//      只给 text 会让域侧重算一遍预算。
//   2. dropped 既是输出也是输入：「本次未注入」清单的长度会反过来影响预算，
//      所以 SectionContext 里必须能拿到当前 dropped。
//   3. order（渲染序）与 priority（截断优先）分离；fixed 段永不裁。

export type PackMode = 'full' | 'truncated'

export type DroppedReason = 'budget' | 'empty-content' | 'cut-order'

export interface DroppedEntry {
  /** 条目 id（两域现有数据都有；W2-d/W2-e 映射时不需 ?? '' 兜底） */
  id: string
  title: string
  reason: DroppedReason
  /**
   * 段号（work 用 6 表示知识段，渲染「本次未注入」时按它过滤；marketing 不填）。
   * 由产出它的 section 决定，内核不猜。
   */
  section?: number
}

export interface SectionItem {
  id: string
  text: string
  tokens: number
  truncated?: boolean
  matched?: boolean
}

export interface SectionResult {
  /** 本段渲染文本（可为空串） */
  text: string
  /** 逐条结果：域侧组装 ContextPack 用 */
  items?: SectionItem[]
  /** 本段产生的 dropped（含 empty-content） */
  drops?: DroppedEntry[]
  /** 本段固定开销（标题/分隔符），内核计费用 */
  fixedTokens?: number
}

export interface SectionContext {
  /** 当前整包预算（渲染后由内重重测；不要假设单调） */
  budgetTokens: number
  mode: PackMode
  /** 当前已产生的 dropped（供「未注入清单」段渲染） */
  dropped: DroppedEntry[]
}

export interface Section {
  key: string
  /** 文本拼接顺序 */
  order: number
  /** 截断优先级：数字小的先保；与 order 分离 */
  priority: number
  /** 永不裁（任务指令 / 画像 / business） */
  fixed?: boolean
  /** 单段上限；缺省不限 */
  maxTokens?: number
  render(ctx: SectionContext): SectionResult
}

export interface AssembleOptions {
  windowTokens: number
  /** 0.7（work）/ 0.6（marketing）—— 由域传入，内核不写死 */
  ratio: number
  /** 48（work）/ 64（marketing） */
  overheadTokens: number
  sections: Section[]
  /** 测量函数：域可传 estimateTokens；内核不直接依赖 tokens.ts */
  measure(text: string): number
}

export interface AssembleSectionResult {
  key: string
  text: string
  items?: SectionItem[]
  dropped: DroppedEntry[]
}

export interface AssembleResult {
  text: string
  usedTokens: number
  budgetTokens: number
  /** 固定段的合计开销（域侧 businessOverBudget 等判断用） */
  fixedTokens: number
  fixedOverBudget: boolean
  mode: PackMode
  sections: AssembleSectionResult[]
  /**
   * 已去重并排序的 dropped。
   *
   * 去重 key：有 `section` 时用 `section:id`，否则用 `id`（work 的
   * `dedupeDropped` 就是按 `${section}:${id}`）。
   * 顺序契约：标题升序；同标题按插入序（tie-break 是契约的一部分——
   * 两域的 ContextPack JSON 比对依赖它）。
   */
  dropped: DroppedEntry[]
}
