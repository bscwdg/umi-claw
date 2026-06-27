import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  session,
  WebContents,
  protocol
} from 'electron'
import { join, parse, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ClawManager } from './clawManager'
import { ConfigManager } from './configManager'
import { DownloadManager } from './downloadManager'
import { ChannelManager } from './channelManager'
import { readFileSync, existsSync } from 'fs'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'

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

// 使用 Map 管理活跃的终端进程，避免 global 污染和内存泄漏
const activeTerminalSessions = new Map<string, TerminalSession>()

/**
 * 获取 OpenClaw 运行所需的环境变量和路径配置
 * 统一提取重复逻辑，确保环境一致性
 */
function getOpenClawRuntimeConfig() {
  const dataDir = configManager.getDataDir()
  const nodePath = configManager.getNodePath() // D:\...\data\runtime\node-win32-x64\node.exe
  const targetConfigDir = join(dataDir, 'config')
  const clawJsPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')

  // 统一路径分隔符为正斜杠，兼容 Node.js 内部处理
  const safeConfigDir = targetConfigDir.replace(/\\/g, '/')
  const safeDataDir = join(dataDir, 'data').replace(/\\/g, '/')

  // 🌟 核心修复：精准拿到绿色 Node 所在的 bin 目录
  const nodeBinDir = dirname(nodePath)

  // 🌟 核心修复：拼装跨平台的环境变量隔离，把绿色 Node 目录强行顶到最前面
  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const systemPath = process.env.PATH || ''
  const isolatedPath = `${nodeBinDir}${pathDelimiter}${systemPath}`

  const env = {
    ...process.env,
    PATH: isolatedPath,
    HOME: safeConfigDir,        // 🚀 此时 safeConfigDir 已经变成了 .../config
    USERPROFILE: safeConfigDir, // 🚀 此时 OpenClaw 的 doctor 会在里面完美建出 .openclaw 且绝不套娃
    OPENCLAW_CONFIG_DIR: join(targetConfigDir, '.openclaw').replace(/\\/g, '/'), // 🎯 精准指向最终配置夹
    OPENCLAW_DATA_DIR: safeDataDir,
    NODE_ENV: 'production',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    PYTHONIOENCODING: 'utf-8'
  }

  return {
    nodePath,
    clawJsPath,
    cwd: join(dataDir, 'openclaw'), // 已经锁定了工作目录，很棒！
    env,
    targetConfigDir
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
    mainWindow!.show()
  })

  mainWindow.on('close', (e) => {
    if (!(app as any).isQuiting) {
      e.preventDefault()
      mainWindow!.hide()
    }
  })

  // 窗口完全关闭时，清理资源
  mainWindow.on('closed', () => {
    killAllTerminalSessions()
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
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
    const iconPath = join(__dirname, '../../resources/tray.png')
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
  ipcMain.handle('window:close', () => mainWindow?.hide())

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
    shell.openExternal('http://localhost:3213')
  })

  // 配置管理
  ipcMain.handle('config:get', () => configManager.getConfig())
  ipcMain.handle('config:save', (_e, config) => configManager.saveConfig(config))
  ipcMain.handle('config:reset', () => configManager.resetConfig())
  ipcMain.handle('config:getDataDir', () => configManager.getDataDir())
  ipcMain.handle('config:openDataDir', () => shell.openPath(configManager.getDataDir()))

  // 环境初始化
  ipcMain.handle('env:check', () => downloadManager.checkEnvironment())
  ipcMain.handle('env:init', async (_e, options) => {
    return downloadManager.initEnvironment(options)
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
  ipcMain.handle('skills:toggleSkillStatus', (event, id, enabled) => configManager.toggleSkillStatus(id, enabled));
  ipcMain.handle('skills:importSkillZip', async () => {
    return await configManager.importSkillZip()
  })

  // 外部链接 - 增加简单的协议校验，防止 file:// 等危险协议
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
    const envConfigDir = join(dataDir, 'config', '.openclaw');

    const possiblePaths = [
      // 1. 环境变量指定的核心目录 (最高优先级)
      join(envConfigDir, 'openclaw.json'),

      // 2. 用户家目录 (常见默认位置)
      join(userHome, '.openclaw', 'openclaw.json'),

      // 3. AppData 隔离数据目录的其他变体
      join(dataDir, 'config', '.openclaw', 'openclaw.json'), // 重复但保留以防逻辑差异
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
      // console.log(configJson, 'configJson') // 已移除

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

  // ─── 终端相关 IPC (统一合并逻辑，废弃旧的 terminal:* 命名空间，但保留兼容) ───

  /**
   * 执行一次性命令 (Snapshot)
   */
  const handleRunCommand = async (_e: any, args: string[]) => {
    const { nodePath, clawJsPath, cwd, env } = getOpenClawRuntimeConfig()

    // 基本的安全检查：限制参数长度，防止缓冲区溢出或极端情况
    if (args.length > 100) {
      return { stdout: '', stderr: '参数过多，拒绝执行', code: -1 }
    }

    return new Promise((resolve) => {
      try {
        const proc = spawn(nodePath, [clawJsPath, ...args], {
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

  // 注册兼容的 IPC 句柄
  ipcMain.handle('terminal:runCommand', handleRunCommand)
  ipcMain.handle('term:run', handleRunCommand)

  /**
   * 启动交互式 PTY 会话
   */
  const handleStartPty = async (event: any, args: string[], cols?: number, rows?: number) => {
    // 如果已有活跃会话，先关闭它（单例模式策略，防止资源泄露）
    // 如果需要多会话，应移除此步并使用 sessionId 区分
    if (activeTerminalSessions.size > 0) {
      console.warn('检测到活跃终端会话，正在强制关闭以启动新会话')
      killAllTerminalSessions()
    }

    const { nodePath, clawJsPath, cwd, env } = getOpenClawRuntimeConfig()
    const sessionId = `session_${Date.now()}`

    try {
      const ptyProc = spawn(nodePath, [clawJsPath, ...args], {
        env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'] // 需要 stdin 所以第一个是 pipe
      })

      // 保存会话
      activeTerminalSessions.set(sessionId, { process: ptyProc, id: sessionId })

      // 实时向前端推送数据
      ptyProc.stdout.on('data', (data) => {
        // 兼容两种事件名
        mainWindow?.webContents.send('terminal:onPtyChunk', { sessionId, data: data.toString() })
        mainWindow?.webContents.send('term:pty-chunk', { sessionId, data: data.toString() })
      })

      ptyProc.stderr.on('data', (data) => {
        mainWindow?.webContents.send('terminal:onPtyChunk', { sessionId, data: data.toString() })
        mainWindow?.webContents.send('term:pty-chunk', { sessionId, data: data.toString() })
      })

      // 监听进程退出
      ptyProc.on('exit', (exitCode) => {
        mainWindow?.webContents.send('terminal:onPtyExit', { sessionId, exitCode: exitCode || 0 })
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

  ipcMain.handle('terminal:startPty', handleStartPty)
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

  ipcMain.handle('terminal:inputPty', handlePtyInput)
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

  ipcMain.handle('terminal:stopPty', handleStopPty)
  ipcMain.handle('term:pty-stop', handleStopPty)

  // 空实现保底
  ipcMain.handle('terminal:removeListeners', () => true)
  ipcMain.handle('term:pty-resize', (_e, sid: string, cols: number, rows: number) => {
    // 如果需要支持 resize，这里应该查找进程并发送 SIGWINCH 或使用 pty.js 的 resize 方法
    // 目前 spawn 的标准子进程不支持动态 resize，除非使用 node-pty
    return true
  })
  ipcMain.handle('test-connection', async (_, config) => {
    try {
      const response = await fetch(
        `${config.baseUrl}/models`,
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`
          }
        }
      )
      const data = await response.json()
      return {
        success: true,
        models: data.data.map((m) => m.id)
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      }
    }
  })

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
  // 生产环境下，直接写在软件运行根目录的 context-data 文件夹里
  const customUserDataPath = join(process.resourcesPath, '../context-data')
  app.setPath('userData', customUserDataPath)
  app.setPath('sessionData', customUserDataPath)
} else {
  // 开发环境下保持默认，或者指向项目内的临时夹
  app.setPath('userData', join(__dirname, '../../.dev-user-data'))
}

// ─── App 生命周期 ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.clawdesktop.app')

  protocol.handle('app', async (request) => {
    let urlPath = request.url.replace('app://', '')

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


  registerIpcHandlers()
  createWindow()
  createTray()
  setupLogForwarding()

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