// electron/main/character/ipc.ts —— character:* 通道注册（宿主命名空间）
//
// 统一信封 {ok:true,data} | {ok:false,error}，错误码见 types.ts。
// 返回 disposer：停用/退出时摘除handler（与插件通道同口径）。

import { ipcMain, screen } from 'electron'
import {
  CHARACTER_CHANNELS,
  CharacterError,
  CHARACTER_ERROR_CODES,
  clampPetPosition,
  toCharacterEnvelope,
  toCharacterErrorEnvelope,
  type CharacterInteractInput,
  type CharacterResetOptions
} from './types'
import type { CharacterManager } from './manager'
import type { PetWindowController } from './petWindow'
import type { CharacterChatService } from './chat'

export type CharacterIpcDisposer = () => void

export interface CharacterIpcDeps {
  pet?: PetWindowController | null
  chat?: CharacterChatService | null
  /** 语音条发送（C08；由 wiring 组装 TTS→SILK→QQ，失败降级文字） */
  deliverVoice?: (
    text: string,
    requested: boolean
  ) => Promise<{ delivered: boolean; channel: 'qq' | 'text'; error?: string }>
  /** 人格包导出/导入（4.3）：由 wiring 提供 workspace 读写 */
  persona?: {
    export: () => Promise<unknown>
    import: (raw: unknown) => Promise<{ written: string[]; backupDir?: string | null }>
  }
  /** 知识导入（4.3）：把用户文件写进 Obsidian 大肥鱼/<类别>/，不新增知识库 */
  knowledge?: {
    import: (payload: unknown) => Promise<{ written: string[] }>
    /** 知识体检：vault/MCP/索引/角色笔记数（4.3） */
    status?: () => unknown
  }
}

