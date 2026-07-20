import { app,dialog } from 'electron'
import { join, dirname ,basename} from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, renameSync } from 'fs'
import AdmZip from 'adm-zip'
import { OFFICIAL_MODEL_PRESETS, toOpenClawProviderKey, pruneReservedOpenClawProviderRefs, isReservedOpenClawProviderKey } from './modelConfig'
import { GATEWAY_TOKEN, openClawPaths } from './openClawPaths'

export interface PresetModel {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  compat?: Record<string, any>
  [key: string]: any
}

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean,
  configName: string,
  customModels?: PresetModel[]
}

export interface AppConfig {
  activeProvider: string
  providers: ModelProvider[]
  port: number
  autoStart: boolean
  launchOnBoot: boolean
  minimizeToTray: boolean
  closeAction: 'ask' | 'tray' | 'exit'
  useChineseMirror: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  language: 'zh-CN' | 'en-US'
  theme: string
  themeBase?: string
  themeAccent?: string
  channels?: Record<string, Record<string, unknown>>
}

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4-flash',
    enabled: true,
    configName: 'DEEPSEEK_DEFAULT_PROVIDERS',
  },
  {
    id: 'volcengine', //
    name: '豆包 (字节跳动)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    model: 'doubao-seed-evolving', // 🔧 修正：原 doubao-seed-evolving 已失效
    enabled: false,
    configName: 'DOUBAO_ARK_PROVIDERS',
  },
  {
    id: 'volcengine-agent-plan',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: '',
    model: 'ark-code-latest',
    enabled: false,
    configName: 'VOLCENGINE_DEFAULT_PROVIDERS',
  },
  {
    id: 'bailian', // ✅ 保持原样，不改为 qwen
    name: '通义千问 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen3.7-max',
    enabled: false,
    configName: 'QWEN_DASHSCOPE_PROVIDERS',
  },
  {
    id: 'bailian-token-plan',
    name: '千问百炼 (阿里云)',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    apiKey: '',
    model: 'qwen3.7-max',
    enabled: false,
    configName: 'QWEN_BAILIAN_DEFAULT_PROVIDERS',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-5.2', // 🔧 修正：原 glm-4-flash 已下线，换为最新旗舰 5.2
    enabled: false,
    configName: 'ZHIPU_DEFAULT_PROVIDERS',
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'kimi-k2.6', // 🔧 修正：原 moonshot-v1-8k 已弃用，换为 k2.6
    enabled: false,
    configName: 'KIMI_DEFAULT_PROVIDERS',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: '',
    model: 'MiniMax-M3', // 🔧 修正：原 abab6.5s-chat 已退役，换为 M3（1M/多模态）
    enabled: false,
    configName: 'MINIMAX_DEFAULT_PROVIDERS',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'deepseek-ai/DeepSeek-V4', // 🔧 建议优化：原 Qwen2.5 过旧，换为热门 DeepSeek V4
    enabled: false,
    configName: 'SILICONFLOW_DEFAULT_PROVIDERS',
  },
  {
    id: 'longCat',
    name: '美团',
    baseUrl: 'https://api.longcat.chat/openai', 
    apiKey: '',
    model: 'LongCat-2.0',
    enabled: false,
    configName: 'LONGCAT_DEFAULT_PROVIDERS',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    enabled: false,
    configName: 'OPENAI_DEFAULT_PROVIDERS',
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com', // 🔧 修正：去掉 /v1，官方标准 BaseUrl 不带
    apiKey: '',
    model: 'claude-sonnet-4-6',
    enabled: false,
    configName: 'ANTHROPIC_DEFAULT_PROVIDERS',
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: 'llama3',
    enabled: false,
    configName: 'CUSTOM_DEFAULT_PROVIDERS',
  },
];

// 使用深拷贝函数确保默认配置不会被意外修改
const getDeepCopyDefaultConfig = (): AppConfig => ({
  activeProvider: 'deepseek',
  providers: DEFAULT_PROVIDERS.map(p => ({ ...p })),
  port: 3213,
  autoStart: false,
  launchOnBoot: false,
  minimizeToTray: true,
  closeAction: 'ask',
  useChineseMirror: true,
  logLevel: 'info',
  language: 'zh-CN',
  theme: 'dark'
})

