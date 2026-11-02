// electron/main/services/pluginKv.ts —— 插件偏好（WP4 C4.1 / C4.3 抽离）
//
// 从 index.ts 抽出：这个工厂原本写在宿主入口里，但它只依赖 dataDir + pluginId，
// 是纯粹的「按插件命名空间隔离的持久化 KV」，没有理由住在入口。
//
// 与插件 db.metaGet/metaSet 的区别：那是插件自己库里的 app_meta；
// 这里是宿主统一持久化的偏好（插件换库也不会丢），键前缀 `plugin:<id>:`。

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PluginKvApi } from '../kernel'

/**
 * 插件 KV：宿主持久化，按插件命名空间隔离（WP4 C4.1）。
 *
 * 与 plugin 的 db.metaGet/metaSet 的区别——那是插件自己库里的 app_meta；
 * 这里是宿主统一持久化的偏好（插件换库也不会丢），键前缀 plugin:<id>:。
 */
export function createPluginKvService(dataDir: string, pluginId: string): PluginKvApi {
  const fileOf = () => join(dataDir, 'plugin-kv.json')
  const prefix = `plugin:${pluginId}:`
  let cache: Record<string, string> | null = null

  const load = (): Record<string, string> => {
    if (cache) return cache
    try {
      const raw = readFileSync(fileOf(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch {
      cache = {}
    }
    return cache
  }

  const flush = (map: Record<string, string>): void => {
    cache = map
    const tmp = fileOf() + '.tmp'
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    renameSync(tmp, fileOf())
  }

  return {
    async get(key) {
      const map = load()
      const value = map[prefix + key]
      return typeof value === 'string' ? value : null
    },
    async set(key, value) {
      const map = { ...load() }
      if (value === null) delete map[prefix + key]
      else map[prefix + key] = value
      flush(map)
    },
    async keys() {
      const map = load()
      return Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort()
    }
  }
}
