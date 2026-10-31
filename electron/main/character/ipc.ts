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
      return toCharacterEnvelope(await chat.clear())
    } catch (error) {
      return toCharacterErrorEnvelope(error)
    }
  })
  // 「她的一天」：默认今天；只读，不触发外发
  handle(CHARACTER_CHANNELS.lifeGet, (payload) => {
    const date = (payload as { date?: unknown } | undefined)?.date
    return manager.getLife(typeof date === 'string' ? date : undefined)
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
