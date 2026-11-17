// electron/main/obsidian/localModel.ts —— 本地向量模型的下载/校验/安装/离线导入
//
// 设计原则（见 resources/embedding-models/*.json 与 docs/app-integration.md）：
// - 不随安装包：模型与运行时都装到 <dataDir>/models/embedding/；
// - 只信内置清单：direct 清单逐文件 URL+sha256；离线 zip 必须匹配 archive 清单；
// - 安装/启用分离：安装完成且自检通过才允许写 ObsidianConfig 的 local 来源；
// - 原子落盘：先下载到 .staging，逐文件校验通过后 rename，失败不留半成品。
//
// 本文件刻意不 import electron：accept 测试可直接 bundle 后跑（NODE 环境）。

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import AdmZip from 'adm-zip'
import { AppError, ERROR_CODES } from '../services/errors'
import type { LocalModelProgress, LocalModelStatus } from './types'

const SCHEMA_VERSION = 1
const HASH_RE = /^[a-f0-9]{64}$/
const MAX_ZIP_BYTES = 200 * 1024 * 1024

interface PackageFile {
  path: string
  sizeBytes: number
  sha256: string
  urls: string[]
}

interface RuntimePackage {
  id: string
  version: string
  platform: string
  entry: string
  files: PackageFile[]
}

interface ModelPackage {
  id: string
  name: string
  version: string
  dim: number
  maxTokens?: number
  license?: string
  files: PackageFile[]
}

export interface LocalEmbeddingManifest {
  schema: number
  strategy: 'direct'
  totalDownloadBytes?: number
  runtimes: RuntimePackage[]
  models: ModelPackage[]
}

interface ArchiveEntry {
  id: string
  version: string
  package: string
  sizeBytes?: number
  sha256: string
  urls?: string[]
}

export interface ArchiveManifest {
  schema: number
  strategy: 'archive'
  runtimes: ArchiveEntry[]
  models: ArchiveEntry[]
}

interface InstalledState {
  schema: 1
  runtime?: { id: string; version: string; installedAt: number }
  model?: { id: string; version: string; dim: number; installedAt: number }
}

interface ZipEntryLike {
  entryName: string
  isDirectory: boolean
  header?: { size?: number }
  getData(): Buffer
}

export interface LocalModelManagerOptions {
  dataDir: string
  manifestPath: string
  archiveManifestPath?: string
  nodePath: string
  selftestScriptPath: string
  platform?: NodeJS.Platform
  arch?: string
  fetchImpl?: typeof fetch
  logger?: (message: string) => void
  /** 测试注入：跳过真实 ORT 自检 */
  runSelfTest?: (runtimeDir: string, modelDir: string) => Promise<{ dim: number }>
}

const SUPPORTED_PLATFORM = 'win32-x64'

function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  const normalized = p.replace(/\\/g, '/')
  if (normalized.includes('\u0000')) return false
  return normalized.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** id/version 只允许单段安全字符，防止 join(root, id, version) 逃出安装根 */
function isSafePackageSegment(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== '.' && value !== '..'
}

function assertManifestFile(file: PackageFile, options: { requireUrls?: boolean } = {}): void {
  if (!file || !isSafeRelativePath(file.path)) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `本地模型清单包含非法路径：${String(file?.path)}`)
  }
  if (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 0) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `本地模型清单文件大小非法：${file.path}`)
  }
  if (!HASH_RE.test(String(file.sha256 || ''))) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `本地模型清单 sha256 非法：${file.path}`)
  }
  // 离线包 manifest 只用于逐文件校验，不要求带下载地址；直连清单必须有 urls
  if (options.requireUrls !== false && (!Array.isArray(file.urls) || file.urls.length === 0)) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_DOWNLOAD_FAILED, `本地模型清单缺少下载地址：${file.path}`)
  }
  for (const url of file.urls || []) {
    if (!/^https?:\/\//i.test(String(url))) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_DOWNLOAD_FAILED, `本地模型清单地址非法：${url}`)
    }
  }
}

