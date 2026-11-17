// electron/main/character/contentStore.ts —— 用户主动消息语料库（话题/台词/生活卡 + 内置停用清单，纯 Node）
//
// 为什么单独成文件：内置话题/台词/生活卡在 resources/character/cards 随包只读，用户无法增删；
// 用户语料独立落 <dataDir>/character/content/*.user.json，与内置合并后再喂给内容引擎，
// 升级覆盖安装目录不影响用户数据。与 stickerStore 同口径：不 import electron，验收可直接 bundle 真源码。
//
// 合并语义（让用户能「接管」内置卡又能随时回退）：
// - 话题按 id：用户同 id 卡覆盖内置卡；删除用户卡后自动回落到内置版本。
// - 台词按组：用户句在同名组末尾追加（内置句始终保留），删除只动用户句。
// - 生活卡按 id：内置在前、用户同 id 覆盖、用户新卡追加；停用清单只过滤内置卡，用户自己的卡不受影响。
// - 停用清单（overrides.user.json）单独落盘：内置内容随包只读，直接改 resources 升级会丢；
//   停用事实必须跟着数据目录与归档包走，否则换机后内置项会复活。
// - 用户文件缺失/损坏一律回落空语料，绝不阻断主动消息。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseLifeDeck, type LifeCard, type LifeDeck } from './contentCards'
import {
  createEmptyContentDeck,
  parseLineDeck,
  parseTopicDeck,
  type ContentDeck,
  type LineDeck,
  type TopicCard,
  type TopicDeck
} from './contentEngine'
import {
  emptyContentOverrides,
  isGroupDisabled,
  isLifeCardDisabled,
  isLineDisabled,
  isTopicDisabled,
  parseContentOverrides,
  restoreOverrides as restoreOverridesList,
  setGroupDisabled as setGroupDisabledList,
  setLifeCardDisabled as setLifeCardDisabledList,
  setLineDisabled as setLineDisabledList,
  setTopicDisabled as setTopicDisabledList,
  type ContentKind,
  type ContentOverrides
} from './contentOverrides'
import { CharacterError, CHARACTER_ERROR_CODES } from './types'

/** 用户语料 IPC（特性模块自持通道，命名按 <domain>:<entity>:<method>，与 stickerStore 同口径） */
export const CHARACTER_CONTENT_CHANNELS = {
  overview: 'character:content:overview',
  importTopics: 'character:content:import-topics',
  importLines: 'character:content:import-lines',
  deleteTopic: 'character:content:delete-topic',
  deleteLine: 'character:content:delete-line',
  reset: 'character:content:reset',
  exportMerged: 'character:content:export'
} as const

export const CONTENT_DIR = 'content'
export const USER_TOPICS_FILE = 'topics.user.json'
export const USER_LINES_FILE = 'lines.user.json'
export const USER_OVERRIDES_FILE = 'overrides.user.json'
export const USER_LIFE_CARDS_FILE = 'life-cards.user.json'
/** 防呆上限（不是业务硬限制）：避免一次导入把数据目录撑爆 */
export const USER_TOPIC_MAX = 200
export const USER_LINE_GROUPS_MAX = 50
export const USER_LIFE_CARD_MAX = 200

export interface ContentStoreOptions {
  /** 应用数据目录（用户语料落 <dataDir>/character/content/） */
  dataDir: string
  /** 内置内容包读取器（由 wiring 注入，读 resources 只读资源） */
  loadBuiltin: () => ContentDeck | Promise<ContentDeck>
  /**
   * 内置生活卡读取器（由 wiring 注入，读 resources/character/cards/life-cards.v1.json）。
   * 可选：未注入时生活卡合并退化为「只有用户卡」，不阻断既有功能的验收/测试。
   */
  loadBuiltinLife?: () => LifeDeck | Promise<LifeDeck>
  logger?: (message: string) => void
}

/** 话题总览项：在 TopicCard 上标注来源；内置可停用，用户可删 */
export type TopicOverviewItem = TopicCard & {
  source: 'builtin' | 'user'
  /** 仅内置项可能为 true：被停用的内置卡仍要列出来，UI 才能显示「已停用/恢复」 */
  disabled?: boolean
}

