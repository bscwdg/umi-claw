// electron/main/services/context/limits.ts —— Context Pack 的共享常量
//
// 这两个域的上下文引擎原本各写一份，取值完全相同（WP2 已核对）：
//   窗口默认/上下界、单条知识最小占用、截断标记、dropped 标题显示长度。
// 下沉后只此一份；两个与域相关的值（预算占比、pack 固定开销）**故意留各域**，
// 因为它们本来就不同（work 0.7 / 48，marketing 0.6 / 64），不是复制粘贴。
//
// 改这些值会影响预算与截断行为，必须同时看 test/context.*.accept.mjs 的断言。

/**
 * 默认上下文窗口（token）。选 128k 作为一期的保守默认值。
 *
 * 注意：这只是**兜底**。拿到真实模型后应由调用方显式传 `contextWindowTokens`——
 * §六 记录的 `model` 取值是 `openclaw` / `openclaw/<agentId>`，映射不到 provider 的模型 id，
 * 所以窗口没法从 model 反推，必须由调用方给。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000

/** 合法窗口下界（比这更小的窗口连一份资料都放不下，属于配置错误而不是缺省） */
export const MIN_CONTEXT_WINDOW_TOKENS = 2_000

/** 合法窗口上界（防手滑写 128000000 把预算变成无上限） */
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000

/** 裁剪模式下单条知识至少值得占用的 token（塞半句不如显式说「还有更多」） */
export const KNOWLEDGE_ITEM_MIN_TOKENS = 120

export const ITEM_TRUNCATE_MARKER = '\n……（本条资料已按上下文预算截断，完整内容见知识库原文）'

/** 「未注入资料」最多展示的标题数（这串文字本身也占预算，必须有界） */
export const DROPPED_TITLES_SHOWN = 3

export const DROPPED_TITLE_MAX_CHARS = 20
