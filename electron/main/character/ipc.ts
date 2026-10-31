// electron/main/character/ipc.ts —— character:* 通道注册（宿主命名空间）
//
// 统一信封 {ok:true,data} | {ok:false,error}，错误码见 types.ts。
// 返回 disposer：停用/退出时摘除handler（与插件通道同口径）。

import { ipcMain } from 'electron'
import {
  CHARACTER_CHANNELS,
  CharacterError,
  CHARACTER_ERROR_CODES,
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

  handle(CHARACTER_CHANNELS.statusGet, () => manager.getStatus())
  handle(CHARACTER_CHANNELS.stateGet, () => manager.getState())
  handle(CHARACTER_CHANNELS.settingsGet, () => manager.getSettings())
  handle(CHARACTER_CHANNELS.settingsSet, (patch) => manager.updateSettings(patch))
  handle(CHARACTER_CHANNELS.interact, (input) =>
    manager.interact((input ?? {}) as CharacterInteractInput)
  )
  handle(CHARACTER_CHANNELS.reset, (options) =>
    manager.reset((options ?? {}) as CharacterResetOptions)
  )
  handle(CHARACTER_CHANNELS.bootstrapRun, () => manager.runBootstrap())
  handle(CHARACTER_CHANNELS.bootstrapStatus, () => manager.getBootstrapStatus())
  handle(CHARACTER_CHANNELS.windowPet, async (payload) => {
    const pet = deps.pet
    if (!pet) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '桌宠窗口尚未接线')
    const action = (payload as { action?: string } | undefined)?.action
    if (action === 'show') pet.show()
    else if (action === 'hide') pet.hide()
    else if (action === 'toggle') pet.toggle()
    else if (action === 'clickThrough') {
      const on = Boolean((payload as { value?: unknown }).value)
      pet.applyClickThrough(on)
      await manager.updateSettings({ pet: { clickThrough: on } })
    } else {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的桌宠窗口动作')
    }
    const state = pet.getState()
    return { visible: pet.isOpen(), clickThrough: state.clickThrough }
  })
  handle(CHARACTER_CHANNELS.windowPetPos, async (payload) => {
    const pet = deps.pet
    if (!pet) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '桌宠窗口尚未接线')
    const raw = (payload ?? {}) as { x?: unknown; y?: unknown }
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '位置需要 x/y 数字')
    }
    const next = await manager.savePetState({ x: raw.x, y: raw.y })
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
      return toCharacterEnvelope(await chat.clear())
    } catch (error) {
      return toCharacterErrorEnvelope(error)
    }
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
