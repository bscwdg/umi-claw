// electron/main/character/bootstrap.ts —— 角色引导（C02）
//
// 一键初始化（可重试、幂等）：
//   1) workspace 目录
//   2) 人格模板渲染 + 受管写入（用户改过的不覆盖）
//   3) 官方 CLI 建 agent 条目（config patch）
//   4) Obsidian `大肥鱼/` 目录（只用既有知识库，不新增 KB）
//   5) 自检 6 项
// 任一步失败只标记该步，不阻断宿主；返回完整报告供设置页展示。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composePersonaFiles, writeManagedFiles, type PersonaTemplates } from './persona'
import type { CharacterSettings, CharacterState } from './types'

export const PERSONA_TEMPLATE_FILES = {
  soul: 'SOUL.md.tpl',
  identity: 'IDENTITY.md.tpl',
  agents: 'AGENTS.md.tpl',
  user: 'USER.md.tpl',
  core: 'core.md',
  // 只注入「规则」：禁用清单（banned.v1.json）与 few-shot（few-shots.v1.json）不进提示词，
  // 否则会被模型复读（回声病）；完整 voice.md 仅作参考。
  voice: 'voice-rules.md'
} as const

export interface BootstrapStep {
  id: string
  name: string
  ok: boolean
  detail: string
}

export interface BootstrapStatusFlags {
  agentReady: boolean
  gatewayReady: boolean
  obsidianReady: boolean
  qqReady: boolean
  ttsReady: boolean
  memorySearchReady: boolean
}

export interface BootstrapReport {
  ok: boolean
  at: number
  workspaceDir: string
  steps: BootstrapStep[]
  status: BootstrapStatusFlags
}

export interface BootstrapDeps {
  workspaceDir: string
  personaSourceDir: string
  getSettings: () => Promise<CharacterSettings>
  getState: () => Promise<CharacterState>
  obsidianVaultPath?: string
  ensureAgentEntry: (workspaceDir: string) => Promise<{ ok: boolean; error?: string }>
  agentConfigured: () => boolean
  gatewayReady?: () => boolean
  qqReady?: () => boolean
  ttsReady?: () => boolean
  memorySearchReady?: () => boolean
  logger?: (message: string) => void
  now?: () => number
}

export function loadPersonaTemplates(personaSourceDir: string): PersonaTemplates {
  const read = (name: string): string => readFileSync(join(personaSourceDir, name), 'utf8')
  return {
    soul: read(PERSONA_TEMPLATE_FILES.soul),
    identity: read(PERSONA_TEMPLATE_FILES.identity),
    agents: read(PERSONA_TEMPLATE_FILES.agents),
    user: read(PERSONA_TEMPLATE_FILES.user),
    core: read(PERSONA_TEMPLATE_FILES.core),
    voice: read(PERSONA_TEMPLATE_FILES.voice)
  }
}

