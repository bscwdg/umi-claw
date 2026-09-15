// database.ts —— DB Worker 客户端（PLAN-2.0.md §四「DB Worker 协议」）
//
// 职责：
//   - 单例常驻子进程（硬规则 8）：整个应用只有一个 db-worker.mjs 进程
//   - 请求队列：id → { resolve, reject, 超时 30s }
//   - 断线自动重启一次；**读请求自动重试，写请求默认不自动重试**
//     （例外：Manager 预生成主键的幂等 upsert 显式传 { retryable: true }）
//   - 惰性初始化：应用启动不建库、不拉 Worker；首次 marketing 调用才 spawn + migrate
//   - 便携 Node 不存在 → 抛 SETUP_REQUIRED（前端引导去环境初始化）
//   - backup()：VACUUM INTO 'data/backup/umi-claw-<ts>.db'，保留最近 5 份
//
// 设计约束（重要）：本模块**不 import electron**，Electron 相关依赖（node 可执行文件
// 路径 / worker 脚本路径 / db 路径 / 备份目录）全部注入。因此它可以在纯 Node 下被
// import 并用 esbuild bundle 后直接测试（test/db-client.accept.mjs）。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError, ERROR_CODES, type ErrorCode } from './errors'
import { TARGET_USER_VERSION, pendingSteps } from './migration'

export interface DatabaseClientOptions {
  /** SQLite 文件路径（约定 data/umi-claw.db） */
  dbPath: string
  /** 备份目录（约定 data/backup） */
  backupDir: string
  /** resources/database/db-worker.mjs 的绝对路径 */
  workerScriptPath: string
  /** 便携 Node 可执行文件绝对路径（configManager.getNodePath()） */
  nodePath: string
  /** 单请求超时，默认 30000ms */
  requestTimeoutMs?: number
  /** 备份保留份数，默认 5 */
  maxBackups?: number
  /** 自动快照最小间隔，默认 24h（仅在已有备份时判断） */
  autoBackupIntervalMs?: number
  /** 优雅停等待上限，默认 3000ms */
  gracefulStopTimeoutMs?: number
  /** worker 在子进程注册表里的名字 */
  subprocessName?: string
  /** 子进程启动钩子：返回反注册函数（index.ts 把它接到 subprocessRegistry） */
  onSpawn?: (info: { name: string; pid: number; gracefulStop: () => Promise<void> }) => () => void
  /** 日志（默认静默） */
  logger?: (message: string) => void
}

export interface DatabaseStatus {
  /** Worker 是否已就绪（已完成 ping + 迁移） */
  ready: boolean
  dbPath: string
  backupDir: string
  /** PRAGMA user_version */
  userVersion: number | null
  /** 实际检出的表清单（含 app_meta） */
  tables: string[]
  indexes: string[]
  journalMode: string | null
  foreignKeys: boolean | null
  sqliteVersion: string | null
  /** Worker 子进程 pid（未启动为 null） */
  workerPid: number | null
  /** 在途请求数 */
  pendingRequests: number
  /** 本次进程内是否刚执行过迁移 */
  migrated: boolean
}

export interface BackupResult {
  path: string
  size: number
  reason: string
  pruned: string[]
}

/** Worker `schema.info` 的原始返回 */
interface SchemaInfoRaw {
  userVersion?: number
  tables?: string[]
  indexes?: string[]
  journalMode?: string | null
  foreignKeys?: boolean | null
  sqliteVersion?: string | null
}

export interface RequestOptions {
  timeoutMs?: number
  /** 写请求显式声明可安全重试（预生成主键的幂等 upsert） */
  retryable?: boolean
  /** 不触发惰性初始化（Worker 未就绪时直接失败） */
  noInit?: boolean
}

interface PendingEntry {
  id: string
  method: string
  params: unknown
  isRead: boolean
  retryable: boolean
  timeoutMs: number
  attempts: number
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: NodeJS.Timeout | null
}

