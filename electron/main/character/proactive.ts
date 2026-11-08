// electron/main/character/proactive.ts —— 主动性调度决策（纯逻辑）
//
// 判定顺序：开关/年龄 → silentUntil → 静默期（bornAt + silenceDays）→ 免打扰
// → 日上限 → 间隔（nextAllowedAt）→ 可发。
// 不做重试/不换通道：失败由调用方降级并记账。

import type { CharacterSettings, CharacterState } from './types'

export type ProactiveReason =
  | 'disabled'
  | 'silence-period'
  | 'quiet-hours'
  | 'daily-cap'
  | 'silent-until'
  | 'min-interval'
  | 'age-unconfirmed'
  /** 未回复累计到阈值：主动停发，等用户互动后重置（避免刷屏） */
  | 'unanswered-backoff'
  /** 本轮候选里没有合适内容（如全被去重挡掉） */
  | 'no-content'
  /** 与最近已发文案精确/近似重复 */
  | 'duplicate'
  /** 关系试探被 48h/同日/连续等闸门挡住 */
  | 'nudge-blocked'
  | 'ok'

export interface ProactiveDayState {
  /** 今日已主动发送条数 */
  activeSent?: number
  /** 今日已送语音条数（C08 用） */
  voiceSent?: number
  intimacyGained?: number
  events?: string[]
  /** 最近一次主动发送时间（兼容旧数据；与 lastProactiveAt 同步写） */
  lastActiveAt?: number
  /** 下一次最早可发送时间（发送后按设置间隔落盘；免打扰结束后最多补一条） */
  nextAllowedAt?: number
  /** 最近一次真正发出的主动消息时间（语义明确的新字段，与 lastActiveAt 同步） */
  lastProactiveAt?: number
  /** 最近已发主动消息文案（≤20，跨天沿用，精确/近似去重用） */
  recentSentTexts?: string[]
  /** 最近用过的话题 id（≤10，约 7 天窗口，同 topic 尽量不重复） */
  recentTopics?: string[]
  /** 最近一次发送的意图（life/topic/line/nudge；连续 intent 不重复） */
  lastIntent?: string
  /** 最近一次关系试探的 family（companion/sister/lover） */
  lastNudgeFamily?: string
  /** 最近一次关系试探时间（同 family 48h 内、同一天最多 1 次） */
  lastNudgeAt?: number
  /** 用户最后一次互动之后已发的主动消息条数（用于试探升级/backoff） */
  unansweredCount?: number
  /** 最近发送时间列表（≤20，跨天沿用；用于重算 unansweredCount，防旧数据漂移） */
  sentTimes?: number[]
}

/** 每日主动消息上限的硬上限 */
export const PROACTIVE_MAX_DAILY_CAP = 60

function clampIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) return 60
  return Math.max(1, Math.min(720, Math.round(value)))
}

/** 按设置算本次间隔；range 模式用 random 取区间内随机值（测试可注入） */
export function proactiveIntervalMs(
  settings: CharacterSettings,
  random: () => number = Math.random
): number {
  const p = settings.proactive
  if (p.intervalMode === 'range') {
    const a = clampIntervalMinutes(p.intervalMinMinutes)
    const b = clampIntervalMinutes(p.intervalMaxMinutes)
    const min = Math.min(a, b)
    const max = Math.max(a, b)
    return Math.round((min + random() * (max - min)) * 60_000)
  }
  return clampIntervalMinutes(p.intervalMinutes) * 60_000
}

export interface ProactiveContext {
  settings: CharacterSettings
  state: CharacterState
  day: ProactiveDayState
  now: number
  /** 本地日期 YYYY-MM-DD */
  today: string
  /** bornAt 缺失时（老数据）用它兜底静默期起点 */
  fallbackStartAt?: number
}

export interface ProactiveDecision {
  send: boolean
  reason: ProactiveReason
  /** external = 外部渠道（发送时再选最近互动的已绑定渠道）；app = 应用内气泡 */
  channel: 'external' | 'app'
}

/** 免打扰时间段（支持跨午夜，如 23:30 → 08:00） */
export function isQuietHours(now: number, quietFrom: string, quietTo: string): boolean {
  const from = parseHhMm(quietFrom)
  const to = parseHhMm(quietTo)
  if (from === null || to === null) return false
  const d = new Date(now)
  const minutes = d.getHours() * 60 + d.getMinutes()
  if (from === to) return false
  if (from < to) return minutes >= from && minutes < to
  // 跨午夜
  return minutes >= from || minutes < to
}

function parseHhMm(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '')
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function decideProactive(ctx: ProactiveContext): ProactiveDecision {
  const { settings, state, day, now } = ctx
  const channel: 'external' | 'app' = settings.proactive.channel === 'app' ? 'app' : 'external'
  const deny = (reason: ProactiveReason): ProactiveDecision => ({ send: false, reason, channel })

  if (!settings.enabled) return deny('disabled')
  if (!settings.proactive.enabled) return deny('disabled')
  // D10：未确认年龄前不主动打扰
  if (!settings.safety.ageConfirmed) return deny('age-unconfirmed')

  // 安静几天
  if (settings.proactive.silentUntil > now) return deny('silent-until')

  // 新收养静默期：从 bornAt（或最近一次互动）起 silenceDays 天内不主动
  const silenceDays = Math.max(0, Math.min(14, Math.round(settings.proactive.silenceDays)))
  if (silenceDays > 0) {
    const startAt = state.bornAt > 0 ? state.bornAt : (ctx.fallbackStartAt ?? state.lastInteractionAt)
    if (startAt > 0 && now - startAt < silenceDays * 86_400_000) return deny('silence-period')
  }

  // 免打扰（深夜不打扰）
  if (isQuietHours(now, settings.proactive.quietFrom, settings.proactive.quietTo)) {
    return deny('quiet-hours')
  }

  // 当日上限
  const cap = Math.max(
    0,
    Math.min(PROACTIVE_MAX_DAILY_CAP, Math.round(settings.proactive.dailyCap))
  )
  if ((day.activeSent ?? 0) >= cap) return deny('daily-cap')

  // 最小间隔：新数据用 nextAllowedAt；旧数据用 lastActiveAt + 设置间隔兜底
  const nextAllowedAt =
    day.nextAllowedAt ?? (day.lastActiveAt ? day.lastActiveAt + proactiveIntervalMs(settings) : 0)
  if (nextAllowedAt > now) return deny('min-interval')

  return { send: true, reason: 'ok', channel }
}
