// test/fixtures/electron-stub.mjs —— 验收专用：替代 'electron' 模块（**边界打桩，非替身逻辑**）
//
// 为什么需要它：`electron/main/configManager.ts` 顶层就 `import { app, dialog } from 'electron'`，
// 而在纯 Node 下解析 'electron' 得到的是「指向 electron.exe 的字符串路径」，
// named import 会在 import 阶段直接炸（不是运行时才炸）。
//
// 这里只桩掉 Electron 的**宿主 API**（app/dialog/shell/ipcMain），
// 被验收的配置生成 / 老用户迁移 / meta 修正逻辑**仍然是真源码**。
// 另外 `ConfigManager` 的数据目录支持 `CLAW_DATA_DIR` 环境变量（见其构造函数），
// 验收走的是那条分支，因此桩里的 `getPath` 在验收路径上不会被使用。

export const app = {
  isPackaged: false,
  getPath: (name) => (name === 'appData' ? process.env.APPDATA || process.cwd() : process.cwd()),
  getAppPath: () => process.cwd(),
  getVersion: () => '1.1.0-test-stub',
  getName: () => 'umi-claw-test',
  quit: () => {},
  on: () => {}
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {}
}

export const shell = {
  openExternal: async () => '',
  openPath: async () => ''
}

export const ipcMain = {
  handle: () => {},
  removeHandler: () => {},
  on: () => {}
}

export const BrowserWindow = class {}

export default { app, dialog, shell, ipcMain, BrowserWindow }