/** 明显是读请求的方法（其余一律按写请求处理：保守，绝不自动重试） */
const READ_METHODS = new Set(['ping', 'schema.info', 'knowledge.search', 'meta.get'])

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BACKUPS = 5
const DEFAULT_AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_GRACEFUL_STOP_MS = 3_000
/** 断线后自动重启次数上限（PLAN §四：「断线自动重启一次」） */
const MAX_AUTO_RESTARTS_PER_EPISODE = 1

function isReadMethod(method: string): boolean {
  if (READ_METHODS.has(method)) return true
  return /\.(list|get|count|search)$/.test(method)
}

function statusFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => /^umi-claw-.*\.db$/.test(f))
  } catch {
    return []
  }
}

function backupStamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  )
}

export class DatabaseClient {
  private readonly opts: Required<
    Pick<
      DatabaseClientOptions,
      | 'dbPath'
      | 'backupDir'
      | 'workerScriptPath'
      | 'nodePath'
      | 'requestTimeoutMs'
      | 'maxBackups'
      | 'autoBackupIntervalMs'
      | 'gracefulStopTimeoutMs'
    >
  > & { subprocessName: string }

  private child: ChildProcess | null = null
  private pending = new Map<string, PendingEntry>()
  private seq = 0
  private stdoutBuf = ''
  private readyPromise: Promise<void> | null = null
  private ready = false
  private migrated = false
  private restartsUsed = 0
  private unregisterSubprocess: (() => void) | null = null
  private disposed = false
  private lastExit: { code: number | null; signal: string | null; at: number } | null = null

