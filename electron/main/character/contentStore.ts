// electron/main/character/contentStore.ts —— 用户主动消息语料库（话题/台词的查看/导入/删除，纯 Node）
//
// 为什么单独成文件：内置话题/台词在 resources/character/cards 随包只读，用户无法增删；
// 用户语料独立落 <dataDir>/character/content/*.user.json，与内置合并后再喂给内容引擎，
// 升级覆盖安装目录不影响用户数据。与 stickerStore 同口径：不 import electron，验收可直接 bundle 真源码。
//
// 合并语义（让用户能「接管」内置卡又能随时回退）：
// - 话题按 id：用户同 id 卡覆盖内置卡；删除用户卡后自动回落到内置版本。
// - 台词按组：用户句在同名组末尾追加（内置句始终保留），删除只动用户句。
// - 用户文件缺失/损坏一律回落空语料，绝不阻断主动消息。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  createEmptyContentDeck,
  parseLineDeck,
  parseTopicDeck,
  type ContentDeck,
  type LineDeck,
  type TopicCard,
  type TopicDeck
} from './contentEngine'
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
/** 防呆上限（不是业务硬限制）：避免一次导入把数据目录撑爆 */
export const USER_TOPIC_MAX = 200
export const USER_LINE_GROUPS_MAX = 50

export interface ContentStoreOptions {
  /** 应用数据目录（用户语料落 <dataDir>/character/content/） */
  dataDir: string
  /** 内置内容包读取器（由 wiring 注入，读 resources 只读资源） */
  loadBuiltin: () => ContentDeck | Promise<ContentDeck>
  logger?: (message: string) => void
}

/** 话题总览项：在 TopicCard 上标注来源，内置只读、用户可删 */
export type TopicOverviewItem = TopicCard & { source: 'builtin' | 'user' }

export interface LineGroupOverview {
  name: string
  builtinLines: string[]
  userLines: string[]
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

export interface ContentStorePaths {
  characterDir: string
  dir: string
  topicsPath: string
  linesPath: string
}

export interface ContentStore {
  paths(): ContentStorePaths
  /** 读用户语料并与内置合并成引擎可用的内容包（坏文件回落仅内置） */
  mergeForEngine(builtin?: ContentDeck): Promise<ContentDeck>
  /** 渲染端总览：每条语料标注 builtin/user，内置只读 */
  overview(): Promise<ContentOverview>
  importTopics(raw: unknown): Promise<ImportTopicsResult>
  importLines(raw: unknown): Promise<ImportLinesResult>
  /** 仅删用户话题卡；内置 id 拒删。返回是否命中并删除 */
  deleteUserTopic(id: string): Promise<boolean>
  /** 仅删用户台词句（组名 + 组内下标）；内置句拒删 */
  deleteUserLine(group: string, index: number): Promise<boolean>
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
      linesPath: join(dir, USER_LINES_FILE)
    }
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

  const writeUserTopics = (deck: TopicDeck): void => {
    writeAtomic(paths().topicsPath, `${JSON.stringify(deck, null, 2)}\n`)
  }

  const writeUserLines = (deck: LineDeck): void => {
    writeAtomic(paths().linesPath, `${JSON.stringify(deck, null, 2)}\n`)
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

  return {
    paths,

    async mergeForEngine(builtin?: ContentDeck): Promise<ContentDeck> {
      const base = builtin ?? (await readBuiltinSafe())
      const userTopics = readUserTopics()
      const userLines = readUserLines()
      const userTopicIds = new Set(userTopics.topics.map((topic) => topic.id))
      // 用户同 id 卡接管内置卡：先放未被接管的内置卡，再追加全部用户卡
      const topics = [
        ...base.topics.topics.filter((topic) => !userTopicIds.has(topic.id)),
        ...userTopics.topics
      ]
      const groups: Record<string, string[]> = {}
      for (const [name, lines] of Object.entries(base.lines.groups)) {
        groups[name] = [...lines]
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
      const userTopics = readUserTopics()
      const userLines = readUserLines()
      const userTopicIds = new Set(userTopics.topics.map((topic) => topic.id))
      const topics: TopicOverviewItem[] = [
        ...builtin.topics.topics
          .filter((topic) => !userTopicIds.has(topic.id))
          .map((topic) => ({ ...topic, source: 'builtin' as const })),
        ...userTopics.topics.map((topic) => ({ ...topic, source: 'user' as const }))
      ]
      const groupNames = new Set([
        ...Object.keys(builtin.lines.groups),
        ...Object.keys(userLines.groups)
      ])
      const lineGroups: LineGroupOverview[] = [...groupNames].map((name) => ({
        name,
        builtinLines: builtin.lines.groups[name] ?? [],
        userLines: userLines.groups[name] ?? []
      }))
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
