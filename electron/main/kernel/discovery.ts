// kernel/discovery.ts —— 从 resources/plugins 读清单（只读数据，不加载代码）
//
// 关键点（PLAN-4.0 §5.1 / §9）：**入口表来自构建期**（plugins.main.generated.ts），
// 磁盘上只扫描「已登记」的那几个 id 的 plugin.json。用户目录永远不扫，
// 因此不存在「往 resources 里塞一个目录就被加载」的路径。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginModule } from './plugin'
import type { PluginSource } from './registry'

export interface DiscoverOptions {
  /** resources/plugins 的绝对路径 */
  root: string
  /** 构建期生成的入口表：id → 动态 import */
  entries: Record<string, () => Promise<unknown>>
  /** 日志（缺省静默） */
  logger?: (line: string) => void
}

/**
 * 返回可注册的插件源。清单缺失/JSON 坏掉不抛错，而是产出 `manifest: null` 的条目，
 * 由调用方决定记日志还是跳过——**一个坏插件不能让宿主起不来**。
 */
export interface DiscoveredPlugin extends Omit<PluginSource, 'manifest' | 'loadMain'> {
  id: string
  manifest: unknown
  loadMain: () => Promise<PluginModule>
  loadError?: string
}

export function discoverPlugins(opts: DiscoverOptions): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = []
  const ids = Object.keys(opts.entries).sort()

  for (const id of ids) {
    const dir = join(opts.root, id)
    const manifestPath = join(dir, 'plugin.json')
    const loadMain = async (): Promise<PluginModule> => {
      const mod = (await opts.entries[id]()) as { default?: PluginModule } | PluginModule
      return (mod as { default?: PluginModule })?.default ?? (mod as PluginModule)
    }

    if (!existsSync(manifestPath)) {
      opts.logger?.(`[plugin:${id}] 缺少 plugin.json（${manifestPath}），跳过`)
      found.push({ id, dir, source: manifestPath, manifest: null, loadMain, loadError: 'MANIFEST_MISSING' })
      continue
    }
    try {
      const text = readFileSync(manifestPath, 'utf-8')
      found.push({ id, dir, source: manifestPath, manifest: JSON.parse(text), loadMain })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      opts.logger?.(`[plugin:${id}] plugin.json 解析失败：${message}`)
      found.push({ id, dir, source: manifestPath, manifest: null, loadMain, loadError: message })
    }
  }

  // 反向检查：磁盘上有清单但没在入口表里 → 明确告知「未登记，不会被加载」
  try {
    for (const name of readdirSync(opts.root)) {
      if (name in opts.entries) continue
      if (existsSync(join(opts.root, name, 'plugin.json'))) {
        opts.logger?.(`[plugin:${name}] 未在构建期入口表中登记，不会被加载（需重新构建：npm run plugin:gen）`)
      }
    }
  } catch {
    // resources/plugins 不存在（开发态常见）→ 宿主零插件启动，属正常路径
  }

  return found
}
