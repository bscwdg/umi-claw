// electron/main/services/context/types.ts —— Context 内核的共享类型
//
// 只保留**真实被使用**的类型。历史说明：本文件最初还定义了 Section /
// SectionContext / AssembleOptions（「先在每段分配 token，再渲染」的模型），
// 但读实际代码后确认两域都不是这个结构——它们是「候选逐条准入 + 剩余空间截断
// + 从尾部让位」（见 assemble.ts 的 assembleLoop）。那套 Section 模型没有使用方，
// 已删除，避免第二个口径。
//
// 现在的事实：
//   - 取舍循环 = assemble.ts:assembleLoop<T>（泛型，域侧给 include/renderText/toDropped）
//   - 预算公式 = budget.ts:computeBudget
//   - 本文件只管两边共用的枚举与条目形状

export type PackMode = 'full' | 'truncated'

export type DroppedReason = 'budget' | 'empty-content' | 'cut-order'

export interface DroppedEntry {
  /** 条目 id（两域现有数据都有；映射时不需 ?? '' 兜底） */
  id: string
  title: string
  reason: DroppedReason
  /**
   * 段号（work 用 6 表示知识段，渲染「本次未注入」时按它过滤；marketing 不填）。
   * 由产出它的段决定，内核不猜。
   */
  section?: number
}
