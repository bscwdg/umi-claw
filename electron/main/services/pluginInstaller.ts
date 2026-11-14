// electron/main/services/pluginInstaller.ts —— `.umi-plugin` 安装/更新/回滚/卸载（C2）
//
// 安装顺序固定：验签 → 安全解包到临时目录 → 写 packageDir → 数据快照 → 更新状态。
// 任何一步失败都不碰现有安装；回滚只切版本并恢复对应数据快照。

import AdmZip from 'adm-zip'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { verifyPluginPackage, type PluginKeyring } from './pluginPackage'
import type { PluginPermissions } from '../kernel/manifest'
import { satisfiesHostRange } from '../kernel/manifest'

export interface PluginTrustEntry {
  fingerprint: string
  keyId: string
  firstSeen: number
  lastSeen: number
}

export interface PluginTrustState {
  schema: 1
  keys: Record<string, PluginTrustEntry>
}

function trustPath(dataDir: string): string {
  return join(dataDir, 'plugin-trust.json')
}

function readTrust(dataDir: string): PluginTrustState {
  try {
    const parsed = JSON.parse(readFileSync(trustPath(dataDir), 'utf8')) as PluginTrustState
    if (parsed.schema === 1 && parsed.keys && typeof parsed.keys === 'object') return parsed
  } catch {
    // 坏文件按空 trust；安装时重建
  }
  return { schema: 1, keys: {} }
}

function writeTrust(dataDir: string, trust: PluginTrustState): void {
  mkdirSync(dataDir, { recursive: true })
  const file = trustPath(dataDir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(trust, null, 2), 'utf8')
  renameSync(tmp, file)
}
export interface InstallRecord {
  id: string
  version: string
  name: string
  packageDir: string
  dataDir: string
  trustLevel: 'official' | 'partner' | 'self'
  keyId: string
  enabled: boolean
  installedAt: number
  updatedAt: number
  entry: string
  permissions?: PluginPermissions
  configSchema?: Record<string, unknown>
  previous?: {
    version: string
    packageDir: string
    dataDir: string
    backupDir: string | null
    installedAt: number
    permissions?: PluginPermissions
    configSchema?: Record<string, unknown>
  }
}

export interface InstallState {
  schema: 1
  plugins: Record<string, InstallRecord>
}

export interface InstallOptions {
  dataDir: string
  packageFile: string
  keyring?: PluginKeyring
  allowSelfSigned?: boolean
  tofuFingerprint?: string
  /** 宿主 child 入口；C2 staging 到 <dataDir>/plugin-runtime/<hostVersion>/ */
  stagingChildSource?: string
  /** 实际用于启动的宿主 child 入口（Electron utilityProcess 须在 app 内） */
  hostChildEntry?: string
  hostVersion?: string
  now?: number
  maxBackups?: number
}

export type InstallResult =
  | { ok: true; record: InstallRecord; updated: boolean }
  | { ok: false; code: string; message: string }

export function installStatePath(dataDir: string): string {
  return join(dataDir, 'plugin-install-state.json')
}

export function readInstallState(dataDir: string): InstallState {
  try {
    const parsed = JSON.parse(readFileSync(installStatePath(dataDir), 'utf8')) as InstallState
    if (parsed.schema === 1 && parsed.plugins && typeof parsed.plugins === 'object') return parsed
  } catch {
    // 坏文件按空状态；安装/更新会整体重写
  }
  return { schema: 1, plugins: {} }
}

