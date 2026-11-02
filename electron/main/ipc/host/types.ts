// electron/main/ipc/host/types.ts —— 宿主 IPC registrar 的共享形状（4.1 WP5-a）
//
// 拆出来的每个 registerXxxIpc 都只依赖「注册一个通道」，不直接 import electron：
// 这样纯 Node 也能给它一个 fake registrar 做行为测试。

export interface HostIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}