const DEFAULT_CONFIG = getDeepCopyDefaultConfig()

export class ConfigManager {
  private dataDir: string
  private configPath: string
  private config: AppConfig
  private openClawConfigPath: string
  private portableSkillsDir: string

  constructor() {
    // 确定数据目录
    if (app.isPackaged) {
      // 生产环境：exe 同级目录下的 data 文件夹
      const exePath = app.getPath('exe')
      this.dataDir = join(dirname(exePath), 'data')
    } else {
      // 开发环境：项目根目录下的 data 文件夹
      this.dataDir = join(process.cwd(), 'data')
    }

    // 设置配置文件路径
    this.configPath = join(this.dataDir, 'config', 'app.json')
    this.openClawConfigPath = openClawPaths.openClawConfig(this.dataDir)
    this.portableSkillsDir = openClawPaths.portableSkillsDir(this.dataDir)
    // 初始化目录结构
    this._ensureDirectories()


    // 加载配置
    this.config = this._load()

    // 初始同步 OpenClaw 配置
    this._syncOpenClawConfig()
  }

  /**
   * 获取当前配置的深拷贝，防止外部修改内部状态
   */
  getConfig(): AppConfig {
    return JSON.parse(JSON.stringify(this.config))
  }

  /**
   * 保存部分配置更新
   * @param partial 部分配置对象
   * @returns 更新后的完整配置
   */
  saveConfig(partial: Partial<AppConfig>): AppConfig {
    // 1. 深度合并基础字段
    this.config = {
      ...this.config,
      ...partial,
      // 2. 安全深拷贝处理 providers
      providers: partial.providers
        ? partial.providers.map(p => ({ ...p }))
        : this.config.providers
    }

    // 3. 必须恢复 app.json 本身的持久化写入
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      console.error('[ConfigManager] 保存 app.json 失败:', err)
    }

    // 4. 同步衍生配置
    this._syncOpenClawConfig()

