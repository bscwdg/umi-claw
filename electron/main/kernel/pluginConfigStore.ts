// kernel/pluginConfigStore.ts —— 插件配置的落盘与命名空间隔离（Phase 1 WP1）
//
// 为什么单独一个文件而不是塞进 configManager：
//   `app.json` 的 saveConfig 会顺带同步 openclaw.json（走官方 CLI 校验），
//   插件每改一个配置键都触发一次网关配置同步是不可接受的。
//   这里用独立的 `<dataDir>/plugin-config.json`（结构：{ "<pluginId>": { ...values } }）。
//
// 健壮性（审查 R3 / 对抗 B4）：
//   - **逐插件序列化**：某个插件写了不可 JSON 化的值，只影响它自己，不会让全体停止落盘；
//   - 写入失败会上报（onError），不再静默吞掉；
//   - 读到坏文件时先备份成 `*.bad-<ts>`，避免下一次写入把用户配置覆盖成空；
//   - 写入用「临时文件 + rename」保证原子性，并做 300ms 合并写。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginConfigApi } from './plugin'

export interface PluginConfigStore {
  values(pluginId: string): Record<string, unknown>
  serviceFor(pluginId: string): PluginConfigApi
  /** 立即落盘；返回本次写入是否成功（失败已通过 onError 上报） */
  flush(): Promise<boolean>
  /** 读取/写入过程中的错误信息（最近 20 条） */
  errors(): string[]
}

export interface PluginConfigStoreOptions {
  /** 错误上报（缺省 console.warn） */
  onError?: (message: string) => void
}

const SAVE_DEBOUNCE_MS = 300
const MAX_ERRORS = 20

export function createPluginConfigStore(
  filePath: string,
  opts: PluginConfigStoreOptions = {}
): PluginConfigStore {
  const errors: string[] = []
  const report = (message: string): void => {
    errors.push(message)
    if (errors.length > MAX_ERRORS) errors.shift()
    ;(opts.onError ?? ((m: string) => console.warn(m)))(message)
  }

  const data = load(filePath, report)
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<boolean> = Promise.resolve(true)

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  /** 逐插件序列化：坏值只影响该插件 */
  function serialize(): { text: string; ok: boolean } {
    const safe: Record<string, Record<string, unknown>> = {}
    let ok = true
    for (const [pluginId, bucket] of Object.entries(data)) {
      try {
        safe[pluginId] = JSON.parse(JSON.stringify(bucket)) as Record<string, unknown>
      } catch (e) {
        ok = false
        report(`[plugin-config] 插件 ${pluginId} 的配置无法序列化（${e instanceof Error ? e.message : String(e)}），本次不落盘`)
      }
    }
    return { text: JSON.stringify(safe, null, 2), ok }
  }

  async function persist(): Promise<boolean> {
    writing = writing.then(() => {
      const { text, ok } = serialize()
      // 即使有坏值也要把好的插件写下去（坏值只影响它自己）
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp-${process.pid}`
        writeFileSync(tmp, text, 'utf-8')
        renameSync(tmp, filePath)
        return ok
      } catch (e) {
        report(`[plugin-config] 落盘失败：${e instanceof Error ? e.message : String(e)}`)
        return false
      }
    })
    return writing
  }

  return {
    values: (pluginId) => data[pluginId] ?? {},
    serviceFor(pluginId) {
      // 懒创建：读一个没写过的插件不该在文件里留下空桶（审查 C1）
      const bucket = (): Record<string, unknown> => {
        data[pluginId] ??= {}
        return data[pluginId]
      }
      return {
        get: <T,>(key: string, fallback?: T) =>
          (data[pluginId] && key in data[pluginId] ? (data[pluginId][key] as T) : fallback) as T | undefined,
        set: (key, value) => {
          bucket()[key] = value
          schedule()
        },
        all: () => ({ ...(data[pluginId] ?? {}) })
      }
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const result = await persist()
      await writing
      return result
    },
    errors: () => [...errors]
  }
}

function load(
  filePath: string,
  report: (message: string) => void
): Record<string, Record<string, unknown>> {
  if (!existsSync(filePath)) return {}
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[id] = { ...(value as Record<string, unknown>) }
      }
    }
    return out
  } catch (e) {
    // 坏文件先留档再回落，避免下一次写入把用户配置覆盖成空
    try {
      const backup = `${filePath}.bad-${Date.now()}`
      renameSync(filePath, backup)
      report(`[plugin-config] 配置文件解析失败，已备份到 ${backup}（${e instanceof Error ? e.message : String(e)}）`)
    } catch {
      report(`[plugin-config] 配置文件解析失败且备份失败（${e instanceof Error ? e.message : String(e)}）`)
    }
    return {}
  }
}
