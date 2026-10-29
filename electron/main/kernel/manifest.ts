// kernel/manifest.ts —— 插件清单解析与校验（PLAN-4.0 §4.1）
//
// 设计要点（v1.1）：
//   - 清单是**数据**，不是代码：`resources/plugins/<id>/plugin.json` 只声明 id / 能力 /
//     依赖 / 贡献点，代码入口由构建期生成的 `plugins.*.generated.ts` 提供。
//   - 校验失败要给出**可诊断的字段级错误**，而不是笼统的「清单非法」。
//   - `capabilities` 用能力版本（host.db.v1），不用宿主 semver：宿主加字段不该让插件失效。
//   - 未知字段一律保留（向前兼容），不做白名单拒绝。

export type PluginId = string

export interface PluginNavGroup {
  id: string
  label: string
  order?: number
}

export interface PluginContributes {
  navGroup?: PluginNavGroup
  routes?: string[]
  settings?: string[]
  commands?: string[]
}

export interface PluginManifest {
  id: PluginId
  name: string
  version: string
  /** 需要宿主提供的能力版本，如 host.db.v1 */
  capabilities: string[]
  /** 需要注入的服务名，如 db / openclaw / host */
  inject: string[]
  /** 激活时机（Phase 0 只支持 onStartup） */
  activation: string[]
  /** 迁移目录（相对插件目录） */
  migrations?: string
  /**
   * 通道命名空间租约（Phase 2 / D1）。
   *
   * 插件可保留历史通道名（如 work:*），但必须在这里声明命名空间，宿主保证
   * **跨插件唯一**、且只在该插件激活期间存在。plugin 是宿主保留前缀，不可租用。
   */
  channels: string[]
  contributes?: PluginContributes
  /** 首次安装是否默认启用 */
  defaultEnabled: boolean
  /** 原始清单（保留未知字段，向前兼容） */
  raw: Record<string, unknown>
}

export type ManifestErrorCode = 'MANIFEST_INVALID' | 'DUPLICATE_ID'

export class PluginManifestError extends Error {
  readonly code: ManifestErrorCode
  readonly pluginId?: string
  readonly field?: string

  constructor(code: ManifestErrorCode, message: string, opts: { pluginId?: string; field?: string } = {}) {
    super(message)
    this.name = 'PluginManifestError'
    this.code = code
    this.pluginId = opts.pluginId
    this.field = opts.field
  }
}

/** id：小写字母开头，只允许小写字母/数字/连字符（用作 channel/目录/日志前缀） */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/
/** 能力版本：点分小写标识 + `.vN` 结尾，如 host.db.v1 */
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v\d+$/
/** 宽松语义化版本：至少 major.minor.patch */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const KNOWN_ACTIVATIONS = new Set(['onStartup', 'onDemand'])

function fail(message: string, field: string, pluginId?: string): never {
  throw new PluginManifestError('MANIFEST_INVALID', message, { field, pluginId })
}

