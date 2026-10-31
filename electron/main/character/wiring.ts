// electron/main/character/wiring.ts —— 角色模块唯一接线点
//
// index.ts 只调用一次 registerCharacter()；其余模块不直接 import 本目录以外的东西。
// 初始化失败只降级角色自身，绝不阻断宿主启动（红线 2）。

import { CharacterManager } from './manager'
import { registerCharacterIpc, type CharacterIpcDisposer } from './ipc'
import { CharacterStore } from './store'
import type { CharacterEvent, CharacterKv } from './types'

export interface CharacterWiringDeps {
  /** 宿主 app_meta KV（work.db；与 voice 同库同口径） */
  kv: CharacterKv
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