    return this.getConfig()
  }

  /**
   * 重置配置为默认值
   */
  resetConfig(): AppConfig {
    this.config = getDeepCopyDefaultConfig()
    // this._persist()
    this._syncOpenClawConfig()
    return this.getConfig()
  }

  getDataDir(): string {
    return this.dataDir
  }

  /**
   * 同步 openclaw.json，供启动流程在 spawn 前调用，确保凭证/模型/渠道是最新的。
   * 内部等价于 _syncOpenClawConfig，对外暴露一个稳定入口，避免 clawManager 重复实现。
   */
  syncOpenClawConfig(): void {
    this._syncOpenClawConfig()
  }

  /**
   * 读取 modelConfig.ts 中某个服务商的官方预设模型列表
   * @param configName 例如 'DEEPSEEK_DEFAULT_PROVIDERS'
   * @returns 模型数组 [{ id, name, contextWindow, maxTokens, input, reasoning }]
   */
  getPresetModels(configName: string): Array<Record<string, any>> {
    const preset = OFFICIAL_MODEL_PRESETS[configName]
    if (!preset || !Array.isArray(preset.models)) {
      return []
    }
    return JSON.parse(JSON.stringify(preset.models))
  }

  getNodePath(): string {
    const platform = process.platform
    const arch = process.arch
    const nodeDir = join(this.dataDir, 'runtime', `node-${platform}-${arch}`)
    if (platform === 'win32') {
      return join(nodeDir, 'node.exe')
    }
    return join(nodeDir, 'bin', 'node')
  }

  /**
   * 安全读取并解析 openclaw.json；文件不存在或解析失败时返回传入的兜底对象
   * @param fallback 读取失败时返回的兜底配置
   * @param onError 解析失败时的可选日志回调
   */
  /**
   * Read and parse openclaw.json, tolerating a UTF-8 BOM prefix.
   * Some editors (e.g. Windows Notepad) or external writers may prepend a BOM,
   * which makes JSON.parse throw "Unexpected token". Strip it defensively.
   */
  private _parseOpenClawJsonRaw(): any {
    let text = readFileSync(this.openClawConfigPath, 'utf-8')
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1)
    }
    return JSON.parse(text)
  }
  private _readOpenClawConfig(fallback: any, onError?: (e: unknown) => void): any {
    if (!existsSync(this.openClawConfigPath)) {
      return fallback
    }
    try {
      const parsed = this._parseOpenClawJsonRaw()
      if (parsed && typeof parsed === 'object') {
        return parsed
      }
    } catch (e) {
      onError?.(e)
    }
    return fallback
  }

  /**
   * 从 SKILL.md 的 YAML Front Matter 中解析指定字段
   * 支持 name: xxx、name: "xxx"、name: 'xxx' 三种写法
   * @returns 解析到的值（已 trim），未匹配到返回 undefined
   */
  private _parseFrontMatterField(content: string, field: string): string | undefined {
    const match = content.match(new RegExp(`${field}:\\s*["']?(.*?)["']?(\\r?\\n|$)`))
    return match && match[1] ? match[1].trim() : undefined
  }

  /**
   * Atomically write text to a path: write to a temp file then rename over the target.
   * Prevents readers from seeing a half-written file and reduces multi-writer races.
   */
  private _atomicWriteFileSync(targetPath: string, content: string): void {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmpPath, content, 'utf-8')
    try {
      renameSync(tmpPath, targetPath)
    } catch (renameErr) {
      // 某些文件系统（exFAT/FAT32 等）对「rename 覆盖已存在文件」支持不佳，回退为直接写目标文件。
      // 回退写入成功即视为整体成功——不再抛出 rename 错误，否则调用方会误判「同步失败」而文件其实已落盘。
      try {
        writeFileSync(targetPath, content, 'utf-8')
      } finally {
        try { if (existsSync(tmpPath)) { renameSync(tmpPath, `${tmpPath}.stale`) } } catch { /* ignore */ }
      }
    }
  }

  /**
   * 确保所有必要的目录存在
   */
  private _ensureDirectories(): void {
    const dirs = [
      this.dataDir,
      join(this.dataDir, 'config'),
      openClawPaths.configDir(this.dataDir),
      this.portableSkillsDir,
      join(this.dataDir, 'logs')
    ]

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true })
        } catch (err) {
          console.error(`[ConfigManager] 创建目录失败: ${dir}`, err)
          // 如果关键目录创建失败，可能需要抛出错误或采取降级策略
          throw new Error(`Failed to create directory: ${dir}`)
        }
      }
    }
  }

  /**
   * 加载配置
   */
  private _load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8')
        const saved = JSON.parse(raw) as Partial<AppConfig>

        // 验证基本结构，防止损坏的 JSON 导致崩溃
        if (!saved || typeof saved !== 'object') {
          throw new Error('Invalid config format')
        }

        // 合并默认值
        // 优化：增加对 saved.providers 元素的类型检查，防止脏数据导致崩溃
        const savedProviders = Array.isArray(saved.providers) ? saved.providers : []

        const mergedProviders = DEFAULT_PROVIDERS.map((def) => {
          const saved_p = savedProviders.find((p: any) => p && typeof p === 'object' && p.id === def.id)
          // 如果找到保存的配置且是对象，则合并，否则使用默认值
          return saved_p ? { ...def, ...saved_p } : def
        })
        return {
          ...DEFAULT_CONFIG,
          ...saved,
          providers: mergedProviders
        }
      }
    } catch (err) {
      console.warn('[ConfigManager] 加载配置失败，使用默认配置', err)
      // 备份损坏的文件以便调试
      try {
        const backupPath = `${this.configPath}.bak.${Date.now()}`
        if (existsSync(this.configPath)) {
          // 修复：使用导入的 copyFileSync 而不是动态 require
          copyFileSync(this.configPath, backupPath)
          console.log(`[ConfigManager] 已备份损坏的配置文件至: ${backupPath}`)
        }
      } catch (e) {
        // 忽略备份失败
        console.error('[ConfigManager] 备份配置文件失败', e)
      }
    }

    // 返回全新的默认配置副本
    return getDeepCopyDefaultConfig()
  }

  /**
   * 同步更新 OpenClaw 配置 (利用 mainConfig 里的官方标准模板完美对齐 Zod 结构)
   */
