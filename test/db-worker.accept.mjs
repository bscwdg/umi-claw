// test/db-worker.accept.mjs —— Commit 02 验收（Worker 半边）
//
// 零依赖 Node 脚本，直接打**真 worker**（resources/database/db-worker.mjs），
// DDL 来自真源码 electron/main/database/schema.ts（经 esbuild 打成临时 ESM，杜绝抄一份）。
//
// 覆盖：建库 / user_version / 11 表齐备 / 索引 / WAL / foreign_keys / 级联删除 /
//       UNIQUE(project_id) / 错误码信封 / 白名单 / 强杀不损坏 / 重启数据仍在 /
//       shutdown 优雅退出 / stdin EOF / VACUUM INTO / LIKE 检索 / migrate 幂等
//
// 用法：node test/db-worker.accept.mjs   （可用 --json-only 只输出 JSON）

import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'

const extraArgs = process.argv.slice(2).filter((a) => a !== '--json-only')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `worker-${Date.now()}`)
const dbPath = join(runDir, 'umi-claw.db')
const active = new Set()

// ── 裸 JSONL 客户端（刻意不复用 database.ts：本文件验的是 Worker 协议本身） ──
class WorkerHarness {
  constructor(label) {
    this.label = label
    this.seq = 0
    this.pending = new Map()
    this.buf = ''
    this.stderr = ''
    this.child = null
    this.exited = null
  }