function asStringArray(value: unknown, field: string, pluginId?: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${field} 必须是字符串数组`, field, pluginId)
  }
  return value as string[]
}

/**
 * 解析并校验清单。任何字段不合法都抛 `PluginManifestError`（带 field），
 * 便于「插件管理页」原样展示给用户。
 */
export function parseManifest(raw: unknown, source = '<inline>'): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`清单不是对象（来源 ${source}）`, 'root')
  }
  const obj = raw as Record<string, unknown>
  const id = obj.id
  if (typeof id !== 'string' || !id) fail('缺少 id', 'id')
  if (!ID_PATTERN.test(id)) fail(`id 必须匹配 ${ID_PATTERN}（实际 ${JSON.stringify(id)}）`, 'id', id)

  const name = obj.name
  if (typeof name !== 'string' || !name.trim()) fail('缺少 name', 'name', id)

  const version = obj.version
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    fail(`version 必须是 x.y.z 形式（实际 ${JSON.stringify(version)}）`, 'version', id)
  }

  const capabilities = asStringArray(obj.capabilities, 'capabilities', id)
  for (const cap of capabilities) {
    if (!CAPABILITY_PATTERN.test(cap)) {
      fail(`能力版本格式非法：${JSON.stringify(cap)}（应形如 host.db.v1）`, 'capabilities', id)
    }
  }

  const inject = asStringArray(obj.inject, 'inject', id)

  const channels = asStringArray(obj.channels, 'channels', id)
  for (const ns of channels) {
    if (!ID_PATTERN.test(ns)) {
      fail(`通道命名空间必须匹配 ${ID_PATTERN}（实际 ${JSON.stringify(ns)}）`, 'channels', id)
    }
    if (ns === 'plugin') fail('plugin 是宿主保留的通道前缀，不能作为插件命名空间', 'channels', id)
  }

  const activation = obj.activation === undefined ? ['onStartup'] : asStringArray(obj.activation, 'activation', id)
  for (const when of activation) {
    if (!KNOWN_ACTIVATIONS.has(when)) fail(`未知 activation：${when}`, 'activation', id)
  }

  const migrations = obj.migrations
  if (migrations !== undefined && typeof migrations !== 'string') fail('migrations 必须是字符串', 'migrations', id)

  const defaultEnabled = obj.defaultEnabled === undefined ? false : obj.defaultEnabled
  if (typeof defaultEnabled !== 'boolean') fail('defaultEnabled 必须是布尔', 'defaultEnabled', id)

  let contributes: PluginContributes | undefined
  if (obj.contributes !== undefined) {
    if (!obj.contributes || typeof obj.contributes !== 'object') {
      fail('contributes 必须是对象', 'contributes', id)
    }
    const c = obj.contributes as Record<string, unknown>
    contributes = {};

    if (c.navGroup !== undefined) {
      const nav = c.navGroup as Record<string, unknown> | null
      if (!nav || typeof nav !== 'object') fail('contributes.navGroup 必须是对象', 'contributes.navGroup', id)
      if (typeof nav.id !== 'string' || !ID_PATTERN.test(nav.id)) {
        fail('contributes.navGroup.id 必须是合法 id', 'contributes.navGroup.id', id)
      }
      if (typeof nav.label !== 'string' || !nav.label.trim()) {
        fail('contributes.navGroup.label 不能为空', 'contributes.navGroup.label', id)
      }
      if (nav.order !== undefined && typeof nav.order !== 'number') {
        fail('contributes.navGroup.order 必须是数字', 'contributes.navGroup.order', id)
      }
      contributes.navGroup = { id: nav.id, label: nav.label, order: nav.order as number | undefined }
    }

    for (const key of ['routes', 'settings', 'commands'] as const) {
      if (c[key] === undefined) continue
      const list = asStringArray(c[key], `contributes.${key}`, id)
      if (key === 'routes') {
        for (const route of list) {
          if (!route.startsWith('/')) fail(`路由必须以 / 开头：${route}`, 'contributes.routes', id)
        }
      }
      contributes[key] = list
    }
  }

  return {
    id,
    name,
    version,
    capabilities,
    inject,
    channels,
    activation,
    migrations,
    contributes,
    defaultEnabled,
    raw: obj
  }
}

/** 宿主当前提供的能力版本（Phase 0：只有基础设施能力） */
export const HOST_CAPABILITIES = [
  'host.ipc.v1',
  'host.jobs.v1',
  'host.config.v1',
  'host.db.v1',
  'host.openclaw.v1',
  'host.notifications.v1',
  'host.ui.slot.v1'
] as const

/** 返回清单要求但宿主未提供的能力（空数组 = 满足） */
export function missingCapabilities(
  manifest: Pick<PluginManifest, 'capabilities'>,
  hostCapabilities: readonly string[] = HOST_CAPABILITIES
): string[] {
  return manifest.capabilities.filter((cap) => !hostCapabilities.includes(cap))
}
