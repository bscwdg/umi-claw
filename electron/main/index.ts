import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  session
} from 'electron'
import { join, parse } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ClawManager } from './clawManager'
import { ConfigManager } from './configManager'
import { DownloadManager } from './downloadManager'
import { readFileSync, existsSync } from 'fs'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let clawManager: ClawManager
let configManager: ConfigManager
let downloadManager: DownloadManager

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
    if (!app.isQuiting) {
      e.preventDefault()
      mainWindow!.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))

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
          app.isQuiting = true
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

  // 外部链接
  ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url))

  // 对话框
  ipcMain.handle('dialog:showMessage', (_e, options) => dialog.showMessageBox(mainWindow!, options))

  // 一键获取token
  ipcMain.handle('claw:get-token', async () => {
  const userHome = app.getPath('home')                     // C:\Users\遥远而清澈
  const dataDir = configManager.getDataDir()               // AppData 中的数据目录
  
  // ⚡️ 新增：动态获取当前项目/程序运行所在的盘符根目录（如果项目在U盘 D 盘，这里就是 D:\）
  const currentDriveRoot = parse(process.cwd()).root       // 例如 "D:\\" 或 "E:\\"
  
  // 1. 🔍 重新编排嫌疑路径表（加入绝对根目录和盘符根目录逻辑）
  // 嫌疑 0：你前面在 start() 里亲手给 OpenClaw 指定的配置环境变量路径（最高优先级）
  const envConfigDir = join(dataDir, 'config', '.openclaw');

  const possiblePaths = [
    // 💡 优先检查你指定的 env 核心目录
    join(envConfigDir, 'config.json'),
    join(envConfigDir, 'openclaw.json'),
    join(envConfigDir, '..', 'config.json'), // 防止它写在父级

    // 嫌疑 1：用户家目录
    join(userHome, '.openclaw', 'config.json'),
    join(userHome, '.openclaw', 'openclaw.json'),
    join(userHome, 'openclaw', 'config.json'), // 容错：不带点的普通文件夹
    
    // 嫌疑 2：AppData 里的应用隔离数据目录
    join(dataDir, 'config', '.openclaw', 'config.json'),
    join(dataDir, 'config', '.openclaw', 'openclaw.json'),
    join(dataDir, 'openclaw', 'config.json'),
    join(dataDir, 'openclaw', 'openclaw.json'),
    
    // 嫌疑 3：当前运行盘符（如 U 盘/D盘/E盘）下的根目录（完美防御 \tmp\ 现象）
    join(currentDriveRoot, 'tmp', 'openclaw', 'config.json'),
    join(currentDriveRoot, 'tmp', 'openclaw', 'openclaw.json'),
    join(currentDriveRoot, '.openclaw', 'config.json'),
    join(currentDriveRoot, 'openclaw', 'config.json'), // 容错：盘符根目录下不带点的文件夹
    join(currentDriveRoot, 'tmp', 'openclaw', '.openclaw', 'config.json'),
    join(currentDriveRoot, 'tmp', 'openclaw', 'openclaw', 'config.json'),
    
    // 嫌疑 4：C 盘绝对根目录下的临时文件夹（兜底）
    'C:\\tmp\\openclaw\\config.json',
    'C:\\tmp\\openclaw\\openclaw.json',
    'C:\\.openclaw\\config.json',
    'C:\\openclaw\\config.json'
  ]

  console.log('--- 🛡️ 开始全盘多盘符扫描 OpenClaw 配置文件 ---')
  console.log(`当前检测到的程序运行盘符根目录为: ${currentDriveRoot}`)
  
  let finalPath = ''
  for (const p of possiblePaths) {
    console.log(`正在检查: ${p} -> ${existsSync(p) ? '【存在 ✅】' : '【不存在 ❌】'}`)
    if (existsSync(p)) {
      finalPath = p
      break 
    }
  }

  try {
    if (!finalPath) {
      throw new Error(
        `全盘扫描失败。已检查以下路径（含当前盘符 ${currentDriveRoot}）均未发现 config.json：\n` + 
        possiblePaths.map(p => `- ${p}`).join('\n')
      )
    }

    // 2. 命中后读取
    console.log(`🎯 成功在盘符关联路径中命中配置文件: ${finalPath}`)
    const configContent = readFileSync(finalPath, 'utf-8')
    const configJson = JSON.parse(configContent)
    console.log(configJson,'configJson')
    const token = configJson?.gateway?.token ? configJson?.gateway?.token : configJson?.gateway?.auth?.token

    if (!token) {
      throw new Error(`找到了配置文件(${finalPath})，但里面缺失 gateway.token 字段`)
    }

    return { success: true, token }
  } catch (err: any) {
    console.error('获取 Token 内部报错:', err)
    return { success: false, error: err.message }
  }
})

}

// ─── 推送日志到渲染进程 ────────────────────────────────────────────────────────

function setupLogForwarding(): void {
  clawManager.on('log', (line: string, type: 'stdout' | 'stderr') => {
    mainWindow?.webContents.send('claw:log', { line, type, time: Date.now() })
  })
  clawManager.on('statusChange', (running: boolean, port?: number) => {
    mainWindow?.webContents.send('claw:statusChange', { running, port })
  })
  downloadManager.on('progress', (progress: DownloadProgress) => {
    mainWindow?.webContents.send('env:progress', progress)
  })
}

// ─── App 生命周期 ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.clawdesktop.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  configManager = new ConfigManager()
  clawManager = new ClawManager(configManager)
  downloadManager = new DownloadManager(configManager)

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
  app.isQuiting = true
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