/** 生活卡总览项：与话题同口径（内置可停用，用户可删） */
export type LifeCardOverviewItem = LifeCard & {
  source: 'builtin' | 'user'
  disabled?: boolean
}

export interface LineGroupOverview {
  name: string
  /** 内置句完整列表：即使组/单句被停用也不裁剪，UI 需要它来展示与恢复 */
  builtinLines: string[]
  userLines: string[]
  /** 整组被停用（只影响内置句，用户自己追加的台词不受影响） */
  disabled?: boolean
  /** 该组内置句里被单句停用的文本（组停用时仍按单句如实上报） */
  disabledLines?: string[]
}

export interface ContentOverview {
  topics: TopicOverviewItem[]
  lineGroups: LineGroupOverview[]
  builtinTopicCount: number
  userTopicCount: number
  userLineCount: number
}

export interface ImportTopicsResult {
  added: number
  updated: number
  total: number
}

export interface ImportLinesResult {
  groupsAdded: number
  linesAdded: number
  totalLines: number
}

export interface ImportLifeDeckResult {
  added: number
  updated: number
  total: number
}

export interface ContentStorePaths {
  characterDir: string
  dir: string
  topicsPath: string
  linesPath: string
  overridesPath: string
  lifeCardsPath: string
}

export interface ContentStore {
  paths(): ContentStorePaths
  /** 读内置内容停用清单（坏文件回落空清单，不阻断主动消息） */
  overrides(): Promise<ContentOverrides>
  /** 导出停用清单（与 overrides 同值；归档导出显式调用，语义更清楚） */
  exportOverrides(): Promise<ContentOverrides>
  /** 导入停用清单：宽容解析（缺字段/坏值回落空清单）后原子写盘并返回 */
  importOverrides(raw: unknown): Promise<ContentOverrides>
  setTopicDisabled(id: string, disabled: boolean): Promise<ContentOverrides>
  setGroupDisabled(group: string, disabled: boolean): Promise<ContentOverrides>
  setLineDisabled(group: string, line: string, disabled: boolean): Promise<ContentOverrides>
  setLifeCardDisabled(id: string, disabled: boolean): Promise<ContentOverrides>
  /** 恢复某一类内置项；kind 省略 = 全部恢复 */
  restoreOverrides(kind?: ContentKind): Promise<ContentOverrides>
  /** 读用户语料并与内置合并成引擎可用的内容包（坏文件回落仅内置；内置按停用清单过滤） */
  mergeForEngine(builtin?: ContentDeck): Promise<ContentDeck>
  /** 渲染端总览：每条语料标注 builtin/user，内置只读；被停用的内置项标 disabled */
  overview(): Promise<ContentOverview>
  importTopics(raw: unknown): Promise<ImportTopicsResult>
  importLines(raw: unknown): Promise<ImportLinesResult>
  /** 单张话题 upsert（UI/agent 编辑用）：保留文件原有额外字段与其他卡 */
  updateUserTopic(raw: unknown): Promise<TopicCard>
  /** 仅删用户话题卡；内置 id 拒删。返回是否命中并删除 */
  deleteUserTopic(id: string): Promise<boolean>
  /** 仅删用户台词句（组名 + 组内下标）；内置句拒删 */
  deleteUserLine(group: string, index: number): Promise<boolean>
  /** 单张生活卡 upsert（用户卡）；返回写入的卡 */
  upsertUserLifeCard(raw: unknown): Promise<LifeCard>
  /** 仅删用户生活卡；内置 id 拒删 */
  deleteUserLifeCard(id: string): Promise<boolean>
  /** 把一份 LifeDeck 合并进用户生活卡（同 id 覆盖、新 id 追加，上限 200 张） */
  importLifeDeck(raw: unknown): Promise<ImportLifeDeckResult>
  /** 生活卡合并：内置过滤停用 → 用户同 id 覆盖 → 追加用户新卡 */
  mergeLifeDeck(builtin?: LifeDeck): Promise<LifeDeck>
  /** 导出合并后的生活卡（内置 + 用户；归档导出用） */
  exportLifeMerged(): Promise<LifeDeck>
  /** 生活卡总览：内置（含被停用项）+ 用户卡，标注 source/disabled */
  listLifeCards(): Promise<LifeCardOverviewItem[]>
  /** 清空用户语料；kind=topics/lines/all，返回各自清掉的条数 */
  resetUser(kind: 'topics' | 'lines' | 'all'): Promise<{ topics: number; lines: number }>
  /** 导出合并后的完整内容包（供用户基于内置改完再导入） */
  exportMerged(): Promise<ContentDeck>
}

