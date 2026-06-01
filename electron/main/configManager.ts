import { app } from 'electron'
import { join, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
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
    model: 'deepseek-chat',
    enabled: true
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'moonshot-v1-8k',
    enabled: false
  },
  {
    id: 'qwen',
    name: '通义千问 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-plus',
    enabled: false
  },
  {
    id: 'doubao',
    name: '豆包 (字节跳动)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    model: 'ep-xxxxxxxxx',
    enabled: false
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
    enabled: false
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: '',
    model: 'abab6.5s-chat',
    enabled: false
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    enabled: false
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    enabled: false
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    enabled: false
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: 'llama3',
    enabled: false
  }
]

const DEFAULT_CONFIG: AppConfig = {
  activeProvider: 'deepseek',
  providers: DEFAULT_PROVIDERS,
  port: 3213,
  autoStart: false,
  minimizeToTray: true,
  useChineseMirror: true,
  logLevel: 'info',
  language: 'zh-CN'
}

export class ConfigManager {
  private dataDir: string
  private configPath: string
  private config: AppConfig

  constructor() {
    // 数据目录：便携模式用 exe 同级目录，否则项目同级目录方便管理
    // const portable = join(process.execPath, '..', 'data')
    // console.log('路径是否存在：', existsSync(portable))
    // this.dataDir = existsSync(portable) ? portable : join(app.getPath('userData'), 'data')
    if (app.isPackaged) {
      // 1. 如果是生产环境（打包后的 exe），数据目录在 exe 所在的同级目录下
      // app.getPath('exe') 拿到的是 D:\xxx\your-app.exe，它的 dirname 就是安装包/解压包目录
      this.dataDir = join(resolve(app.getPath('exe'), '..'), 'data')
    } else {
      // 2. 如果是开发模式（npm run dev），数据目录就在当前项目的根目录下的 data 文件夹
      // process.cwd() 在开发时代表你敲击运行命令的那个项目根目录
      this.dataDir = join(process.cwd(), 'data')
    }
    // ── 🛡️ 安全防御：确保该 data 目录一定存在，不存在就自动创建 ─────────────────
    if (!existsSync(this.dataDir)) {
      try {
        mkdirSync(this.dataDir, { recursive: true })
        console.log(`[Init] 成功创建本地数据目录: ${this.dataDir}`)
      } catch (err) {
        console.error(`[Init] 创建数据目录失败:`, err)
      }
    }
    mkdirSync(this.dataDir, { recursive: true })
    this.configPath = join(this.dataDir, 'config', 'app.json')
    mkdirSync(join(this.dataDir, 'config'), { recursive: true })
    mkdirSync(join(this.dataDir, 'config', '.openclaw'), { recursive: true })
    mkdirSync(join(this.dataDir, 'logs'), { recursive: true })

    this.config = this._load()
  }

  getConfig(): AppConfig {
    return { ...this.config }
  }

  saveConfig(partial: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...partial }
    this._persist()
    // 同步写入 openclaw.json
    this._syncOpenClawConfig()
    return this.config
  }

  resetConfig(): AppConfig {
    this.config = { ...DEFAULT_CONFIG }
    this._persist()
    return this.config
  }

  getDataDir(): string {
    return this.dataDir
  }

  getNodePath(): string {
    const platform = process.platform
    const arch = process.arch
    const nodeDir = join(this.dataDir, 'runtime', `node-${platform}-${arch}`)
    if (platform === 'win32') return join(nodeDir, 'node.exe')
    return join(nodeDir, 'bin', 'node')
  }

  private _load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8')
        const saved = JSON.parse(raw)
        // 合并默认值，确保新字段存在
        return {
          ...DEFAULT_CONFIG,
          ...saved,
          providers: DEFAULT_PROVIDERS.map((def) => {
            const saved_p = saved.providers?.find((p: ModelProvider) => p.id === def.id)
            return saved_p ? { ...def, ...saved_p } : def
          })
        }
      }
    } catch { }
    return { ...DEFAULT_CONFIG }
  }

  private _persist(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
  }

  private _syncOpenClawConfig(): void {
    const provider = this.config.providers.find(
      (p) => p.id === this.config.activeProvider
    )
    if (!provider) return

    const openClawConfig = {
      llm: {
        provider: 'openai-compatible',
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model
      },
      server: {
        port: this.config.port
      }
    }

    const configDir = join(this.dataDir, 'config', '.openclaw')
    writeFileSync(
      join(configDir, 'openclaw.json'),
      JSON.stringify(openClawConfig, null, 2),
      'utf-8'
    )
  }
}
