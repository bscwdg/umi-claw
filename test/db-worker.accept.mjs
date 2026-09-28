// test/db-worker.accept.mjs —— Commit 00 验收（Worker 半边）
//
// 验的是 PLAN-3.0.md 的数据层底座本身：
//   - Worker JSONL 协议、白名单、错误码信封（§14.2）
//   - 8 表 schema + 索引 + user_version 迁移（§三 / §3.1 / 硬规则 24）
//   - 双时间语义（§2.2.1）、append-only 快照字段（§7.1）、conversations 承接 runId（§14.1）
//
// 刻意不复用 database.ts：本文件验的是 Worker 协议本身。
// 用法：node test/db-worker.accept.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

const extraArgs = process.argv.slice(2).filter((a) => a !== '--json-only')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `worker-${Date.now()}`)
const dbPath = join(runDir, 'umi-claw.db')
const active = new Set()

// ── 裸 JSONL 客户端 ──────────────────────────────────────────────────────────
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
// 期望索引 = v1 冻结索引 ∪ 各迁移步骤追加的索引（如 v2 的 idx_todos_remind）
const EXPECTED_INDEXES = [
  ...new Set([
    ...schemaMod.INDEX_STATEMENTS.map((s) => s.match(/idx_[a-z_]+/)[0]),
    ...MIGRATION_STEPS.flatMap((s) =>
      s.statements.map((sql) => sql.match(/idx_[a-z_]+/)?.[0]).filter(Boolean)
    )
  ])
].sort()
const TARGET = migrationMod.TARGET_USER_VERSION

const r = new Recorder('db-worker（Worker 半边）')
let main = null

