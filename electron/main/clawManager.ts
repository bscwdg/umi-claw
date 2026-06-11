import { EventEmitter } from 'events'
import { ChildProcess, spawn, exec } from 'child_process'
import { join, resolve } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { promises as fs } from "fs";
import { ConfigManager } from './configManager'
import { promisify } from "util";

export interface ClawStatus {
  running: boolean
  pid?: number
  port: number
  uptime?: number
  startedAt?: number
}

export interface LogEntry {
  line: string
  type: 'stdout' | 'stderr' | 'system'
  time: number
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  installed: boolean
  builtin: boolean
}

// 内置中文技能列表
const BUILTIN_SKILLS: Omit<SkillInfo, 'installed'>[] = [
  { id: 'china-search', name: '🔍 中国搜索', description: '使用百度/必应进行中文搜索', builtin: true },
  { id: 'china-weather', name: '🌤️ 中国天气', description: '查询国内各城市天气预报', builtin: true },
  { id: 'zhihu-writer', name: '📝 知乎写作', description: '生成知乎风格的长文回答', builtin: true },
  { id: 'xiaohongshu', name: '🍠 小红书作家', description: '创作小红书风格种草文案', builtin: true },
  { id: 'douyin-script', name: '🎵 抖音脚本', description: '生成短视频口播脚本', builtin: true },
  { id: 'wechat-article', name: '📰 微信公众号', description: '撰写微信公众号推文', builtin: true },
  { id: 'deepseek-helper', name: '🤖 DeepSeek 助手', description: 'DeepSeek 专属优化助手', builtin: true },
  { id: 'bilibili-helper', name: '📺 B站助手', description: '哔哩哔哩视频脚本与分析', builtin: true },
  { id: 'code-review', name: '💻 代码审查', description: '智能代码审查与优化建议', builtin: true },
  { id: 'translate-pro', name: '🌐 专业翻译', description: '中英文专业级双向翻译', builtin: true }
]

// 固定 token - 注意：这只是一个标识符，不是敏感密钥，可以保留
const GATEWAY_TOKEN = "https://github.com/bscwdg/umi-claw";

const execAsync = promisify(exec);


export class ClawManager extends EventEmitter {
  private process: ChildProcess | null = null
  private logs: LogEntry[] = []
  private maxLogs = 2000
  private startedAt?: number
  private port = 3213
  private configManager: ConfigManager
  // 用于防止 stop 被并发调用
  private isStopping = false

  constructor(configManager: ConfigManager) {
    super()
    this.configManager = configManager
  }

  async _killGhostProcesses() {
    if (process.platform === "win32") {
      try {
        // 注意：这会杀死当前用户下所有的 bun/openclaw 进程，包括其他项目的。
        // 在生产环境中，建议通过 PID 文件管理进程，而非盲目杀进程名。
        // 这里保持原有逻辑，但优化错误处理以忽略“未找到进程”的正常情况。
        await execAsync("taskkill /f /im bun.exe");
      } catch (e: any) {
        // 忽略 "ERROR: The process ... not found." 错误
        if (!e.message.includes("not found")) {
          console.warn('清理 bun 进程时发生非预期错误:', e.message)
        }
      }
      
      try {
        await execAsync("taskkill /f /im openclaw.exe");
      } catch (e: any) {
        if (!e.message.includes("not found")) {
          console.warn('清理 openclaw 进程时发生非预期错误:', e.message)
        }
      }
      console.log("🧹 僵尸进程清理尝试完毕。");
    }
  }

