// kernel/registry.ts —— 插件注册表：清单校验 + 能力检查 + 启停状态
//
// 纯数据 + 纯函数，不碰 electron / fs：宿主（index.ts）负责把「清单 JSON + 入口加载器」
// 喂进来，测试也可以直接喂假数据。

import {
  HOST_CAPABILITIES,
  missingCapabilities,
  parseManifest,
  PluginManifestError,
  type PluginManifest
} from './manifest'
import type { PluginModule } from './plugin'

export type PluginState = 'discovered' | 'validated' | 'activated' | 'deactivated' | 'disabled' | 'failed'

export interface PluginRuntimeError {
  code: string
  message: string
}

export interface PluginRecord {
  readonly manifest: PluginManifest
  /** 插件目录（含 plugin.json / migrations） */
  readonly dir: string
  /** 清单来源，用于报错定位（文件路径或 `<inline>`） */
  readonly source: string
  readonly loadMain: () => Promise<PluginModule>
  state: PluginState
  enabled: boolean
  error?: PluginRuntimeError
  /** 已注册的 IPC 方法（相对名，不含 plugin:<id>: 前缀） */
  ipcMethods: Set<string>
  jobCount: number
}

export interface PluginSource {
  dir: string
  source: string
  manifest: unknown
  loadMain: () => Promise<PluginModule>
}

export interface PluginRegistryOptions {
  /** 宿主提供的能力版本；默认取 HOST_CAPABILITIES */
  hostCapabilities?: readonly string[]
  /** 持久化的启停状态（缺省用清单的 defaultEnabled） */
  persistedEnabled?: Record<string, boolean>
}

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>()
  private readonly hostCapabilities: readonly string[]
  private readonly persistedEnabled: Record<string, boolean>

  constructor(opts: PluginRegistryOptions = {}) {
    this.hostCapabilities = opts.hostCapabilities ?? HOST_CAPABILITIES
    this.persistedEnabled = { ...(opts.persistedEnabled ?? {}) }
  }

  /**
   * 注册插件。清单非法 / 能力缺失 → 抛 `PluginManifestError`；
   * 同一 id 重复注册 → `DUPLICATE_ID`。
   */
  register(source: PluginSource): PluginRecord {
    const manifest = parseManifest(source.manifest, source.source)
    if (this.records.has(manifest.id)) {
      throw new PluginManifestError('DUPLICATE_ID', `插件 id 重复：${manifest.id}`, {
        pluginId: manifest.id,
        field: 'id'
      })
    }
    const missing = missingCapabilities(manifest, this.hostCapabilities)
    if (missing.length) {
      throw new PluginManifestError(
        'MANIFEST_INVALID',
        `插件 ${manifest.id} 需要宿主未提供的能力：${missing.join(', ')}（宿主支持：${this.hostCapabilities.join(', ')}）`,
        { pluginId: manifest.id, field: 'capabilities' }
      )
    }
    const persisted = this.persistedEnabled[manifest.id]
    const record: PluginRecord = {
      manifest,
      dir: source.dir,
      source: source.source,
      loadMain: source.loadMain,
      state: 'validated',
      enabled: typeof persisted === 'boolean' ? persisted : manifest.defaultEnabled,
      ipcMethods: new Set(),
      jobCount: 0
    }
    this.records.set(manifest.id, record)
    return record
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  }

  isEnabled(id: string): boolean {
    return this.records.get(id)?.enabled === true
  }

  setEnabled(id: string, enabled: boolean): PluginRecord {
    const record = this.records.get(id)
    if (!record) throw new PluginManifestError('MANIFEST_INVALID', `未注册的插件：${id}`, { pluginId: id })
    record.enabled = enabled
    this.persistedEnabled[id] = enabled
    if (!enabled && record.state === 'activated') record.state = 'disabled'
    return record
  }

  /** 需要激活的插件（启用且未 failed） */
  activationTargets(): PluginRecord[] {
    return this.list().filter((r) => r.enabled && r.state !== 'activated' && r.state !== 'failed')
  }

  /** 供宿主持久化：只导出用户显式设置过的开关 */
  enabledSnapshot(): Record<string, boolean> {
    return { ...this.persistedEnabled }
  }

  capabilityList(): readonly string[] {
    return this.hostCapabilities
  }
}