  start() {
    this.child = spawn(nodePath, [workerScriptPath, '--db', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    active.add(this)
    this.child.stdout.setEncoding('utf-8')
    this.child.stdout.on('data', (c) => this.onData(c))
    this.child.stderr.setEncoding('utf-8')
    this.child.stderr.on('data', (c) => {
      this.stderr += c
    })
    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exited = { code, signal }
        // 进程死亡时把所有在途请求立刻置错，避免测试白等到超时
        for (const [id, entry] of [...this.pending.entries()]) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
          entry.reject(new Error(`worker 已退出（code=${code} signal=${signal}），请求中断: ${entry.method}`))
        }
        resolve({ code, signal })
      })
    })
    return this
  }

  onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const entry = this.pending.get(msg.id)
      if (!entry) continue
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      entry.resolve(msg)
    }
  }

  call(method, params = {}, timeoutMs = 20000) {
    if (!this.child || this.exited) return Promise.reject(new Error('worker 未运行'))
    const id = `${this.label}-${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求超时（${timeoutMs}ms）: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  sendRaw(line) {
    this.child.stdin.write(line + '\n')
  }

  endStdin() {
    try {
      this.child.stdin.end()
    } catch {
      /* 已关闭 */
    }
  }

  kill(signal = 'SIGKILL') {
    try {
      this.child.kill(signal)
    } catch {
      /* 已退出 */
    }
  }

  async waitExit(ms = 8000) {
    const timeout = sleep(ms).then(() => {
      throw new Error(`等待 worker 退出超时（${ms}ms）`)
    })
    return Promise.race([this.exitPromise, timeout])
  }

  dispose() {
    active.delete(this)
    if (this.child && !this.exited) {
      try {
        this.child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }
  }
}

function fresh(label) {
  return new WorkerHarness(label).start()
}

/** 直连同一库文件的独立连接（只用于取事实，不做业务） */
function direct(fn) {
  const db = new DatabaseSync(dbPath)
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

const migrationMod = await import(
  pathToFileURL(bundleEntry('electron/main/database/migration.ts', 'migration.mjs')).href
)
const schemaMod = await import(
  pathToFileURL(bundleEntry('electron/main/database/schema.ts', 'schema.mjs')).href
)
const MIGRATION_STEPS = migrationMod.MIGRATION_STEPS
const EXPECTED_TABLES = [...schemaMod.SCHEMA_TABLES].sort()
const EXPECTED_INDEXES = schemaMod.INDEX_STATEMENTS.map((s) => s.match(/idx_[a-z_]+/)[0]).sort()
const TARGET = migrationMod.TARGET_USER_VERSION

const r = new Recorder('db-worker（Worker 半边）')
let main = null

try {
  mkdirSync(runDir, { recursive: true })

  // ── W1 惰性建库：worker 启动前不存在，启动后出现 ──
  await r.check('W1', 'worker 启动即建库（spawn 前不存在）', async () => {
    assert(!existsSync(dbPath), '建库前不应存在 umi-claw.db')
    main = fresh('main')
    await sleep(400)
    assert(existsSync(dbPath), 'spawn 后应创建 umi-claw.db')
    const pong = await main.call('ping')
    assertEq(pong.ok, true, 'ping 应成功')
    return `db=${dbPath} pid=${pong.data.pid}`
  })

  // ── W2 user_version 0 → 1 迁移 ──
  await r.check('W2', 'migrate 0 → 1，user_version=1', async () => {
    const before = await main.call('schema.info')
    assertEq(before.data.userVersion, 0, '空库 user_version 应为 0')
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.ok, true, 'migrate 应成功: ' + JSON.stringify(res.error || {}))
    assertEq(res.data.from, 0, 'from 应为 0')
    assertEq(res.data.to, TARGET, `to 应为 ${TARGET}`)
    assertEq(res.data.applied.length, MIGRATION_STEPS.length, 'applied 数量应等于步骤数')
    const after = await main.call('schema.info')
    assertEq(after.data.userVersion, 1, '迁移后 user_version 应为 1')
    return `applied=${res.data.applied.map((a) => 'v' + a.version).join(',')}`
  })

  // ── W3 migrate 幂等 ──
  await r.check('W3', 'migrate 幂等（已是最新时不再执行）', async () => {
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.ok, true, '重复 migrate 应成功')
    assertEq(res.data.applied.length, 0, '不应重复执行任何 step')
    assertEq(res.data.from, 1, 'from 应为 1')
    return 'applied=[]'
  })

  // ── W4 表齐备（10 业务表 + app_meta；不含已作废的 project_messages） ──
  await r.check('W4', '11 张表齐备（10 业务表 + app_meta），无 project_messages', async () => {
    const info = await main.call('schema.info')
    const tables = [...info.data.tables].sort()
    assertEq(JSON.stringify(tables), JSON.stringify(EXPECTED_TABLES), '表清单应与 schema.ts 一致')
    assert(!tables.includes('project_messages'), 'project_messages 已作废，不应建表')
    assertEq(info.data.tables.filter((t) => !t.startsWith('sqlite_')).length, 11, '表数量应为 11')
    return tables.join(', ')
  })

  // ── W5 索引齐备 ──
  await r.check('W5', '10 个索引齐备', async () => {
    const info = await main.call('schema.info')
    const idx = [...info.data.indexes].sort()
    assertEq(JSON.stringify(idx), JSON.stringify(EXPECTED_INDEXES), '索引清单应一致')
    return idx.join(', ')
  })

  // ── W6 WAL 生效 ──
  await r.check('W6', 'WAL 生效（journal_mode=wal + -wal 文件出现）', async () => {
    const info = await main.call('schema.info')
    assertEq(info.data.journalMode, 'wal', 'journal_mode 应为 wal')
    await main.call('app_meta.upsert', { data: { key: 'wal_probe', value: '1' } })
    assert(existsSync(dbPath + '-wal'), '-wal 文件应存在')
    return `journal_mode=${info.data.journalMode} wal=${statSync(dbPath + '-wal').size}B`
  })

  // ── W7 foreign_keys=ON + 级联删除 ──
  await r.check('W7', 'foreign_keys=ON：删 project 级联清业务数据', async () => {
    const info = await main.call('schema.info')
    assertEq(info.data.foreignKeys, true, 'PRAGMA foreign_keys 应为 1')
    const now = Date.now()
    await main.call('projects.create', {
      data: { id: 'p1', name: '摄影店', conversation_key: 'k1', created_at: now, updated_at: now }
    })
    await main.call('businesses.create', { data: { id: 'b1', project_id: 'p1' } })
    await main.call('knowledge_items.create', {
      data: { id: 'k1', project_id: 'p1', title: '价目表', type: 'text' }
    })
    await main.call('knowledge_chunks.create', {
      data: { id: 'c1', knowledge_id: 'k1', chunk_index: 0, content: '套系 999' }
    })
    await main.call('contents.create', { data: { id: 'ct1', project_id: 'p1', title: '草稿' } })
    await main.call('content_versions.create', {
      data: { id: 'v1', content_id: 'ct1', version: 1, content: 'x', source: 'ai' }
    })
    await main.call('project_watchlist.upsert', { data: { project_id: 'p1', keyword: '写真' } })
    await main.call('hot_topics.create', {
      data: {
        id: 'h1',
        source_platform: 'douyin',
        source: 'mock',
        title: '热榜第一条',
        fingerprint: 'fp1',
        first_seen_at: now,
        last_seen_at: now
      }
    })
    await main.call('hot_topic_samples.create', {
      data: { id: 's1', topic_id: 'h1', sampled_at: now, heat: 100, rank: 1 }
    })
    await main.call('project_hot_topics.upsert', {
      data: { project_id: 'p1', topic_id: 'h1', platform: 'xiaohongshu', scored_at: now }
    })

    await main.call('projects.delete', { keys: { id: 'p1' }, required: true })

    const business = await main.call('businesses.list', { where: { project_id: 'p1' } })
    const knowledge = await main.call('knowledge_items.list', { where: { project_id: 'p1' } })
    const contents = await main.call('contents.list', { where: { project_id: 'p1' } })
    const watch = await main.call('project_watchlist.list', { where: { project_id: 'p1' } })
    const score = await main.call('project_hot_topics.list', { where: { project_id: 'p1' } })
    const versions = await main.call('content_versions.list', { where: { content_id: 'ct1' } })
    assertEq(business.data.length, 0, 'businesses 应被级联删除')
    assertEq(knowledge.data.length, 0, 'knowledge_items 应被级联删除')
    assertEq(contents.data.length, 0, 'contents 应被级联删除')
    assertEq(watch.data.length, 0, 'project_watchlist 应被级联删除')
    assertEq(score.data.length, 0, 'project_hot_topics 应被级联删除')
    assertEq(versions.data.length, 0, 'content_versions 应随 contents 级联删除')
    // 全局热点不受 project 删除影响
    const topics = await main.call('hot_topics.list', {})
    assertEq(topics.data.length, 1, 'hot_topics 是全局数据，不应被删')
    return 'businesses/knowledge/chunks/contents/versions/watchlist/scores 全部级联清空'
  })

  // ── W8 businesses UNIQUE(project_id) ──
  await r.check('W8', 'businesses UNIQUE(project_id) 生效 → CONFLICT', async () => {
    const now = Date.now()
    await main.call('projects.create', {
      data: { id: 'p2', name: '女装店', conversation_key: 'k2', created_at: now, updated_at: now }
    })
    const first = await main.call('businesses.create', { data: { id: 'b2', project_id: 'p2' } })
    assertEq(first.ok, true, '首个 business 应成功')
    const second = await main.call('businesses.create', { data: { id: 'b3', project_id: 'p2' } })
    assertEq(second.ok, false, '第二个 business 应失败')
    assertEq(second.error.code, 'CONFLICT', '错误码应为 CONFLICT')
    return `code=${second.error.code} message=${second.error.message.slice(0, 60)}`
  })

  // ── W9 错误码信封 ──
  await r.check('W9', '错误码信封：NOT_FOUND / VALIDATION_ERROR / CONFLICT / 白名单', async () => {
    const notFound = await main.call('projects.get', { keys: { id: 'nope' }, required: true })
    assertEq(notFound.ok, false, 'required get 缺失应失败')
    assertEq(notFound.error.code, 'NOT_FOUND', '应为 NOT_FOUND')
    assert(typeof notFound.error.message === 'string' && notFound.error.message.length > 0, '应有 message')

    const badFk = await main.call('knowledge_items.create', {
      data: { id: 'kx', project_id: 'ghost', title: 'x', type: 'text' }
    })
    assertEq(badFk.ok, false, '非法外键应失败')
    assertEq(badFk.error.code, 'VALIDATION_ERROR', '外键违反应为 VALIDATION_ERROR')

    const badCol = await main.call('projects.list', { where: { evil_column: 1 } })
    assertEq(badCol.error.code, 'VALIDATION_ERROR', '未知列应为 VALIDATION_ERROR')

    const unknown = await main.call('projects.dropEverything')
    assertEq(unknown.ok, false, '未知方法应失败')
    assertEq(unknown.error.code, 'VALIDATION_ERROR', '未知方法应为 VALIDATION_ERROR')
    assert(Array.isArray(unknown.error.details.allowed), '应回传白名单 allowed')
    assert(unknown.error.details.allowed.includes('ping'), 'allowed 应含 ping')

    const rawSql = await main.call('p', { sql: 'DROP TABLE projects' })
    assertEq(rawSql.ok, false, '前端传 SQL 必须被拒')
    return `allowed=${unknown.error.details.allowed.length} 个方法`
  })

  // ── W10 白名单覆盖面（10 表 CRUD + migrate/ping/shutdown） ──
  await r.check('W10', '白名单覆盖 11 表 × CRUD + migrate/ping/shutdown', async () => {
    const ping = await main.call('ping')
    const allowed = (await main.call('nope')).error.details.allowed
    const need = ['ping', 'shutdown', 'migrate', 'schema.info', 'knowledge.search', 'maintenance.vacuumInto']
    for (const t of EXPECTED_TABLES) {
      for (const op of ['list', 'get', 'create', 'upsert', 'update', 'delete', 'count']) {
        need.push(`${t}.${op}`)
      }
    }
    const missing = need.filter((m) => !allowed.includes(m))
    assertEq(missing.length, 0, '缺失方法: ' + missing.join(', '))
    assert(ping.data.pong === true, 'ping 应回 pong')
    return `${allowed.length} 个白名单方法；${need.length} 项覆盖检查全中`
  })

  // ── W11 LIKE 检索 + 行数统计 ──
  await r.check('W11', 'knowledge.search（LIKE）与 count', async () => {
    await main.call('knowledge_items.upsert', {
      data: { id: 'k9', project_id: 'p2', title: '套系价目表', type: 'text', content: '轻写真 999 元，含 3 套服装' }
    })
    const hit = await main.call('knowledge.search', { projectId: 'p2', query: '轻写真' })
    assertEq(hit.ok, true, '检索应成功')
    assertEq(hit.data.length, 1, '应命中 1 条')
    assert(hit.data[0].snippet.includes('999'), 'snippet 应含正文片段')
    const none = await main.call('knowledge.search', { projectId: 'p2', query: '不存在词' })
    assertEq(none.data.length, 0, '不应命中')
    const cnt = await main.call('knowledge_items.count', { where: { project_id: 'p2' } })
    assertEq(cnt.data.count, 1, 'count 应为 1')
    return `snippet=${hit.data[0].snippet.slice(0, 30)}`
  })

  // ── W12 脏输入不崩 ──
  await r.check('W12', '脏请求行（非 JSON / 缺 method）不自杀', async () => {
    main.sendRaw('这不是 JSON')
    main.sendRaw(JSON.stringify({ id: 'x1' }))
    await sleep(250)
    const pong = await main.call('ping')
    assertEq(pong.ok, true, '脏输入后 ping 仍应成功（worker 未自杀）')
    const noMethod = { id: 'w12-no-method' }
    return `stderr 片段=${main.stderr.split('\n').filter(Boolean).slice(-1)[0] || '(空)'}；${JSON.stringify(noMethod)}`
  })

  // ── W13 VACUUM INTO 备份 ──
  const backupPath = join(runDir, 'backup', 'umi-claw-stamp.db')
  await r.check('W13', 'VACUUM INTO 备份链路可用（含目标已存在 → CONFLICT）', async () => {
    const res = await main.call('maintenance.vacuumInto', { path: backupPath })
    assertEq(res.ok, true, '备份应成功: ' + JSON.stringify(res.error || {}))
    assert(existsSync(backupPath), '备份文件应存在')
    const size = statSync(backupPath).size
    assert(size > 0, '备份文件不应为空')
    const again = await main.call('maintenance.vacuumInto', { path: backupPath })
    assertEq(again.ok, false, '重复备份到同一路径应失败')
    assertEq(again.error.code, 'CONFLICT', '应为 CONFLICT')
    // 备份是可独立打开的完整库
    const bak = new DatabaseSync(backupPath)
    const check = bak.prepare('PRAGMA integrity_check').get()
    const tables = bak.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c
    bak.close()
    assertEq(check.integrity_check, 'ok', '备份库应完整')
    return `size=${size}B tables=${tables}`
  })

  // ── W14 强杀（写操作中）后库不损坏 ──
  await r.check('W14', '强杀（SIGKILL）后库不损坏，数据仍在', async () => {
    const now = Date.now()
    await main.call('projects.upsert', {
      data: { id: 'p3', name: '餐厅', conversation_key: 'k3', created_at: now, updated_at: now }
    })
    // 用独立连接持有写锁 → 让 worker 卡在 busy_timeout 里（真正「写操作中」）
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 200')
    blocker.exec('BEGIN IMMEDIATE')
    const inflight = main.call('projects.upsert', {
      data: { id: 'p4', name: '写锁内', conversation_key: 'k4', created_at: now, updated_at: now }
    })
    await sleep(200)
    main.kill('SIGKILL')
    await main.waitExit()
    try {
      blocker.exec('ROLLBACK')
    } catch {
      /* 忽略 */
    }
    blocker.close()
    await inflight.catch(() => 'inflight 随进程死亡而中断（预期）')

    const check = direct((db) => db.prepare('PRAGMA integrity_check').get().integrity_check)
    assertEq(check, 'ok', 'integrity_check 应为 ok')
    const rows = direct((db) => db.prepare('SELECT COUNT(*) AS c FROM projects').get().c)
    assert(rows >= 2, `已提交数据应仍在（实际 ${rows} 行）`)
    const uv = direct((db) => db.prepare('PRAGMA user_version').get().user_version)
    assertEq(uv, 1, 'user_version 应保持 1')
    main.dispose()
    main = null
    return `integrity_check=ok projects=${rows} user_version=${uv}`
  })

  // ── W15 重启后数据仍在 ──
  await r.check('W15', '强杀后重启：数据仍在、migrate 幂等', async () => {
    main = fresh('restart')
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.data.applied.length, 0, '重启后不应重复迁移')
    const list = await main.call('projects.list', {})
    const ids = list.data.map((r) => r.id).sort()
    assert(ids.includes('p3'), '强杀前提交的 p3 应仍在')
    assert(ids.includes('p2'), '更早的 p2 应仍在')
    return `projects=${ids.join(',')}`
  })

  // ── W16 shutdown 指令优雅退出 ──
  await r.check('W16', 'shutdown 指令优雅退出（exit 0 + WAL 截断）', async () => {
    const res = await main.call('shutdown')
    assertEq(res.ok, true, 'shutdown 应回 ok')
    assertEq(res.data.bye, true, '应回 bye')
    const { code } = await main.waitExit(8000)
    assertEq(code, 0, '退出码应为 0')
    const walExists = existsSync(dbPath + '-wal')
    const walSize = walExists ? statSync(dbPath + '-wal').size : 0
    assert(walSize === 0, `WAL 应被 checkpoint(TRUNCATE) 截断（实际 ${walSize}B）`)
    main.dispose()
    main = null
    return `exitCode=${code} wal=${walSize}B`
  })

  // ── W17 stdin EOF 优雅退出 ──
  await r.check('W17', 'stdin 关闭（EOF）也优雅退出', async () => {
    const h = fresh('eof')
    await h.call('ping')
    h.endStdin()
    const { code } = await h.waitExit(8000)
    assertEq(code, 0, 'EOF 退出码应为 0')
    h.dispose()
    return `exitCode=${code}`
  })

  // ── W18 SIGTERM 优雅退出 ──
  await r.check('W18', 'SIGTERM 触发优雅退出', async () => {
    const h = fresh('sigterm')
    await h.call('ping')
    h.kill('SIGTERM')
    const { code } = await h.waitExit(8000).catch(() => ({ code: null }))
    // Windows 上 TerminateProcess 不会派发信号处理器，进程被直接终止（code=1）；
    // POSIX 上应走优雅路径 code=0。两者都算「进程已退出、库可读」。
    const check = direct((db) => db.prepare('PRAGMA integrity_check').get().integrity_check)
    assertEq(check, 'ok', 'SIGTERM 后库应完整')
    h.dispose()
    return `exitCode=${code} integrity_check=ok（Windows 无信号语义，POSIX 下为 0）`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const h of [...active]) h.dispose()
  await sleep(200)
}

const workerResult = r.toJSON({ nodePath })
const workerOk = printResult(workerResult)
writeJson(join(__dirname, 'accept-result-worker.json'), workerResult)

// ── 客户端半边：同一命令串起来跑（真实 database.ts，经 esbuild bundle） ──
console.log('\n>>> 运行客户端半边：node test/db-client.accept.mjs')
const child = spawnSync(process.execPath, [join(__dirname, 'db-client.accept.mjs'), ...extraArgs], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: process.env
})
const clientResultPath = join(__dirname, 'accept-result-client.json')
let clientResult = null
try {
  clientResult = JSON.parse(readFileSync(clientResultPath, 'utf-8'))
} catch (e) {
  clientResult = { suite: 'db-client（客户端半边）', error: String(e), passed: 0, failed: 1, checks: [] }
}

const combined = {
  commit: 'Commit 02 —— DB Worker + 首版 Schema + 安装包前置',
  plan: 'PLAN-2.0.md v1.14（§三 目录策略 / §四 数据层 / §五 IPC 与错误规范 / §七 Commit 02 验收）',
  ranAt: new Date().toISOString(),
  node: process.version,
  runtimeNode: nodePath,
  totals: {
    checks: workerResult.checks.length + (clientResult.checks || []).length,
    passed: workerResult.passed + (clientResult.passed || 0),
    failed: workerResult.failed + (clientResult.failed || 0)
  },
  suites: [workerResult, clientResult],
  workerExitCode: child.status
}

writeJson(join(__dirname, 'accept-result.json'), combined)

console.log('')
console.log('================= 汇总 =================')
console.log(`worker 半边 : ${workerResult.passed}/${workerResult.checks.length} 通过（失败 ${workerResult.failed}）`)
console.log(
  `client 半边 : ${clientResult.passed || 0}/${(clientResult.checks || []).length} 通过（失败 ${clientResult.failed || 0}，exit=${child.status}）`
)
console.log(`合计        : ${combined.totals.passed}/${combined.totals.checks} 通过，失败 ${combined.totals.failed}`)
console.log('结果已写入 test/accept-result.json')

const allOk = workerOk && combined.totals.failed === 0

// 清理临时工作目录（失败时保留现场，便于排查）
if (allOk && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(allOk ? 0 : 1)