function emptyTopicDeck(): TopicDeck {
  return { schema: 'fish-topics/1', version: '0.0.0', topics: [] }
}

function emptyLineDeck(): LineDeck {
  return { schema: 'fish-lines/1', version: '0.0.0', groups: {} }
}

function emptyLifeDeck(): LifeDeck {
  return { schema: 'fish-life-cards/1', version: '0.0.0', cards: [] }
}

/** 保序去重：保留首次出现的句子（内置在前时即内置优先），用于跨内置/用户边界的台词语料合并 */
function dedupePreservingOrder(lines: string[]): string[] {
  return [...new Set(lines)]
}

/** 原子写文本（临时文件 + rename），避免半截 json 把语料库写坏（与 stickerStore 同写法） */
function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, absPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    writeFileSync(absPath, content, 'utf8')
  }
}

export function createContentStore(options: ContentStoreOptions): ContentStore {
  const paths = (): ContentStorePaths => {
    const characterDir = join(options.dataDir, 'character')
    const dir = join(characterDir, CONTENT_DIR)
    return {
      characterDir,
      dir,
      topicsPath: join(dir, USER_TOPICS_FILE),
      linesPath: join(dir, USER_LINES_FILE),
      overridesPath: join(dir, USER_OVERRIDES_FILE),
      lifeCardsPath: join(dir, USER_LIFE_CARDS_FILE)
    }
  }

  const writeJsonAtomic = (absPath: string, value: unknown): void => {
    writeAtomic(absPath, `${JSON.stringify(value, null, 2)}\n`)
  }

  const readUserTopics = (): TopicDeck => {
    const file = paths().topicsPath
    if (!existsSync(file)) return emptyTopicDeck()
    try {
      return parseTopicDeck(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      options.logger?.(
        `[character] 用户话题语料损坏，本轮忽略: ${(error as Error)?.message ?? String(error)}`
      )
      return emptyTopicDeck()
    }
  }

  /**
   * 读话题文件原文：单卡 upsert 要保留「其他卡」与文件级额外字段，
   * 必须先拿到原始 JSON，不能走 parseTopicDeck（它会丢掉解析器不认识的字段）。
   */
  const readUserTopicsRaw = (): Record<string, unknown> => {
    const file = paths().topicsPath
    const fallback = (): Record<string, unknown> => ({
      schema: 'fish-topics/1',
      version: '0.0.0',
      topics: []
    })
    if (!existsSync(file)) return fallback()
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback()
      return parsed as Record<string, unknown>
    } catch (error) {
      options.logger?.(
        `[character] 用户话题语料损坏，按空文件重建: ${(error as Error)?.message ?? String(error)}`
      )
      return fallback()
    }
  }

  const readUserLines = (): LineDeck => {
    const file = paths().linesPath
    if (!existsSync(file)) return emptyLineDeck()
    try {
      return parseLineDeck(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      options.logger?.(
        `[character] 用户台词语料损坏，本轮忽略: ${(error as Error)?.message ?? String(error)}`
      )
      return emptyLineDeck()
    }
  }

  const readOverrides = (): ContentOverrides => {
    const file = paths().overridesPath
    if (!existsSync(file)) return emptyContentOverrides()
    try {
      return parseContentOverrides(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      // 坏文件回落空清单：宁可让内置项全部恢复可见，也不能让主动消息因一份清单挂掉
      options.logger?.(
        `[character] 内容停用清单损坏，本轮按空清单处理: ${(error as Error)?.message ?? String(error)}`
      )
      return emptyContentOverrides()
    }
  }

  const writeOverrides = (overrides: ContentOverrides): void => {
    writeJsonAtomic(paths().overridesPath, overrides)
  }

  const readUserLifeDeck = (): LifeDeck => {
    const file = paths().lifeCardsPath
    if (!existsSync(file)) return emptyLifeDeck()
    try {
      return parseLifeDeck(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      options.logger?.(
        `[character] 用户生活卡损坏，本轮忽略: ${(error as Error)?.message ?? String(error)}`
      )
      return emptyLifeDeck()
    }
  }

  const writeUserLifeDeck = (deck: LifeDeck): void => {
    writeJsonAtomic(paths().lifeCardsPath, deck)
  }

  const writeUserTopics = (deck: TopicDeck): void => {
    writeJsonAtomic(paths().topicsPath, deck)
  }

  const writeUserLines = (deck: LineDeck): void => {
    writeJsonAtomic(paths().linesPath, deck)
  }

  const readBuiltinSafe = async (): Promise<ContentDeck> => {
    try {
      return await options.loadBuiltin()
    } catch (error) {
      options.logger?.(
        `[character] 内置语料读取失败，总览仅显示用户语料: ${(error as Error)?.message ?? String(error)}`
      )
      return createEmptyContentDeck()
    }
  }

  const readBuiltinLifeSafe = async (): Promise<LifeDeck> => {
    if (!options.loadBuiltinLife) return emptyLifeDeck()
    try {
      return await options.loadBuiltinLife()
    } catch (error) {
      options.logger?.(
        `[character] 内置生活卡读取失败，生活卡合并仅含用户卡: ${(error as Error)?.message ?? String(error)}`
      )
      return emptyLifeDeck()
    }
  }

  return {
    paths,

    async overrides(): Promise<ContentOverrides> {
      return readOverrides()
    },

    async exportOverrides(): Promise<ContentOverrides> {
      return readOverrides()
    },

    async importOverrides(raw: unknown): Promise<ContentOverrides> {
      // 宽容解析后原子写盘：字段缺失/非法值回落成空清单（与读取同口径，不抛错）
      const next = parseContentOverrides(raw)
      writeOverrides(next)
      return next
    },

    async setTopicDisabled(id: string, disabled: boolean): Promise<ContentOverrides> {
      const next = setTopicDisabledList(readOverrides(), id, disabled)
      writeOverrides(next)
      return next
    },

    async setGroupDisabled(group: string, disabled: boolean): Promise<ContentOverrides> {
      const next = setGroupDisabledList(readOverrides(), group, disabled)
      writeOverrides(next)
      return next
    },

    async setLineDisabled(
      group: string,
      line: string,
      disabled: boolean
    ): Promise<ContentOverrides> {
      const next = setLineDisabledList(readOverrides(), group, line, disabled)
      writeOverrides(next)
      return next
    },

    async setLifeCardDisabled(id: string, disabled: boolean): Promise<ContentOverrides> {
      const next = setLifeCardDisabledList(readOverrides(), id, disabled)
      writeOverrides(next)
      return next
    },

    async restoreOverrides(kind?: ContentKind): Promise<ContentOverrides> {
      const next = restoreOverridesList(readOverrides(), kind)
      writeOverrides(next)
      return next
    },

    async mergeForEngine(builtin?: ContentDeck): Promise<ContentDeck> {
      const base = builtin ?? (await readBuiltinSafe())
      const overrides = readOverrides()
      const userTopics = readUserTopics()
      const userLines = readUserLines()
      const userTopicIds = new Set(userTopics.topics.map((topic) => topic.id))
      // 用户同 id 卡接管内置卡：先放未被接管、且未被停用的内置卡，再追加全部用户卡
      // （停用清单只针对内置项；用户自己写的卡即使同 id 也不过滤）
      const topics = [
        ...base.topics.topics.filter(
          (topic) => !userTopicIds.has(topic.id) && !isTopicDisabled(overrides, topic.id)
        ),
        ...userTopics.topics
      ]
      const groups: Record<string, string[]> = {}
      for (const [name, lines] of Object.entries(base.lines.groups)) {
        if (isGroupDisabled(overrides, name)) continue
        const kept = lines.filter((line) => !isLineDisabled(overrides, name, line))
        if (kept.length > 0) groups[name] = kept
      }
      for (const [name, lines] of Object.entries(userLines.groups)) {
        // 跨内置/用户边界保序去重：内置句在前优先保留，用户导入与内置重复的句不抬高随机权重
        groups[name] = dedupePreservingOrder([...(groups[name] ?? []), ...lines])
      }
      return {
        topics: { ...base.topics, topics },
        lines: { ...base.lines, groups }
      }
    },

    async overview(): Promise<ContentOverview> {
      const builtin = await readBuiltinSafe()
      const overrides = readOverrides()
      const userTopics = readUserTopics()
      const userLines = readUserLines()
      const userTopicIds = new Set(userTopics.topics.map((topic) => topic.id))
      const topics: TopicOverviewItem[] = []
      for (const topic of builtin.topics.topics) {
        const disabled = isTopicDisabled(overrides, topic.id)
        // 用户同 id 接管后不再重复列内置版本（保持现语义）；
        // 但被停用的内置卡必须保留，否则 UI 没有入口显示「已停用/恢复」
        if (userTopicIds.has(topic.id) && !disabled) continue
        topics.push({
          ...topic,
          source: 'builtin' as const,
          ...(disabled ? { disabled: true } : {})
        })
      }
      topics.push(...userTopics.topics.map((topic) => ({ ...topic, source: 'user' as const })))
      const groupNames = new Set([
        ...Object.keys(builtin.lines.groups),
        ...Object.keys(userLines.groups)
      ])
      const lineGroups: LineGroupOverview[] = [...groupNames].map((name) => {
        const builtinLines = builtin.lines.groups[name] ?? []
        const groupDisabled = isGroupDisabled(overrides, name)
        const disabledLines = builtinLines.filter((line) => isLineDisabled(overrides, name, line))
        return {
          name,
          // 完整列表不裁剪：停用只影响引擎合并，总览必须保留原文供 UI 展示与恢复
          builtinLines,
          userLines: userLines.groups[name] ?? [],
          ...(groupDisabled ? { disabled: true } : {}),
          ...(disabledLines.length > 0 ? { disabledLines } : {})
        }
      })
      const userLineCount = Object.values(userLines.groups).reduce(
        (sum, lines) => sum + lines.length,
        0
      )
      return {
        topics,
        lineGroups,
        builtinTopicCount: builtin.topics.topics.length,
        userTopicCount: userTopics.topics.length,
        userLineCount
      }
    },

    async importTopics(raw: unknown): Promise<ImportTopicsResult> {
      const incoming = parseTopicDeck(raw)
      if (incoming.topics.length === 0) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '话题语料为空或没有合法话题卡（每张卡至少要有 id 与 sample/hooks）'
        )
      }
      const current = readUserTopics()
      const byId = new Map(current.topics.map((topic) => [topic.id, topic]))
      let added = 0
      let updated = 0
      for (const topic of incoming.topics) {
        if (byId.has(topic.id)) updated += 1
        else added += 1
        byId.set(topic.id, topic)
      }
      if (byId.size > USER_TOPIC_MAX) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          `用户话题上限 ${USER_TOPIC_MAX} 张，导入后将达 ${byId.size} 张`
        )
      }
      const next: TopicDeck = { ...current, topics: [...byId.values()] }
      writeUserTopics(next)
      return { added, updated, total: next.topics.length }
    },

    async importLines(raw: unknown): Promise<ImportLinesResult> {
      const incoming = parseLineDeck(raw)
      const groupCount = Object.keys(incoming.groups).length
      if (groupCount === 0) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '台词语料为空或没有合法台词组（组名需为小写短横线，每组至少一句）'
        )
      }
      const current = readUserLines()
      const groups: Record<string, string[]> = {}
      for (const [name, lines] of Object.entries(current.groups)) groups[name] = [...lines]
      let groupsAdded = 0
      let linesAdded = 0
      for (const [name, lines] of Object.entries(incoming.groups)) {
        if (!(name in groups)) {
          groups[name] = []
          groupsAdded += 1
        }
        const existing = new Set(groups[name])
        for (const line of lines) {
          if (existing.has(line)) continue
          groups[name].push(line)
          existing.add(line)
          linesAdded += 1
        }
      }
      if (Object.keys(groups).length > USER_LINE_GROUPS_MAX) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          `台词组上限 ${USER_LINE_GROUPS_MAX} 组，导入后将达 ${Object.keys(groups).length} 组`
        )
      }
      const next: LineDeck = { ...current, groups }
      writeUserLines(next)
      const totalLines = Object.values(groups).reduce((sum, list) => sum + list.length, 0)
      return { groupsAdded, linesAdded, totalLines }
    },

    async updateUserTopic(raw: unknown): Promise<TopicCard> {
      // 复用话题解析器：包一层单元素 deck，解析规则（id/sample/hooks/白名单）与批量导入完全一致
      const parsed = parseTopicDeck({ schema: 'fish-topics/1', version: '1.0.0', topics: [raw] })
      const card = parsed.topics[0]
      if (!card) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '话题卡不合法（至少需要 id 与 sample/hooks）'
        )
      }
      const file = readUserTopicsRaw()
      const rawTopics = Array.isArray(file.topics) ? [...file.topics] : []
      const index = rawTopics.findIndex(
        (item) =>
          Boolean(item) &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).id === card.id
      )
      if (index >= 0) {
        // 合并旧卡字段：解析器不认识的自定义字段（备注/来源等）在编辑后仍保留
        rawTopics[index] = { ...(rawTopics[index] as Record<string, unknown>), ...card }
      } else {
        if (rawTopics.length >= USER_TOPIC_MAX) {
          throw new CharacterError(
            CHARACTER_ERROR_CODES.BAD_PAYLOAD,
            `用户话题上限 ${USER_TOPIC_MAX} 张，已达到上限`
          )
        }
        rawTopics.push(card)
      }
      const next = {
        ...file,
        schema: typeof file.schema === 'string' ? file.schema : 'fish-topics/1',
        version: typeof file.version === 'string' ? file.version : '1.0.0',
        topics: rawTopics
      }
      writeJsonAtomic(paths().topicsPath, next)
      return card
    },

    async deleteUserTopic(id: string): Promise<boolean> {
      const current = readUserTopics()
      const remaining = current.topics.filter((topic) => topic.id !== id)
      if (remaining.length === current.topics.length) return false
      writeUserTopics({ ...current, topics: remaining })
      return true
    },

    async deleteUserLine(group: string, index: number): Promise<boolean> {
      const current = readUserLines()
      const lines = current.groups[group]
      if (!Array.isArray(lines) || !Number.isInteger(index) || index < 0 || index >= lines.length) {
        return false
      }
      const nextLines = lines.filter((_, i) => i !== index)
      const groups = { ...current.groups }
      if (nextLines.length === 0) delete groups[group]
      else groups[group] = nextLines
      writeUserLines({ ...current, groups })
      return true
    },

    async upsertUserLifeCard(raw: unknown): Promise<LifeCard> {
      // 复用生活卡解析器（id/activity 必填，slots/minStage/weight 白名单与夹取一致）
      const parsed = parseLifeDeck({ schema: 'fish-life-cards/1', version: '1.0.0', cards: [raw] })
      const card = parsed.cards[0]
      if (!card) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '生活卡不合法（至少需要 id 与 activity）'
        )
      }
      const current = readUserLifeDeck()
      const cards = [...current.cards]
      const index = cards.findIndex((item) => item.id === card.id)
      if (index >= 0) {
        cards[index] = card
      } else {
        if (cards.length >= USER_LIFE_CARD_MAX) {
          throw new CharacterError(
            CHARACTER_ERROR_CODES.BAD_PAYLOAD,
            `用户生活卡上限 ${USER_LIFE_CARD_MAX} 张，已达到上限`
          )
        }
        cards.push(card)
      }
      writeUserLifeDeck({ ...current, cards })
      return card
    },

    async deleteUserLifeCard(id: string): Promise<boolean> {
      const current = readUserLifeDeck()
      const cards = current.cards.filter((card) => card.id !== id)
      if (cards.length === current.cards.length) return false
      writeUserLifeDeck({ ...current, cards })
      return true
    },

    async importLifeDeck(raw: unknown): Promise<ImportLifeDeckResult> {
      const incoming = parseLifeDeck(raw)
      if (incoming.cards.length === 0) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '生活卡为空或没有合法卡（每张卡至少要有 id 与 activity）'
        )
      }
      const current = readUserLifeDeck()
      const byId = new Map(current.cards.map((card) => [card.id, card]))
      let added = 0
      let updated = 0
      for (const card of incoming.cards) {
        if (byId.has(card.id)) updated += 1
        else added += 1
        byId.set(card.id, card)
      }
      if (byId.size > USER_LIFE_CARD_MAX) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          `用户生活卡上限 ${USER_LIFE_CARD_MAX} 张，导入后将达 ${byId.size} 张`
        )
      }
      const next: LifeDeck = { ...current, cards: [...byId.values()] }
      writeUserLifeDeck(next)
      return { added, updated, total: next.cards.length }
    },

    async mergeLifeDeck(builtin?: LifeDeck): Promise<LifeDeck> {
      const base = builtin ?? (await readBuiltinLifeSafe())
      const overrides = readOverrides()
      const user = readUserLifeDeck()
      const userById = new Map(user.cards.map((card) => [card.id, card]))
      const cards: LifeCard[] = []
      const seen = new Set<string>()
      for (const card of base.cards) {
        // 停用清单只过滤内置卡：用户自己的卡即便同 id 也不该被隐式复活/隐藏
        if (isLifeCardDisabled(overrides, card.id)) continue
        seen.add(card.id)
        cards.push(userById.get(card.id) ?? card)
      }
      // 用户新卡（含覆盖了已停用内置 id 的用户卡）追加在末尾
      for (const card of user.cards) {
        if (seen.has(card.id)) continue
        seen.add(card.id)
        cards.push(card)
      }
      return {
        schema: typeof base.schema === 'string' ? base.schema : 'fish-life-cards/1',
        version: typeof base.version === 'string' ? base.version : '0.0.0',
        cards
      }
    },

    async exportLifeMerged(): Promise<LifeDeck> {
      return this.mergeLifeDeck()
    },

    async listLifeCards(): Promise<LifeCardOverviewItem[]> {
      const builtin = await readBuiltinLifeSafe()
      const user = readUserLifeDeck()
      const overrides = readOverrides()
      const userIds = new Set(user.cards.map((card) => card.id))
      const items: LifeCardOverviewItem[] = []
      for (const card of builtin.cards) {
        const disabled = isLifeCardDisabled(overrides, card.id)
        // 与话题总览同口径：用户同 id 接管后不再重复列内置版本，但停用项必须保留给 UI 恢复
        if (userIds.has(card.id) && !disabled) continue
        items.push({
          ...card,
          source: 'builtin' as const,
          ...(disabled ? { disabled: true } : {})
        })
      }
      items.push(...user.cards.map((card) => ({ ...card, source: 'user' as const })))
      return items
    },

    async resetUser(kind: 'topics' | 'lines' | 'all'): Promise<{ topics: number; lines: number }> {
      const topics = readUserTopics().topics.length
      const lines = Object.values(readUserLines().groups).reduce((sum, list) => sum + list.length, 0)
      if (kind === 'topics' || kind === 'all') {
        if (existsSync(paths().topicsPath)) rmSync(paths().topicsPath, { force: true })
      }
      if (kind === 'lines' || kind === 'all') {
        if (existsSync(paths().linesPath)) rmSync(paths().linesPath, { force: true })
      }
      const clearedTopics = kind === 'lines' ? 0 : topics
      const clearedLines = kind === 'topics' ? 0 : lines
      return { topics: clearedTopics, lines: clearedLines }
    },

    async exportMerged(): Promise<ContentDeck> {
      return this.mergeForEngine()
    }
  }
}
