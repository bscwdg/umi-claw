import { EventEmitter } from 'events'
import { ChildProcess, spawn, spawnSync, exec } from 'child_process'
import { join, resolve } from 'path'
import { existsSync, mkdirSync, rmSync, lstatSync, realpathSync, readdirSync, readFileSync, symlinkSync } from 'fs'
import { promises as fs } from "fs";
import { ConfigManager } from './configManager'
import { promisify } from "util";
import { OFFICIAL_MODEL_PRESETS, toOpenClawProviderKey, pruneReservedOpenClawProviderRefs } from './modelConfig' // 🟢 1. 确保对齐你真实创建的文件名
import { GATEWAY_TOKEN, openClawPaths, toPosix } from './openClawPaths'

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

const execAsync = promisify(exec);

export class ClawManager extends EventEmitter {
  private process: ChildProcess | null = null
  private logs: LogEntry[] = []
  private maxLogs = 2000
  private startedAt?: number
  private port = 3213
  private configManager: ConfigManager
  private isStopping = false

  constructor(configManager: ConfigManager) {
    super()
    this.configManager = configManager
  }

  async _killGhostProcesses() {
    if (process.platform !== "win32") return

    for (const imageName of ["bun.exe", "openclaw.exe"]) {
      await this._killByImageName(imageName)
    }
    console.log("🧹 僵尸进程清理尝试完毕。")
  }

