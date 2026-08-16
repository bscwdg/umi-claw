import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { EventEmitter } from 'events'
import { ConfigManager } from '../configManager'
import { openClawPaths } from '../openClawPaths'
import { EMBEDDING_PRESETS } from '../modelConfig'
import type { ObsidianConfig, ObsidianIndexStatus, ObsidianIndexProgress, ObsidianSearchHit, EmbeddingAdapter } from './types'

const DEFAULT_OBSIDIAN_CONFIG: ObsidianConfig = {
  enabled: false,
  vaultPath: '',
  embeddingSource: 'preset',
  embeddingProviderId: '',
  embeddingModel: '',
  embeddingAdapter: 'openai',
  chunkSize: 800,
  maxChunksPerNote: 50
}

/**
 * Obsidian 知识库集成主进程管理器。
 * - 持有用户配置（vault 路径、embedding 源）
 * - 触发 indexer 子进程重建索引，转发进度事件
 * - 生成 openclaw.json 的 mcp.servers.obsidian 片段（供 configManager 注入）
 * - 测试 embedding 连通、查询索引状态
 *
 * 子进程脚本（indexer.mjs / mcp-server.mjs）位于 resources/obsidian/，
 * 由 dataDir 的绿色 node 拉起，零原生依赖，复用 node:sqlite。
 */
export class ObsidianManager extends EventEmitter {
  private configManager: ConfigManager
  private indexing = false
  private lastError: string | null = null
  private currentProc: import('child_process').ChildProcess | null = null

  constructor(configManager: ConfigManager) {
    super()
    this.configManager = configManager
  }

  private get dataDir(): string {
    return this.configManager.getDataDir()
  }

  /** 资源目录下的 .mjs 脚本绝对路径（dev: 项目根/resources；pack: resourcesPath/resources） */
  private getScriptPath(name: string): string {
    const isDev = !app.isPackaged
    const resRoot = isDev ? join(app.getAppPath(), 'resources') : join(process.resourcesPath, 'resources')
    return join(resRoot, 'obsidian', name)
  }

  getObsidianConfig(): ObsidianConfig {
    const cfg = (this.configManager.getConfig() as any).obsidian
    return { ...DEFAULT_OBSIDIAN_CONFIG, ...(cfg || {}) }
  }

  saveObsidianConfig(cfg: ObsidianConfig): ObsidianConfig {
    this.configManager.saveConfig({ obsidian: cfg } as any)
    return this.getObsidianConfig()
  }

