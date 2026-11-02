// work/routerManager.ts —— 一句话入口路由（PLAN-3.0.md §5.2 / §14 B3）
//
// Router **不是聊天窗**：用户不需要知道有哪些工具。本地关键词规则优先——
// 零成本、零延迟、离线可用；未命中默认进工作问答（最通用兜底）。
//
// **B3：永不失败（硬规则）**——参数非法、规则未命中、文本为空，一律返回 'qa' 兜底；
// 这是全系统唯一不抛错误信封的通道。
//
// 长文本识别：多行粘贴或超过阈值 → 视为「素材」，配合 整理/总结/纪要 等词跳工具页预填。
//
// 本模块不 import electron；纯函数 + 注入 now()（供「周四」类相对日期推算），纯 Node 可测。

/** 路由目标（稳定标识；工具页在 Commit 07 落地，此处先产出 target 字符串） */
export const ROUTE_TARGETS = {
  /** 待办/记录：AI 提取结构化 → 候选卡 */
  TODO_EXTRACT: 'todo_extract',
  TOOL_MINUTES: 'tool_minutes',
  TOOL_SUMMARY: 'tool_summary',
  TOOL_TRANSLATE: 'tool_translate',
  TOOL_POLISH: 'tool_polish',
  EMAIL_DRAFT: 'email_draft',
  REPORT: 'report',
  /** 工作问答（默认兜底，永不「没反应」） */
  QA: 'qa'
} as const
export type RouteTarget = (typeof ROUTE_TARGETS)[keyof typeof ROUTE_TARGETS]

/** 长文本阈值（字符）：超过即视为粘贴的素材 */
export const LONG_TEXT_THRESHOLD = 50

export interface TodoDraft {
  /** best-effort 标题（剥掉提醒词后的剩余文本） */
  title: string
  /** 从「周四」等词推算的到期日（无法推算为 null） */
  dueDate: string | null
}

export interface RouteResult {
  target: RouteTarget
  /** 命中的规则（误判出路展示：「识别为：X · 转工作问答」） */
  reason: string
  /** 是否长文本素材 */
  longText: boolean
  /** 原文（工具页预填用，已 trim） */
  text: string
  /** target=todo_extract 时的初步提取 */
  draft: TodoDraft | null
}

export interface RouterOptions {
  now?: () => number
}

export class RouterManager {
  private readonly now: () => number

  constructor(options: RouterOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /** 路由（B3：永不抛错） */
  route(rawInput: unknown): RouteResult {
    const text = typeof rawInput === 'string' ? rawInput.trim() : ''
    const longText = text.includes('\n') || text.length > LONG_TEXT_THRESHOLD

    // 空输入 → qa 兜底（B3）
    if (!text) {
      return { target: ROUTE_TARGETS.QA, reason: '空输入 → 工作问答兜底', longText: false, text: '', draft: null }
    }

    // 疑问句（怎么/吗/为什么/？等）且不是强祈使 → 优先 qa
    const isQuestion = /[?？]|怎么|为什么|是不是|能不能|可不可以|什么是|如何/.test(text)

    // 1) 邮件：要求出现「邮件」（「客户嫌贵怎么回复」是问答，不跳邮件）
    if (text.includes('邮件')) {
      return result(ROUTE_TARGETS.EMAIL_DRAFT, '命中「邮件」→ 邮件草拟', text, longText)
    }

    // 2) 报告：强祈使（写/生成/出/做/发 + 日报/周报），或「做了什么总结」，或单独的日报/周报
    const reportHit =
      /(写|生成|出|做|发|来一?份).{0,4}(日报|周报)/.test(text) ||
      /做了什么/.test(text) ||
      /^(今天|今天的|我的)?(日报|周报)$/.test(text.trim())
    if (reportHit) {
      const type = /周报/.test(text) ? 'weekly' : 'daily'
      return result(ROUTE_TARGETS.REPORT, `命中报告关键词 → ${type === 'weekly' ? '周报' : '日报'}`, text, longText)
    }

    // 3) 待办/提醒：提醒我/记一下/别忘了/待办，或「周X要/去…」
    const todoHit =
      /提醒我|记一下|记一个|记条|别忘了|待办|要记得/.test(text) ||
      /周[一二三四五六日天末][^，。]{0,8}(要|去|得)/.test(text)
    if (todoHit) {
      return {
        target: ROUTE_TARGETS.TODO_EXTRACT,
        reason: '命中待办/提醒词 → 结构化提取候选',
        longText,
        text,
        draft: this.extractTodoDraft(text)
      }
    }

    // 4) 工具类：纪要 / 摘要 / 翻译 / 润色
    //    纪要、摘要按 §5.2 是「长文本 + 关键词」；翻译/润色长短皆可
    if (/纪要|会议记录|整理会议/.test(text)) {
      return result(ROUTE_TARGETS.TOOL_MINUTES, '命中「纪要/会议」→ 会议纪要', text, longText)
    }
    if (longText && /总结|摘要|概括/.test(text)) {
      return result(ROUTE_TARGETS.TOOL_SUMMARY, '长文本 + 「总结/摘要」→ 摘要工具', text, longText)
    }
    if (/翻译|译成|翻成|英文|日文/.test(text)) {
      return result(ROUTE_TARGETS.TOOL_TRANSLATE, '命中「翻译」→ 翻译工具', text, longText)
    }
    if (/润色|改正式|改轻松|语气|改得?通顺|改一下/.test(text)) {
      return result(ROUTE_TARGETS.TOOL_POLISH, '命中「润色/语气」→ 润色工具', text, longText)
    }
    // 短文本里的总结/摘要无素材可加工 → 不跳工具，落到 qa（有疑问语义）或报告都不命中时
    if (/总结|摘要/.test(text) && !isQuestion) {
      return result(ROUTE_TARGETS.TOOL_SUMMARY, '命中「总结/摘要」→ 摘要工具', text, longText)
    }

    // 5) 默认：工作问答（永远不会「没反应」）
    return result(ROUTE_TARGETS.QA, '未命中本地规则 → 工作问答兜底', text, longText)
  }

  /** 待办初步提取：剥提醒词得标题；解析「周X」得到期日 */
  private extractTodoDraft(text: string): TodoDraft {
    let title = text
      .replace(/提醒我|记一下|记一个|记条|别忘了|要记得|待办/g, '')
      .replace(/^[，,：:\s]+|[，。！!？?\s]+$/g, '')
      .trim()
    if (!title) title = text
    return { title: title.slice(0, 200), dueDate: this.parseWeekday(text) }
  }

  /** 「周X」→ 下一个该星期几的日期；无法解析 → null */
  private parseWeekday(text: string): string | null {
    const m = text.match(/周([一二三四五六日天末])/)
    if (!m) return null
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6 }
    const target = map[m[1]]
    const now = new Date(this.now())
    // 当前是星期几（0=周日）
    const cur = now.getDay()
    let delta = (target - cur + 7) % 7
    if (delta === 0) delta = 7 // 「本周三」若已过则指下周；同一天保守也取下一次
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dt = new Date(now.getTime() + delta * 24 * 60 * 60 * 1000)
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  }
}

function result(target: RouteTarget, reason: string, text: string, longText: boolean): RouteResult {
  return { target, reason, longText, text, draft: null }
}

export function createRouterManager(options?: RouterOptions): RouterManager {
  return new RouterManager(options)
}
