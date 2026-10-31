// electron/main/character/wiring.ts —— 角色模块唯一接线点
//
// index.ts 只调用一次 registerCharacter()；其余模块不直接 import 本目录以外的东西。
// 初始化失败只降级角色自身，绝不阻断宿主启动（红线 2）。

import { globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import { CharacterManager } from './manager'
import { registerCharacterIpc, type CharacterIpcDisposer } from './ipc'
import { CharacterStore } from './store'
import { applyAgentPatch, createOpenClawCliRunner } from './agentPatchRunner'
import { CHARACTER_AGENT_ID, CHARACTER_AGENT_MODEL, readAgentEntry } from './agentConfig'
import { loadPersonaTemplates, runBootstrap } from './bootstrap'
import { composePersonaFiles, writeManagedFiles } from './persona'
import { PetWindowController, type PetMenuAction } from './petWindow'
import { CharacterChatService, type CharacterChatFn } from './chat'
import {
  CHARACTER_CHANNELS,
  clampPetPosition,
  type CharacterEvent,
  type CharacterKv
} from './types'

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
  /** gateway 聊天函数（index.ts 用 workGatewayClient.createChatStream 注入；缺省则聊天不可用） */
  chat?: CharacterChatFn
  /** 角色 agent 模型路由（默认 openclaw/feiyu） */
  chatModel?: string
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

/** 幂等：同一进程只允许一份角色装配（重复调用返回已注册实例，避免第二次静默失效） */
let activeWiring: Promise<CharacterWiringResult> | null = null

export function registerCharacter(deps: CharacterWiringDeps): Promise<CharacterWiringResult> {
  if (activeWiring) return activeWiring
  activeWiring = registerCharacterInternal(deps)
    .then((result) => {
      // 降级（manager=null）不缓存：允许调用方修复环境后重试
      if (!result.manager) activeWiring = null
      return result
    })
    .catch((error) => {
      activeWiring = null
      throw error
    })
  return activeWiring
}

async function registerCharacterInternal(
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
        const ok = globalShortcut.register(CLICK_THROUGH_SHORTCUT, () => {
          pet?.applyClickThrough(false)
          void managerRef
            ?.updateSettings({ pet: { clickThrough: false } })
            .catch(() => undefined)
        })
        if (!ok) {
          // 逃生热键注册失败时绝不能保持穿透，否则用户被锁在窗外
          logger('[character] 穿透逃生热键注册失败，已自动关闭穿透')
          pet?.applyClickThrough(false)
          void managerRef?.updateSettings({ pet: { clickThrough: false } }).catch(() => undefined)
        }
      } else if (!on && registered) {
        globalShortcut.unregister(CLICK_THROUGH_SHORTCUT)
      }
    } catch (error) {
      logger(`[character] 穿透逃生热键注册失败: ${(error as Error)?.message ?? String(error)}`)
      pet?.applyClickThrough(false)
      void managerRef?.updateSettings({ pet: { clickThrough: false } }).catch(() => undefined)
    }
  }

  try {
    const store = new CharacterStore({ kv: deps.kv, now: deps.now })
    const workspaceDir = join(deps.dataDir, 'config', '.openclaw', 'workspace-feiyu')
    const manager = new CharacterManager({
      store,
      now: deps.now,
      logger,
      onEvent: (event) => {
        if (event.type === 'settings') void syncPet()
        if (event.type === 'reset') void chatService?.reloadGeneration().catch(() => undefined)
        // 桌宠窗口也要收到状态/设置事件（尺寸/表情/可见性同步）
        if (event.type === 'emotion') {
          pet?.broadcast(CHARACTER_CHANNELS.emotion, event.payload)
        } else {
          pet?.broadcast('character:event', event)
        }
        deps.onEvent?.(event)
      },
      clampPosition: (x, y, width, height) => {
        const displays = screen.getAllDisplays()
        const primary = screen.getPrimaryDisplay()
        const near = displays.find(
          (d) =>
            x >= d.bounds.x &&
            x < d.bounds.x + d.bounds.width &&
            y >= d.bounds.y &&
            y < d.bounds.y + d.bounds.height
        )
        return clampPetPosition(x, y, width, height, (near ?? primary).workArea)
      }
    })
    managerRef = manager
    await manager.init()

    // 聊天（C04）：会话键 conv:fish:<session>:<gen>；清空 = 轮换代际
    let chat: CharacterChatService | null = null
    if (deps.chat) {
      chat = new CharacterChatService({
        chat: deps.chat,
        store: {
          readChatGeneration: () => store.readChatGeneration(),
          writeChatGeneration: (gen) => store.writeChatGeneration(gen)
        },
        onEmotion: (emotion, visualState) => {
          void manager.applyChatEmotion(emotion, visualState).catch(() => undefined)
        },
        onMessage: (_text, refId) => {
          void manager
            .applyRelationshipEvent({ type: 'chat.message', refId })
            .catch((error) =>
              logger(`[character] 聊天记账失败: ${(error as Error)?.message ?? String(error)}`)
            )
        },
        model: deps.chatModel ?? CHARACTER_AGENT_MODEL,
        now: deps.now,
        logger
      })
      await chat.init()
    }
    const chatService = chat

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
      updateShortcut(manager.isEnabled() && initialPet.clickThrough)
    }

    ipcDisposer = registerCharacterIpc(manager, { pet, chat: chatService })

    // 设置/互动后 ≤300ms 合并重写人格文件（STATE.md 即时；用户改过的 SOUL/AGENTS 保留）
    manager.setPersonaSyncRunner(async () => {
      const templates = loadPersonaTemplates(deps.personaSourceDir)
      const files = composePersonaFiles({
        settings: await manager.getSettings(),
        state: await manager.getState(),
        templates
      })
      writeManagedFiles(workspaceDir, files)
    })

    // 引导接线：官方 CLI 写 agent 条目；人格文件走受管写入
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
        agentConfigured: () => {
          const entry = readAgentEntry(deps.configPath, CHARACTER_AGENT_ID)
          if (!entry.exists) return false
          if (!entry.workspace) return false
          const normalize = (p: string): string =>
            p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          const actual = normalize(entry.workspace)
          const expected = normalize(workspaceDir)
          // CLI 可能规范化路径（大小写/相对/多余 ./）：退化为「末尾同名目录」也算就绪，
          // 否则每次启动都会重复 patch 且引导步常驻失败
          return actual === expected || actual.endsWith(`/${CHARACTER_AGENT_ID}`) || actual.endsWith('/workspace-feiyu')
        },
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
        if (!settings.enabled) {
          // 停用 = 收起窗口（不销毁控制器，重新启用可重建）
          pet.close()
          updateShortcut(false)
          return
        }
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
        chatService?.cancelAll()
        manager.dispose()
        pet?.destroy()
        pet = null
        activeWiring = null
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
