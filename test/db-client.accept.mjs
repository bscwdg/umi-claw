// test/db-client.accept.mjs —— Commit 02 验收（客户端半边）
//
// **打真实源码**：用 vite 自带的 node_modules/.bin/esbuild 把
// electron/main/database/database.ts bundle 成临时 ESM，在纯 Node 里 import 并注入依赖。
// 刻意「不抄一份客户端逻辑」，因此这里验证的正是生产代码路径。
//
// 覆盖：惰性初始化 / 单例（一个 worker 进程）/ 断线自动重启一次 / 读自动重试 /
//       写默认不重试 / 显式 retryable 的幂等 upsert 可重试 / 30s 超时 /
//       SETUP_REQUIRED / dbStatus / backup(VACUUM INTO + 保留 5 份) / shutdown 后数据仍在
//
// 用法：node test/db-client.accept.mjs

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, `client-${Date.now()}`)
const dbPath = join(runDir, 'umi-claw.db')
const backupDir = join(runDir, 'backup')
const altDir = join(runDir, 'alt')
mkdirSync(runDir, { recursive: true })

const bundledPath = bundleEntry('electron/main/database/database.ts', 'database.mjs')
const registryPath = bundleEntry('electron/main/subprocessRegistry.ts', 'subprocessRegistry.mjs')
const mod = await import(pathToFileURL(bundledPath).href)
const registryMod = await import(pathToFileURL(registryPath).href)
const DatabaseClient = mod.DatabaseClient
const subprocessRegistry = registryMod.subprocessRegistry
const clients = new Set()

function makeClient(overrides = {}) {
  const client = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'work-db-worker-test',
    requestTimeoutMs: 30_000,
    ...overrides
  })
  clients.add(client)
  return client
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    throw new Error(`kill(${pid}) 失败: ${e.message}`)
  }
}

/**
 * 数一数真实存在的 worker 进程数（Windows 用 CIM 按命令行精确匹配本次 db 路径）
 *
 * ⚠️ 2026-09-16 复审 P1：受限环境（拿不到 WMI 权限、沙箱）下 CIM 会「拒绝访问」，
 * 那是环境问题，不能当成「多起了一个 Worker」的功能回归。
 * 坑：Get-CimInstance 的 0x80041003 是**非终止错误**，管道照样吐出 0、exit=0，
 * 故必须 $ErrorActionPreference='Stop' + try/catch，把失败显式变成空输出；
 * 查询不可靠时一律返回 null（不可知），由调用方降级成 PID 判活。
 */
function countWorkerProcesses() {
  if (process.platform !== 'win32') return null
  const needle = dbPath.replace(/'/g, "''")
  const ps =
    `$ErrorActionPreference='Stop'; try { ` +
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${needle}*' } | Measure-Object).Count ` +
    `} catch { '' }`
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf-8',
    windowsHide: true
  })
  const text = String(out.stdout || '').trim()
  const n = parseInt(text, 10)
  if (out.error || out.status !== 0 || text === '' || !Number.isFinite(n)) return null
  return n
}

/** 进程判活：不依赖 WMI，权限无关（ESRCH=不存在；EPERM=存在但无权限） */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

/** 等 pid 真的消失（给 OS 回收时间），返回是否已消失 */
async function waitPidGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await sleep(100)
  }
  return !isPidAlive(pid)
}

function direct(dbFile, fn) {
  const db = new DatabaseSync(dbFile)
  try {
    return fn(db)
  } finally {
    try {
      db.close()
    } catch {
      /* 忽略 */
    }
  }
}

const r = new Recorder('db-client（客户端半边，打真 database.ts）')
let main = null

