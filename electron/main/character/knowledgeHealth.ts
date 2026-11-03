// electron/main/character/knowledgeHealth.ts —— 角色知识体检（4.3 P1）
//
// 为什么需要它：角色知识只用既有 Obsidian（不新增库），但「vault 配了没 / MCP 启用没 /
// 索引建了没 / 大肥鱼/ 下有几篇」这些状态散在配置与索引文件里，UI 看不到；导入成功 ≠ 能检索。
// 这里把判定收成纯函数（可单测）：blockers 决定 `searchable`，warnings（索引中/上次失败）
// 只提示、不阻断——旧索引往往仍可用，不能因为「正在重建」就告诉用户完全搜不到。

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const CHARACTER_KB_DIR = '大肥鱼'
export const CHARACTER_ARCHIVE_DIR = '归档'

/** 索引状态的最小投影（来自 obsidianManager.getIndexStatus，避免此模块依赖 electron） */
export interface KnowledgeIndexLike {
  indexing?: boolean
  noteCount?: number
  chunkCount?: number
  lastIndexedAt?: number | string | null
  lastError?: string | null
  vaultPath?: string | null
}

export type KnowledgeBlocker =
  | 'no-vault'
  | 'vault-missing'
  | 'mcp-disabled'
  | 'no-notes'
  | 'index-empty'
  | 'index-other-vault'
export type KnowledgeWarning = 'indexing' | 'index-error'
export type KnowledgeReason = KnowledgeBlocker | KnowledgeWarning

export interface KnowledgeHealth {
  vaultPath: string
  vaultExists: boolean
  obsidianEnabled: boolean
  index: KnowledgeIndexLike | null
  /** 角色目录下 .md 数量（最多数到 maxNotes 篇，防止超大 vault 卡 UI） */
  characterNotes: number
  /** 真正能被她检索到：blockers 为空（warnings 不阻断） */
  searchable: boolean
  /** 阻断原因 + 不阻断提示（稳定顺序） */
  reasons: KnowledgeReason[]
  /** 不阻断但应提示：索引中 / 上次索引失败 */
  warnings: KnowledgeWarning[]
}

/** 递归数 `大肥鱼/` 下的 .md（排除顶层 `归档/` 与隐藏条目；depth≤6；最多 maxNotes 篇） */
export function countCharacterNotes(vaultPath: string, maxNotes = 500): number {
  const root = join(vaultPath, CHARACTER_KB_DIR)
  if (!existsSync(root)) return 0
  let count = 0
  const walk = (dir: string, depth: number): void => {
    if (count >= maxNotes || depth > 6) return
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= maxNotes) return
      // 与 indexer 一致：隐藏条目一律不索引，也不计入「她有知识」
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (depth === 0 && entry.name === CHARACTER_ARCHIVE_DIR) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        count += 1
      }
    }
  }
  walk(root, 0)
  return count
}

function sameVault(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const abs = resolve(p)
    return abs.endsWith(sep) ? abs.slice(0, -1) : abs
  }
  return norm(a) === norm(b)
}

export function buildKnowledgeHealth(input: {
  vaultPath: string
  vaultExists: boolean
  obsidianEnabled: boolean
  index: KnowledgeIndexLike | null
  characterNotes: number
}): KnowledgeHealth {
  const vaultPath = String(input.vaultPath ?? '').trim()
  const vaultExists = Boolean(input.vaultExists)
  const obsidianEnabled = Boolean(input.obsidianEnabled)
  const index = input.index ?? null
  const characterNotes = Number.isFinite(input.characterNotes) ? Math.max(0, input.characterNotes) : 0
  const blockers: KnowledgeBlocker[] = []
  const warnings: KnowledgeWarning[] = []
  if (!vaultPath) blockers.push('no-vault')
  else if (!vaultExists) blockers.push('vault-missing')
  if (!obsidianEnabled) blockers.push('mcp-disabled')
  if (characterNotes <= 0) blockers.push('no-notes')
  // 索引是否可用看 chunkCount（noteCount 是整个 vault 的笔记数，空笔记也可能有 noteCount）
  const chunkCount = Number(index?.chunkCount ?? 0)
  if (!index || !(chunkCount > 0)) blockers.push('index-empty')
  else if (index.vaultPath && !sameVault(index.vaultPath, vaultPath)) {
    blockers.push('index-other-vault')
  }
  if (index?.indexing) warnings.push('indexing')
  if (index?.lastError) warnings.push('index-error')
  return {
    vaultPath,
    vaultExists,
    obsidianEnabled,
    index,
    characterNotes,
    searchable: blockers.length === 0,
    reasons: [...blockers, ...warnings],
    warnings
  }
}
