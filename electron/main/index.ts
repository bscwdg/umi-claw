import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  protocol
} from 'electron'
import { join, parse, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ClawManager } from './clawManager'
import { ConfigManager } from './configManager'
import { DownloadManager, type DownloadProgress } from './downloadManager'
import { ChannelManager } from './channelManager'
import { ObsidianManager } from './obsidian/obsidianManager'
import { EMBEDDING_PRESETS } from './modelConfig'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'
import { readFileSync, existsSync } from 'fs'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import type { TerminalRuntime } from '../../src/types/terminal'

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
            await clawManager.start()
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
  ipcMain.handle('claw:start', async () => {
    return clawManager.start()
  })
  ipcMain.handle('claw:stop', async () => {
    return clawManager.stop()
  })
  ipcMain.handle('claw:restart', async () => {
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
  ipcMain.handle('config:openDataDir', () => shell.openPath(configManager.getDataDir()))

  // 环境初始化
  ipcMain.handle('env:check', () => downloadManager.checkEnvironment())
  ipcMain.handle('env:init', async (_e, options) => {
    return downloadManager.initEnvironment(options)
  })
  ipcMain.handle('env:update', async (_e, options) => {
    return downloadManager.updateOpenClaw(options)
  })
  ipcMain.handle('env:checkLatest', async (_e, options) => {
    return downloadManager.checkLatestVersion(options)
  })
  ipcMain.handle('env:getInfo', () => downloadManager.getEnvInfo())

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
    const outDir = join(__dirname, '..')
    const filePath = join(outDir, urlPath)

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

  registerIpcHandlers()
  createWindow()
  createTray()
  setupLogForwarding()

  // 启动时同步开机自启项，保证与配置一致
  const startupConfig = configManager.getConfig()
  applyLoginItemSettings(startupConfig.launchOnBoot)

  // 自动启动服务：应用启动时自动运行 OpenClaw
  if (startupConfig.autoStart) {
    clawManager.start().catch((err) => {
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