  /**
   * 🚀 启动 OpenClaw 服务
   */
  async start(): Promise<{ success: boolean; error?: string }> {
    console.log('启动 OpenClaw...', new Date().toISOString())
    
    if (this.process) {
      return { success: false, error: 'OpenClaw 已在运行中' }
    }

    await this._killGhostProcesses()

    // 1. 获取当前前端保存并激活的最新的服务商配置
    const currentConfig = this.configManager.getConfig()
    const activeProvider = currentConfig.providers.find(
      (p) => p.id === currentConfig.activeProvider
    )
    
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')

    if (!existsSync(nodePath)) {
      return { success: false, error: '未找到 Node.js 运行时，请先初始化环境' }
    }
    if (!existsSync(clawJsPath)) {
      return { success: false, error: '未找到 OpenClaw 核心库，请先初始化环境' }
    }

    // 🌟 划定 U 盘下的隔离目录作为“伪家目录”
    const portableHomeDir = join(dataDir, 'config').replace(/\\/g, '/')
    const targetConfigDir = join(portableHomeDir, '.openclaw').replace(/\\/g, '/')
    
    // 预检并修复配置
    try {
      await this._checkAndFixConfigBeforeStart(targetConfigDir, activeProvider)
    } catch (err: any) {
      return { success: false, error: `配置初始化失败: ${err.message}` }
    }

    // 🌟 伪造并重定向环境变量
    const commonEnv = {
      HOME: portableHomeDir,
      USERPROFILE: portableHomeDir,
      OPENCLAW_CONFIG_DIR: targetConfigDir,
      OPENCLAW_DATA_DIR: join(dataDir, 'data').replace(/\\/g, '/'),
      PORT: String(this.port),
      NODE_ENV: 'production',
      OPENCLAW_DISABLE_BONJOUR: '1',
      BONJOUR_DISABLE: '1',
      OPENCLAW_GATEWAY_MODE: 'local',
      GATEWAY_MODE: 'local',
      // 某些库可能读取小写或双下划线变量
      gateway__mode: 'local',
      NODE_CONFIG_DIR: targetConfigDir,
    }

    // 动态注入 Provider 相关环境变量
    const providerEnv: Record<string, string> = {}
    
    if (activeProvider) {
      if (activeProvider.id === 'openai') {
        if (!activeProvider.apiKey) {
           return { success: false, error: 'OpenAI API Key 未配置' }
        }
        providerEnv.OPENAI_API_KEY = activeProvider.apiKey
        providerEnv.OPENAI_BASE_URL = activeProvider.baseUrl ?? ''
      } else if (activeProvider.id === 'deepseek') {
        if (!activeProvider.apiKey) {
          // 🔴 修复：严禁硬编码密钥。如果没有 Key，应报错。
          return { success: false, error: 'DeepSeek API Key 未配置' }
        }
        providerEnv.DEEPSEEK_API_KEY = activeProvider.apiKey
        providerEnv.DEEPSEEK_BASE_URL = activeProvider.baseUrl ?? ''
      }
      // 如果有其他 provider，可在此扩展
    }

    const env = {
      ...process.env,
      ...commonEnv,
      ...providerEnv
    }

    this._addLog(`正在启动 OpenClaw (端口 ${this.port})...`, 'system')
    
    try {
      this.process = spawn(nodePath, [
        clawJsPath,
        'gateway',
        '--port',
        String(this.port),
      ], {
        env,
        cwd: join(dataDir, 'openclaw'),
        shell: false,
        detached: false,
        // 建议增加 stdio 配置以便更好地捕获输出，虽然下面单独绑定了事件
        stdio: ['pipe', 'pipe', 'pipe'] 
      })

      this.startedAt = Date.now()
      this._setupProcessEvents()
      this.emit('statusChange', true, this.port)
      return { success: true }
    } catch (err: any) {
      this.process = null
      return { success: false, error: err.message }
    }
  }

  async stop(): Promise<{ success: boolean }> {
    if (!this.process) return { success: true }
    if (this.isStopping) return { success: true } // 防止重复停止

    this.isStopping = true
    this._addLog('正在停止 OpenClaw...', 'system')
    
    const proc = this.process
    this.process = null // 立即置空，防止外部再次调用 stop 或 start 时的状态冲突

    return new Promise((resolve) => {
      let resolved = false
      const finish = () => {
        if (!resolved) {
          resolved = true
          this.isStopping = false
          resolve({ success: true })
        }
      }

      // 优雅关闭
      try {
        proc.kill('SIGTERM')
      } catch (e) {
        // 进程可能已经退出
      }

      const timeout = setTimeout(() => {
        this._addLog('强制终止 OpenClaw 进程', 'system')
        try {
          proc.kill('SIGKILL')
        } catch (e) {}
        finish()
      }, 5000)

      proc.on('exit', () => {
        clearTimeout(timeout)
        this.startedAt = undefined
        this.emit('statusChange', false)
        this._addLog('OpenClaw 已停止', 'system')
        finish()
      })
      
      // 处理进程可能在 kill 后立即消失的情况
      proc.on('error', (err) => {
         clearTimeout(timeout)
         this.startedAt = undefined
         this.emit('statusChange', false)
         this._addLog(`停止过程中出错: ${err.message}`, 'system')
         finish()
      })
    })
  }

