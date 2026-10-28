import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TerminalRuntime } from '../../src/types/terminal'
import type { ChannelStatus } from '../../src/types/channels'
import type {
  VoiceAudioPayload,
  VoiceCatalogFile,
  VoiceCloneActivateInput,
  VoiceCloneRecord,
  VoiceCloneSample,
  VoiceCloneTrainInput,
  VoiceCloneValidation,
  VoiceKeyKind,
  VoiceSettings,
  VoiceSettingsView,
  VoiceSpeakInput,
  VoiceSpeakResult,
  VoiceTestResult,
  VoiceUsageDay
} from '../main/fish/voice/core/types'
console.log('✅ preload loaded')
async function voiceCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as {
    ok?: boolean
    data?: T
    error?: { message?: string }
  }
  if (res?.ok) return res.data as T
  throw new Error(res?.error?.message || '语音服务不可用')
}

// 完整类型化的 API
const api = {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    // 关闭确认：接收主进程发来的关闭请求
    onCloseRequest: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('window:close-request', handler)
      return () => ipcRenderer.off('window:close-request', handler)
    },
    // 关闭确认：回传用户选择（tray=最小化到托盘，exit=退出）
    resolveClose: (action: 'tray' | 'exit', remember?: boolean) =>
      ipcRenderer.invoke('window:close-resolve', { action, remember }),
    // 关闭确认：用户取消
    cancelClose: () => ipcRenderer.invoke('window:close-cancel')
  },

  // OpenClaw 进程管理
  claw: {
    start: () => ipcRenderer.invoke('claw:start'),
    stop: () => ipcRenderer.invoke('claw:stop'),
    restart: () => ipcRenderer.invoke('claw:restart'),
    status: () => ipcRenderer.invoke('claw:status'),
    openWeb: () => ipcRenderer.invoke('claw:openWeb'),
    // 事件监听
    onLog: (cb: (data: { line: string; type: string; time: number }) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('claw:log', handler)
      return () => ipcRenderer.off('claw:log', handler)
    },
    onStatusChange: (cb: (data: { running: boolean; port?: number; maintenance?: boolean }) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('claw:statusChange', handler)
      return () => ipcRenderer.off('claw:statusChange', handler)
    },
    // 获取token
    getToken: () => ipcRenderer.invoke('claw:get-token'),
  },

  // 配置
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: any) => ipcRenderer.invoke('config:save', config),
    reset: () => ipcRenderer.invoke('config:reset'),
    getDataDir: () => ipcRenderer.invoke('config:getDataDir'),
    openDataDir: () => ipcRenderer.invoke('config:openDataDir'),
    testConnection: (config) => ipcRenderer.invoke('test-connection', config),
    getPresetModels: (configName: string) =>
      ipcRenderer.invoke('config:getPresetModels', configName),
    refreshModelPresets: () => ipcRenderer.invoke('config:refreshModelPresets'),
    getModelPresetsInfo: () => ipcRenderer.invoke('config:getModelPresetsInfo')
  },

  // 环境
  env: {
    check: () => ipcRenderer.invoke('env:check'),
    init: (options?: any) => ipcRenderer.invoke('env:init', options),
    update: (options?: any) => ipcRenderer.invoke('env:update', options),
    checkLatest: (options?: any) => ipcRenderer.invoke('env:checkLatest', options),
    getInfo: () => ipcRenderer.invoke('env:getInfo'),
    getNodeVersions: (options?: any) => ipcRenderer.invoke('env:nodeVersions', options),
    updateNode: (options?: any) => ipcRenderer.invoke('env:updateNode', options),
    onProgress: (cb: (progress: any) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('env:progress', handler)
      return () => ipcRenderer.off('env:progress', handler)
    }
  },

  // 日志
  log: {
    getLogs: () => ipcRenderer.invoke('log:getLogs'),
    clearLogs: () => ipcRenderer.invoke('log:clearLogs')
  },

  // 技能
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    install: (id: string) => ipcRenderer.invoke('skills:install', id),
    uninstall: (id: string) => ipcRenderer.invoke('skills:uninstall', id),
    getInstalledSkills: () => ipcRenderer.invoke('skills:getInstalledSkills'),
    toggleSkillStatus: (id: string, enabled: boolean) => ipcRenderer.invoke('skills:toggleSkillStatus', id, enabled),
    removeSkill: (id: string) => ipcRenderer.invoke('skills:removeSkill', id),
    importSkillZip: () => ipcRenderer.invoke('skills:importSkillZip'),
    probeRemote: () => ipcRenderer.invoke('skills:probeRemote'),
    installSkills: (ids: string[]) => ipcRenderer.invoke('skills:installSkills', ids),
    applyUpdates: (ids: string[]) => ipcRenderer.invoke('skills:applyUpdates', ids),
    getPendingUpdates: () => ipcRenderer.invoke('skills:getPendingUpdates'),
  },

  // 工具
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // 应用信息
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion')
  },

  dialog: {
    showMessage: (options: any) => ipcRenderer.invoke('dialog:showMessage', options)
  },
  // 渠道
  channels: {
    isPluginInstalled: (pluginId: string) =>
      ipcRenderer.invoke('channels:isPluginInstalled', pluginId),
    installPlugin: (pluginPkg: string) =>
      ipcRenderer.invoke('channels:installPlugin', pluginPkg),
    getStatuses: (): Promise<ChannelStatus[]> => ipcRenderer.invoke('channels:getStatuses')
  },
  // 终端
  terminal: {
    runCommand: (args: string[], runtime?: TerminalRuntime) =>
      ipcRenderer.invoke('term:run', args, runtime),
    startPty: (args: string[], cols: number, rows: number, runtime?: TerminalRuntime) =>
      ipcRenderer.invoke('term:pty-start', args, cols, rows, runtime),
    inputPty: (sid: string, data: string) => ipcRenderer.invoke('term:pty-input', sid, data),
    resizePty: (sid: string, cols: number, rows: number) => ipcRenderer.invoke('term:pty-resize', sid, cols, rows),
    stopPty: (sid: string) => ipcRenderer.invoke('term:pty-stop', sid),
    // 监听主进程推过来的终端流数据
    onPtyChunk: (callback: any) => ipcRenderer.on('term:pty-chunk', (_, data) => callback(data)),
    onPtyExit: (callback: any) => ipcRenderer.on('term:pty-exit', (_, data) => callback(data)),
    // 组件卸载时移除监听，防止内存泄漏
    removeListeners: () => {
      ipcRenderer.removeAllListeners('term:pty-chunk')
      ipcRenderer.removeAllListeners('term:pty-exit')
    }
  },

  // Obsidian 知识库
  obsidian: {
    getConfig: () => ipcRenderer.invoke('obsidian:getConfig'),
    saveConfig: (cfg: any) => ipcRenderer.invoke('obsidian:saveConfig', cfg),
    selectVault: () => ipcRenderer.invoke('obsidian:selectVault'),
    getIndexStatus: () => ipcRenderer.invoke('obsidian:getIndexStatus'),
    rebuildIndex: () => ipcRenderer.invoke('obsidian:rebuildIndex'),
    cancelIndex: () => ipcRenderer.invoke('obsidian:cancelIndex'),
    testEmbedding: (arg: any) => ipcRenderer.invoke('obsidian:testEmbedding', arg),
    getEmbeddingPresets: () => ipcRenderer.invoke('obsidian:getEmbeddingPresets'),
    testSearch: (arg: { query: string; limit?: number; tag?: string }) =>
      ipcRenderer.invoke('obsidian:testSearch', arg),
    onIndexProgress: (cb: (data: any) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('obsidian:index-progress', handler)
      return () => ipcRenderer.off('obsidian:index-progress', handler)
    }
  },

  // ── 鱼语音（PLAN-VOICE.md）──
  fish: {
    voice: {
      settings: {
        get: () => voiceCall<VoiceSettingsView>('fish:voice:settings:get'),
        set: (patch: Partial<VoiceSettings>) =>
          voiceCall<VoiceSettingsView>('fish:voice:settings:set', patch)
      },
      key: {
        set: (kind: VoiceKeyKind, value: string) =>
          voiceCall<VoiceSettingsView>('fish:voice:key:set', kind, value),
        clear: (kind: VoiceKeyKind) =>
          voiceCall<VoiceSettingsView>('fish:voice:key:clear', kind)
      },
      catalog: {
        get: () => voiceCall<VoiceCatalogFile>('fish:voice:catalog:get')
      },
      test: (kind: VoiceKeyKind) => voiceCall<VoiceTestResult>('fish:voice:test', kind),
      speak: (input: VoiceSpeakInput) =>
        voiceCall<VoiceSpeakResult>('fish:voice:speak', input),
      audio: (audioId: string) =>
        voiceCall<VoiceAudioPayload>('fish:voice:audio', audioId),
      budget: {
        get: (date?: string) => voiceCall<VoiceUsageDay>('fish:voice:budget:get', date),
        set: (limit: number) =>
          voiceCall<VoiceSettingsView>('fish:voice:budget:set', limit)
      },
      cache: {
        clear: () => voiceCall<{ freedBytes: number }>('fish:voice:cache:clear')
      },
      clone: {
        pickSample: () => voiceCall<VoiceCloneSample | null>('fish:voice:clone:pickSample'),
        validate: (token: string) =>
          voiceCall<VoiceCloneValidation>('fish:voice:clone:validate', token),
        train: (input: VoiceCloneTrainInput) =>
          voiceCall<VoiceCloneRecord>('fish:voice:clone:train', input),
        status: (speakerId: string) =>
          voiceCall<VoiceCloneRecord>('fish:voice:clone:status', speakerId),
        list: () => voiceCall<VoiceCloneRecord[]>('fish:voice:clone:list'),
        remove: (speakerId: string) =>
          voiceCall<{ removed: true; remoteDelete: 'unsupported' }>(
            'fish:voice:clone:remove',
            speakerId
          ),
        activate: (input: VoiceCloneActivateInput) =>
          voiceCall<VoiceSpeakResult>('fish:voice:clone:activate', input),
        demoAudio: (speakerId: string, modelType: number) =>
          voiceCall<VoiceAudioPayload>('fish:voice:clone:demoAudio', speakerId, modelType)
      },
      autoSpeak: {
        on: (cb: (event: { audioId: string; mime: string }) => void) => {
          const handler = (_event: unknown, data: { audioId: string; mime: string }) => cb(data)
          ipcRenderer.on('fish:voice:auto-speak', handler)
          return () => ipcRenderer.off('fish:voice:auto-speak', handler)
        }
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

export type Api = typeof api
