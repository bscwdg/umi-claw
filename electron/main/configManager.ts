import { app,dialog } from 'electron'
import { join, resolve, dirname ,basename} from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import AdmZip from 'adm-zip'
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
    this.openClawConfigPath = join(this.dataDir, 'config', '.openclaw', 'openclaw.json')
    this.portableSkillsDir = join(this.dataDir, 'config', '.openclaw', 'skills')
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
private _syncOpenClawConfig(): void {
  try {
    const workspacePath = join(this.dataDir, 'config', '.openclaw', 'workspace')
    const allowedDataRoot = this.dataDir.replace(/\\/g, '/')

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

    if (existsSync(this.openClawConfigPath)) {
      try {
        const raw = readFileSync(this.openClawConfigPath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          existingConfig = parsed
        }
      } catch (e) { }
    }

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
        // 融合技能（如果预设中包含 skills）
        if (officialBody.skills) {
          const incomingSkills = officialBody.skills.entries || officialBody.skills
          existingConfig.skills.entries = {
            ...existingConfig.skills.entries,
            ...incomingSkills
          }
        }

        // 使用 p.id 作为 provider 的键（与后续 primary 拼接一致）
        existingConfig.models.providers[p.id] = {
          ...existingConfig.models.providers[p.id],
          ...officialBody
        }
      } else {
        console.warn(`[ConfigManager] 未找到 configName: ${p.configName} 对应的预设配置，跳过`)
      }
    }

    // ----- 处理激活模型 Primary -----
    const activeProvider = this.config.providers.find((p) => p.id === this.config.activeProvider)
    if (activeProvider) {
      const pId = activeProvider.id
      const mName = activeProvider.model
      const fullModelKey = `${pId}/${mName}`
      existingConfig.agents.defaults.model = { primary: fullModelKey }
      existingConfig.agents.defaults.models[fullModelKey] = {}
    }

    // 清理多余字段
    if (existingConfig.models) delete existingConfig.models.timeout
    if (existingConfig.plugins) {
      delete existingConfig.plugins.bonjour
      delete (existingConfig.plugins as any)['talk-voice']
    }

    existingConfig.meta = {
      ...(existingConfig.meta || {}),
      lastTouchedVersion: 'latest',
      lastTouchedAt: new Date().toISOString()
    }

    const content = JSON.stringify(existingConfig, null, 2)
    writeFileSync(this.openClawConfigPath, content, 'utf-8')
    console.log('[ConfigManager] openclaw.json 已使用新版预设结构同步完成。')
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
      if (existsSync(this.openClawConfigPath)) {
        try {
          const raw = readFileSync(this.openClawConfigPath, 'utf-8')
          const parsed = JSON.parse(raw)
          // 🟢 核心变动：从 skills.entries 节点获取已启用的映射表
          enabledSkillsMap = parsed?.skills?.entries || parsed?.skills || {}
        } catch (e) {
          console.warn('[ConfigManager] 匹配技能开关时读取 openclaw.json 失败', e)
        }
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

              // 使用正则匹配 YAML/Front Matter 中的 name 和 description
              // 支持三种常见格式：name: xxx、name: "xxx"、name: 'xxx'
              const nameMatch = fileContent.match(/name:\s*["']?(.*?)["']?(\r?\n|$)/)
              const descMatch = fileContent.match(/description:\s*["']?(.*?)["']?(\r?\n|$)/)

              if (nameMatch && nameMatch[1]) {
                skillName = nameMatch[1].trim()
              }
              if (descMatch && descMatch[1]) {
                skillDescription = descMatch[1].trim()
              }
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

      if (existsSync(this.openClawConfigPath)) {
        try {
          const raw = readFileSync(this.openClawConfigPath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            openClawConfig = parsed
          }
        } catch (e) {
          console.warn('[ConfigManager] 读取 openclaw.json 失败，将采用全新骨架覆盖', e)
        }
      }

      // 2. 强保障 skills 节点存在
      openClawConfig.skills = openClawConfig.skills || {}
      openClawConfig.skills.entries = openClawConfig.skills.entries || {}

      // 🟢 写入到 entries 内部
      openClawConfig.skills.entries[skillId] = {
        enabled: enabled
      }
      // 4. 安全回写到磁盘
      writeFileSync(this.openClawConfigPath, JSON.stringify(openClawConfig, null, 2), 'utf-8')
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
          const nameMatch = fileContent.match(/name:\s*["']?(.*?)["']?(\r?\n|$)/)
          if (nameMatch && nameMatch[1]) {
            targetSkillName = nameMatch[1].trim() // 精准提取 yaml 里的 name: pdf-helper
          }
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