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
  logLevel: string
  language: string
  theme: string
  themeBase?: string
  themeAccent?: string
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
