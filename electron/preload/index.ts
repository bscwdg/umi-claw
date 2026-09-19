import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TerminalRuntime } from '../../src/types/terminal'
console.log('✅ preload loaded')
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
    importSkillZip: () => ipcRenderer.invoke('skills:importSkillZip'),
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

  // marketing（Commit 02：system 面；Commit 03：project CRUD + context 切换）
  // 统一返回信封：{ ok: true, data } | { ok: false, error: { code, message, details? } }
  // 渲染端按 error.code 分支，禁止用 error.message.includes() 判断
  marketing: {
    system: {
      dbStatus: (options?: { initialize?: boolean }) =>
        ipcRenderer.invoke('marketing:system:dbStatus', options),
      ping: () => ipcRenderer.invoke('marketing:system:ping'),
      metaGet: (key: string) => ipcRenderer.invoke('marketing:system:metaGet', key),
      metaSet: (key: string, value: string | null) =>
        ipcRenderer.invoke('marketing:system:metaSet', key, value)
    },
    project: {
      list: () => ipcRenderer.invoke('marketing:project:list'),
      get: (projectId: string) => ipcRenderer.invoke('marketing:project:get', projectId),
      create: (input: { name: string; industry?: string | null; description?: string | null }) =>
        ipcRenderer.invoke('marketing:project:create', input),
      update: (
        projectId: string,
        patch: { name?: string; industry?: string | null; description?: string | null }
      ) => ipcRenderer.invoke('marketing:project:update', projectId, patch),
      delete: (projectId: string) => ipcRenderer.invoke('marketing:project:delete', projectId)
    },
    context: {
      getCurrentProject: () => ipcRenderer.invoke('marketing:context:getCurrentProject'),
      setCurrentProject: (projectId: string | null) =>
        ipcRenderer.invoke('marketing:context:setCurrentProject', projectId)
    },
    // Commit 04：Business 与 Project 1:1（无 list/create）；Watchlist 只做手工增删（**不采集**）
    business: {
      get: (projectId: string) => ipcRenderer.invoke('marketing:business:get', projectId),
      upsert: (projectId: string, data: Record<string, string | null>) =>
        ipcRenderer.invoke('marketing:business:upsert', projectId, data),
      delete: (projectId: string) => ipcRenderer.invoke('marketing:business:delete', projectId)
    },
    watchlist: {
      list: (projectId: string) => ipcRenderer.invoke('marketing:watchlist:list', projectId),
      add: (projectId: string, keyword: string, type?: string | null) =>
        ipcRenderer.invoke('marketing:watchlist:add', projectId, keyword, type),
      remove: (projectId: string, keyword: string) =>
        ipcRenderer.invoke('marketing:watchlist:remove', projectId, keyword),
      setEnabled: (projectId: string, keyword: string, enabled: boolean) =>
        ipcRenderer.invoke('marketing:watchlist:setEnabled', projectId, keyword, enabled)
    },
    // Commit 05a：知识库（导入时本地解析一次 → 文本入库、原文留 data/projects/<id>/）
    knowledge: {
      list: (projectId: string, options?: { limit?: number }) =>
        ipcRenderer.invoke('marketing:knowledge:list', projectId, options),
      get: (projectId: string, id: string) =>
        ipcRenderer.invoke('marketing:knowledge:get', projectId, id),
      create: (projectId: string, data: { title: string; type: string; content: string }) =>
        ipcRenderer.invoke('marketing:knowledge:create', projectId, data),
      update: (projectId: string, id: string, patch: { title?: string; content?: string }) =>
        ipcRenderer.invoke('marketing:knowledge:update', projectId, id, patch),
      delete: (projectId: string, id: string) =>
        ipcRenderer.invoke('marketing:knowledge:delete', projectId, id),
      search: (projectId: string, query: string, limit?: number) =>
        ipcRenderer.invoke('marketing:knowledge:search', projectId, query, limit),
      import: (
        projectId: string,
        input: { type: string; title?: string; text?: string; url?: string; filePath?: string }
      ) => ipcRenderer.invoke('marketing:knowledge:import', projectId, input),
      // 本地文件选择器（dialog 在主进程）；用户取消 → data.filePath = null，不是错误
      pickFile: (): Promise<{ ok: true; data: { filePath: string | null } } | { ok: false; error: { code: string; message: string; details?: unknown } }> =>
        ipcRenderer.invoke('marketing:knowledge:pickFile'),
      // Commit 05b：扫描件/资料图 AI 识别兑底（**用户显式触发**；结果人工确认后才入库）。
      // 流式增量沿用 07 的事件名（marketing:gateway:chunk / done / error，streamId=taskId），
      // 复用 advisor 下面的 onChunk/onDone/onError 订阅（全局事件、按 streamId 归并，不另订一套）
      recognize: (
        projectId: string,
        input: { filePath: string; type?: string }
      ): Promise<{
        ok: true
        data: {
          taskId: string
          projectId: string
          kind: 'pdf' | 'image'
          suggestedTitle: string
          images: Array<{ page: number; width: number; height: number; bytes: number; downscaled: boolean }>
        }
      } | { ok: false; error: { code: string; message: string; details?: unknown } }> =>
        ipcRenderer.invoke('marketing:knowledge:recognize', projectId, input),
      // 停止识别；幂等（任务已结束时返回 aborted:false，不报错）。
      // 两路定位（05b 外部复审）：有 taskId 按 taskId；栅格化窗口里还没有 taskId 时按 projectId
      // 中止该商家在途任务（主进程 recognizer 的注册表覆盖整个生命周期）。
      abortRecognize: (taskId?: string | null, projectId?: string | null) =>
        ipcRenderer.invoke('marketing:knowledge:recognize:abort', taskId ?? null, projectId ?? null),
      // 人工确认后入库（硬规则 10：确认弹窗的「确认入库」是唯一写入路径）
      commitRecognized: (
        projectId: string,
        input: { filePath: string; type: string; title?: string | null; content: string }
      ): Promise<{
        ok: true
        data: Record<string, unknown>
      } | { ok: false; error: { code: string; message: string; details?: unknown } }> =>
        ipcRenderer.invoke('marketing:knowledge:commitRecognized', projectId, input)
    },
    // Commit 07：Gateway 只读面（硬规则 13：token 与 HTTP 调用只留主进程，渲染端只拿快照）
    // status      = 只读就绪快照（零 token；只发 GET /health + GET /v1/models）
    // ensureReady = 探活 → 按需自动拉起（复用 clawManager）→ 就绪轮询 → 同一快照
    gateway: {
      status: (): Promise<{
        ok: true
        data: {
          ready: boolean
          port: number
          baseUrl: string
          endpointsEnabled: boolean
          lastError: { code: string; message: string; details?: unknown } | null
        }
      } | { ok: false; error: { code: string; message: string; details?: unknown } }> =>
        ipcRenderer.invoke('marketing:gateway:status'),
      ensureReady: (): Promise<{
        ok: true
        data: {
          ready: boolean
          port: number
          baseUrl: string
          endpointsEnabled: boolean
          lastError: { code: string; message: string; details?: unknown } | null
        }
      } | { ok: false; error: { code: string; message: string; details?: unknown } }> =>
        ipcRenderer.invoke('marketing:gateway:ensureReady')
    },
    // Commit 08：AI Advisor（grounded 问答 + 扩词候选）
    // 流式增量走 07 定死的事件名（marketing:gateway:chunk / done / error，payload 带 streamId），
    // 面板按 streamId 归并自己的流；abort 会真断上游（07 已验证）。
    // 05b 的扫描件识别增量也走这三个事件（streamId=taskId），订阅只订一次。
    advisor: {
      ask: (input: { projectId: string; question: string; platform?: string | null; model?: string | null }) =>
        ipcRenderer.invoke('marketing:advisor:ask', input),
      // 停止生成；幂等（流已结束时返回 aborted:false，不报错）
      abort: (streamId: string) => ipcRenderer.invoke('marketing:advisor:abort', streamId),
      watchCandidates: (projectId: string, options?: { count?: number }) =>
        ipcRenderer.invoke('marketing:advisor:watchCandidates', projectId, options),
      onChunk: (cb: (payload: { streamId: string; index: number; delta: string }) => void) => {
        const handler = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('marketing:gateway:chunk', handler)
        return () => ipcRenderer.off('marketing:gateway:chunk', handler)
      },
      onDone: (
        cb: (payload: { streamId: string; chunks: number; text: string | null; aborted: boolean }) => void
      ) => {
        const handler = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('marketing:gateway:done', handler)
        return () => ipcRenderer.off('marketing:gateway:done', handler)
      },
      onError: (cb: (payload: { streamId: string; error: { code: string; message: string; details?: unknown } }) => void) => {
        const handler = (_: unknown, data: any) => cb(data)
        ipcRenderer.on('marketing:gateway:error', handler)
        return () => ipcRenderer.off('marketing:gateway:error', handler)
      }
    },
    // Commit 09：Content Center（一次生成 3 版供选 → 编辑 → 版本 → 人工审核/发布标记）。
    // 流式增量同样走 07 事件名（streamId=`<genTaskId>-<角度key>`），订阅复用 advisor 的
    // onChunk/onDone/onError（全局事件按 streamId 归并，三路不串台）。
    content: {
      list: (projectId: string, options?: { status?: string | null; platform?: string | null; limit?: number }) =>
        ipcRenderer.invoke('marketing:content:list', projectId, options),
      get: (projectId: string, id: string) => ipcRenderer.invoke('marketing:content:get', projectId, id),
      create: (
        projectId: string,
        data: { title?: string | null; platform?: string | null; topic?: string | null; content?: string | null; sourceTopicId?: string | null }
      ) => ipcRenderer.invoke('marketing:content:create', projectId, data),
      update: (
        projectId: string,
        id: string,
        patch: {
          title?: string | null
          platform?: string | null
          topic?: string | null
          content?: string | null
          status?: string
          published_at?: number | null
          effect_note?: string | null
        }
      ) => ipcRenderer.invoke('marketing:content:update', projectId, id, patch),
      // §五 扩面：delete（幂等；版本随 FK 级联清）
      delete: (projectId: string, id: string) => ipcRenderer.invoke('marketing:content:delete', projectId, id),
      // 一次生成 3 版供选（三路并行流式；硬规则 10：产出一律人工采纳，永不自动发）
      generate: (
        projectId: string,
        spec: { contentId?: string | null; platform: string; topic?: string | null; title?: string | null; customer?: string | null; sourceTopicId?: string | null; query?: string | null }
      ) => ipcRenderer.invoke('marketing:content:generate', projectId, spec),
      // 停止生成：两路定位（同 05b 口径）；幂等
      abortGenerate: (genTaskId?: string | null, projectId?: string | null) =>
        ipcRenderer.invoke('marketing:content:generate:abort', genTaskId ?? null, projectId ?? null),
      saveVersion: (
        projectId: string,
        id: string,
        input: { content: string; source?: string; prompt?: string | null },
        options?: { activate?: boolean }
      ) => ipcRenderer.invoke('marketing:content:saveVersion', projectId, id, input, options),
      // §五 扩面：版本清单（历史面板）
      versions: (projectId: string, id: string) => ipcRenderer.invoke('marketing:content:versions', projectId, id)
    },
    // Commit 11：热点雷达。list 打开页看时间差决定是否立即采集（force 强制）；
    // Commit 12：score 懒评分（按批续评，force=手动重新分析）。
    hot: {
      list: (projectId: string, options?: { platform?: string | null; force?: boolean; skipCollect?: boolean; windowHours?: number }) =>
        ipcRenderer.invoke('marketing:hot:list', projectId, options),
      get: (topicId: string) => ipcRenderer.invoke('marketing:hot:get', topicId),
      refresh: () => ipcRenderer.invoke('marketing:hot:refresh'),
      score: (projectId: string, platform: string, options?: { force?: boolean }) =>
        ipcRenderer.invoke('marketing:hot:score', projectId, platform, options)
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
