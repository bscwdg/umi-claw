import { EventEmitter } from 'events'
import { ChildProcess, spawn, exec, execFile } from 'child_process'
import { dirname, join, relative, resolve, sep } from 'path'
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  unlinkSync
} from 'fs'
import { promises as fs } from "fs";
import { ConfigManager } from './configManager'
import { promisify } from "util";
import { get as httpGet } from 'node:http'
import {
  appendStartupDuration,
  estimateStartupMs,
  parseStartupStats,
  serializeStartupStats
} from './startupStats'
import { connect as netConnect } from 'node:net'
import { toOpenClawProviderKey } from './modelConfig'
import { openClawPaths, toPosix, buildOpenClawEnv } from './openClawPaths'

export interface ClawStatus {
  running: boolean
  pid?: number
  port: number
  uptime?: number
  startedAt?: number
  /** doctor --fix / 状态库迁移进行中（网关未起但非静止） */
  maintenance?: boolean
  /** 进程已起但 `/health` 还没通（启动中） */
  starting?: boolean
  /** 网关真正可用（`/health` 200） */
  ready?: boolean
  /** 就绪时刻（毫秒时间戳），未就绪为空 */
  readyAt?: number
  /** 最近一次「spawn→就绪」耗时（毫秒），便于前端/日志展示 */
  startupMs?: number
  /** 启动阶段（前端展示「现在在等什么」）：preparing/spawning/loading/ready */
  bootPhase?: BootPhase
  /** 依据最近几次启动历史估算的总耗时（毫秒），用于 UI「预计还需 N 秒」 */
  estimateStartupMs?: number
}