private _syncOpenClawConfig(): void {
  try {
    const workspacePath = join(openClawPaths.configDir(this.dataDir), 'workspace')

    let existingConfig: any = {
      agents: { defaults: {} },
      gateway: { mode: "local", auth: { mode: "token", token: GATEWAY_TOKEN } },
      channels: {},
      plugins: { entries: { "openclaw-weixin": { "enabled": true } } },
      skills: { entries: {} },
      wizard: {
        "lastRunAt": new Date().toISOString(),
        "lastRunVersion": "2026.6.8",
        "lastRunCommand": "doctor",
        "lastRunMode": "local"
      }
    }

    // 读取已有 openclaw.json：只读一次并复用解析结果，避免「守卫读一遍、兜底再读一遍」之间的
    // TOCTOU 窗口——若文件在两次读之间被截断，守卫通过而兜底返回骨架，反而会用骨架覆盖真实配置
    // （正是守卫想防的 clobber）。
    let parsedExisting: any = null
    if (existsSync(this.openClawConfigPath)) {
      try {
        parsedExisting = this._parseOpenClawJsonRaw()
        if (!parsedExisting || typeof parsedExisting !== 'object') parsedExisting = null
      } catch (parseErr) {
        console.error('[ConfigManager] openclaw.json parse failed; skip sync to avoid overwriting config with skeleton', parseErr)
        return
      }
    }
    existingConfig = parsedExisting || existingConfig

    // ----- 保证基础骨架存在 -----
    existingConfig.agents = existingConfig.agents || {}
    existingConfig.agents.defaults = existingConfig.agents.defaults || {}
    existingConfig.agents.defaults.workspace = workspacePath
    existingConfig.agents.defaults.models = existingConfig.agents.defaults.models || {}

    existingConfig.gateway = existingConfig.gateway || {}
    existingConfig.gateway.mode = "local"
    existingConfig.gateway.auth = existingConfig.gateway.auth || {}
    existingConfig.gateway.auth = {
      ...existingConfig.gateway.auth,
      mode: "token",
      token: GATEWAY_TOKEN
    }

    existingConfig.models = existingConfig.models || {}
    existingConfig.models.mode = "merge"
    existingConfig.models.providers = existingConfig.models.providers || {}

    existingConfig.skills = existingConfig.skills || {}
    existingConfig.skills.entries = existingConfig.skills.entries || {}

    // ----- 🔥 核心改动：遍历 providers，使用 configName 从 OFFICIAL_MODEL_PRESETS 获取配置 -----
    const allProviders = this.config.providers || []
    for (const p of allProviders) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        continue
      }

      // 直接用 configName 作为键（例如 'DEEPSEEK_DEFAULT_PROVIDERS'）获取预设
      const providerConfig = OFFICIAL_MODEL_PRESETS[p.configName]
      if (providerConfig) {
        const officialBody = JSON.parse(JSON.stringify(providerConfig)) // 深拷贝
        // 覆盖用户自定义的 baseUrl 和 apiKey
        officialBody.baseUrl = p.baseUrl || officialBody.baseUrl
        officialBody.apiKey = p.apiKey
        officialBody.api = officialBody.api || "openai-completions"
        // 合并用户自定义模型（去重，自定义覆盖同 id 预设）
        if (Array.isArray(p.customModels) && p.customModels.length) {
          const baseModels = Array.isArray(officialBody.models) ? officialBody.models : []
          const merged = [...baseModels]
          for (const rawCm of p.customModels) {
            if (!rawCm || !rawCm.id) continue
            // OpenClaw model schema 规范化：name 缺失/空白则用 id 兜底；
            // input/contextWindow/maxTokens/cost 缺失则补最小合法默认，避免自定义模型
            // 因缺字段被网关 Zod 校验拒绝（仅补缺失项，用户显式值保留）。
            const cm = {
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...rawCm,
              name: (rawCm.name && String(rawCm.name).trim()) ? rawCm.name : rawCm.id,
            }
            const idx = merged.findIndex((m: any) => m && m.id === cm.id)
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...cm }
            } else {
              merged.push(cm)
            }
          }
          officialBody.models = merged
        }
        // 融合技能（如果预设中包含 skills）
        if (officialBody.skills) {
          const incomingSkills = officialBody.skills.entries || officialBody.skills
          existingConfig.skills.entries = {
            ...existingConfig.skills.entries,
            ...incomingSkills
          }
        }

        // 使用避让后的安全 key 作为 provider 的键（与后续 primary 拼接一致），
        // 避免与 OpenClaw 外部 provider 目录重名而触发插件强制安装。
        const providerKey = toOpenClawProviderKey(p.id)
        existingConfig.models.providers[providerKey] = {
          ...existingConfig.models.providers[providerKey],
          ...officialBody
        }
      } else {
        console.warn(`[ConfigManager] 未找到 configName: ${p.configName} 对应的预设配置，跳过`)
      }
    }

    // ----- 处理激活模型 Primary -----
    const activeProvider = this.config.providers.find((p) => p.id === this.config.activeProvider)
    if (activeProvider) {
      const pId = toOpenClawProviderKey(activeProvider.id)
      const mName = activeProvider.model
      const fullModelKey = `${pId}/${mName}`
      existingConfig.agents.defaults.model = { primary: fullModelKey }
      existingConfig.agents.defaults.models[fullModelKey] = {}
    }

    // ----- 清理累积残留（只写不清会导致 openclaw.json 持续膨胀）-----
    // 1) models.providers：以「当前已填 apiKey 的 provider 安全 key 集合」为白名单，
    //    删除曾启用、现已清空 key 或从列表移除的 provider 残留。保留 id 键已由
    //    pruneReservedOpenClawProviderRefs 处理，这里处理其余普通 provider。
    const liveProviderKeys = new Set(
      (this.config.providers || [])
        .filter(p => p.apiKey && p.apiKey.trim() !== '')
        .map(p => toOpenClawProviderKey(p.id))
    )
    if (existingConfig.models?.providers) {
      for (const key of Object.keys(existingConfig.models.providers)) {
        if (!liveProviderKeys.has(key) && !isReservedOpenClawProviderKey(key)) {
          // 保留 id 不删（交给 prune 流程统一判定），其余不在白名单的一律清理
          delete existingConfig.models.providers[key]
        }
      }
    }
    // 2) agents.defaults.models：只保留当前 activeProvider 的 fullModelKey，
    //    删除历史切换 provider 累积下来的旧模型键。
    if (activeProvider) {
      const pId = toOpenClawProviderKey(activeProvider.id)
      const keepKey = `${pId}/${activeProvider.model}`
      const modelsMap = existingConfig.agents?.defaults?.models
      if (modelsMap && typeof modelsMap === 'object') {
        for (const key of Object.keys(modelsMap)) {
          if (key !== keepKey && !isReservedOpenClawProviderKey(key.split('/')[0])) {
            delete modelsMap[key]
          }
        }
      }
    }

    // 清理多余字段
    if (existingConfig.models) delete existingConfig.models.timeout
    if (existingConfig.plugins) {
      delete existingConfig.plugins.bonjour
      delete (existingConfig.plugins as any)['talk-voice']

      // remove stale plugin entries that are actually model providers
      // (they live under models.providers, not as installed plugins)
      if (existingConfig.plugins.entries) {
        const providerIds = new Set((this.config.providers || []).map(p => p.id))
        for (const key of Object.keys(existingConfig.plugins.entries)) {
          if (providerIds.has(key)) {
            delete existingConfig.plugins.entries[key]
          }
        }
      }
    }

    // 自愈：清理旧版本/旧配置里会触发 OpenClaw 外部 provider 插件安装的冲突残留
    // （models.providers 下的保留 id 键、agents.defaults.models 下命中前缀的模型键）。
    pruneReservedOpenClawProviderRefs(existingConfig)

    // channel config injection (native channels such as feishu)
    existingConfig.channels = existingConfig.channels || {}
    const uiChannels = this.config.channels || {}
    const feishuCfg = uiChannels.feishu as Record<string, unknown> | undefined
    if (feishuCfg && feishuCfg.enabled) {
      const appId = String(feishuCfg.appId ?? '').trim()
      const appSecret = String(feishuCfg.appSecret ?? '').trim()
      if (appId && appSecret) {
        const feishu: Record<string, unknown> = {
          ...(existingConfig.channels.feishu || {}),
          appId,
          appSecret,
          dmPolicy: feishuCfg.dmPolicy || 'pairing',
          groupPolicy: feishuCfg.groupPolicy || 'allowlist',
          requireMention: feishuCfg.requireMention ?? true
        }
        const encryptKey = String(feishuCfg.encryptKey ?? '').trim()
        const verificationToken = String(feishuCfg.verificationToken ?? '').trim()
        if (encryptKey) feishu.encryptKey = encryptKey
        if (verificationToken) feishu.verificationToken = verificationToken
        existingConfig.channels.feishu = feishu

        existingConfig.plugins = existingConfig.plugins || {}
        existingConfig.plugins.entries = existingConfig.plugins.entries || {}
        existingConfig.plugins.entries.feishu = {
          ...(existingConfig.plugins.entries.feishu || {}),
          enabled: true
        }
      }
    } else if (existingConfig.channels.feishu) {
      delete existingConfig.channels.feishu
    }

    existingConfig.meta = {
      ...(existingConfig.meta || {}),
      lastTouchedVersion: 'latest',
      lastTouchedAt: new Date().toISOString()
    }

    const content = JSON.stringify(existingConfig, null, 2)
    this._atomicWriteFileSync(this.openClawConfigPath, content)
    console.log('[ConfigManager] openclaw.json 已使用新版预设结构同步完成。')

    // 同步凭证库 auth-profiles.json：把所有已填 API Key 的服务商写一份，
    // 作为 openclaw.json 之外的双保险，供 OpenClaw 凭证管理读取。
    this._syncAuthProfiles(allProviders)
  } catch (err: any) {
    console.error('[ConfigManager] 同步 OpenClaw 配置失败:', err.message)
  }
}

