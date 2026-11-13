// plugin-sdk/src/official-host.ts —— 官方插件 IPC 层专用的宿主 electron 适配
//
// hostUi 会 import electron；只给 main/ipc 用，不要并进 official barrel。

export * from '../../electron/main/services/hostUi'
