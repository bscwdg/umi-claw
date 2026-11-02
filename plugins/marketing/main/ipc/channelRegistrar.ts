// plugins/marketing/main/ipc/channelRegistrar.ts —— 通道注册器的统一注入点（Phase 3 装箱）
//
// work 用的是 plugins/work/main/ipc/work.ts 自带的 setWorkIpcRegistrar；marketing 这边有 5 个 ipc 文件
// （marketing / advisor / scan / content / hot），各自复制一份注入点太脏，
// 所以抽出这个共享模块：插件激活时接上 ctx.registerChannelIpc，停用即摘除。

export interface ChannelRegistrar {
  /** 只需要 payload（可多参） */
  handle(channel: string, fn: (...args: any[]) => Promise<unknown>): void
  /** 需要原始 IPC 事件（流式通道拿 event.sender） */
  handleEvent(channel: string, fn: (event: any, ...args: any[]) => Promise<unknown>): void
}

// 4.1 WP6-b：本文件已搬进插件目录，不能再 require('electron')（边界门禁连非 type 引用也计）。
// 生产路径在插件 activate 里必然先 setChannelRegistrar(ctx.registerChannelIpc) 再注册；
// 未注入就注册属于接线错误，直接抛错比静默落到宿主 ipcMain 更安全。
const defaultRegistrar: ChannelRegistrar = {
  handle() {
    throw new Error(
      '通道注册器未注入：插件必须在注册 IPC 前 setChannelRegistrar(ctx.registerChannelIpc)'
    )
  },
  handleEvent() {
    throw new Error(
      '通道注册器未注入：插件必须在注册 IPC 前 setChannelRegistrar(ctx.registerChannelIpc)'
    )
  }
}

let active: ChannelRegistrar | null = null

/** 注入注册器（插件激活时接自己，传 null 恢复 ipcMain） */
export function setChannelRegistrar(registrar: ChannelRegistrar | null): void {
  active = registrar
}

/** 当前是否有插件接管了通道注册（验收用：激活结束后必须为 false，否则宿主注册会被劫持） */
export function hasChannelRegistrar(): boolean {
  return active !== null
}

export function channelHandle(
  channel: string,
  fn: (...args: any[]) => Promise<unknown>
): void {
  ;(active ?? defaultRegistrar).handle(channel, fn)
}

export function channelHandleEvent(
  channel: string,
  fn: (event: any, ...args: any[]) => Promise<unknown>
): void {
  ;(active ?? defaultRegistrar).handleEvent(channel, fn)
}
