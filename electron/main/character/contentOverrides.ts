// electron/main/character/contentOverrides.ts —— 内置内容停用清单（话题/台词/生活卡）
//
// 为什么需要它：内置内容随安装包只读、升级会被覆盖，直接改 resources 会丢；
// 用户停用内置项的事实必须落在数据目录，并由归档包带走，否则换机后内置项会复活。
//
// 纯 Node（不 import electron/core），便于验收脚本直接打真源码。

export const CONTENT_KINDS = ['topics', 'lines', 'lifeCards'] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]

export interface DisabledLineRef {
  group: string
  line: string
}

export interface ContentOverrides {
  schema: 'fish-content-overrides/1'
  version: '1.0.0'
  kinds: {
    topics: { disabledIds: string[] }
    lines: { disabledGroups: string[]; disabledLines: DisabledLineRef[] }
    lifeCards: { disabledIds: string[] }
  }
}

const MAX_IDS = 2000
const MAX_LINES = 5000
const MAX_TEXT = 200
const MAX_GROUP = 64

function cleanText(raw: unknown, max = MAX_TEXT): string {
  return typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
    : ''
}

function uniqueStrings(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const value = cleanText(item, MAX_TEXT)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function uniqueLineRefs(raw: unknown): DisabledLineRef[] {
  if (!Array.isArray(raw)) return []
  const out: DisabledLineRef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const group = cleanText(record.group, MAX_GROUP)
    const line = cleanText(record.line, 300)
    if (!group || !line) continue
    const key = `${group}\u0000${line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ group, line })
    if (out.length >= MAX_LINES) break
  }
  return out
}

export function emptyContentOverrides(): ContentOverrides {
  return {
    schema: 'fish-content-overrides/1',
    version: '1.0.0',
    kinds: {
      topics: { disabledIds: [] },
      lines: { disabledGroups: [], disabledLines: [] },
      lifeCards: { disabledIds: [] }
    }
  }
}

/** 宽容解析：坏/缺字段回落空清单；不需要调用方先做 schema 校验 */
export function parseContentOverrides(raw: unknown): ContentOverrides {
  const src = (raw ?? {}) as Record<string, unknown>
  const kinds = (src.kinds ?? {}) as Record<string, unknown>
  const topics = (kinds.topics ?? {}) as Record<string, unknown>
  const lines = (kinds.lines ?? {}) as Record<string, unknown>
  const lifeCards = (kinds.lifeCards ?? {}) as Record<string, unknown>
  return {
    schema: 'fish-content-overrides/1',
    version: '1.0.0',
    kinds: {
      topics: { disabledIds: uniqueStrings(topics.disabledIds, MAX_IDS) },
      lines: {
        disabledGroups: uniqueStrings(lines.disabledGroups, MAX_IDS),
        disabledLines: uniqueLineRefs(lines.disabledLines)
      },
      lifeCards: { disabledIds: uniqueStrings(lifeCards.disabledIds, MAX_IDS) }
    }
  }
}

export function isTopicDisabled(overrides: ContentOverrides, id: string): boolean {
  return overrides.kinds.topics.disabledIds.includes(id)
}

export function isLineDisabled(
  overrides: ContentOverrides,
  group: string,
  line: string
): boolean {
  return overrides.kinds.lines.disabledLines.some(
    (item) => item.group === group && item.line === line
  )
}

export function isGroupDisabled(overrides: ContentOverrides, group: string): boolean {
  return overrides.kinds.lines.disabledGroups.includes(group)
}

export function isLifeCardDisabled(overrides: ContentOverrides, id: string): boolean {
  return overrides.kinds.lifeCards.disabledIds.includes(id)
}

function toggle(list: string[], value: string, disabled: boolean): string[] {
  const rest = list.filter((item) => item !== value)
  return disabled ? [...rest, value] : rest
}

export function setTopicDisabled(
  overrides: ContentOverrides,
  id: string,
  disabled: boolean
): ContentOverrides {
  const value = cleanText(id)
  if (!value) return overrides
  return {
    ...overrides,
    kinds: {
      ...overrides.kinds,
      topics: { disabledIds: toggle(overrides.kinds.topics.disabledIds, value, disabled) }
    }
  }
}

export function setLifeCardDisabled(
  overrides: ContentOverrides,
  id: string,
  disabled: boolean
): ContentOverrides {
  const value = cleanText(id)
  if (!value) return overrides
  return {
    ...overrides,
    kinds: {
      ...overrides.kinds,
      lifeCards: {
        disabledIds: toggle(overrides.kinds.lifeCards.disabledIds, value, disabled)
      }
    }
  }
}

export function setGroupDisabled(
  overrides: ContentOverrides,
  group: string,
  disabled: boolean
): ContentOverrides {
  const value = cleanText(group, MAX_GROUP)
  if (!value) return overrides
  return {
    ...overrides,
    kinds: {
      ...overrides.kinds,
      lines: {
        ...overrides.kinds.lines,
        disabledGroups: toggle(overrides.kinds.lines.disabledGroups, value, disabled)
      }
    }
  }
}

export function setLineDisabled(
  overrides: ContentOverrides,
  group: string,
  line: string,
  disabled: boolean
): ContentOverrides {
  const g = cleanText(group, MAX_GROUP)
  const text = cleanText(line, 300)
  if (!g || !text) return overrides
  const rest = overrides.kinds.lines.disabledLines.filter(
    (item) => !(item.group === g && item.line === text)
  )
  return {
    ...overrides,
    kinds: {
      ...overrides.kinds,
      lines: {
        ...overrides.kinds.lines,
        disabledLines: disabled ? [...rest, { group: g, line: text }] : rest
      }
    }
  }
}

/** 恢复某一类全部内置项；kind 省略 = 全部恢复 */
export function restoreOverrides(
  overrides: ContentOverrides,
  kind?: ContentKind
): ContentOverrides {
  const empty = emptyContentOverrides()
  if (!kind) return empty
  return {
    ...overrides,
    kinds: { ...overrides.kinds, [kind]: empty.kinds[kind] }
  }
}

export function hasAnyOverride(overrides: ContentOverrides): boolean {
  return (
    overrides.kinds.topics.disabledIds.length > 0 ||
    overrides.kinds.lines.disabledGroups.length > 0 ||
    overrides.kinds.lines.disabledLines.length > 0 ||
    overrides.kinds.lifeCards.disabledIds.length > 0
  )
}
