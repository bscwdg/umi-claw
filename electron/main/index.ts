import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  protocol,
  Notification
} from 'electron'
import { join, parse, dirname, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ClawManager } from './clawManager'
import { ConfigManager } from './configManager'
import { SkillSyncService } from './skillSyncService'
import { DownloadManager, type DownloadProgress } from './downloadManager'
import { ChannelManager } from './channelManager'
import { ObsidianManager } from './obsidian/obsidianManager'
import { EMBEDDING_PRESETS, OFFICIAL_MODEL_PRESETS } from './modelConfig'
import { openClawPaths, buildOpenClawEnv, toPosix, GATEWAY_TOKEN } from './openClawPaths'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process'
import type { TerminalRuntime } from '../../src/types/terminal'
import {
  createGatewayClient,
  detectMultimodalCapability,
  GATEWAY_MODEL_DEFAULT,
  type GatewayClient,
  type GatewayModels,
  type GatewayStarterResult
} from './gatewayClient'
import { registerGatewayIpc, registerWorkIpc } from './ipc'
import { AppError, ERROR_CODES } from './database/errors'
import { DatabaseClient, WORK_DB_FILENAME } from './database/database'
import { subprocessRegistry } from './subprocessRegistry'
import { createProfileManager, type ProfileManager } from './work/profileManager'
import { createMatterManager, type MatterManager } from './work/matterManager'
import { createTodoManager, dateOf, type TodoManager } from './work/todoManager'
import { createRecordManager, type RecordManager } from './work/recordManager'
import {
  createContextEngine,
  type ContextEngine,
  type SnapshotScope
} from './work/contextEngine'
import { createContextManager, type ContextManager } from './work/contextManager'
import { createRouterManager, type RouterManager } from './work/routerManager'
import { createTodayManager, type TodayManager } from './work/todayManager'
import { createReportManager, type ReportManager } from './work/reportManager'
import { createQaManager, type QaManager } from './work/qaManager'
import { createToolManager, type ToolManager } from './work/toolManager'
import { createKnowledgeManager, type KnowledgeManager } from './work/knowledgeManager'
import { createWizardManager, type WizardManager } from './work/wizardManager'
import { createReminderManager, type ReminderManager } from './work/reminderManager'
import { resolvePdfjsAssets } from './work/parsers/pdfjsAssets'

