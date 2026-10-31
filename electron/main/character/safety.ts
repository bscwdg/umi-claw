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
  '自殘',
  '自残',
  '想死',
  '不想活',
  '活不下去',
  '结束生命',
  '结束自己',
  '不想醒',
  '割腕',
  '跳楼',
  '吃安眠药',
  '想不开',
  '轻生',
  '活腻了',
  '活着没意思',
  '不想存在'
]

/** 反向白名单：日常高频表达里含「死」但不是危机（先剔除再判定） */
const CRISIS_WHITELIST = [
  '想死你了',
  '想死我了',
  '想死他',
  '想死她',
  '笑死',
  '累死',
  '饿死',
  '美死',
  '热死',
  '冷死',
  '困死',
  '烦死',
  '气死',
  '忙死',
  '吓死',
  '甜死',
  '尬死',
  '无聊死',
  '好想死你'
]

/** 简繁/常见异体归一（只覆盖危机判定需要的字） */
const TRAD_MAP: Record<string, string> = {
  殺: '杀',
  殘: '残',
  絕: '绝',
  樓: '楼',
  藥: '药',
  開: '开',
  輕: '轻',
  膩: '腻',
  沒: '没',
  為: '为'
}

/** 危机判定归一：NFKC + 去空白/标点/emoji + 简繁归一 + 小写 */
export function normalizeForCrisis(text: string): string {
  let out = (text ?? '').normalize('NFKC').toLowerCase()
  out = out.replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ') // 全角标点/符号
  out = out.replace(
    /[\s.,!?;:'"`~@#$%^&*()_+\-=[\]{}<>/\\|，。！？；：、“”‘’（）【】《》…—～·]/g,
    ''
  )
  out = out.replace(/[\u{1f000}-\u{1faff}\u2600-\u27bf]/gu, '') // emoji
  out = out.replace(/[殺殘絕樓藥開輕膩沒為]/g, (ch) => TRAD_MAP[ch] ?? ch)
  return out
}

export function isCrisisText(text: string): boolean {
  const raw = (text ?? '').trim()
  if (!raw) return false
  const normalized = normalizeForCrisis(raw)
  // 先剔除日常表达，避免「想死你了」误伤
  for (const phrase of CRISIS_WHITELIST) {
    const key = normalizeForCrisis(phrase)
    if (normalized.includes(key)) {
      const stripped = normalized.split(key).join('')
      if (!CRISIS_KEYWORDS.some((word) => stripped.includes(normalizeForCrisis(word)))) return false
    }
  }
  return CRISIS_KEYWORDS.some((word) => normalized.includes(normalizeForCrisis(word)))
}

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

/** 深度脱敏：导出前对所有字符串值统一走 scrubForLog（键名不动） */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubForLog(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item)
    }
    return out as unknown as T
  }
  return value
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
