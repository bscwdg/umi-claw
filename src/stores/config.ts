import { defineStore } from 'pinia'
import { ref } from 'vue'
import { applyTheme } from '@/composables/useTheme'

/** 本地 app.json 已存，但 openclaw.json 同步未通过官方校验（非硬失败，不丢用户设置） */
export class SyncWarning extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncWarning'
  }
}

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
  configName?: string
  customModels?: PresetModel[]
  /** 请求超时（秒），国内模型卡顿建议调大 */
  timeoutSeconds?: number
  /** 获取模型列表的接口地址：完整 URL 或路径（如 /models），留空默认 {baseUrl}/models */
  modelsListUrl?: string
}

export interface PresetModel {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  [key: string]: any
}

export interface AppConfig {
  activeProvider: string
  providers: ModelProvider[]
  port: number
  autoStart: boolean
  launchOnBoot: boolean
  minimizeToTray: boolean
  /** 退出应用时是否保留网关在后台运行（下次启动直接复用，跳过冷启动） */
  keepGatewayOnQuit: boolean
  closeAction: 'ask' | 'tray' | 'exit'
  useChineseMirror: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  language: 'zh-CN' | 'en-US'
  theme: string
  themeBase?: string
  themeAccent?: string
  channels?: Record<string, Record<string, unknown>>
}

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const saving = ref(false)

  async function load() {
    loading.value = true
    try {
      config.value = await window.api.config.get()
      applyCurrentTheme()
    } finally {
      loading.value = false
    }
  }

  async function save(partial: Partial<AppConfig>) {
    saving.value = true
    try {
      const res = await window.api.config.save(partial)
      // IPC 返回 { config, openClawSyncOk, openClawSyncError, appConfigSavedOk, appConfigSaveError }；
      // 兼容旧形态（直接返回 AppConfig）
      const saved = res && typeof res === 'object' && 'config' in res
        ? res
        : { config: res, openClawSyncOk: true, openClawSyncError: null, appConfigSavedOk: true, appConfigSaveError: null }
      config.value = saved.config
      applyCurrentTheme()
      if (saved.appConfigSavedOk === false) {
        // app.json 本地落盘失败：设置根本没写进去，重启即丢失——这是硬失败，不能当「已保存」。
        throw new Error(`设置保存失败（app.json 未能写入）：${saved.appConfigSaveError || '未知原因'}`)
      }
      if (saved.openClawSyncOk === false) {
        // 本地已存但网关配置未通过校验：提示用户，不丢设置
        throw new SyncWarning(saved.openClawSyncError || 'openclaw.json 同步未通过校验')
      }
    } finally {
      saving.value = false
    }
  }

  async function reset() {
    const res = await window.api.config.reset()
    // 与 save 同口径：IPC 现在返回 { config, openClawSyncOk, openClawSyncError, appConfigSavedOk, appConfigSaveError }；兼容旧形态
    const saved = res && typeof res === 'object' && 'config' in res
      ? res
      : { config: res, openClawSyncOk: true, openClawSyncError: null, appConfigSavedOk: true, appConfigSaveError: null }
    config.value = saved.config
    applyCurrentTheme()
    if (saved.appConfigSavedOk === false) {
      // 重置后的默认值未能写入 app.json（重启即回旧值）——硬失败，不能当「已恢复」
      throw new Error(`重置失败（app.json 未能写入）：${saved.appConfigSaveError || '未知原因'}`)
    }
    if (saved.openClawSyncOk === false) {
      // 本地已重置但网关配置未通过校验：像保存一样提示警告（不丢设置，下次启动 doctor 会收敛）
      throw new SyncWarning(saved.openClawSyncError || '重置后 openclaw.json 同步未通过校验')
    }
  }

  function applyCurrentTheme() {
    if (!config.value) return
    applyTheme({
      theme: config.value.theme,
      themeBase: config.value.themeBase,
      themeAccent: config.value.themeAccent
    })
  }

  const activeProvider = () =>
    config.value?.providers.find((p) => p.id === config.value?.activeProvider)

  return { config, loading, saving, load, save, reset, activeProvider, applyCurrentTheme }
})
