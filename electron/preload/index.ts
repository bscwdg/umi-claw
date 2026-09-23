import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TerminalRuntime } from '../../src/types/terminal'

console.log('✅ preload loaded')

// ── work 域信封解包：IPC 返回 {ok,data} / {ok,error} ────────────────────────
// 失败抛带 code/details 的错误，渲染端按 err.code 分支（不读 message）。
class WorkError extends Error {
  code: string
  details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'WorkError'
    this.code = code
    this.details = details
  }
}

async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (res && res.ok) return res.data as T
  throw new WorkError(res?.error?.code ?? 'UNKNOWN', res?.error?.message ?? `IPC ${channel} 失败`, res?.error?.details)
}

// 完整类型化的 API
const api = {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onCloseRequest: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('window:close-request', handler)
      return () => ipcRenderer.off('window:close-request', handler)
    },
    resolveClose: (action: 'tray' | 'exit', remember?: boolean) =>
      ipcRenderer.invoke('window:close-resolve', { action, remember }),
    cancelClose: () => ipcRenderer.invoke('window:close-cancel')
  },

  // OpenClaw 进程管理
  claw: {
    start: () => ipcRenderer.invoke('claw:start'),
    stop: () => ipcRenderer.invoke('claw:stop'),
    restart: () => ipcRenderer.invoke('claw:restart'),
    status: () => ipcRenderer.invoke('claw:status'),
    openWeb: () => ipcRenderer.invoke('claw:openWeb'),
    onLog: (cb: (data: { line: string; type: string; time: number }) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('claw:log', handler)
      return () => ipcRenderer.off('claw:log', handler)
    },
    onStatusChange: (cb: (data: { running: boolean; port?: number }) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on('claw:statusChange', handler)
      return () => ipcRenderer.off('claw:statusChange', handler)
    },
    getToken: () => ipcRenderer.invoke('claw:get-token')
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
    toggleSkillStatus: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:toggleSkillStatus', id, enabled),
    importSkillZip: () => ipcRenderer.invoke('skills:importSkillZip'),
    syncFromRemote: () => ipcRenderer.invoke('skills:syncFromRemote'),
    applyUpdates: (ids: string[]) => ipcRenderer.invoke('skills:applyUpdates', ids),
    getPendingUpdates: () => ipcRenderer.invoke('skills:getPendingUpdates')
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
      ipcRenderer.invoke('channels:installPlugin', pluginPkg)
  },

  // 终端
  terminal: {
    runCommand: (args: string[], runtime?: TerminalRuntime) =>
      ipcRenderer.invoke('term:run', args, runtime),
    startPty: (args: string[], cols: number, rows: number, runtime?: TerminalRuntime) =>
      ipcRenderer.invoke('term:pty-start', args, cols, rows, runtime),
    inputPty: (sid: string, data: string) => ipcRenderer.invoke('term:pty-input', sid, data),
    resizePty: (sid: string, cols: number, rows: number) =>
      ipcRenderer.invoke('term:pty-resize', sid, cols, rows),
    stopPty: (sid: string) => ipcRenderer.invoke('term:pty-stop', sid),
    onPtyChunk: (callback: any) => ipcRenderer.on('term:pty-chunk', (_, data) => callback(data)),
    onPtyExit: (callback: any) => ipcRenderer.on('term:pty-exit', (_, data) => callback(data)),
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

  // ── work 域（3.0，PLAN-3.0.md §14）────────────────────────────────────────
  // 硬规则 3：渲染端不持有 GATEWAY_TOKEN、不直连网关；一律 IPC → Manager → Gateway。
  work: {
    // 流式增量：统一 work:stream:{chunk,done,error}，按 runId 归并（B2）。
    // 渲染端用 composable 订阅并过滤自己的 runId。
    stream: {
      onChunk: (cb: (e: { runId: string; index: number; delta: string }) => void) => {
        const h = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('work:stream:chunk', h)
        return () => ipcRenderer.off('work:stream:chunk', h)
      },
      onDone: (
        cb: (e: { runId: string; chunks: number; text: string | null; aborted: boolean }) => void
      ) => {
        const h = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('work:stream:done', h)
        return () => ipcRenderer.off('work:stream:done', h)
      },
      onError: (cb: (e: { runId: string; error: any }) => void) => {
        const h = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('work:stream:error', h)
        return () => ipcRenderer.off('work:stream:error', h)
      },
      removeAll: () => {
        ipcRenderer.removeAllListeners('work:stream:chunk')
        ipcRenderer.removeAllListeners('work:stream:done')
        ipcRenderer.removeAllListeners('work:stream:error')
      }
    },

    gateway: {
      status: () => call('work:gateway:status'),
      ensureReady: () => call('work:gateway:ensureReady')
    },

    profile: {
      get: () => call('work:profile:get'),
      update: (input) => call('work:profile:update', input)
    },

    matters: {
      list: (params?) => call('work:matters:list', params ?? {}),
      create: (input) => call('work:matters:create', input),
      update: (id: string, patch) => call('work:matters:update', id, patch),
      delete: (id: string) => call('work:matters:delete', id),
      suggestMatter: (recordText: string) => call('work:matters:suggestMatter', recordText)
    },

    todos: {
      list: (params?) => call('work:todos:list', params ?? {}),
      create: (input) => call('work:todos:create', input),
      update: (id: string, patch) => call('work:todos:update', id, patch),
      delete: (id: string) => call('work:todos:delete', id),
      complete: (id: string) => call('work:todos:complete', id),
      uncomplete: (id: string) => call('work:todos:uncomplete', id),
      confirm: (id: string) => call('work:todos:confirm', id),
      ignore: (id: string) => call('work:todos:ignore', id),
      confirmBatch: (ids: string[]) => call('work:todos:confirmBatch', ids),
      ignoreBatch: (ids: string[]) => call('work:todos:ignoreBatch', ids)
    },

    records: {
      list: (params?) => call('work:records:list', params ?? {}),
      get: (id: string) => call('work:records:get', id),
      create: (input) => call('work:records:create', input),
      update: (id: string, patch) => call('work:records:update', id, patch),
      delete: (id: string) => call('work:records:delete', id),
      confirm: (id: string, patch?) => call('work:records:confirm', id, patch ?? {}),
      ignore: (id: string) => call('work:records:ignore', id),
      restore: (id: string) => call('work:records:restore', id),
      confirmBatch: (ids: string[]) => call('work:records:confirmBatch', ids),
      ignoreBatch: (ids: string[]) => call('work:records:ignoreBatch', ids),
      listFiltered: (params?) => call('work:records:listFiltered', params ?? {}),
      proposeCandidate: (input) => call('work:records:proposeCandidate', input)
    },

    context: {
      snapshot: (request: { scope: string; id?: string }) =>
        call('work:context:snapshot', request)
    },

    today: {
      get: (date?: string) => call('work:today:get', date)
    },

    router: {
      route: (input: string) => call('work:router:route', input)
    },

    reports: {
      list: (params?) => call('work:reports:list', params ?? {}),
      get: (id: string) => call('work:reports:get', id),
      aggregate: (params: { type: 'daily' | 'weekly'; period?: string }) =>
        call('work:reports:aggregate', params),
      generate: (params: { type: 'daily' | 'weekly'; period?: string }) =>
        call('work:reports:generate', params),
      abortGenerate: (runId: string) => call('work:reports:abortGenerate', runId),
      saveDraft: (id: string, content: string) => call('work:reports:saveDraft', id, content),
      confirm: (id: string) => call('work:reports:confirm', id),
      regenerate: (id: string) => call('work:reports:regenerate', id),
      versions: (id: string) => call('work:reports:versions', id)
    },

    qa: {
      ask: (params: { question: string; conversationKey?: string }) =>
        call('work:qa:ask', params),
      abortAsk: (runId: string) => call('work:qa:abortAsk', runId)
    },

    tools: {
      list: () => call('work:tools:list'),
      run: (params: { toolId: string; text: string; conversationKey?: string; instruction?: string }) =>
        call('work:tools:run', params),
      abortRun: (runId: string) => call('work:tools:abortRun', runId)
    },

    knowledge: {
      list: (params?: { status?: string; limit?: number }) =>
        call('work:knowledge:list', params ?? {}),
      get: (id: string) => call('work:knowledge:get', id),
      create: (input) => call('work:knowledge:create', input),
      update: (id: string, patch) => call('work:knowledge:update', id, patch),
      delete: (id: string) => call('work:knowledge:delete', id),
      search: (query: string, limit?: number) => call('work:knowledge:search', query, limit),
      import: (input) => call('work:knowledge:import', input)
    },

    wizard: {
      status: () => call('work:wizard:status'),
      grantConsent: () => call('work:wizard:grantConsent'),
      complete: () => call('work:wizard:complete'),
      decide: (decision: string) => call('work:wizard:decide', decision),
      readMapping: () => call('work:wizard:readMapping')
    },

    reminder: {
      setEnabled: (id: 'morning' | 'report', enabled: boolean) =>
        call('work:reminder:setEnabled', id, enabled),
      check: () => call('work:reminder:check')
    }
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore non-contextIsolation fallback
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