// 类型定义
interface TerminalSession {
  process: ChildProcessWithoutNullStreams
  id: string
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let clawManager: ClawManager
let configManager: ConfigManager
let downloadManager: DownloadManager
let channelManager: ChannelManager
let obsidianManager: ObsidianManager
let skillSyncService: SkillSyncService
/** Gateway Client 单例（Commit 01）：主进程唯一发 Gateway HTTP 请求的地方（硬规则 3） */
let workGatewayClient: GatewayClient | null = null
/** DB Worker 客户端单例（Commit 02 起被各 Manager 消费；硬规则 2：全局单例） */
let workDatabase: DatabaseClient | null = null
let workProfileManager: ProfileManager | null = null
let workMatterManager: MatterManager | null = null
let workTodoManager: TodoManager | null = null
let workRecordManager: RecordManager | null = null
let workContextEngine: ContextEngine | null = null
let workContextManager: ContextManager | null = null
let workRouterManager: RouterManager | null = null
let workTodayManager: TodayManager | null = null
let workReportManager: ReportManager | null = null
let workQaManager: QaManager | null = null
let workToolManager: ToolManager | null = null
let workKnowledgeManager: KnowledgeManager | null = null
let workWizardManager: WizardManager | null = null
let workReminderManager: ReminderManager | null = null

// 使用 Map 管理活跃的终端进程，避免 global 污染和内存泄漏
const activeTerminalSessions = new Map<string, TerminalSession>()

/**
 * 获取 OpenClaw 运行所需的环境变量和路径配置
 * 统一提取重复逻辑，确保环境一致性
 */
function getOpenClawRuntimeConfig() {
  const dataDir = configManager.getDataDir()
  const nodePath = configManager.getNodePath() // D:\...\data\runtime\node-win32-x64\node.exe
  const clawJsPath = openClawPaths.clawJs(dataDir)
  const targetConfigDir = openClawPaths.portableHome(dataDir)

  const env = buildOpenClawEnv(dataDir, nodePath, {
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    PYTHONIOENCODING: 'utf-8'
  })

  return {
    nodePath,
    clawJsPath,
    cwd: openClawPaths.installDir(dataDir),
    env,
    targetConfigDir
  }
}

// ─── Gateway Client wiring（Commit 01） ───────────────────────────────────────

/** PID 是否存活：EPERM（进程在但无权发信号）也视为存活 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/**
 * 读 OpenClaw 实际监听端口（配置端口被占时 OpenClaw 自动退让，实测 3213→3214）。
 *
 * 锁文件由 OpenClaw 写在 <configDir>/tmp/openclaw/gateway.<hash>.lock，内容含
 * pid/port/stateDir/startTime。这里只认 hash 段无点的实例锁（排除 gateway.state.lock）、
 * stateDir 必须对应当前 dataDir（防跨数据目录误读）、PID 必须仍存活（防残留旧锁），
 * 多份锁取 startTime 最新。任何异常返回 undefined（读锁失败不影响配置端口探活）。
 */
function readActualGatewayPort(): number | undefined {
  try {
    const dataDir = configManager.getDataDir()
    const configDir = openClawPaths.configDir(dataDir)
    const lockDir = join(configDir, 'tmp', 'openclaw')
    if (!existsSync(lockDir)) return undefined
    const expectedStateDir = toPosix(configDir)
    const locks = readdirSync(lockDir)
      // 负向先行排除 gateway.state.lock（`state` 本身能匹配 [^.]+，不显式排除会漏进来）
      .filter((file) => /^gateway\.(?!state\.lock$)[^.]+\.lock$/.test(file))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(lockDir, file), 'utf8')) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((lock): lock is Record<string, unknown> => Boolean(lock))
      .filter((lock) => Number(lock.pid) > 0 && Number(lock.port) > 0)
      .filter((lock) => !lock.stateDir || toPosix(String(lock.stateDir)) === expectedStateDir)
      .filter((lock) => isProcessAlive(Number(lock.pid)))
      .sort((a, b) => Number(b.startTime ?? 0) - Number(a.startTime ?? 0))
    return locks.length ? Number(locks[0].port) : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析当前配置下的 Gateway 模型选择。**每次调用都重读配置**（不做启动快照）：
 * 全新安装时客户端先于 Setup 构造（providers 为空），用户在 Setup 里选了支持图片的模型后
 * 只走渲染端 reload（主进程不重启）；启动快照会让 `multimodal` 一直停在 null，
 * 含图请求会被明确拒掉，直到用户完全重启 App。运行中切 provider / 换模型同理。
 */
function resolveGatewayModels(): Partial<GatewayModels> {
  const config = configManager.getConfig()
  const activeProvider = (config.providers || []).find((p) => p.id === config.activeProvider) ?? null
  const preset = activeProvider ? OFFICIAL_MODEL_PRESETS[activeProvider.configName] : null
  const presetModel = Array.isArray(preset?.models)
    ? preset.models.find((m: any) => m?.id === activeProvider?.model) ?? null
    : null
  return {
    text: GATEWAY_MODEL_DEFAULT,
    multimodal: detectMultimodalCapability(presetModel) ? GATEWAY_MODEL_DEFAULT : null
  }
}

/**
 * 构造 Gateway Client（Commit 01）：探活 / 自动拉起 / 就绪轮询 / SSE 的**唯一**实现。
 *
 * 依赖注入（不 import electron 的模块才好测）：
 *   - `baseUrl` / `port`：来自 `configManager.getConfig().port`（实测只绑 127.0.0.1）
 *   - `token`：`openClawPaths.GATEWAY_TOKEN`（**硬规则 3：只留在主进程**）
 *   - `models`：`text` = `openclaw`；`multimodal` 仅当当前 provider 声明了图片输入能力
 *   - `starter`：**复用 clawManager 的启停**（不另起炉灶）；已在跑就不重复 start
 *   - `conversationKeyResolver`：3.0 无 Project 概念，会话键由调用方按 §6.4 显式给
 *     （`conv:work:qa` / `conv:work:tool:{id}` / `conv:work:report:{type}:{period}`）
 * 本函数零 IO 副作用；真正的 HTTP 请求发生在 probe / ensureReady / chat。
 */
function createWorkGatewayClient(): GatewayClient {
  const config = configManager.getConfig()
  const port = Number(config.port) > 0 ? Number(config.port) : 3213

  const starter = async (): Promise<GatewayStarterResult> => {
    const status = clawManager.getStatus()
    if (status.running) {
      // 进程已在跑（可能还在冷启动）：不要重复 start，直接交给就绪轮询
      return { started: false, reason: 'already-running' }
    }
    // 硬性闸门（北 2026-09-24）：未同意用户协议不得拉起 OpenClaw
    try {
      await workWizardManager?.ensureConsent()
    } catch (e) {
      throw new AppError(
        ERROR_CODES.OPENCLAW_NOT_READY,
        (e as Error)?.message ?? '请先同意用户协议，再启动 OpenClaw',
        { reason: 'consent-required' }
      )
    }
    const result = await clawManager.start()
    if (!result.success) {
      throw new AppError(
        ERROR_CODES.OPENCLAW_NOT_READY,
        `自动拉起 OpenClaw 失败：${result.error || '未知错误'}`,
        { reason: 'start-failed' }
      )
    }
    // 拉起成功≠就绪：clawManager.start() 返回时进程往往还在冷启动（实测首次非流式 80.3s），
    // 所以这里只回「我拉过了」，就绪判定交给客户端的轮询
    return { started: true, reason: 'started' }
  }

  const client = createGatewayClient({
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    token: GATEWAY_TOKEN,
    // 模型选择**按次解析**（不做启动快照）：Setup 完成 / 换 provider 后无需重启主进程即生效
    modelsResolver: resolveGatewayModels,
    starter,
    actualPortResolver: () => readActualGatewayPort(),
    logger: (message: string) => console.log(message)
  })
  console.log(
    `[gateway] Gateway Client 就绪：${client.baseUrl}（model=${GATEWAY_MODEL_DEFAULT}，多模态=${resolveGatewayModels().multimodal ?? '未配置'}，每请求重读配置）`
  )
  return client
}

/**
 * 取 Gateway Client 单例（Commit 01）。
 *
 * 后续 Commit 的消费者（qa / tools / reports）调 `createChatStream()` 拿 SSE 增量，
 * 再交给 `forwardGatewayStream(webContents, runId, handle)` 推给渲染进程。
 * **不要**在别处 `new GatewayClient(...)`——token 与超时参数必须来自同一处配置。
 */
export function getWorkGatewayClient(): GatewayClient {
  if (!workGatewayClient) {
    throw new Error('Gateway Client 尚未初始化（应在 app.whenReady 之后取用）')
  }
  return workGatewayClient
}

/**
 * 解析终端命令入口与配套环境变量。
 * npx 模式下按用户的镜像开关注入 npm_config_registry，加快国内网络拉包；
 * 同时把 npm 缓存固定到便携数据目录（Windows 的 npm 默认缓存走 LOCALAPPDATA，
 * 不显式指定会在宿主机用户目录留缓存，破坏便携隔离）。
 * 其余环境（HOME/USERPROFILE 指向便携 config 目录）与 openclaw 一致，
 * 企微 CLI 正是靠 USERPROFILE/.openclaw 定位本应用托管的 OpenClaw 配置。
 */
function resolveTerminalRuntime(runtime?: TerminalRuntime): { entryJs: string; env: NodeJS.ProcessEnv; error?: string } {
  const { clawJsPath, env } = getOpenClawRuntimeConfig()
  if (runtime !== 'npx') {
    return { entryJs: clawJsPath, env }
  }
  const dataDir = configManager.getDataDir()
  const nodePath = configManager.getNodePath()
  const npxJs = join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (!existsSync(npxJs)) {
    return { entryJs: '', env, error: `未找到便携 npx 入口: ${npxJs}，请先完成运行环境下载` }
  }
  const registry = configManager.getConfig().useChineseMirror
    ? 'https://registry.npmmirror.com'
    : 'https://registry.npmjs.org'
  return {
    entryJs: npxJs,
    env: {
      ...env,
      npm_config_registry: registry,
      npm_config_cache: join(dataDir, 'config', '.npm-cache')
    }
  }
}

/**
 * 构造 DB Worker 客户端（Commit 02）：把 Electron 专属的路径解析（dev / 安装包 resources、
 * 便携 Node、数据目录）注入 database.ts，后者保持纯 Node 可测。
 * 惰性：构造时不建库、不 spawn（首次 work 域调用才拉 Worker）。
 */
function createWorkDatabase(): DatabaseClient {
  const dataDir = configManager.getDataDir()
  const isDev = !app.isPackaged
  const resRoot = isDev
    ? join(app.getAppPath(), 'resources')
    : join(process.resourcesPath, 'resources')
  return new DatabaseClient({
    // 3.0 用自己的库文件：2.0 的 umi-claw.db 与之同目录同名且 user_version 也=1，
    // 沿用会让迁移被跳过、3.0 的表建不出来（见 WORK_DB_FILENAME 注释）
    dbPath: join(dataDir, WORK_DB_FILENAME),
    backupDir: join(dataDir, 'backup'),
    workerScriptPath: join(resRoot, 'database', 'db-worker.mjs'),
    nodePath: configManager.getNodePath(),
    subprocessName: 'work-db-worker',
    // 启动即注册（子进程注册表）：_stopRuntimeProcesses / 退出清理先优雅停
    onSpawn: (info) => subprocessRegistry.register(info),
    logger: (message) => console.log(message)
  })
}

/** resources/ 根（dev / 打包双路径，与 createWorkDatabase 同口径） */
function resourcesRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
}

/**
 * 定位旧版本库（硬规则 17：只读检测，不写旧库）。
 *
 * 版本隔离：1.0 = %APPDATA%/umi-claw/data；2.0 = %APPDATA%/<2.0 dir>/data；
 * 便携态旧库在各自安装目录的 data/。这里只判断 db 文件是否存在，不打开。
 */
function locateLegacyDbs(currentDataDir: string): import('./work/wizardManager').OldDbInfo[] {
  const out: import('./work/wizardManager').OldDbInfo[] = []

  const candidates: Array<{ version: '1.0' | '2.0'; dir: string }> = []
  // 1.0 固定 appData 名
  const appDataDir = app.getPath('appData')
  candidates.push({ version: '1.0', dir: join(appDataDir, 'umi-claw', 'data') })

  // 2.0：与 3.0 **同目录同名**（%APPDATA%/UmiClaw/data/umi-claw.db）。
  // 3.0 已改用 work.db，所以同目录下的 umi-claw.db 就是 2.0 的库——
  // 必须作为候选暴露给向导，否则用户旧数据永远不可见（硬规则 17）。
  candidates.push({ version: '2.0', dir: currentDataDir })

  // 便携/同机共存：当前 dataDir 的同级或上级可能有旧版本（同目录隔离名不同）
  // 这里保守地只查 %APPDATA% 下的已知目录，避免任意扫描用户磁盘（最小出站面）
  for (const dirName of ['UmiClaw2', 'umi-claw-2']) {
    candidates.push({ version: '2.0', dir: join(appDataDir, dirName, 'data') })
  }

  for (const c of candidates) {
    const dbPath = join(c.dir, 'umi-claw.db')
    // 跳过当前库自身（3.0 现用 work.db，正常不会命中；防的是历史配置指回旧名）
    if (dbPath === join(currentDataDir, 'work.db')) continue
    if (existsSync(dbPath)) {
      out.push({ version: c.version, dbPath, present: true })
    }
  }
  return out
}

