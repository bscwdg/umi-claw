// electron/main/clawManager.ts —— OpenClaw 网关生命周期管理器（启动/就绪探活/停止/自愈/退出保留）
//
// 为什么这个文件必须保留且接口稳定：ClawManager 是主进程访问网关的唯一生命周期入口
// （IPC、index.ts wiring、更新探针都从这里取状态与动作），验收脚本也直接 bundle 本文件
// 并 monkey-patch 其私有方法做打桩。2026-11 J2 起，纯执行体按职责拆到 ./claw/
// （清理 / doctor / 迁移 / 日志 tail / 技能 / 状态拼装…），这里只留状态机与启动停止编排，
// 以及与被拆模块同名的一层薄委托 —— 拆分不得改变行为，也不得改变上述打桩面。

import { EventEmitter } from 'events'
import { ChildProcess, spawn, execFile } from 'child_process'
import { dirname, join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  closeSync
} from 'fs'
import { ConfigManager } from './configManager'
import { promisify } from 'util'
import {
  appendStartupDuration,
  estimateStartupMs,
  parseStartupStats,
  serializeStartupStats
} from './startupStats'
import { openClawPaths, toPosix, buildOpenClawEnv } from './openClawPaths'
import type { BootPhase, ClawStatus, LogEntry } from './claw/types'
import type { ClawLogger } from './claw/deps'
import { buildClawStatus } from './claw/status'
import { withTimeout, withTimeoutValue } from './claw/timeout'
import { cleanStalePluginCaptures, killByImageName, killGhostNodeGateways } from './claw/reclaim'
import { fetchHealthOk, findPidListeningOnPort, probePortOpen } from './claw/probe'
import {
  clearGatewayRuntime,
  drainGatewayLogTails,
  scheduleNodeCompileCacheCleanup,
  writeGatewayRuntime
} from './claw/gatewayRuntime'
import type { GatewayLogTail } from './claw/gatewayRuntime'
import {
  buildProviderEnv,
  collectVoiceTtsEnv,
  ensureNodeCompileCacheDir,
  logWebhookMarkerResult,
  openDetachedGatewayLogs
} from './claw/spawnEnv'
import { installSkill, listSkills, uninstallSkill } from './claw/skills'
import type { SkillInfo } from './claw/skills'
import { readSchemaVersions } from './claw/schema'
import type { SchemaVersionEntry } from './claw/schema'
import { markStartupMigrationsComplete, repairManagedPluginPeerLinks } from './claw/migrations'
import {
  DOCTOR_CONTENTION_RE,
  autoFixMaintenance,
  cleanStaleAgentLeases,
  runDoctorOnce
} from './claw/doctor'
import type { StartupProbeResult } from './claw/rollback'

// 拆分后对外契约不变：index.ts / ipc/host/env.ts / 验收脚本仍从本文件取这些导出
export { decideRollback } from './claw/rollback'
export type { StartupProbeResult } from './claw/rollback'
export type { SkillInfo } from './claw/skills'
export type { SchemaVersionEntry } from './claw/schema'
export type { BootPhase, ClawStatus, LogEntry } from './claw/types'

