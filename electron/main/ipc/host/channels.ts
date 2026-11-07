// electron/main/ipc/host/channels.ts —— 渠道插件 IPC（4.1 WP5-a 第二批：从 index.ts 拆出）
//
// 原生长连接渠道（飞书等）以 OpenClaw 插件形式安装；这里只做透传 + 把异常转成
// {success:false,error}（前端按 success 分支，不能把 reject 当成功）。

import type { HostIpcRegistrar } from './types'

export interface ChannelsIpcDeps {
  isPluginInstalled: (pluginId: string) => unknown
  installPlugin: (pluginPkg: string) => Promise<unknown>
  /** QQ 扫码登录前置：安装缺失插件并确保 openclaw.json 里已启用 */
  prepareQQBotLogin: () => Promise<unknown>
  getChannelStatuses: () => unknown
}

export function registerChannelsIpc(
  ipc: HostIpcRegistrar,
  deps: ChannelsIpcDeps
): void {
  ipc.handle('channels:isPluginInstalled', (_e, pluginId: string) =>
    deps.isPluginInstalled(pluginId)
  )
  ipc.handle('channels:installPlugin', async (_e, pluginPkg: string) => {
    try {
      await deps.installPlugin(pluginPkg)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? String(err) }
    }
  })
  // QQ 扫码登录前置：插件「装了但没启用」时 channels login 会当成未安装，
  // 现场走 npm 安装且最后报 does not support login。这里先把启用态补齐再跳终端。
  ipc.handle('channels:prepareQQBotLogin', async () => {
    try {
      return await deps.prepareQQBotLogin()
    } catch (err) {
      return { success: false, installed: false, enabled: false, error: (err as Error)?.message ?? String(err) }
    }
  })
  // 渠道已接入状态（只读，依据 openclaw.json 与插件登录态）
  ipc.handle('channels:getStatuses', () => deps.getChannelStatuses())
}
