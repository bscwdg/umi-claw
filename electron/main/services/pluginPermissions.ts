// pluginPermissions.ts —— 第三方插件权限模型原型（PLAN-5.0 Phase 1 B2）
//
// 目标：manifest 申请 → 用户授权（持久化）→ broker 判定 → 审计；撤销立即生效。
// 边界：NODE_OPTIONS 只做 Node API 层护栏（B0：不是沙箱，网络仍可直连）。
// 默认拒绝：manifest 没申请、用户没授权、路径不在 allowlist 内都返回 denied。

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginPermissions } from '../kernel/manifest'
import { PUBLIC_SERVICE_NAMES } from '../kernel/manifest'

export interface PermissionGrant {
  pluginId: string
  grantedAt: number
  permissions: PluginPermissions
}

interface PermissionFile {
  schema: 1
  grants: Record<string, PermissionGrant>
}

export interface PluginPermissionStore {
  load(): void
  grant(pluginId: string, permissions: PluginPermissions): PermissionGrant
  revoke(pluginId: string): void
  get(pluginId: string): PermissionGrant | undefined
  list(): PermissionGrant[]
}

export function createPermissionStore(filePath: string): PluginPermissionStore {
  let grants: Record<string, PermissionGrant> = {}
  let loaded = false

  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
  const sanitizeGrant = (raw: unknown): PermissionGrant | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const g = raw as Record<string, unknown>
    if (typeof g.pluginId !== 'string' || !g.pluginId) return null
    if (typeof g.grantedAt !== 'number') return null
    const p = g.permissions
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    const perms = p as Record<string, unknown>
    const fsPerm = perms.fs
    if (fsPerm !== undefined && (!fsPerm || typeof fsPerm !== 'object' || Array.isArray(fsPerm))) return null
    if (fsPerm) {
      const f = fsPerm as Record<string, unknown>
      if (f.read !== undefined && !isStringArray(f.read)) return null
      if (f.write !== undefined && !isStringArray(f.write)) return null
    }
    if (perms.network !== undefined && !isStringArray(perms.network)) return null
    if (perms.services !== undefined && !isStringArray(perms.services)) return null
    return {
      pluginId: g.pluginId,
      grantedAt: g.grantedAt,
      permissions: p as PluginPermissions
    }
  }

  const ensureLoaded = (): void => {
    if (loaded) return
    loaded = true
    try {
      if (!existsSync(filePath)) return
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as PermissionFile
      if (raw?.schema === 1 && raw.grants && typeof raw.grants === 'object' && !Array.isArray(raw.grants)) {
        const next: Record<string, PermissionGrant> = {}
        for (const [id, value] of Object.entries(raw.grants)) {
          const grant = sanitizeGrant(value)
          if (grant && grant.pluginId === id) next[id] = grant
        }
        grants = next
      }
    } catch {
      // 坏文件按「全部未授权」处理（fail-closed）
      grants = {}
    }
  }

  const save = (): void => {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}`
    const payload: PermissionFile = { schema: 1, grants }
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, filePath)
  }

  return {
    load: ensureLoaded,
    grant(pluginId, permissions) {
      ensureLoaded()
      const grant: PermissionGrant = { pluginId, grantedAt: Date.now(), permissions }
      grants = { ...grants, [pluginId]: grant }
      save()
      return grant
    },
    revoke(pluginId) {
      ensureLoaded()
      if (!grants[pluginId]) return
      const next = { ...grants }
      delete next[pluginId]
      grants = next
      save()
    },
    get(pluginId) {
      ensureLoaded()
      return grants[pluginId]
    },
    list() {
      ensureLoaded()
      return Object.values(grants)
    }
  }
}

export type PermissionAction =
  | { type: 'fs.read'; path: string }
  | { type: 'fs.write'; path: string }
  | { type: 'network'; host: string }
  | { type: 'service'; name: string }

export interface PermissionDecision {
  allowed: boolean
  reason: string
}

export interface PermissionAudit {
  record(pluginId: string, action: PermissionAction, decision: PermissionDecision): void
}

export function createPermissionAudit(filePath: string): PermissionAudit {
  return {
    record(pluginId, action, decision) {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        appendFileSync(
          filePath,
          JSON.stringify({
            at: new Date().toISOString(),
            pluginId,
            action: action.type,
            target:
              action.type === 'network'
                ? action.host
                : action.type === 'service'
                  ? action.name
                  : basename(action.path),
            allowed: decision.allowed,
            reason: decision.reason
          }) + '\n',
          'utf8'
        )
      } catch {
        // 审计写失败不能阻断插件调用；但宿主日志应能看到（调用方 logger）
      }
    }
  }
}

interface PermissionRoots {
  /** 插件包目录（mainPath 所在目录） */
  pluginDir: string
  /** 该插件独立数据目录 */
  dataDir: string
}

function normalized(p: string): string {
  return process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
}

function isUnder(parent: string, child: string): boolean {
  const p = normalized(parent)
  const c = normalized(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 词法 + realpath 双检：词法挡 `..`，realpath 挡 junction/symlink 越界 */
function isUnderReal(parent: string, child: string): boolean {
  if (!isUnder(parent, child)) return false
  try {
    const realParent = realpathSync.native(parent)
    const realChild = realpathSync.native(child)
    return isUnder(realParent, realChild)
  } catch {
    // 目标尚不存在（写新文件）时词法判定即可；父目录存在性由 Node 权限模型兜底
    return true
  }
}

function pathFromData(dataDir: string, rel: string): string | null {
  if (/^[a-zA-Z]:/.test(rel) || /[\s\u0000-\u001f<>:"|?*]/.test(rel)) return null
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.startsWith('~')) return null
  if (rel.split(/[\\/]+/).includes('..')) return null
  const resolved = resolve(dataDir, ...rel.split(/[\\/]+/).filter(Boolean))
  return isUnder(dataDir, resolved) ? resolved : null
}

export interface PermissionBroker {
  check(pluginId: string, action: PermissionAction): PermissionDecision
}

export function createPermissionBroker(options: {
  store: PluginPermissionStore
  audit: PermissionAudit
  rootsFor: (pluginId: string) => PermissionRoots
}): PermissionBroker {
  return {
    check(pluginId, action) {
      const grant = options.store.get(pluginId)
      const roots = options.rootsFor(pluginId)
      let decision: PermissionDecision
      if (!grant) {
        decision = { allowed: false, reason: '未授权（默认拒绝）' }
      } else if (action.type === 'fs.read') {
        const allowed =
          isUnderReal(roots.pluginDir, action.path) ||
          (grant.permissions.fs?.read ?? []).some((rel) => {
            const dir = pathFromData(roots.dataDir, rel)
            return dir !== null && isUnderReal(dir, action.path)
          })
        decision = allowed ? { allowed: true, reason: 'fs.read allowlist' } : { allowed: false, reason: 'fs.read 不在 allowlist' }
      } else if (action.type === 'fs.write') {
        const allowed = (grant.permissions.fs?.write ?? []).some((rel) => {
          const dir = pathFromData(roots.dataDir, rel)
          return dir !== null && isUnderReal(dir, action.path)
        })
        decision = allowed ? { allowed: true, reason: 'fs.write allowlist' } : { allowed: false, reason: 'fs.write 不在 allowlist' }
      } else if (action.type === 'network') {
        const host = action.host.toLowerCase()
        const allowed = (grant.permissions.network ?? []).some((pattern) => {
          if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(2)
            return host.endsWith(`.${suffix}`) && host !== suffix
          }
          return host === pattern
        })
        decision = allowed ? { allowed: true, reason: 'network allowlist' } : { allowed: false, reason: 'network 不在 allowlist' }
      } else {
        // 公开服务 allowlist 双保险：即使历史 grant 里有内部能力（consent/abort），也拒绝
        const publicName = (PUBLIC_SERVICE_NAMES as readonly string[]).includes(action.name)
        const allowed = publicName && (grant.permissions.services ?? []).includes(action.name)
        decision = allowed
          ? { allowed: true, reason: 'service allowlist' }
          : { allowed: false, reason: publicName ? 'service 不在 allowlist' : 'service 不是公开服务' }
      }
      options.audit.record(pluginId, action, decision)
      return decision
    }
  }
}

/** 子进程 env 白名单：只给运行所需 + NODE_OPTIONS 权限旗标，绝不透传宿主密钥/数据目录 */
const ENV_ALLOWLIST = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ'])

export interface PermissionEnvOptions {
  pluginDir: string
  dataDir: string
  /** 额外只读根（child 入口目录等；同样走 cwd 相对路径） */
  extraReadDirs?: string[]
  /** 子进程 cwd；缺省 = pluginDir。NODE_OPTIONS 用相对路径，避开 "Program Files" 空格 */
  cwd?: string
  permissions?: PluginPermissions
  baseEnv?: NodeJS.ProcessEnv
}

export function buildPluginPermissionEnv(options: PermissionEnvOptions): Record<string, string> {
  const base = options.baseEnv ?? process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key)) env[key] = value
  }

  const cwd = options.cwd ?? options.pluginDir
  const flagPath = (absolute: string): string => {
    // 优先相对 cwd：安装路径常含空格（Program Files），NODE_OPTIONS 的绝对路径无法可靠转义。
    // 相对路径不包含父目录名（只含 .. 和固定子目录），因此不会带空格。
    let rel = relative(cwd, absolute)
    if (!rel) rel = '.'
    if (isAbsolute(rel)) rel = absolute
    if (/\s/.test(rel) || /["']/.test(rel)) {
      const error = new Error(`PLUGIN_PERMISSION_CONFIG_INVALID：权限路径无法安全注入 NODE_OPTIONS：${absolute}`)
      ;(error as Error & { code?: string }).code = 'PLUGIN_PERMISSION_CONFIG_INVALID'
      throw error
    }
    return rel.split(sep).join('/')
  }

  const readDirs = new Set<string>([flagPath(options.pluginDir)])
  const writeDirs = new Set<string>()
  for (const dir of options.extraReadDirs ?? []) readDirs.add(flagPath(dir))
  for (const rel of options.permissions?.fs?.read ?? []) {
    const dir = pathFromData(options.dataDir, rel)
    if (dir) readDirs.add(flagPath(dir))
  }
  for (const rel of options.permissions?.fs?.write ?? []) {
    const dir = pathFromData(options.dataDir, rel)
    if (dir) writeDirs.add(flagPath(dir))
  }

  const flags = [
    '--experimental-permission',
    ...[...readDirs].map((p) => `--allow-fs-read=${p}`),
    ...[...writeDirs].map((p) => `--allow-fs-write=${p}`)
  ]
  env.NODE_OPTIONS = flags.join(' ')
  return env
}

/** 仅供测试/诊断：判断路径是否落在根内（不暴露到对外 API） */
export function isPathUnder(parent: string, child: string): boolean {
  if (isAbsolute(child) !== isAbsolute(parent)) return false
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
