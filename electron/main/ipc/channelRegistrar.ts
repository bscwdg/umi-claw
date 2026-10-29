// ipc/channelRegistrar.ts —— 通道注册器的统一注入点（Phase 3 装箱）
//
// work 用的是 ipc/work.ts 自带的 setWorkIpcRegistrar；marketing 这边有 5 个 ipc 文件
// （marketing / advisor / scan / content / hot），各自复制一份注入点太脏，
// 所以抽出这个共享模块：插件激活时接上 ctx.registerChannelIpc，停用即摘除。

export interface ChannelRegistrar {
  /** 只需要 payload（可多参） */
  handle(channel: string, fn: (...args: any[]) => Promise<unknown>): void
  /** 需要原始 IPC 事件（流式通道拿 event.sender） */
  handleEvent(channel: string, fn: (event: any, ...args: any[]) => Promise<unknown>): void
}

const ipcMainRef: {
  removeHandler?: (channel: string) => void
  handle?: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void
} = (() => {
  try {
    // 延迟 require：本模块也会被纯 Node 测试 import，测试里没有 electron
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron').ipcMain ?? {}
  } catch {
    return {}
  }
})()

const defaultRegistrar: ChannelRegistrar = {
  handle(channel, fn) {
    ipcMainRef.removeHandler?.(channel)
    ipcMainRef.handle?.(channel, (_e, ...args) => fn(...args))
  },
  handleEvent(channel, fn) {
    ipcMainRef.removeHandler?.(channel)
    ipcMainRef.handle?.(channel, (event, ...args) => fn(event, ...args))
  }
}

let active: ChannelRegistrar | null = null

/** 注入注册器（插件激活时接自己，传 null 恢复 ipcMain） */
export function setChannelRegistrar(registrar: ChannelRegistrar | null): void {
  active = registrar
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