export function registerCharacterIpc(
  manager: CharacterManager,
  deps: CharacterIpcDeps = {}
): CharacterIpcDisposer {
  const channels = Object.values(CHARACTER_CHANNELS)

  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return toCharacterEnvelope(await fn(...args))
      } catch (error) {
        return toCharacterErrorEnvelope(error)
      }
    })
  }

  handle(CHARACTER_CHANNELS.statusGet, () => ({
    ...manager.getStatus(),
    chatGen: deps.chat?.getGeneration() ?? 0
  }))
  handle(CHARACTER_CHANNELS.stateGet, () => manager.getState())
  handle(CHARACTER_CHANNELS.settingsGet, () => manager.getSettings())
  handle(CHARACTER_CHANNELS.settingsSet, (patch) => manager.updateSettings(patch))
  handle(CHARACTER_CHANNELS.interact, (input) =>
    manager.interact((input ?? {}) as CharacterInteractInput)
  )
  handle(CHARACTER_CHANNELS.reset, (options) =>
    manager.reset((options ?? {}) as CharacterResetOptions)
  )
  handle(CHARACTER_CHANNELS.bootstrapRun, async () => {
    if (!manager.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    return manager.runBootstrap()
  })
  handle(CHARACTER_CHANNELS.bootstrapStatus, () => manager.getBootstrapStatus())
  handle(CHARACTER_CHANNELS.windowPet, async (payload) => {
    const pet = deps.pet
    if (!pet) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '桌宠窗口尚未接线')
    const action = (payload as { action?: string } | undefined)?.action
    // D8：未启用时整段不启动；只允许 hide 收尾，其他动作一律拒绝
    if (!manager.isEnabled() && action !== 'hide') {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    if (action === 'show') pet.show()
    else if (action === 'hide') pet.hide()
    else if (action === 'toggle') pet.toggle()
    else if (action === 'clickThrough') {
      // 严格布尔：字符串 'false' 不能变成 true
      const on = (payload as { value?: unknown }).value === true
      // 先落盘再应用：落盘失败时不会出现「已穿透但没有逃生热键」的死局
      await manager.updateSettings({ pet: { clickThrough: on } })
      pet.applyClickThrough(on)
    } else {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的桌宠窗口动作')
    }
    const state = pet.getState()
    return { visible: pet.isOpen(), clickThrough: state.clickThrough }
  })
  handle(CHARACTER_CHANNELS.windowPetPos, async (payload) => {
    const pet = deps.pet
    if (!pet) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '桌宠窗口尚未接线')
    if (!manager.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    const raw = (payload ?? {}) as { x?: unknown; y?: unknown }
    if (
      typeof raw.x !== 'number' ||
      typeof raw.y !== 'number' ||
      !Number.isFinite(raw.x) ||
      !Number.isFinite(raw.y)
    ) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '位置需要有限数字 x/y')
    }
    const current = await manager.getPetState()
    const x = raw.x
    const y = raw.y
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const near = displays.find(
      (d) =>
        x >= d.bounds.x &&
        x < d.bounds.x + d.bounds.width &&
        y >= d.bounds.y &&
        y < d.bounds.y + d.bounds.height
    )
    const workArea = (near ?? primary).workArea
    const clamped = clampPetPosition(
      Math.round(x),
      Math.round(y),
      current.width,
      current.height,
      workArea
    )
    const next = await manager.savePetState({ x: clamped.x, y: clamped.y })
    pet.applyState({ x: next.x, y: next.y })
    return next
  })
  // 聊天：send 需要拿到调用方 webContents 才能推流式事件，所以不走通用 handle 包装
  ipcMain.handle(CHARACTER_CHANNELS.chatSend, async (event, payload) => {
    try {
      if (!manager.isEnabled()) {
        throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
      }
      const chat = deps.chat
      if (!chat) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '聊天尚未接线')
      const result = await chat.send(
        (payload ?? {}) as { text?: unknown; session?: unknown },
        (streamEvent) => {
          if (event.sender.isDestroyed()) return
          const channel =
            streamEvent.kind === 'chunk'
              ? CHARACTER_CHANNELS.streamChunk
              : streamEvent.kind === 'done'
                ? CHARACTER_CHANNELS.streamDone
                : CHARACTER_CHANNELS.streamError
          event.sender.send(channel, streamEvent)
        }
      )
      return toCharacterEnvelope(result)
    } catch (error) {
      return toCharacterErrorEnvelope(error)
    }
  })
  ipcMain.handle(CHARACTER_CHANNELS.chatCancel, async (_event, payload) => {
    try {
      const chat = deps.chat
      if (!chat) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '聊天尚未接线')
      const runId = (payload as { runId?: unknown } | undefined)?.runId
      if (typeof runId !== 'string' || !runId) {
        throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '缺少 runId')
      }
      return toCharacterEnvelope({ cancelled: chat.cancel(runId) })
    } catch (error) {
      return toCharacterErrorEnvelope(error)
    }
  })
  ipcMain.handle(CHARACTER_CHANNELS.chatClear, async () => {
    try {
      const chat = deps.chat
      if (!chat) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '聊天尚未接线')
      const result = await chat.clear()
      // status 与流事件必须同一个 gen：清空后立刻回写缓存
      manager.noteChatGen(result.gen)
      return toCharacterEnvelope(result)
    } catch (error) {
      return toCharacterErrorEnvelope(error)
    }
  })
  // 「她的一天」：默认今天；只读，不触发外发
  handle(CHARACTER_CHANNELS.lifeGet, (payload) => {
    const date = (payload as { date?: unknown } | undefined)?.date
    return manager.getLife(typeof date === 'string' ? date : undefined)
  })
  handle(CHARACTER_CHANNELS.memoryStatus, () => manager.getMemoryStatus())
  handle(CHARACTER_CHANNELS.memoryRunNow, async () => {
    if (!manager.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    return manager.maybeRunDailyMemory(undefined, true)
  })
  handle(CHARACTER_CHANNELS.voiceSend, async (payload) => {
    if (!manager.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    const rawText = (payload as { text?: unknown } | undefined)?.text
    const text = typeof rawText === 'string' ? rawText.slice(0, 120) : '本鱼在呢。'
    const decision = await manager.decideVoiceFor(text, true)
    if (!decision.send) {
      return { delivered: false, channel: 'text' as const, reason: decision.reason }
    }
    // 判定发生在预留之前，避免「先自增再判满」导致 cap=1 永远发不出
    const claimed = await manager.claimVoiceSlot()
    if (!claimed.ok) {
      return { delivered: false, channel: 'text' as const, reason: claimed.reason ?? 'daily-cap' }
    }
    if (!deps.deliverVoice) {
      await manager.releaseVoiceSlot()
      return { delivered: false, channel: 'text' as const, reason: 'not-wired' }
    }
    const result = await deps.deliverVoice(text, decision.requested)
    if (!result.delivered) await manager.releaseVoiceSlot()
    return { ...result, reason: decision.reason }
  })
  handle(CHARACTER_CHANNELS.exportData, () => manager.exportData())
  handle(CHARACTER_CHANNELS.personaExport, () => {
    if (!deps.persona) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '人格包功能未接线')
    }
    return deps.persona.export()
  })
  handle(CHARACTER_CHANNELS.personaImport, (raw) => {
    if (!deps.persona) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '人格包功能未接线')
    }
    return deps.persona.import(raw)
  })
  handle(CHARACTER_CHANNELS.knowledgeStatus, () => {
    if (!deps.knowledge?.status) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '知识体检功能未接线')
    }
    return deps.knowledge.status()
  })
  handle(CHARACTER_CHANNELS.knowledgeImport, (payload) => {
    if (!deps.knowledge) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '知识导入功能未接线')
    }
    return deps.knowledge.import(payload)
  })
  handle(CHARACTER_CHANNELS.deleteData, (payload) =>
    manager.deleteData((payload as { scope?: unknown } | undefined)?.scope)
  )

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