const execFileAsync = promisify(execFile)

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
  private logTails: GatewayLogTail[] = []
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

  /** 子模块统一的日志注入点：日志仍由 _addLog 单点收集（上限/顺序都不变） */
  private _logSink(): ClawLogger {
    return (line, type) => this._addLog(line, type)
  }

  async _killGhostProcesses(dataDir: string) {
    if (process.platform !== 'win32') return

    // 三路清理互不依赖，并行执行以缩短启动前等待。
    await Promise.all([
      ...['bun.exe', 'openclaw.exe'].map((name) => this._killByImageName(name)),
      killGhostNodeGateways(this._logSink(), dataDir)
    ])
    console.log('🧹 僵尸进程清理尝试完毕。')
  }

  /**
   * 清理 OpenClaw 插件隔离副本（tmp/plugin-captures/<uuid>）的历史残留。
   *
   * 完整实现与安全前提（维护闸门 / 先摘 junction 再 rename 再 rm / 删除超时）
   * 见 claw/reclaim.ts 的 cleanStalePluginCaptures；这里保留同名薄委托，既维持启动链
   * 的调用点，也维持验收脚本对 `_withTimeout(this._cleanStalePluginCaptures` 的文本断言。
   */
  private async _cleanStalePluginCaptures(dataDir: string): Promise<void> {
    return cleanStalePluginCaptures(
      {
        log: this._logSink(),
        isMaintenanceBusy: () =>
          this.maintenanceActive || !!this.doctorInFlight || this.maintenanceAutoFixInFlight
      },
      dataDir
    )
  }

  /** 启动前 best-effort 步骤的超时包装（实现见 claw/timeout.ts；超时=本次跳过，不算失败） */
  private _withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<boolean> {
    return withTimeout(this._logSink(), task, timeoutMs, label)
  }

  /** 带返回值的超时版本（用于必须拿到结果的启动前步骤）。 */
  private _withTimeoutValue<T>(
    task: Promise<T>,
    timeoutMs: number,
    label: string,
    fallback: T
  ): Promise<T> {
    return withTimeoutValue(this._logSink(), task, timeoutMs, label, fallback)
  }

  /** 按镜像名结束进程（实现见 claw/reclaim.ts；退出码 128=未找到进程，视为正常） */
  private async _killByImageName(imageName: string): Promise<void> {
    return killByImageName(imageName)
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
    const prepareStartedAt = Date.now()
    await this._killGhostProcesses(dataDir)
    // 已无 openclaw 进程：顺手回收插件隔离副本残留（实测能堆到 1GB+，还会拖慢启动巡检）。
    // 这是启动前优化，任何删除卡住都不能阻塞启动（2026-11-07 实测带 junction 的旧副本
    // 上 fs.rm 会永久 pending，把启动卡在 preparing 20+ 分钟）。
    await this._withTimeout(
      this._cleanStalePluginCaptures(dataDir),
      30_000,
      '插件隔离副本清理'
    )
    this._addLog(
      `[gateway] 启动前清理完成（${((Date.now() - prepareStartedAt) / 1000).toFixed(1)}s）`,
      'system'
    )

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
    const peerLinkWarning = await this._withTimeoutValue(
      this._repairManagedPluginPeerLinks(dataDir),
      30_000,
      '受管插件 peer 链接检查',
      null
    )
    if (peerLinkWarning) {
      // 链接补建失败（多为 U 盘/exFAT 等不支持 junction 的卷）：
      // 写进日志面板，并作为 warning 带回前端提示（不阻断启动）。
      this._addLog(peerLinkWarning, 'stderr')
    }
    // 关键根治：直接写入启动迁移 checkpoint，让 OpenClaw 跳过会因 peer-link 失败而
    // 拒绝启动的审计。这对任何磁盘/任何文件系统（含 U 盘 exFAT/FAT32/UNC）都有效。
    const peerCheckStartedAt = Date.now()
    await this._withTimeoutValue(
      this._markStartupMigrationsComplete(dataDir),
      20_000,
      '启动迁移 checkpoint 写入',
      undefined
    )
    this._addLog(
      `[gateway] 插件链接/迁移检查完成（${((Date.now() - peerCheckStartedAt) / 1000).toFixed(1)}s）`,
      'system'
    )

    // 启动前同步 openclaw.json：凭证、激活模型、渠道等以 configManager 为唯一真相源，
    // 避免此前在本类内重复实现（且曾用 p.id 取 OFFICIAL_MODEL_PRESETS 导致死分支）。
    // 写入一律走官方 config patch：被 schema 拒绝时绝不 spawn 网关（否则必 exit 78）。
    const syncStartedAt = Date.now()
    let syncResult = await this.configManager.syncOpenClawConfig()
    this._addLog(
      `[gateway] 配置同步${syncResult.ok ? '完成' : '未完成'}（${((Date.now() - syncStartedAt) / 1000).toFixed(1)}s）`,
      syncResult.ok ? 'system' : 'stderr'
    )
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
    // 必须放在 syncOpenClawConfig 之后、spawn 之前：官方 patch 可能重写 openclaw.json，
    // 标记要最后落盘，否则会被下一次 patch 覆盖。
    await logWebhookMarkerResult(
      this._logSink(),
      () => this.configManager.ensureWebhookMigrationMarker()
    )

    // 对话内语音：密钥只以环境变量注入，绝不写进 openclaw.json。
    const voiceTtsEnv = await collectVoiceTtsEnv(this._logSink(), this.voiceTtsEnvProvider)

    // V8 编译缓存：渠道插件包很大（feishu 73MB），每次冷启动都要重新编译 JS。
    // 缓存放 data 目录内，不把任何数据迁出用户既有的数据盘（见 claw/spawnEnv.ts）。
    const nodeCompileCacheDir = ensureNodeCompileCacheDir(dataDir)

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

    const providerEnvResult = buildProviderEnv(activeProvider)
    if (providerEnvResult.error) return { success: false, error: providerEnvResult.error }
    const providerEnv = providerEnvResult.env

    // 不再 spread process.env：commonEnv 已由 buildOpenClawEnv 从 process.env 派生，
    // 并清掉了 npm_config_cache 的大小写变体。在它之后重新 spread 会把宿主继承的
    // 大写 NPM_CONFIG_CACHE 带回来（Windows 环境变量不区分大小写，会覆盖小写值）。
    const env = {
      ...commonEnv,
      ...providerEnv,
      ...voiceTtsEnv
    }

    this._addLog(`正在启动 OpenClaw (端口 ${this.port})...`, 'system')

    // 「退出应用保留网关」需要子进程脱离本实例：detached + 把 stdout/stderr 写文件，
    // 否则 App 退出后管道关闭，网关写日志会中断/崩溃。默认关闭，行为与原来完全一致。
    const keepOnQuit = this.configManager.getConfig().keepGatewayOnQuit === true
    const detachedLogs = openDetachedGatewayLogs(keepOnQuit, dataDir)
    const gatewayLogFile = detachedLogs.logFile
    const gatewayErrFile = detachedLogs.errFile
    let gatewayLogFd = detachedLogs.logFd
    let gatewayErrFd = detachedLogs.errFd
    const detached = detachedLogs.detached

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
      } else {
        // 非保留模式：清掉可能遗留的陈旧运行时描述
        this._clearGatewayRuntime()
      }
      // 不论是否 detached 都启用缓存清理（默认 keep=false 用户同样会写 NODE_COMPILE_CACHE）
      this._scheduleNodeCompileCacheCleanup(dataDir)
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
    return writeGatewayRuntime(
      {
        getDataDir: () => this.configManager.getDataDir(),
        getPid: () => this.process?.pid,
        getPort: () => this.port,
        getStartedAt: () => this.startedAt,
        isDetached: () => this.detachedChild,
        readOpenClawVersion: (dataDir) => this._readOpenClawVersion(dataDir)
      },
      logFile
    )
  }

  private _clearGatewayRuntime(): void {
    // 路径求值也放在 try 内：旧实现就是 try { unlinkSync(this._gatewayRuntimePath) }，
    // getDataDir 抛错时同样静默（运行时描述只是便利文件，失败不影响启动/停止）。
    try {
      clearGatewayRuntime(this._gatewayRuntimePath)
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

  /** 增量读取文件日志（实现见 claw/gatewayRuntime.ts；addLog→emit 仍在 per-tail try 内） */
  private _drainGatewayLogTails(): void {
    drainGatewayLogTails(this.logTails, (text, type) => {
      this._addLog(text, type)
      this.emit('log', text, type)
    })
  }

  /** V8 编译缓存无上限；启动后后台做一次上限清理（超过 512MB 清空） */
  private _scheduleNodeCompileCacheCleanup(dataDir: string): void {
    scheduleNodeCompileCacheCleanup(this._logSink(), dataDir)
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

  /** 端口当前被哪个 PID 监听（实现见 claw/probe.ts；复用前身份校验，避免 pid 复用误认/误杀） */
  private async _findPidListeningOnPort(port: number): Promise<number | undefined> {
    return findPidListeningOnPort(port)
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
    return probePortOpen(Number(this.port) || 3213, timeoutMs)
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
    return fetchHealthOk(port, timeoutMs)
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
    // this.port 会停留在陈旧默认值）；拼装口径见 claw/status.ts。
    return buildClawStatus({
      // running 判在「有没有进程句柄」而不是 pid：spawn 返回后到 pid 赋值之间
      // 存在窗口期，旧实现用的是 !!this.process（保持等价，勿改回看 pid）。
      hasProcess: !!this.process,
      processPid: this.process?.pid,
      adoptedPid: this.adoptedPid,
      configPort: Number(this.configManager.getConfig().port),
      port: this.port,
      startedAt: this.startedAt,
      maintenanceActive: this.maintenanceActive,
      startInFlight: this.startInFlight !== null,
      ready: this.ready,
      readyAt: this.readyAt,
      bootPhase: this.bootPhase,
      estimateStartupMs: this._estimateStartupMs()
    })
  }

  getLogs(): LogEntry[] {
    return this.logs.slice(-500)
  }

  clearLogs(): void {
    this.logs = []
  }

  listSkills(): SkillInfo[] {
    return listSkills(this.configManager.getDataDir())
  }

  async installSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    return installSkill(
      { log: this._logSink(), getDataDir: () => this.configManager.getDataDir() },
      skillId
    )
  }

  async uninstallSkill(skillId: string): Promise<{ success: boolean; error?: string }> {
    return uninstallSkill(
      { log: this._logSink(), getDataDir: () => this.configManager.getDataDir() },
      skillId
    )
  }

  /**
   * 网关因状态库 schema 过旧拒绝启动（退出码 78 / maintenance_required）时的自愈：
   * 结束残留进程 -> 独立进程执行 doctor --fix（非交互）-> 自动重启。
   * 每次启动生命周期最多自愈一次，避免迁移失败时无限重启。
   * 执行体在 claw/doctor.ts（autoFixMaintenance）；这里只注入实例状态与回调。
   */
  private async _autoFixMaintenance(): Promise<void> {
    return autoFixMaintenance({
      log: this._logSink(),
      isInFlight: () => this.maintenanceAutoFixInFlight,
      isUsed: () => this.maintenanceAutoFixUsed,
      setInFlight: (value) => {
        this.maintenanceAutoFixInFlight = value
      },
      setUsed: (value) => {
        this.maintenanceAutoFixUsed = value
      },
      runDoctorFix: () => this.runDoctorFix(),
      start: () => this.start()
    })
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
    await cleanStaleAgentLeases(
      {
        log: this._logSink(),
        getNodePath: () => this.configManager.getNodePath(),
        resourcesRoot: this.resourcesRoot
      },
      dataDir
    )
  }

  /** 读 OpenClaw 各数据库的 schema 版本（实现见 claw/schema.ts；回滚安全性的唯一判据） */
  async readSchemaVersions(): Promise<SchemaVersionEntry[]> {
    return readSchemaVersions(() => this.configManager.getDataDir())
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

  /** doctor 的单次执行（实现见 claw/doctor.ts；不做清理 / 不重试），供 runDoctorFix 调用 */
  private _runDoctorOnce(
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return runDoctorOnce(
      {
        log: this._logSink(),
        getDataDir: () => this.configManager.getDataDir(),
        getNodePath: () => this.configManager.getNodePath()
      },
      env,
      timeoutMs
    )
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

  /**
   * 向 OpenClaw 状态库写入“启动迁移已完成”的 checkpoint，以跳过启动时的插件 peer-link 审计。
   *
   * 完整实现与「为什么在 U 盘/exFAT 上必须写 checkpoint」的说明见
   * claw/migrations.ts；这里保留同名薄委托，维持启动链调用点与验收脚本的文本断言。
   */
  private async _markStartupMigrationsComplete(dataDir: string): Promise<void> {
    return markStartupMigrationsComplete(
      { log: this._logSink(), getNodePath: () => this.configManager.getNodePath() },
      dataDir
    )
  }

  /**
   * 启动前修复受管 npm 插件的 openclaw peerDependency 链接。
   *
   * 实现与「为什么必须补真 junction 才能通过 realpath 审计」的说明见
   * claw/migrations.ts（repairManagedPluginPeerLinks）。
   *
   * @returns 错误提示字符串；全部成功时返回 null。
   */
  private async _repairManagedPluginPeerLinks(dataDir: string): Promise<string | null> {
    return repairManagedPluginPeerLinks({ log: this._logSink() }, dataDir)
  }
}