/**
 * 调用便携 Node 跑 read-old-db.mjs（只读），返回映射字段。
 * 失败（退出码非0）一律抛错，绝不静默当成功（硬规则 17）。
 */
function readLegacyDb(
  info: import('./work/wizardManager').OldDbInfo
): Promise<import('./work/wizardManager').OldDbMapping> {
  return new Promise((resolve, reject) => {
    const nodePath = configManager.getNodePath()
    const script = join(resourcesRoot(), 'database', 'read-old-db.mjs')
    execFile(
      nodePath,
      [script, '--dbPath', info.dbPath, '--version', info.version],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AppError(ERROR_CODES.FILE_PARSE_ERROR, `旧库只读映射失败: ${stderr || err.message}`, {
              reason: 'legacy-read-failed'
            })
          )
          return
        }
        try {
          const parsed = JSON.parse(String(stdout)) as {
            mapping: Record<string, unknown>
            displayOnlyCount: number
          }
          resolve({
            callName: asString(parsed.mapping.callName),
            position: asString(parsed.mapping.position),
            department: asString(parsed.mapping.department),
            company: asString(parsed.mapping.company),
            tone: asString(parsed.mapping.tone),
            displayOnlyCount: Number(parsed.displayOnlyCount ?? 0)
          })
        } catch (e) {
          reject(new AppError(ERROR_CODES.DB_ERROR, `旧库映射输出损坏: ${(e as Error).message}`))
        }
      }
    )
  })
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * 发本地通知（硬规则 22：只有三类——早上汇总 / 日报草稿 / **待办到点提醒**，无其他通知）。
 * id 仅用于日志与将来的点击跳转，通知内容全在 payload 里。
 */
function showReminderNotification(
  id: string,
  payload: import('./work/reminderManager').ReminderPayload
): void {
  // 本机通知现在是**必达主通道**（待办到点提醒不看外发配置），所以这里必须**不抛**：
  // 抛出去会被 reminderManager 的逐条兜底当成「未消费」→ 每 30s 重试一次，
  // 结果是永远弹不出来还一直刷日志。不可用就记日志放过（提醒照样消费）。
  try {
    if (!Notification.isSupported()) {
      console.log(`[reminder] 本机通知不可用（isSupported=false），跳过 ${id}: ${payload.title}`)
      return
    }
    const n = new Notification({ title: payload.title, body: payload.body })
    // 点击 morning → 打开/聚焦「新的一天」页；具体路由由渲染端处理，这里只展示
    void id
    n.show()
  } catch (e) {
    console.log(`[reminder] 本机通知失败（不影响提醒消费）: ${(e as Error)?.message}`)
  }
}

/**
 * 外发短提示（**方案 A**）：spawn OpenClaw 渠道 CLI 发一条消息。
 *
 * - 只发 payload.title + payload.body（构造上不可能带日报正文）
 * - 走与 gateway 启动同一套便携环境（buildOpenClawEnv），不另造一套路径
 * - 失败返回 { ok:false }，不抛——本地通知已送达，外发尽力而为
 */
function pushReminderMessage(
  dest: { channel: string; target: string },
  payload: import('./work/reminderManager').ReminderPayload
): Promise<import('./work/reminderManager').PushResult> {
  return new Promise((resolve) => {
    const dataDir = configManager.getDataDir()
    const nodePath = configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)
    if (!existsSync(nodePath) || !existsSync(clawJsPath)) {
      resolve({ ok: false, message: '未找到 OpenClaw 运行时' })
      return
    }
    const env = buildOpenClawEnv(dataDir, nodePath, { OPENCLAW_DISABLE_BONJOUR: '1' })
    const text = `${payload.title}\n${payload.body}`
    execFile(
      nodePath,
      [clawJsPath, 'message', 'send', '--channel', dest.channel, '--target', dest.target, '--message', text],
      { cwd: openClawPaths.installDir(dataDir), env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').toString().trim().slice(0, 300)
          resolve({ ok: false, message: detail || '外发命令失败' })
          return
        }
        resolve({ ok: true })
      }
    )
  })
}

/**
 * 列出可推送渠道及其配置状态（供外发下拉）。
 *
 * 「已配置」的判定依据：
 * - feishu / wecom：app.json 里 `channels.<key>` 必填凭证已填齐（与渠道页同口径）
 * - openclaw-weixin：插件已装 **且** 已有登录账号（走终端登录，不存 app.json）
 * - dingtalk：OpenClaw 无实现，永远 supported=false（仅用于提示）
 */
async function listPushChannelOptions(): Promise<
  import('./work/reminderManager').PushChannelOption[]
> {
  const appCfg = configManager.getConfig()
  const uiChannels = (appCfg.channels ?? {}) as Record<string, Record<string, unknown> | undefined>
  const filled = (key: string, fields: string[]): boolean => {
    const cfg = uiChannels[key]
    if (!cfg) return false
    return fields.every((f) => String(cfg[f] ?? '').trim() !== '')
  }

  // 微信：插件 + 登录账号双条件
  let weixinReady = false
  try {
    const accountsFile = join(configManager.getDataDir(), 'config', '.openclaw', 'openclaw-weixin', 'accounts.json')
    if (existsSync(accountsFile)) {
      const list = JSON.parse(readFileSync(accountsFile, 'utf-8')) as unknown
      weixinReady = Array.isArray(list) && list.length > 0
    }
  } catch {
    weixinReady = false
  }

  return [
    { channel: 'feishu', label: '飞书', configured: filled('feishu', ['appId', 'appSecret']), supported: true },
    { channel: 'wecom', label: '企业微信', configured: filled('wecom', ['corpId', 'agentId', 'secret']), supported: true },
    { channel: 'openclaw-weixin', label: '微信', configured: weixinReady, supported: true },
    { channel: 'dingtalk', label: '钉钉', configured: filled('dingtalk', ['appKey', 'appSecret']), supported: false }
  ]
}

/**
 * 列出某渠道下 OpenClaw **已经知道**的推送目标（用户不需手填）。
 *
 * 来源：OpenClaw 的 agent 库 `conversations` 表——它记住「谁跟它说过话」，
 * 每条含 `channel` / `delivery_target` / `kind`。取最近若干条，新→旧。
 *
 * 用便携 node 子进程读（同 clawManager 先例）：Electron 30 内置 node 未必启用 `node:sqlite`。
 * 只读打开，绝不写入。
 */
