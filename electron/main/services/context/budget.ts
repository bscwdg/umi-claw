// electron/main/services/context/budget.ts —— 预算公式（W2-b）
//
// 只做一件事：window × ratio → 进预算的 token 与留给生成/历史的余量。
// 不做分配、不碰 DB、不依赖两域任何代码。
//
// 为什么单独抽：两域原本各写 `Math.floor(window * CONTEXT_BUDGET_RATIO)` 与
// `window - budgetTokens`，公式相同但 ratio 不同（0.7 / 0.6）。ratio 由调用方传入，
// 内核不写死——否则第三个域进来又要改内核。

export interface BudgetBreakdown {
  /** 进 Context Pack 的 token */
  budgetTokens: number
  /** 留给对话历史 / 生成 / 平台规则的余量 */
  reservedTokens: number
}

/**
 * 计算预算拆分。纯函数，不做范围校验——窗口合法性由调用方（requireWindow）负责。
 *
 * 取整口径：只对 `budgetTokens` 向下取整；`reservedTokens` 直接取差额，
 * 因此非整数窗口下它可能带小数（如 10.5 → 7 / 3.5），负数窗口会得到负数。
 * 这两种输入在上游已被 requireWindow 拒绝，这里保留纯数学行为、不额外兜底。
 */
export function computeBudget(windowTokens: number, ratio: number): BudgetBreakdown {
  const budgetTokens = Math.floor(windowTokens * ratio)
  return { budgetTokens, reservedTokens: windowTokens - budgetTokens }
}
