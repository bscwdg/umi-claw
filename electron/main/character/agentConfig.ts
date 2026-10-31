// electron/main/character/agentConfig.ts —— OpenClaw agent 条目的读取与补丁构造
//
// 只经官方 CLI `config patch` 写 openclaw.json（单写入口，红线 1）；
// 本文件只负责「构造补丁 / 读回校验」，不直接写配置。

import { readFileSync } from 'node:fs'

export const CHARACTER_AGENT_ID = 'feiyu'
/** 聊天必须显式路由到 feiyu agent，否则人格/记忆全部空转（审查 P0-1） */
export const CHARACTER_AGENT_MODEL = `openclaw/${CHARACTER_AGENT_ID}`

export interface AgentPatchPayload {
  agents: { entries: Record<string, { workspace: string }> }
}

export function isValidAgentId(id: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(id)
}

export function buildAgentPatch(agentId: string, workspace: string): AgentPatchPayload {
  if (!isValidAgentId(agentId)) throw new Error(`非法 agent id: ${agentId}`)
  if (!workspace) throw new Error('workspace 不能为空')
  return { agents: { entries: { [agentId]: { workspace } } } }
}

export interface AgentEntryReadResult {
  exists: boolean
  workspace?: string
  error?: string
}

/** 读 openclaw.json 判断 agent 条目是否存在（不写、不改） */
export function readAgentEntry(configPath: string, agentId: string): AgentEntryReadResult {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(stripBom(raw)) as {
      agents?: { entries?: Record<string, { workspace?: string }> }
    }
    const entry = parsed?.agents?.entries?.[agentId]
    if (!entry) return { exists: false }
    return {
      exists: true,
      workspace: typeof entry.workspace === 'string' ? entry.workspace : undefined
    }
  } catch (error) {
    return { exists: false, error: (error as Error)?.message ?? String(error) }
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