async function listPushTargetOptions(
  channel: string
): Promise<import('./work/reminderManager').PushTargetOption[]> {
  const dataDir = configManager.getDataDir()
  const nodePath = configManager.getNodePath()
  if (!existsSync(nodePath)) return []

  // agent 库路径：config/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
  const agentsDir = join(dataDir, 'config', '.openclaw', 'agents')
  if (!existsSync(agentsDir)) return []
  const dbPaths: string[] = []
  try {
    for (const agentId of readdirSync(agentsDir)) {
      const p = join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite')
      if (existsSync(p)) dbPaths.push(toPosix(p))
    }
  } catch {
    return []
  }
  if (!dbPaths.length) return []

  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    'const out = [];',
    'for (const dbPath of process.argv.slice(1)) {',
    '  try {',
    '    const db = new DatabaseSync(dbPath, { readOnly: true });',
    '    const rows = db.prepare("SELECT channel, delivery_target, kind, label, updated_at FROM conversations WHERE channel = ? ORDER BY updated_at DESC LIMIT 20").all(process.env.UCLawChannel);',
    '    for (const r of rows) out.push(r);',
    '    db.close();',
    '  } catch (e) {}',
    '}',
    'process.stdout.write(JSON.stringify(out));'
  ].join('\n')

  return new Promise((resolve) => {
    execFile(
      nodePath,
      ['-e', script, ...dbPaths],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, UCLawChannel: channel }
      },
      (err, stdout) => {
        if (err) {
          console.log(`[push] 读取目标失败: ${err.message}`)
          resolve([])
          return
        }
        try {
          const raw = JSON.parse(String(stdout || '[]')) as Array<Record<string, unknown>>
          // 去重（同一目标可能出现在多个 agent 库），保留最新
          const seen = new Set<string>()
          const out: import('./work/reminderManager').PushTargetOption[] = []
          for (const r of raw) {
            const target = String(r.delivery_target ?? '').trim()
            if (!target || seen.has(target)) continue
            seen.add(target)
            const kind = r.kind === 'group' ? 'group' : 'direct'
            const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : ''
            out.push({
              target,
              label: label || (kind === 'group' ? '群聊' : '私聊'),
              kind,
              updatedAt: Number(r.updated_at ?? 0)
            })
          }
          resolve(out)
        } catch {
          resolve([])
        }
      }
    )
  })
}

/**
 * 取 work 域各 Manager 单例（Commit 02）。
 *
 * 全部共用同一个 DatabaseClient 单例（硬规则 2：DB Worker 全局单例）。
 * 消费者是 IPC 层（ipc/work.ts）；渲染端拿不到 Manager 本身。
 */
function initWorkManagers(): {
  profile: ProfileManager
  matters: MatterManager
  todos: TodoManager
  records: RecordManager
  context: ContextManager
  today: TodayManager
  router: RouterManager
  reports: ReportManager
  qa: QaManager
  tools: ToolManager
  knowledge: KnowledgeManager
  wizard: WizardManager
  reminder: ReminderManager
} {
  if (!workDatabase) throw new Error('DB 客户端尚未初始化')
  workProfileManager = workProfileManager ?? createProfileManager({ database: workDatabase })
  workMatterManager = workMatterManager ?? createMatterManager({ database: workDatabase })
  workTodoManager = workTodoManager ?? createTodoManager({ database: workDatabase })
  workRecordManager = workRecordManager ?? createRecordManager({ database: workDatabase })
  // ContextEngine 读同一个 DB 单例；latest Pack 用 scope='latest' 当场组
  workContextEngine =
    workContextEngine ??
    createContextEngine({ database: workDatabase, logger: (m) => console.log(m) })
  const engine = workContextEngine
  workContextManager =
    workContextManager ??
    createContextManager({
      database: workDatabase,
      buildLatestPack: () => engine.buildPack('latest' as SnapshotScope, {})
    })
  // today / router（Commit 05）
  workTodayManager =
    workTodayManager ?? createTodayManager({ database: workDatabase })
  workRouterManager = workRouterManager ?? createRouterManager()
  // reports（Commit 06）：注入同一个 ContextEngine + Gateway Client
  if (!workReportManager) {
    if (!workGatewayClient) throw new Error('Gateway Client 尚未初始化')
    workReportManager = createReportManager({
      database: workDatabase,
      contextEngine: engine,
      gateway: workGatewayClient,
      logger: (m) => console.log(m)
    })
  }
  // qa（Commit 07）
  if (!workQaManager) {
    if (!workGatewayClient) throw new Error('Gateway Client 尚未初始化')
    workQaManager = createQaManager({
      database: workDatabase,
      contextEngine: engine,
      gateway: workGatewayClient,
      logger: (m) => console.log(m)
    })
  }
  // tools（Commit 07）：薄边界，复用 records/todos
  if (!workToolManager) {
    if (!workGatewayClient) throw new Error('Gateway Client 尚未初始化')
    workToolManager = createToolManager({
      records: workRecordManager!,
      todos: workTodoManager!,
      gateway: workGatewayClient,
      logger: (m) => console.log(m)
    })
  }
  // knowledge（Commit 08）：解析 pdfjs 资产 + dataDir
  if (!workKnowledgeManager) {
    const pdfjsAssets = resolvePdfjsAssets({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    })
    workKnowledgeManager = createKnowledgeManager({
      database: workDatabase,
      dataDir: configManager.getDataDir(),
      pdfjsAssets,
      logger: (m) => console.log(m)
    })
  }
  // wizard / reminder（Commit 09）
  workWizardManager =
    workWizardManager ??
    createWizardManager({
      database: workDatabase,
      locateOldDbs: () => locateLegacyDbs(configManager.getDataDir()),
      readOldDb: (info) => readLegacyDb(info),
      logger: (m) => console.log(m)
    })
  workReminderManager =
    workReminderManager ??
    createReminderManager({
      database: workDatabase,
      notifier: (id, payload) => showReminderNotification(id, payload),
      getMorningSummary: async () => {
        const todos = await workTodoManager!.list({ state: 'confirmed' })
        const today = dateOf(Date.now())
        const relevant = todos.filter((t) => t.due_date === null || String(t.due_date) <= today)
        return { count: relevant.length, titles: relevant.map((t) => t.title) }
      },
      // 方案 A（v0.9 拍板）：按配置外发**短提示**（不含正文），正文仍需人工确认
      pusher: async (_id, payload, dest) => pushReminderMessage(dest, payload),
      // 外发下拉只展示已配置的渠道（北：没配置肯定不能推）
      listPushChannels: () => listPushChannelOptions(),
      // 目标由 OpenClaw 自己给出（北：不需要填，openclaw 自己知道）
      listPushTargets: (channel) => listPushTargetOptions(channel),
      // v2：待办到点提醒——到点查询与提醒后回标（口径见 reminderManager 注释）
      listDueTodoReminders: async () =>
        (await workTodoManager!.listDueReminders()).map((t) => ({
          id: t.id,
          title: t.title,
          dueDate: t.due_date,
          dueAt: t.due_at
        })),
      markTodoReminded: (id, ts) => workTodoManager!.markReminded(id, ts),
      // 本地闭环（硬规则 22 重评估后拍板）：到点**先自动生成日报草稿**，再发通知。
      // 仍**不自动外发正文**——草稿进「报告」页等人工确认（硬规则 5）。
      generateDailyDraft: async () => {
        const rm = workReportManager
        if (!rm) return { status: 'error', message: '报告模块未就绪' }
        try {
          const handle = await rm.generate({ type: 'daily' })
          // 等流结束：草稿正文落 reports.content 后再发通知，避免「通知说好了但点进去是空的」
          const result = await handle.stream.result
          if (result.aborted) return { status: 'error', message: '生成已中止' }
          return { status: 'generated', reportId: handle.reportId }
        } catch (e) {
          const err = e as { details?: { reason?: string }; message?: string }
          if (err?.details?.reason === 'no-records') return { status: 'empty' }
          return { status: 'error', message: err?.message ?? '未知错误' }
        }
      },
      logger: (m) => console.log(m)
    })
  return {
    profile: workProfileManager,
    matters: workMatterManager,
    todos: workTodoManager,
    records: workRecordManager,
    context: workContextManager,
    today: workTodayManager,
    router: workRouterManager,
    reports: workReportManager,
    qa: workQaManager,
    tools: workToolManager,
    knowledge: workKnowledgeManager,
    wizard: workWizardManager,
    reminder: workReminderManager
  }
}