function writeInstallState(dataDir: string, state: InstallState): void {
  const file = installStatePath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

function safeEntryName(name: string): string | null {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const parts = name.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return name
}

function extractPackage(packageFile: string, targetDir: string): { ok: true } | { ok: false; code: string; message: string } {
  let zip: AdmZip
  try {
    zip = new AdmZip(packageFile)
  } catch (e) {
    return { ok: false, code: 'PACKAGE_INVALID_ZIP', message: (e as Error).message }
  }
  const entries = zip.getEntries()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = safeEntryName(entry.entryName)
    if (!name) return { ok: false, code: 'PACKAGE_UNSAFE_PATH', message: entry.entryName }
    if (seen.has(name.toLowerCase())) return { ok: false, code: 'PACKAGE_DUPLICATE_ENTRY', message: name }
    seen.add(name.toLowerCase())
  }
  const staging = `${targetDir}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(staging, { recursive: true })
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const name = safeEntryName(entry.entryName)!
      const out = resolve(staging, name)
      if (!out.startsWith(resolve(staging) + sep)) {
        return { ok: false, code: 'PACKAGE_UNSAFE_PATH', message: name }
      }
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, entry.getData())
    }
    mkdirSync(dirname(targetDir), { recursive: true })
    rmSync(targetDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
    renameSync(staging, targetDir)
    return { ok: true }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: 'PACKAGE_EXTRACT_FAILED', message: (e as Error).message }
  }
}

const RESERVED_PLUGIN_IDS = new Set(['work', 'marketing', 'hello', 'host', 'plugin', 'system', 'app', 'umi'])
const PUBLIC_SERVICES = new Set(['db', 'openclaw', 'notifications', 'config', 'kv', 'secrets', 'voice'])

function parseManifest(
  dir: string,
  hostVersion: string
): { id: string; version: string; name: string; permissions?: PluginPermissions; configSchema?: Record<string, unknown> } | { code: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as {
      id?: string
      version?: string
      name?: string
      apiVersion?: number
      engines?: { host?: string }
      permissions?: PluginPermissions
      configSchema?: Record<string, unknown>
    }
    if (!raw.id || !/^[a-z][a-z0-9-]*$/.test(raw.id)) return null
    if (RESERVED_PLUGIN_IDS.has(raw.id)) return { code: 'PLUGIN_ID_RESERVED' }
    if (raw.permissions) {
      const keys = Object.keys(raw.permissions)
      if (keys.some((key) => !['fs', 'network', 'services'].includes(key))) return { code: 'PACKAGE_MANIFEST_INVALID' }
      const services = raw.permissions.services ?? []
      if (!Array.isArray(services) || services.some((service) => !PUBLIC_SERVICES.has(service))) {
        return { code: 'PLUGIN_PERMISSION_DENIED' }
      }
    }
    if (!raw.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)) return null
    if (!existsSync(join(dir, 'main.js'))) return null
    if (raw.apiVersion !== undefined && (!Number.isInteger(raw.apiVersion) || raw.apiVersion < 1)) {
      return { code: 'PLUGIN_INCOMPATIBLE' }
    }
    if (raw.engines?.host && !satisfiesHostRange(hostVersion, raw.engines.host)) {
      return { code: 'PLUGIN_INCOMPATIBLE' }
    }
    return { id: raw.id, version: raw.version, name: raw.name ?? raw.id, permissions: raw.permissions, configSchema: raw.configSchema }
  } catch {
    return null
  }
}

function timestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

function copyDir(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function backupData(dataDir: string, pluginId: string, now: number, maxBackups: number): string | null {
  const source = join(dataDir, 'plugin-data', pluginId)
  if (!existsSync(source)) return null
  const root = join(dataDir, 'plugin-backups', pluginId)
  mkdirSync(root, { recursive: true })
  const target = join(root, timestamp(now))
  copyDir(source, target)
  const all = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  while (all.length > maxBackups) {
    const oldest = all.shift()!
    rmSync(join(root, oldest), { recursive: true, force: true })
  }
  return target
}

function stageChild(options: InstallOptions): string {
  const version = options.hostVersion ?? 'unknown'
  const targetDir = join(options.dataDir, 'plugin-runtime', version)
  const target = join(targetDir, 'pluginProcessChild.js')
  if (options.stagingChildSource && existsSync(options.stagingChildSource)) {
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(options.stagingChildSource, target)
  }
  return target
}

/** C8：安装/更新/回滚/卸载审计（JSONL，不落密钥/绝对用户路径） */
export function appendPluginAudit(
  dataDir: string,
  event: {
    action: 'install' | 'update' | 'rollback' | 'uninstall'
    id: string
    version?: string
    ok: boolean
    code?: string
    at?: string
  }
): void {
  try {
    const line = JSON.stringify({
      at: event.at ?? new Date().toISOString(),
      action: event.action,
      id: event.id,
      version: event.version,
      ok: event.ok,
      code: event.code
    })
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(join(dataDir, 'plugin-audit.log'), `${line}\n`, 'utf8')
  } catch {
    // 审计写失败不阻断安装；C8 诊断会暴露日志缺失
  }
}

/** C8：诊断快照（不返回密钥内容） */
export function collectPluginDiagnostics(dataDir: string): {
  installed: number
  backups: number
  auditLines: number
  keyring: boolean
  trust: boolean
  revocations: boolean
} {
  const state = readInstallState(dataDir)
  let backups = 0
  try {
    for (const entry of readdirSync(join(dataDir, 'plugin-backups'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      backups += readdirSync(join(dataDir, 'plugin-backups', entry.name), { withFileTypes: true }).filter((e) => e.isDirectory()).length
    }
  } catch {
    // 无备份目录
  }
  let auditLines = 0
  try {
    auditLines = readFileSync(join(dataDir, 'plugin-audit.log'), 'utf8').split('\n').filter(Boolean).length
  } catch {
    // 无审计
  }
  return {
    installed: Object.keys(state.plugins).length,
    backups,
    auditLines,
    keyring: existsSync(join(dataDir, 'plugin-keys.json')),
    trust: existsSync(join(dataDir, 'plugin-trust.json')),
    revocations: existsSync(join(dataDir, 'plugin-revocations.json'))
  }
}

function isRevoked(dataDir: string, keyId: string, fingerprint: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'plugin-revocations.json'), 'utf8')) as {
      keys?: Record<string, unknown>
      fingerprints?: Record<string, unknown>
    }
    return Boolean(raw.keys?.[keyId] || raw.fingerprints?.[fingerprint])
  } catch {
    return false
  }
}
function isSubsetPermissions(next: PluginPermissions | undefined, previous: PluginPermissions | undefined): boolean {
  const n = next ?? {}
  const p = previous ?? {}
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  const nServices = list(n.services)
  if (nServices.some((s) => !list(p.services).includes(s))) return false
  const nRead = list(n.fs?.read)
  if (nRead.some((x) => !list(p.fs?.read).includes(x))) return false
  const nWrite = list(n.fs?.write)
  if (nWrite.some((x) => !list(p.fs?.write).includes(x))) return false
  const nDomains = list(n.network)
  if (nDomains.some((x) => !list(p.network).includes(x))) return false
  return true
}

/** 启动/安装前策略检查：kill switch 与吊销对已安装插件同样生效 */
export function isPluginBlockedByPolicy(dataDir: string, record: Pick<InstallRecord, 'keyId'>): string | null {
  if (existsSync(join(dataDir, 'plugin-kill-switch.json'))) return 'PLUGIN_KILL_SWITCH'
  if (record.keyId) {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, 'plugin-revocations.json'), 'utf8')) as {
        keys?: Record<string, unknown>
      }
      if (raw.keys?.[record.keyId]) return 'PLUGIN_REVOKED'
    } catch {
      // 无吊销文件
    }
  }
  return null
}

/** C6：host 侧按 configSchema 校验第三方配置（类型/枚举/required/大小/深度） */
export function validatePluginConfig(
  schema: Record<string, unknown> | undefined,
  config: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, message: '配置必须是对象' }
  const text = JSON.stringify(config)
  if (text.length > 64 * 1024) return { ok: false, message: '配置超过 64KB' }
  const depth = (v: unknown, d = 0): number =>
    d > 6 ? d : v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v as Record<string, unknown>).map((x) => depth(x, d + 1))) : d
  if (depth(config) > 6) return { ok: false, message: '配置嵌套过深' }
  const properties = (schema as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined)?.properties
  if (!properties) return { ok: true, value: config as Record<string, unknown> }
  for (const [key, prop] of Object.entries(properties)) {
    const value = (config as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (prop.type === 'number' && typeof value !== 'number') return { ok: false, message: `${key} 必须是数字` }
    if (prop.type === 'boolean' && typeof value !== 'boolean') return { ok: false, message: `${key} 必须是布尔` }
    if (prop.type === 'string' && typeof value !== 'string') return { ok: false, message: `${key} 必须是字符串` }
    if (prop.enum && !prop.enum.includes(value)) return { ok: false, message: `${key} 不在枚举内` }
  }
  return { ok: true, value: config as Record<string, unknown> }
}
export function inspectPluginPackage(options: {
  packageFile: string
  keyring?: PluginKeyring
  allowSelfSigned?: boolean
}): { ok: true; id: string; version: string; trust: string; fingerprint: string; keyId: string } | { ok: false; code: string; message: string } {
  const verified = verifyPluginPackage(options.packageFile, {
    keyring: options.keyring,
    allowSelfSigned: options.allowSelfSigned
  })
  if (!verified.ok) return verified
  try {
    const raw = JSON.parse(new AdmZip(options.packageFile).getEntry('plugin.json')!.getData().toString('utf8')) as {
      id?: string
      version?: string
    }
    if (!raw.id || !raw.version) return { ok: false, code: 'PACKAGE_MANIFEST_INVALID', message: '缺少 id/version' }
    return {
      ok: true,
      id: raw.id,
      version: raw.version,
      trust: verified.trust,
      fingerprint: verified.fingerprint,
      keyId: verified.signature.keyId
    }
  } catch (e) {
    return { ok: false, code: 'PACKAGE_MANIFEST_INVALID', message: (e as Error).message }
  }
}
/** C8：kill switch（存在即拒绝所有第三方安装/更新） */
export function setPluginKillSwitch(dataDir: string, enabled: boolean, reason = ''): void {
  const file = join(dataDir, 'plugin-kill-switch.json')
  if (enabled) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ enabledAt: new Date().toISOString(), reason }, null, 2), 'utf8')
  } else {
    rmSync(file, { force: true })
  }
}

export function installPlugin(options: InstallOptions): InstallResult {
  const result = installPluginImpl(options)
  if (!result.ok) {
    appendPluginAudit(options.dataDir, {
      action: 'install',
      id: basename(options.packageFile),
      ok: false,
      code: result.code
    })
  }
  return result
}

function installPluginImpl(options: InstallOptions): InstallResult {
  if (existsSync(join(options.dataDir, 'plugin-kill-switch.json'))) {
    return { ok: false, code: 'PLUGIN_KILL_SWITCH', message: '第三方插件安装已停用（kill switch）' }
  }
  const verified = verifyPluginPackage(options.packageFile, {
    keyring: options.keyring,
    allowSelfSigned: options.allowSelfSigned,
    tofuFingerprint: options.tofuFingerprint
  })
  if (!verified.ok) return verified
  if (isRevoked(options.dataDir, verified.signature.keyId, verified.fingerprint)) {
    return { ok: false, code: 'PLUGIN_REVOKED', message: `插件密钥已吊销：${verified.signature.keyId}` }
  }
  if (verified.trust === 'self') {
    const trust = readTrust(options.dataDir)
    const known = trust.keys[verified.signature.keyId]
    if (known && known.fingerprint !== verified.fingerprint) {
      return { ok: false, code: 'PACKAGE_TOFU_MISMATCH', message: '自签包指纹变化，拒绝安装' }
    }
    trust.keys[verified.signature.keyId] = {
      fingerprint: verified.fingerprint,
      keyId: verified.signature.keyId,
      firstSeen: known?.firstSeen ?? Date.now(),
      lastSeen: Date.now()
    }
    writeTrust(options.dataDir, trust)
  }
  const now = options.now ?? Date.now()
  const id = (() => {
    try {
      return (JSON.parse(new AdmZip(options.packageFile).getEntry('plugin.json')!.getData().toString('utf8')) as { id?: string }).id
    } catch {
      return undefined
    }
  })()
  if (!id) return { ok: false, code: 'PACKAGE_MANIFEST_INVALID', message: '缺少 id' }
  const state = readInstallState(options.dataDir)
  const existing = state.plugins[id]
  if (existing && existing.keyId !== verified.signature.keyId && verified.trust === 'self') {
    return { ok: false, code: 'PACKAGE_KEY_ID_CHANGED', message: '自签插件更新更换了 keyId，需重新确认信任' }
  }
  const isUpdate = Boolean(existing)
  const stagingDir = join(options.dataDir, 'plugin-packages', id, `.staging-${now}`)
  const extracted = extractPackage(options.packageFile, stagingDir)
  if (!extracted.ok) return extracted
  const manifest = parseManifest(stagingDir, options.hostVersion ?? '5.0.0')
  if (!manifest) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, code: 'PACKAGE_MANIFEST_INVALID', message: 'plugin.json 非法或缺 main.js' }
  }
  if ('code' in manifest) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, code: manifest.code, message: 'apiVersion/engines 与宿主不兼容' }
  }
  if (existing && !isSubsetPermissions(manifest.permissions, existing.permissions)) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, code: 'PLUGIN_PERMISSION_ESCALATION', message: '升级不得扩大权限；请先卸载再安装' }
  }
  if (manifest.id !== id) {
    rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, code: 'PACKAGE_MANIFEST_INVALID', message: 'id 与包名不一致' }
  }
  const finalDir = join(options.dataDir, 'plugin-packages', id, manifest.version)
  if (existsSync(finalDir) && !isUpdate) {
    // 同版本重装：覆盖前先移除旧目录
    rmSync(finalDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
  }
  mkdirSync(dirname(finalDir), { recursive: true })
  rmSync(finalDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
  renameSync(stagingDir, finalDir)

  const backupDir = isUpdate ? backupData(options.dataDir, id, now, options.maxBackups ?? 5) : null
  const dataDir = join(options.dataDir, 'plugin-data', id)
  mkdirSync(dataDir, { recursive: true })
  const stagedEntry = stageChild({ ...options, hostVersion: options.hostVersion ?? 'unknown' })
  const entry = options.hostChildEntry ?? stagedEntry
  const record: InstallRecord = {
    id,
    version: manifest.version,
    name: manifest.name,
    packageDir: finalDir,
    dataDir,
    trustLevel: verified.trust,
    keyId: verified.signature.keyId,
    enabled: true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    entry,
    permissions: manifest.permissions,
    configSchema: manifest.configSchema,
    ...(isUpdate
      ? {
          previous: {
            version: existing.version,
            packageDir: existing.packageDir,
            dataDir: existing.dataDir,
            backupDir,
            installedAt: existing.installedAt,
            permissions: existing.permissions,
            configSchema: existing.configSchema
          }
        }
      : {})
  }
  writeInstallState(options.dataDir, {
    schema: 1,
    plugins: { ...state.plugins, [id]: record }
  })
  appendPluginAudit(options.dataDir, {
    action: isUpdate ? 'update' : 'install',
    id,
    version: record.version,
    ok: true
  })
  return { ok: true, record, updated: isUpdate }
}

export type RollbackResult =
  | { ok: true; record: InstallRecord }
  | { ok: false; code: string; message: string }

export function rollbackPlugin(dataDir: string, pluginId: string): RollbackResult {
  const state = readInstallState(dataDir)
  const current = state.plugins[pluginId]
  if (!current) return { ok: false, code: 'PLUGIN_NOT_INSTALLED', message: pluginId }
  if (!current.previous) return { ok: false, code: 'PLUGIN_NO_PREVIOUS', message: pluginId }
  if (!existsSync(current.previous.packageDir)) {
    return { ok: false, code: 'PLUGIN_PREVIOUS_MISSING', message: current.previous.packageDir }
  }
  if (current.previous.backupDir && existsSync(current.previous.backupDir)) {
    rmSync(current.dataDir, { recursive: true, force: true })
    copyDir(current.previous.backupDir, current.dataDir)
  }
  const record: InstallRecord = {
    ...current,
    version: current.previous.version,
    packageDir: current.previous.packageDir,
    dataDir: current.previous.dataDir,
    installedAt: current.previous.installedAt,
    updatedAt: Date.now(),
    permissions: current.previous.permissions ?? current.permissions,
    configSchema: current.previous.configSchema ?? current.configSchema,
    previous: undefined
  }
  writeInstallState(dataDir, { schema: 1, plugins: { ...state.plugins, [pluginId]: record } })
  appendPluginAudit(dataDir, { action: 'rollback', id: pluginId, version: record.version, ok: true })
  return { ok: true, record }
}

export type UninstallResult = { ok: true } | { ok: false; code: string; message: string }

export function uninstallPlugin(dataDir: string, pluginId: string, keepData = true): UninstallResult {
  const state = readInstallState(dataDir)
  const current = state.plugins[pluginId]
  if (!current) return { ok: false, code: 'PLUGIN_NOT_INSTALLED', message: pluginId }
  rmSync(current.packageDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
  if (!keepData) rmSync(join(dataDir, 'plugin-data', pluginId), { recursive: true, force: true })
  const plugins = { ...state.plugins }
  delete plugins[pluginId]
  writeInstallState(dataDir, { schema: 1, plugins })
  appendPluginAudit(dataDir, { action: 'uninstall', id: pluginId, ok: true })
  return { ok: true }
}
