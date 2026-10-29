import { dialog, ipcMain } from 'electron'
import {
  toVoiceErrorEnvelope,
  VOICE_ERROR_CODES,
  VoiceError,
  type VoiceIpcResult
} from './core/errors'
import type {
  VoiceCloneActivateInput,
  VoiceCloneSample,
  VoiceCloneTrainInput,
  VoiceKeyKind,
  VoiceSpeakInput
} from './core/types'
import type { VoiceManager } from './core/manager'
import type { VoiceCloneManager } from './core/cloneManager'

export const VOICE_CHANNELS = {
  settingsGet: 'fish:voice:settings:get',
  settingsSet: 'fish:voice:settings:set',
  keySet: 'fish:voice:key:set',
  keyClear: 'fish:voice:key:clear',
  catalogGet: 'fish:voice:catalog:get',
  test: 'fish:voice:test',
  speak: 'fish:voice:speak',
  audio: 'fish:voice:audio',
  budgetGet: 'fish:voice:budget:get',
  budgetSet: 'fish:voice:budget:set',
  cacheClear: 'fish:voice:cache:clear',
  cancel: 'fish:voice:cancel',
  clonePickSample: 'fish:voice:clone:pickSample',
  cloneValidate: 'fish:voice:clone:validate',
  cloneTrain: 'fish:voice:clone:train',
  cloneStatus: 'fish:voice:clone:status',
  cloneList: 'fish:voice:clone:list',
  cloneRemove: 'fish:voice:clone:remove',
  cloneActivate: 'fish:voice:clone:activate',
  cloneDemoAudio: 'fish:voice:clone:demoAudio'
} as const

async function wrap<T>(fn: () => Promise<T>): Promise<VoiceIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: toVoiceErrorEnvelope(error) }
  }
}

function handle(
  channel: string,
  fn: (...args: any[]) => Promise<VoiceIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_event, ...args) => fn(...args))
}

function validateKeyKind(kind: unknown): VoiceKeyKind {
  if (kind !== 'tts' && kind !== 'clone') {
    throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
  }
  return kind
}

export function registerVoiceIpc(manager: VoiceManager, clone: VoiceCloneManager): void {
  handle(VOICE_CHANNELS.settingsGet, () => wrap(() => manager.getSettings()))
  handle(VOICE_CHANNELS.settingsSet, (patch: unknown) =>
    wrap(() => manager.updateSettings(patch))
  )
  handle(VOICE_CHANNELS.keySet, (kind: unknown, value: string) =>
    wrap(() => manager.setKey(validateKeyKind(kind), value))
  )
  handle(VOICE_CHANNELS.keyClear, (kind: unknown) =>
    wrap(() => manager.clearKey(validateKeyKind(kind)))
  )
  handle(VOICE_CHANNELS.catalogGet, () => wrap(async () => manager.getCatalog()))
  handle(VOICE_CHANNELS.test, (kind: unknown) =>
    wrap(() => manager.test(validateKeyKind(kind)))
  )
  handle(VOICE_CHANNELS.speak, (input: VoiceSpeakInput) =>
    wrap(() => manager.speak(input))
  )
  handle(VOICE_CHANNELS.audio, (audioId: string) =>
    wrap(() => manager.readAudio(audioId))
  )
  handle(VOICE_CHANNELS.budgetGet, (date?: string) =>
    wrap(() => manager.getBudget(typeof date === 'string' ? date : undefined))
  )
  handle(VOICE_CHANNELS.budgetSet, (limit: number) =>
    wrap(() => manager.updateSettings({ dailyCharLimit: limit }))
  )
  handle(VOICE_CHANNELS.cacheClear, () => wrap(() => manager.clearCache()))
  handle(VOICE_CHANNELS.cancel, (jobId: string) =>
    wrap(async () => {
      await manager.cancel(String(jobId ?? ''))
      return { cancelled: true }
    })
  )
  handle(VOICE_CHANNELS.clonePickSample, () =>
    wrap(async (): Promise<VoiceCloneSample | null> => {
      const result = await dialog.showOpenDialog({
        title: '选择声音克隆样本',
        properties: ['openFile'],
        filters: [
          {
            name: '音频样本',
            extensions: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm']
          }
        ]
      })
      if (result.canceled || !result.filePaths[0]) return null
      return clone.registerSample(result.filePaths[0])
    })
  )
  handle(VOICE_CHANNELS.cloneValidate, (token: string) =>
    wrap(() => clone.validate(token))
  )
  handle(VOICE_CHANNELS.cloneTrain, (input: VoiceCloneTrainInput) =>
    wrap(() => clone.train(input))
  )
  handle(VOICE_CHANNELS.cloneStatus, (speakerId: string) =>
    wrap(() => clone.refresh(speakerId))
  )
  handle(VOICE_CHANNELS.cloneList, () => wrap(() => clone.list()))
  handle(VOICE_CHANNELS.cloneRemove, (speakerId: string) =>
    wrap(() => clone.remove(speakerId))
  )
  handle(VOICE_CHANNELS.cloneActivate, (input: VoiceCloneActivateInput) =>
    wrap(() => clone.activate(input))
  )
  handle(VOICE_CHANNELS.cloneDemoAudio, (speakerId: string, modelType: number) =>
    wrap(() => clone.readDemo(speakerId, modelType))
  )
}
