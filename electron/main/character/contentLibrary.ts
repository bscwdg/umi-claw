// electron/main/character/contentLibrary.ts —— 通用内容库 facade（话题/台词/生活卡，纯 Node）
//
// 为什么需要它：IPC/UI 与未来的 agent 工具都只需要「列出/新增/删除/停用/恢复」这几个动作，
// 不应该各自拼 contentStore 的 import/overview/overrides 细节；这里把三种 kind 收敛成同一套
// 增删改查语义，store 仍是唯一落盘实现。不接 ipc（由 wiring/ipc 层接线），便于验收打真源码。
//
// 语义约定：
// - topics/lifeCards 的 key 是卡 id，只能删用户项；内置项用 disable(kind, id, true) 停用。
// - lines 的 key 形如 `group::text`；`group::`（text 为空）表示整组停用。
// - 停用只作用于内置内容；用户自己的话题/台词/生活卡永远不因停用清单消失。

import {
  isGroupDisabled,
  isLineDisabled,
  type ContentKind,
  type ContentOverrides
} from './contentOverrides'
import type { ContentStore } from './contentStore'
import { CHARACTER_ERROR_CODES, CharacterError } from './types'

export type ContentLibraryKind = ContentKind

export interface ContentKindInfo {
  kind: ContentLibraryKind
  label: string
  /** 该类内容对外的字段说明（可选；UI/agent 生成表单时参考） */
  itemFields?: string[]
}

export interface ContentLibrary {
  /** 三类内容及中文标签（话题/台词/生活卡） */
  kinds(): ContentKindInfo[]
  /** topics 返回总览项（含 source/disabled）；lines 按组展开为 key 条目；lifeCards 返回内置+用户卡 */
  list(kind: ContentLibraryKind): Promise<unknown[]>
  /** topics→单卡 upsert；lifeCards→单卡 upsert；lines→{group,text} 追加进用户台词 */
  upsert(kind: ContentLibraryKind, item: unknown): Promise<unknown>
  /** topics/lifeCards 只删用户项；lines 只删用户句（key=`group::text`） */
  remove(kind: ContentLibraryKind, key: string): Promise<boolean>
  /** topics/lifeCards 按 id 停用；lines 用 `group::text` 停用单句、`group::` 停用整组 */
  disable(
    kind: ContentLibraryKind,
    key: string,
    disabled: boolean
  ): Promise<ContentOverrides>
  /** 恢复某一类内置项；kind 省略 = 全部恢复 */
  restore(kind?: ContentLibraryKind): Promise<ContentOverrides>
  overrides(): Promise<ContentOverrides>
  importOverrides(raw: unknown): Promise<ContentOverrides>
}

export interface ContentLibraryOptions {
  store: ContentStore
  logger?: (message: string) => void
}

/** IPC 通道（特性模块自持，命名按 <domain>:<entity>:<method>；与旧 content 通道并存） */
export const CHARACTER_CONTENT_LIBRARY_CHANNELS = {
  list: 'character:content:list',
  upsert: 'character:content:upsert',
  remove: 'character:content:remove',
  disable: 'character:content:disable',
  restore: 'character:content:restore',
  overrides: 'character:content:overrides'
} as const

/** 与 parseLineDeck 的组名白名单保持一致（小写短横线），避免 facade 放过解析器会丢的脏键 */
const LINE_GROUP_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const KIND_INFOS: ContentKindInfo[] = [
  { kind: 'topics', label: '话题', itemFields: ['id', 'title', 'sample', 'hooks', 'details'] },
  { kind: 'lines', label: '台词', itemFields: ['group', 'text'] },
  {
    kind: 'lifeCards',
    label: '生活卡',
    itemFields: ['id', 'activity', 'mood', 'goal', 'hook', 'slots', 'minStage', 'weight']
  }
]

const KINDS: ContentLibraryKind[] = KIND_INFOS.map((info) => info.kind)

function splitLineKey(key: string): { group: string; text: string } | null {
  if (typeof key !== 'string') return null
  const index = key.indexOf('::')
  if (index <= 0) return null
  return { group: key.slice(0, index), text: key.slice(index + 2) }
}

function readLineItem(item: unknown): { group: string; text: string } {
  const raw = (item ?? {}) as Record<string, unknown>
  const group = typeof raw.group === 'string' ? raw.group.trim() : ''
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 300) : ''
  if (!group || !text) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '台词条目需要 group 与 text')
  }
  if (!LINE_GROUP_PATTERN.test(group)) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      '台词组名需为小写短横线（如 greeting、miss）'
    )
  }
  return { group, text }
}

