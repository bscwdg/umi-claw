// electron/main/character/proactive.ts —— 主动性调度决策（纯逻辑）
//
// 判定顺序（PLAN-FISH-CHARACTER §5.4）：
//   开关 → 静默期（bornAt + silenceDays）→ 免打扰 → 日上限 → silentUntil → 可发
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
  | 'ok'

export interface ProactiveDayState {
  /** 今日已主动发送条数 */
  activeSent?: number
  /** 今日已送语音条数（C08 用） */
  voiceSent?: number
  intimacyGained?: number
  events?: string[]
  /** 最近一次主动发送时间（最小间隔用） */
  lastActiveAt?: number
}

/** 两条主动消息之间的最小间隔：默认 1 小时（避免 tick 连发同一条内容） */
export const PROACTIVE_MIN_GAP_MS = 60 * 60_000

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
  const cap = Math.max(0, Math.min(10, Math.round(settings.proactive.dailyCap)))
  if ((day.activeSent ?? 0) >= cap) return deny('daily-cap')

  // 最小间隔：tick 每 30s，不设间隔会连发同一条内容
  if (day.lastActiveAt && now - day.lastActiveAt < PROACTIVE_MIN_GAP_MS) {
    return deny('min-interval')
  }

  return { send: true, reason: 'ok', channel }
}
