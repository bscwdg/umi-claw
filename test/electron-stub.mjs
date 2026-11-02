// electron-stub.mjs —— 验收测试用的 electron 替身（插件 main 打包时 alias 到这里）
// 目的：让 marketing/work 的 main 能在 node 下 import 而不启动 Electron。
// 只做最小可用桩：断言都在测试侧，不等于真实 Electron 行为。

export const app = {
  isPackaged: false,
  getVersion: () => '0.0.0-test',
  getPath: () => '',
  getAppPath: () => '',
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  whenReady: () => Promise.resolve(),
  quit: () => undefined,
  exit: () => undefined,
  relaunch: () => undefined,
  setPath: () => undefined,
  getName: () => 'umi-claw-test',
  commandLine: { appendSwitch: () => undefined, hasSwitch: () => false }
}

export const ipcMain = {
  handle: () => undefined,
  removeHandler: () => undefined,
  on: () => undefined,
  once: () => undefined,
  removeAllListeners: () => undefined
}

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => undefined,
  off: () => undefined,
  send: () => undefined
}

export class BrowserWindow {
  static getAllWindows() {
    return []
  }
  static getFocusedWindow() {
    return null
  }
  constructor() {
    this.webContents = { send: () => undefined, on: () => undefined, executeJavaScript: async () => '' }
    this.isDestroyed = () => false
    this.isMinimized = () => false
    this.isVisible = () => true
  }
  loadURL() {
    return Promise.resolve()
  }
  loadFile() {
    return Promise.resolve()
  }
  show() {}
  hide() {}
  close() {}
  focus() {}
  restore() {}
  destroy() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setPosition() {}
  getPosition() {
    return [0, 0]
  }
  on() {}
  once() {}
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: () => undefined
}

export const shell = {
  openPath: async () => '',
  openExternal: async () => '',
  showItemInFolder: () => undefined
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(String(value)),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8')
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: () => ({ isEmpty: () => true })
}

export const clipboard = { writeText: () => undefined, readText: () => '' }
export const Menu = {
  buildFromTemplate: () => ({ popup: () => undefined }),
  setApplicationMenu: () => undefined
}
export const Tray = class {
  setToolTip() {}
  setContextMenu() {}
  on() {}
  destroy() {}
}
export const Notification = class {
  constructor() {
    this.on = () => undefined
  }
  show() {}
  close() {}
  static isSupported() {
    return false
  }
}
export const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
}
export const session = { defaultSession: { setPermissionRequestHandler: () => undefined } }
export const protocol = { registerFileProtocol: () => undefined }
export const net = { fetch: async () => ({ ok: false, status: 0 }) }
export const globalShortcut = {
  register: () => true,
  unregister: () => undefined,
  unregisterAll: () => undefined,
  isRegistered: () => false
}
export const powerMonitor = { on: () => undefined, getSystemIdleTime: () => 0 }
export const systemPreferences = { getMediaAccessStatus: () => 'granted' }
export const contextBridge = { exposeInMainWorld: () => undefined }

export default {
  app,
  ipcMain,
  ipcRenderer,
  BrowserWindow,
  dialog,
  shell,
  safeStorage,
  nativeImage,
  clipboard,
  Menu,
  Tray,
  Notification,
  screen,
  session,
  protocol,
  net,
  globalShortcut,
  powerMonitor,
  systemPreferences,
  contextBridge
}