  async selectVault(): Promise<{ path: string; warning?: string } | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择 Obsidian Vault 目录'
    })
    if (result.canceled || !result.filePaths.length) return null
    const path = result.filePaths[0]
    // Obsidian vault 根目录通常含 .obsidian/ 配置目录；缺失时给提示但不阻止
    // （用户也可能是把普通 markdown 目录当知识库用）
    let warning: string | undefined
    if (!existsSync(join(path, '.obsidian'))) {
      warning = '该目录未检测到 .obsidian 配置（可能不是 Obsidian vault），仍可继续'
    }
    return { path, warning }
  }

  /**
   * 从当前配置解析 embedding 凭据 + adapter。
   * - preset 模式：从选定 provider 取 baseUrl/apiKey，adapter 来自对应预设
   * - custom 模式：直接用 customEmbedding 字段，不依赖任何 provider
   */
  private resolveEmbedding(cfg: ObsidianConfig) {
    if (cfg.embeddingSource === 'custom' && cfg.customEmbedding) {
      const c = cfg.customEmbedding
      return { baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, adapter: c.adapter || 'openai' }
    }
    const provider = this.configManager.getConfig().providers.find((p) => p.id === cfg.embeddingProviderId)
    // 从预设里取 adapter，找不到默认 openai
    const preset = EMBEDDING_PRESETS.find(
      (p) => p.providerId === cfg.embeddingProviderId && p.modelId === cfg.embeddingModel
    )
    return {
      baseUrl: provider?.baseUrl || '',
      apiKey: provider?.apiKey || '',
      model: cfg.embeddingModel || '',
      adapter: (preset?.adapter as EmbeddingAdapter) || 'openai'
    }
  }

  /** 生成 openclaw.json 的 mcp.servers.obsidian 片段；未启用或未配 vault 返回 null */
  buildMcpServerConfig(): Record<string, unknown> | null {
    const cfg = this.getObsidianConfig()
    if (!cfg.enabled || !cfg.vaultPath) return null
    const nodePath = this.configManager.getNodePath()
    const mcpScript = this.getScriptPath('mcp-server.mjs')
    const dbPath = openClawPaths.obsidianDb(this.dataDir)
    const emb = this.resolveEmbedding(cfg)
    return {
      command: nodePath,
      args: [mcpScript, '--vault', cfg.vaultPath, '--db', dbPath],
      env: {
        OBS_EMBEDDING_BASE_URL: emb.baseUrl,
        OBS_EMBEDDING_API_KEY: emb.apiKey,
        OBS_EMBEDDING_MODEL: emb.model,
        OBS_EMBEDDING_ADAPTER: emb.adapter
      }
    }
  }

  /** 测试 embedding 连通，返回向量维度。支持 preset/providerId 与 custom 两种入参形态 */
  async testEmbedding(arg: { providerId: string; model: string } | { baseUrl: string; apiKey: string; model: string; adapter: EmbeddingAdapter }): Promise<{ dim: number }> {
    let base: string, apiKey: string, model: string, adapter: EmbeddingAdapter = 'openai'
    if ('providerId' in arg) {
      const provider = this.configManager.getConfig().providers.find((p) => p.id === arg.providerId)
      if (!provider) throw new Error('未找到该服务商')
      if (!provider.apiKey) throw new Error('该服务商未配置 API Key')
      base = (provider.baseUrl || '').replace(/\/$/, '')
      apiKey = provider.apiKey
      model = arg.model
      const preset = EMBEDDING_PRESETS.find((p) => p.providerId === arg.providerId && p.modelId === arg.model)
      adapter = (preset?.adapter as EmbeddingAdapter) || 'openai'
    } else {
      base = (arg.baseUrl || '').replace(/\/$/, '')
      apiKey = arg.apiKey
      model = arg.model
      adapter = arg.adapter || 'openai'
    }

    // 用与 indexer 相同的路径调一次，维度从响应取
    const endpoint = adapter === 'cohere' ? `${base}/embed` : `${base}/embeddings`
    const body = adapter === 'cohere'
      ? JSON.stringify({ texts: ['测试'], model, input_type: 'search_document', embedding_types: ['float'] })
      : JSON.stringify({ model, input: ['测试'] })
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json: any = await res.json()
    const dim = adapter === 'cohere'
      ? json?.embeddings?.[0]?.length
      : json?.data?.[0]?.embedding?.length
    if (!dim) throw new Error('返回结构异常：未取到向量')
    return { dim }
  }

  /**
   * 检索测试：spawn search.mjs（零依赖绿色 node 子进程），与 mcp-server 的
   * search_notes 同一条链路（embedOne + searchTopK）。供前端测试面板调用，
   * 无需重启 OpenClaw 即可验证索引效果。
   */
  async testSearch(arg: { query: string; limit?: number; tag?: string }): Promise<{ hits: ObsidianSearchHit[]; tookMs: number }> {
    const query = (arg.query || '').trim()
    if (!query) throw new Error('请输入检索内容')

    const dbPath = openClawPaths.obsidianDb(this.dataDir)
    if (!existsSync(dbPath)) throw new Error('尚未建立索引，请先点击「重建索引」')

    const nodePath = this.configManager.getNodePath()
    if (!existsSync(nodePath)) throw new Error('未找到 Node.js 运行时，请先初始化环境')

    const emb = this.resolveEmbedding(this.getObsidianConfig())
    if (!emb.baseUrl || !emb.apiKey || !emb.model) {
      throw new Error('未配置 embedding 凭据，请先选择/填写 embedding 模型并保存配置')
    }

    const script = this.getScriptPath('search.mjs')
    // 与 rebuildIndex 一致：只透传必要变量（含 Windows 硬依赖），不继承主进程全部 env
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      OBS_EMBEDDING_BASE_URL: emb.baseUrl,
      OBS_EMBEDDING_API_KEY: emb.apiKey,
      OBS_EMBEDDING_MODEL: emb.model,
      OBS_EMBEDDING_ADAPTER: emb.adapter
    }
    const limit = Math.max(1, Math.min(arg.limit || 5, 20))
    const spawnArgs = [script, '--db', dbPath, '--query', query, '--limit', String(limit)]
    const tag = (arg.tag || '').trim()
    if (tag) spawnArgs.push('--tag', tag)

    return new Promise((resolve, reject) => {
      const proc = spawn(nodePath, spawnArgs, { env, windowsHide: true, shell: false })
      let stdout = ''
      let stderr = ''
      proc.stdout.setEncoding('utf-8')
      proc.stdout.on('data', (d: string) => { stdout += d })
      proc.stderr.setEncoding('utf-8')
      proc.stderr.on('data', (d: string) => { stderr += d })
      proc.on('exit', (code) => {
        // search.mjs 保证结果/错误都以单行 JSON 输出；从后往前找第一条可解析的
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const r = JSON.parse(lines[i])
            if (r && typeof r === 'object') {
              if (r.ok) resolve({ hits: r.hits || [], tookMs: r.tookMs || 0 })
              else reject(new Error(r.error || '检索失败'))
              return
            }
          } catch { /* 跳过非 JSON 行 */ }
        }
        reject(new Error(stderr.trim().slice(0, 300) || `检索进程退出码 ${code}`))
      })
      proc.on('error', (err) => reject(err))
    })
  }

  /** 取消正在进行的索引 */
  async cancelIndex(): Promise<{ success: boolean }> {
    if (this.currentProc && this.indexing) {
      try {
        this.currentProc.kill()
      } catch { /* 忽略 */ }
      this.currentProc = null
      this.indexing = false
      this.lastError = '索引已取消'
      this.emit('progress', { phase: 'error', message: '索引已取消' } as ObsidianIndexProgress)
    }
    return { success: true }
  }

  /**
   * 当前生效 embedding 的签名：source + model + adapter。
   * 写入 status.json 供下次 rebuildIndex 判断是否换过模型（签名变了必须清库，
   * 否则新旧维度向量混存，cosine 检索产生 NaN/维度不匹配）。
   */
  private embeddingSignature(cfg: ObsidianConfig): string {
    if (cfg.embeddingSource === 'custom') {
      const c = cfg.customEmbedding
      return `custom|${c?.model || ''}|${c?.adapter || 'openai'}`
    }
    return `preset|${cfg.embeddingModel || ''}|${cfg.embeddingAdapter || 'openai'}`
  }

  /** 触发重建索引（spawn indexer.mjs，零依赖子进程） */
  async rebuildIndex(): Promise<{ success: boolean; error?: string }> {
    const cfg = this.getObsidianConfig()
    if (!cfg.vaultPath) throw new Error('未配置 vault 路径')
    if (this.indexing) throw new Error('索引进行中，请稍候')

    // 切换 embedding 模型/adapter 时必须清库：维度变化会导致旧向量与新向量混存，
    // cosine 检索时维度不匹配产生 NaN 污染 top-K。
    // 用 source+model+adapter 组合签名判断（同 model 不同 adapter 也算不一致）。
    const prev = this.getIndexStatus()
    const prevSig = prev.embeddingSignature
    const curSig = this.embeddingSignature(cfg)
    if (prevSig && prevSig !== curSig) {
      try { unlinkSync(openClawPaths.obsidianDb(this.dataDir)) } catch { /* 忽略不存在 */ }
      try { unlinkSync(join(openClawPaths.obsidianDir(this.dataDir), 'status.json')) } catch { /* 忽略 */ }
      this.lastError = null
    }

    this.indexing = true
    this.lastError = null

    const nodePath = this.configManager.getNodePath()
    if (!existsSync(nodePath)) {
      this.indexing = false
      throw new Error('未找到 Node.js 运行时，请先初始化环境')
    }
    const indexerScript = this.getScriptPath('indexer.mjs')
    const dbPath = openClawPaths.obsidianDb(this.dataDir)
    mkdirSync(openClawPaths.obsidianDir(this.dataDir), { recursive: true })

    const emb = this.resolveEmbedding(cfg)
    // 只透传子进程需要的环境变量，不继承 Electron 主进程的全部 env，
    // 避免用户的 OPENAI_API_KEY / ANTHROPIC_API_KEY 等敏感变量泄漏到子进程。
    // SYSTEMROOT/SYSTEMDRIVE/TEMP/TMP 是 Windows 上 node 网络/加密/临时文件的
    // 硬依赖（缺 SYSTEMROOT 可能导致 fetch 报错），必须一并带上。
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      OBS_EMBEDDING_BASE_URL: emb.baseUrl,
      OBS_EMBEDDING_API_KEY: emb.apiKey,
      OBS_EMBEDDING_MODEL: emb.model,
      OBS_EMBEDDING_ADAPTER: emb.adapter
    }

    return new Promise((resolve) => {
      const proc = spawn(nodePath, [
        indexerScript, '--vault', cfg.vaultPath, '--db', dbPath,
        '--chunk-size', String(cfg.chunkSize || 800),
        '--max-chunks', String(cfg.maxChunksPerNote || 50)
      ], { env, windowsHide: true, shell: false })
      this.currentProc = proc

      let buf = ''
      proc.stdout.setEncoding('utf-8')
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            this.handleIndexerMessage(JSON.parse(line))
          } catch { /* 忽略非 JSON 行 */ }
        }
      })
      proc.stderr.on('data', (d: Buffer) => {
        console.log('[indexer]', d.toString().trim())
      })
      proc.on('exit', (code) => {
        // 只在退出的是当前进程时清状态，避免「取消后立刻重建」时
        // 旧进程的 exit 回调把新进程的 indexing 状态打回 false。
        if (this.currentProc === proc) {
          this.indexing = false
          this.currentProc = null
        }
        if (code === 0) resolve({ success: true })
        else resolve({ success: false, error: this.lastError || `索引进程退出码 ${code}` })
      })
      proc.on('error', (err) => {
        if (this.currentProc === proc) {
          this.indexing = false
          this.currentProc = null
        }
        this.lastError = err.message
        resolve({ success: false, error: err.message })
      })
    })
  }

  private handleIndexerMessage(msg: any): void {
    if (msg.type === 'progress') {
      this.emit('progress', {
        phase: msg.phase, processed: msg.processed, total: msg.total, message: msg.message
      } as ObsidianIndexProgress)
    } else if (msg.type === 'done') {
      this.writeStatus({
        noteCount: msg.noteCount,
        chunkCount: msg.chunkCount,
        embeddingDim: msg.embeddingDim,
        truncated: msg.truncated || [],
        embedErrors: Array.isArray(msg.embedErrors) ? msg.embedErrors : []
      })
      const truncNote = (msg.truncated && msg.truncated.length)
        ? `，${msg.truncated.length} 篇超长被截断`
        : ''
      this.emit('progress', {
        phase: 'done',
        message: `完成：${msg.noteCount} 篇笔记，${msg.chunkCount} 个文本块${truncNote}`
      } as ObsidianIndexProgress)
    } else if (msg.type === 'error') {
      this.lastError = msg.message
      this.emit('progress', { phase: 'error', message: msg.message } as ObsidianIndexProgress)
    }
  }

  private writeStatus(data: { noteCount: number; chunkCount: number; embeddingDim: number | null; truncated: string[]; embedErrors?: Array<{ file: string; error: string }> }): void {
    const dir = openClawPaths.obsidianDir(this.dataDir)
    mkdirSync(dir, { recursive: true })
    const cfg = this.getObsidianConfig()
    const status = {
      noteCount: data.noteCount,
      chunkCount: data.chunkCount,
      lastIndexedAt: Date.now(),
      embeddingModel: cfg.embeddingModel || null,
      embeddingSignature: this.embeddingSignature(cfg),
      embeddingDim: data.embeddingDim || null,
      vaultPath: cfg.vaultPath || null,
      truncatedFiles: data.truncated || [],
      embedErrors: data.embedErrors || []
    }
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf-8')
  }

  getIndexStatus(): ObsidianIndexStatus {
    const statusFile = join(openClawPaths.obsidianDir(this.dataDir), 'status.json')
    let saved: any = {}
    try { saved = JSON.parse(readFileSync(statusFile, 'utf-8')) } catch { /* 未索引过 */ }
    const dbPath = openClawPaths.obsidianDb(this.dataDir)
    let dbSize = 0
    try { dbSize = statSync(dbPath).size } catch { /* 库不存在 */ }
    return {
      indexing: this.indexing,
      noteCount: saved.noteCount || 0,
      chunkCount: saved.chunkCount || 0,
      lastIndexedAt: saved.lastIndexedAt || null,
      dbSizeBytes: dbSize,
      embeddingModel: saved.embeddingModel || null,
      embeddingSignature: saved.embeddingSignature || null,
      embeddingDim: saved.embeddingDim || null,
      vaultPath: saved.vaultPath || null,
      lastError: this.lastError,
      truncatedFiles: Array.isArray(saved.truncatedFiles) ? saved.truncatedFiles : [],
      embedErrors: Array.isArray(saved.embedErrors) ? saved.embedErrors : []
    }
  }
}