/**
 * 安全地终止并清理指定的终端会话
 */
function killTerminalSession(sessionId: string): boolean {
  const session = activeTerminalSessions.get(sessionId)
  if (!session) {
    // 兼容旧逻辑：如果没有 sessionId，尝试清理全局遗留（如果有）
    // 这里主要依赖 Map 管理，如果传入特定 ID 找不到，视为已清理
    return false
  }

  try {
    const proc = session.process
    if (!proc.killed) {
      // 优先发送 SIGTERM 允许优雅退出
      proc.kill('SIGTERM')

      // 设置超时，如果未退出则强制杀死
      setTimeout(() => {
        if (!proc.killed && proc.pid) {
          try {
            proc.kill('SIGKILL')
          } catch (e) {
            // 忽略进程已退出的错误
          }
        }
      }, 2000)
    }
  } catch (err) {
    console.error(`[PTY] 终止会话 ${sessionId} 时出错:`, err)
  } finally {
    activeTerminalSessions.delete(sessionId)
    return true
  }
}

/**
 * 清理所有活跃的终端会话（用于应用退出时）
 */
function killAllTerminalSessions() {
  const sessionIds = Array.from(activeTerminalSessions.keys())
  sessionIds.forEach(id => killTerminalSession(id))
}

// 标记：关闭确认对话框是否正在等待用户选择，避免重复弹出
let closeConfirmPending = false

/**
 * 统一的应用退出流程：标记退出、清理终端会话并停止 OpenClaw
 */
function quitApp(): void {
  ;(app as any).isQuiting = true
  killAllTerminalSessions()
  clawManager.stop().finally(() => app.quit())
}

/**
 * 根据配置同步系统开机自启项。
 * openAtLogin=true 时随系统启动；openAsHidden 让应用启动后直接驻留托盘（后台运行）。
 * 打包环境下才真正生效，开发环境跳过以免把 electron.exe 注册进启动项。
 */
function applyLoginItemSettings(launchOnBoot: boolean): void {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin: launchOnBoot,
        openAsHidden: launchOnBoot
      })
    } catch (err) {
      console.error('[Main] 设置开机自启失败:', err)
    }
  }
}

/**
 * 处理主窗口关闭事件，根据配置项 closeAction 决定行为：
 *  - 'exit' : 退出应用并停止 OpenClaw
 *  - 'tray' : 最小化到系统托盘后台运行
 *  - 'ask'  : 弹出确认对话框询问用户（可记住选择）
 * 当 minimizeToTray 为 false 时，'ask'/'tray' 一律直接退出。
 */
function handleWindowClose(e: Electron.Event): void {
  // 已进入退出流程（托盘退出、before-quit 等），放行让窗口真正关闭
  if ((app as any).isQuiting) {
    return
  }

  const config = configManager.getConfig()
  const closeAction = config.closeAction ?? 'ask'
  const minimizeToTray = config.minimizeToTray !== false

  // 未开启托盘驻留时，关闭即退出
  if (!minimizeToTray) {
    e.preventDefault()
    quitApp()
    return
  }

  if (closeAction === 'exit') {
    e.preventDefault()
    quitApp()
    return
  }

  if (closeAction === 'tray') {
    e.preventDefault()
    mainWindow?.hide()
    return
  }

  // closeAction === 'ask'：交给渲染层弹出确认对话框
  e.preventDefault()
  if (closeConfirmPending) {
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    closeConfirmPending = true
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('window:close-request')
  } else {
    quitApp()
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    icon: app.isPackaged
      ? join(process.resourcesPath, 'resources', 'icon.ico')
      : join(__dirname, "../../resources/icon.ico"),
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false, // 自定义标题栏
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 开机自启（openAsHidden）场景下不弹出窗口，直接后台驻留托盘
    const launchedAtLogin = app.getLoginItemSettings().wasOpenedAsHidden
    if (!launchedAtLogin) {
      mainWindow!.show()
    }
  })

  mainWindow.on('close', (e) => {
    handleWindowClose(e)
  })

  // 窗口完全关闭时，清理资源
  mainWindow.on('closed', () => {
    killAllTerminalSessions()
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 仅放行 http/https，拦截 file://、javascript: 等危险协议
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadURL('app://renderer/index.html')
  }
}

function createTray(): void {
  // 增加图标加载的错误处理，防止因图标缺失导致崩溃
  let icon: Electron.NativeImage
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'resources', 'tray.png')
      : join(__dirname, '../../resources/tray.png')
    if (!existsSync(iconPath)) {
      //  fallback 或者使用默认图标，这里假设必须存在，若不存在则使用空图像防止崩溃
      console.warn('Tray icon not found at:', iconPath)
      icon = nativeImage.createEmpty()
    } else {
      icon = nativeImage.createFromPath(iconPath)
    }
  } catch (e) {
    console.error('Failed to load tray icon', e)
    icon = nativeImage.createEmpty()
  }

  // 确保图标尺寸合适
  const resizedIcon = icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 })
  tray = new Tray(resizedIcon)

  const updateMenu = (running: boolean) => {
    const menu = Menu.buildFromTemplate([
      {
        label: running ? '🟢 OpenClaw 运行中' : '🔴 OpenClaw 已停止',
        enabled: false
      },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      {
        label: running ? '停止服务' : '启动服务',
        click: async () => {
          if (running) {
            await clawManager.stop()
          } else {
            // 硬性闸门：未同意用户协议不得启动（与 IPC 同口径）
            try {
              await workWizardManager?.ensureConsent()
              await clawManager.start()
            } catch (e) {
              console.error('[Tray] 启动被拒:', (e as Error)?.message)
            }
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          ; (app as any).isQuiting = true
          clawManager.stop().finally(() => app.quit())
        }
      }
    ])
    tray!.setContextMenu(menu)
  }

  tray.setToolTip('Umi Claw')
  updateMenu(false)
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  // 监听状态变化更新托盘
  clawManager.on('statusChange', (running: boolean) => updateMenu(running))
}

