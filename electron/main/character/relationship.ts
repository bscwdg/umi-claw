// electron/main/character/relationship.ts —— 关系引擎（C05，纯逻辑可测）
//
// 规则写死在常量表里（PLAN-FISH-CHARACTER §5.2：不做后台可调）：
// - 事件 → 三轴增量；每日上限；refId 幂等（默认 7 天窗口）；
// - 阶段只升不降；跨天重置日计数；首日互动累计连续天数；
// - 模型只提议、宿主按白名单 × 上限应用（C06 接模型信号时复用）。
//
// 不依赖 electron / fs：输入状态快照 + 事件 + 上下文，输出新状态与结果。

import type { CharacterState } from './types'

export type RelationshipEventType =
  | 'chat.message'
  | 'voice.listen'
  | 'voice.request'
  | 'interact.pat'
  | 'interact.feed'
  | 'day.streak'
  | 'milestone'
  | 'teach.fact'

export interface RelationshipEvent {
  type: RelationshipEventType
  /** 幂等键（同一条消息/同一次里程碑重复上报只算一次） */
  refId?: string
  at?: number
}

export interface RelationshipRule {
  familiarity: number
  intimacy: number
  dailyCap: number
}

export const RELATIONSHIP_RULES: Record<RelationshipEventType, RelationshipRule> = {
  'chat.message': { familiarity: 1, intimacy: 1, dailyCap: 20 },
  'voice.listen': { familiarity: 1, intimacy: 0, dailyCap: 10 },
  'voice.request': { familiarity: 0, intimacy: 1, dailyCap: 3 },
  'interact.pat': { familiarity: 1, intimacy: 0, dailyCap: 10 },
  'interact.feed': { familiarity: 0, intimacy: 1, dailyCap: 5 },
  'day.streak': { familiarity: 1, intimacy: 0, dailyCap: 1 },
  milestone: { familiarity: 3, intimacy: 2, dailyCap: 3 },
  'teach.fact': { familiarity: 0, intimacy: 1, dailyCap: 5 }
}

/** 阶段阈值（按熟悉度，只升不降） */
export const STAGE_THRESHOLDS: Array<{ stage: CharacterState['stage']; minFamiliarity: number }> = [
  { stage: 4, minFamiliarity: 90 },
  { stage: 3, minFamiliarity: 60 },
  { stage: 2, minFamiliarity: 30 },
  { stage: 1, minFamiliarity: 10 },
  { stage: 0, minFamiliarity: 0 }
]

export const STAGE_UNLOCKS: Record<number, string[]> = {
  1: ['称昵称'],
  2: ['收集贝壳', '摸头'],
  3: ['一个秘密'],
  4: ['进阶称呼']
}

export const DEDUP_WINDOW_MS = 7 * 86_400_000
const FAMILIARITY_CAP = 100
const INTIMACY_CAP = 100

export interface RelationshipApplyContext {
  now: number
  /** 本地日期 YYYY-MM-DD */
  today: string
  /** 旧 dedup 表（refId → at） */
  dedup: Record<string, number>
}

export interface RelationshipApplyResult {
  state: CharacterState
  dedup: Record<string, number>
  applied: boolean
  reason?: 'duplicate' | 'daily-cap' | 'unknown-event'
  delta: { familiarity: number; intimacy: number }
  stageChanged: boolean
  unlocked: string[]
}

export function applyRelationshipEvent(
  state: CharacterState,
  event: RelationshipEvent,
  ctx: RelationshipApplyContext
): RelationshipApplyResult {
  const rule = RELATIONSHIP_RULES[event.type]
  const next: CharacterState = {
    ...state,
    dayCounters: { ...(state.dayCounters ?? {}) },
    dayKey: state.dayKey ?? ctx.today
  }
  const dedup = { ...ctx.dedup }
  const base: RelationshipApplyResult = {
    state: next,
    dedup,
    applied: false,
    delta: { familiarity: 0, intimacy: 0 },
    stageChanged: false,
    unlocked: []
  }
  if (!rule) return { ...base, reason: 'unknown-event' }

  // 幂等：同 refId 在窗口内只算一次（长度截断 + 原型键防护）
  const refKey = event.refId ? sanitizeRefId(event.refId) : ''
  if (refKey) {
    const last = dedup[refKey]
    if (typeof last === 'number' && ctx.now - last < DEDUP_WINDOW_MS) {
      return { ...base, reason: 'duplicate' }
    }
  }

  // 跨天：重置日计数 + 连续天数
  if (next.dayKey !== ctx.today) {
    next.dayKey = ctx.today
    next.dayCounters = {}
    const lastDay = next.lastInteractionAt > 0 ? toDateKey(next.lastInteractionAt) : ''
    const yesterday = toDateKey(ctx.now - 86_400_000)
    next.streakDays = lastDay === yesterday ? next.streakDays + 1 : 1
  } else if (next.lastInteractionAt === 0) {
    next.streakDays = Math.max(1, next.streakDays)
  }

  // 每日上限
  const used = next.dayCounters?.[event.type] ?? 0
  if (rule.dailyCap >= 0 && used >= rule.dailyCap) {
    return { ...base, reason: 'daily-cap' }
  }
  next.dayCounters = { ...(next.dayCounters ?? {}), [event.type]: used + 1 }

  const dFamiliarity = Math.max(0, rule.familiarity)
  const dIntimacy = Math.max(0, rule.intimacy)
  next.familiarity = Math.min(FAMILIARITY_CAP, next.familiarity + dFamiliarity)
  next.intimacy = Math.min(INTIMACY_CAP, next.intimacy + dIntimacy)
  next.lastInteractionAt = ctx.now
  next.updatedAt = ctx.now

  if (refKey) dedup[refKey] = ctx.now
  const pruned = pruneDedup(dedup, ctx.now)

  // 阶段只升不降
  const targetStage = stageForFamiliarity(next.familiarity)
  const stageChanged = targetStage > next.stage
  const unlocked: string[] = []
  if (stageChanged) {
    for (let s = next.stage + 1; s <= targetStage; s += 1) {
      unlocked.push(...(STAGE_UNLOCKS[s] ?? []))
    }
    next.stage = targetStage
  }

  return {
    state: next,
    dedup: pruned,
    applied: true,
    delta: { familiarity: dFamiliarity, intimacy: dIntimacy },
    stageChanged,
    unlocked
  }
}

export function stageForFamiliarity(familiarity: number): CharacterState['stage'] {
  for (const row of STAGE_THRESHOLDS) {
    if (familiarity >= row.minFamiliarity) return row.stage
  }
  return 0
}

export function pruneDedup(
  dedup: Record<string, number>,
  now: number,
  windowMs = DEDUP_WINDOW_MS
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, at] of Object.entries(dedup)) {
    if (typeof at === 'number' && now - at < windowMs) out[key] = at
  }
  return out
}

export function toDateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** refId 幂等键消毒：防 __proto__/constructor 原型键与超长键污染幂等表 */
export function sanitizeRefId(refId: string): string {
  const raw = String(refId ?? '').trim()
  if (!raw) return ''
  const safe = raw.replace(/[^\w:.\-]/g, '_').slice(0, 64)
  if (!safe || safe === '__proto__' || safe === 'constructor' || safe === 'prototype') {
    return `ref:${safe || 'empty'}`
  }
  return `ref:${safe}`
}
