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
  /** 出错的阶段：manifest / capability / load / activate / activate-timeout / late-register */
  stage?: string
  message: string
  /** 清单字段名（清单类错误） */
  field?: string
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
  /** 构建期入口表里的 key；给了就要求与清单 id 一致（防止「以 A 的 id 加载 B 的代码」） */
  entryId?: string
  loadMain: () => Promise<PluginModule>
}

/** 宿主能注入的服务（Phase 0 只有 host） */
export const HOST_SERVICES = ['host'] as const

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
    if (source.entryId && source.entryId !== manifest.id) {
      throw new PluginManifestError(
        'MANIFEST_INVALID',
        `清单 id 与构建期入口不一致：入口 ${JSON.stringify(source.entryId)}、清单 ${JSON.stringify(manifest.id)}（禁止以 A 的 id 加载 B 的代码）`,
        { pluginId: manifest.id, field: 'id' }
      )
    }
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
    const unknownServices = manifest.inject.filter((s) => !HOST_SERVICES.includes(s as 'host'))
    if (unknownServices.length) {
      throw new PluginManifestError(
        'MANIFEST_INVALID',
        `插件 ${manifest.id} 声明了宿主不存在的服务：${unknownServices.join(', ')}（可用：${HOST_SERVICES.join(', ')}）`,
        { pluginId: manifest.id, field: 'inject' }
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

  /**
   * 登记一个「注册阶段就失败」的插件（清单缺失/坏 JSON/id 冲突/能力缺失）。
   *
   * 为什么要登记：只 console 的话，插件管理页与 `plugin:list` 里这个插件**根本不存在**，
   * 用户看到的是「装了但没生效且没有任何解释」。
   */
  addFailed(
    entryId: string,
    error: { code: string; stage?: string; message: string; field?: string },
    meta: { dir: string; source: string }
  ): PluginRecord {
    const existing = this.records.get(entryId)
    if (existing) return existing
    const record: PluginRecord = {
      manifest: {
        id: entryId,
        name: entryId,
        version: '0.0.0',
        capabilities: [],
        inject: [],
        activation: [],
        defaultEnabled: false,
        raw: {}
      },
      dir: meta.dir,
      source: meta.source,
      loadMain: async () => ({ activate: () => undefined }),
      state: 'failed',
      enabled: false,
      error: { ...error, stage: error.stage ?? 'manifest' },
      ipcMethods: new Set(),
      jobCount: 0
    }
    this.records.set(entryId, record)
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

  /**
   * 需要激活的插件：启用 + 未激活/未失败 + **声明了 onStartup**。
   *
   * 最后一条别省：清单允许 `onDemand`，但 Phase 0 没有懒加载入口；
   * 若不过滤，声明 onDemand 的插件照样会在启动时被激活（声明与行为不一致）。
   */
  activationTargets(): PluginRecord[] {
    return this.list().filter(
      (r) =>
        r.enabled &&
        r.state !== 'activated' &&
        r.state !== 'failed' &&
        r.manifest.activation.includes('onStartup')
    )
  }

  /** 供宿主持久化：只导出用户显式设置过的开关 */
  enabledSnapshot(): Record<string, boolean> {
    return { ...this.persistedEnabled }
  }

  capabilityList(): readonly string[] {
    return this.hostCapabilities
  }
}
