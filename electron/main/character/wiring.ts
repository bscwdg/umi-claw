// electron/main/character/wiring.ts —— 角色模块唯一接线点
//
// index.ts 只调用一次 registerCharacter()；其余模块不直接 import 本目录以外的东西。
// 初始化失败只降级角色自身，绝不阻断宿主启动（红线 2）。

import { join } from 'node:path'
import { CharacterManager } from './manager'
import { registerCharacterIpc, type CharacterIpcDisposer } from './ipc'
import { CharacterStore } from './store'
import { applyAgentPatch, createOpenClawCliRunner } from './agentPatchRunner'
import { CHARACTER_AGENT_ID, readAgentEntry } from './agentConfig'
import { runBootstrap } from './bootstrap'
import type { CharacterEvent, CharacterKv } from './types'

export interface CharacterCliConfig {
  nodePath: string
  cliPath: string
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}

export interface CharacterWiringDeps {
  /** 宿主 app_meta KV（work.db；与 voice 同库同口径） */
  kv: CharacterKv
  /** 应用数据目录（<dataDir>/config/.openclaw/workspace-feiyu 在这里） */
  dataDir: string
  /** 人格模板目录（开发态 app/resources/character/persona；打包态 resources/...） */
  personaSourceDir: string
  /** openclaw.json 路径（只读校验 agent 条目） */
  configPath: string
  /** 官方 CLI 子进程配置 */
  cli: CharacterCliConfig
  /** 既有 Obsidian vault 路径（只在其下建 `大肥鱼/`，不新增知识库） */
  obsidianVaultPath?: () => string | undefined
  gatewayReady?: () => boolean
  qqReady?: () => boolean
  ttsReady?: () => boolean
  memorySearchReady?: () => boolean
  logger?: (message: string) => void
  onEvent?: (event: CharacterEvent) => void
  now?: () => number
}

export interface CharacterWiringResult {
  manager: CharacterManager | null
  dispose: () => Promise<void>
}

export async function registerCharacter(
  deps: CharacterWiringDeps
): Promise<CharacterWiringResult> {
  const logger = deps.logger ?? ((message: string) => console.log(message))
  let ipcDisposer: CharacterIpcDisposer | null = null

  try {
    const store = new CharacterStore({ kv: deps.kv, now: deps.now })
    const manager = new CharacterManager({
      store,
      now: deps.now,
      logger,
      onEvent: deps.onEvent
    })
    await manager.init()
    ipcDisposer = registerCharacterIpc(manager)

    // 引导接线：官方 CLI 写 agent 条目；人格文件走受管写入
    const workspaceDir = join(deps.dataDir, 'config', '.openclaw', 'workspace-feiyu')
    const tmpDir = join(deps.dataDir, 'cache')
    const runner = createOpenClawCliRunner(deps.cli)
    manager.setBootstrapRunner(() =>
      runBootstrap({
        workspaceDir,
        personaSourceDir: deps.personaSourceDir,
        getSettings: () => manager.getSettings(),
        getState: () => manager.getState(),
        obsidianVaultPath: deps.obsidianVaultPath?.(),
        ensureAgentEntry: (ws) =>
          applyAgentPatch({ runner, tmpDir, agentId: CHARACTER_AGENT_ID, workspace: ws }),
        agentConfigured: () => readAgentEntry(deps.configPath, CHARACTER_AGENT_ID).exists,
        gatewayReady: deps.gatewayReady,
        qqReady: deps.qqReady,
        ttsReady: deps.ttsReady,
        memorySearchReady: deps.memorySearchReady,
        logger,
        now: deps.now
      })
    )

    // 已启用（用户上次开着）：启动后静默补一次引导，保证 workspace 与人格文件存在
    if (manager.isEnabled()) {
      void manager.runBootstrap().catch((error) => {
        logger(`[character] 启动引导失败（不影响主流程）: ${(error as Error)?.message ?? String(error)}`)
      })
    }

    return {
      manager,
      dispose: async () => {
        ipcDisposer?.()
        ipcDisposer = null
      }
    }
  } catch (error) {
    logger(
      `[character] 初始化失败，角色功能降级（不影响主流程）: ${
        (error as Error)?.message ?? String(error)
      }`
    )
    ipcDisposer?.()
    return { manager: null, dispose: async () => undefined }
  }
}
