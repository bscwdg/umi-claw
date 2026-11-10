// electron/main/character/legacyGroupCleanup.ts —— 4.4 双 agent / 群聊状态的遗留清理
//
// 为什么需要它：4.5 把 QQ 群聊从「独立 feiyu-group agent」改回单 agent（qqbot 私聊/群聊
// 都走 feiyu），新代码不再创建 feiyu-group 的 workspace / agentDir；但升级用户的磁盘上
// 仍会留下 workspace-feiyu-group/、agents/feiyu-group/ 和 feiyu-guard 的群语音计数状态。
// 「删除全部数据」若不清这些，UI 会误报「全部删除成功」，旧 workspace 里的人格文件与
// 记忆副本也会被当成用户数据残留。
//
// 纯 Node（不 import electron）+ 删除动作可注入：accept 能用临时目录验真实文件行为，
// 也能用抛错的 remove 验失败收集（不 mock 被测逻辑）。
// 只在 scope=all 时清理：values/memory 是「只清数值/记忆」的轻量语义，不动 openclaw 配置目录。

import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DeleteScope } from './safety'

/** 4.4 双 agent 的 agentId（只用于定位遗留路径；不再创建/绑定） */
export const LEGACY_GROUP_AGENT_ID = 'feiyu-group'

/**
 * 「删除全部数据」需要一并清理的遗留路径；scope 非 all 返回空数组。
 * 返回绝对路径，调用方逐个 rm（不存在视为已清理）。
 */
export function legacyGroupCleanupPaths(dataDir: string, scope: DeleteScope): string[] {
  if (scope !== 'all') return []
  const openclawDir = join(dataDir, 'config', '.openclaw')
  return [
    // 4.4 群聊独立 workspace（AGENTS/SOUL/IDENTITY/USER + memory 副本）
    join(openclawDir, 'workspace-feiyu-group'),
    // openclaw CLI 给 feiyu-group 自动建的 agentDir（agent 条目已由群策略迁移摘除）
    join(openclawDir, 'agents', LEGACY_GROUP_AGENT_ID),
    // 4.5 feiyu-guard 的群语音日计数状态（落在 character 数据目录下）
    join(dataDir, 'character', 'group-guard-state.json')
  ]
}

/**
 * 逐个删除并收集失败文案（沿用 deleteWorkspaceFiles 的失败收集模式：调用方汇总后
 * 交给 manager 转 warning，不阻断删除主流程）。
 * - 不存在视为已清理：rmSync 的 force 不抛错；
 * - 单个失败不中断后续路径；
 * - 返回 [] 表示全部清理成功。
 */
export function removePathsCollectingFailures(
  paths: string[],
  options: {
    /** 删除动作（验收注入抛错用；缺省 rmSync force+recursive） */
    remove?: (path: string) => void
    /** 失败文案里的目标名（缺省 basename，避免把完整路径写进 UI 提示） */
    label?: (path: string) => string
  } = {}
): string[] {
  const remove =
    options.remove ?? ((path: string) => rmSync(path, { force: true, recursive: true }))
  const label = options.label ?? ((path: string) => basename(path))
  const failures: string[] = []
  for (const path of paths) {
    try {
      remove(path)
    } catch (error) {
      failures.push(`${label(path)}：${(error as Error)?.message ?? String(error)}`)
    }
  }
  return failures
}