export function validateDirectManifest(raw: unknown): LocalEmbeddingManifest {
  const m = raw as LocalEmbeddingManifest
  if (!m || m.schema !== SCHEMA_VERSION || m.strategy !== 'direct') {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型清单格式非法（schema/strategy）')
  }
  if (!Array.isArray(m.runtimes) || m.runtimes.length === 0) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型清单缺少 runtime')
  }
  if (!Array.isArray(m.models) || m.models.length === 0) {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型清单缺少 model')
  }
  for (const rt of m.runtimes) {
    if (!rt.id || !rt.version || rt.platform !== SUPPORTED_PLATFORM) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, '本地模型运行时平台不受支持')
    }
    if (!Array.isArray(rt.files) || rt.files.length === 0) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型 runtime 文件列表为空')
    }
    for (const file of rt.files) assertManifestFile(file)
  }
  for (const model of m.models) {
    if (!model.id || !model.version || !Number.isFinite(model.dim) || model.dim <= 0) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型清单 model 元数据非法')
    }
    if (!Array.isArray(model.files) || model.files.length === 0) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '本地模型 model 文件列表为空')
    }
    for (const file of model.files) assertManifestFile(file)
  }
  return m
}

export function validateArchiveManifest(raw: unknown): ArchiveManifest {
  const m = raw as ArchiveManifest
  if (!m || m.schema !== SCHEMA_VERSION || m.strategy !== 'archive') {
    throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包清单格式非法（schema/strategy）')
  }
  for (const key of ['runtimes', 'models'] as const) {
    const list = m[key]
    if (!Array.isArray(list) || list.length === 0) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `离线包清单缺少 ${key}`)
    }
    for (const item of list) {
      if (!item || typeof item.package !== 'string' || !HASH_RE.test(String(item.sha256 || ''))) {
        throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包清单条目非法')
      }
      if (!isSafePackageSegment(item.id) || !isSafePackageSegment(item.version)) {
        throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包清单 id/version 非法')
      }
    }
  }
  return m
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export class LocalModelManager extends EventEmitter {
  private readonly opts: LocalModelManagerOptions
  private readonly root: string
  private readonly runtimeRoot: string
  private readonly modelRoot: string
  private readonly statePath: string
  private readonly stagingRoot: string
  private installing = false
  private abortController: AbortController | null = null
  private progress: LocalModelProgress | null = null
  private lastProgressEmitAt = 0
  private lastError: string | null = null
  private manifest: LocalEmbeddingManifest | null = null
  private archiveManifest: ArchiveManifest | null = null

  constructor(options: LocalModelManagerOptions) {
    super()
    this.opts = options
    this.root = join(options.dataDir, 'models', 'embedding')
    this.runtimeRoot = join(this.root, 'runtimes')
    this.modelRoot = join(this.root, 'models')
    this.statePath = join(this.root, 'state.json')
    this.stagingRoot = join(this.root, '.staging')
  }

  private get platformKey(): string {
    return `${this.opts.platform ?? process.platform}-${this.opts.arch ?? process.arch}`
  }

  isSupported(): boolean {
    return this.platformKey === SUPPORTED_PLATFORM
  }

  /** 运行时/模型当前安装目录（未安装返回 null） */
  getInstalledPaths(): { runtimeDir: string; modelDir: string } | null {
    const state = this.readStateSync()
    if (!state.runtime || !state.model) return null
    const runtimeDir = join(this.runtimeRoot, state.runtime.id, state.runtime.version)
    const modelDir = join(this.modelRoot, state.model.id, state.model.version)
    if (!existsSync(runtimeDir) || !existsSync(modelDir)) return null
    // 目录存在 ≠ 可加载：至少要求清单与模型主文件存在（损坏时 health/保存配置不能误判 installed；
    // 更完整的逐文件哈希在 local-embedding.mjs 加载前复验）
    if (!existsSync(join(runtimeDir, 'manifest.json')) || !existsSync(join(modelDir, 'manifest.json'))) return null
    if (!existsSync(join(modelDir, 'model_quantized.onnx'))) return null
    return { runtimeDir, modelDir }
  }

  getStatus(): LocalModelStatus {
    const manifest = this.loadManifestSafe()
    const state = this.readStateSync()
    const paths = this.getInstalledPaths()
    const installed = Boolean(paths)
    const runtime = installed && state.runtime ? { id: state.runtime.id, version: state.runtime.version } : null
    const modelPkg = manifest?.models[0] ?? null
    const installedModel = installed && state.model
      ? {
          id: state.model.id,
          version: state.model.version,
          name: modelPkg?.name ?? state.model.id,
          dim: state.model.dim,
          sizeBytes: modelPkg?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0
        }
      : null
    const totalBytes = manifest
      ? (manifest.runtimes[0]?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0) +
        (manifest.models[0]?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0)
      : 0
    return {
      installed,
      installing: this.installing,
      runtime,
      model: installedModel,
      progress: this.progress,
      lastError: this.lastError,
      supported: this.isSupported(),
      available: modelPkg
        ? {
            modelId: modelPkg.id,
            version: modelPkg.version,
            name: modelPkg.name,
            dim: modelPkg.dim,
            sizeBytes: modelPkg.files.reduce((s, f) => s + f.sizeBytes, 0),
            totalDownloadBytes: totalBytes
          }
        : null
    }
  }

  async install(): Promise<void> {
    if (!this.isSupported()) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, `本地模型暂不支持当前平台：${this.platformKey}`)
    }
    if (this.installing) throw new AppError(ERROR_CODES.CONFLICT, '本地模型正在安装中')
    if (!existsSync(this.opts.nodePath)) {
      throw new AppError(ERROR_CODES.SETUP_REQUIRED, '便携 Node 未安装，无法运行本地模型自检（请先在设置页初始化环境）')
    }
    const manifest = this.loadManifest()
    const totalBytes =
      (manifest.runtimes[0]?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0) +
      (manifest.models[0]?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0)
    await this.ensureDiskSpace(totalBytes + 200 * 1024 * 1024)
    this.installing = true
    this.lastError = null
    this.abortController = new AbortController()
    try {
      // 清理上一次崩溃留下的 staging（安装有全局互斥，不会误删并发任务）
      await rm(this.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      await this.doInstall(manifest)
      this.emitProgress({ phase: 'done', downloadedBytes: 0, totalBytes: 0, message: '本地模型安装完成' })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitProgress({ phase: 'error', downloadedBytes: 0, totalBytes: 0, message: this.lastError })
      throw error
    } finally {
      this.installing = false
      this.abortController = null
      await rm(this.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  cancel(): void {
    this.abortController?.abort()
  }

  async remove(): Promise<void> {
    if (this.installing) throw new AppError(ERROR_CODES.CONFLICT, '本地模型正在安装中，不能卸载')
    if (!existsSync(this.root)) {
      this.lastError = null
      this.progress = null
      return
    }
    // 原子摘除：先 rename 到 .deleting-*，再删除；rename 失败（网关/索引进程仍映射
    // dll/onnx 时 Windows 会锁目录）不会留下“删了一半”的安装目录。
    const deleting = `${this.root}.deleting-${Date.now()}`
    try {
      await rename(this.root, deleting)
    } catch (error) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `本地模型文件正被占用（请先停止/重启 OpenClaw 再卸载）：${error instanceof Error ? error.message : String(error)}`
      )
    }
    await rm(deleting, { recursive: true, force: true })
    this.lastError = null
    this.progress = null
  }

  /** 离线导入：zip 必须匹配 archive 清单（未知包拒绝），解压后逐文件校验并自检 */
  async importFromFile(zipPath: string): Promise<{ kind: 'runtime' | 'model'; id: string; version: string }> {
    if (this.installing) throw new AppError(ERROR_CODES.CONFLICT, '本地模型正在安装/导入中')
    if (!existsSync(this.opts.nodePath)) {
      throw new AppError(ERROR_CODES.SETUP_REQUIRED, '便携 Node 未安装，无法运行本地模型自检')
    }
    // 同步占位，避免两个 IPC 并发进入 doImportFromFile 的 await 窗口
    this.installing = true
    this.abortController = new AbortController()
    this.lastError = null
    try {
      return await this.doImportFromFile(zipPath)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.installing = false
      this.abortController = null
      await rm(this.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async doImportFromFile(zipPath: string): Promise<{ kind: 'runtime' | 'model'; id: string; version: string }> {
    const archive = this.loadArchiveManifest()
    const zipStat = await stat(zipPath).catch(() => null)
    if (!zipStat || !zipStat.isFile()) throw new AppError(ERROR_CODES.NOT_FOUND, `离线包不存在：${zipPath}`)
    if (zipStat.size > MAX_ZIP_BYTES) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包体积异常，拒绝导入')
    }
    const zipHash = await hashFile(zipPath)
    const runtimeEntry = archive.runtimes.find((x) => x.sha256 === zipHash)
    const modelEntry = archive.models.find((x) => x.sha256 === zipHash)
    if (!runtimeEntry && !modelEntry) {
      throw new AppError(
        ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED,
        '离线包不在内置清单中（未知 id/版本或文件已损坏），请先升级应用或重新下载'
      )
    }
    const kind = runtimeEntry ? 'runtime' : 'model'
    const entry = (runtimeEntry ?? modelEntry) as ArchiveEntry
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().filter((e) => !e.isDirectory)
    const manifestEntry = entries.find((e) => /\bmanifest\.json$/i.test(e.entryName))
    if (!manifestEntry) throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包缺少 manifest.json')
    let inner: { kind?: string; id?: string; version?: string; dim?: number; files?: PackageFile[] }
    try {
      inner = JSON.parse(manifestEntry.getData().toString('utf8'))
    } catch {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包 manifest.json 无法解析')
    }
    if (inner.kind !== (kind === 'runtime' ? 'embedding-runtime' : 'embedding-model')) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包类型与内置清单不匹配')
    }
    if (!inner.id || !inner.version || !Array.isArray(inner.files) || inner.files.length === 0) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包 manifest 字段不完整')
    }
    if (!isSafePackageSegment(inner.id) || !isSafePackageSegment(inner.version)) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包 manifest id/version 非法')
    }
    for (const file of inner.files) assertManifestFile(file, { requireUrls: false })
    // 必须与内置 archive 清单的 id/version 完全一致（不能因为是条件判断就跳过）
    if (inner.id !== entry.id || inner.version !== entry.version) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包 id/version 与内置清单不匹配')
    }
    if (kind === 'model' && Number(inner.dim) !== Number(this.loadManifest().models[0]?.dim)) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包模型维度与内置清单不匹配')
    }

    const stageDir = join(this.stagingRoot, `import-${kind}-${Date.now()}`)
    try {
      const state = this.readStateSync()
      const installedRuntimeDir = state.runtime
        ? join(this.runtimeRoot, state.runtime.id, state.runtime.version)
        : ''
      const installedModelDir = state.model
        ? join(this.modelRoot, state.model.id, state.model.version)
        : ''
      await this.extractZip(entries, stageDir)
      // 把包内 manifest 落到安装目录，供 local-embedding.mjs 启动时复验
      await writeFile(join(stageDir, 'manifest.json'), JSON.stringify(inner, null, 2), 'utf-8')
      await this.verifyDirectory(stageDir, inner.files)
      let dim = 0
      if (kind === 'runtime') {
        // 只有模型已存在时才能做完整自检；否则等模型导入后再由 install/启用前自检
        if (installedModelDir && existsSync(installedModelDir)) {
          dim = (await this.runSelfTest(stageDir, installedModelDir)).dim
        }
      } else {
        if (!installedRuntimeDir || !existsSync(installedRuntimeDir)) {
          throw new AppError(ERROR_CODES.LOCAL_MODEL_NOT_INSTALLED, '请先导入/安装本地模型运行时，再导入模型包')
        }
        dim = (await this.runSelfTest(installedRuntimeDir, stageDir)).dim
      }
      if (kind === 'model') {
        const manifestModel = this.loadManifest().models.find((m) => m.id === inner.id && m.version === inner.version)
        if (manifestModel && dim !== manifestModel.dim) {
          throw new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, `模型维度不符：期望 ${manifestModel.dim}，实际 ${dim}`)
        }
      }
      const finalDir = kind === 'runtime'
        ? join(this.runtimeRoot, inner.id, inner.version)
        : join(this.modelRoot, inner.id, inner.version)
      await this.installDirectory(stageDir, finalDir)
      if (kind === 'runtime') state.runtime = { id: inner.id, version: inner.version, installedAt: Date.now() }
      else state.model = { id: inner.id, version: inner.version, dim: dim || inner.dim || 0, installedAt: Date.now() }
      await this.writeState(state)
      return { kind, id: inner.id, version: inner.version }
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** 自检：当前已安装的运行时+模型能否真实加载并编出正确维度 */
  async selfTest(): Promise<{ dim: number }> {
    const paths = this.getInstalledPaths()
    if (!paths) throw new AppError(ERROR_CODES.LOCAL_MODEL_NOT_INSTALLED, '本地模型尚未安装')
    return this.runSelfTest(paths.runtimeDir, paths.modelDir)
  }

  // ── 内部实现 ──

  private async doInstall(manifest: LocalEmbeddingManifest): Promise<void> {
    const runtimePkg = manifest.runtimes[0]
    const modelPkg = manifest.models[0]
    const state = this.readStateSync()
    const installedRuntimeDir = state.runtime
      ? join(this.runtimeRoot, state.runtime.id, state.runtime.version)
      : ''
    const installedModelDir = state.model
      ? join(this.modelRoot, state.model.id, state.model.version)
      : ''
    const needRuntime = !(state.runtime && state.runtime.id === runtimePkg.id && state.runtime.version === runtimePkg.version &&
      await this.verifyDirectoryQuiet(join(this.runtimeRoot, runtimePkg.id, runtimePkg.version), runtimePkg.files))
    const needModel = !(state.model && state.model.id === modelPkg.id && state.model.version === modelPkg.version &&
      await this.verifyDirectoryQuiet(join(this.modelRoot, modelPkg.id, modelPkg.version), modelPkg.files))
    const totalBytes =
      (needRuntime ? runtimePkg.files.reduce((s, f) => s + f.sizeBytes, 0) : 0) +
      (needModel ? modelPkg.files.reduce((s, f) => s + f.sizeBytes, 0) : 0)
    const runtimeStage = join(this.stagingRoot, `runtime-${Date.now()}`)
    const modelStage = join(this.stagingRoot, `model-${Date.now()}`)
    let downloaded = 0
    const onBytes = (bytes: number): void => {
      downloaded += bytes
      this.emitProgress({ phase: 'downloading', downloadedBytes: downloaded, totalBytes, message: '下载本地模型' })
    }
    await ensureDir(this.stagingRoot)

    if (needRuntime) await this.downloadPackage(runtimePkg.files, runtimeStage, onBytes)
    if (needModel) await this.downloadPackage(modelPkg.files, modelStage, onBytes)
    // 把清单落到安装目录，供 local-embedding.mjs 启动时逐文件复验
    if (needRuntime) {
      await writeFile(
        join(runtimeStage, 'manifest.json'),
        JSON.stringify({ schema: 1, kind: 'embedding-runtime', id: runtimePkg.id, version: runtimePkg.version, files: runtimePkg.files }, null, 2),
        'utf-8'
      )
    }
    if (needModel) {
      await writeFile(
        join(modelStage, 'manifest.json'),
        JSON.stringify({ schema: 1, kind: 'embedding-model', id: modelPkg.id, version: modelPkg.version, dim: modelPkg.dim, files: modelPkg.files }, null, 2),
        'utf-8'
      )
    }

    this.emitProgress({ phase: 'installing', downloadedBytes: downloaded, totalBytes, message: '写入本地模型' })
    const runtimeDir = needRuntime ? runtimeStage : installedRuntimeDir
    const modelDir = needModel ? modelStage : installedModelDir
    this.emitProgress({ phase: 'self_test', downloadedBytes: downloaded, totalBytes, message: '本地模型自检中' })
    const { dim } = await this.runSelfTest(runtimeDir, modelDir)
    if (this.abortController?.signal.aborted) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '安装已取消')
    }
    if (dim !== modelPkg.dim) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, `模型维度不符：期望 ${modelPkg.dim}，实际 ${dim}`)
    }

    if (needRuntime) {
      await this.installDirectory(runtimeStage, join(this.runtimeRoot, runtimePkg.id, runtimePkg.version))
      state.runtime = { id: runtimePkg.id, version: runtimePkg.version, installedAt: Date.now() }
    }
    if (needModel) {
      await this.installDirectory(modelStage, join(this.modelRoot, modelPkg.id, modelPkg.version))
      state.model = { id: modelPkg.id, version: modelPkg.version, dim, installedAt: Date.now() }
    }
    await this.writeState(state)
  }

  /** 逐文件哈希校验；任何异常都按“无效”处理（用于安装前判断是否需要重下） */
  private async verifyDirectoryQuiet(dir: string, files: PackageFile[]): Promise<boolean> {
    try {
      await this.verifyDirectory(dir, files)
      return true
    } catch {
      return false
    }
  }

  private async ensureDiskSpace(requiredBytes: number): Promise<void> {
    try {
      const info = await statfs(this.opts.dataDir)
      const free = Number(info.bavail) * Number(info.bsize)
      if (free > 0 && free < requiredBytes) {
        throw new AppError(
          ERROR_CODES.LOCAL_MODEL_DOWNLOAD_FAILED,
          `磁盘空间不足：安装本地模型约需 ${Math.ceil(requiredBytes / 1024 / 1024)}MB，当前可用 ${Math.floor(free / 1024 / 1024)}MB`
        )
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      // statfs 在个别文件系统/权限下不可用：不阻塞安装，后续写盘失败会给出真实错误
    }
  }

  private async downloadPackage(
    files: PackageFile[],
    stageDir: string,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const queue = [...files]
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift()
        if (!file) return
        await this.downloadOne(file, stageDir, onBytes)
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  private async downloadOne(file: PackageFile, stageDir: string, onBytes: (bytes: number) => void): Promise<void> {
    const dest = join(stageDir, ...file.path.split('/'))
    await ensureDir(dirname(dest))
    let lastError: unknown = null
    for (const url of file.urls) {
      if (this.abortController?.signal.aborted) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '安装已取消')
      const tmp = `${dest}.part`
      try {
        const signal = AbortSignal.any([this.abortController!.signal, AbortSignal.timeout(300_000)])
        const res = await (this.opts.fetchImpl ?? fetch)(url, { signal, redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const hash = createHash('sha256')
        let size = 0
        const out = createWriteStream(tmp)
        const reader = Readable.fromWeb(res.body as never)
        for await (const chunk of reader) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += buf.length
          hash.update(buf)
          if (!out.write(buf)) {
            await new Promise<void>((resolveDrain) => out.once('drain', () => resolveDrain()))
          }
          onBytes(buf.length)
        }
        await new Promise<void>((resolveEnd, rejectEnd) => {
          out.end(() => resolveEnd())
          out.once('error', rejectEnd)
        })
        const digest = hash.digest('hex')
        if (size !== file.sizeBytes || digest !== file.sha256) {
          throw new Error(`文件校验失败（size=${size}/${file.sizeBytes}）`)
        }
        await rename(tmp, dest)
        this.emitProgress({ phase: 'verifying', downloadedBytes: 0, totalBytes: 0, file: file.path })
        return
      } catch (error) {
        lastError = error
        await rm(tmp, { force: true }).catch(() => undefined)
        if (this.abortController?.signal.aborted) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, '安装已取消')
        }
      }
    }
    throw new AppError(
      ERROR_CODES.LOCAL_MODEL_DOWNLOAD_FAILED,
      `下载失败：${file.path}（已尝试 ${file.urls.length} 个镜像）${lastError instanceof Error ? `：${lastError.message}` : ''}`
    )
  }

  private async verifyDirectory(dir: string, files: PackageFile[]): Promise<void> {
    for (const file of files) {
      const p = join(dir, ...file.path.split('/'))
      const info = await stat(p).catch(() => null)
      if (!info || !info.isFile() || info.size !== file.sizeBytes) {
        throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `文件缺失或大小不符：${file.path}`)
      }
      const digest = await hashFile(p)
      if (digest !== file.sha256) {
        throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `sha256 不符：${file.path}`)
      }
    }
  }

  private async installDirectory(stageDir: string, finalDir: string): Promise<void> {
    await ensureDir(dirname(finalDir))
    const backup = `${finalDir}.old-${Date.now()}`
    let movedOld = false
    if (existsSync(finalDir)) {
      await rename(finalDir, backup)
      movedOld = true
    }
    try {
      await rename(stageDir, finalDir)
      if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      // rename 失败时恢复旧安装，避免“先删后 rename”把可用版本弄丢
      if (movedOld) await rename(backup, finalDir).catch(() => undefined)
      throw error
    }
  }

  private async extractZip(entries: ZipEntryLike[], destDir: string): Promise<void> {
    if (entries.length > 500) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包文件数量异常，拒绝导入')
    }
    let totalSize = 0
    for (const entry of entries) {
      if (typeof entry.header?.size === 'number') {
        totalSize += entry.header.size
        if (entry.header.size > 256 * 1024 * 1024) {
          throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `离线包单文件过大：${entry.entryName}`)
        }
      }
    }
    if (totalSize > 1024 * 1024 * 1024) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线包解压后体积异常，拒绝导入')
    }
    const names = entries.map((e) => e.entryName.replace(/\\/g, '/'))
    const firstSegments = new Set(names.map((n) => n.split('/')[0]))
    const prefix = firstSegments.size === 1 && names.every((n) => n.includes('/')) ? names[0].split('/')[0] + '/' : ''
    for (const entry of entries) {
      const raw = entry.entryName.replace(/\\/g, '/')
      const rel = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
      if (!rel || !isSafeRelativePath(rel)) {
        throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, `离线包包含非法路径：${entry.entryName}`)
      }
      const target = join(destDir, ...rel.split('/'))
      await ensureDir(dirname(target))
      await writeFile(target, entry.getData())
    }
  }

  private async runSelfTest(runtimeDir: string, modelDir: string): Promise<{ dim: number }> {
    if (this.opts.runSelfTest) return this.opts.runSelfTest(runtimeDir, modelDir)
    if (!runtimeDir || !modelDir) {
      throw new AppError(ERROR_CODES.LOCAL_MODEL_NOT_INSTALLED, '本地模型尚未安装完整（runtime/model 缺一）')
    }
    if (!existsSync(this.opts.nodePath)) {
      throw new AppError(ERROR_CODES.SETUP_REQUIRED, '便携 Node 未安装，无法运行本地模型自检')
    }
    return new Promise<{ dim: number }>((resolvePromise, rejectPromise) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SYSTEMROOT: process.env.SYSTEMROOT,
        SYSTEMDRIVE: process.env.SYSTEMDRIVE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        OBS_EMBEDDING_ADAPTER: 'local',
        OBS_EMBEDDING_LOCAL_RUNTIME_DIR: runtimeDir,
        OBS_EMBEDDING_LOCAL_MODEL_DIR: modelDir
      }
      const proc = spawn(this.opts.nodePath, [this.opts.selftestScriptPath], {
        env,
        windowsHide: true,
        shell: false
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        rejectPromise(new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, '本地模型自检超时（90s）'))
      }, 90_000)
      proc.stdout.setEncoding('utf-8')
      proc.stdout.on('data', (d: string) => { stdout += d })
      proc.stderr.setEncoding('utf-8')
      proc.stderr.on('data', (d: string) => { stderr += d })
      proc.on('error', (error) => {
        clearTimeout(timer)
        rejectPromise(new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, `自检进程启动失败：${error.message}`))
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]) as { ok?: boolean; dim?: number; error?: string }
            if (parsed.ok && Number.isFinite(parsed.dim)) {
              resolvePromise({ dim: Number(parsed.dim) })
              return
            }
            if (parsed.error) {
              rejectPromise(new AppError(ERROR_CODES.LOCAL_MODEL_UNSUPPORTED, parsed.error))
              return
            }
          } catch { /* 跳过非 JSON 行 */ }
        }
        rejectPromise(
          new AppError(
            ERROR_CODES.LOCAL_MODEL_UNSUPPORTED,
            `自检失败（退出码 ${code}）：${(stderr.trim() || stdout.trim()).slice(0, 300)}`
          )
        )
      })
    })
  }

  private emitProgress(progress: LocalModelProgress): void {
    this.progress = progress
    // 下载阶段每个 chunk 都上报会让 IPC 过载（54MB → 上千次事件）；
    // 100ms 节流，非下载阶段（verifying/installing/self_test/done/error）立即上报。
    const now = Date.now()
    if (progress.phase === 'downloading' && now - this.lastProgressEmitAt < 100) return
    this.lastProgressEmitAt = now
    this.emit('progress', progress)
  }

  private loadManifest(): LocalEmbeddingManifest {
    if (this.manifest) return this.manifest
    this.manifest = validateDirectManifest(this.readJsonSync(this.opts.manifestPath, '本地模型清单'))
    return this.manifest
  }

  private loadManifestSafe(): LocalEmbeddingManifest | null {
    try {
      return this.loadManifest()
    } catch {
      return null
    }
  }

  private loadArchiveManifest(): ArchiveManifest {
    if (this.archiveManifest) return this.archiveManifest
    const path = this.opts.archiveManifestPath
    if (!path) throw new AppError(ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED, '离线导入需要内置 archive 清单')
    this.archiveManifest = validateArchiveManifest(this.readJsonSync(path, '离线包清单'))
    return this.archiveManifest
  }

  private readJsonSync(path: string, label: string): unknown {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      throw new AppError(
        ERROR_CODES.LOCAL_MODEL_VERIFY_FAILED,
        `${label}读取失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private readStateSync(): InstalledState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as InstalledState
      if (raw && raw.schema === 1) return raw
    } catch { /* 未安装 */ }
    return { schema: 1 }
  }

  private async writeState(state: InstalledState): Promise<void> {
    await ensureDir(this.root)
    const tmp = `${this.statePath}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    // Windows rename 可覆盖已存在文件；失败再退回 rm+rename（窗口更小，避免 crash 丢 state）
    try {
      await rename(tmp, this.statePath)
    } catch {
      await rm(this.statePath, { force: true })
      await rename(tmp, this.statePath)
    }
  }
}

/** 资源目录下的清单路径（dev: appPath/resources；pack: resourcesPath/resources） */
export function localModelManifestPath(resourcesRoot: string): string {
  return join(resourcesRoot, 'embedding-models', 'local-embedding-manifest.json')
}

export function localModelArchiveManifestPath(resourcesRoot: string): string {
  return join(resourcesRoot, 'embedding-models', 'local-embedding-manifest.archive.json')
}
