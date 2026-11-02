// plugins/marketing/main/ipc/ipcTypes.ts —— 插件 IPC 用到的最小 electron 结构类型
//
// 4.1 WP6-b：ipc 文件搬进插件后不能再 `from 'electron'`（即使 type-only 也会被 P32 静态
// 扫描判违规）。这里只用结构化接口描述实际用到的字段，运行时零耦合、类型仍可编译。

/** 只需要 sender（流式通道转发用）与可透传的附加字段 */
export interface IpcMainInvokeEventLike {
  sender?: unknown
  [key: string]: unknown
}
