import { defineStore } from 'pinia'
import { ref } from 'vue'
import { applyTheme } from '@/composables/useTheme'

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
      config.value = await window.api.config.save(partial)
      applyCurrentTheme()
    } finally {
      saving.value = false
    }
  }

  async function reset() {
    config.value = await window.api.config.reset()
    applyCurrentTheme()
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
