// electron/main/ipc/host/types.ts —— 宿主 IPC registrar 的共享形状（4.1 WP5-a）
//
// channels/config/skills 三个 registrar 用这个形状（不直接 import electron，可给
// fake registrar 做行为测试）；misc/claw/modelConnection/terminal/env 仍各自持有
// electron 依赖（misc 直接 import electron，env 已可注入），做纯 Node 行为测试时
// 需要按文件先 stub/注入 electron —— P45 补测试时注意这个差异。

export interface HostIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}