try {
  // ── C1 bundle 出来的是真源码（不含 electron 顶层 import） ──
  await r.check('C1', 'database.ts 可纯 Node import（依赖注入，无 electron 顶层引用）', async () => {
    assert(typeof DatabaseClient === 'function', '应导出 DatabaseClient')
    const src = (await import('node:fs')).readFileSync(bundledPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(src), 'bundle 内不应存在 electron import')
    return `bundle=${bundledPath.replace(/^.*[\\/]/, '')} size=${statSync(bundledPath).size}B`
  })

  // ── C2 惰性初始化 ──
  await r.check('C2', '惰性初始化：构造不建库、不拉 Worker', async () => {
    main = makeClient()
    assertEq(main.isReady, false, '构造后不应 ready')
    assertEq(main.workerPid, null, '构造后不应有 worker 进程')
    assert(!existsSync(dbPath), '构造后不应创建数据库文件')
    const st = await main.dbStatus({ initialize: false })
    assertEq(st.ready, false, '不初始化时 ready=false')
    assertEq(st.userVersion, null, '不初始化时 userVersion=null')
    assert(!existsSync(dbPath), 'dbStatus({initialize:false}) 不应建库')
    return `dbExists=${existsSync(dbPath)}`
  })

  // ── C3 首次请求拉起 worker 并建库 ──
  await r.check('C3', '首次请求拉起 worker → 建库 + user_version=1 + 8 表', async () => {
    const pong = await main.ping()
    assertEq(pong.pong, true, 'ping 应成功')
    assert(existsSync(dbPath), '首次请求后应建库')
    const st = await main.dbStatus()
    assertEq(st.ready, true, 'ready 应为 true')
    assertEq(st.userVersion, 1, 'user_version 应为 1')
    assertEq(st.tables.length, 8, `应有 8 张表（硬规则 24，实际 ${st.tables.length}）`)
    assert(st.tables.includes('app_meta'), '应含 app_meta')
    assertEq(st.journalMode, 'wal', 'journal_mode 应为 wal')
    assertEq(st.foreignKeys, true, 'foreign_keys 应为 ON')
    assertEq(st.migrated, true, '本次应执行过迁移')
    return `pid=${st.workerPid} tables=${st.tables.length} uv=${st.userVersion} wal=${st.journalMode}`
  })

  // ── C4 单例：连续 20 次调用只存在一个 worker 进程 ──
  await r.check('C4', '单例（硬规则 8）：连续 20 次调用只存在一个 node 子进程', async () => {
    const pid0 = main.workerPid
    for (let i = 0; i < 20; i++) {
      const res = await main.request('app_meta.upsert', {
        data: { key: `singleton_${i}`, value: String(i) }
      })
      assertEq(res.changes >= 0, true, `第 ${i} 次写入应成功`)
    }
    const cnt = await main.request('app_meta.count', { where: { key: `singleton_0` } })
    assertEq(cnt.count, 1, '写入应落库')
    assertEq(main.workerPid, pid0, 'worker pid 应保持不变（没有反复 spawn）')
    const live = countWorkerProcesses()
    if (live === null) {
      assert(isPidAlive(pid0), 'CIM 不可用，降级 PID 判活：worker 应仍活着')
      return `pid=${pid0} 20 次调用后 pid 未变；OS 进程数不可知（本环境 CIM 不可用，已降级 PID 判活）`
    }
    assertEq(live, 1, `OS 层应只有 1 个 worker 进程（实际 ${live}）`)
    return `pid=${pid0} 20 次调用后 OS 进程数=${live}`
  })

  // ── C5 断线自动重启 + 读重试 / 写不重试 ──
  await r.check('C5', '断线自动重启一次：读自动重试成功，写不自动重试（DB_ERROR）', async () => {
    const now = Date.now()
    await main.request('matters.upsert', {
      data: { id: 'pc1', name: '压测事项', created_at: now, updated_at: now }
    })
    const pidBefore = main.workerPid

    // 用独立连接持有 WAL 写锁：worker 是单线程同步执行，写请求会卡在 busy_timeout 里，
    // 后续读请求虽已发出但无法被处理 → 制造真正「在途」的请求（确定性，不靠竞态）
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 200')
    blocker.exec('BEGIN IMMEDIATE')

    const writeP = main.request('matters.upsert', {
      data: { id: 'pc2', name: '写不重试', created_at: now, updated_at: now }
    })
    await sleep(200)
    const readP = main.request('matters.list', {})
    await sleep(200)

    killPid(pidBefore)
    try {
      blocker.exec('ROLLBACK')
    } catch {
      /* 忽略 */
    }
    blocker.close()

    const writeOutcome = await writeP.then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code, reason: e.details && e.details.reason })
    )
    assertEq(writeOutcome.ok, false, '写请求不应自动重试')
    assertEq(writeOutcome.code, 'DB_ERROR', '写请求应回 DB_ERROR')

    const readOutcome = await readP.then(
      (v) => ({ ok: true, n: Array.isArray(v) ? v.length : -1 }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(readOutcome.ok, true, '读请求应自动重试成功: ' + JSON.stringify(readOutcome))
    assert(readOutcome.n >= 1, '重试后的读应拿到数据')

    const pidAfter = main.workerPid
    assert(pidAfter !== null && pidAfter !== pidBefore, '应已自动重启（pid 变化）')
    assertEq(main.lastExitInfo !== null, true, '应记录到 worker 异常退出')
    const live = countWorkerProcesses()
    if (live === null) {
      assert(isPidAlive(pidAfter), 'CIM 不可用，降级 PID 判活：重启后的 worker 应活着')
    } else {
      assertEq(live, 1, `重启后仍应只有 1 个 worker 进程（实际 ${live}）`)
    }
    return `pid ${pidBefore} → ${pidAfter}；写=${writeOutcome.code}(reason=${writeOutcome.reason})，读重试成功(${readOutcome.n} 行)`
  })

  // ── C6 显式 retryable 的幂等 upsert 可重试 ──
  await r.check('C6', '例外：预生成主键的 upsert（metaSet）崩溃后可安全重试', async () => {
    const pidBefore = main.workerPid
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 200')
    blocker.exec('BEGIN IMMEDIATE')
    const p = main.metaSet('retry_probe', 'ok')
    await sleep(250)
    killPid(pidBefore)
    try {
      blocker.exec('ROLLBACK')
    } catch {
      /* 忽略 */
    }
    blocker.close()
    const res = await p.then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, code: e.code, reason: e.details && e.details.reason })
    )
    assertEq(res.ok, true, 'retryable 的 upsert 应重试成功: ' + JSON.stringify(res))
    const value = await main.metaGet('retry_probe')
    assertEq(value, 'ok', '重试后应真正落库')
    assert(main.workerPid !== pidBefore, '应已自动重启')
    return `retry_probe=${value} pid=${main.workerPid}`
  })

  // ── C7 超时（30s 默认；此处注入 600ms 验证语义） ──
  await r.check('C7', '请求超时语义（默认 30s，注入 600ms 验证）→ DB_ERROR/reason=timeout', async () => {
    const db2 = join(altDir, 'timeout.db')
    const client2 = makeClient({ dbPath: db2, backupDir: join(altDir, 'backup'), requestTimeoutMs: 600 })
    await client2.ping()
    const blocker = new DatabaseSync(db2)
    blocker.exec('PRAGMA busy_timeout = 200')
    blocker.exec('BEGIN IMMEDIATE')
    const outcome = await client2
      .request('app_meta.upsert', { data: { key: 'slow', value: '1' } })
      .then(
        () => ({ ok: true }),
        (e) => ({ ok: false, code: e.code, reason: e.details && e.details.reason, msg: e.message })
      )
    try {
      blocker.exec('ROLLBACK')
    } catch {
      /* 忽略 */
    }
    blocker.close()
    assertEq(outcome.ok, false, '应超时失败')
    assertEq(outcome.code, 'DB_ERROR', '超时应回 DB_ERROR')
    assertEq(outcome.reason, 'timeout', 'details.reason 应为 timeout')
    assert(/600ms/.test(outcome.msg), 'message 应含超时毫秒数')
    await client2.shutdown()
    clients.delete(client2)
    return outcome.msg
  })

  // ── C8 SETUP_REQUIRED ──
  await r.check('C8', '便携 Node 缺失 → SETUP_REQUIRED（不建库、不阻塞）', async () => {
    const bogusDir = join(altDir, 'setup')
    const client = makeClient({
      dbPath: join(bogusDir, 'umi-claw.db'),
      backupDir: join(bogusDir, 'backup'),
      nodePath: join(bogusDir, 'runtime', 'node-win32-x64', 'node.exe')
    })
    const st = await client.dbStatus().then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, code: e.code, details: e.details })
    )
    assertEq(st.ok, false, 'dbStatus 应失败')
    assertEq(st.code, 'SETUP_REQUIRED', '错误码应为 SETUP_REQUIRED')
    assert(st.details && typeof st.details.nodePath === 'string', 'details 应带 nodePath')
    const ping = await client.ping().then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(ping.code, 'SETUP_REQUIRED', 'ping 也应回 SETUP_REQUIRED')
    assert(!existsSync(join(bogusDir, 'umi-claw.db')), '未初始化时不应创建库文件')
    clients.delete(client)
    return `code=${st.code} message=${String(st.details && st.details.nodePath).replace(/^.*[\\/]/, '')}`
  })

  // ── C9 backup：VACUUM INTO + 保留最近 5 份 ──
  await r.check('C9', 'backup() VACUUM INTO + 保留最近 5 份（超出删最旧）', async () => {
    const first = await main.backup('manual-1')
    assert(existsSync(first.path), '备份文件应存在')
    assert(first.size > 0, '备份不应为空')
    const okDb = direct(first.path, (db) => db.prepare('PRAGMA integrity_check').get().integrity_check)
    assertEq(okDb, 'ok', '备份库应完整可用')
    for (let i = 2; i <= 7; i++) {
      await main.backup(`manual-${i}`)
      await sleep(3)
    }
    const files = readdirSync(backupDir).filter((f) => /^umi-claw-.*\.db$/.test(f)).sort()
    assertEq(files.length, 5, `应只保留 5 份（实际 ${files.length}: ${files.join(',')}）`)
    assert(!files.includes(first.path.replace(/^.*[\\/]/, '')), '最旧的一份应被清理')
    // 快照里的数据是完整库
    const snap = direct(join(backupDir, files[files.length - 1]), (db) =>
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='matters'").get().c
    )
    assertEq(snap, 1, '快照应含 matters 表')
    return `保留 ${files.length} 份，最新=${files[files.length - 1]}`
  })

  // ── C10 shutdown 优雅退出 → 再请求自动重新拉起，数据仍在 ──
  await r.check('C10', 'shutdown 优雅退出；再次请求自动拉起且数据仍在', async () => {
    const pidBefore = main.workerPid
    await main.metaSet('persist_probe', 'v1')
    await main.shutdown()
    assertEq(main.workerPid, null, 'shutdown 后不应有 worker')
    assertEq(main.isReady, false, 'shutdown 后 ready=false')
    const back = await main.metaGet('persist_probe')
    assertEq(back, 'v1', '重启后数据应仍在')
    assert(main.workerPid !== null && main.workerPid !== pidBefore, '应重新拉起新 worker')
    const st = await main.dbStatus()
    assertEq(st.userVersion, 1, '重启后 user_version 仍为 1')
    assertEq(st.migrated, false, '重启不应再触发迁移')
    return `pid ${pidBefore} → ${main.workerPid}，persist_probe=${back}`
  })

  // ── C11 所有失败都带 §五 错误码 ──
  await r.check('C11', '失败信封 code 全部落在 §五 错误码表内', async () => {
    const allowed = new Set([
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'DB_ERROR',
      'SETUP_REQUIRED',
      'OPENCLAW_NOT_READY',
      'OPENCLAW_TIMEOUT',
      'OPENCLAW_AUTH_ERROR',
      'FILE_NOT_FOUND',
      'FILE_PARSE_ERROR'
    ])
    const bad = await main.request('app_meta.get', { keys: {} }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(bad.ok, false, '缺主键应失败')
    assert(allowed.has(bad.code), `错误码应来自 §14.2: ${bad.code}`)
    const nf = await main.request('matters.get', { keys: { id: 'ghost' }, required: true }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(nf.code, 'NOT_FOUND', 'missing row 应为 NOT_FOUND')
    return `code=${bad.code} / ${nf.code}`
  })
  // ── C12 注册表接入（真 subprocessRegistry.ts + onSpawn 契约） ──
  await r.check('C12', '子进程注册表接入：启动即注册，gracefulStop 走优雅退出', async () => {
    assertEq(typeof subprocessRegistry.register, 'function', 'subprocessRegistry 应可用')
    const regClient = makeClient({ dbPath: join(altDir, 'registry.db'), backupDir: join(altDir, 'reg-backup') })
    const wired = new DatabaseClient({
      dbPath: join(altDir, 'registry.db'),
      backupDir: join(altDir, 'reg-backup'),
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker',
      onSpawn: (info) => subprocessRegistry.register(info)
    })
    clients.add(wired)
    await wired.ping()
    const list = subprocessRegistry.list()
    assertEq(list.length, 1, '启动后注册表应有 1 个条目')
    assertEq(list[0].name, 'work-db-worker', '注册名应对')
    assertEq(list[0].pid, wired.workerPid, '注册 pid 应等于 worker pid')
    assertEq(typeof list[0].gracefulStop, 'function', '应提供 gracefulStop')
    const stops = await subprocessRegistry.stopAll(3000)
    assertEq(stops.length, 1, 'stopAll 应处理 1 个条目')
    assertEq(stops[0].ok, true, `优雅停止应成功: ${stops[0].error || ''}`)
    assertEq(wired.isReady, false, '优雅停止后客户端应变为未就绪')
    assertEq(subprocessRegistry.size, 0, '退出后应反注册')
    const back = await wired.ping()
    assertEq(back.pong, true, '再次请求应重新拉起')
    assertEq(subprocessRegistry.size, 1, '重新拉起后应重新注册')
    await regClient.dispose()
    clients.delete(regClient)
    await wired.dispose()
    clients.delete(wired)
    return `注册/优雅停止/反注册/重新注册 全链路通过（pid=${list[0].pid}）`
  })

  // ── C13 初始化失败不得留下游离 Worker（2026-09-16 复审 P2 回归） ──
  await r.check('C13', '初始化失败回收 Worker：不留游离进程、可安全重试', async () => {
    const badDir = join(altDir, 'badver')
    mkdirSync(badDir, { recursive: true })
    const badDb = join(badDir, 'umi-claw.db')
    // 造一个 user_version 高于应用支持值的库：ping 会成功，迁移前置校验抛错 →
    // 精确覆盖「spawn 成功但初始化失败」这条路径
    direct(badDb, (db) => db.exec('PRAGMA user_version = 99'))

    const spawned = []
    let unregistered = 0
    const client = new DatabaseClient({
      dbPath: badDb,
      backupDir: join(badDir, 'backup'),
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-badver',
      onSpawn: (info) => {
        spawned.push(info.pid)
        return () => {
          unregistered += 1
        }
      }
    })
    clients.add(client)

    const outcome = await client.dbStatus({ initialize: true }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(outcome.ok, false, 'user_version 过高应导致初始化失败')
    assertEq(outcome.code, 'DB_ERROR', '错误码应为 DB_ERROR')
    assertEq(spawned.length, 1, '应 spawn 过 1 个 Worker')
    assertEq(client.workerPid, null, '失败后客户端不应再持有 child')
    assertEq(client.isReady, false, '失败后不应 ready')
    assertEq(unregistered, 1, '应反注册（注册表不留死条目）')
    assertEq(await waitPidGone(spawned[0]), true, `失败后不得留下游离 Worker（pid=${spawned[0]}）`)

    // 可重试：再次请求仍是同一个错误码，且每次失败都要回收
    const again = await client.ping().then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    )
    assertEq(again.ok, false, '重试仍应失败')
    for (const pid of spawned) {
      assertEq(await waitPidGone(pid), true, `每次失败都应回收（pid=${pid} 仍活着）`)
    }
    assertEq(client.workerPid, null, '重试失败后同样不应持有 child')
    clients.delete(client)
    await client.dispose().catch(() => {})
    return `spawned=${spawned.length} 全部已回收；code=${outcome.code} unregistered=${unregistered}`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const c of [...clients]) {
    try {
      await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
}

const result = r.toJSON({ bundle: bundledPath, nodePath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-client.json'), result)
console.log('结果已写入 test/accept-result-client.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
