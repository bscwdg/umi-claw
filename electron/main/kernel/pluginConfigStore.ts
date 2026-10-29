// kernel/pluginConfigStore.ts —— 插件配置的落盘与命名空间隔离（Phase 1 WP1）
//
// 为什么单独一个文件而不是塞进 configManager：
//   `app.json` 的 saveConfig 会顺带同步 openclaw.json（走官方 CLI 校验），
//   插件每改一个配置键都触发一次网关配置同步是不可接受的。
//   这里用独立的 `<dataDir>/plugin-config.json`（结构：{ "<pluginId>": { ...values } }），
//   写入用「临时文件 + rename」保证原子性，并做 300ms 合并写。
//
// 后续（Phase 4）若要并回 AppConfig.plugins，只需替换本文件实现，插件侧 API 不变。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginConfigApi } from './plugin'

export interface PluginConfigStore {
  /** 该插件当前的全部配置（浅拷贝语义由调用方遵守） */
  values(pluginId: string): Record<string, unknown>
  /** 生成绑定到某个插件的配置服务（给 ctx.services.config 用） */
  serviceFor(pluginId: string): PluginConfigApi
  /** 立即落盘（退出前调用） */
  flush(): Promise<void>
}

const SAVE_DEBOUNCE_MS = 300

export function createPluginConfigStore(filePath: string): PluginConfigStore {
  const data = load(filePath)
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  async function persist(): Promise<void> {
    writing = writing.then(() => {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp-${process.pid}`
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
        renameSync(tmp, filePath)
      } catch {
        // 落盘失败不能打断应用；下次 set 还会再试
      }
    })
    return writing
  }

  return {
    values: (pluginId) => data[pluginId] ?? {},
    serviceFor(pluginId) {
      const bucket = (data[pluginId] ??= {})
      return {
        get: <T,>(key: string, fallback?: T) =>
          (key in bucket ? (bucket[key] as T) : fallback) as T | undefined,
        set: (key, value) => {
          bucket[key] = value
          schedule()
        },
        all: () => ({ ...bucket })
      }
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await persist()
      await writing
    }
  }
}

function load(filePath: string): Record<string, Record<string, unknown>> {
  try {
    if (!existsSync(filePath)) return {}
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[id] = { ...(value as Record<string, unknown>) }
      }
    }
    return out
  } catch {
    // 配置坏掉不该阻止启动：按「全部默认值」处理
    return {}
  }
}