  constructor(options: DatabaseClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'DatabaseClient 需要注入式依赖配置')
    }
    for (const key of ['dbPath', 'backupDir', 'workerScriptPath', 'nodePath'] as const) {
      if (typeof options[key] !== 'string' || !options[key]) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `DatabaseClient 缺少依赖: ${key}`)
      }
    }
    this.opts = {
      dbPath: options.dbPath,
      backupDir: options.backupDir,
      workerScriptPath: options.workerScriptPath,
      nodePath: options.nodePath,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBackups: options.maxBackups ?? DEFAULT_MAX_BACKUPS,
      autoBackupIntervalMs: options.autoBackupIntervalMs ?? DEFAULT_AUTO_BACKUP_INTERVAL_MS,
      gracefulStopTimeoutMs: options.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_MS,
      subprocessName: options.subprocessName ?? 'marketing-db-worker'
    }
    this.onSpawn = options.onSpawn
    this.logger = options.logger
  }

  private onSpawn?: DatabaseClientOptions['onSpawn']
  private logger?: DatabaseClientOptions['logger']

  // ── 只读状态 ────────────────────────────────────────────────────────────────
  get dbPath(): string {
    return this.opts.dbPath
  }

  get isReady(): boolean {
    return this.ready && !!this.child
  }

  get workerPid(): number | null {
    return this.child?.pid ?? null
  }

  get lastExitInfo(): { code: number | null; signal: string | null; at: number } | null {
    return this.lastExit
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 惰性初始化 ──────────────────────────────────────────────────────────────
  /** 确保 Worker 就绪（首次调用才 spawn + 迁移）。可重复调用，共享同一个 Promise */
  async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new AppError(ERROR_CODES.DB_ERROR, 'DatabaseClient 已 dispose，不能继续使用')
    }
    if (this.ready && this.child) return
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.startWorker().catch((e) => {
      this.readyPromise = null
      throw e
    })
    return this.readyPromise
  }

  private async startWorker(): Promise<void> {
    const { nodePath, workerScriptPath, dbPath, backupDir } = this.opts
    // 便携 Node 缺失 = 环境未初始化（§五 SETUP_REQUIRED），绝不阻塞应用启动
    if (!existsSync(nodePath)) {
      throw new AppError(
        ERROR_CODES.SETUP_REQUIRED,
        `未找到便携 Node 运行时（${nodePath}），请先完成环境初始化`,
        { nodePath }
      )
    }
    if (!existsSync(workerScriptPath)) {
      throw new AppError(ERROR_CODES.DB_ERROR, `未找到 DB Worker 脚本（${workerScriptPath}）`, {
        workerScriptPath
      })
    }
    mkdirSync(dirname(dbPath), { recursive: true })
    mkdirSync(backupDir, { recursive: true })

    const child = spawn(nodePath, [workerScriptPath, '--db', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: minimalEnv()
    })
    this.child = child
    this.stdoutBuf = ''
    // migrated 的语义 = 「本个 Worker 会话内刚执行过迁移」，重启后重置
    this.migrated = false

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      if (text) this.log(`[db-worker] ${text}`)
    })
    child.on('error', (err) => {
      this.log(`[db] spawn 失败: ${err.message}`)
      if (this.child === child) this.child = null
      this.ready = false
      this.readyPromise = null
    })
    child.on('exit', (code, signal) => this.handleExit(child, code, signal))

    if (typeof child.pid === 'number') {
      this.unregisterSubprocess =
        this.onSpawn?.({
          name: this.opts.subprocessName,
          pid: child.pid,
          gracefulStop: () => this.shutdown()
        }) ?? null
    }

    try {
      await this.sendRaw('ping', {}, 15_000)
      await this.runMigrations()
    } catch (e) {
      this.ready = false
      this.readyPromise = null
      throw e instanceof AppError
        ? e
        : new AppError(ERROR_CODES.DB_ERROR, `DB Worker 初始化失败: ${errorText(e)}`)
    }
    this.ready = true
    this.log(`[db] ready pid=${child.pid} db=${dbPath}`)
  }

  /** 启动时把 user_version 推到 TARGET_USER_VERSION（DDL 来自 schema.ts） */
  private async runMigrations(): Promise<void> {
    const info = (await this.sendRaw('schema.info', {}, this.opts.requestTimeoutMs)) as {
      userVersion?: number
      tables?: string[]
    }
    const from = Number(info?.userVersion) || 0
    if (from > TARGET_USER_VERSION) {
      throw new AppError(
        ERROR_CODES.DB_ERROR,
        `数据库 user_version=${from} 高于当前应用支持的 ${TARGET_USER_VERSION}，请升级 Umi Claw`,
        { userVersion: from, supported: TARGET_USER_VERSION }
      )
    }
    if (from < TARGET_USER_VERSION) {
      // §四 备份触发时机：Schema 迁移前（已有数据才需要）
      if (from > 0) {
        try {
          const b = await this.backup('pre-migration')
          this.log(`[db] 迁移前快照: ${b.path}`)
        } catch (e) {
          this.log(`[db] 迁移前快照失败（继续迁移）: ${errorText(e)}`)
        }
      }
      const steps = pendingSteps(from).map((s) => ({
        version: s.version,
        name: s.name,
        statements: s.statements
      }))
      const res = (await this.sendRaw(
        'migrate',
        { steps },
        this.opts.requestTimeoutMs * 4
      )) as { to?: number; applied?: Array<{ version: number }> }
      const after = (await this.sendRaw('schema.info', {}, this.opts.requestTimeoutMs)) as {
        userVersion?: number
      }
      if (Number(after?.userVersion) !== TARGET_USER_VERSION) {
        throw new AppError(
          ERROR_CODES.DB_ERROR,
          `迁移后 user_version=${after?.userVersion}，期望 ${TARGET_USER_VERSION}`
        )
      }
      this.migrated = true
      this.log(
        `[db] migrated ${from} -> ${Number(res?.to)} (${(res?.applied ?? [])
          .map((a) => 'v' + a.version)
          .join(',')})`
      )
    } else {
      // 已是最新：按需滚动快照（距上次 >24h），失败不阻断
      void this.maybeAutoBackup()
    }
  }

  private async maybeAutoBackup(): Promise<void> {
    try {
      const files = statusFiles(this.opts.backupDir)
      if (!files.length) return
      let newest = 0
      for (const f of files) {
        try {
          const m = statSync(join(this.opts.backupDir, f)).mtimeMs
          if (m > newest) newest = m
        } catch {
          /* 忽略 */
        }
      }
      if (newest && Date.now() - newest < this.opts.autoBackupIntervalMs) return
      const b = await this.backup('auto')
      this.log(`[db] 滚动快照: ${b.path}`)
    } catch (e) {
      this.log(`[db] 滚动快照失败（忽略）: ${errorText(e)}`)
    }
  }

  // ── 请求 ────────────────────────────────────────────────────────────────────
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    if (typeof method !== 'string' || !method) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'request 需要 method')
    }
    if (options.noInit !== true) {
      await this.ensureReady()
    } else if (!this.ready || !this.child) {
      throw new AppError(ERROR_CODES.DB_ERROR, 'DB Worker 尚未就绪（noInit）')
    }
    const entry: PendingEntry = {
      id: `req-${++this.seq}`,
      method,
      params,
      isRead: isReadMethod(method),
      retryable: options.retryable === true,
      timeoutMs: options.timeoutMs ?? this.opts.requestTimeoutMs,
      attempts: 0,
      resolve: () => undefined,
      reject: () => undefined,
      timer: null
    }
    const promise = new Promise<T>((resolve, reject) => {
      entry.resolve = resolve as (v: unknown) => void
      entry.reject = reject
    })
    this.beginRequest(entry)
    return promise
  }

  /** 不触发 ensureReady 的内部请求（初始化流程专用） */
  private sendRaw(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const entry: PendingEntry = {
      id: `req-${++this.seq}`,
      method,
      params,
      isRead: isReadMethod(method),
      retryable: false,
      timeoutMs,
      attempts: 0,
      resolve: () => undefined,
      reject: () => undefined,
      timer: null
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    this.beginRequest(entry)
    return promise
  }

  private beginRequest(entry: PendingEntry): void {
    entry.attempts += 1
    this.pending.set(entry.id, entry)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (this.pending.delete(entry.id)) {
        entry.reject(
          new AppError(ERROR_CODES.DB_ERROR, `DB 请求超时（${entry.timeoutMs}ms）: ${entry.method}`, {
            reason: 'timeout',
            method: entry.method,
            timeoutMs: entry.timeoutMs
          })
        )
      }
    }, entry.timeoutMs)
    this.writeLine({ id: entry.id, method: entry.method, params: entry.params ?? {} })
  }

  private writeLine(payload: unknown): void {
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) return
    try {
      child.stdin.write(JSON.stringify(payload) + '\n')
    } catch (e) {
      this.log(`[db] 写入 Worker stdin 失败: ${errorText(e)}`)
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: {
        id?: string
        ok?: boolean
        data?: unknown
        error?: { code?: string; message?: string; details?: unknown }
      }
      try {
        msg = JSON.parse(line)
      } catch {
        this.log(`[db] 无法解析 Worker 输出: ${line.slice(0, 200)}`)
        continue
      }
      const entry = msg.id ? this.pending.get(msg.id) : undefined
      if (!entry) {
        // 超时后才回来的响应：忽略（对应 promise 已 reject）
        continue
      }
      this.pending.delete(msg.id as string)
      if (entry.timer) clearTimeout(entry.timer)
      if (msg.ok) {
        this.restartsUsed = 0
        entry.resolve(msg.data === undefined ? null : msg.data)
      } else {
        const code = normalizeCode(msg.error?.code)
        entry.reject(
          new AppError(code, msg.error?.message || `DB 请求失败: ${entry.method}`, msg.error?.details)
        )
      }
    }
  }

  // ── 断线：自动重启一次 + 读重试 / 写不重试 ──────────────────────────────────
  private handleExit(child: ChildProcess, code: number | null, signal: string | null): void {
    const wasCurrent = this.child === child
    if (wasCurrent) {
      this.child = null
      this.ready = false
      this.readyPromise = null
    }
    this.unregisterSubprocess?.()
    this.unregisterSubprocess = null
    if (!wasCurrent) return

    this.lastExit = { code, signal, at: Date.now() }
    const pendings = [...this.pending.values()]
    this.pending.clear()
    for (const p of pendings) if (p.timer) clearTimeout(p.timer)
    if (!pendings.length) {
      this.log(`[db] Worker 退出（code=${code} signal=${signal}），无在途请求`)
      return
    }

    const retriable = pendings.filter((p) => p.isRead || p.retryable)
    const fatal = pendings.filter((p) => !(p.isRead || p.retryable))
    // 写请求默认不自动重试：防重复写入（§四 v1.10）
    for (const p of fatal) {
      p.reject(
        new AppError(
          ERROR_CODES.DB_ERROR,
          `DB Worker 异常退出（code=${code} signal=${signal}），写请求不自动重试: ${p.method}`,
          { method: p.method, code, signal, reason: 'worker-exit-no-retry' }
        )
      )
    }

    const canRestart = this.restartsUsed < MAX_AUTO_RESTARTS_PER_EPISODE
    if (!retriable.length || !canRestart) {
      for (const p of retriable) {
        p.reject(
          new AppError(
            ERROR_CODES.DB_ERROR,
            `DB Worker 异常退出（code=${code} signal=${signal}）: ${p.method}`,
            { method: p.method, code, signal, reason: canRestart ? 'worker-exit' : 'restart-exhausted' }
          )
        )
      }
      return
    }

    this.restartsUsed += 1
    this.log(`[db] Worker 异常退出，自动重启（第 ${this.restartsUsed} 次）后重试 ${retriable.length} 个读请求`)
    this.ensureReady().then(
      () => {
        for (const p of retriable) {
          // 只重试读请求（含显式 retryable 的幂等 upsert）
          this.beginRequest(p)
        }
      },
      (e) => {
        for (const p of retriable) p.reject(e)
      }
    )
  }

  // ── 关闭 ────────────────────────────────────────────────────────────────────
  /** 优雅停止：{ method: 'shutdown' } → wal_checkpoint → close → exit(0)；超时强杀 */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) {
      this.ready = false
      this.readyPromise = null
      return
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve())
    })
    this.ready = false
    this.readyPromise = null
    try {
      child.stdin?.write(JSON.stringify({ id: 'shutdown', method: 'shutdown', params: {} }) + '\n')
    } catch {
      /* stdin 可能已关闭 */
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, this.opts.gracefulStopTimeoutMs)
    await exited
    clearTimeout(timer)
    if (this.child === child) this.child = null
    this.unregisterSubprocess?.()
    this.unregisterSubprocess = null
    this.log('[db] Worker 已优雅退出')
  }

  /** 永久失效（应用退出清理用） */
  async dispose(): Promise<void> {
    this.disposed = true
    const err = new AppError(ERROR_CODES.DB_ERROR, 'DatabaseClient 已关闭')
    const pendings = [...this.pending.values()]
    this.pending.clear()
    for (const p of pendings) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    await this.shutdown()
  }

  // ── 面向上层的小接口（Commit 02 的 marketing.system 面） ────────────────────
  async ping(): Promise<{ pong: boolean; pid: number; ts: number }> {
    return this.request('ping', {}, { timeoutMs: 10_000 })
  }

  async dbStatus(options: { initialize?: boolean } = {}): Promise<DatabaseStatus> {
    const initialize = options.initialize !== false
    if (initialize) {
      await this.ensureReady()
    }
    let info: SchemaInfoRaw | null = null
    if (this.ready && this.child) {
      info = (await this.sendRaw('schema.info', {}, this.opts.requestTimeoutMs)) as SchemaInfoRaw
    }
    return {
      ready: this.isReady,
      dbPath: this.opts.dbPath,
      backupDir: this.opts.backupDir,
      userVersion: info?.userVersion ?? null,
      tables: info?.tables ?? [],
      indexes: info?.indexes ?? [],
      journalMode: info?.journalMode ?? null,
      foreignKeys: info?.foreignKeys ?? null,
      sqliteVersion: info?.sqliteVersion ?? null,
      workerPid: this.workerPid,
      pendingRequests: this.pending.size,
      migrated: this.migrated
    }
  }

  async metaGet(key: string): Promise<string | null> {
    if (typeof key !== 'string' || !key) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'metaGet 需要 key')
    }
    const row = (await this.request<{ value: string | null } | null>('app_meta.get', {
      keys: { key }
    })) as { value?: string | null } | null
    return row ? (row.value ?? null) : null
  }

  async metaSet(key: string, value: string | null): Promise<{ changes: number }> {
    if (typeof key !== 'string' || !key) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'metaSet 需要 key')
    }
    // 预生成主键（key）的 upsert：天然幂等，允许 Worker 崩溃后重试
    const res = (await this.request(
      'app_meta.upsert',
      { data: { key, value: value === null ? null : String(value) } },
      { retryable: true }
    )) as { changes: number }
    return { changes: Number(res?.changes ?? 0) }
  }

  /** VACUUM INTO 在线一致性快照；保留最近 maxBackups 份，超出删最旧 */
  async backup(reason = 'manual'): Promise<BackupResult> {
    await this.ensureReady()
    const target = join(this.opts.backupDir, `umi-claw-${backupStamp()}.db`)
    const res = (await this.request(
      'maintenance.vacuumInto',
      { path: target },
      { timeoutMs: this.opts.requestTimeoutMs * 4 }
    )) as { path: string; size: number }
    const pruned = this.pruneBackups()
    return { path: res?.path ?? target, size: Number(res?.size ?? 0), reason, pruned }
  }

  private pruneBackups(): string[] {
    const pruned: string[] = []
    try {
      const files = statusFiles(this.opts.backupDir).sort() // 文件名含时间戳，字典序 = 时间序
      const overflow = files.length - this.opts.maxBackups
      for (let i = 0; i < overflow; i++) {
        const full = join(this.opts.backupDir, files[i])
        try {
          unlinkSync(full)
          pruned.push(files[i])
          this.log(`[db] 清理旧备份: ${files[i]}`)
        } catch (e) {
          this.log(`[db] 删除旧备份失败 ${files[i]}: ${errorText(e)}`)
        }
      }
    } catch (e) {
      this.log(`[db] 备份保留策略失败: ${errorText(e)}`)
    }
    return pruned
  }
}

function normalizeCode(code: string | undefined): ErrorCode {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    return code as ErrorCode
  }
  return ERROR_CODES.DB_ERROR
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 只透传便携 Node 运行所需的系统变量，不继承主进程全部 env（避免泄漏凭据） */
function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SYSTEMDRIVE: process.env.SYSTEMDRIVE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_OPTIONS: process.env.NODE_OPTIONS
  }
}

// ── 单例（硬规则 8：整个应用只有一个 DB Worker） ──────────────────────────────
let singleton: DatabaseClient | null = null

export function configureDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  if (singleton) return singleton
  singleton = new DatabaseClient(options)
  return singleton
}

export function getDatabaseClient(): DatabaseClient {
  if (!singleton) {
    throw new AppError(ERROR_CODES.DB_ERROR, 'DatabaseClient 尚未配置（请先在主进程 wiring 中调用 configureDatabaseClient）')
  }
  return singleton
}

/** 仅供测试/退出清理：丢弃单例引用 */
export function resetDatabaseClient(): void {
  singleton = null
}
