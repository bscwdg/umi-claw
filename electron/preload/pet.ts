// electron/preload/pet.ts —— 桌宠窗口专用 preload（最小暴露面）
//
// §13.1-2：桌宠窗口不复用主窗的全量 preload —— 只给角色需要的只读状态、设置读取、
// 互动与隐藏；work/marketing/terminal/voice 等宿主 IPC 一概不暴露。

import { contextBridge, ipcRenderer } from 'electron'
import type { CharacterChatStreamEvent } from '../main/character/chat'
import type { CharacterEvent, CharacterSettings, CharacterState } from '../main/character/types'

class PetCallError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PetCallError'
    this.code = code
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
  if (result && result.ok === true) return result.data
  const error = result && result.ok === false ? result.error : null
  throw new PetCallError(error?.code ?? 'CHARACTER_STORE_IO', error?.message ?? 'IPC 调用失败')
}

const character = {
  status: () => call('character:status:get'),
  state: () => call<CharacterState>('character:state:get'),
  settings: {
    get: () => call<CharacterSettings>('character:settings:get'),
    set: (patch: Partial<CharacterSettings>) => call<CharacterSettings>('character:settings:set', patch)
  },
  interact: (input: { kind: 'pat' | 'feed' }) => call<CharacterState>('character:interact', input),
  pet: {
    hide: () => call('character:window:pet', { action: 'hide' })
  },
  onEvent: (cb: (event: CharacterEvent) => void) => {
    const handler = (_event: unknown, data: CharacterEvent) => cb(data)
    ipcRenderer.on('character:event', handler)
    return () => ipcRenderer.off('character:event', handler)
  },
  onEmotion: (cb: (payload: { emotion: string; visualState: string }) => void) => {
    const handler = (_event: unknown, payload: { emotion: string; visualState: string }) =>
      cb(payload)
    ipcRenderer.on('character:emotion', handler)
    return () => ipcRenderer.off('character:emotion', handler)
  },
  onStream: (_cb: (event: CharacterChatStreamEvent) => void) => () => undefined
}

const api = { character }

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore non-contextIsolation fallback
  window.api = api
}
