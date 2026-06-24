import { app } from 'electron'
import { join, resolve, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { OFFICIAL_MODEL_PRESETS } from './modelConfig'

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean,
  configName: string,
}

export interface AppConfig {
  activeProvider: string
  providers: ModelProvider[]
  port: number
  autoStart: boolean
  minimizeToTray: boolean
  useChineseMirror: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  language: 'zh-CN' | 'en-US'
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
    id: 'doubao',
    name: '豆包 (字节跳动)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    model: 'ep-xxxxxxxxx',
    enabled: false,
    configName: 'DOUBAO_ARK_PROVIDERS'         // 和火山代码计划区分开
  },
  {
    id: 'volcengine-plan',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: '',
    model: 'ark-code-latest',
    enabled: false,
    configName: 'VOLCENGINE_DEFAULT_PROVIDERS'         // 火山
  },
  {
    id: 'bailian',
    name: '通义千问 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen3.7-max',
    enabled: false,
    configName: 'QWEN_DASHSCOPE_PROVIDERS'    // 和百炼计划区分开
  },
  {
    id: 'bailian-token-plan',
    name: '千问百炼 (阿里云)',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    apiKey: '',
    model: 'qwen3.7-max',
    enabled: false,
    configName: 'QWEN_BAILIAN_DEFAULT_PROVIDERS'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
    enabled: false,
    configName: 'ZHIPU_DEFAULT_PROVIDERS'
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'moonshot-v1-8k',
    enabled: false,
    configName: 'KIMI_DEFAULT_PROVIDERS'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: '',
    model: 'abab6.5s-chat',
    enabled: false,
    configName: 'MINIMAX_DEFAULT_PROVIDERS'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    enabled: false,
    configName: 'SILICONFLOW_DEFAULT_PROVIDERS'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    enabled: false,
    configName: 'OPENAI_DEFAULT_PROVIDERS'
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    enabled: false,
    configName: 'ANTHROPIC_DEFAULT_PROVIDERS'
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: 'llama3',
    enabled: false,
    configName: 'CUSTOM_DEFAULT_PROVIDERS'
  }
]

// 使用深拷贝函数确保默认配置不会被意外修改
const getDeepCopyDefaultConfig = (): AppConfig => ({
  activeProvider: 'deepseek',
  providers: DEFAULT_PROVIDERS.map(p => ({ ...p })),
  port: 3213,
  autoStart: false,
  minimizeToTray: true,
  useChineseMirror: true,
  logLevel: 'info',
  language: 'zh-CN'
})

const DEFAULT_CONFIG = getDeepCopyDefaultConfig()
// 固定 token
const GATEWAY_TOKEN = "https://github.com/bscwdg/umi-claw";

export class ConfigManager {
  private dataDir: string
  private configPath: string
  private config: AppConfig
  private openClawConfigPath: string

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

    // 初始化目录结构
    this._ensureDirectories()