/**
 * 同步 auth-profiles.json 凭证库（<configDir>/agents/main/agent/auth-profiles.json）。
 * 仅写入已配置 API Key 的服务商；读取失败时从空对象重建，不阻断主流程。
 */
private _syncAuthProfiles(allProviders: ModelProvider[]): void {
  try {
    const agentAuthDir = join(openClawPaths.configDir(this.dataDir), 'agents', 'main', 'agent')
    mkdirSync(agentAuthDir, { recursive: true })
    const authProfilesPath = join(agentAuthDir, 'auth-profiles.json')

    let authProfiles: Record<string, any> = {}
    if (existsSync(authProfilesPath)) {
      try {
        const authRaw = readFileSync(authProfilesPath, 'utf-8')
        const parsed = JSON.parse(authRaw)
        if (parsed && typeof parsed === 'object') authProfiles = parsed
      } catch {
        authProfiles = {}
      }
    }

    for (const p of allProviders) {
      if (p.apiKey) {
        authProfiles[p.id] = {
          apiKey: p.apiKey,
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {})
        }
      }
    }
    writeFileSync(authProfilesPath, JSON.stringify(authProfiles, null, 2), 'utf-8')
  } catch (err: any) {
    console.warn('[ConfigManager] 同步 auth-profiles.json 失败:', err.message)
  }
}
  getRuntimeDir() {
    return join(
      this.getDataDir(),
      'runtime'
    )
  }
  /**
   * 🟢 [方向 A] 供前端 Skills 页面调用：全量扫描本地便携式子目录，解析并返回技能列表
   */
  public getInstalledSkills(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
    const list: any[] = []
    try {
      // 1. 安全检查：如果便携目录不存在，直接返回空列表
      if (!existsSync(this.portableSkillsDir)) {
        return list
      }

      // 2. 读取 openclaw.json 里的全局技能开关状态，用来做前端对齐
      let enabledSkillsMap: Record<string, any> = {}
      const parsedForSkills = this._readOpenClawConfig(null, (e) =>
        console.warn('[ConfigManager] 匹配技能开关时读取 openclaw.json 失败', e)
      )
      if (parsedForSkills) {
        // 从 skills.entries 节点获取已启用的映射表
        enabledSkillsMap = parsedForSkills?.skills?.entries || parsedForSkills?.skills || {}
      }

      // 3. 扫描父目录下的所有子文件夹（即每个独立的 Skill 包）
      const entries = readdirSync(this.portableSkillsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFolderId = entry.name // 文件夹名作为唯一 ID（例如 "pdf-helper"）
          const skillMdPath = join(this.portableSkillsDir, skillFolderId, 'SKILL.md')

          // 默认兜底信息，防止某些 Skill 没有写标准声明导致崩溃
          let skillName = skillFolderId
          let skillDescription = "暂无描述信息。"

          // 4. 如果根部存在 SKILL.md，开始硬核解析它的 Front Matter
          if (existsSync(skillMdPath)) {
            try {
              const fileContent = readFileSync(skillMdPath, 'utf-8')
              skillName = this._parseFrontMatterField(fileContent, 'name') ?? skillName
              skillDescription =
                this._parseFrontMatterField(fileContent, 'description') ?? skillDescription
            } catch (mdErr) {
              console.error(`[ConfigManager] 解析 ${skillFolderId}/SKILL.md 失败:`, mdErr)
            }
          }

          // 5. 组装成前端开箱即用的标准 JSON 结构
          list.push({
            id: skillFolderId,                     // 用于命令行的目录标识
            name: skillName,                       // 页面显示的技能名称
            description: skillDescription,         // 页面显示的描述
            enabled: enabledSkillsMap[skillFolderId]?.enabled ?? false // 默认没在配置里的算关闭
          })
        }
      }
    } catch (err) {
      console.error('[ConfigManager] 全量扫描本地 Skill 失败:', err)
    }

    console.log(`[ConfigManager] 本地 Skills 扫描完成，共找到 ${list.length} 个技能。`)
    return list
  }
  /**
   * 🟢 供前端 Skills 页面调用：控制某个本地 Skill 的启用/禁用开关
   * @param skillId 技能的唯一标识（即文件夹名，例如 "pdf-helper"）
   * @param enabled 目标状态：true 开启，false 关闭
   */
  public toggleSkillStatus(skillId: string, enabled: boolean): void {
    try {
      // 1. 初始化或读取现有的 openclaw.json 配置
      let openClawConfig: any = {
        agents: { defaults: {} },
        gateway: { mode: "local", auth: {} },
        channels: {},
        plugins: { entries: { "openclaw-weixin": { "enabled": true } } },
        skills: { entries: {} }
      }

      // 只读一次并复用解析结果，避免守卫/兜底双读的 TOCTOU 窗口（同 _syncOpenClawConfig）
      let parsedForToggle: any = null
      if (existsSync(this.openClawConfigPath)) {
        try {
          parsedForToggle = this._parseOpenClawJsonRaw()
          if (!parsedForToggle || typeof parsedForToggle !== 'object') parsedForToggle = null
        } catch (parseErr) {
          console.error('[ConfigManager] openclaw.json parse failed; skip skill toggle to avoid overwriting config', parseErr)
          return
        }
      }
      openClawConfig = parsedForToggle || openClawConfig

      // 2. 强保障 skills 节点存在
      openClawConfig.skills = openClawConfig.skills || {}
      openClawConfig.skills.entries = openClawConfig.skills.entries || {}

      // 🟢 写入到 entries 内部
      openClawConfig.skills.entries[skillId] = {
        enabled: enabled
      }
      // 4. 安全回写到磁盘
      this._atomicWriteFileSync(this.openClawConfigPath, JSON.stringify(openClawConfig, null, 2))
      console.log(`[ConfigManager] 本地技能 [${skillId}] 状态已成功切换为: ${enabled}`)

    } catch (err) {
      console.error(`[ConfigManager] 切换技能 [${skillId}] 开关失败:`, err)
    }
  }

  /**
   * 🟢 供前端 Skills 页面调用：弹出文件选择框，选择 zip 包并自动解压到便携 skills 目录
   */
  public async importSkillZip(): Promise<{ success: boolean; error?: string }> {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择 OpenClaw 技能压缩包 (.zip)',
        filters: [{ name: 'Zip Archives', extensions: ['zip'] }],
        properties: ['openFile']
      })

      if (canceled || filePaths.length === 0) {
        return { success: false, error: '用户取消了选择' }
      }

      const zipPath = filePaths[0]
      // 获取压缩包本来的文件名（去掉 .zip），作为无根目录时的备用文件夹名
      const zipFileName = basename(zipPath, '.zip') 

      const zip = new AdmZip(zipPath)
      const zipEntries = zip.getEntries()

      // 1. 深度扫描：定位 SKILL.md 并摸清它的底层结构
      let skillMdEntry: any = null
      let hasParentFolder = false
      let detectedFolderName = ''

      for (const entry of zipEntries) {
        if (entry.entryName.endsWith('SKILL.md')) {
          skillMdEntry = entry
          const parts = entry.entryName.split('/')
          // 如果切开大于 1，说明形如 "pdf-helper/SKILL.md"，天然自带了父文件夹
          if (parts.length > 1 && parts[0] !== '') {
            hasParentFolder = true
            detectedFolderName = parts[0]
          }
          break
        }
      }

      if (!skillMdEntry) {
        return { success: false, error: '不合法的 Skill 包：未检测到 SKILL.md 文件！' }
      }

      // 2. 智能化分流解压机制
      if (hasParentFolder) {
        // 🔹 情况 A：压缩包本身很规范，里面已经套了文件夹 (如 pdf-helper/SKILL.md)
        // 直接解压释放到父目录，adm-zip 会完整保留 pdf-helper 文件夹
        zip.extractAllTo(this.portableSkillsDir, true)
        console.log(`[ConfigManager] 规范包解压完成，保留了原有目录: ${detectedFolderName}`)
      } else {
        // 🔹 情况 B：压缩包不规范，文件全平铺在根部 (如 📂zip根部/SKILL.md)
        // 我们需要硬核解析出 SKILL.md 里的 name，作为它的专属文件夹名
        let targetSkillName = zipFileName // 默认用压缩包文件名兜底
        try {
          const fileContent = skillMdEntry.getData().toString('utf8')
          // 精准提取 yaml 里的 name: pdf-helper
          targetSkillName = this._parseFrontMatterField(fileContent, 'name') ?? targetSkillName
        } catch (e) {
          console.warn('[ConfigManager] 从平铺的 SKILL.md 中解析 name 失败，改用压缩包名')
        }

        // 拼接出它应该去的合规子目录绝对路径：data/config/.openclaw/skills/pdf-helper
        const finalSkillDir = join(this.portableSkillsDir, targetSkillName)
        
        // 强行把整个压缩包的所有内容，解压释放到这个新建的独立子目录下
        zip.extractAllTo(finalSkillDir, true)
        console.log(`[ConfigManager] 平铺包解压完成，已自动为其创建合规子目录: ${targetSkillName}`)
      }

      return { success: true }

    } catch (err: any) {
      console.error('[ConfigManager] 导入 Skill 压缩包失败:', err)
      return { success: false, error: err.message || '解压安装过程中发生未知错误' }
    }
  }
}