// ─── IPC 处理器 ───────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  // 关闭确认对话框的用户选择回传：tray=最小化到托盘，exit=退出并停止 OpenClaw
  ipcMain.handle('window:close-resolve', (_e, payload: { action: 'tray' | 'exit'; remember?: boolean }) => {
    closeConfirmPending = false
    const action = payload?.action ?? 'tray'
    const remember = payload?.remember === true
    if (remember && (action === 'tray' || action === 'exit')) {
      configManager.saveConfig({ closeAction: action })
    }
    if (action === 'exit') {
      quitApp()
    } else {
      mainWindow?.hide()
    }
  })
  // 用户取消关闭
  ipcMain.handle('window:close-cancel', () => {
    closeConfirmPending = false
  })

  // OpenClaw 进程管理
  // 硬性闸门（北 2026-09-24）：启动前必须已同意用户协议，否则拒绝并让前端弹回协议弹窗。
  const ensureConsentGate = async (): Promise<{ ok: true } | { ok: false; result: unknown }> => {
    try {
      await workWizardManager?.ensureConsent()
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        result: {
          success: false,
          reason: 'consent-required',
          error: (e as Error)?.message ?? '请先同意用户协议'
        }
      }
    }
  }

  ipcMain.handle('claw:start', async () => {
    const gate = await ensureConsentGate()
    if (!gate.ok) return gate.result
    return clawManager.start()
  })
  ipcMain.handle('claw:stop', async () => {
    return clawManager.stop()
  })
  ipcMain.handle('claw:restart', async () => {
    const gate = await ensureConsentGate()
    if (!gate.ok) return gate.result
    await clawManager.stop()
    return clawManager.start()
  })
  ipcMain.handle('claw:status', () => {
    return clawManager.getStatus()
  })
  ipcMain.handle('claw:openWeb', () => {
    const port = configManager.getConfig().port || 3213
    shell.openExternal(`http://localhost:${port}`)
  })

  // 应用版本：以 package.json 的 version 为唯一真相源（app.getVersion() 直接返回它）
  ipcMain.handle('app:getVersion', () => app.getVersion())

  // 配置管理
  ipcMain.handle('config:get', () => configManager.getConfig())
  ipcMain.handle('config:save', (_e, config) => {
    const saved = configManager.saveConfig(config)
    // 配置保存后同步开机自启项
    applyLoginItemSettings(saved.launchOnBoot)
    return saved
  })
  ipcMain.handle('config:reset', () => {
    const reset = configManager.resetConfig()
    applyLoginItemSettings(reset.launchOnBoot)
    return reset
  })
  ipcMain.handle('config:getDataDir', () => configManager.getDataDir())
  ipcMain.handle('config:getPresetModels', (_e, configName: string) =>
    configManager.getPresetModels(configName)
  )
  ipcMain.handle('config:refreshModelPresets', () => configManager.refreshModelPresets())
  ipcMain.handle('config:getModelPresetsInfo', () => configManager.getModelPresetsInfo())
  ipcMain.handle('config:openDataDir', () => shell.openPath(configManager.getDataDir()))

  // 环境初始化
  ipcMain.handle('env:check', () => downloadManager.checkEnvironment())
  ipcMain.handle('env:init', async (_e, options) => {
    return downloadManager.initEnvironment(options)
  })
  ipcMain.handle('env:update', async (_e, options) => {
    // 更新期间状态库不能被占用：先停网关，更新完执行 schema 迁移，再按需重启
    const wasRunning = clawManager.getStatus().running
    if (wasRunning) {
      await clawManager.stop()
    }
    const result = await downloadManager.updateOpenClaw(options)
    if (result.success) {
      const doctor = await clawManager.runDoctorFix()
      if (!doctor.success) {
        // 对齐 OpenClaw v2026.9.1：更新后 Doctor 失败 → 自动回滚 npm 候选版本，
        // 不把迁移不过去的新版本留在用户环境里；快照缺失（回滚不可用）才降级为警告。
        const rollback = await downloadManager.restoreOpenClawBackup()
        if (rollback.restored) {
          result.success = false
          result.rolledBack = true
          result.currentVersion = rollback.version
          result.error =
            `新版本数据库迁移（doctor --fix）失败，已自动回滚到 v${rollback.version ?? '原版本'}，` +
            `旧环境可继续使用，可稍后重试更新。失败原因：${doctor.error || '未知错误'}`
        } else {
          result.warning =
            'OpenClaw 已更新，但数据库迁移未成功：' + (doctor.error || '未知错误') +
            '。下次启动网关时应用会自动重试迁移；如异常持续可重新执行更新。'
        }
      } else {
        // 迁移通过：候选版本正式生效，此前保留的回滚快照可以删除
        // （清理失败仅留调试日志，残留快照不影响运行，下次更新会自动清理）。
        downloadManager.discardOpenClawBackup()
      }
    }
    // 更新成功或失败后已回滚，都恢复网关运行（旧版本回滚后重启可做到更新不中断工作）；
    // 回滚也失败时环境不确定，不贸然重启。
    if (wasRunning && (result.success || result.rolledBack)) {
      try {
        await clawManager.start()
      } catch (e: any) {
        // 网关重启失败不改变更新结果本身，附加警告由 UI 展示
        const restartWarning = `网关重启失败：${e.message}`
        if (result.success) {
          result.warning = [result.warning, restartWarning].filter(Boolean).join('；')
        } else {
          result.error = `${result.error}；${restartWarning}，请稍后在控制台手动启动`
        }
      }
    }
    return result
  })
  ipcMain.handle('env:checkLatest', async (_e, options) => {
    return downloadManager.checkLatestVersion(options)
  })
  ipcMain.handle('env:getInfo', () => downloadManager.getEnvInfo())
  // 查询可安装的 Node 版本列表（LTS + 当前版本，标记 OpenClaw 兼容性）
  ipcMain.handle('env:nodeVersions', async (_e, options) => {
    return downloadManager.getNodeVersions(options)
  })
  // 更新内置便携 Node 到指定版本：先停网关释放文件锁，结束后（无论成败）恢复原运行状态
  ipcMain.handle('env:updateNode', async (_e, options) => {
    const wasRunning = clawManager.getStatus().running
    if (wasRunning) {
      await clawManager.stop()
    }
    let result = await downloadManager.updateNodeRuntime(options)
    if (wasRunning) {
      try {
        await clawManager.start()
      } catch (e: any) {
        // 网关重启失败不改变更新结果本身，附加警告由 UI 展示
        result = { ...result, warning: `网关重启失败：${e.message}` }
      }
    }
    return result
  })

  // 日志
  ipcMain.handle('log:getLogs', () => clawManager.getLogs())
  ipcMain.handle('log:clearLogs', () => clawManager.clearLogs())

  // 技能管理
  ipcMain.handle('skills:list', () => clawManager.listSkills())
  ipcMain.handle('skills:install', (_e, skillId) => clawManager.installSkill(skillId))
  ipcMain.handle('skills:uninstall', (_e, skillId) => clawManager.uninstallSkill(skillId))
  ipcMain.handle('skills:getInstalledSkills', () => configManager.getInstalledSkills());
  ipcMain.handle('skills:toggleSkillStatus', (_event, id, enabled) => configManager.toggleSkillStatus(id, enabled));
  ipcMain.handle('skills:importSkillZip', async () => {
    return await configManager.importSkillZip()
  })
  ipcMain.handle('skills:syncFromRemote', () => skillSyncService.syncFromRemote())
  // 勾选更新：主进程先过滤非 string 项，service 内再做白名单校验与去重
  ipcMain.handle('skills:applyUpdates', (_e, ids: unknown) =>
    skillSyncService.applyUpdates(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []))
  ipcMain.handle('skills:getPendingUpdates', () => skillSyncService.getPendingUpdates())

  // 外部链接 - 增加简单的协议校验，防止 file:// 等危险协议
  // channels: plugin install for native long-connection channels (e.g. feishu)
  ipcMain.handle('channels:isPluginInstalled', (_e, pluginId: string) =>
    channelManager.isPluginInstalled(pluginId)
  )
  ipcMain.handle('channels:installPlugin', async (_e, pluginPkg: string) => {
    try {
      await channelManager.installPlugin(pluginPkg)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return shell.openExternal(url)
    }
    return Promise.reject(new Error('Invalid URL protocol'))
  })

  // 对话框 - 增加主窗口存在性检查
  ipcMain.handle('dialog:showMessage', (_e, options) => {
    const win = mainWindow || BrowserWindow.getFocusedWindow()
    if (!win) {
      // 如果没有窗口，使用 null 让 dialog 自动创建临时窗口或报错，视 Electron 版本而定
      // 通常建议至少有一个父窗口
      return dialog.showMessageBox(options as any)
    }
    return dialog.showMessageBox(win, options)
  })

  // 一键获取token - 优化安全性与逻辑
  ipcMain.handle('claw:get-token', async () => {
    const userHome = app.getPath('home')
    const dataDir = configManager.getDataDir()

    // 移除硬编码的 C:\tmp 和当前盘符根目录的随意扫描，聚焦于标准配置路径
    const envConfigDir = openClawPaths.configDir(dataDir);

    const possiblePaths = [
      // 1. 环境变量指定的核心目录 (最高优先级)
      join(envConfigDir, 'openclaw.json'),

      // 2. 用户家目录 (常见默认位置)
      join(userHome, '.openclaw', 'openclaw.json'),

      // 3. AppData 隔离数据目录的其他变体
      join(dataDir, 'openclaw', 'openclaw.json'),
    ]

    console.log('--- 🛡️ 开始扫描 OpenClaw 配置文件 ---')

    let finalPath = ''
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        finalPath = p
        console.log(`✅ 命中配置文件: ${p}`)
        break
      }
    }

    try {
      if (!finalPath) {
        throw new Error(
          `未找到 OpenClaw 配置文件。已检查以下路径：\n` +
          possiblePaths.map(p => `- ${p}`).join('\n')
        )
      }

      const configContent = readFileSync(finalPath, 'utf-8')
      const configJson = JSON.parse(configContent)

      // ⚠️ 安全警告：不要在生产环境日志中打印包含 Token 的完整 JSON
      const token = configJson?.gateway?.token || configJson?.gateway?.auth?.token

      if (!token) {
        throw new Error(`配置文件存在 (${finalPath})，但缺少 gateway.token 字段`)
      }

      return { success: true, token }
    } catch (err: any) {
      console.error('获取 Token 失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  // ─── 终端相关 IPC (统一使用 term:* 命名空间) ───

  /**
   * 执行一次性命令 (Snapshot)
   */
  const handleRunCommand = async (_e: any, args: string[], runtime?: TerminalRuntime) => {
    const { nodePath, cwd } = getOpenClawRuntimeConfig()
    const { entryJs, env, error } = resolveTerminalRuntime(runtime)

    if (error) {
      return { stdout: '', stderr: error, code: -1 }
    }

    // 基本的安全检查：限制参数长度，防止缓冲区溢出或极端情况
    if (args.length > 100) {
      return { stdout: '', stderr: '参数过多，拒绝执行', code: -1 }
    }

    return new Promise((resolve) => {
      try {
        const proc = spawn(nodePath, [entryJs, ...args], {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'] // 明确指定 stdio
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d) => (stdout += d.toString()))
        proc.stderr.on('data', (d) => (stderr += d.toString()))

        proc.on('exit', (code) => {
          resolve({ stdout, stderr, code })
        })

        proc.on('error', (err) => {
          resolve({ stdout: '', stderr: `子进程启动失败: ${err.message}`, code: -1 })
        })
      } catch (e: any) {
        resolve({ stdout: '', stderr: `执行异常: ${e.message}`, code: -1 })
      }
    })
  }

  ipcMain.handle('term:run', handleRunCommand)

  /**
   * 启动交互式 PTY 会话
   */
  const handleStartPty = async (_event: any, args: string[], _cols?: number, _rows?: number, runtime?: TerminalRuntime) => {
    // 如果已有活跃会话，先关闭它（单例模式策略，防止资源泄露）
    // 如果需要多会话，应移除此步并使用 sessionId 区分
    if (activeTerminalSessions.size > 0) {
      console.warn('检测到活跃终端会话，正在强制关闭以启动新会话')
      killAllTerminalSessions()
    }

    const { nodePath, cwd } = getOpenClawRuntimeConfig()
    const { entryJs, env, error } = resolveTerminalRuntime(runtime)
    const sessionId = `session_${Date.now()}`

    if (error) {
      // 返回带 error 字段的结果而非 null，让前端能拿到具体错误原因。
      // 不走 pty-chunk 发错误消息：前端 listener 按 sessionId 过滤，
      // 此时尚未建立 session，消息会被丢弃。
      return { error }
    }

    try {
      const ptyProc = spawn(nodePath, [entryJs, ...args], {
        env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'] // 需要 stdin 所以第一个是 pipe
      })

      // 保存会话
      activeTerminalSessions.set(sessionId, { process: ptyProc, id: sessionId })

      // 实时向前端推送数据
      ptyProc.stdout.on('data', (data) => {
        mainWindow?.webContents.send('term:pty-chunk', { sessionId, data: data.toString() })
      })

      ptyProc.stderr.on('data', (data) => {
        mainWindow?.webContents.send('term:pty-chunk', { sessionId, data: data.toString() })
      })

      // 监听进程退出
      ptyProc.on('exit', (exitCode) => {
        mainWindow?.webContents.send('term:pty-exit', { sessionId, exitCode: exitCode || 0 })
        // 自动清理
        activeTerminalSessions.delete(sessionId)
      })

      ptyProc.on('error', (err) => {
        console.error('PTY 进程错误:', err)
        activeTerminalSessions.delete(sessionId)
      })

      return sessionId
    } catch (err: any) {
      console.error('PTY 启动失败:', err)
      return null
    }
  }

  ipcMain.handle('term:pty-start', handleStartPty)

  /**
   * 向 PTY 写入输入
   */
  const handlePtyInput = (_e: any, sessionId: string, data: string) => {
    // 优先使用 sessionId 查找，如果没有提供 sessionId 或找不到，则兼容旧逻辑（查找最后一个）
    let proc: ChildProcessWithoutNullStreams | undefined

    if (sessionId && activeTerminalSessions.has(sessionId)) {
      proc = activeTerminalSessions.get(sessionId)?.process
    }

    // 兼容旧代码：如果没有 sessionId 或者前端没传对，尝试找任意一个活跃进程（不推荐，但为了兼容）
    if (!proc && activeTerminalSessions.size > 0) {
      const firstKey = activeTerminalSessions.keys().next().value
      if (firstKey) proc = activeTerminalSessions.get(firstKey)?.process
    }

    if (proc && proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(data)
    }
  }

  ipcMain.handle('term:pty-input', handlePtyInput)

  /**
   * 停止 PTY 会话
   */
  const handleStopPty = (_e: any, sessionId: string) => {
    // 如果前端传了 sessionId，杀特定的；否则杀所有的（兼容旧逻辑）
    if (sessionId && activeTerminalSessions.has(sessionId)) {
      return killTerminalSession(sessionId)
    }

    // 兼容旧的全局变量逻辑或无 ID 情况
    killAllTerminalSessions()
    return true
  }

  ipcMain.handle('term:pty-stop', handleStopPty)

  ipcMain.handle('term:pty-resize', (_e, _sid: string, _cols: number, _rows: number) => {
    // 如果需要支持 resize，这里应该查找进程并发送 SIGWINCH 或使用 pty.js 的 resize 方法
    // 目前 spawn 的标准子进程不支持动态 resize，除非使用 node-pty
    return true
  })
  ipcMain.handle('test-connection', async (_, config) => {
    try {
      // 模型列表接口：modelsListUrl 支持完整 URL 或路径，留空默认 {baseUrl}/models
      const customListUrl = String(config.modelsListUrl || '').trim()
      const base = String(config.baseUrl || '').replace(/\/+$/, '')
      const listUrl = customListUrl
        ? /^https?:\/\//i.test(customListUrl)
          ? customListUrl
          : `${base}${customListUrl.startsWith('/') ? customListUrl : `/${customListUrl}`}`
        : `${base}/models`
      // 超时：未配置时默认 900 秒（15 分钟），与模型配置的默认超时保持一致
      const rawTimeout = Number(config.timeoutSeconds)
      const timeoutSeconds = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(Math.round(rawTimeout), 86400)
        : 900
      const response = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(timeoutSeconds * 1000)
      })
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }
      const data = await response.json()
      const models = Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : []
      return { success: true, models }
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error)
      const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(msg)
      return {
        success: false,
        error: isTimeout ? `请求超时，国内模型卡顿可在配置中调大超时时间` : msg
      }
    }
  })

  // ── Obsidian 知识库 ──
  ipcMain.handle('obsidian:getConfig', () => obsidianManager.getObsidianConfig())
  ipcMain.handle('obsidian:saveConfig', (_e, cfg) => obsidianManager.saveObsidianConfig(cfg))
  ipcMain.handle('obsidian:selectVault', async () => obsidianManager.selectVault())
  ipcMain.handle('obsidian:getIndexStatus', () => obsidianManager.getIndexStatus())
  ipcMain.handle('obsidian:rebuildIndex', async () => {
    try {
      return await obsidianManager.rebuildIndex()
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  ipcMain.handle('obsidian:cancelIndex', async () => obsidianManager.cancelIndex())
  ipcMain.handle('obsidian:testEmbedding', async (_e, arg) => {
    // 不吞异常：失败时抛出，由渲染进程 try/catch 统一捕获。
    // 否则返回 {success:false} 会被前端当作成功（r.dim 为 undefined 仍显示"连通"）。
    return await obsidianManager.testEmbedding(arg)
  })
  ipcMain.handle('obsidian:getEmbeddingPresets', () => EMBEDDING_PRESETS)
  // 检索测试：失败时抛出，由渲染进程统一捕获展示
  ipcMain.handle('obsidian:testSearch', async (_e, arg) => obsidianManager.testSearch(arg))

}

// ─── 推送日志到渲染进程 ────────────────────────────────────────────────────────

function setupLogForwarding(): void {
  // 确保移除旧监听器以防止重复绑定（如果此函数可能被多次调用）
  // 由于是在 app.whenReady 中调用一次，通常没问题，但加上保护更好

  const logHandler = (line: string, type: 'stdout' | 'stderr') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claw:log', { line, type, time: Date.now() })
    }
  }

  const statusHandler = (running: boolean, port?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claw:statusChange', { running, port })
    }
  }

  clawManager.on('log', logHandler)
  channelManager.on('log', (line: string, type: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claw:log', { line, type, time: Date.now() })
    }
  })
  clawManager.on('statusChange', statusHandler)

  downloadManager.on('progress', (progress: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('env:progress', progress)
    }
  })
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])
if (app.isPackaged) {
  const exeDir = dirname(app.getPath('exe'))
  if (existsSync(join(exeDir, 'data'))) {
    // 便携模式（U 盘等，与 configManager 的便携判定一致）：
    // Electron 用户数据同样跟随 exe，保证换机器数据完整
    const portableUserData = join(exeDir, 'context-data')
    app.setPath('userData', portableUserData)
    app.setPath('sessionData', portableUserData)
  } else {
    // 普通安装：用户数据放 %APPDATA%\UmiClaw（与安装目录分离，
    // NSIS 更新时会清空安装目录，用户数据放里面会被一并清掉）
    const appDataRoot = join(app.getPath('appData'), 'UmiClaw')
    app.setPath('userData', appDataRoot)
    app.setPath('sessionData', appDataRoot)
  }
} else {
  // 开发环境下保持默认，或者指向项目内的临时夹
  app.setPath('userData', join(__dirname, '../../.dev-user-data'))
}