try {
  mkdirSync(runDir, { recursive: true })

  // ── W1 惰性建库 ──
  await r.check('W1', 'worker 启动即建库（spawn 前不存在）', async () => {
    assert(!existsSync(dbPath), '建库前不应存在 umi-claw.db')
    main = fresh('main')
    await sleep(400)
    assert(existsSync(dbPath), 'spawn 后应创建 umi-claw.db')
    const pong = await main.call('ping')
    assertEq(pong.ok, true, 'ping 应成功')
    return `db=${dbPath} pid=${pong.data.pid}`
  })

  // ── W2 user_version 0 → TARGET ──
  await r.check('W2', `migrate 0 → ${TARGET}，user_version=${TARGET}`, async () => {
    const before = await main.call('schema.info')
    assertEq(before.data.userVersion, 0, '空库 user_version 应为 0')
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.ok, true, 'migrate 应成功: ' + JSON.stringify(res.error || {}))
    assertEq(res.data.from, 0, 'from 应为 0')
    assertEq(res.data.to, TARGET, `to 应为 ${TARGET}`)
    assertEq(res.data.applied.length, MIGRATION_STEPS.length, 'applied 数量应等于步骤数')
    const after = await main.call('schema.info')
    assertEq(after.data.userVersion, TARGET, `迁移后 user_version 应为 ${TARGET}`)
    return `applied=${res.data.applied.map((a) => 'v' + a.version).join(',')}`
  })

  // ── W3 migrate 幂等 ──
  await r.check('W3', 'migrate 幂等（已是最新时不再执行）', async () => {
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.ok, true, '重复 migrate 应成功')
    assertEq(res.data.applied.length, 0, '不应重复执行任何 step')
    assertEq(res.data.from, TARGET, `from 应为 ${TARGET}`)
    return 'applied=[]'
  })

  // ── W4 一期 8 表锁定（硬规则 24）──
  await r.check('W4', '8 张表齐备（硬规则 24），无营销域遗留表', async () => {
    const info = await main.call('schema.info')
    const tables = [...info.data.tables].sort()
    assertEq(JSON.stringify(tables), JSON.stringify(EXPECTED_TABLES), '表清单应与 schema.ts 一致')
    assertEq(info.data.tables.filter((t) => !t.startsWith('sqlite_')).length, 8, '表数量应为 8')
    for (const forbidden of ['projects', 'businesses', 'contents', 'hot_topics', 'content_versions', 'knowledge_items']) {
      assert(!tables.includes(forbidden), `${forbidden} 属 2.0 营销域，不应出现在 3.0`)
    }
    return tables.join(', ')
  })

  // ── W5 索引齐备 ──
  await r.check('W5', '索引齐备（§3.1）', async () => {
    const info = await main.call('schema.info')
    const idx = [...info.data.indexes].sort()
    assertEq(JSON.stringify(idx), JSON.stringify(EXPECTED_INDEXES), '索引清单应一致')
    return `${idx.length} 个：${idx.join(', ')}`
  })

  // ── W6 WAL ──
  await r.check('W6', 'WAL 生效（journal_mode=wal + -wal 文件出现）', async () => {
    const info = await main.call('schema.info')
    assertEq(info.data.journalMode, 'wal', 'journal_mode 应为 wal')
    await main.call('app_meta.upsert', { data: { key: 'wal_probe', value: '1' } })
    assert(existsSync(dbPath + '-wal'), '-wal 文件应存在')
    return `journal_mode=${info.data.journalMode} wal=${statSync(dbPath + '-wal').size}B`
  })

  // ── W7 foreign_keys=ON：matters 删除 → 弱关联 SET NULL（不是级联删）──
  await r.check('W7', 'foreign_keys=ON：删 matter → todos/activity_log 挂空但不删行', async () => {
    const info = await main.call('schema.info')
    assertEq(info.data.foreignKeys, true, 'PRAGMA foreign_keys 应为 1')
    const now = Date.now()
    await main.call('matters.create', { data: { id: 'm1', name: 'Q3活动', created_at: now, updated_at: now } })
    await main.call('todos.create', {
      data: { id: 't1', title: '完成方案', matter_id: 'm1', source: 'manual', state: 'confirmed', created_at: now, updated_at: now }
    })
    await main.call('activity_log.create', {
      data: { id: 'a1', content: '写了初稿', occurred_date: '2026-09-23', source: 'manual', status: 'confirmed', matter_id: 'm1', created_at: now, updated_at: now }
    })
    await main.call('matters.delete', { keys: { id: 'm1' }, required: true })

    const todos = await main.call('todos.list', { where: { id: 't1' } })
    assertEq(todos.data.length, 1, 'todos 不应被级联删除（弱关联）')
    assertEq(todos.data[0].matter_id, null, 'todos.matter_id 应被 SET NULL')
    const acts = await main.call('activity_log.list', { where: { id: 'a1' } })
    assertEq(acts.data.length, 1, 'activity_log 不应被级联删除')
    assertEq(acts.data[0].matter_id, null, 'activity_log.matter_id 应被 SET NULL')
    const left = await main.call('matters.list', {})
    assertEq(left.data.length, 0, 'matter 本身应已删除')
    return 'matters 删除 → 2 张表挂空，行数不变'
  })

  // ── W8 reports UNIQUE(type, period) ──
  await r.check('W8', 'reports UNIQUE(type, period) 生效 → CONFLICT', async () => {
    const now = Date.now()
    const first = await main.call('reports.create', {
      data: { id: 'r1', type: 'daily', period: '2026-09-23', created_at: now, updated_at: now }
    })
    assertEq(first.ok, true, '首次创建应成功')
    const second = await main.call('reports.create', {
      data: { id: 'r2', type: 'daily', period: '2026-09-23', created_at: now, updated_at: now }
    })
    assertEq(second.ok, false, '同周期重复创建应失败')
    assertEq(second.error.code, 'CONFLICT', '应为 CONFLICT')
    // 不同周期可以
    const other = await main.call('reports.create', {
      data: { id: 'r3', type: 'weekly', period: '2026-W39', created_at: now, updated_at: now }
    })
    assertEq(other.ok, true, '不同类型/周期应可创建')
    return 'daily+2026-09-23 冲突；weekly+2026-W39 通过'
  })

  // ── W9 knowledge UNIQUE(source_path) ──
  await r.check('W9', 'knowledge UNIQUE(source_path)：同文件重导入冲突，手输（path=NULL）可多条', async () => {
    const now = Date.now()
    const k1 = await main.call('knowledge.create', {
      data: { id: 'k1', title: '制度.pdf', type: 'pdf', source_path: 'C:/a/制度.pdf', created_at: now, updated_at: now }
    })
    assertEq(k1.ok, true, '首次导入应成功')
    const k2 = await main.call('knowledge.create', {
      data: { id: 'k2', title: '制度.pdf', type: 'pdf', source_path: 'C:/a/制度.pdf', created_at: now, updated_at: now }
    })
    assertEq(k2.ok, false, '同 source_path 应冲突')
    assertEq(k2.error.code, 'CONFLICT', '应为 CONFLICT')
    // NULL 互不冲突（手输 text/faq）
    const n1 = await main.call('knowledge.create', { data: { id: 'k3', title: '手输A', type: 'text', created_at: now, updated_at: now } })
    const n2 = await main.call('knowledge.create', { data: { id: 'k4', title: '手输B', type: 'text', created_at: now, updated_at: now } })
    assertEq(n1.ok, true, '手输第一条应成功')
    assertEq(n2.ok, true, '手输第二条也应成功（NULL 互不冲突）')
    return '文件路径唯一；手输 NULL 可多条'
  })

  // ── W10 双时间语义（§2.2.1）──
  await r.check('W10', '双时间语义：occurred_date 必填、occurred_time 可空、允许补记', async () => {
    const now = Date.now()
    const bad = await main.call('activity_log.create', {
      data: { id: 'a-bad', content: '缺发生日', source: 'manual', status: 'confirmed', created_at: now, updated_at: now }
    })
    assertEq(bad.ok, false, '缺 occurred_date 应失败')
    assertEq(bad.error.code, 'VALIDATION_ERROR', '应为 VALIDATION_ERROR')

    // 补记：occurred_date 早于 created_at（昨天的事今天记）
    const back = await main.call('activity_log.create', {
      data: {
        id: 'a-back', content: '昨天补记的事', occurred_date: '2026-09-22',
        source: 'manual', status: 'confirmed', created_at: now, updated_at: now
      }
    })
    assertEq(back.ok, true, '补记应允许（occurred_date ≠ created_at 的日期）')
    assertEq(back.data.row.occurred_date, '2026-09-22', 'occurred_date 应存实际发生日')
    assertEq(back.data.row.occurred_time, null, 'occurred_time 未传应为 NULL（时间未记）')

    // 有时间
    const timed = await main.call('activity_log.create', {
      data: {
        id: 'a-timed', content: '开会', occurred_date: '2026-09-23', occurred_time: '15:00',
        source: 'manual', status: 'confirmed', created_at: now, updated_at: now
      }
    })
    assertEq(timed.data.row.occurred_time, '15:00', 'occurred_time 应存 HH:MM')
    return '必填校验 ✓ 补记 ✓ 时间未记 ✓'
  })

  // ── W11 候选质量门槛留痕字段（§2.2）──
  await r.check('W11', '候选留痕：filtered_reason 可写入并读回（不静默丢）', async () => {
    const now = Date.now()
    const res = await main.call('activity_log.create', {
      data: {
        id: 'a-f', content: '过短', occurred_date: '2026-09-23', source: 'ai_output',
        status: 'ignored', filtered_reason: 'too-short', created_at: now, updated_at: now
      }
    })
    assertEq(res.ok, true, '应可写入')
    const got = await main.call('activity_log.get', { keys: { id: 'a-f' }, required: true })
    assertEq(got.data.filtered_reason, 'too-short', 'filtered_reason 应可读回')
    return 'filtered_reason 落库可读'
  })

  // ── W12 conversations 承接 runId + 快照（§14.1，不新增表）──
  await r.check('W12', 'conversations 承接 runId 与 contextSnapshot（不新增表）', async () => {
    const now = Date.now()
    const snapshot = JSON.stringify({ memory_snapshot: { matters: 1 }, inputs: [{ id: 'a1' }], dropped: [] })
    const res = await main.call('conversations.create', {
      data: {
        id: 'c1', conversation_key: 'conv:work:qa', run_id: 'run-001', role: 'assistant',
        content: '你今天做了 3 件事', metadata: snapshot, created_at: now
      }
    })
    assertEq(res.ok, true, '应可写入')
    const byRun = await main.call('conversations.list', { where: { run_id: 'run-001' } })
    assertEq(byRun.data.length, 1, '应能按 runId 检索到')
    const parsed = JSON.parse(byRun.data[0].metadata)
    assertEq(parsed.dropped.length, 0, 'metadata JSON 应可解析')
    assert(parsed.memory_snapshot, 'memory_snapshot 应存在')
    return `run_id → conversations.metadata（${byRun.data[0].metadata.length}B）`
  })

  // ── W13 错误码信封（§14.2）──
  await r.check('W13', '错误码信封：NOT_FOUND / VALIDATION_ERROR / CONFLICT / 白名单', async () => {
    const notFound = await main.call('matters.get', { keys: { id: 'nope' }, required: true })
    assertEq(notFound.ok, false, 'required get 缺失应失败')
    assertEq(notFound.error.code, 'NOT_FOUND', '应为 NOT_FOUND')
    assert(typeof notFound.error.message === 'string' && notFound.error.message.length > 0, '应有 message')

    const badFk = await main.call('todos.create', {
      data: { id: 't-bad', title: 'x', matter_id: 'ghost', source: 'manual', state: 'confirmed', created_at: 1, updated_at: 1 }
    })
    assertEq(badFk.ok, false, '非法外键应失败')
    assertEq(badFk.error.code, 'VALIDATION_ERROR', '外键违反应为 VALIDATION_ERROR')

    const badCol = await main.call('matters.list', { where: { evil_column: 1 } })
    assertEq(badCol.error.code, 'VALIDATION_ERROR', '未知列应为 VALIDATION_ERROR')

    const unknown = await main.call('matters.dropEverything')
    assertEq(unknown.ok, false, '未知方法应失败')
    assertEq(unknown.error.code, 'VALIDATION_ERROR', '未知方法应为 VALIDATION_ERROR')
    assert(Array.isArray(unknown.error.details.allowed), '应回传白名单 allowed')
    assert(unknown.error.details.allowed.includes('ping'), 'allowed 应含 ping')

    const rawSql = await main.call('p', { sql: 'DROP TABLE matters' })
    assertEq(rawSql.ok, false, '前端传 SQL 必须被拒')

    // 错误码必须全部落在 §14.2 的 11 项内
    const envelopeMod = await import(
      pathToFileURL(bundleEntry('electron/main/database/errors.ts', 'errors.mjs')).href
    )
    const allowedCodes = Object.keys(envelopeMod.ERROR_CODES)
    assertEq(allowedCodes.length, 11, `§14.2 应为 11 项，实际 ${allowedCodes.length}`)
    assert(!allowedCodes.includes('HOT_SOURCE_ERROR'), 'HOT_SOURCE_ERROR 应已移除')
    assert(allowedCodes.includes('STREAM_TRUNCATED'), 'STREAM_TRUNCATED 应已加入')
    return `allowed=${unknown.error.details.allowed.length} 方法；错误码 ${allowedCodes.length} 项`
  })

  // ── W14 白名单覆盖面（8 表 × CRUD + migrate/ping/shutdown）──
  await r.check('W14', '白名单覆盖 8 表 × CRUD + migrate/ping/shutdown', async () => {
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

  // ── W15 knowledge.search（无 projectId，§6.3 全量优先的 LIKE 兜底）──
  await r.check('W15', 'knowledge.search（LIKE，无 projectId）与 count', async () => {
    const now = Date.now()
    await main.call('knowledge.upsert', {
      data: { id: 'k9', title: '公司制度', type: 'text', content: '年假 5 天，需提前 3 个工作日申请', created_at: now, updated_at: now }
    })
    const hit = await main.call('knowledge.search', { query: '年假' })
    assertEq(hit.ok, true, '检索应成功')
    assert(hit.data.length >= 1, '应命中至少 1 条')
    assert(hit.data[0].snippet.includes('年假'), 'snippet 应含正文片段')
    const none = await main.call('knowledge.search', { query: '绝对不存在的词xyz' })
    assertEq(none.data.length, 0, '不应命中')
    const empty = await main.call('knowledge.search', { query: '   ' })
    assertEq(empty.ok, false, '空 query 应被拒')
    assertEq(empty.error.code, 'VALIDATION_ERROR', '应为 VALIDATION_ERROR')
    const cnt = await main.call('knowledge.count', {})
    assert(cnt.data.count >= 1, 'count 应 ≥1')
    return `snippet=${hit.data[0].snippet.slice(0, 24)}`
  })

  // ── W16 脏输入不崩 ──
  await r.check('W16', '脏请求行（非 JSON / 缺 method）不自杀', async () => {
    main.sendRaw('这不是 JSON')
    main.sendRaw(JSON.stringify({ id: 'x1' }))
    await sleep(250)
    const pong = await main.call('ping')
    assertEq(pong.ok, true, '脏输入后 ping 仍应成功（worker 未自杀）')
    return `stderr 末行=${main.stderr.split('\n').filter(Boolean).slice(-1)[0] || '(空)'}`
  })

  // ── W17 VACUUM INTO 备份 ──
  const backupPath = join(runDir, 'backup', 'umi-claw-stamp.db')
  await r.check('W17', 'VACUUM INTO 备份链路可用（含目标已存在 → CONFLICT）', async () => {
    const res = await main.call('maintenance.vacuumInto', { path: backupPath })
    assertEq(res.ok, true, '备份应成功: ' + JSON.stringify(res.error || {}))
    assert(existsSync(backupPath), '备份文件应存在')
    const size = statSync(backupPath).size
    assert(size > 0, '备份文件不应为空')
    const again = await main.call('maintenance.vacuumInto', { path: backupPath })
    assertEq(again.ok, false, '重复备份到同一路径应失败')
    assertEq(again.error.code, 'CONFLICT', '应为 CONFLICT')
    const bak = new DatabaseSync(backupPath)
    const check = bak.prepare('PRAGMA integrity_check').get()
    const tables = bak.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c
    bak.close()
    assertEq(check.integrity_check, 'ok', '备份库应完整')
    return `size=${size}B tables=${tables}`
  })

  // ── W18 强杀（写操作中）后库不损坏 ──
  await r.check('W18', '强杀（SIGKILL）后库不损坏，数据仍在', async () => {
    const now = Date.now()
    await main.call('matters.upsert', {
      data: { id: 'm-keep', name: '强杀前提交', created_at: now, updated_at: now }
    })
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('PRAGMA busy_timeout = 200')
    blocker.exec('BEGIN IMMEDIATE')
    const inflight = main.call('matters.upsert', {
      data: { id: 'm-lost', name: '写锁内', created_at: now, updated_at: now }
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
    const rows = direct((db) => db.prepare('SELECT COUNT(*) AS c FROM matters').get().c)
    assert(rows >= 1, `已提交数据应仍在（实际 ${rows} 行）`)
    const uv = direct((db) => db.prepare('PRAGMA user_version').get().user_version)
    assertEq(uv, TARGET, `user_version 应保持 ${TARGET}`)
    main.dispose()
    main = null
    return `integrity_check=ok matters=${rows} user_version=${uv}`
  })

  // ── W19 重启后数据仍在 ──
  await r.check('W19', '强杀后重启：数据仍在、migrate 幂等', async () => {
    main = fresh('restart')
    const res = await main.call('migrate', { steps: MIGRATION_STEPS })
    assertEq(res.data.applied.length, 0, '重启后不应重复迁移')
    const list = await main.call('matters.list', {})
    const ids = list.data.map((r) => r.id)
    assert(ids.includes('m-keep'), '强杀前提交的 m-keep 应仍在')
    return `matters=${ids.join(',')}`
  })

  // ── W20 shutdown 优雅退出 ──
  await r.check('W20', 'shutdown 指令优雅退出（exit 0 + WAL 截断）', async () => {
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

  // ── W21 stdin EOF 优雅退出 ──
  await r.check('W21', 'stdin 关闭（EOF）也优雅退出', async () => {
    const h = fresh('eof')
    await h.call('ping')
    h.endStdin()
    const { code } = await h.waitExit(8000)
    assertEq(code, 0, 'EOF 退出码应为 0')
    h.dispose()
    return `exitCode=${code}`
  })

  // ── W22 SIGTERM 优雅退出 ──
  await r.check('W22', 'SIGTERM 触发优雅退出（库仍完整）', async () => {
    const h = fresh('sigterm')
    await h.call('ping')
    h.kill('SIGTERM')
    const { code } = await h.waitExit(8000).catch(() => ({ code: null }))
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
  cwd: join(__dirname, '..')
})

const clientResultPath = join(__dirname, 'accept-result-client.json')
let clientResult = null
try {
  clientResult = JSON.parse((await import('node:fs')).readFileSync(clientResultPath, 'utf-8'))
} catch {
  /* 未产出 */
}

const combined = {
  suite: 'Commit 00 · 数据层底座',
  worker: { passed: workerResult.passed, total: workerResult.total, failed: workerResult.failed },
  client: clientResult
    ? { passed: clientResult.passed, total: clientResult.total, failed: clientResult.failed }
    : { passed: 0, total: 0, failed: 1 },
  totals: {
    passed: workerResult.passed + (clientResult?.passed ?? 0),
    total: workerResult.total + (clientResult?.total ?? 0),
    failed: workerResult.failed + (clientResult?.failed ?? 1)
  }
}
writeJson(join(__dirname, 'accept-result.json'), combined)

console.log('')
console.log(`===== ${combined.suite} =====`)
console.log(`Worker 半边: ${combined.worker.passed}/${combined.worker.total}`)
console.log(`客户端半边: ${combined.client.passed}/${combined.client.total}`)
console.log(`----- 合计: ${combined.totals.passed}/${combined.totals.total} 通过，失败 ${combined.totals.failed} -----`)

const allOk = workerOk && combined.totals.failed === 0
process.exit(allOk ? 0 : 1)
