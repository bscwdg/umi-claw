// electron/main/services/pluginKv.ts —— 插件偏好（WP4 C4.1 / C4.3 抽离）
//
// 从 index.ts 抽出：这个工厂原本写在宿主入口里，但它只依赖 dataDir + pluginId，
// 是纯粹的「按插件命名空间隔离的持久化 KV」，没有理由住在入口。
//
// 与插件 db.metaGet/metaSet 的区别：那是插件自己库里的 app_meta；
// 这里是宿主统一持久化的偏好（插件换库也不会丢），键前缀 `plugin:<id>:`。
//
// 并发（4.0.1 P8）：同一 dataDir 下的所有插件共用一个 `plugin-kv.json`，所以缓存与
// 写队列必须按**文件路径**共享——否则两个插件实例各自持有一份完整 map，后写者会把
// 先写者的键整份抹掉（对抗复核已复现）。这里用模块级 Map 缓存 + promise 串行队列。

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PluginKvApi } from '../kernel'

interface SharedKvState {
  cache: Record<string, string> | null
  /** 写串行队列：所有 set/clear 依次执行，避免读-改-写交错 */
  queue: Promise<void>
}

const sharedByFile = new Map<string, SharedKvState>()

function sharedStateOf(file: string): SharedKvState {
  let state = sharedByFile.get(file)
  if (!state) {
    state = { cache: null, queue: Promise.resolve() }
    sharedByFile.set(file, state)
  }
  return state
}

/**
 * 插件 KV：宿主持久化，按插件命名空间隔离（WP4 C4.1）。
 *
 * 与 plugin 的 db.metaGet/metaSet 的区别——那是插件自己库里的 app_meta；
 * 这里是宿主统一持久化的偏好（插件换库也不会丢），键前缀 plugin:<id>:。
 */
export function createPluginKvService(dataDir: string, pluginId: string): PluginKvApi {
  const fileOf = () => join(dataDir, 'plugin-kv.json')
  const shared = sharedStateOf(fileOf())
  const prefix = `plugin:${pluginId}:`

  const load = (): Record<string, string> => {
    if (shared.cache) return shared.cache
    try {
      const raw = readFileSync(fileOf(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      shared.cache =
        parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch {
      shared.cache = {}
    }
    return shared.cache
  }

  const flush = (map: Record<string, string>): void => {
    const tmp = fileOf() + '.tmp'
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    renameSync(tmp, fileOf())
    // 落盘成功后才更新缓存：写失败时保留旧值，避免 get() 返回未落盘的「幻影数据」
    shared.cache = map
  }

  /** 串行执行一次读-改-写；前一个任务失败不阻塞后续（队列吞掉错误，由调用方各自失败） */
  const enqueue = (fn: () => void): Promise<void> => {
    const run = shared.queue.then(fn)
    shared.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    async get(key) {
      const map = load()
      const value = map[prefix + key]
      return typeof value === 'string' ? value : null
    },
    async set(key, value) {
      await enqueue(() => {
        const map = { ...load() }
        if (value === null) delete map[prefix + key]
        else map[prefix + key] = value
        flush(map)
      })
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
