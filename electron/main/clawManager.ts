import { EventEmitter } from 'events'
import { ChildProcess, spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs'
import { ConfigManager } from './configManager'

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

export class ClawManager extends EventEmitter {
  private process: ChildProcess | null = null
  private logs: LogEntry[] = []
  private maxLogs = 2000
  private startedAt?: number
  private port = 3213
  private configManager: ConfigManager

  constructor(configManager: ConfigManager) {
    super()
    this.configManager = configManager
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    console.log('启动 OpenClaw...')
    if (this.process) {
      return { success: false, error: 'OpenClaw 已在运行中' }
    }

    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()

    // 1. 🔍 变更点：不再指向 .bin 下的壳，直接指向 openclaw 依赖包本身的真实 JS 文件
    // 💡 提示：openclaw 官方标准的入口一般是它的 dist/index.js 或 index.js
    const clawJsPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')
    // 如果上一步启动报错，可以检查一下 node_modules/openclaw/package.json 里的 "main" 字段指向什么，对齐即可

    if (!existsSync(nodePath)) {
      return { success: false, error: '未找到 Node.js 运行时，请先初始化环境' }
    }
    if (!existsSync(clawJsPath)) {
      return { success: false, error: '未找到 OpenClaw 核心库，请先初始化环境' }
    }

    const config = this.configManager.getConfig()
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_DIR: join(dataDir, 'config', '.openclaw'),
      OPENCLAW_DATA_DIR: join(dataDir, 'data'),
      PORT: String(this.port),
      NODE_ENV: 'production'
    }

    this._addLog(`正在启动 OpenClaw (端口 ${this.port})...`, 'system')

    // try {
    //   // 2. 🚀 变更点：这里传入的是纯粹的 JS 文件路径，node 能够完美解析，不再卡死和抛语法错误
    //   this.process = spawn(nodePath, [clawJsPath], {
    //     env,
    //     cwd: join(dataDir, 'openclaw'),
    //     shell: false,
    //     detached: false
    //   })

    //   this.startedAt = Date.now()
    //   this._setupProcessEvents()
    //   this.emit('statusChange', true, this.port)
    //   return { success: true }
    // } catch (err: any) {
    //   return { success: false, error: err.message }
    // }
    try {
      //  核心点：在参数数组中追加 'gateway' 命令以及对应端口号 '--port'
      this.process = spawn(nodePath, [
        clawJsPath,
        'gateway',
        '--port',
        String(this.port)
      ], {
        env,
        cwd: join(dataDir, 'openclaw'),
        shell: false,
        detached: false
      })

      this.startedAt = Date.now()
      this._setupProcessEvents()
      this.emit('statusChange', true, this.port)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
  async stop(): Promise<{ success: boolean }> {
    if (!this.process) return { success: true }

    return new Promise((resolve) => {
      this._addLog('正在停止 OpenClaw...', 'system')
      const proc = this.process!
      this.process = null

      // 优雅关闭
      proc.kill('SIGTERM')
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve({ success: true })
      }, 5000)

      proc.on('exit', () => {
        clearTimeout(timeout)
        this.startedAt = undefined
        this.emit('statusChange', false)
        this._addLog('OpenClaw 已停止', 'system')
        resolve({ success: true })
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

    try {
      // 1. 确保父级链路目录完整性
      mkdirSync(skillDir, { recursive: true })
      
      // 2. 生成定义并写入
      const skillDef = this._generateSkillDefinition(skill)
      writeFileSync(join(skillDir, 'index.json'), JSON.stringify(skillDef, null, 2))
      
      this._addLog(`技能 "${skill.name}" 安装成功`, 'system')
      
      // 💡 建议在下面增加：向 openclaw 触发热重载的逻辑（如有）
      // await this.gatewayProvider.reloadSkills() 

      return { success: true }
    } catch (err: any) {
      return { success: false, error: `写入技能失败: ${err.message}` }
    }
}

async uninstallSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const skillDir = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'skills', skillId)

    try {
      if (existsSync(skillDir)) {
        // ⚡️ 安全干掉动态 import，直接用顶层的 rmSync，兼顾了高版本 Node 的强力递归删除
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
      if (this.process) {
        this.process = null
        this.startedAt = undefined
        this.emit('statusChange', false)
      }
    })

    this.process.on('error', (err) => {
      this._addLog(`进程错误: ${err.message}`, 'stderr')
      this.emit('log', `进程错误: ${err.message}`, 'stderr')
    })
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
}