// ─── App 生命周期 ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.clawdesktop.app')
  protocol.handle('app', async (request) => {
    let urlPath = request.url.replace('app://', '')

    // 修复：去掉开头的所有斜杠，避免 Windows path.join 把路径解析成绝对路径导致文件找不到
    // 当 URL 是 app:///assets/xxx.js 时，替换后得到 /assets/xxx.js，开头斜杠会导致 join(outDir, urlPath) 出错
    while (urlPath.startsWith('/') || urlPath.startsWith('\\')) {
      urlPath = urlPath.substring(1);
    }

    // 如果是根路径，默认指向 index.html
    if (urlPath === '' || urlPath === '/') {
      urlPath = 'renderer/index.html'
    }

    // 去掉 URL 可能带有的参数或哈希（如 index.html?v=123）
    urlPath = urlPath.split('?')[0].split('#')[0]

    // 精准拼出磁盘绝对路径（此时大家都统一在 dist-electron 目录下）
    // resolve 规范化并做边界检查：URL 里的字面反斜杠不被浏览器当分隔符折叠，
    // 但 Windows 下 path 会解析它——不检查即可用 app://x/..\..\.. 逃出目录读任意文件
    const outDir = resolve(join(__dirname, '..'))
    const filePath = resolve(outDir, urlPath)
    if (filePath !== outDir && !filePath.startsWith(outDir + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      // 1. 同步读取文件二进制数据
      const data = readFileSync(filePath)

      // 2. 动态识别文件扩展名，给予精确的 Content-Type（这对于 Vite 启动的 JS 模块至关重要）
      const ext = parse(filePath).ext
      let contentType = 'text/html'
      if (ext === '.js' || ext === '.mjs') contentType = 'text/javascript'
      else if (ext === '.css') contentType = 'text/css'
      else if (ext === '.svg') contentType = 'image/svg+xml'
      else if (ext === '.json') contentType = 'application/json'
      else if (ext === '.png') contentType = 'image/png'
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg'

      // 3. 完美组装标准 Web Response 返回
      return new Response(data, {
        headers: { 'Content-Type': contentType }
      })
    } catch (error) {
      console.error(`[Protocol] 无法读取文件: ${filePath}`, error)
      return new Response('Not Found', { status: 404 })
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  configManager = new ConfigManager()
  skillSyncService = new SkillSyncService(configManager)
  clawManager = new ClawManager(configManager)
  downloadManager = new DownloadManager(configManager)
  channelManager =
    new ChannelManager(
      configManager
    )
  obsidianManager = new ObsidianManager(configManager)
  // 注入 Obsidian MCP 配置生成器：_syncOpenClawConfig 写回 openclaw.json 时调用
  configManager.setObsidianMcpInjector(() => obsidianManager.buildMcpServerConfig())

  // Obsidian 索引进度转发到渲染进程
  obsidianManager.on('progress', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('obsidian:index-progress', data)
    }
  })

  // ── work Gateway Client（Commit 01）：零 IO 副作用；starter 复用 clawManager 启停 ──
  workGatewayClient = createWorkGatewayClient()
  // ── work DB 客户端 + Manager（Commit 02）：构造不建库、不 spawn（首次调用才拉 Worker）──
  workDatabase = createWorkDatabase()
  const workManagers = initWorkManagers()

  registerIpcHandlers()
  // ── work.gateway（Commit 01：只读快照 + 探活/自动拉起/就绪轮询）──
  // 只注册两条通道；业务流（qa/tools/reports 的 SSE 增量）归各自 Commit
  registerGatewayIpc(workGatewayClient)
  // ── work.profile / work.matters / work.todos（Commit 02）──
  registerWorkIpc(workManagers)
  // ── 两个固定本地通知的轻量定时检查（硬规则22；不是调度系统）──
  workManagers.reminder.start()
  createWindow()
  createTray()
  setupLogForwarding()

  // 启动时同步开机自启项，保证与配置一致
  const startupConfig = configManager.getConfig()
  applyLoginItemSettings(startupConfig.launchOnBoot)

  // 自动启动服务：应用启动时自动运行 OpenClaw（同样受用户协议闸门约束）
  if (startupConfig.autoStart) {
    workWizardManager
      ?.ensureConsent()
      .then(() => clawManager.start())
      .catch((err) => {
        console.error('[Main] 自动启动 OpenClaw 失败:', err)
      })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  ; (app as any).isQuiting = true
  // 确保在退出前杀死所有子进程，防止孤儿进程
  killAllTerminalSessions()
  await clawManager.stop()
})

// 类型扩展
declare global {
  namespace Electron {
    interface App {
      isQuiting: boolean
    }
  }
}
export type { DownloadProgress }
