import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
console.log('✅ preload loaded')
// 完整类型化的 API
const api = {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
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
    onStatusChange: (cb: (data: { running: boolean; port?: number }) => void) => {
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
      ipcRenderer.invoke('config:getPresetModels', configName)
  },

  // 环境
  env: {
    check: () => ipcRenderer.invoke('env:check'),
    init: (options?: any) => ipcRenderer.invoke('env:init', options),
    update: (options?: any) => ipcRenderer.invoke('env:update', options),
    checkLatest: (options?: any) => ipcRenderer.invoke('env:checkLatest', options),
    getInfo: () => ipcRenderer.invoke('env:getInfo'),
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
    importSkillZip: () => ipcRenderer.invoke('skills:importSkillZip'),
  },

  // 工具
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },

  dialog: {
    showMessage: (options: any) => ipcRenderer.invoke('dialog:showMessage', options)
  },
  // 渠道
  channels: {
   
  },
  // 终端
  terminal: {
    runCommand: (args: string[]) => ipcRenderer.invoke('term:run', args),
    startPty: (args: string[], cols: number, rows: number) => ipcRenderer.invoke('term:pty-start', args, cols, rows),
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