  getStatus(): ClawStatus {
    return {
      running: !!this.process,
      pid: this.process?.pid,
      port: this.port,
      uptime: this.startedAt ? Date.now() - this.startedAt : undefined,
      startedAt: this.startedAt
    }
  }

  getLogs(): LogEntry[] {
    return this.logs.slice(-500)
  }

  clearLogs(): void {
    this.logs = []
  }

  listSkills(): SkillInfo[] {
    const dataDir = this.configManager.getDataDir()
    const skillsDir = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'skills')

    return BUILTIN_SKILLS.map((s) => ({
      ...s,
      installed: existsSync(join(skillsDir, s.id))
    }))
  }

  async installSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    const skill = BUILTIN_SKILLS.find((s) => s.id === skillId)
    if (!skill) return { success: false, error: '技能不存在' }
    const dataDir = this.configManager.getDataDir()
    const skillsDir = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'skills')
    const skillDir = join(skillsDir, skillId)
    // 🛡️ 安全检查：确保解析后的路径在预期的 skillsDir 内
    const resolvedSkillDir = resolve(skillDir)
    const resolvedSkillsDir = resolve(skillsDir)
    if (!resolvedSkillDir.startsWith(resolvedSkillsDir)) {
        return { success: false, error: '非法的技能路径' }
    }
    try {
      mkdirSync(skillDir, { recursive: true })
      const skillDef = this._generateSkillDefinition(skill)
      // 使用 await 确保写入完成
      await fs.writeFile(join(skillDir, 'index.json'), JSON.stringify(skillDef, null, 2))
      this._addLog(`技能 "${skill.name}" 安装成功`, 'system')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `写入技能失败: ${err.message}` }
    }
  }

  async uninstallSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const skillsDir = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'skills')
    const skillDir = join(skillsDir, skillId)

    // 🛡️ 安全检查
    const resolvedSkillDir = resolve(skillDir)
    const resolvedSkillsDir = resolve(skillsDir)
    if (!resolvedSkillDir.startsWith(resolvedSkillsDir)) {
        return { success: false, error: '非法的技能路径' }
    }

    try {
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true })
        this._addLog(`技能 ID "${skillId}" 卸载成功`, 'system')
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `卸载技能失败: ${err.message}` }
    }
  }

  private _setupProcessEvents(): void {
    if (!this.process) return

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      lines.forEach((line) => {
        this._addLog(line, 'stdout')
        this.emit('log', line, 'stdout')
      })
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      lines.forEach((line) => {
        this._addLog(line, 'stderr')
        this.emit('log', line, 'stderr')
      })
    })

    this.process.on('exit', (code, signal) => {
      this._addLog(
        `OpenClaw 进程退出 (code=${code}, signal=${signal})`,
        'system'
      )
      // 只有当 process 仍然指向当前实例时才清理，防止旧事件回调干扰新实例
      if (this.process) {
        this.process = null
        this.startedAt = undefined
        this.emit('statusChange', false)
      }
    })

    this.process.on('error', (err) => {
      this._addLog(`进程错误: ${err.message}`, 'stderr')
      this.emit('log', `进程错误: ${err.message}`, 'stderr')
      // 发生错误时，通常进程也会退出，但为了保险起见，重置状态
      if (this.process) {
          this.process = null
          this.startedAt = undefined
          this.emit('statusChange', false)
      }
    })
    
    // ⚠️ 移除无效的 unhandledRejection 和 uncaughtException 监听
    // ChildProcess 不会发射这些事件，它们是主进程 process 对象的事件。
    // 在这里监听它们没有任何作用，反而会造成误解。
  }

  private _addLog(line: string, type: LogEntry['type']): void {
    const entry: LogEntry = { line, type, time: Date.now() }
    this.logs.push(entry)
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }
  }

  private _generateSkillDefinition(skill: Omit<SkillInfo, 'installed'>): object {
    const prompts: Record<string, string> = {
      'china-search': '你是一个搜索助手，帮助用户在中国主流平台搜索信息。根据用户的问题，生成合适的搜索建议和摘要。',
      'china-weather': '你是天气查询助手，为中国用户提供城市天气信息。根据用户提供的城市名，给出天气预报和出行建议。',
      'zhihu-writer': '你是知乎专业回答者，擅长撰写深度、有料的知乎风格长文。回答要有干货，逻辑清晰，适当使用数据和案例。',
      'xiaohongshu': '你是小红书内容创作者，擅长撰写种草文案。文风活泼，多用emoji，格式为标题+正文+标签。',
      'douyin-script': '你是抖音爆款脚本创作专家，帮助创作者写口播稿。开头要抓眼球，中间有料，结尾引导互动。',
      'wechat-article': '你是微信公众号运营专家，擅长撰写爆款推文。标题吸引人，内容有深度，结构清晰。',
      'deepseek-helper': '你是DeepSeek AI使用专家，帮助用户充分发挥DeepSeek的能力。提供最优提示词和使用技巧。',
      'bilibili-helper': '你是B站内容创作助手，帮助UP主策划选题、撰写脚本、优化标题和封面文案。',
      'code-review': '你是资深代码审查专家，对提交的代码进行全面review，指出问题、安全风险、性能瓶颈，并提供优化建议。',
      'translate-pro': '你是专业翻译，精通中英文互译。翻译要准确、地道，兼顾语境和文化差异，必要时提供注释。'
    }

    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: '1.0.0',
      systemPrompt: prompts[skill.id] || skill.description,
      builtin: true
    }
  }

  private async _checkAndFixConfigBeforeStart(
    targetConfigDir: string,
    provider?: {
      id: string
      model: string
      apiKey?: string
      baseUrl?: string
    }
  ): Promise<void> {
    try {
      mkdirSync(targetConfigDir, { recursive: true })

      const portableConfigPath = join(targetConfigDir, 'openclaw.json')
      let config: any = {}

      if (existsSync(portableConfigPath)) {
        try {
          const raw = await fs.readFile(portableConfigPath, 'utf-8')
          config = JSON.parse(raw)
        } catch (e) {
          console.warn('[OpenClaw] 配置文件解析失败，将重置配置', e)
          config = {}
        }
      }

      // 更新 Agent 默认模型
      config.agents ??= {}
      config.agents.defaults ??= {}

      if (provider) {
        config.agents.defaults.model = {
          primary: `${provider.id}/${provider.model}`
        }
        
        config.agents.defaults.models ??= {}
        const modelKey = `${provider.id}/${provider.model}`
        config.agents.defaults.models[modelKey] ??= {}
      }

      // 保持其他配置不变
      config.channels ??= {}
      config.skills ??= {}
      
      // 更新元数据
      config.meta = {
        lastTouchedVersion: 'latest',
        lastTouchedAt: new Date().toISOString()
      }

      await fs.writeFile(
        portableConfigPath,
        JSON.stringify(config, null, 2),
        'utf-8'
      )

      // 处理 auth-profiles
      const agentAuthDir = join(targetConfigDir, 'agents', 'main', 'agent')
      mkdirSync(agentAuthDir, { recursive: true })

      const authProfilesPath = join(agentAuthDir, 'auth-profiles.json')

      // 只有在文件不存在且有 Provider 信息时才创建/覆盖
      // 注意：如果文件已存在，我们通常不应该覆盖它，以免丢失用户手动修改的其他配置
      // 原逻辑是 !existsSync 才写，这里保持一致
      if (provider?.apiKey && !existsSync(authProfilesPath)) {
        const authProfiles = {
          [provider.id]: {
            apiKey: provider.apiKey,
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {})
          }
        }

        await fs.writeFile(
          authProfilesPath,
          JSON.stringify(authProfiles, null, 2),
          'utf-8'
        )
        console.log('[OpenClaw] auth-profiles 已生成')
      }

    } catch (err: any) {
      console.error('OpenClaw 配置初始化失败:', err)
      throw err // 向上抛出错误，让 start() 方法知道配置失败了
    }
  }
}