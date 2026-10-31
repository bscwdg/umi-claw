// electron/main/character/wiring.ts —— 角色模块唯一接线点
//
// index.ts 只调用一次 registerCharacter()；其余模块不直接 import 本目录以外的东西。
// 初始化失败只降级角色自身，绝不阻断宿主启动（红线 2）。

import { globalShortcut } from 'electron'
import { join } from 'node:path'
import { CharacterManager } from './manager'
import { registerCharacterIpc, type CharacterIpcDisposer } from './ipc'
import { CharacterStore } from './store'
import { applyAgentPatch, createOpenClawCliRunner } from './agentPatchRunner'
import { CHARACTER_AGENT_ID, readAgentEntry } from './agentConfig'
import { runBootstrap } from './bootstrap'
import { PetWindowController, type PetMenuAction } from './petWindow'
import type { CharacterEvent, CharacterKv } from './types'

/** 点击穿透的逃生热键（穿透开启时注册；关掉即注销） */
export const CLICK_THROUGH_SHORTCUT = 'CommandOrControl+Alt+F'

export interface CharacterCliConfig {
  nodePath: string
  cliPath: string
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}

export interface CharacterPetWindowConfig {
  preloadPath: string
  devRendererUrl?: string
  prodRendererUrl: string
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
  /** 桌宠窗口配置（C03）；缺省则不建窗口 */
  petWindow?: CharacterPetWindowConfig
  /** 桌宠菜单里的「聊两句 / 设置」回调（由 index.ts 聚焦主窗） */
  onPetAction?: (action: PetMenuAction) => void
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
  let pet: PetWindowController | null = null
  let managerRef: CharacterManager | null = null

  const updateShortcut = (on: boolean): void => {
    try {
      const registered = globalShortcut.isRegistered(CLICK_THROUGH_SHORTCUT)
      if (on && !registered) {
        globalShortcut.register(CLICK_THROUGH_SHORTCUT, () => {
          pet?.applyClickThrough(false)
          void managerRef
            ?.updateSettings({ pet: { clickThrough: false } })
            .catch(() => undefined)
        })
      } else if (!on && registered) {
        globalShortcut.unregister(CLICK_THROUGH_SHORTCUT)
      }
    } catch (error) {
      logger(`[character] 穿透逃生热键注册失败: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  try {
    const store = new CharacterStore({ kv: deps.kv, now: deps.now })
    const manager = new CharacterManager({
      store,
      now: deps.now,
      logger,
      onEvent: (event) => {
        if (event.type === 'settings') void syncPet()
        deps.onEvent?.(event)
      }
    })
    managerRef = manager
    await manager.init()

    // 桌宠窗口（C03）：单例、透明置顶、位置记忆；停用时销毁
    if (deps.petWindow) {
      const initialPet = await manager.getPetState()
      pet = new PetWindowController({
        preloadPath: deps.petWindow.preloadPath,
        devRendererUrl: deps.petWindow.devRendererUrl,
        prodRendererUrl: deps.petWindow.prodRendererUrl,
        initialState: initialPet,
        onPositionChange: (x, y) => {
          void manager.savePetState({ x, y }).catch(() => undefined)
        },
        onAction: (action) => void handlePetAction(action),
        onClosed: () => undefined
      })
      if (manager.isEnabled() && initialPet.visible) pet.show()
      updateShortcut(initialPet.clickThrough)
    }

    ipcDisposer = registerCharacterIpc(manager, { pet })

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

    // 已启用（用户上次开着）：启动后静默补一次引导 + 校正桌宠可见性
    if (manager.isEnabled()) {
      void manager.runBootstrap().catch((error) => {
        logger(`[character] 启动引导失败（不影响主流程）: ${(error as Error)?.message ?? String(error)}`)
      })
      await syncPet()
    }

    async function syncPet(): Promise<void> {
      if (!pet) return
      try {
        const settings = await manager.getSettings()
        const petState = await manager.getPetState()
        pet.applyState({ ...petState, visible: Boolean(settings.enabled && settings.pet.visible) })
        updateShortcut(Boolean(settings.enabled && settings.pet.clickThrough))
      } catch (error) {
        logger(`[character] 桌宠状态同步失败: ${(error as Error)?.message ?? String(error)}`)
      }
    }

    async function handlePetAction(action: PetMenuAction): Promise<void> {
      try {
        if (action === 'hide') {
          pet?.hide()
          await manager.updateSettings({ pet: { visible: false } })
          return
        }
        if (action === 'quiet') {
          const until = (deps.now ?? Date.now)() + 3 * 86_400_000
          await manager.updateSettings({ proactive: { silentUntil: until } })
          return
        }
        deps.onPetAction?.(action)
      } catch (error) {
        logger(`[character] 桌宠菜单动作失败: ${(error as Error)?.message ?? String(error)}`)
      }
    }

    return {
      manager,
      dispose: async () => {
        try {
          if (globalShortcut.isRegistered(CLICK_THROUGH_SHORTCUT)) {
            globalShortcut.unregister(CLICK_THROUGH_SHORTCUT)
          }
        } catch {
          /* ignore */
        }
        ipcDisposer?.()
        ipcDisposer = null
        pet?.destroy()
        pet = null
      }
    }
  } catch (error) {
    logger(
      `[character] 初始化失败，角色功能降级（不影响主流程）: ${
        (error as Error)?.message ?? String(error)
      }`
    )
    ipcDisposer?.()
    pet?.destroy()
    return { manager: null, dispose: async () => undefined }
  }
}
