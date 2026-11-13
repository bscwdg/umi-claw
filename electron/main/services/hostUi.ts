// electron/main/services/hostUi.ts —— 宿主 electron 能力的窄适配（4.1 WP6-b）
//
// 插件 IPC 文件搬进 plugins/<id>/main/ipc/ 后不能再 `import ... from 'electron'`（边界门禁），
// 但 work/marketing 的 IPC 确实要用：文件选择对话框、聚焦窗口。
// 这里做一层最小适配：插件 IPC 只 import 本文件（services 允许），electron 细节留在宿主。
//
// 注意：`BrowserWindow` 等类型以 `import type` 暴露给调用方是允许的（门禁放行 type-only），
// 但运行时对象（dialog / BrowserWindow 静态方法）必须经本模块函数获取。
// A3a 起不再导出裸 ipcMain：通道只能经 ctx.registerChannelIpc 注册。

import { BrowserWindow, dialog } from 'electron'

/** 聚焦窗口（可能为空：无窗口/应用未就绪） */
export function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

export interface HostOpenDialogOptions {
  title?: string
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface HostOpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

/** 打开文件/目录选择框（有父窗口时挂 sheet） */
export function showOpenDialog(
  window: BrowserWindow | null | undefined,
  options: HostOpenDialogOptions
): Promise<HostOpenDialogResult> {
  return window
    ? (dialog.showOpenDialog(window, options as never) as Promise<HostOpenDialogResult>)
    : (dialog.showOpenDialog(options as never) as Promise<HostOpenDialogResult>)
}