export async function runBootstrap(deps: BootstrapDeps): Promise<BootstrapReport> {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? (() => undefined)
  const steps: BootstrapStep[] = []
  let settings: CharacterSettings
  let state: CharacterState
  try {
    settings = await deps.getSettings()
    state = await deps.getState()
  } catch (error) {
    steps.push({
      id: 'settings',
      name: '读取角色设置与状态',
      ok: false,
      detail: (error as Error)?.message ?? String(error)
    })
    return {
      ok: false,
      at: now(),
      workspaceDir: deps.workspaceDir,
      steps,
      status: {
        agentReady: false,
        gatewayReady: false,
        obsidianReady: false,
        qqReady: false,
        ttsReady: false,
        memorySearchReady: false
      }
    }
  }

  // 1) workspace 目录
  try {
    mkdirSync(join(deps.workspaceDir, 'fish'), { recursive: true })
    steps.push({ id: 'workspace', name: 'workspace 目录', ok: true, detail: deps.workspaceDir })
  } catch (error) {
    steps.push({
      id: 'workspace',
      name: 'workspace 目录',
      ok: false,
      detail: (error as Error)?.message ?? String(error)
    })
  }

  // 2) 人格模板渲染 + 受管写入
  try {
    const templates = loadPersonaTemplates(deps.personaSourceDir)
    const files = composePersonaFiles({ settings, state, templates })
    const result = writeManagedFiles(deps.workspaceDir, files)
    steps.push({
      id: 'persona',
      name: '人格文件（SOUL/IDENTITY/AGENTS/USER + STATE）',
      ok: true,
      detail: `写入 ${result.written.length}，保留用户改动 ${result.kept.length}${
        result.kept.length ? `（${result.kept.join(', ')}）` : ''
      }`
    })
  } catch (error) {
    steps.push({
      id: 'persona',
      name: '人格文件（SOUL/IDENTITY/AGENTS/USER + STATE）',
      ok: false,
      detail: (error as Error)?.message ?? String(error)
    })
  }

  // 3) agent 条目（官方 CLI config patch）
  try {
    const ensured = await deps.ensureAgentEntry(deps.workspaceDir)
    const configured = deps.agentConfigured()
    steps.push({
      id: 'agent',
      name: 'OpenClaw agent 条目（feiyu）',
      ok: ensured.ok && configured,
      detail: ensured.ok
        ? configured
          ? 'agent 条目已写入'
          : 'CLI 已执行但配置里读不到 feiyu（可能需要重启网关）'
        : ensured.error ?? '未知错误'
    })
  } catch (error) {
    steps.push({
      id: 'agent',
      name: 'OpenClaw agent 条目（feiyu）',
      ok: false,
      detail: (error as Error)?.message ?? String(error)
    })
  }

  // 4) Obsidian 目录（不新增知识库，只在既有 vault 建角色目录）
  const vault = (deps.obsidianVaultPath ?? '').trim()
  if (!vault) {
    steps.push({
      id: 'obsidian',
      name: 'Obsidian 大肥鱼目录',
      ok: true,
      detail: '未配置 Obsidian vault，跳过（不影响使用）'
    })
  } else {
    try {
      const target = join(vault, '大肥鱼')
      mkdirSync(target, { recursive: true })
      steps.push({ id: 'obsidian', name: 'Obsidian 大肥鱼目录', ok: true, detail: target })
    } catch (error) {
      steps.push({
        id: 'obsidian',
        name: 'Obsidian 大肥鱼目录',
        ok: false,
        detail: (error as Error)?.message ?? String(error)
      })
    }
  }

  // 5) 依赖自检（obsidianReady 必须看真实目录，不能用「配置了 vault」冒充）
  const vaultDir = vault ? join(vault, '大肥鱼') : ''
  const flags: BootstrapStatusFlags = {
    agentReady: safe(() => deps.agentConfigured(), false),
    gatewayReady: safe(() => deps.gatewayReady?.() ?? false, false),
    obsidianReady: Boolean(vaultDir) && existsSync(vaultDir),
    qqReady: safe(() => deps.qqReady?.() ?? false, false),
    ttsReady: safe(() => deps.ttsReady?.() ?? false, false),
    memorySearchReady: safe(() => deps.memorySearchReady?.() ?? false, false)
  }
  steps.push({
    id: 'deps',
    name: '依赖自检',
    ok: true,
    detail: Object.entries(flags)
      .map(([k, v]) => `${k}=${v ? '✓' : '×'}`)
      .join('  ')
  })

  log(`[character] bootstrap 完成：${steps.filter((s) => s.ok).length}/${steps.length} 步通过`)
  return {
    ok: steps.every((s) => s.ok),
    at: now(),
    workspaceDir: deps.workspaceDir,
    steps,
    status: flags
  }
}

function safe(fn: () => boolean, fallback: boolean): boolean {
  try {
    return Boolean(fn())
  } catch {
    return fallback
  }
}