function assertKind(kind: unknown): ContentLibraryKind {
  if (typeof kind !== 'string' || !KINDS.includes(kind as ContentLibraryKind)) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      `未知内容类型 ${String(kind)}（可选 topics/lines/lifeCards）`
    )
  }
  return kind as ContentLibraryKind
}

export function createContentLibrary(options: ContentLibraryOptions): ContentLibrary {
  const { store } = options

  const listLines = async (): Promise<unknown[]> => {
    const overview = await store.overview()
    const overrides = await store.overrides()
    const items: Array<{
      key: string
      group: string
      text: string
      source: 'builtin' | 'user'
      disabled: boolean
    }> = []
    const seen = new Set<string>()
    for (const group of overview.lineGroups) {
      const groupDisabled = isGroupDisabled(overrides, group.name)
      for (const text of group.builtinLines) {
        const key = `${group.name}::${text}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          key,
          group: group.name,
          text,
          source: 'builtin',
          // 整组停用等价于该组内置句全部不可用；单句停用只影响那一句
          disabled: groupDisabled || isLineDisabled(overrides, group.name, text)
        })
      }
      for (const text of group.userLines) {
        const key = `${group.name}::${text}`
        // 用户句与内置句同文本时按合并语义只保留内置那份，避免 UI 同 key 重复渲染
        if (seen.has(key)) continue
        seen.add(key)
        // 用户台词不受停用清单影响（与 mergeForEngine 同口径）
        items.push({ key, group: group.name, text, source: 'user', disabled: false })
      }
    }
    return items
  }

  return {
    kinds(): ContentKindInfo[] {
      return KIND_INFOS.map((info) => ({ ...info }))
    },

    async list(kind: ContentLibraryKind): Promise<unknown[]> {
      const target = assertKind(kind)
      if (target === 'topics') return (await store.overview()).topics
      if (target === 'lines') return listLines()
      return store.listLifeCards()
    },

    async upsert(kind: ContentLibraryKind, item: unknown): Promise<unknown> {
      const target = assertKind(kind)
      if (target === 'topics') return store.updateUserTopic(item)
      if (target === 'lifeCards') return store.upsertUserLifeCard(item)
      const line = readLineItem(item)
      const result = await store.importLines({
        schema: 'fish-lines/1',
        version: '1.0.0',
        groups: { [line.group]: [line.text] }
      })
      return { group: line.group, text: line.text, added: result.linesAdded > 0 }
    },

    async remove(kind: ContentLibraryKind, key: string): Promise<boolean> {
      const target = assertKind(kind)
      if (target === 'topics') return store.deleteUserTopic(key)
      if (target === 'lifeCards') return store.deleteUserLifeCard(key)
      const parts = splitLineKey(key)
      if (!parts || !parts.text) return false
      // 用户句没有稳定 id：按组内文本定位下标，只删用户库里的那一句（内置句不动）
      const overview = await store.overview()
      const group = overview.lineGroups.find((item) => item.name === parts.group)
      if (!group) return false
      const index = group.userLines.indexOf(parts.text)
      if (index < 0) return false
      return store.deleteUserLine(parts.group, index)
    },

    async disable(
      kind: ContentLibraryKind,
      key: string,
      disabled: boolean
    ): Promise<ContentOverrides> {
      const target = assertKind(kind)
      if (target === 'topics') return store.setTopicDisabled(key, disabled)
      if (target === 'lifeCards') return store.setLifeCardDisabled(key, disabled)
      const parts = splitLineKey(key)
      if (!parts || !parts.group) {
        throw new CharacterError(
          CHARACTER_ERROR_CODES.BAD_PAYLOAD,
          '台词 key 应为 group::text（单句）或 group::（整组）'
        )
      }
      if (!parts.text) return store.setGroupDisabled(parts.group, disabled)
      return store.setLineDisabled(parts.group, parts.text, disabled)
    },

    async restore(kind?: ContentLibraryKind): Promise<ContentOverrides> {
      if (kind === undefined) return store.restoreOverrides()
      return store.restoreOverrides(assertKind(kind))
    },

    async overrides(): Promise<ContentOverrides> {
      return store.overrides()
    },

    async importOverrides(raw: unknown): Promise<ContentOverrides> {
      return store.importOverrides(raw)
    }
  }
}
