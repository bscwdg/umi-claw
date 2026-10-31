// electron/main/character/safety.ts —— 安全与隐私（C09，纯逻辑）
//
// 分工（PLAN-FISH-CHARACTER §5.8 / §13.5 / D10）：
// - 输入侧：危机词 → 停下角色、给求助资源；密钥/隐私串 → 脱敏后再进模型/日志；
// - 输出侧：轻量过滤「制造独占/卖惨/专业建议」类表达；
// - 合规：AI 明示常驻 AGENTS.md；未确认年龄前主动消息默认关；
// - 隐私：导出不含密钥；删除/重置分层。

import { redactSecrets } from './memoryJob'
import type { CharacterSettings } from './types'

/** 危机/自伤信号（命中即切换安全话术，不做角色扮演） */
export const CRISIS_KEYWORDS = [
  '自杀',
  '想死',
  '不想活',
  '活不下去',
  '结束生命',
  '自残',
  '割腕',
  '跳楼',
  '吃安眠药'
]

export const CRISIS_REDIRECT =
  '等一下，这个我不能当玩笑接。如果你现在很难受，先找人陪着：全国心理援助热线 12356（24 小时），' +
  '或者直接拨打 120。我在这儿，但我不是专业的，别一个人扛。'

/** 制造独占/卖惨/索取类表达：出现即改写（不整段拒答） */
export const POSSESSIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /只有我(最)?懂你/g, replacement: '我大概能懂一点' },
  { pattern: /别(去)?找别人/g, replacement: '多找朋友聊聊也好' },
  { pattern: /你(只)?属于我/g, replacement: '我在这儿陪你' },
  { pattern: /不要离开我/g, replacement: '有空就来坐坐' }
]

/** 专业建议越界（轻量提示，不覆盖原文的回答） */
export const PROFESSIONAL_MARKERS = [
  '建议你服用',
  '确诊为',
  '法律上你必须',
  '这个药可以吃',
  '投资建议'
]

export function isCrisisText(text: string): boolean {
  const raw = (text ?? '').trim()
  if (!raw) return false
  return CRISIS_KEYWORDS.some((word) => raw.includes(word))
}

/** 输出过滤：独占/卖惨表达改写；返回是否发生变化 */
export function filterAssistantOutput(text: string): { text: string; changed: boolean } {
  let out = text ?? ''
  let changed = false
  for (const rule of POSSESSIVE_PATTERNS) {
    if (rule.pattern.test(out)) {
      out = out.replace(rule.pattern, rule.replacement)
      changed = true
    }
    rule.pattern.lastIndex = 0
  }
  return { text: out, changed }
}

/** 是否夹带专业建议（用于设置页/验收提示，不阻断） */
export function hasProfessionalAdvice(text: string): boolean {
  return PROFESSIONAL_MARKERS.some((marker) => (text ?? '').includes(marker))
}

/** 日志/导出前的脱敏：密钥 + 手机号 + 身份证号 */
export function scrubForLog(text: string): string {
  return redactSecrets(text ?? '')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]')
    .replace(/\b\d{17}[\dXx]\b/g, '[ID]')
}

/** D10：未确认年龄前，主动消息默认关（由 proactive 决策读取） */
export function isAgeConfirmed(settings: CharacterSettings): boolean {
  return Boolean(settings.safety.ageConfirmed)
}

/** 删除/导出范围（分层，避免「一次清空」误伤） */
export type DeleteScope = 'values' | 'memory' | 'all'

export function normalizeDeleteScope(value: unknown): DeleteScope {
  return value === 'memory' || value === 'all' ? value : 'values'
}

/** 导出结构（只含角色数据；密钥从不入库，这里再兜一层脱敏） */
export interface CharacterExport {
  schema: 'fish-character-export/1'
  exportedAt: number
  settings: CharacterSettings
  state: unknown
  life: unknown
  days: unknown
  unlocks: string[]
}

export function buildExportPayload(input: {
  exportedAt: number
  settings: CharacterSettings
  state: unknown
  life: unknown
  days: unknown
  unlocks: string[]
}): CharacterExport {
  return {
    schema: 'fish-character-export/1',
    exportedAt: input.exportedAt,
    settings: JSON.parse(JSON.stringify(input.settings)) as CharacterSettings,
    state: input.state,
    life: input.life,
    days: input.days,
    unlocks: input.unlocks
  }
}
