/**
 * esbuild alias stub for 'electron'（仅验收测试用）。
 *
 * 目的：让 test/*.accept.mjs 能在纯 node 下 bundle 主进程模块（clawManager →
 * configManager / modelPresets 都 `import { app, dialog } from 'electron'`），
 * 而不需要启动真实 Electron、更不碰真实网关与用户数据。
 *
 * 只提供模块求值期用得到的形状；方法一律返回安全默认值。
 */
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
  getVersion: () => '0.0.0-test'
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => undefined
}

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => ''
}

export const ipcMain = {
  handle: () => undefined,
  on: () => undefined
}

export default { app, dialog, shell, ipcMain }
