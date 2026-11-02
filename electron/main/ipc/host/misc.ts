// electron/main/ipc/host/misc.ts —— 宿主杂项 IPC（4.1 WP5-a：从 index.ts 拆出）
//
// 内容：窗口控制 / 应用版本 / 网关日志 / 外链 / 通用对话框 / Obsidian 知识库。
// 为什么先拆这一组：这些 handler 只依赖「窗口、configManager、clawManager 日志、shell/dialog、
// obsidianManager」五个窄能力，不牵扯 env 更新等大块状态；拆出后 index.ts 只剩组装。
// deps 用 getter：宿主是晚初始化（mainWindow/clawManager 在 whenReady 里才赋值）。

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { EMBEDDING_PRESETS } from '../../modelConfig'

/** Obsidian 管理器的最小接口（宿主 ObsidianManager 的实现恰好满足） */
export interface ObsidianIpcApi {
  getObsidianConfig(): unknown
  saveObsidianConfig(cfg: unknown): unknown
  selectVault(): Promise<unknown>
  getIndexStatus(): unknown
  rebuildIndex(): Promise<unknown>
  cancelIndex(): unknown
  testEmbedding(arg: unknown): Promise<unknown>
  testSearch(arg: unknown): Promise<unknown>
}

export interface MiscIpcDeps {
  getMainWindow: () => BrowserWindow | null
  setCloseConfirmPending: (pending: boolean) => void
  /** 关闭确认里「记住选择」：只写 app.json，跳过 openclaw 配置同步 */
  saveCloseAction: (action: 'tray' | 'exit') => void
  quitApp: () => void
  getLogs: () => unknown
  clearLogs: () => unknown
  obsidian: () => ObsidianIpcApi
}

export function registerMiscIpc(deps: MiscIpcDeps): void {
  // ── 窗口控制 ──
  ipcMain.handle('window:minimize', () => deps.getMainWindow()?.minimize())
  ipcMain.handle('window:maximize', () => {
    const win = deps.getMainWindow()
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.handle('window:close', () => deps.getMainWindow()?.close())
  // 关闭确认对话框的用户选择回传：tray=最小化到托盘，exit=退出并停止 OpenClaw
  ipcMain.handle(
    'window:close-resolve',
    (_e, payload: { action: 'tray' | 'exit'; remember?: boolean }) => {
      deps.setCloseConfirmPending(false)
      const action = payload?.action ?? 'tray'
      const remember = payload?.remember === true
      if (remember && (action === 'tray' || action === 'exit')) {
        // closeAction 是纯 UI 偏好、不进 openclaw.json：skipSync 跳过 config patch，
        // 避免退出时 fire-and-forget 一次冷启动 spawn（约 12s）而 quitApp 不等。
        deps.saveCloseAction(action)
      }
      if (action === 'exit') {
        deps.quitApp()
      } else {
        deps.getMainWindow()?.hide()
      }
    }
  )
  // 用户取消关闭
  ipcMain.handle('window:close-cancel', () => {
    deps.setCloseConfirmPending(false)
  })

  // ── 应用版本：以 package.json 的 version 为唯一真相源 ──
  ipcMain.handle('app:getVersion', () => app.getVersion())

  // ── 网关日志 ──
  ipcMain.handle('log:getLogs', () => deps.getLogs())
  ipcMain.handle('log:clearLogs', () => deps.clearLogs())

  // ── 外部链接：只放行 http(s)，防止 file:// 等危险协议 ──
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return shell.openExternal(url)
    }
    return Promise.reject(new Error('Invalid URL protocol'))
  })

  // ── 通用对话框：优先挂主窗口做 sheet ──
  ipcMain.handle('dialog:showMessage', (_e, options) => {
    const win = deps.getMainWindow() || BrowserWindow.getFocusedWindow()
    if (!win) {
      // 无窗口时用不带父窗口的重载（Electron 会创建临时窗口；有父窗口更稳）
      return dialog.showMessageBox(options as never)
    }
    return dialog.showMessageBox(win, options as never)
  })

  // ── Obsidian 知识库 ──
  ipcMain.handle('obsidian:getConfig', () => deps.obsidian().getObsidianConfig())
  ipcMain.handle('obsidian:saveConfig', (_e, cfg) => deps.obsidian().saveObsidianConfig(cfg))
  ipcMain.handle('obsidian:selectVault', async () => deps.obsidian().selectVault())
  ipcMain.handle('obsidian:getIndexStatus', () => deps.obsidian().getIndexStatus())
  ipcMain.handle('obsidian:rebuildIndex', async () => {
    try {
      return await deps.obsidian().rebuildIndex()
    } catch (e) {
      return { success: false, error: (e as Error)?.message ?? String(e) }
    }
  })
  ipcMain.handle('obsidian:cancelIndex', async () => deps.obsidian().cancelIndex())
  ipcMain.handle('obsidian:testEmbedding', async (_e, arg) => {
    // 不吞异常：失败时抛出，由渲染进程 try/catch 统一捕获。
    // 否则返回 {success:false} 会被前端当作成功（r.dim 为 undefined 仍显示「连通」）。
    return await deps.obsidian().testEmbedding(arg)
  })
  ipcMain.handle('obsidian:getEmbeddingPresets', () => EMBEDDING_PRESETS)
  // 检索测试：失败时抛出，由渲染进程统一捕获展示
  ipcMain.handle('obsidian:testSearch', async (_e, arg) => deps.obsidian().testSearch(arg))
}
