// electron/main/character/knowledgeHealth.ts —— 角色知识体检（4.3 P1）
//
// 为什么需要它：角色知识只用既有 Obsidian（不新增库），但「vault 配了没 / MCP 启用没 /
// 索引建了没 / 大肥鱼/ 下有几篇」这些状态散在配置与索引文件里，UI 看不到；导入成功 ≠ 能检索。
// 这里把判定收成纯函数（可单测）：`searchable` 只在「启用 + vault 存在 + 有角色笔记 + 索引非空」
// 同时成立时为 true，并给出可展示的原因码。

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const CHARACTER_KB_DIR = '大肥鱼'

/** 索引状态的最小投影（来自 obsidianManager.getIndexStatus，避免此模块依赖 electron） */
export interface KnowledgeIndexLike {
  indexing?: boolean
  noteCount?: number
  lastIndexedAt?: number | string | null
  lastError?: string | null
}

export interface KnowledgeHealth {
  vaultPath: string
  vaultExists: boolean
  obsidianEnabled: boolean
  index: KnowledgeIndexLike | null
  /** 角色目录下 .md 数量（最多数到 maxNotes 篇，防止超大 vault 卡 UI） */
  characterNotes: number
  /** 真正能被她检索到：启用 + vault 存在 + 角色笔记 > 0 + 索引 noteCount > 0 且无错误 */
  searchable: boolean
  /** 不可检索/需注意的原因码（稳定顺序，供 UI 映射文案） */
  reasons: KnowledgeReason[]
}

export type KnowledgeReason =
  | 'no-vault'
  | 'vault-missing'
  | 'mcp-disabled'
  | 'no-notes'
  | 'index-empty'
  | 'indexing'
  | 'index-error'

/** 递归数 `大肥鱼/` 下的 .md（含子目录）；目录不存在返回 0；最多数 maxNotes 篇 */
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
      if (entry.isDirectory()) {
        if (entry.name === '归档' || entry.name.startsWith('.')) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        count += 1
      }
    }
  }
  walk(root, 0)
  return count
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
  const reasons: KnowledgeReason[] = []
  if (!vaultPath) reasons.push('no-vault')
  else if (!vaultExists) reasons.push('vault-missing')
  if (!obsidianEnabled) reasons.push('mcp-disabled')
  if (characterNotes <= 0) reasons.push('no-notes')
  if (!index || !(Number(index.noteCount) > 0)) reasons.push('index-empty')
  if (index?.indexing) reasons.push('indexing')
  if (index?.lastError) reasons.push('index-error')
  return {
    vaultPath,
    vaultExists,
    obsidianEnabled,
    index,
    characterNotes,
    searchable: reasons.length === 0,
    reasons
  }
}
