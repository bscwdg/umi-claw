// electron/main/ipc/host/config.ts —— 应用配置 IPC（4.1 WP5-a 第三批：从 index.ts 拆出）
//
// config:save / config:reset 的返回形状是前端契约：干净 AppConfig + 同步/落盘状态分开透出，
// 让「已保存」不能说谎（openClawSyncOk / appConfigSavedOk 为 false 时 UI 要提示）。
// 这里把同一套拆包逻辑收在一个 helper，避免两个 handler 各写一份。

import type { AppConfig } from '../../configManager'
import type { HostIpcRegistrar } from './types'

/** configManager.saveConfig/resetConfig 的附加状态字段（宿主库是唯一类型来源） */
type ConfigWithStatus = AppConfig & {
  openClawSyncOk?: boolean
  openClawSyncError?: string
  appConfigSavedOk?: boolean
  appConfigSaveError?: string
}

export interface ConfigIpcDeps {
  getConfig: () => AppConfig
  saveConfig: (config: Partial<AppConfig>) => Promise<ConfigWithStatus>
  resetConfig: () => Promise<ConfigWithStatus>
  /** 配置保存/重置后同步开机自启项 */
  applyLoginItemSettings: (launchOnBoot: boolean) => void
  getDataDir: () => string
  getPresetModels: (configName: string) => unknown
  refreshModelPresets: () => Promise<unknown> | unknown
  getModelPresetsInfo: () => unknown
  openDataDir: (dir: string) => Promise<unknown> | unknown
}

/** 与前端契约：config 干净，同步/落盘状态单独字段（缺省视为成功） */
function toSaveResult(saved: ConfigWithStatus) {
  const { openClawSyncOk, openClawSyncError, appConfigSavedOk, appConfigSaveError, ...appConfig } =
    saved
  return {
    config: appConfig,
    openClawSyncOk: openClawSyncOk !== false,
    openClawSyncError: openClawSyncError ?? null,
    appConfigSavedOk: appConfigSavedOk !== false,
    appConfigSaveError: appConfigSaveError ?? null
  }
}

export function registerConfigIpc(ipc: HostIpcRegistrar, deps: ConfigIpcDeps): void {
  ipc.handle('config:get', () => deps.getConfig())
  ipc.handle('config:save', async (_e, config: Partial<AppConfig>) => {
    const saved = await deps.saveConfig(config)
    // 配置保存后同步开机自启项
    deps.applyLoginItemSettings(saved.launchOnBoot)
    return toSaveResult(saved)
  })
  ipc.handle('config:reset', async () => {
    const reset = await deps.resetConfig()
    deps.applyLoginItemSettings(reset.launchOnBoot)
    // 与 config:save 同口径：把同步/落盘状态随返回值透出，前端重置后能像保存一样看到警告/失败
    return toSaveResult(reset)
  })
  ipc.handle('config:getDataDir', () => deps.getDataDir())
  ipc.handle('config:getPresetModels', (_e, configName: string) => deps.getPresetModels(configName))
  ipc.handle('config:refreshModelPresets', () => deps.refreshModelPresets())
  ipc.handle('config:getModelPresetsInfo', () => deps.getModelPresetsInfo())
  ipc.handle('config:openDataDir', () => deps.openDataDir(deps.getDataDir()))
}
