import { EventEmitter } from 'events'
import { ChildProcess, spawn, exec, execFile } from 'child_process'
import { join, relative, resolve, sep } from 'path'
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync
} from 'fs'
import { promises as fs } from "fs";
import { ConfigManager } from './configManager'
import { promisify } from "util";
import { toOpenClawProviderKey } from './modelConfig'
import { openClawPaths, toPosix, buildOpenClawEnv } from './openClawPaths'

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

/**
 * `probeStartup` 的结论。三态而非布尔，是为了让调用方区分
 * 「拿到起不来的正面证据」和「压根没测出结论」—— 只有前者才允许触发回滚。
 */
export interface StartupProbeResult {
  /** 进程活着且就绪 */
  ok: boolean
  /** 进程自己退出了：这是「新版本起不来」的正面证据，可用于回滚决策 */
  refused: boolean
  /** 既没退出也没就绪：结论不确定，**不要**据此回滚 */
  inconclusive: boolean
  exitCode?: number | null
  /**
   * `refused` 的**限定词**（不是并列的第四态）：自退原因是「状态库需要迁移」
   * （退出码 78 / 打印过迁移提示）。它把「数据条件」从「新版本有缺陷」里分出来，
   * 供调用方选文案与补救动作（重跑 doctor vs 重试更新）。
   *
   * 注意它**不**参与回滚安全性判断 —— 那只看数据有没有真被迁移过
   * （见 ClawManager.readSchemaVersions 与 env:update）。
   */
  maintenanceRequired: boolean
  reason: string
}

/** SQLite 文件头里 `PRAGMA user_version` 的偏移（4 字节大端 uint32） */
const SQLITE_USER_VERSION_OFFSET = 60

/**
 * doctor 因状态库被占用而失败的输出特征。
 * 实测文案：`Doctor could not enter maintenance. An agent database is in use.
 * Stop other OpenClaw processes using this state, then retry the update.`
 * 另含其内部错误名 StateDatabaseCoordinatorContentionError / SQLITE_BUSY。
 */
const DOCTOR_CONTENTION_RE =
  /database is in use|ContentionError|database is locked|SQLITE_BUSY/i

/**
 * 读 SQLite 文件头 offset 60 处的大端 uint32，即 `PRAGMA user_version`。
 *
 * 不引 sqlite 依赖：这里只需要「版本号变没变」，读 4 个字节就够；
 * 真正 open 一次库反而会和 doctor / 网关抢锁。
 *
 * 读不到（文件不存在 / 被独占 / 不是 SQLite）返回 null，调用方按「未知」处理 ——
 * 绝不要把「读不到」当成「没变」，那会让回滚安全性判断失效。
 */
