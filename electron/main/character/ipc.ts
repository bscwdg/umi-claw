// electron/main/character/ipc.ts —— character:* 通道注册（宿主命名空间）
//
// 统一信封 {ok:true,data} | {ok:false,error}，错误码见 types.ts。
// 返回 disposer：停用/退出时摘除handler（与插件通道同口径）。

import { ipcMain } from 'electron'
import {
  CHARACTER_CHANNELS,
  toCharacterEnvelope,
  toCharacterErrorEnvelope,
  type CharacterInteractInput,
  type CharacterResetOptions
} from './types'
import type { CharacterManager } from './manager'

export type CharacterIpcDisposer = () => void

export function registerCharacterIpc(manager: CharacterManager): CharacterIpcDisposer {
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

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