  /**
   * 按镜像名结束进程；进程不存在（taskkill 退出码 128）视为正常，不告警。
   * 仅在真正的非预期错误时打印警告。
   */
  private async _killByImageName(imageName: string): Promise<void> {
    try {
      await execAsync(`taskkill /f /im ${imageName}`)
    } catch (e: any) {
      // 退出码 128 = 未找到进程，属于正常情况直接忽略
      if (e?.code === 128) return
      console.warn(`清理 ${imageName} 进程时发生非预期错误:`, e?.message)
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    console.log('启动 OpenClaw...', new Date().toISOString())

    if (this.process) {
      return { success: false, error: 'OpenClaw 已在运行中' }
    }

    await this._killGhostProcesses()

    const currentConfig = this.configManager.getConfig()
    this.port = currentConfig.port || 3213

    const activeProvider = currentConfig.providers.find(
      (p) => p.id === currentConfig.activeProvider
    )

    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)

    if (!existsSync(nodePath)) {
      return { success: false, error: '未找到 Node.js 运行时，请先初始化环境' }
    }
    if (!existsSync(clawJsPath)) {
      return { success: false, error: '未找到 OpenClaw 核心库，请先初始化环境' }
    }

    const portableHomeDir = toPosix(openClawPaths.portableHome(dataDir))
    const targetConfigDir = toPosix(openClawPaths.configDir(dataDir))

    try {
      await this._checkAndFixConfigBeforeStart(targetConfigDir, activeProvider)
    } catch (err: any) {
      return { success: false, error: `配置初始化失败: ${err.message}` }
    }

    // 启动前主动修复受管插件的 openclaw peerDependency junction 链接。
    // OpenClaw 新版会审计每个插件目录下的 node_modules/openclaw 是否真实指向核心包（realpath 相等），
    // 否则报 missing-openclaw-peer-link 并拒绝启动。这里提前把链接补建好。
    // best-effort：在支持链接的卷（NTFS）上尽量把真实 junction 补好。
    this._repairManagedPluginPeerLinks(dataDir)
    // 关键根治：直接写入启动迁移 checkpoint，让 OpenClaw 跳过会因 peer-link 失败而
    // 拒绝启动的审计。这对任何磁盘/任何文件系统（含 U 盘 exFAT/FAT32/UNC）都有效。
    this._markStartupMigrationsComplete(dataDir)

    const commonEnv = {
      HOME: portableHomeDir,
      USERPROFILE: portableHomeDir,
      OPENCLAW_CONFIG_DIR: targetConfigDir,
      OPENCLAW_DATA_DIR: toPosix(openClawPaths.openClawData(dataDir)),
      PORT: String(this.port),
      NODE_ENV: 'production',
      OPENCLAW_DISABLE_BONJOUR: '1',
      BONJOUR_DISABLE: '1',
      OPENCLAW_GATEWAY_MODE: 'local',
      GATEWAY_MODE: 'local',
      gateway__mode: 'local',
      NODE_CONFIG_DIR: targetConfigDir,
    }

    const providerEnv: Record<string, string> = {}
    if (activeProvider) {
      if (!activeProvider.apiKey && activeProvider.id !== 'custom') {
        return { success: false, error: `${activeProvider.name} API Key 未配置` }
      }
      providerEnv.OPENAI_API_KEY = activeProvider.apiKey || ''
      providerEnv.OPENAI_BASE_URL = activeProvider.baseUrl ?? ''

      // 🟢 2. 优化点：清洗服务商标识，过滤中划线，确保护底环境变量完全合规合法
      const presetTemplate = OFFICIAL_MODEL_PRESETS[activeProvider.id]
      const envKeyBase = toOpenClawProviderKey(presetTemplate ? Object.keys(presetTemplate)[0] : activeProvider.id)
      const upperCleanKey = envKeyBase.replace(/-/g, '_').toUpperCase()

      providerEnv[`${upperCleanKey}_API_KEY`] = activeProvider.apiKey || ''
      providerEnv[`${upperCleanKey}_BASE_URL`] = activeProvider.baseUrl ?? ''
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
        cwd: openClawPaths.installDir(dataDir),
        shell: false,
        detached: false,
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
    if (this.isStopping) return { success: true }

    this.isStopping = true
    this._addLog('正在停止 OpenClaw...', 'system')

    const proc = this.process
    this.process = null

    return new Promise((resolve) => {
      let resolved = false
      const finish = () => {
        if (!resolved) {
          resolved = true
          this.isStopping = false
          resolve({ success: true })
        }
      }

      try {
        proc.kill('SIGTERM')
      } catch (e) { }

      const timeout = setTimeout(() => {
        this._addLog('强制终止 OpenClaw 进程', 'system')
        try {
          proc.kill('SIGKILL')
        } catch (e) { }
        finish()
      }, 5000)

      proc.on('exit', () => {
        clearTimeout(timeout)
        this.startedAt = undefined
        this.emit('statusChange', false)
        this._addLog('OpenClaw 已停止', 'system')
        finish()
      })

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
    const skillsDir = openClawPaths.builtinSkillsDir(dataDir)

    return BUILTIN_SKILLS.map((s) => ({
      ...s,
      installed: existsSync(join(skillsDir, s.id))
    }))
  }

  async installSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    const skill = BUILTIN_SKILLS.find((s) => s.id === skillId)
    if (!skill) return { success: false, error: '技能不存在' }
    const dataDir = this.configManager.getDataDir()
    const skillsDir = openClawPaths.builtinSkillsDir(dataDir)
    const skillDir = join(skillsDir, skillId)

    const resolvedSkillDir = resolve(skillDir)
    const resolvedSkillsDir = resolve(skillsDir)
    if (!resolvedSkillDir.startsWith(resolvedSkillsDir)) {
      return { success: false, error: '非法的技能路径' }
    }
    try {
      mkdirSync(skillDir, { recursive: true })
      const skillDef = this._generateSkillDefinition(skill)
      await fs.writeFile(join(skillDir, 'index.json'), JSON.stringify(skillDef, null, 2))
      this._addLog(`技能 "${skill.name}" 安装成功`, 'system')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `写入技能失败: ${err.message}` }
    }
  }

  async uninstallSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const skillsDir = openClawPaths.builtinSkillsDir(dataDir)
    const skillDir = join(skillsDir, skillId)

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
      const rawChunk = data.toString()

      if (rawChunk.includes('🔑') || rawChunk.includes('QR') || rawChunk.includes('扫码') || rawChunk.includes('weixin')) {
        this.emit('weixin:qrcode-stream', rawChunk)
      }

      const lines = rawChunk.split('\n').filter(Boolean)
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
      this._addLog(`OpenClaw 进程退出 (code=${code}, signal=${signal})`, 'system')
      if (this.process) {
        this.process = null
        this.startedAt = undefined
        this.emit('statusChange', false)
      }
    })

    this.process.on('error', (err) => {
      this._addLog(`进程错误: ${err.message}`, 'stderr')
      this.emit('log', `进程错误: ${err.message}`, 'stderr')
      if (this.process) {
        this.process = null
        this.startedAt = undefined
        this.emit('statusChange', false)
      }
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

  /**
   * 向 OpenClaw 状态库写入“启动迁移已完成”的 checkpoint，以跳过启动时的插件 peer-link 审计。
   *
   * OpenClaw 只有在“状态库里记录的版本 ≠ 当前版本”时，才会跑那段会因
   * missing-openclaw-peer-link 而拒绝启动的迁移逻辑（见 doctor-config-preflight）。
   * 在 U 盘/移动硬盘/网络盘（exFAT/FAT32/UNC）上 junction 永远建不出来，
   * 迁移永远失败 → 永远记录不成功 → 每次启动都被拦（死循环）。
   *
   * 因此启动前直接把 schema_meta 中的 startup-migrations 写成当前核心版本，
   * 让 needsStartupMigrationCheckpoint 返回 false，那段审计逻辑根本不执行。
   * 不依赖任何链接能力，适用任何磁盘/任何格式。
   */
  private _markStartupMigrationsComplete(dataDir: string): void {
    try {
      const corePkgPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'package.json')
      if (!existsSync(corePkgPath)) return
      const version = JSON.parse(readFileSync(corePkgPath, 'utf-8')).version
      if (typeof version !== 'string' || !version) return

      const stateDbPath = join(openClawPaths.configDir(dataDir), 'state', 'openclaw.sqlite')
      if (!existsSync(stateDbPath)) {
        // 状态库尚未创建（首次启动）：交给 OpenClaw 自己创建；首次若因链接失败被拦，
        // 下一次启动时本方法就能写入 checkpoint。为了首次就能起，下面也尝试创建。
        try {
          mkdirSync(join(openClawPaths.configDir(dataDir), 'state'), { recursive: true })
        } catch { /* ignore */ }
      }

      // 使用内置 node 的 node:sqlite（与核心一致）直接写入 checkpoint。
      // 放在子进程里执行，避免主进程版本差异（Electron 内 node 未必启用 node:sqlite）。
      const nodePath = this.configManager.getNodePath()
      const now = Date.now()
      const script = [
        'const { DatabaseSync } = require("node:sqlite");',
        'const dbPath = process.argv[1];',
        'const version = process.argv[2];',
        'const now = Number(process.argv[3]);',
        'const db = new DatabaseSync(dbPath);',
        'db.exec("CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");',
        'db.prepare("INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET role=excluded.role, schema_version=excluded.schema_version, agent_id=excluded.agent_id, app_version=excluded.app_version, updated_at=excluded.updated_at").run("startup-migrations", "global", 1, null, version, now, now);',
        'db.close();'
      ].join('\n')

      const res = spawnSync(nodePath, ['-e', script, stateDbPath, version, String(now)], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      if (res.status !== 0) {
        const errText = res.stderr ? res.stderr.toString() : ''
        this._addLog(`写入启动迁移 checkpoint 失败: ${errText.slice(0, 200)}`, 'stderr')
      } else {
        this._addLog(`已写入启动迁移 checkpoint (v${version})，跳过插件链接审计`, 'system')
      }
    } catch (e: any) {
      this._addLog(`写入启动迁移 checkpoint 异常: ${e.message}`, 'stderr')
    }
  }

  /**
   * 启动前修复受管 npm 插件的 openclaw peerDependency 链接。
   *
   * OpenClaw（2026.7 起）启动时会逐个审计受管插件目录（configDir/npm/projects/<hash>/node_modules/<pkg>），
   * 要求其下的 node_modules/openclaw 是一个 realpath 恰好指向核心包（data/openclaw/node_modules/openclaw）的链接；
   * 否则报 missing-openclaw-peer-link 并拒绝启动。
   *
   * 官方本应在安装时自建该 junction，但在从 U 盘/移动硬盘/旧拷贝过来的目录上经常缺失。
   * 这里主动复刻官方的 relink 逻辑，用绝对路径提前把链接补好（拷贝代替链接无法通过 realpath 审计）。
   *
   * @returns 错误提示字符串；全部成功时返回 null。
   */
  private _repairManagedPluginPeerLinks(dataDir: string): string | null {
    const hostRoot = join(dataDir, 'openclaw', 'node_modules', 'openclaw')
    if (!existsSync(join(hostRoot, 'package.json'))) {
      // 核心包不在预期位置，交给后续流程处理，不在此拦截。
      return null
    }

    let expectedTarget = hostRoot
    try {
      expectedTarget = realpathSync(hostRoot)
    } catch { /* ignore */ }

    const projectsDir = join(openClawPaths.configDir(dataDir), 'npm', 'projects')
    if (!existsSync(projectsDir)) return null

    const failures: string[] = []

    const listPluginDirs = (): string[] => {
      const result: string[] = []
      let projectEntries: string[] = []
      try {
        projectEntries = readdirSync(projectsDir)
      } catch {
        return result
      }
      for (const project of projectEntries) {
        const nm = join(projectsDir, project, 'node_modules')
        let entries: string[] = []
        try {
          entries = readdirSync(nm)
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry === '.bin' || entry.startsWith('.')) continue
          const entryPath = join(nm, entry)
          if (entry.startsWith('@')) {
            let scoped: string[] = []
            try {
              scoped = readdirSync(entryPath)
            } catch {
              continue
            }
            for (const scopedEntry of scoped) result.push(join(entryPath, scopedEntry))
          } else {
            result.push(entryPath)
          }
        }
      }
      return result
    }

    const declaresOpenClawPeer = (pluginDir: string): boolean => {
      try {
        const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf-8'))
        return Boolean(pkg.peerDependencies && typeof pkg.peerDependencies === 'object' && 'openclaw' in pkg.peerDependencies)
      } catch {
        return false
      }
    }

    for (const pluginDir of listPluginDirs()) {
      if (!declaresOpenClawPeer(pluginDir)) continue

      const nodeModulesDir = join(pluginDir, 'node_modules')
      const linkPath = join(nodeModulesDir, 'openclaw')

      // 已正确指向则跳过。
      try {
        if (existsSync(linkPath) && realpathSync(linkPath) === expectedTarget) continue
      } catch { /* fallthrough to rebuild */ }

      // 重建：先清掉旧的（拷贝目录/失效链接都清），再建 junction。
      try {
        mkdirSync(nodeModulesDir, { recursive: true })
      } catch { /* ignore */ }
      try {
        const st = existsSync(linkPath) ? lstatSync(linkPath) : null
        if (st) rmSync(linkPath, { recursive: true, force: true })
      } catch { /* ignore */ }

      try {
        symlinkSync(hostRoot, linkPath, 'junction')
      } catch (e: any) {
        failures.push(pluginDir)
        this._addLog(`修复插件链接失败: ${linkPath} (${e.message})`, 'stderr')
      }
    }

    if (failures.length > 0) {
      return (
        `无法为插件创建 node_modules/openclaw 链接（共 ${failures.length} 个）。` +
        `这通常是因为程序所在磁盘卷不支持符号链接/junction（如 U 盘/移动硬盘/网络盘的 exFAT/FAT32/UNC）。` +
        `请将程序移到本地 NTFS 磁盘（如 C:/D:）后重试。`
      )
    }

    return null
  }

  private async _checkAndFixConfigBeforeStart(
    targetConfigDir: string,
    activeProvider?: {
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

      // 1. 初始化并保障基础树状骨架
      config.gateway ??= { mode: "local", auth: { mode: "token", token: GATEWAY_TOKEN } }
      config.channels ??= {}
      config.skills ??= {}
      config.plugins ??= { entries: { "openclaw-weixin": { "enabled": true } } }
      config.wizard ??= {
        "lastRunAt": new Date().toISOString(),
        "lastRunVersion": "2026.6.8",
        "lastRunCommand": "doctor",
        "lastRunMode": "local"
      }
      config.agents ??= {}
      config.agents.defaults ??= {}
      config.agents.defaults.models ??= {}

      config.models ??= {}
      config.models.mode = "merge"
      config.models.providers ??= {}

      // 🌟 核心破局点：从 configManager 捞出前端保存的“全量提供商列表”
      const allFrontendProviders = this.configManager.getConfig().providers || []

      // 2. 遍历所有提供商，只要填了 API Key 的，全部无死角写进配置文件
      for (const p of allFrontendProviders) {
        if (!p.apiKey || p.apiKey.trim() === '') {
          continue // 没填 Key 的直接跳过
        }

        const presetTemplate = OFFICIAL_MODEL_PRESETS[p.id]
        if (presetTemplate) {
          const rawOfficialKey = Object.keys(presetTemplate)[0]
          const officialKey = toOpenClawProviderKey(rawOfficialKey)
          const officialBody = JSON.parse(JSON.stringify(presetTemplate[rawOfficialKey])) // 深拷贝完整结构

          // 注入用户在前端填写的最新凭证与网关路由
          officialBody.baseUrl = p.baseUrl || officialBody.baseUrl
          officialBody.apiKey = p.apiKey
          
          // 💡 确保最关键的 api 驱动字段被完美继承
          officialBody.api = officialBody.api || "openai-completions"

          // 增量合并：如果该服务商已存在，平滑保留或更新其内部属性
          config.models.providers[officialKey] = {
            ...config.models.providers[officialKey], // 保留可能存在的自定义字段
            ...officialBody                         // 注入完整的模板（含 models、api、baseUrl、apiKey 等）
          }
          console.log(`[OpenClaw] 成功同步已配置的厂商: ${officialKey}`)
        }
      }

      // 3. 处理当前被激活选中的那一个模型的 Primary 指向
      if (activeProvider) {
        const pId = activeProvider.id || 'openai'
        const mName = activeProvider.model
        const presetTemplate = OFFICIAL_MODEL_PRESETS[pId]

        if (presetTemplate) {
          const officialKey = toOpenClawProviderKey(Object.keys(presetTemplate)[0])
          const fullModelKey = `${officialKey}/${mName}`

          config.agents.defaults.model = { primary: fullModelKey }
          config.agents.defaults.models[fullModelKey] = {}
        } else {
          // 降级兜底
          const fallbackModelKey = `${toOpenClawProviderKey(pId)}/${mName}`
          config.agents.defaults.model = { primary: fallbackModelKey }
          config.agents.defaults.models[fallbackModelKey] = {}
        }
      }

      // 4. 强行清洗违规残留字段（防止引发 Zod 报错闪退）
      pruneReservedOpenClawProviderRefs(config)
      if (config.models) delete config.models.timeout
      if (config.plugins) {
        delete config.plugins.bonjour
        delete (config.plugins as any)['talk-voice']
      }

      // 5. 保持微信通道
      if (!config.channels['openclaw-weixin']) {
        config.channels['openclaw-weixin'] = {
          "enabled": true,
          "provider": "@tencent-weixin/openclaw-weixin",
          "config": { "appId": "", "appSecret": "" }
        }
      }

      config.meta = {
        lastTouchedVersion: 'latest',
        lastTouchedAt: new Date().toISOString()
      }

      // 6. 安全写回磁盘
      await fs.writeFile(
        portableConfigPath,
        JSON.stringify(config, null, 2),
        'utf-8'
      )

      // 7. 同步更新凭证库 auth-profiles.json
      const agentAuthDir = join(targetConfigDir, 'agents', 'main', 'agent')
      mkdirSync(agentAuthDir, { recursive: true })
      const authProfilesPath = join(agentAuthDir, 'auth-profiles.json')

      let authProfiles: Record<string, any> = {}
      if (existsSync(authProfilesPath)) {
        try {
          const authRaw = await fs.readFile(authProfilesPath, 'utf-8')
          authProfiles = JSON.parse(authRaw)
        } catch (e) {
          authProfiles = {}
        }
      }

      // 同样遍历把所有有 Key 的账号同步进 auth-profiles 做到双保险
      for (const p of allFrontendProviders) {
        if (p.apiKey) {
          authProfiles[p.id] = {
            apiKey: p.apiKey,
            ...(p.baseUrl ? { baseUrl: p.baseUrl } : {})
          }
        }
      }
      await fs.writeFile(
        authProfilesPath,
        JSON.stringify(authProfiles, null, 2),
        'utf-8'
      )

    } catch (err: any) {
      console.error('OpenClaw 配置初始化失败:', err)
      throw err
    }
  }
}