/** 启动阶段：preparing=主进程准备（清理/patch/doctor）；spawning=已拉起进程；loading=端口已监听、插件/渠道加载中 */
export type BootPhase = 'idle' | 'preparing' | 'spawning' | 'loading' | 'ready'

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
  /**
   * 网关「真正可用」标记（`GET /health` 返回 200）。
   *
   * 注意：`startedAt` 只表示**进程已 spawn**，此时 openclaw 还要加载插件/渠道/状态库
   * （实测可达数分钟）。前端/UI 必须用 `ready` 判断「能不能开网页」，不能用 `running`。
   */
  private ready = false
  private readyAt?: number
  /** 后台探活进行中：停止/退出后置 true，避免旧探针继续改状态 */
  private readyProbeStopped = false
  /** 探活代际：每次 stop/spawn 自增；旧代际的探针结果一律丢弃（防重启窗口串台） */
  private readyProbeSeq = 0
  /** 当前启动阶段（见 BootPhase） */
  private bootPhase: BootPhase = 'idle'
  /** 最近几次「spawn→health」耗时（毫秒），用于估算 ETA */
  private startupDurations: number[] = []
  private startupStatsLoaded = false
  /** 本次 spawn 是否已记过耗时（探针与 waitReady 可能同时完成，避免重复记录） */
  private startupDurationRecorded = false
  /** 上次退出时留在后台的网关 PID（非本实例子进程，停止用 taskkill） */
  private adoptedPid?: number
  /** 本次实例是否以 detached + 文件日志方式启动（退出保留网关的前提） */
  private detachedChild = false
  /** 文件日志 tail（detached 模式下 stdout/stderr 分别写文件，面板从文件取日志） */
  private logTailTimer?: ReturnType<typeof setInterval>
  private logTails: Array<{
    file: string
    type: 'stdout' | 'stderr'
    offset: number
    carry: string
  }> = []
  /** 复用后台网关后的低频健康巡检 */
  private adoptedHealthTimer?: ReturnType<typeof setInterval>
  /** 退出处理幂等标记（quitApp 与 before-quit 都会调用 handleAppQuit） */
  private quitHandled = false
  private configManager: ConfigManager
  private isStopping = false
  // 网关退出码 78（状态库需要 schema 迁移）时的自动修复状态
  private maintenanceAutoFixInFlight = false
  private maintenanceAutoFixUsed = false
  private maintenanceMarkerSeen = false
  private healthyResetTimer?: ReturnType<typeof setTimeout>
  // probeStartup 进行中：期间禁止退出码 78 触发自动 doctor，决策权交给探针调用方
  private probeInFlight = false
  /**
   * 进行中的启动 Promise：并发 start() 归并到同一次 spawn。
   * 旧实现在「检查 this.process」与「真正 spawn」之间隔着多个 await，
   * 更新探针与退出码 78 自愈同时启动时两边都会 spawn，先 spawn 成功的
   * 句柄还会被后退出者的 exit 处理清掉 —— 网关实际在跑，App 却显示已停止。
   */
  private startInFlight: Promise<{ success: boolean; error?: string; warning?: string }> | null = null
  /** 进行中的 doctor：并发调用（更新流程 / 退出码 78 自愈）共享同一次执行，绝不并发迁移同一状态库 */
  private doctorInFlight: Promise<{ success: boolean; output?: string; error?: string }> | null = null
  /**
   * 维护模式互斥锁：覆盖「prepareForDoctor（杀残留进程+清僵尸租约）+ 跑 doctor」整个临界区。
   * doctorInFlight 只挡住同时调 runDoctorFix 的并发，挡不住 index.ts 更新链路直接调 prepareForDoctor——
   * 那路会在另一路 doctor 正在跑时 taskkill 掉它（doctor 进程与网关命令行特征相同），造成互相残杀、
   * 状态库锁来回易手（holder 18032→7476），没有一路能跑完。所有需要独占状态库的入口统一走这把锁。
   */
  private maintenanceMutex: Promise<void> = Promise.resolve()
  /** 维护模式进行中标记：供前端把「启动中」细化为「正在修复配置/迁移数据库」 */
  private maintenanceActive = false

  /**
   * 维护模式是否进行中（杀残留进程 / doctor --fix / 状态库迁移）。
   * 供 IPC 透到前端：doctor 阶段网关虽未起，但也不是静止，应显示「正在修复配置…」。
   */
  isMaintenanceActive(): boolean {
    return this.maintenanceActive
  }

  /**
   * 在维护互斥锁内执行 fn：同一时刻只有一路能「杀残留进程 + 跑 doctor」。
   * 后来者在锁外排队（而不是并行杀进程），避免互相 taskkill。
   * 锁内维护 maintenanceActive 标记，fn 结束（无论成败）即复位。
   */
  private _withMaintenanceLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.maintenanceActive = true
      // 主动推一次状态：doctor 期间 running 不变、不触发 statusChange，
      // 前端靠这次推送把「已停止」实时细化成「修复中」，避免以为卡死重复点击。
      this.emit('statusChange', !!this.process, this.port)
      try {
        return await fn()
      } finally {
        this.maintenanceActive = false
        this.emit('statusChange', !!this.process, this.port)
      }
    }
    // 链式排队：把本次执行挂到上一把锁之后，无论上一把成败都继续（finally 语义）。
    const result = this.maintenanceMutex.then(run, run)
    // maintenanceMutex 只跟踪「锁是否空闲」，不关心 fn 的成败/返回值；吞掉 rejection 防止未处理。
    this.maintenanceMutex = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  /** resources/ 根路径（dev/打包双路径，定位 list-node-starts.ps1）；可选 */
  private resourcesRoot?: string

  /**
   * 语音 TTS 环境变量提供器（由主进程在语音初始化后注入）。
   * 密钥只走环境变量，不进 openclaw.json —— 见 configManager._injectOpenClawTts。
   */
  private voiceTtsEnvProvider: (() => Promise<Record<string, string>>) | null = null

  constructor(configManager: ConfigManager, resourcesRoot?: string) {
    super()
    this.configManager = configManager
    this.resourcesRoot = resourcesRoot
  }

  /** 注入语音 TTS 环境变量提供器（关闭对话内语音或没密钥时返回空对象）。 */
  setVoiceTtsEnvProvider(fn: (() => Promise<Record<string, string>>) | null): void {
    this.voiceTtsEnvProvider = fn
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
   * 清理 OpenClaw 插件隔离副本（tmp/plugin-captures/<uuid>）的历史残留。
   *
   * 背景：OpenClaw 每个新进程启动前都会把渠道插件整体复制到该目录做隔离加载，
   * 而飞书插件自带数千个 node_modules 小文件。短命 CLI（config patch / doctor）
   * 退出后来不及回收，实测堆积十余个副本、占用 1GB+；副本越多，OpenClaw 启动时
   * 自己的目录巡检也越慢，是冷启动从十几秒劣化到数分钟的原因之一。
   *
   * 安全前提（比「杀完幽灵进程」更严格，因为那是必要不充分条件）：
   *  1. `_killGhostNodeGateways` 刻意**不杀** doctor / config patch（它们同样会用到
   *     captures 目录），非 Windows 上整个 `_killGhostProcesses` 更是空操作。
   *     `start()` 又不走维护互斥锁——维护任务在途（退出码 78 自愈、更新链路）时
   *     用户完全可能点「启动」。所以这里必须自己看维护闸：维护在途直接跳过。
   *  2. 只处理 UUID 形态（或本方法上一轮改名残留的 `.stale-` 前缀）的直接子目录。
   *  3. **先 rename 再 rm**（与官方回收实现同口径）：UUID 目录被 OpenClaw 视为
   *     带 owner token 的活跃副本，原地 rm 半途失败会留下一个「看起来合法、实际残缺」
   *     的副本；改成 `.stale-` 前缀后，即使删除失败，下次启动也只会被本方法继续清理，
   *     不会当成有效副本加载。
   *
   * best-effort：删除失败（占用/权限）只记日志，绝不阻断启动。
   */
  private async _cleanStalePluginCaptures(dataDir: string): Promise<void> {
    // 维护任务在途时跳过：doctor / config patch / 更新链路都在用同一个 captures 目录，
    // 而 _killGhostProcesses 不会（也不该）杀它们。
    if (this.maintenanceActive || this.doctorInFlight || this.maintenanceAutoFixInFlight) {
      this._addLog('维护任务进行中，跳过插件隔离副本清理（避免误删在用副本）', 'system')
      return
    }
    // 非 Windows 上前面的幽灵进程清理是空操作，「已无 openclaw 进程」不成立，
    // 不做无条件删除（该目录堆积是 Windows 便携环境的实测问题）。
    if (process.platform !== 'win32') return

    const STALE_PREFIX = '.stale-'
    try {
      const capturesDir = join(openClawPaths.configDir(dataDir), 'tmp', 'plugin-captures')
      if (!existsSync(capturesDir)) return
      const uuidDirRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const entries = await fs.readdir(capturesDir, { withFileTypes: true })
      const staleNames = entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            (uuidDirRe.test(entry.name) || entry.name.startsWith(STALE_PREFIX))
        )
        .map((entry) => entry.name)

      let removed = 0
      let skipped = 0
      // 串行处理：Windows 上数万小文件的递归删除本身就慢，并发只会加剧磁盘争用。
      // 全部走异步 fs：同步 rmSync 会冻结事件循环，期间所有 IPC 与「启动中」UI 全部卡死。
      for (const name of staleNames) {
        const original = join(capturesDir, name)
        // 已是上一轮改名残留的目录直接删；UUID 目录先改名。
        const target = name.startsWith(STALE_PREFIX) ? original : join(capturesDir, STALE_PREFIX + name)
        try {
          if (target !== original) await fs.rename(original, target)
          await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
          removed++
        } catch (e: any) {
          // 占用 / 权限：保留原状（UUID 目录名字不变，下次启动仍会被识别为待清理候选）
          skipped++
          console.warn(`[ClawManager] 清理插件隔离副本失败（跳过）: ${name}`, e?.message || e)
        }
      }
      if (removed > 0) {
        this._addLog(`已清理 ${removed} 个插件隔离副本残留（tmp/plugin-captures）`, 'system')
      }
      if (skipped > 0) {
        this._addLog(
          `${skipped} 个插件隔离副本仍被占用，已跳过（不影响本次启动，下次启动会重试）`,
          'system'
        )
      }
    } catch (e: any) {
      this._addLog(`插件隔离副本清理失败（可忽略）：${e?.message || e}`, 'stderr')
    }
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
    //
    // 关键：只杀「网关本体」，不能杀同特征的其他子命令进程。真实网关命令行是
    //   node <clawJs> gateway --port ...
    // 而 doctor（node <clawJs> doctor --fix）/ config patch（node <clawJs> config patch）
    // 命令行同样含 clawJs 路径——不排除会把正在跑的 doctor / 用户手动开的维护进程
    // 当僵尸网关 taskkill 掉（这正是并发 doctor 互相残杀、状态库锁来回易手的根源）。
    // 判据收紧为「含 clawJs 且含 gateway 子命令」，显式排除 doctor / config patch。
    const script =
      `$n='${psNeedle}'; ` +
      `Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | ` +
      `Where-Object { $cl=$_.CommandLine; if(-not $cl){$false}else{$cl=$cl.Replace('\\','/').ToLower(); $cl.Contains($n) -and $cl.Contains('gateway') -and -not $cl.Contains('doctor') -and -not $cl.Contains('config patch')} } | ` +
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

  /**
   * 启动网关（可重入）：已在运行 / 启动在途时直接归并，绝不 spawn 第二个。
   * 真正的 spawn 在 _spawnGateway，同一时刻只允许一个 in-flight。
   */
  async start(): Promise<{ success: boolean; error?: string; warning?: string }> {
    // 复用中的后台网关已就绪：不再 spawn（否则会撞端口/被 ghost 清理误杀）
    if (this.adoptedPid !== undefined) {
      return { success: true }
    }
    if (this.process) {
      return { success: false, error: 'OpenClaw 已在运行中' }
    }
    if (this.startInFlight) {
      console.log('启动已在进行中，归并到同一次启动')
      return this.startInFlight
    }
    // 提前进入「准备配置」阶段：spawn 之前还有 ghost 清理 / captures 回收 / 配置 patch / doctor，
    // 在慢环境里可能持续数分钟；前端据此显示「正在准备」而不是停在「已停止」。
    this._setBootPhase('preparing', '[gateway] 开始准备启动（清理残留 / 同步配置 / 检查插件）…')
    const inFlight = this._spawnGateway().finally(() => {
      if (this.startInFlight === inFlight) this.startInFlight = null
    })
    this.startInFlight = inFlight
    return inFlight
  }

  private async _spawnGateway(): Promise<{ success: boolean; error?: string; warning?: string }> {
    console.log('启动 OpenClaw...', new Date().toISOString())

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
      this._setBootPhase('idle')
      return { success: false, error: '未找到 Node.js 运行时，请先初始化环境' }
    }
    if (!existsSync(clawJsPath)) {
      this._setBootPhase('idle')
      return { success: false, error: '未找到 OpenClaw 核心库，请先初始化环境' }
    }

    // 清理要在确认运行时/核心库存在之后：两者都缺时启动本来就发不出去，
    // 没必要为此去扫进程、更没必要误伤别的实例。
    await this._killGhostProcesses(dataDir)
    // 已无 openclaw 进程：顺手回收插件隔离副本残留（实测能堆到 1GB+，还会拖慢启动巡检）
    await this._cleanStalePluginCaptures(dataDir)

    const targetConfigDir = toPosix(openClawPaths.configDir(dataDir))

    // 启动前同步 openclaw.json：凭证、激活模型、渠道等以 configManager 为唯一真相源，
    // 避免此前在本类内重复实现（且曾用 p.id 取 OFFICIAL_MODEL_PRESETS 导致死分支）。
    // 启动前主动修复受管插件的 openclaw peerDependency junction 链接。
    // OpenClaw 新版会审计每个插件目录下的 node_modules/openclaw 是否真实指向核心包（realpath 相等），
    // 否则报 missing-openclaw-peer-link 并拒绝启动。这里提前把链接补建好。
    // best-effort：在支持链接的卷（NTFS）上尽量把真实 junction 补好；失败不阻断启动（见下方 checkpoint 兜底）。
    //
    // 顺序说明：peer-link 修复 + checkpoint 必须在下方 doctor 闸门**之前**完成（两者均幂等）。
    // 原因：checkpoint 的唯一作用是让 OpenClaw 跳过在 exFAT/FAT32/UNC/U 盘上会失败的 peer-link 审计，
    // 而 doctor --fix 自身也做同样的插件收敛——若「不支持 junction 的卷 + 配置恰好非法」叠加，
    // doctor 会在没有 checkpoint、链接也没补的情况下失败，把原本靠 checkpoint 能启动的场景拦下。
    const peerLinkWarning = await this._repairManagedPluginPeerLinks(dataDir)
    if (peerLinkWarning) {
      // 链接补建失败（多为 U 盘/exFAT 等不支持 junction 的卷）：
      // 写进日志面板，并作为 warning 带回前端提示用户（不阻断启动）。
      this._addLog(peerLinkWarning, 'stderr')
    }
    // 关键根治：直接写入启动迁移 checkpoint，让 OpenClaw 跳过会因 peer-link 失败而
    // 拒绝启动的审计。这对任何磁盘/任何文件系统（含 U 盘 exFAT/FAT32/UNC）都有效。
    await this._markStartupMigrationsComplete(dataDir)

    // 启动前同步 openclaw.json：凭证、激活模型、渠道等以 configManager 为唯一真相源，
    // 避免此前在本类内重复实现（且曾用 p.id 取 OFFICIAL_MODEL_PRESETS 导致死分支）。
    // 写入一律走官方 config patch：被 schema 拒绝时绝不 spawn 网关（否则必 exit 78）。
    let syncResult = await this.configManager.syncOpenClawConfig()
    // patch 超时/进程错误（非 schema 拒绝）时不跑 doctor，仅作为启动 warning 透给前端
    let syncTransientWarning: string | undefined
    if (!syncResult.ok) {
      // 只有「CLI 正常退出但明确拒绝补丁」（schema 非法 / 退役键等）才允许 doctor 介入。
      // timeout / process 只说明这个短命 CLI 没跑完——冷启动时它要先复制渠道插件的
      // 数千个小文件（Windows + fs-safe 逐文件准入），实测可达数分钟，与配置是否合法无关。
      // 历史上这里对任何失败都无条件跑 doctor --fix：doctor 的复制量比 patch 更大还要
      // 逐文件哈希，慢环境下 20 分钟超时都跑不完，随后网关永远拉不起来（「启不起来」死局）。
      // 这类瞬时失败改为只告警、继续拉起网关；磁盘配置本身无效时网关会自行 exit 78，
      // 再由既有的退出码自愈链路决定是否 doctor。
      if (syncResult.kind === 'rejected') {
        this._addLog(
          'openclaw.json 未通过官方校验，正在运行 doctor --fix 自动收敛（可能需要数分钟，期间网关暂不启动）...',
          'system'
        )
        const doctor = await this.runDoctorFix()
        if (doctor.success) {
          // doctor --fix 就地收敛了磁盘上的 openclaw.json，但 ConfigManager 内存里的 this.config
          // 仍是加载时的旧快照。先 reloadFromDisk 重读（doctor 不碰 app.json，重读是防御性刷新），
          // 否则重试同步会基于旧快照重算 merge patch，把 doctor 刚修掉的退役键/旧结构重新写回去
          //（doctor 白跑，下次启动再触发 78）。
          syncResult = await this.configManager.syncOpenClawConfig({ reloadFromDisk: true })
        } else {
          return {
            success: false,
            error: `配置自动修复失败（doctor --fix 未成功）：${doctor.error || syncResult.error}`
          }
        }
        if (!syncResult.ok && syncResult.kind === 'rejected') {
          return { success: false, error: `openclaw.json 同步未通过官方校验，未启动网关：${syncResult.error}` }
        }
        if (syncResult.ok) {
          this._addLog('doctor 收敛完成，openclaw.json 已通过官方校验，继续启动网关。', 'system')
        } else {
          // doctor 已跑完，重试同步仍是超时/进程类瞬时失败：与主路径同口径，
          // 告警并继续拉起（doctor 已就地收敛磁盘配置，大概率可启动）；
          // 仍被 schema 拒绝的情况上面已中止，不会带病启动。
          syncTransientWarning =
            `doctor 收敛完成，但配置同步未确认（${syncResult.error || 'CLI 未正常结束'}），已继续启动网关；` +
            '若模型或渠道配置未生效，请稍后重试启动。'
          this._addLog(syncTransientWarning, 'stderr')
        }
      } else {
        syncTransientWarning =
          `openclaw.json 同步未完成（${syncResult.error || 'CLI 未正常结束'}），已继续启动网关；` +
          '若模型或渠道配置未生效，请稍后重试启动。'
        this._addLog(syncTransientWarning, 'stderr')
      }
    }

    // 兜底补齐 legacy webhook 迁移完成标记（详见 openclawWebhookMarker.ts 顶部说明）。
    //
    // OpenClaw 只在迁移「无 warning」时才写入 meta.migrations.webhookListeners；插件
    // doctor 契约在 Windows 上加载失败（符号链接权限/文件占用）会让它每次启动重跑
    // 该迁移（实测 185s）。官方对「外部管理的配置」明确要求由外部程序写入标记。
    //
    // 必须放在 syncOpenClawConfig 之后：官方 patch 可能重写 openclaw.json，标记要最后落盘。
    try {
      const marker = await this.configManager.ensureWebhookMigrationMarker()
      const legacy = marker.skippedLegacyChannels ?? []
      if (marker.changed) {
        this._addLog(
          '[gateway] 已补齐 legacy webhook 迁移完成标记（避免每次启动重复迁移，实测约 3 分钟）' +
            (marker.backupPath ? `；原文件备份：${marker.backupPath}` : ''),
          'system'
        )
      } else if (legacy.length > 0) {
        // 有 legacyWebhook 端点：官方要求「补端点 + 补标记」双管齐下，我们只负责标记这一半，
        // 所以这里交回 OpenClaw 官方迁移，不强行标记完成。
        this._addLog(
          `[gateway] 检测到 legacyWebhook 配置（${legacy.join(' / ')}），保留 OpenClaw 官方迁移、不补完成标记`,
          'stderr'
        )
      } else if (marker.error) {
        this._addLog(`[gateway] webhook 迁移标记补齐跳过：${marker.error}`, 'stderr')
      }
    } catch (e: any) {
      this._addLog(`[gateway] webhook 迁移标记补齐异常：${e?.message || e}`, 'stderr')
    }

    // 对话内语音：密钥只以环境变量注入，绝不写进 openclaw.json。
    let voiceTtsEnv: Record<string, string> = {}
    if (this.voiceTtsEnvProvider) {
      try {
        voiceTtsEnv = await this.voiceTtsEnvProvider()
      } catch (e) {
        this._addLog(
          `语音 TTS 环境变量注入失败（不影响网关启动）: ${(e as Error)?.message}`,
          'stderr'
        )
      }
    }

    // V8 编译缓存：渠道插件包很大（feishu 73MB），每次冷启动都要重新编译 JS。
    // NODE_COMPILE_CACHE 让 Node 把编译产物缓存到磁盘，后续启动复用（Node 22+ 支持）。
    // 缓存放 data 目录内，不把任何数据迁出用户既有的数据盘。
    let nodeCompileCacheDir = ''
    try {
      nodeCompileCacheDir = join(dataDir, 'cache', 'node-compile')
      mkdirSync(nodeCompileCacheDir, { recursive: true })
    } catch {
      nodeCompileCacheDir = ''
    }

    const commonEnv = buildOpenClawEnv(dataDir, nodePath, {
      PORT: String(this.port),
      OPENCLAW_DISABLE_BONJOUR: '1',
      BONJOUR_DISABLE: '1',
      ...(nodeCompileCacheDir ? { NODE_COMPILE_CACHE: nodeCompileCacheDir } : {}),
      OPENCLAW_GATEWAY_MODE: 'local',
      // 官方启动阶段 trace：在日志里给出 plugins.gateway-load.plugin.<id> 的
      // configValidation / artifactPreparation / source-capture+load / register 分项耗时，
      // 用于定位「插件物化慢」的确切环节（只写日志，不改变行为）。
      // 官方启动 trace：默认关闭（日志量大）；排障时用 CLAW_OC_STARTUP_TRACE=1 打开
      ...(process.env.CLAW_OC_STARTUP_TRACE === '1' ? { OPENCLAW_GATEWAY_STARTUP_TRACE: '1' } : {}),
      // 实验开关：fs-safe 走 JS 兜底（native 会对每次文件操作做 identity/ACL 校验，
      // 官方文档说 strict-mode 的额外校验 "can be slower"）。用 per-plugin trace 对比
      // feishu 的 loadMs 是否下降；默认写 'auto'，实验期间用 'off'。
      // 注：off 会让 Windows 安全凭证读取（SecretRef/GitHub 身份）不可用——本应用当前不依赖。
      // 覆盖值必须白名单，避免非法值让网关启动失败
      OPENCLAW_FS_SAFE_NATIVE_MODE: (() => {
        const override = process.env.CLAW_FS_SAFE_NATIVE_MODE
        return override === 'auto' || override === 'off' || override === 'require'
          ? override
          : 'auto'
      })(),
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
      ...providerEnv,
      ...voiceTtsEnv
    }

    this._addLog(`正在启动 OpenClaw (端口 ${this.port})...`, 'system')

    // 「退出应用保留网关」需要子进程脱离本实例：detached + 把 stdout/stderr 写文件，
    // 否则 App 退出后管道关闭，网关写日志会中断/崩溃。默认关闭，行为与原来完全一致。
    const keepOnQuit = this.configManager.getConfig().keepGatewayOnQuit === true
    const gatewayLogFile = join(dataDir, 'logs', 'openclaw-gateway.log')
    const gatewayErrFile = join(dataDir, 'logs', 'openclaw-gateway.err.log')
    let gatewayLogFd: number | undefined
    let gatewayErrFd: number | undefined
    if (keepOnQuit) {
      try {
        mkdirSync(dirname(gatewayLogFile), { recursive: true })
        writeFileSync(gatewayLogFile, '')
        writeFileSync(gatewayErrFile, '')
        gatewayLogFd = openSync(gatewayLogFile, 'a')
        gatewayErrFd = openSync(gatewayErrFile, 'a')
      } catch {
        gatewayLogFd = undefined
        gatewayErrFd = undefined
      }
    }
    const detached = keepOnQuit && gatewayLogFd !== undefined && gatewayErrFd !== undefined

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
        detached,
        stdio: detached
          ? ['ignore', gatewayLogFd!, gatewayErrFd!]
          : ['pipe', 'pipe', 'pipe']
      })
      // 父进程只需要自己的副本；子进程已继承句柄。
      for (const fd of [gatewayLogFd, gatewayErrFd]) {
        if (fd === undefined) continue
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      gatewayLogFd = undefined
      gatewayErrFd = undefined
      this.detachedChild = detached

      this.startedAt = Date.now()
      this.startupDurationRecorded = false
      this._setBootPhase('spawning', '[gateway] 网关进程已拉起，等待 HTTP 端口监听…')
      if (detached) {
        // 让 App 退出时不再阻塞；日志改从文件 tail（面板照常有输出）
        this.process.unref()
        this._startGatewayLogTails([
          { file: gatewayLogFile, type: 'stdout' },
          { file: gatewayErrFile, type: 'stderr' }
        ])
        this._writeGatewayRuntime(gatewayLogFile)
        this._scheduleNodeCompileCacheCleanup(dataDir)
      } else {
        // 非保留模式：清掉可能遗留的陈旧运行时描述
        this._clearGatewayRuntime()
      }
      this._startReadyProbe()
      this._setupProcessEvents(this.process!)
      this.emit('statusChange', true, this.port)
      if (this.healthyResetTimer) clearTimeout(this.healthyResetTimer)
      this.healthyResetTimer = setTimeout(() => {
        // 持续健康运行 30s 后允许下一次退出码 78 再触发自愈
        if (this.process) this.maintenanceAutoFixUsed = false
      }, 30000)
      const warning = [peerLinkWarning, syncTransientWarning].filter(Boolean).join('；') || undefined
      return { success: true, warning }
    } catch (err: any) {
      for (const fd of [gatewayLogFd, gatewayErrFd]) {
        if (fd === undefined) continue
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      this.process = null
      this.detachedChild = false
      this._setBootPhase('idle')
      return { success: false, error: err.message }
    }
  }

  async stop(): Promise<{ success: boolean }> {
    if (this.healthyResetTimer) {
      clearTimeout(this.healthyResetTimer)
      this.healthyResetTimer = undefined
    }
    // 复用的后台网关不是本实例子进程：用 taskkill 结束并按停止语义清状态。
    if (this.adoptedPid !== undefined) {
      const pid = this.adoptedPid
      this.adoptedPid = undefined
      this.isStopping = true
      this._stopAdoptedHealthWatch()
      const killed = await this._killAdoptedProcess(pid)
      this._clearGatewayRuntime()
      this._stopGatewayLogTails()
      this.ready = false
      this.readyAt = undefined
      this.bootPhase = 'idle'
      this.startedAt = undefined
      this.isStopping = false
      this.emit('statusChange', false)
      if (!killed) {
        this._addLog(`停止复用的后台网关失败（PID ${pid} 仍存活）`, 'stderr')
        return { success: false }
      }
      this._addLog('已停止复用的后台网关', 'system')
      return { success: true }
    }

    // 启动在途（ghost 清理 / 配置同步的 await 窗口）时先等它落定，
    // 否则会漏掉刚 spawn 的网关，留下占用状态目录的孤儿。
    if (this.startInFlight) {
      await this.startInFlight.catch(() => undefined)
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
        this._markNotReady()
        this.emit('statusChange', false)
        this._addLog('OpenClaw 已停止', 'system')
        finish()
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        this.startedAt = undefined
        this._markNotReady()
        this.emit('statusChange', false)
        this._addLog(`停止过程中出错: ${err.message}`, 'system')
        finish()
      })
    })
  }

  private get _gatewayRuntimePath(): string {
    return join(this.configManager.getDataDir(), 'cache', 'gateway-runtime.json')
  }

  /** 记录「后台网关」描述（供下次启动复用）；普通模式下写了也无害 */
  private _writeGatewayRuntime(logFile: string): void {
    try {
      const file = this._gatewayRuntimePath
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            version: 1,
            pid: this.process?.pid,
            port: this.port,
            startedAt: this.startedAt,
            detached: this.detachedChild,
            // 版本一并记录：adopt 时据此拒绝跨版本复用旧后台网关
            openclawVersion: this._readOpenClawVersion(this.configManager.getDataDir()),
            logFile
          },
          null,
          2
        )}\n`,
        'utf-8'
      )
    } catch {
      /* 运行时描述只是便利文件，失败不影响启动 */
    }
  }

  private _clearGatewayRuntime(): void {
    try {
      unlinkSync(this._gatewayRuntimePath)
    } catch {
      /* ignore */
    }
  }

  /** detached 模式下从文件 tail 网关日志（stdout/stderr 分开；保留半行 carry、检测截断） */
  private _startGatewayLogTails(
    tails: Array<{ file: string; type: 'stdout' | 'stderr' }>,
    fromEndBytes = 0
  ): void {
    this._stopGatewayLogTails()
    this.logTails = tails.map(({ file, type }) => {
      let offset = 0
      try {
        const size = statSync(file).size
        offset = fromEndBytes > 0 ? Math.max(0, size - fromEndBytes) : 0
      } catch {
        offset = 0
      }
      return { file, type, offset, carry: '' }
    })
    this._drainGatewayLogTails()
    this.logTailTimer = setInterval(() => this._drainGatewayLogTails(), 400)
  }

  private _stopGatewayLogTails(): void {
    if (this.logTailTimer) {
      clearInterval(this.logTailTimer)
      this.logTailTimer = undefined
    }
    this.logTails = []
  }

  /** 把 pino JSON 行还原成可读文本（兼容 msg 字段；解析失败原样输出） */
  private _formatGatewayLogLine(line: string): string {
    const text = line.trim()
    if (!text.startsWith('{')) return text
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const msg = parsed['1'] ?? parsed.msg
      if (typeof msg === 'string') return msg
      if (msg && typeof msg === 'object') return JSON.stringify(msg)
      return text
    } catch {
      return text
    }
  }

  /** 增量读取（stat 判增长 + read(offset)，不再整文件 readFileSync） */
  private _drainGatewayLogTails(): void {
    for (const tail of this.logTails) {
      try {
        const size = statSync(tail.file).size
        // 文件被截断/轮转：从头重读，丢弃半个旧行
        if (size < tail.offset) {
          tail.offset = 0
          tail.carry = ''
        }
        if (size <= tail.offset) continue
        const want = Math.min(size - tail.offset, 1024 * 1024)
        const fd = openSync(tail.file, 'r')
        try {
          const buf = Buffer.alloc(want)
          const read = readSync(fd, buf, 0, want, tail.offset)
          tail.offset += read
          const chunk = tail.carry + buf.subarray(0, read).toString('utf-8')
          const lines = chunk.split('\n')
          tail.carry = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const text = this._formatGatewayLogLine(line)
            this._addLog(text, tail.type)
            this.emit('log', text, tail.type)
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        /* 文件暂不可读：下个 tick 继续 */
      }
    }
  }

  /** V8 编译缓存无上限；启动后后台做一次上限清理（超过 512MB 清空） */
  private _scheduleNodeCompileCacheCleanup(dataDir: string): void {
    const timer = setTimeout(() => {
      try {
        const dir = join(dataDir, 'cache', 'node-compile')
        let total = 0
        const walk = (p: string, depth: number): void => {
          if (depth > 6) return
          for (const entry of readdirSync(p, { withFileTypes: true })) {
            const full = join(p, entry.name)
            if (entry.isDirectory()) walk(full, depth + 1)
            else {
              try {
                total += statSync(full).size
              } catch {
                /* ignore */
              }
            }
          }
        }
        walk(dir, 0)
        if (total > 512 * 1024 * 1024) {
          rmSync(dir, { recursive: true, force: true })
          this._addLog(`[gateway] 已清理过大的 V8 编译缓存（${Math.round(total / 1024 / 1024)}MB）`, 'system')
        }
      } catch {
        /* 清理 best-effort */
      }
    }, 5000)
    ;(timer as { unref?: () => void }).unref?.()
  }
  /** 结束复用的后台网关（独立方法便于验收里打桩）；返回是否已确认退出 */
  private async _killAdoptedProcess(pid: number): Promise<boolean> {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* 进程可能已退出，下面用存活检测判定 */
    }
    return !this._isPidAlive(pid)
  }

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 读取当前安装的 openclaw 版本（用于拒绝跨版本复用旧后台网关） */
  private _readOpenClawVersion(dataDir: string): string | undefined {
    try {
      const pkg = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'package.json')
      const version = JSON.parse(readFileSync(pkg, 'utf-8')).version
      return typeof version === 'string' ? version : undefined
    } catch {
      return undefined
    }
  }

  /** 端口当前被哪个 PID 监听（复用前身份校验，避免 pid 复用误认/误杀） */
  private async _findPidListeningOnPort(port: number): Promise<number | undefined> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
        for (const line of stdout.split('\n')) {
          if (!/LISTENING/i.test(line)) continue
          const cols = line.trim().split(/\s+/)
          const local = cols[1] ?? ''
          const pid = Number(cols[cols.length - 1])
          if (!local.endsWith(`:${port}`)) continue
          if (Number.isFinite(pid) && pid > 0) return pid
        }
        return undefined
      }
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        windowsHide: true
      })
      const pid = Number(stdout.split('\n').find((v) => v.trim()))
      return Number.isFinite(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  private _startAdoptedHealthWatch(): void {
    this._stopAdoptedHealthWatch()
    this.adoptedHealthTimer = setInterval(() => {
      if (this.adoptedPid === undefined) return
      void this._fetchHealthOk(1500).then((ok) => {
        if (!ok && this.adoptedPid !== undefined) {
          this._addLog('[gateway] 复用的后台网关失去响应，已标记为未运行（可重新启动）', 'stderr')
          this.adoptedPid = undefined
          this.ready = false
          this.readyAt = undefined
          this.bootPhase = 'idle'
          this.startedAt = undefined
          this._clearGatewayRuntime()
          this._stopGatewayLogTails()
          this._stopAdoptedHealthWatch()
          this.emit('statusChange', false)
        }
      })
    }, 30_000)
    ;(this.adoptedHealthTimer as { unref?: () => void }).unref?.()
  }

  private _stopAdoptedHealthWatch(): void {
    if (this.adoptedHealthTimer) {
      clearInterval(this.adoptedHealthTimer)
      this.adoptedHealthTimer = undefined
    }
  }

  /**
   * 启动时复用「上次退出时保留的网关」。
   *
   * 安全前置：设置开启 + 描述 pid 存活 + **端口 owner pid 与描述一致**
   * （防 pid 被系统复用后误认 / taskkill 误杀）+ openclaw 版本一致；
   * 若网关仍在 loading（pid 活但 /health 未通），最多等 3 分钟，超时才杀掉冷启动。
   */
  async adoptRunningGateway(): Promise<boolean> {
    try {
      const cfg = this.configManager.getConfig()
      if (cfg.keepGatewayOnQuit !== true) return false
      this.port = Number(cfg.port) > 0 ? Number(cfg.port) : 3213
      const desc = JSON.parse(readFileSync(this._gatewayRuntimePath, 'utf-8')) as {
        pid?: number
        port?: number
        startedAt?: number
        logFile?: string
        openclawVersion?: string
      }
      if (!desc || typeof desc.pid !== 'number') return false
      if (Number(desc.port) !== this.port) {
        this._addLog('[gateway] 陈旧的后台网关描述（端口不一致），已清理', 'stderr')
        this._clearGatewayRuntime()
        return false
      }
      const currentVersion = this._readOpenClawVersion(this.configManager.getDataDir())
      if (desc.openclawVersion && currentVersion && desc.openclawVersion !== currentVersion) {
        this._addLog(
          `[gateway] 后台网关版本不一致（${desc.openclawVersion} → ${currentVersion}），不复用`,
          'stderr'
        )
        if (this._isPidAlive(desc.pid)) await this._killAdoptedProcess(desc.pid)
        this._clearGatewayRuntime()
        return false
      }
      if (!this._isPidAlive(desc.pid)) {
        this._addLog('[gateway] 上次保留的网关进程已不在，走冷启动', 'system')
        this._clearGatewayRuntime()
        return false
      }
      const ownerPid = await this._findPidListeningOnPort(this.port)
      if (ownerPid !== undefined && ownerPid !== desc.pid) {
        this._addLog(
          `[gateway] 端口 ${this.port} 的监听进程与记录不一致（${ownerPid} ≠ ${desc.pid}），不复用`,
          'stderr'
        )
        this._clearGatewayRuntime()
        return false
      }

      const deadline = Date.now() + 3 * 60_000
      let ok = await this._fetchHealthOk(1500)
      while (!ok && Date.now() < deadline) {
        if (!this._isPidAlive(desc.pid)) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
        ok = await this._fetchHealthOk(1500)
      }
      if (!ok) {
        this._addLog('[gateway] 保留的网关未在预期时间内就绪，将停止它并冷启动', 'stderr')
        await this._killAdoptedProcess(desc.pid)
        this._clearGatewayRuntime()
        return false
      }

      this.adoptedPid = desc.pid
      this.startedAt = typeof desc.startedAt === 'number' ? desc.startedAt : Date.now()
      this.ready = true
      this.readyAt = Date.now()
      this.bootPhase = 'ready'
      this.startupDurationRecorded = true
      if (typeof desc.logFile === 'string') {
        const errFile = desc.logFile.endsWith('.log')
          ? `${desc.logFile.slice(0, -4)}.err.log`
          : `${desc.logFile}.err`
        this._startGatewayLogTails(
          [
            { file: desc.logFile, type: 'stdout' },
            { file: errFile, type: 'stderr' }
          ],
          64 * 1024
        )
      }
      this._startAdoptedHealthWatch()
      this._addLog('[gateway] 检测到上次退出时保留的网关，已直接复用（跳过冷启动）', 'system')
      this.emit('statusChange', true, this.port)
      return true
    } catch {
      return false
    }
  }

  /**
   * App 退出前的网关处理：开启「退出保留网关」时让 detached 子进程继续跑
   * （下次启动由 adoptRunningGateway 复用）；否则照旧停止。幂等：quitApp 与 before-quit 都会调。
   */
  async handleAppQuit(): Promise<void> {
    if (this.quitHandled) return
    this.quitHandled = true
    const keep = this.configManager.getConfig().keepGatewayOnQuit === true
    const canKeep = keep && (this.adoptedPid !== undefined || (this.detachedChild && !!this.process))
    if (canKeep) {
      this._addLog('[gateway] 已按设置保留网关在后台运行（下次启动直接复用，跳过冷启动）', 'system')
      this._stopGatewayLogTails()
      this._stopAdoptedHealthWatch()
      try {
        this.process?.unref()
      } catch {
        /* ignore */
      }
      this.process = null
      this.detachedChild = false
      return
    }
    await this.stop()
  }
  private get _startupStatsPath(): string {
    return join(this.configManager.getDataDir(), 'cache', 'startup-stats.json')
  }

  /** 懒加载历史启动耗时（读失败一律当空，不影响启动） */
  private _ensureStartupStatsLoaded(): void {
    if (this.startupStatsLoaded) return
    this.startupStatsLoaded = true
    try {
      this.startupDurations = parseStartupStats(readFileSync(this._startupStatsPath, 'utf-8'))
    } catch {
      this.startupDurations = []
    }
  }

  /** 记录一次「spawn→health」耗时（同一次 spawn 只记一次），并落盘供 ETA 估算 */
  private _recordStartupDuration(durationMs: number): void {
    if (this.startupDurationRecorded) return
    this.startupDurationRecorded = true
    this._ensureStartupStatsLoaded()
    this.startupDurations = appendStartupDuration(this.startupDurations, durationMs)
    try {
      const file = this._startupStatsPath
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, serializeStartupStats(this.startupDurations), 'utf-8')
    } catch {
      // 统计写盘失败不影响启动
    }
  }

  /** 估算总启动耗时（最近几次中位数）；没有历史时 undefined */
  private _estimateStartupMs(): number | undefined {
    this._ensureStartupStatsLoaded()
    return estimateStartupMs(this.startupDurations)
  }
  /** 更新启动阶段并推送（阶段变化才推送，避免事件/日志刷屏） */
  private _setBootPhase(phase: BootPhase, logLine?: string): void {
    if (this.bootPhase === phase) return
    this.bootPhase = phase
    if (logLine) this._addLog(logLine, 'system')
    // preparing 阶段进程还没起：由渲染端本地状态显示「准备中」，这里不推 running=false 打扰它
    if (this.process || phase === 'idle') this.emit('statusChange', !!this.process, this.port)
  }

  /** TCP 端口是否已监听（HTTP 服务在听、但 /health 还没 200 → 插件/渠道加载中） */
  private _probePortOpen(timeoutMs = 800): Promise<boolean> {
    const port = Number(this.port) || 3213
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const socket = netConnect({ host: '127.0.0.1', port })
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => {
          socket.destroy()
          done(true)
        })
        socket.once('timeout', () => {
          socket.destroy()
          done(false)
        })
        socket.once('error', () => done(false))
      } catch {
        done(false)
      }
    })
  }
  /**
   * 探测网关是否真正可用（`GET /health` 200）。
   *
   * 用短超时的 http 请求而不是「进程是否存活」：openclaw spawn 后要加载插件/渠道/状态库，
   * 进程在但端口没监听是常态（实测可达数分钟），只有 /health 通才算能开网页。
   */
  private _fetchHealthOk(timeoutMs = 1500): Promise<boolean> {
    // 用 spawn 时的端口：启动窗口内用户可能保存了新的 config.port（保存只改配置、不重启），
    // 用配置端口会让探活盯错端口 → 15 分钟超时误报。
    const port = Number(this.port) || Number(this.configManager.getConfig().port) || 3213
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const req = httpGet({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
          res.resume()
          done(res.statusCode === 200)
        })
        req.on('timeout', () => {
          req.destroy()
          done(false)
        })
        req.on('error', () => done(false))
      } catch {
        done(false)
      }
    })
  }

  /** 进程停止/退出：清 ready 并停掉后台探针（避免旧探针改新实例状态） */
  private _markNotReady(): void {
    this.ready = false
    this.readyAt = undefined
    this.readyProbeStopped = true
    this.readyProbeSeq++
    this.bootPhase = 'idle'
  }

  /** spawn 成功后启动后台探活：就绪时记 readyAt、写耗时日志、推状态 */
  private _startReadyProbe(): void {
    this.ready = false
    this.readyAt = undefined
    this.readyProbeStopped = false
    // 代际隔离：stop→start 窗口里旧探针可能还在等 HTTP 响应；恢复后不能拿旧 spawnAt
    // 给新实例写就绪/耗时日志（旧端口未释放时甚至可能探到旧进程的 /health 200）。
    const seq = ++this.readyProbeSeq
    const spawnAt = this.startedAt ?? Date.now()
    const stale = (): boolean =>
      this.readyProbeStopped || seq !== this.readyProbeSeq || !this.process
    const poll = async (): Promise<void> => {
      if (stale()) return
      if (await this._fetchHealthOk()) {
        // 与 waitReady 并发时可能已被对方置 ready：去重，避免重复日志/emit。
        if (stale() || this.ready) return
        this.ready = true
        this.readyAt = Date.now()
        this._setBootPhase('ready')
        this._recordStartupDuration(this.readyAt - spawnAt)
        this._addLog(
          `[gateway] 启动耗时 ${((this.readyAt - spawnAt) / 1000).toFixed(1)}s（spawn→health）`,
          'system'
        )
        this.emit('statusChange', true, this.port)
        return
      }
      // 端口已监听说明 HTTP 服务起来了，但 /health 还没 200：
      // 这段正是 OpenClaw 物化/加载渠道插件的时间（实测可达数分钟），单独标一个阶段。
      if (this.bootPhase === 'spawning' && (await this._probePortOpen())) {
        if (stale()) return
        this._setBootPhase(
          'loading',
          '[gateway] HTTP 端口已监听，正在加载插件/渠道（首次或升级后需重建插件包，可能需数分钟）…'
        )
      }
      setTimeout(() => void poll(), 500)
    }
    void poll()
  }

  /**
   * 等待网关就绪（UI 的「启动中…」/「打开网页」前调用）。
   *
   * @returns ready=false 时带 error：进程已退出（启动失败）或超时。
   */
  async waitReady(
    timeoutMs = 15 * 60_000
  ): Promise<{ ready: boolean; elapsedMs: number; error?: string }> {
    const startAt = this.startedAt ?? Date.now()
    // 复用的后台网关（adoptedPid）不是本实例子进程，但同样算「在运行」。
    if (!this.process && this.adoptedPid === undefined) {
      return { ready: false, elapsedMs: 0, error: 'OpenClaw 未在运行' }
    }
    if (this.ready) {
      return { ready: true, elapsedMs: (this.readyAt ?? Date.now()) - startAt }
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.process && this.adoptedPid === undefined) {
        return {
          ready: false,
          elapsedMs: Date.now() - startAt,
          error: 'OpenClaw 进程已退出（启动失败），请查看日志'
        }
      }
      if (this.ready) {
        return { ready: true, elapsedMs: (this.readyAt ?? Date.now()) - startAt }
      }
      if (await this._fetchHealthOk()) {
        if (!this.ready) {
          this.ready = true
          this.readyAt = Date.now()
          this._setBootPhase('ready')
          this._recordStartupDuration(this.readyAt - startAt)
          this._addLog(
            `[gateway] 启动耗时 ${((this.readyAt - startAt) / 1000).toFixed(1)}s（spawn→health）`,
            'system'
          )
          this.emit('statusChange', true, this.port)
        }
        return { ready: true, elapsedMs: (this.readyAt ?? Date.now()) - startAt }
      }
      if (this.bootPhase === 'spawning' && (await this._probePortOpen())) {
        this._setBootPhase(
          'loading',
          '[gateway] HTTP 端口已监听，正在加载插件/渠道（首次或升级后需重建插件包，可能需数分钟）…'
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return {
      ready: false,
      elapsedMs: Date.now() - startAt,
      error: `启动超时（>${Math.round(timeoutMs / 1000)}s），请查看日志`
    }
  }

  getStatus(): ClawStatus {
    // 端口以当前配置为准（服务可能在 App 重启前就已启动、未走 start()，
    // this.port 会停留在陈旧默认值）；配置缺失才退回最近一次启动用端口
    const currentPort = Number(this.configManager.getConfig().port) > 0
      ? Number(this.configManager.getConfig().port)
      : this.port
    return {
      running: !!this.process || this.adoptedPid !== undefined,
      pid: this.process?.pid ?? this.adoptedPid,
      port: currentPort,
      uptime: this.startedAt ? Date.now() - this.startedAt : undefined,
      startedAt: this.startedAt,
      // doctor --fix / 状态库迁移进行中：网关虽未起，但也不是静止，
      // 前端据此把「启动中」细化为「正在修复配置…」，避免用户以为卡死重复点击。
      maintenance: this.maintenanceActive,
      // spawn 前的准备阶段（startInFlight 在途）同样算「启动中」，避免刷新窗口显示已停止
      starting:
        ((!!this.process || this.adoptedPid !== undefined) && !this.ready) ||
        (this.startInFlight !== null && !this.ready),
      ready: (!!this.process || this.adoptedPid !== undefined) && this.ready,
      readyAt: this.readyAt,
      startupMs:
        this.startedAt && this.readyAt ? Math.max(0, this.readyAt - this.startedAt) : undefined,
      bootPhase:
        this.process || this.adoptedPid !== undefined
          ? this.ready
            ? 'ready'
            : this.bootPhase
          : this.startInFlight !== null
            ? 'preparing'
            : 'idle',
      estimateStartupMs: this._estimateStartupMs()
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
  /**
   * 让 doctor 能进入维护模式：结束仍占着状态库的残留网关进程 + 清僵尸租约。
   * 公开入口：在维护互斥锁内执行（供 index.ts 更新链路调用）。
   * 与 _runDoctorFixLocked 内部的 _prepareForDoctorUnlocked 区分——后者已在锁内，
   * 直接调无锁实现，避免重入死锁。
   */
  async prepareForDoctor(): Promise<void> {
    return this._withMaintenanceLock(() => this._prepareForDoctorUnlocked())
  }

  /**
   * prepareForDoctor 的无锁实现：仅在已持有维护互斥锁的上下文里调用（_runDoctorFixLocked）。
   *
   * 便携目录下 `gateway stop` 不可用，doctor 必须独占状态库。而 stop() 只杀直接
   * 子进程，网关派生出来的 worker 会活下来继续占着 agent 库 —— doctor 只能报
   * 「An agent database is in use」退出，迁移半途而废，留下「state 库已迁移、
   * agent 库没迁移」的半迁移状态，新旧版本都起不来（dev 环境实测过）。
   */
  private async _prepareForDoctorUnlocked(): Promise<void> {
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
    // 单飞：更新流程的 doctor 与退出码 78 自愈的 doctor 可能同时触发，
    // 两个 doctor 并发迁移同一批 SQLite 正是半迁移死局的来源。后来者复用结果。
    if (this.doctorInFlight) {
      this._addLog('已有 doctor --fix 在执行，复用其结果（不再并发启动第二个）', 'system')
      return this.doctorInFlight
    }
    // 整个「杀残留进程 + 跑 doctor」都在维护互斥锁内：任何一路执行期间，
    // 另一路（含 index.ts 更新链路直接调 prepareForDoctor）只能在锁外排队，
    // 不会把正在跑的 doctor 当僵尸网关 taskkill 掉。
    const inFlight = this._withMaintenanceLock(() => this._runDoctorFixLocked(timeoutMs)).finally(() => {
      if (this.doctorInFlight === inFlight) this.doctorInFlight = null
    })
    this.doctorInFlight = inFlight
    return inFlight
  }

  private async _runDoctorFixLocked(
    timeoutMs: number
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

    await this._prepareForDoctorUnlocked()
    const first = await this._runDoctorOnce(env, timeoutMs)
    if (first.success || !DOCTOR_CONTENTION_RE.test(first.output || '')) return first

    // 争用是竞态：刚清完仍可能被别的 openclaw 进程占住（用户手动开的实例、
    // 上一轮 doctor 没退干净的 worker）。明确命中争用提示时再清一次重试，
    // 而不是把半迁移状态丢给探针 —— 探针只会把它误读成「新版本起不来」。
    this._addLog('doctor 报告状态库被占用，清理残留进程后重试一次...', 'system')
    await this._prepareForDoctorUnlocked()
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
   * 而 schema 拒绝要约 65s 才退 78；若用固定短预算（如旧的 90s）会和 65s 贴得太近，
   * 容易误判——故本方法改用「进程退出 vs 就绪」竞速，不依赖 gatewayClient 的就绪预算
   *（该预算已放宽到 10 分钟以覆盖 Windows 慢冷启动）。
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
    // 预算必须与 gatewayClient 的就绪预算同一口径：Windows 便携环境冷启动要复制渠道插件
    // 隔离副本（实测 7~9 分钟），曾用 150s/240s 会把「正在正常启动」判成「未在预期时间内
    // 就绪」——更新流程随后还会把进程停掉。这里只用于「没退出也没就绪」的兜底，
    // 进程自行退出仍由下面的竞速第一时间下结论。
    budgetMs = 600_000,
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

  /**
   * 为指定网关子进程挂事件。事件一律按「进程身份」归属：只有当前跟踪的进程
   * （this.process === proc）才允许清空句柄 / 触发自愈。旧实例（双启动竞态中
   * 先 spawn 的那个）退出时不再会把新实例的句柄误清成「已停止」。
   * 无参时绑定当前 this.process（兼容直接赋值后挂事件的用法与验收测试）。
   */
  private _setupProcessEvents(proc: ChildProcess | null = this.process): void {
    if (!proc) return

    proc.stdout?.on('data', (data: Buffer) => {
      const rawChunk = data.toString()

      const lines = rawChunk.split('\n').filter(Boolean)
      lines.forEach((line) => {
        this._addLog(line, 'stdout')
        this.emit('log', line, 'stdout')
      })
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      lines.forEach((line) => {
        this._addLog(line, 'stderr')
        this.emit('log', line, 'stderr')
        // 旧实例输出的迁移提示不能污染当前实例的判断
        if (
          this.process === proc &&
          /schema migration required|maintenance_required|run openclaw doctor --fix/i.test(line)
        ) {
          this.maintenanceMarkerSeen = true
        }
      })
    })

    proc.on('exit', (code, signal) => {
      const isTracked = this.process === proc
      this._addLog(
        `OpenClaw 进程退出 (code=${code}, signal=${signal}${isTracked ? '' : '，旧实例'})`,
        'system'
      )
      if (isTracked) {
        this.process = null
        this.detachedChild = false
        this.startedAt = undefined
        this._clearGatewayRuntime()
        this._stopGatewayLogTails()
        this._stopAdoptedHealthWatch()
        this._markNotReady()
        this.emit('statusChange', false)
      }
      // 退出码 78（EX_CONFIG）或本生命周期内出现过迁移提示：自动 doctor --fix 后重启，每次启动最多一次
      const needsMaintenance =
        isTracked &&
        (code === 78 || (typeof code === 'number' && code !== 0 && this.maintenanceMarkerSeen))
      if (!isTracked) {
        // 旧实例退出：不碰当前句柄、不触发自愈，只留一行可读日志
        this._addLog('检测到旧 OpenClaw 实例退出，已忽略（不影响当前实例）', 'system')
        return
      }
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

    proc.on('error', (err) => {
      this._addLog(`进程错误: ${err.message}`, 'stderr')
      this.emit('log', `进程错误: ${err.message}`, 'stderr')
      if (this.process === proc) {
        this.process = null
        this.startedAt = undefined
        this._markNotReady()
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
    /** 本轮实际重建过的链接：用于修复后等文件稳定，避免和 OpenClaw 的插件复制/审计抢时序 */
    const repairedLinks: string[] = []

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
        repairedLinks.push(linkPath)
      } catch (e: any) {
        failures.push(pluginDir)
        this._addLog(`修复插件链接失败: ${linkPath} (${e.message})`, 'stderr')
      }
    }

    if (repairedLinks.length > 0) {
      // 仅记日志：实测 junction 创建后 realpath 立即就绪，额外等待是 no-op；
      // 真正与 OpenClaw 插件复制/审计的交错发生在 spawn 之后，这里等待影响不到它。
      this._addLog(`已修复 ${repairedLinks.length} 个插件 peer 链接`, 'system')
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
