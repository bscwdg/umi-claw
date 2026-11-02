// electron/main/character/wiring.ts —— 角色模块唯一接线点
//
// index.ts 只调用一次 registerCharacter()；其余模块不直接 import 本目录以外的东西。
// 初始化失败只降级角色自身，绝不阻断宿主启动（红线 2）。

import { globalShortcut, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CharacterManager } from './manager'
import { registerCharacterIpc, type CharacterIpcDisposer } from './ipc'
import { CharacterStore } from './store'
import { applyAgentPatch, createOpenClawCliRunner, removeAgentEntry } from './agentPatchRunner'
import { CHARACTER_AGENT_ID, CHARACTER_AGENT_MODEL, readAgentEntry } from './agentConfig'
import { loadPersonaTemplates, runBootstrap } from './bootstrap'
import { parseLifeDeck } from './contentCards'
import { deliverVoice, type QqBotCreds } from './qqVoice'
import { isVoiceRequest } from './voicePolicy'
import { formatSearchContext, looksLikeRecallQuery, withTimeout } from './searchContext'
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
  /** 主动消息外发（C08 注入 QQ；缺省只发应用内气泡） */
  sendProactive?: (message: { text: string; channel: 'qq' | 'app' }) => Promise<boolean>
  /** 日记生成（index.ts 用 gateway 非流式 chat + openclaw/feiyu） */
  generateDiary?: (prompt: string, meta: { date: string }) => Promise<string>
  /** 预检索（性能）：像在问过去/笔记时由宿主直接查 Obsidian，命中片段注入本轮上下文 */
  searchKnowledge?: (
    query: string
  ) => Promise<Array<{ path: string; content: string; score: number }>>
  /** 语音条（C08）：TTS 出 16k WAV + QQ 凭据；缺省则语音条不可用（降级文字） */
  voice?: {
    speakPcm: (text: string) => Promise<Uint8Array>
    creds: () => QqBotCreds | null
    encodeSilk?: (pcm: Uint8Array, sampleRate: number) => Promise<Uint8Array>
  }
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
    // 删除全量时再摘 agent 条目（runner 在下方创建，先留可调用位）
    let removeAgentEntryFn: (() => Promise<unknown>) | null = null
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
      },
      loadLifeDeck: async () => {
        const file = join(dirname(deps.personaSourceDir), 'cards', 'life-cards.v1.json')
        return parseLifeDeck(JSON.parse(readFileSync(file, 'utf8')))
      },
      writeLifeDoc: async (text) => {
        writeFileSync(join(workspaceDir, 'fish', 'LIFE.md'), text, 'utf8')
      },
      sendProactive: deps.sendProactive,
      generateDiary: deps.generateDiary,
      readWorkspaceMemory: async (date) => {
        try {
          return readFileSync(join(workspaceDir, 'memory', `${date}.md`), 'utf8')
        } catch {
          return null
        }
      },
      writeWorkspaceMemory: async (date, text) => {
        const dir = join(workspaceDir, 'memory')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${date}.md`), text, 'utf8')
      },
      writeObsidianDiary: async (relPath, text) => {
        const vault = deps.obsidianVaultPath?.()?.trim()
        if (!vault) throw new Error('未配置 Obsidian vault，日记只写 workspace')
        const target = join(vault, ...relPath.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, text, 'utf8')
      },
      obsidianAvailable: () => Boolean(deps.obsidianVaultPath?.()?.trim()),
      deleteWorkspaceFiles: async (scope) => {
        if (scope === 'values') return
        // 日记：从 Obsidian 日记目录移到 归档/<时间戳>，不直接删用户笔记
        const vault = deps.obsidianVaultPath?.()?.trim()
        if (vault) {
          const diaryDir = join(vault, '大肥鱼', '日记')
          if (existsSync(diaryDir)) {
            const archiveDir = join(vault, '大肥鱼', '归档', String(Date.now()))
            try {
              mkdirSync(archiveDir, { recursive: true })
              for (const file of readdirSync(diaryDir)) {
                renameSync(join(diaryDir, file), join(archiveDir, file))
              }
            } catch (error) {
              logger(`[character] 日记归档失败: ${(error as Error)?.message ?? String(error)}`)
            }
          }
        }
        // workspace：STATE/LIFE/memory 一定清；全量删除才动人格文件
        const removeSafe = (path: string): void => {
          try {
            rmSync(path, { force: true, recursive: true })
          } catch {
            /* ignore */
          }
        }
        removeSafe(join(workspaceDir, 'fish', 'STATE.md'))
        removeSafe(join(workspaceDir, 'fish', 'LIFE.md'))
        removeSafe(join(workspaceDir, 'memory'))
        if (scope === 'all') {
          for (const file of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md']) {
            removeSafe(join(workspaceDir, file))
          }
          removeSafe(join(workspaceDir, '.fish-managed.json'))
          // §13.1-4：全量删除后 openclaw.json 里不应再有 feiyu 条目
          if (removeAgentEntryFn) {
            try {
              const result = (await removeAgentEntryFn()) as { ok?: boolean; error?: string } | undefined
              if (result && result.ok === false) {
                // 不能静默：删除 all 后 agent 条目必须消失（§13.1-4）
                throw new Error(result.error ?? 'agent 条目删除失败')
              }
            } catch (error) {
              logger(`[character] 删除 agent 条目失败: ${(error as Error)?.message ?? String(error)}`)
              throw error
            }
          }
        }
      }
    })
    managerRef = manager
    // 状态自检改为实时求值：配置改完不用重跑初始化，页面「连接自检」立刻反映
    // 与 bootstrap 同口径：条目存在且 workspace 指向角色工作区
    // agent 就绪判定：bootstrap 报告与「连接自检」实时 flags 必须同一口径
    const isAgentConfigured = (): boolean => {
      const entry = readAgentEntry(deps.configPath, CHARACTER_AGENT_ID)
      if (!entry.exists || !entry.workspace) return false
      const normalize = (p: string): string =>
        p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const actual = normalize(entry.workspace)
      const expected = normalize(workspaceDir)
      // CLI 可能规范化路径（大小写/相对/多余 ./）：末尾同名目录也算就绪
      return (
        actual === expected ||
        actual.endsWith(`/${CHARACTER_AGENT_ID}`) ||
        actual.endsWith('/workspace-feiyu')
      )
    }
    manager.setStatusProviders({
      ...(deps.gatewayReady ? { gatewayReady: deps.gatewayReady } : {}),
      ...(deps.qqReady ? { qqReady: deps.qqReady } : {}),
      ...(deps.ttsReady ? { ttsReady: deps.ttsReady } : {}),
      ...(deps.memorySearchReady ? { memorySearchReady: deps.memorySearchReady } : {}),
      agentReady: isAgentConfigured,
      obsidianReady: () => {
        const vault = deps.obsidianVaultPath?.()?.trim()
        return Boolean(vault && existsSync(join(vault, '大肥鱼')))
      }
    })
    await manager.init()

    // 语音条（C08）：TTS 16k WAV → SILK → QQ；失败降级文字，不重试
    let voiceSeq = 0
    // 串行化语音发送：msg_seq 的读取-自增不能并发（QQ 会因重复 seq 拒收）
    let voiceQueue: Promise<unknown> = Promise.resolve()
    const deliverVoiceFn = deps.voice
      ? async (
          text: string
        ): Promise<{ delivered: boolean; channel: 'qq' | 'text'; error?: string }> => {
          const run = voiceQueue.then(async () => {
            try {
              const result = await deliverVoice({
                text,
                creds: deps.voice!.creds(),
                speakPcm: deps.voice!.speakPcm,
                encodeSilk: deps.voice!.encodeSilk,
                seq: voiceSeq
              })
              voiceSeq = result.seq
              return { delivered: result.delivered, channel: result.channel, error: result.error }
            } catch (error) {
              return {
                delivered: false,
                channel: 'text' as const,
                error: (error as Error)?.message ?? String(error)
              }
            }
          })
          voiceQueue = run.catch(() => undefined)
          return run
        }
      : undefined

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
        onMessage: (text, refId, userText) => {
          void manager
            .applyRelationshipEvent({ type: 'chat.message', refId })
            .catch((error) =>
              logger(`[character] 聊天记账失败: ${(error as Error)?.message ?? String(error)}`)
            )
          // 用户明确要语音：按策略发语音条；失败只降级文字（聊天文本已经展示）
          if (deliverVoiceFn && isVoiceRequest(userText)) {
            void (async () => {
              try {
                const decision = await manager.decideVoiceFor(text, true)
                if (!decision.send) return
                const claimed = await manager.claimVoiceSlot()
                if (!claimed.ok) return
                const result = await deliverVoiceFn(text)
                if (result.delivered) {
                  await manager.applyRelationshipEvent({
                    type: 'voice.request',
                    refId: `v:${refId}`
                  })
                } else {
                  await manager.releaseVoiceSlot()
                }
              } catch (error) {
                logger(`[character] 语音条失败（已降级文字）: ${(error as Error)?.message ?? String(error)}`)
              }
            })()
          }
        },
        // 安全闸门：危机词不进模型；输出侧改写独占/卖惨表达
        screenInput: (text) => manager.screenInbound(text),
        filterOutput: (text) => manager.filterAssistantText(text),
        contextProvider: async (text: string) => {
          // 每轮注入的短上下文：称呼 + 阶段 + 今日活动（≤300 字，让 C05/C06 对对话可见）
          const parts: string[] = []
          try {
            const settings = await manager.getSettings()
            const state = await manager.getState()
            const life = await manager.getLife()
            const address = settings.relationship.address || '你'
            const activity = life.day?.activity ?? ''
            const stageLabels = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
            parts.push(
              `称呼：${address}；阶段：${stageLabels[state.stage] ?? '初识'}；心情：${
                state.mood || '平静'
              }${activity ? `；今天：${activity}` : ''}`.slice(0, 300)
            )
          } catch {
            /* 状态读失败不影响对话 */
          }
          // 预检索：像在问过去/笔记时，宿主直接查 Obsidian（200–500ms），
          // 把命中片段注入本轮，省掉模型 tool_search → search_notes 的 40s+ 链路。
          if (deps.searchKnowledge && looksLikeRecallQuery(text)) {
            try {
              const hits = await withTimeout(deps.searchKnowledge(text), 1200)
              const context = formatSearchContext(hits ?? [])
              if (context) parts.push(context)
            } catch {
              /* 预检索失败就退回让模型自己决定是否检索 */
            }
          }
          return parts.length ? parts.join('\n\n') : null
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

    ipcDisposer = registerCharacterIpc(manager, {
      pet,
      chat: chatService,
      deliverVoice: deliverVoiceFn
    })

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
    removeAgentEntryFn = () => removeAgentEntry({ runner, tmpDir, agentId: CHARACTER_AGENT_ID })
    manager.setBootstrapRunner(() =>
      runBootstrap({
        workspaceDir,
        personaSourceDir: deps.personaSourceDir,
        getSettings: () => manager.getSettings(),
        getState: () => manager.getState(),
        obsidianVaultPath: deps.obsidianVaultPath?.(),
        ensureAgentEntry: (ws) =>
          applyAgentPatch({ runner, tmpDir, agentId: CHARACTER_AGENT_ID, workspace: ws }),
        agentConfigured: isAgentConfigured,
        gatewayReady: deps.gatewayReady,
        qqReady: deps.qqReady,
        ttsReady: deps.ttsReady,
        memorySearchReady: deps.memorySearchReady,
        logger,
        now: deps.now
      })
    )

    let proactiveTimer: NodeJS.Timeout | null = null
    const stopProactive = (): void => {
      if (proactiveTimer) clearInterval(proactiveTimer)
      proactiveTimer = null
    }
    const startProactive = (): void => {
      if (proactiveTimer) return
      proactiveTimer = setInterval(() => {
        void manager.runProactiveTick().catch((error) => {
          logger(`[character] 主动性 tick 失败: ${(error as Error)?.message ?? String(error)}`)
        })
        // 23:00 窗口内跑每日记忆（失败会按 5 分钟间隔重试，最多 3 次）
        void manager.maybeRunDailyMemory().catch((error) => {
          logger(`[character] 每日记忆 tick 失败: ${(error as Error)?.message ?? String(error)}`)
        })
      }, 30_000)
    }

    // 已启用（用户上次开着）：启动后静默补一次引导 + 校正桌宠可见性 + 生成今天的生活
    if (manager.isEnabled()) {
      void manager.runBootstrap().catch((error) => {
        logger(`[character] 启动引导失败（不影响主流程）: ${(error as Error)?.message ?? String(error)}`)
      })
      void manager.ensureDailyLife().catch(() => undefined)
      startProactive()
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
          stopProactive()
          return
        }
        const petState = await manager.getPetState()
        pet.applyState({ ...petState, visible: Boolean(settings.enabled && settings.pet.visible) })
        updateShortcut(Boolean(settings.enabled && settings.pet.clickThrough))
        startProactive()
        void manager.ensureDailyLife().catch(() => undefined)
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
        stopProactive()
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