function readUserVersion(file: string): number | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      if (readSync(fd, buf, 0, 4, SQLITE_USER_VERSION_OFFSET) !== 4) return null
      return buf.readUInt32BE(0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** 单个 OpenClaw 数据库的 schema 版本 */
export interface SchemaVersionEntry {
  /** 相对 config/.openclaw 的路径（正斜杠），便于日志与断言定位 */
  file: string
  /** `PRAGMA user_version`；读不到时为 null */
  version: number | null
}

/**
 * 更新流程「要不要回滚」的决策。
 *
 * 抽成纯函数是因为这条判断出过一次代价很大的错：最初拿「本次 doctor 有没有改动
 * schema」当唯一判据（dataMigrated），它只在**第一次**失败时成立 —— 环境若已被
 * 上一次失败迁到一半（state 库升到 19、旧二进制只支持 17），再跑一次会因为
 * 「这次没变化」被判成安全，回滚后新旧版本都起不来，且备份已被消费，应用再也
 * 救不回来。所以 maintenanceRequired 也必须单独挡住。
 *
 * 注意回滚是**单向**的（_restoreOpenClawSnapshot 会先 rmSync 掉新版本的
 * node_modules），一旦滚错就没有「再滚回来」的机会，判据必须偏保守。
 */
export function decideRollback(
  probe: StartupProbeResult,
  dataMigrated: boolean
): { rollback: boolean; reason: string } {
  if (probe.ok) return { rollback: false, reason: '新版本已就绪' }
  if (!probe.refused) return { rollback: false, reason: '证据不足（进程未自行退出）' }
  if (dataMigrated)
    return { rollback: false, reason: '本次更新迁移过数据库，旧版本将无法读取当前数据' }
  if (probe.maintenanceRequired)
    return {
      rollback: false,
      reason: '数据待迁移：无法确认旧版本能读当前库（可能已被历史更新迁移过），回滚风险过高'
    }
  return { rollback: true, reason: '进程自行退出，且数据未被动过' }
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
const execFileAsync = promisify(execFile);

/**
 * 异步判断路径是否存在。用于启动期热路径，替代同步 existsSync，
 * 避免在主进程事件循环上阻塞（U 盘/exFAT 上单次 stat 延迟较大）。
 */
const pathExists = (p: string): Promise<boolean> =>
  fs.access(p).then(() => true).catch(() => false);

export class ClawManager extends EventEmitter {
  private process: ChildProcess | null = null
  private logs: LogEntry[] = []
  private maxLogs = 2000
  private startedAt?: number
  private port = 3213
  private configManager: ConfigManager
  private isStopping = false
  // 网关退出码 78（状态库需要 schema 迁移）时的自动修复状态
  private maintenanceAutoFixInFlight = false
  private maintenanceAutoFixUsed = false
  private maintenanceMarkerSeen = false
  private healthyResetTimer?: ReturnType<typeof setTimeout>
  // probeStartup 进行中：期间禁止退出码 78 触发自动 doctor，决策权交给探针调用方
  private probeInFlight = false
  /** resources/ 根路径（dev/打包双路径，定位 list-node-starts.ps1）；可选 */
  private resourcesRoot?: string

  constructor(configManager: ConfigManager, resourcesRoot?: string) {
    super()
    this.configManager = configManager
    this.resourcesRoot = resourcesRoot
  }

  async _killGhostProcesses(dataDir: string) {
    if (process.platform !== "win32") return

    // 三路清理互不依赖，并行执行以缩短启动前等待。
    await Promise.all([
      ...["bun.exe", "openclaw.exe"].map((name) => this._killByImageName(name)),
      this._killGhostNodeGateways(dataDir)
    ])
    console.log("🧹 僵尸进程清理尝试完毕。")
  }

  /**
   * 按命令行精确清理残留网关进程。
   *
   * 为什么不能像 bun/openclaw 那样按镜像名杀：真实网关是 **node.exe**
   * （spawn 的是数据目录里的便携 node + openclaw/dist/index.js），而用户机器上
   * 通常同时跑着别的 node（开发服务、Electron 辅助进程、其它工具），
   * `taskkill /im node.exe` 会把这些一并杀掉。
   *
   * 判据取「命令行里出现本数据目录的 openclaw 入口」：既是残留网关的充要特征，
   * 也天然排除了别的实例和无关 node 进程。
   *
   * 残留网关不清掉的话，它会占住状态目录，新网关起来后会以退出码 78
   * （Another gateway already owns this state directory）自退 —— 而这正是
   * probeStartup 判定「新版本起不来」的正面证据，会把正常的新版本回滚掉。
   */
  private async _killGhostNodeGateways(dataDir: string): Promise<void> {
    // 命令行里的路径是反斜杠，统一成正斜杠再比较（Windows 路径不区分大小写）
    const needle = toPosix(openClawPaths.clawJs(dataDir)).toLowerCase()
    // PowerShell 单引号串里只需把 ' 翻倍转义
    const psNeedle = needle.replace(/'/g, "''")

    // 用 execFile 而不是 exec：整段脚本作为一个 argv 传进去，
    // 不经过 cmd.exe，省掉一层引号转义（PS 脚本里 -Filter 的双引号在 cmd 下会被吃掉）。
    // 脚本内部只用单引号，避免与 Node 在 Windows 上的 argv 引号处理打架。
    const script =
      `$n='${psNeedle}'; ` +
      `Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Replace('\\','/').ToLower().Contains($n) } | ` +
      `ForEach-Object { $_.ProcessId }`

    let stdout: string
    try {
      const res = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script])
      stdout = res.stdout
    } catch (e: any) {
      // 清理是 best-effort：查不到（无 node 进程时 Get-CimInstance 无输出、
      // 或 PowerShell 不可用）都不该阻断启动。
      console.warn('清理残留网关进程时发生非预期错误:', e?.message)
      return
    }

    const pids = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
    if (!pids.length) return

    // /t 连子进程一起收掉，避免网关的 sidecar 残留
    await Promise.all(
      pids.map(async (pid) => {
        try {
          await execFileAsync('taskkill', ['/f', '/t', '/pid', pid])
          console.log(`🧹 已清理残留网关进程 pid=${pid}`)
        } catch (e: any) {
          console.warn(`清理残留网关进程 pid=${pid} 失败:`, e?.message)
        }
      })
    )
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

  async start(): Promise<{ success: boolean; error?: string; warning?: string }> {
    console.log('启动 OpenClaw...', new Date().toISOString())

    if (this.process) {
      return { success: false, error: 'OpenClaw 已在运行中' }
    }

    this.maintenanceMarkerSeen = false

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

    // 清理要在确认运行时/核心库存在之后：两者都缺时启动本来就发不出去，
    // 没必要为此去扫进程、更没必要误伤别的实例。
    await this._killGhostProcesses(dataDir)

    const targetConfigDir = toPosix(openClawPaths.configDir(dataDir))

    // 启动前同步 openclaw.json：凭证、激活模型、渠道等以 configManager 为唯一真相源，
    // 避免此前在本类内重复实现（且曾用 p.id 取 OFFICIAL_MODEL_PRESETS 导致死分支）。
    try {
      this.configManager.syncOpenClawConfig()
    } catch (err: any) {
      return { success: false, error: `配置初始化失败: ${err.message}` }
    }

    // 启动前主动修复受管插件的 openclaw peerDependency junction 链接。
    // OpenClaw 新版会审计每个插件目录下的 node_modules/openclaw 是否真实指向核心包（realpath 相等），
    // 否则报 missing-openclaw-peer-link 并拒绝启动。这里提前把链接补建好。
    // best-effort：在支持链接的卷（NTFS）上尽量把真实 junction 补好；失败不阻断启动（见下方 checkpoint 兜底）。
    const peerLinkWarning = await this._repairManagedPluginPeerLinks(dataDir)
    if (peerLinkWarning) {
      // 链接补建失败（多为 U 盘/exFAT 等不支持 junction 的卷）：
      // 写进日志面板，并作为 warning 带回前端提示用户（不阻断启动）。
      this._addLog(peerLinkWarning, 'stderr')
    }
    // 关键根治：直接写入启动迁移 checkpoint，让 OpenClaw 跳过会因 peer-link 失败而
    // 拒绝启动的审计。这对任何磁盘/任何文件系统（含 U 盘 exFAT/FAT32/UNC）都有效。
    await this._markStartupMigrationsComplete(dataDir)

    const commonEnv = buildOpenClawEnv(dataDir, nodePath, {
      PORT: String(this.port),
      OPENCLAW_DISABLE_BONJOUR: '1',
      BONJOUR_DISABLE: '1',
      OPENCLAW_GATEWAY_MODE: 'local',
      GATEWAY_MODE: 'local',
      gateway__mode: 'local',
      NODE_CONFIG_DIR: targetConfigDir
    })

    const providerEnv: Record<string, string> = {}
    if (activeProvider) {
      if (!activeProvider.apiKey && activeProvider.id !== 'custom') {
        return { success: false, error: `${activeProvider.name} API Key 未配置` }
      }
      providerEnv.OPENAI_API_KEY = activeProvider.apiKey || ''
      providerEnv.OPENAI_BASE_URL = activeProvider.baseUrl ?? ''

      // 同时写一份以服务商安全 key 命名的环境变量，便于 OpenClaw 内联 provider 识别。
      const envKeyBase = toOpenClawProviderKey(activeProvider.id)
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
      if (this.healthyResetTimer) clearTimeout(this.healthyResetTimer)
      this.healthyResetTimer = setTimeout(() => {
        // 持续健康运行 30s 后允许下一次退出码 78 再触发自愈
        if (this.process) this.maintenanceAutoFixUsed = false
      }, 30000)
      return { success: true, warning: peerLinkWarning || undefined }
    } catch (err: any) {
      this.process = null
      return { success: false, error: err.message }
    }
  }

  async stop(): Promise<{ success: boolean }> {
    if (this.healthyResetTimer) {
      clearTimeout(this.healthyResetTimer)
      this.healthyResetTimer = undefined
    }
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
    // 端口以当前配置为准（服务可能在 App 重启前就已启动、未走 start()，
    // this.port 会停留在陈旧默认值）；配置缺失才退回最近一次启动用端口
    const currentPort = Number(this.configManager.getConfig().port) > 0
      ? Number(this.configManager.getConfig().port)
      : this.port
    return {
      running: !!this.process,
      pid: this.process?.pid,
      port: currentPort,
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

  /**
   * 网关因状态库 schema 过旧拒绝启动（退出码 78 / maintenance_required）时的自愈：
   * 结束残留进程 -> 独立进程执行 doctor --fix（非交互）-> 自动重启。
   * 每次启动生命周期最多自愈一次，避免迁移失败时无限重启。
   */
  private async _autoFixMaintenance(): Promise<void> {
    if (this.maintenanceAutoFixInFlight || this.maintenanceAutoFixUsed) return
    this.maintenanceAutoFixInFlight = true
    // 先占标记再干活：重启后若仍报 78，由退出处理分支解除标记并提示用户手动重试，
    // 而不是立刻再跑一轮 doctor（单次 doctor 就要 1~2 分钟，会变成死循环）。
    this.maintenanceAutoFixUsed = true
    try {
      this._addLog('检测到 OpenClaw 状态库需要升级迁移（退出码 78），正在自动修复...', 'system')
      // 清理残留网关进程由 runDoctorFix 内部保证（prepareForDoctor），这里不再重复
      const result = await this.runDoctorFix()
      if (result.success) {
        this._addLog('状态库迁移完成，正在自动重启 OpenClaw...', 'system')
      } else {
        // doctor 非正常结束（被超时中止 / 退出码非 0）不等于迁移没做：
        // 它完全可能在完成 schema 迁移后，死在后续那些与本问题无关的检查上。
        // 所以照常重启一次，让「其实已经修好」的情况自愈；真的没修好时，
        // 重启后仍会以 78 退出，由退出处理分支兜底提示。
        this._addLog(
          `自动迁移未正常结束：${result.error || '未知错误'}。迁移可能已落盘，仍尝试直接重启；` +
            `若依旧无法启动，请点击「启动」重试，或在「环境初始化」页重试更新`,
          'stderr'
        )
      }
      await this.start()
    } catch (e: any) {
      this._addLog(`自动迁移异常：${e?.message || e}`, 'stderr')
    } finally {
      this.maintenanceAutoFixInFlight = false
    }
  }

  /**
   * 让 doctor 能进入维护模式：结束仍占着状态库的残留网关进程。
   *
   * 便携目录下 `gateway stop` 不可用，doctor 必须独占状态库。而 stop() 只杀直接
   * 子进程，网关派生出来的 worker 会活下来继续占着 agent 库 —— doctor 只能报
   * 「An agent database is in use」退出，迁移半途而废，留下「state 库已迁移、
   * agent 库没迁移」的半迁移状态，新旧版本都起不来（dev 环境实测过）。
   */
  async prepareForDoctor(): Promise<void> {
    const dataDir = this.configManager.getDataDir()
    await this._killGhostProcesses(dataDir)
    // 杀进程只释放 OS 文件句柄；agent_database_leases 是 **DB 记录**的应用级租约，
    // 网关被 taskkill /f 强杀后没机会释放，记录仍残留。不清掉的话 doctor 照样
    // 判「agent database is in use」拒绝进入维护模式（dev 实测 14 条历史租约堆积）。
    await this._cleanStaleAgentLeases(dataDir)
  }

  /**
   * doctor 前置清理：删除 state 库 agent_database_leases 中「owner 进程已死，
   * 或 PID 已被复用」的僵尸租约，并收尾 gateway_boot_lifecycle 中 owner 已死、
   * completed_at_ms 为空的启动记录。
   *
   * 判据是 owner_start_time 与进程**真实启动时间**是否一致：只查 PID 存活着会被
   * PID 复用骗过（实测一个 24 天前的租约 PID 被系统服务复用）。best-effort：
   * 失败不阻断 doctor，runDoctorFix 命中争用还有一次重试兜底。
   */
  private async _cleanStaleAgentLeases(dataDir: string): Promise<void> {
    const nodePath = this.configManager.getNodePath()
    const stateDbPath = join(openClawPaths.configDir(dataDir), 'state', 'openclaw.sqlite')
    if (!existsSync(stateDbPath)) return

    // 进程枚举走独立 .ps1 文件（list-node-starts.ps1），避免「node -e 内联
    // → cmd → powershell」多层引号转义。返回行：<pid>|<ISO启动时间>。
    const ps1 = this.resourcesRoot
      ? join(this.resourcesRoot, 'database', 'list-node-starts.ps1')
      : ''

    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      'const { execFileSync } = require("node:child_process");',
      'const dbPath = process.argv[1];',
      'const ps1Path = process.argv[2];',
      'const isWin = process.platform === "win32";',
      'function liveProcessStarts() {',
      '  const map = new Map();',
      '  let out = "";',
      '  try {',
      '    if (isWin) {',
      '      out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path], { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });',
      '    } else {',
      '      out = execFileSync("sh", ["-c", "ps -eo pid,lstart"], { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });',
      '    }',
      '  } catch {}',
      '  for (const line of out.split(/\\r?\\n/)) {',
      '    let m;',
      '    if (isWin) {',
      '      m = line.trim().match(/^(\\d+)\\|(.+)$/);',
      '      if (m) map.set(Number(m[1]), Date.parse(m[2]));',
      '    } else {',
      '      m = line.trim().match(/^(\\d+)\\s+(.+)$/);',
      '      if (m) { const t = Date.parse(m[2]); if (Number.isFinite(t)) map.set(Number(m[1]), t); }',
      '    }',
      '  }',
      '  return map;',
      '}',
      'const starts = liveProcessStarts();',
      '// 本脚本自身就跑在 node.exe 里，枚举成功则 map 必含当前进程，size 不可能为 0；',
      '// size===0 只可能是枚举失败（ps1 被拦 / 路径为空）——此时无法证明 owner 已死，',
      '// 绝不能把所有租约当僵尸误删（那会夺走存活网关的租约），中止并以非 0 退出。',
      'if (starts.size === 0) {',
      '  console.error("process enumeration failed; lease cleanup aborted");',
      '  process.exit(3);',
      '}',
      'const db = new DatabaseSync(dbPath);',
      'let leases = [];',
      'try { leases = db.prepare("SELECT lease_id, owner_pid, owner_start_time FROM agent_database_leases").all(); } catch {}',
      'let removedLeases = 0;',
      'const delLease = db.prepare("DELETE FROM agent_database_leases WHERE lease_id = ?");',
      'for (const l of leases) {',
      '  const start = starts.has(l.owner_pid) ? starts.get(l.owner_pid) : null;',
      '  // 进程不存在(null)，或 PID 复用（真实启动时间与租约记录对不上）→ 僵尸租约',
      '  const stale = start === null || (l.owner_start_time && Math.abs(start - l.owner_start_time) > 5000);',
      '  if (stale) removedLeases += delLease.run(l.lease_id).changes;',
      '}',
      'let closedBoots = 0;',
      'try {',
      '  const boots = db.prepare("SELECT boot_id, pid FROM gateway_boot_lifecycle WHERE completed_at_ms IS NULL").all();',
      '  const updBoot = db.prepare("UPDATE gateway_boot_lifecycle SET completed_at_ms = CAST(unixepoch(\'subsec\')*1000 AS INTEGER), outcome = \'interrupted\', reason = \'owner process gone; stale lease cleaned before doctor\' WHERE boot_id = ?");',
      '  for (const b of boots) if (!starts.has(b.pid)) closedBoots += updBoot.run(b.boot_id).changes;',
      '} catch {}',
      'db.close();',
      'console.log(JSON.stringify({ totalLeases: leases.length, removedLeases, closedBoots }));'
    ].join('\n')

    try {
      const res = await execFileAsync(nodePath, ['-e', script, stateDbPath, ps1], {
        windowsHide: true,
        maxBuffer: 1024 *1024
      })
      const summary = String(res.stdout || '').trim()
      this._addLog(`doctor 前置租约清理完成：${summary || '无残留'}`, 'system')
    } catch (e: any) {
      const errText = e?.stderr ? String(e.stderr).slice(0, 200) : e?.message || ''
      this._addLog(`doctor 前置租约清理失败（可忽略）：${errText}`, 'stderr')
    }
  }

  /**
   * 读 OpenClaw 各数据库的 schema 版本，用于判断「doctor 有没有动过数据」。
   *
   * 为什么更新流程必须知道这件事：回滚快照里只有 node_modules / lock / npm，
   * **没有数据库**（见 downloadManager 的 _snapshotOpenClawForUpdate）。doctor 一旦
   * 迁移过 schema，旧二进制的 schema 门槛更低，读不了新库 —— 此时回滚不是恢复，
   * 而是把「新版本起不来」升级成「新旧都起不来」。dev 环境实测过这条死局：
   * state 库被升到 19，回滚到只支持 17 的旧版后，两边都拒绝启动。
   *
   * 比的是**前后是否变化**，所以半迁移（state 升了、agent 没升）也能被检出。
   */
  async readSchemaVersions(): Promise<SchemaVersionEntry[]> {
    const root = openClawPaths.configDir(this.configManager.getDataDir())
    const abs = [join(root, 'state', 'openclaw.sqlite'), ...this._agentDbPaths(root)]
    return Promise.all(
      abs.map(async (file) => ({
        file: relative(root, file).split(sep).join('/'),
        version: readUserVersion(file)
      }))
    )
  }

  /** 枚举各 agent 的数据库（config/.openclaw/agents/<id>/agent/openclaw-agent.sqlite） */
  private _agentDbPaths(root: string): string[] {
    const agentsDir = join(root, 'agents')
    let ids: string[]
    try {
      ids = readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
    return ids
      .map((id) => join(agentsDir, id, 'agent', 'openclaw-agent.sqlite'))
      .filter((p) => existsSync(p))
  }

  /**
   * 以独立子进程执行 `openclaw doctor --fix --non-interactive --yes`。
   * --non-interactive 只执行安全迁移，--yes 跳过所有确认提示，避免管道内挂死。
   *
   * 状态库独占这件事由本方法自己保证（先清残留进程，命中争用再清一次重试），
   * 不再推给调用方 —— 之前把「调用方必须保证没有其他 openclaw 进程占用状态库」
   * 写在注释里，更新流程就没照做，直接导致了半迁移死局。
   *
   * 超时给得非常宽松，且只作为兜底：本机实测一次「无事可做」的完整 doctor 就要 105s，
   * 若状态库需要 schema 迁移（如 agent 库 19→24），迁移大库还会额外耗时数分钟，
   * 且全程没有任何输出。曾用 180s 硬超时，结果把迁移到一半的 doctor 直接强杀：
   * 迁移其实已经落盘，却被判定为失败 —— 启动自愈因此放弃重启，
   * 更新流程更会据此回滚刚装好的新版本。宁可等久一点，也不能中途杀迁移。
   */
  async runDoctorFix(
    timeoutMs = 20 * 60 * 1000
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)
    if (!existsSync(nodePath)) return { success: false, error: '未找到 Node.js 运行时' }
    if (!existsSync(clawJsPath)) return { success: false, error: '未找到 OpenClaw 核心库' }

    const env = buildOpenClawEnv(dataDir, nodePath, {
      OPENCLAW_DISABLE_BONJOUR: '1',
      BONJOUR_DISABLE: '1'
    })

    await this.prepareForDoctor()
    const first = await this._runDoctorOnce(env, timeoutMs)
    if (first.success || !DOCTOR_CONTENTION_RE.test(first.output || '')) return first

    // 争用是竞态：刚清完仍可能被别的 openclaw 进程占住（用户手动开的实例、
    // 上一轮 doctor 没退干净的 worker）。明确命中争用提示时再清一次重试，
    // 而不是把半迁移状态丢给探针 —— 探针只会把它误读成「新版本起不来」。
    this._addLog('doctor 报告状态库被占用，清理残留进程后重试一次...', 'system')
    await this.prepareForDoctor()
    return this._runDoctorOnce(env, timeoutMs)
  }

  /** doctor 的单次执行（不做清理 / 不重试），供 runDoctorFix 调用 */
  private _runDoctorOnce(
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)

    this._addLog('正在执行 openclaw doctor --fix（非交互模式）...', 'system')

    return new Promise((resolve) => {
      let output = ''
      let settled = false
      const finish = (result: { success: boolean; output?: string; error?: string }) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      try {
        const child = execFile(
          nodePath,
          [clawJsPath, 'doctor', '--fix', '--non-interactive', '--yes'],
          {
            cwd: openClawPaths.installDir(dataDir),
            env,
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024
          }
        )
        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString()
          output += text
          text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((l) => this._addLog(`[doctor] ${l}`, 'stdout'))
        })
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString()
          output += text
          text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((l) => this._addLog(`[doctor] ${l}`, 'stderr'))
        })
        const timeoutError = (signal?: string | null) =>
          `doctor 超过 ${Math.round(timeoutMs / 60000)} 分钟仍未结束，已被中止` +
          `（signal=${signal ?? 'unknown'}）。状态库很大时迁移耗时较长属正常，可稍后重试。`
        child.on('error', (err: any) => {
          // 超时兜底触发时 Node 会以 ETIMEDOUT/killed 抛错，给出可读原因而不是裸 err.message
          if (err?.killed || err?.code === 'ETIMEDOUT') {
            finish({ success: false, output, error: timeoutError(err?.signal) })
            return
          }
          finish({ success: false, output, error: err.message })
        })
        child.on('exit', (code, signal) => {
          if (code === 0) {
            this._addLog('[doctor] 修复执行完成', 'system')
            finish({ success: true, output })
          } else if (code === null) {
            // code=null 表示被信号终止（即上面的超时兜底），而非 doctor 自己返回的退出码
            finish({ success: false, output, error: timeoutError(signal) })
          } else {
            finish({ success: false, output, error: `doctor 退出码 ${code}` })
          }
        })
      } catch (e: any) {
        finish({ success: false, output, error: e.message })
      }
    })
  }

  /**
   * 更新流程的「新版本到底能不能启动」探针 —— 用来替代 doctor 退出码作回滚判据。
   *
   * 为什么不能只看 doctor：doctor 会在完成 schema 迁移**之后**，因为与迁移无关的检查
   * （插件白名单过期、memory provider 没配 key 等）非 0 退出。拿它决定回滚，
   * 会把迁移其实成功、版本完全可用的新包误回滚掉。
   *
   * 探针本身无持久化副作用：网关遇到旧 schema 是**拒绝启动**（退 78），
   * 不会自己去改 schema，所以「启动一次看看」是安全的。
   *
   * 判定用「进程退出 vs 就绪」竞速，而不是固定超时：本机实测成功路径约 6s 就监听端口，
   * 而 schema 拒绝要约 65s 才退 78；现成就绪轮询预算（90s）和 65s 贴得太近，容易误判。
   * 进程一退出就立刻下结论，既快又准。
   *
   * `refused` 的判据被刻意收窄成「**进程确实起来了、又自己退出了**」：
   * start() 的前置失败（未配 API Key、配置同步失败、找不到运行时…）一律算 inconclusive。
   * 那些原因说明的是「这次启动没发起」，与「新版本能不能跑」无关，
   * 若也算成证据，用户没配 API Key 就会把正常的新版本回滚掉。
   *
   * @param readyProbe 单次就绪探测（由调用方注入，避免 ClawManager 依赖 Gateway HTTP 客户端）
   */
  async probeStartup(
    readyProbe: () => Promise<boolean>,
    budgetMs = 150000,
    pollMs = 1000
  ): Promise<StartupProbeResult> {
    const started = await this.start()
    // start() 的前置失败是**异质**的：未找到 Node/核心库是环境问题，
    // 未配置 API Key、配置同步失败是用户配置问题 —— 说的都是「这次启动没发起」，
    // 而不是「新版本起不来」。拿它回滚，会把「用户没填 API Key」这种与新版本
    // 好坏无关的问题，变成一次破坏性的版本回滚。
    // 严格按「只有进程自行退出才算证据」的原则，这里一律归 inconclusive。
    // （'OpenClaw 已在运行中' 会返回 success:false 但 this.process 非空，照常进就绪轮询）
    if (!started.success && !this.process) {
      return {
        ok: false,
        refused: false,
        inconclusive: true,
        maintenanceRequired: false,
        reason: `启动未能发起：${started.error || '未知原因'}`
      }
    }
    const proc = this.process
    if (!proc) {
      // start() 报成功却没有进程句柄：内部状态不一致，同样不是「进程自行退出」的证据
      return {
        ok: false,
        refused: false,
        inconclusive: true,
        maintenanceRequired: false,
        reason: '启动返回成功但未持有进程句柄'
      }
    }

    // 用 holder 而不是裸 let：TS 的控制流分析看不到闭包里的赋值，
    // 裸 let 会被一路收窄成 null（never）。属性访问则会在函数调用后失效，不会收窄。
    const exitState: { value: { code: number | null; signal: string | null } | null } = {
      value: null
    }
    const onExit = (code: number | null, signal: string | null) => {
      exitState.value = { code, signal }
    }
    proc.once('exit', onExit)

    // 探针期间由本方法决策，禁止退出处理分支再触发一轮 doctor
    this.probeInFlight = true
    const deadline = Date.now() + budgetMs
    try {
      while (Date.now() < deadline) {
        if (exitState.value) break
        let ready = false
        try {
          ready = await readyProbe()
        } catch {
          ready = false
        }
        if (ready) {
          return {
            ok: true,
            refused: false,
            inconclusive: false,
            maintenanceRequired: false,
            reason: '就绪'
          }
        }
        if (exitState.value) break
        await new Promise((r) => setTimeout(r, pollMs))
      }
    } finally {
      this.probeInFlight = false
      proc.off('exit', onExit)
    }

    const finalExit = exitState.value
    if (finalExit) {
      // 78 / 迁移提示说明是**数据**条件（库比新版本旧），不是新版本自身有缺陷。
      // 这个区分只影响文案与补救动作；回滚安不安全由「数据有没有被真迁移过」决定。
      const maintenanceRequired = finalExit.code === 78 || this.maintenanceMarkerSeen
      return {
        ok: false,
        refused: true,
        inconclusive: false,
        exitCode: finalExit.code,
        maintenanceRequired,
        reason: maintenanceRequired
          ? `网关因状态库需要迁移而自退（code=${finalExit.code}）`
          : `网关启动后自行退出（code=${finalExit.code}, signal=${finalExit.signal}）`
      }
    }
    return {
      ok: false,
      refused: false,
      inconclusive: true,
      maintenanceRequired: this.maintenanceMarkerSeen,
      reason: `网关在 ${(budgetMs / 1000).toFixed(budgetMs < 10000 ? 1 : 0)}s 内未就绪，但进程仍在运行`
    }
  }

  private _setupProcessEvents(): void {
    if (!this.process) return

    this.process.stdout?.on('data', (data: Buffer) => {
      const rawChunk = data.toString()

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
        if (/schema migration required|maintenance_required|run openclaw doctor --fix/i.test(line)) {
          this.maintenanceMarkerSeen = true
        }
      })
    })

    this.process.on('exit', (code, signal) => {
      this._addLog(`OpenClaw 进程退出 (code=${code}, signal=${signal})`, 'system')
      if (this.process) {
        this.process = null
        this.startedAt = undefined
        this.emit('statusChange', false)
      }
      // 退出码 78（EX_CONFIG）或本生命周期内出现过迁移提示：自动 doctor --fix 后重启，每次启动最多一次
      const needsMaintenance =
        code === 78 || (typeof code === 'number' && code !== 0 && this.maintenanceMarkerSeen)
      if (needsMaintenance) {
        // 探针期间决策权归 probeStartup 的调用方（回滚 / 保留由它定），
        // 这里不要插一轮 doctor，否则会和探针抢状态库、并拖长更新流程。
        if (this.probeInFlight) return
        if (this.maintenanceAutoFixUsed) {
          // 本轮已经 doctor 过一次仍然起不来：不再自动重跑（否则就是
          // 「doctor 1~2 分钟 → 重启 → 78」的死循环）。这里只解除标记，
          // 让用户下一次手动点「启动」时还能再自愈一轮，并明确告诉他下一步做什么。
          this.maintenanceAutoFixUsed = false
          this._addLog(
            '状态库迁移后仍无法启动，已暂停自动修复。请点击「启动」重试，或手动运行 openclaw doctor --fix 查看详情。',
            'stderr'
          )
          return
        }
        void this._autoFixMaintenance()
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
  private async _markStartupMigrationsComplete(dataDir: string): Promise<void> {
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

      try {
        // execFile 默认捕获 stderr（失败时挂在 error.stderr 上），无需 stdio 配置；
        // windowsHide 避免闪现控制台窗口。
        await execFileAsync(nodePath, ['-e', script, stateDbPath, version, String(now)], {
          windowsHide: true
        })
        this._addLog(`已写入启动迁移 checkpoint (v${version})，跳过插件链接审计`, 'system')
      } catch (e: any) {
        const errText = e?.stderr ? String(e.stderr).slice(0, 200) : (e?.message || '')
        this._addLog(`写入启动迁移 checkpoint 失败: ${errText}`, 'stderr')
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
  private async _repairManagedPluginPeerLinks(dataDir: string): Promise<string | null> {
    const hostRoot = join(dataDir, 'openclaw', 'node_modules', 'openclaw')
    if (!(await pathExists(join(hostRoot, 'package.json')))) {
      // 核心包不在预期位置，交给后续流程处理，不在此拦截。
      return null
    }

    let expectedTarget = hostRoot
    try {
      expectedTarget = await fs.realpath(hostRoot)
    } catch { /* ignore */ }

    const projectsDir = join(openClawPaths.configDir(dataDir), 'npm', 'projects')
    if (!(await pathExists(projectsDir))) return null

    const failures: string[] = []

    const listPluginDirs = async (): Promise<string[]> => {
      const result: string[] = []
      let projectEntries: string[] = []
      try {
        projectEntries = await fs.readdir(projectsDir)
      } catch {
        return result
      }
      for (const project of projectEntries) {
        const nm = join(projectsDir, project, 'node_modules')
        let entries: string[] = []
        try {
          entries = await fs.readdir(nm)
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry === '.bin' || entry.startsWith('.')) continue
          const entryPath = join(nm, entry)
          if (entry.startsWith('@')) {
            let scoped: string[] = []
            try {
              scoped = await fs.readdir(entryPath)
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

    const declaresOpenClawPeer = async (pluginDir: string): Promise<boolean> => {
      try {
        const pkg = JSON.parse(await fs.readFile(join(pluginDir, 'package.json'), 'utf-8'))
        return Boolean(pkg.peerDependencies && typeof pkg.peerDependencies === 'object' && 'openclaw' in pkg.peerDependencies)
      } catch {
        return false
      }
    }

    for (const pluginDir of await listPluginDirs()) {
      if (!(await declaresOpenClawPeer(pluginDir))) continue

      const nodeModulesDir = join(pluginDir, 'node_modules')
      const linkPath = join(nodeModulesDir, 'openclaw')

      // 已正确指向则跳过（realpath 对不存在/失效链接会抛错，自动落入重建分支）。
      try {
        if (await fs.realpath(linkPath) === expectedTarget) continue
      } catch { /* fallthrough to rebuild */ }

      // 重建：先清掉旧的（拷贝目录/失效链接都清），再建 junction。
      try {
        await fs.mkdir(nodeModulesDir, { recursive: true })
      } catch { /* ignore */ }
      // force:true 让路径不存在时也不报错；recursive 兼容旧的是目录而非链接的情况。
      try {
        await fs.rm(linkPath, { recursive: true, force: true })
      } catch { /* ignore */ }

      try {
        await fs.symlink(hostRoot, linkPath, 'junction')
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
}