    // 设置配置文件路径
    this.configPath = join(this.dataDir, 'config', 'app.json')
    this.openClawConfigPath = join(this.dataDir, 'config', '.openclaw', 'openclaw.json')

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
   * 确保所有必要的目录存在
   */
  private _ensureDirectories(): void {
    const dirs = [
      this.dataDir,
      join(this.dataDir, 'config'),
      join(this.dataDir, 'config', '.openclaw'),
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
   * 持久化配置到磁盘 (同步以确保原子性和错误捕获)
   */
  // private _syncOpenClawConfig(): void {
  //   try {
  //     const activeProvider = this.config.providers.find(
  //       (p) => p.id === this.config.activeProvider
  //     )

  //     const openClawConfig = activeProvider
  //       ? {
  //         agents: {
  //           defaults: {
  //             model: {
  //               primary: activeProvider.model
  //             },
  //             models: {
  //               [activeProvider.model]: {}
  //             }
  //           }
  //         },
  //         channels: {},
  //         skills: {},
  //         meta: {
  //           generatedBy: 'claw-desktop',
  //           generatedAt: new Date().toISOString()
  //         }
  //       }
  //       : {
  //         channels: {},
  //         skills: {}
  //       }

  //     const content = JSON.stringify(openClawConfig, null, 2)

  //     let shouldWrite = true

  //     if (existsSync(this.openClawConfigPath)) {
  //       try {
  //         const existingContent = readFileSync(
  //           this.openClawConfigPath,
  //           'utf-8'
  //         )

  //         if (existingContent === content) {
  //           shouldWrite = false
  //         }
  //       } catch { }
  //     }

  //     if (shouldWrite) {
  //       writeFileSync(
  //         this.openClawConfigPath,
  //         content,
  //         'utf-8'
  //       )
  //     }
  //   } catch (err: any) {
  //     console.error(
  //       '[ConfigManager] 同步 OpenClaw 配置失败:',
  //       err.message
  //     )
  //   }
  // }
  /**
   * 同步更新 OpenClaw 配置 (采用增量安全合并，不再抹除其他配置项)
   */
  // private _syncOpenClawConfig(): void {
  //   try {
  //     const workspacePath = join(
  //       this.dataDir,
  //       'config',
  //       '.openclaw',
  //       'workspace'
  //     )

  //     // 1. 初始化一个兜底的基础骨架
  //     let existingConfig: any = {
  //       agents: { defaults: {} },
  //       gateway: { mode: "local", auth: {} },
  //       channels: {}, // 确保核心通道节点不丢失
  //       plugins: {}
  //     }

  //     // 2. 如果文件存在，先读取现有的配置（保留微信渠道等生态字段）
  //     if (existsSync(this.openClawConfigPath)) {
  //       try {
  //         const raw = readFileSync(this.openClawConfigPath, 'utf-8')
  //         const parsed = JSON.parse(raw)
  //         if (parsed && typeof parsed === 'object') {
  //           existingConfig = parsed
  //         }
  //       } catch (e) {
  //         console.warn('[ConfigManager] 读取现有 openclaw.json 失败，将使用安全合并策略', e)
  //       }
  //     }

  //     // 3. 极其精准、局部安全地合并更新我们的配置（不破坏已存在的同级对象）
  //     existingConfig.agents = existingConfig.agents || {}
  //     existingConfig.agents.defaults = {
  //       ...(existingConfig.agents.defaults || {}),
  //       workspace: workspacePath
  //     }

  //     existingConfig.gateway = {
  //       ...(existingConfig.gateway || {}),
  //       mode: "local",
  //       auth: {
  //         ...(existingConfig.gateway?.auth || {}),
  //         mode: "token",
  //         token: GATEWAY_TOKEN
  //       }
  //     }

  //     existingConfig.meta = {
  //       ...(existingConfig.meta || {}),
  //       lastTouchedVersion: 'latest',
  //       lastTouchedAt: new Date().toISOString()
  //     }

  //     // 4. 将内容序列化并写回
  //     const content = JSON.stringify(existingConfig, null, 2)

  //     writeFileSync(
  //       this.openClawConfigPath,
  //       content,
  //       'utf-8'
  //     )
  //     console.log('[ConfigManager] openclaw.json 配置已实现增量平滑同步。')
  //   } catch (err: any) {
  //     console.error(
  //       '[ConfigManager] 同步 OpenClaw 配置失败:',
  //       err.message
  //     )
  //   }
  // }
  /**
   * 同步更新 OpenClaw 配置 (利用 mainConfig 里的官方标准模板完美对齐 Zod 结构)
   */
  /**
   * 同步更新 OpenClaw 配置 (利用 modelConfig 里的官方标准模板完美对齐 Zod 结构)
   */
  private _syncOpenClawConfig(): void {
    try {
      const workspacePath = join(
        this.dataDir,
        'config',
        '.openclaw',
        'workspace'
      )

      // 1. 初始化基础骨架（若文件存在则直接读取完整内容，确保不破坏任何已有字段）
      let existingConfig: any = {
        agents: { defaults: {} },
        gateway: { mode: "local", auth: {} },
        channels: {},
        plugins: { entries: { "openclaw-weixin": { "enabled": true } } },
        wizard: {
          "lastRunAt": new Date().toISOString(),
          "lastRunVersion": "2026.6.8",
          "lastRunCommand": "doctor",
          "lastRunMode": "local"
        }
      }

      if (existsSync(this.openClawConfigPath)) {
        try {
          const raw = readFileSync(this.openClawConfigPath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            existingConfig = parsed
          }
        } catch (e) {
          console.warn('[ConfigManager] 读取现有 openclaw.json 失败', e)
        }
      }

      // 确保核心深层节点安全存在
      existingConfig.agents = existingConfig.agents || {}
      existingConfig.agents.defaults = existingConfig.agents.defaults || {}
      existingConfig.agents.defaults.workspace = workspacePath
      existingConfig.agents.defaults.models = existingConfig.agents.defaults.models || {}

      existingConfig.models = existingConfig.models || {}
      existingConfig.models.mode = "merge"
      existingConfig.models.providers = existingConfig.models.providers || {}

      // 🟢 核心改动 1：遍历前端所有的提供商列表，只要填了 Key 统统写入
      const allProviders = this.config.providers || []
      for (const p of allProviders) {
        if (!p.apiKey || p.apiKey.trim() === '') {
          continue // 没填 API Key 的商户直接跳过
        }

        const presetTemplate = OFFICIAL_MODEL_PRESETS[p.id]
        if (presetTemplate) {
          const officialKey = Object.keys(presetTemplate)[0]
          const officialBody = JSON.parse(JSON.stringify(presetTemplate[officialKey])) // 深拷贝模板

          // 注入用户在 UI 界面填写的真实 baseUrl 和 apiKey
          officialBody.baseUrl = p.baseUrl || officialBody.baseUrl
          officialBody.apiKey = p.apiKey
          
          // 💡 显式保证关键驱动协议 api 的同步写入，不会丢失
          officialBody.api = officialBody.api || "openai-completions"

          // 增量融合到全局配置
          existingConfig.models.providers[officialKey] = {
            ...existingConfig.models.providers[officialKey],
            ...officialBody
          }
          console.log(`[ConfigManager 保存] 成功同步已配置的厂商: ${officialKey}`)
        }
      }

      // 2. 寻找到当前激活的提供商，单独修正 Primary 选中指向
      const activeProvider = this.config.providers.find(
        (p) => p.id === this.config.activeProvider
      )

      if (activeProvider) {
        const pId = activeProvider.id || 'openai'
        const mName = activeProvider.model
        const presetTemplate = OFFICIAL_MODEL_PRESETS[pId]

        const officialKey = presetTemplate ? Object.keys(presetTemplate)[0] : pId.toLowerCase()
        const fullModelKey = `${officialKey}/${mName}`

        existingConfig.agents.defaults.model = {
          primary: fullModelKey
        }
        existingConfig.agents.defaults.models[fullModelKey] = {}
      }

      // 🟢 核心改动 2：清洗容易引发 Zod 报错的非网关标准违规残留字段
      if (existingConfig.models) {
        delete existingConfig.models.timeout
      }
      if (existingConfig.plugins) {
        delete existingConfig.plugins.bonjour
        delete (existingConfig.plugins as any)['talk-voice']
      }

      // 3. 同步网关基本信息
      existingConfig.gateway = {
        ...(existingConfig.gateway || {}),
        mode: "local",
        auth: {
          ...(existingConfig.gateway?.auth || {}),
          mode: "token",
          token: GATEWAY_TOKEN
        }
      }

      // 4. 更新元数据时间戳
      existingConfig.meta = {
        ...(existingConfig.meta || {}),
        lastTouchedVersion: 'latest',
        lastTouchedAt: new Date().toISOString()
      }

      // 5. 序列化并安全回写磁盘
      const content = JSON.stringify(existingConfig, null, 2)
      writeFileSync(this.openClawConfigPath, content, 'utf-8')
      console.log('[ConfigManager] openclaw.json 已经成功于保存时刷新所有带 Key 模型的完整结构。')
    } catch (err: any) {
      console.error('[ConfigManager] 同步 OpenClaw 配置失败:', err.message)
    }
  }
  getRuntimeDir() {
    return join(
      this.getDataDir(),
      'runtime'
    )
  }
}