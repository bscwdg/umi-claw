// db-worker.mjs —— Umi Claw 3.0 work DB Worker（零依赖，仅 node:sqlite）
//
// 设计基线：PLAN-3.0.md §三「核心数据模型」/ 硬规则 2。
//   - 单例常驻子进程，由 electron/main/database/database.ts 用便携 Node 拉起
//   - stdio JSONL 协议：
//       请求  { "id": "req-001", "method": "matters.list", "params": {} }
//       成功  { "id": "req-001", "ok": true,  "data": [] }
//       失败  { "id": "req-001", "ok": false, "error": { "code": "DB_ERROR", "message": "..." } }
//   - method 白名单分发：前端永远拿不到 SQL；渲染端只能经 IPC → Manager → 本进程
//   - 启动即执行 PRAGMA foreign_keys=ON / journal_mode=WAL / busy_timeout=5000
//   - 请求按到达顺序串行处理（DatabaseSync 本身同步，写操作天然串行）
//   - 未捕获异常回结构化 error，**不自杀**（除 shutdown / stdin 关闭 / SIGTERM / SIGINT）
//
// 硬规则：2（全局单例）、2（不得引入 better-sqlite3）、3（DB 只在主进程侧）。
//
// 唯一「接收 SQL」的入口是 migrate：它只由主进程侧的 database.ts 在惰性初始化时
// 调用，IPC 层不转发该方法，且 Worker 侧严格
// 校验形状（version 必须是正整数、statements 必须是字符串数组）。DDL 的真实来源
// 是 electron/main/database/schema.ts（Commit 00 交付物，单一真相来源）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

// ── 参数 ──────────────────────────────────────────────────────────────────────
function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  return null
}

const dbPath = argValue('--db')
if (!dbPath) {
  process.stderr.write('[db-worker] 缺少 --db <path> 参数\n')
  process.exit(1)
}

// ── 错误 ──────────────────────────────────────────────────────────────────────
// 错误码表与 PLAN-2.0.md §五 一致（此处只用到 DB 侧的几个；OPENCLAW_* 由 07 使用）
class WorkerError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** SQLite 原生错误 → §五 错误码 */
function mapDbError(e) {
  const msg = String((e && e.message) || e)
  const code = String((e && e.code) || '')
  if (/UNIQUE|PRIMARY KEY/i.test(msg) || /SQLITE_CONSTRAINT_PRIMARYKEY|SQLITE_CONSTRAINT_UNIQUE/i.test(code)) {
    return new WorkerError('CONFLICT', msg)
  }
  if (/FOREIGN KEY/i.test(msg) || /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(code)) {
    return new WorkerError('VALIDATION_ERROR', msg)
  }
  if (/NOT NULL|CHECK constraint/i.test(msg)) {
    return new WorkerError('VALIDATION_ERROR', msg)
  }
  if (/UNIQUE constraint/i.test(msg)) {
    return new WorkerError('CONFLICT', msg)
  }
  return new WorkerError('DB_ERROR', msg)
}

// ── 打开数据库 ────────────────────────────────────────────────────────────────
mkdirSync(dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)

try {
  db.exec('PRAGMA foreign_keys = ON')
} catch (e) {
  process.stderr.write('[db-worker] PRAGMA foreign_keys 失败: ' + e.message + '\n')
}
try {
  // WAL 在不支持的文件系统上会失败（网络盘等），降级不阻断
  db.exec('PRAGMA journal_mode = WAL')
} catch (e) {
  process.stderr.write('[db-worker] PRAGMA journal_mode=WAL 失败（降级）: ' + e.message + '\n')
}
try {
  db.exec('PRAGMA busy_timeout = 5000')
} catch (e) {
  process.stderr.write('[db-worker] PRAGMA busy_timeout 失败: ' + e.message + '\n')
}

// ── 表元数据（列名白名单；与 schema.ts 一一对应） ─────────────────────────────
// 白名单是硬边界：任何未登记的列名/表名一律拒绝，杜绝拼接注入。
// 3.0：一期 8 表锁定（硬规则 24）——profile / matters / todos / activity_log /
// reports / knowledge / conversations / app_meta。
const TABLES = {
  profile: {
    pk: ['id'],
    columns: ['id', 'call_name', 'position', 'department', 'company', 'report_to', 'tone', 'report_style', 'industry', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  matters: {
    pk: ['id'],
    columns: ['id', 'name', 'status', 'color', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  todos: {
    pk: ['id'],
    columns: ['id', 'title', 'due_date', 'due_at', 'matter_id', 'source', 'routine_rule', 'state', 'done_at', 'remind_at', 'reminded_at', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  activity_log: {
    pk: ['id'],
    columns: ['id', 'content', 'occurred_date', 'occurred_time', 'source', 'source_ref', 'status', 'matter_id', 'confirmed_at', 'filtered_reason', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  reports: {
    pk: ['id'],
    columns: ['id', 'type', 'period', 'status', 'content', 'generation_context', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  knowledge: {
    pk: ['id'],
    columns: ['id', 'title', 'type', 'source_path', 'source_name', 'content', 'status', 'created_at', 'updated_at'],
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  conversations: {
    pk: ['id'],
    columns: ['id', 'conversation_key', 'run_id', 'role', 'content', 'metadata', 'created_at'],
    createdAt: 'created_at',
    updatedAt: null
  },
  app_meta: {
    pk: ['key'],
    columns: ['key', 'value'],
    createdAt: null,
    updatedAt: null
  }
}

const TABLE_NAMES = Object.keys(TABLES)

/** 标识符一律双引号包裹 + 白名单校验（双保险） */
function qi(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new WorkerError('VALIDATION_ERROR', `非法标识符: ${name}`)
  }
  return '"' + name + '"'
}

function table(nameOrParams, fallback) {
  const name =
    typeof nameOrParams === 'string'
      ? nameOrParams
      : nameOrParams && typeof nameOrParams.table === 'string'
        ? nameOrParams.table
        : fallback
  const t = TABLES[name]
  if (!t) throw new WorkerError('VALIDATION_ERROR', `未知表: ${name}`)
  return t
}

function assertColumn(t, col) {
  if (!t.columns.includes(col)) {
    throw new WorkerError('VALIDATION_ERROR', `未知列: ${col}`)
  }
  return col
}

/** 剔除 undefined，保留 null（null 是有效值，代表显式置空） */
function clean(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object') {
      throw new WorkerError('VALIDATION_ERROR', `列 ${k} 的值必须是标量（字符串/数字/null）`)
    }
    out[k] = v
  }
  return out
}

function pickColumns(t, obj) {
  const out = {}
  for (const [k, v] of Object.entries(clean(obj))) {
    assertColumn(t, k)
    out[k] = v
  }
  return out
}

/** PK 解析：支持 {keys:{...}} / {pk:"x"} / {id:"x"} / 顶层主键列 */
function normalizeKeys(t, params) {
  const p = params || {}
  const keys = {}
  const single = t.pk.length === 1 ? t.pk[0] : null

  if (p.keys && typeof p.keys === 'object') {
    for (const [k, v] of Object.entries(p.keys)) {
      if (v === undefined || v === null) continue
      keys[assertColumn(t, k)] = v
    }
  }
  if (p.pk !== undefined && p.pk !== null) {
    if (single && (typeof p.pk !== 'object' || Array.isArray(p.pk))) {
      keys[single] = p.pk
    } else if (typeof p.pk === 'object' && !Array.isArray(p.pk)) {
      for (const [k, v] of Object.entries(p.pk)) {
        if (v === undefined || v === null) continue
        keys[assertColumn(t, k)] = v
      }
    } else {
      throw new WorkerError('VALIDATION_ERROR', `表 ${t.pk.join('+')} 的主键需要对象形式`)
    }
  }
  if (single && p[single] !== undefined && p[single] !== null) {
    keys[single] = p[single]
  }
  for (const k of t.pk) {
    if (p[k] !== undefined && p[k] !== null) keys[k] = p[k]
  }

  for (const k of t.pk) {
    if (keys[k] === undefined) {
      throw new WorkerError('VALIDATION_ERROR', `缺少主键列: ${k}`)
    }
  }
  return keys
}

function requireParams(params) {
  const p = params
  if (p !== undefined && p !== null && typeof p !== 'object') {
    throw new WorkerError('VALIDATION_ERROR', 'params 必须是对象')
  }
  return p || {}
}

function clampLimit(v, def, max) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

// ── 通用 CRUD ─────────────────────────────────────────────────────────────────
function opList(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const where = []
  const args = []
  if (p.where && typeof p.where === 'object') {
    for (const [k, v] of Object.entries(p.where)) {
      assertColumn(t, k)
      if (v === null) {
        where.push(qi(k) + ' IS NULL')
      } else if (Array.isArray(v)) {
        if (!v.length) {
          where.push('0 = 1')
          continue
        }
        where.push(qi(k) + ' IN (' + v.map(() => '?').join(', ') + ')')
        for (const item of v) args.push(item)
      } else if (v === undefined) {
        continue
      } else {
        where.push(qi(k) + ' = ?')
        args.push(v)
      }
    }
  }

  let orderSql = ''
  const order = p.order === undefined ? t.pk : p.order
  // 参数约定 4（PLAN-3.0.md §14）：list 一律「新→旧」，因此必须支持方向。
  // 兼容两种写法：字符串/字符串数组（默认 ASC，2.0 旧口径）与
  // { column, direction } 对象/对象数组（3.0 新增，direction: 'asc' | 'desc'）。
  const orderParts = []
  const pushOrder = (spec) => {
    if (typeof spec === 'string') {
      orderParts.push(qi(assertColumn(t, spec)) + ' ASC')
      return
    }
    if (spec && typeof spec === 'object' && typeof spec.column === 'string') {
      const dir = String(spec.direction ?? 'asc').toLowerCase()
      if (dir !== 'asc' && dir !== 'desc') {
        throw new WorkerError('VALIDATION_ERROR', `order.direction 只能是 asc/desc: ${spec.direction}`)
      }
      orderParts.push(qi(assertColumn(t, spec.column)) + ' ' + dir.toUpperCase())
      return
    }
    throw new WorkerError('VALIDATION_ERROR', 'order 元素必须是列名或 { column, direction }')
  }
  if (typeof order === 'string' || (order && typeof order === 'object' && !Array.isArray(order))) {
    pushOrder(order)
  } else if (Array.isArray(order)) {
    for (const o of order) pushOrder(o)
  } else {
    throw new WorkerError('VALIDATION_ERROR', 'order 必须是列名/列名数组/{column,direction} 或其数组')
  }
  orderSql = orderParts.length ? ' ORDER BY ' + orderParts.join(', ') : ''

  const limit = clampLimit(p.limit, 500, 5000)
  const offset = Math.max(0, Math.floor(Number(p.offset) || 0))
  const sql =
    'SELECT * FROM ' + qi(name) + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    orderSql + ' LIMIT ? OFFSET ?'
  return db.prepare(sql).all(...args, limit, offset)
}

function opCount(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const where = []
  const args = []
  if (p.where && typeof p.where === 'object') {
    for (const [k, v] of Object.entries(p.where)) {
      assertColumn(t, k)
      if (v === null) where.push(qi(k) + ' IS NULL')
      else if (v !== undefined) {
        where.push(qi(k) + ' = ?')
        args.push(v)
      }
    }
  }
  const sql = 'SELECT COUNT(*) AS c FROM ' + qi(name) + (where.length ? ' WHERE ' + where.join(' AND ') : '')
  return { count: db.prepare(sql).get(...args).c }
}

function opGet(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const keys = normalizeKeys(t, p)
  const sql =
    'SELECT * FROM ' + qi(name) + ' WHERE ' + t.pk.map((k) => qi(k) + ' = ?').join(' AND ') + ' LIMIT 1'
  const row = db.prepare(sql).get(...t.pk.map((k) => keys[k]))
  if (!row) {
    if (p.required === true) {
      throw new WorkerError('NOT_FOUND', `${name} 不存在: ${JSON.stringify(keys)}`)
    }
    return null
  }
  return row
}

function opCreate(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const data = pickColumns(t, p.data)
  if (!Object.keys(data).length) throw new WorkerError('VALIDATION_ERROR', 'data 不能为空')
  for (const k of t.pk) {
    if (data[k] === undefined || data[k] === null) {
      throw new WorkerError('VALIDATION_ERROR', `缺少主键列: ${k}`)
    }
  }
  const now = Date.now()
  if (t.createdAt && data[t.createdAt] === undefined) data[t.createdAt] = now
  if (t.updatedAt && data[t.updatedAt] === undefined) data[t.updatedAt] = now

  const cols = Object.keys(data)
  const sql =
    'INSERT INTO ' + qi(name) + ' (' + cols.map(qi).join(', ') + ') VALUES (' +
    cols.map(() => '?').join(', ') + ')'
  const info = db.prepare(sql).run(...cols.map((c) => data[c]))
  const keys = {}
  for (const k of t.pk) keys[k] = data[k]
  return { changes: Number(info.changes), keys, row: opGet(name, { keys }) }
}

function opUpsert(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const data = pickColumns(t, p.data)
  if (!Object.keys(data).length) throw new WorkerError('VALIDATION_ERROR', 'data 不能为空')
  for (const k of t.pk) {
    if (data[k] === undefined || data[k] === null) {
      throw new WorkerError('VALIDATION_ERROR', `缺少主键列: ${k}`)
    }
  }
  const now = Date.now()
  if (t.createdAt && data[t.createdAt] === undefined) data[t.createdAt] = now
  if (t.updatedAt && data[t.updatedAt] === undefined) data[t.updatedAt] = now

  const cols = Object.keys(data)
  // 冲突时只更新非主键列；空集合（纯主键表）退化为 DO NOTHING
  const updatable = cols.filter((c) => !t.pk.includes(c))
  const conflict =
    updatable.length > 0
      ? 'DO UPDATE SET ' + updatable.map((c) => qi(c) + ' = excluded.' + qi(c)).join(', ')
      : 'DO NOTHING'
  const sql =
    'INSERT INTO ' + qi(name) + ' (' + cols.map(qi).join(', ') + ') VALUES (' +
    cols.map(() => '?').join(', ') + ') ON CONFLICT (' + t.pk.map(qi).join(', ') + ') ' + conflict
  const info = db.prepare(sql).run(...cols.map((c) => data[c]))
  const keys = {}
  for (const k of t.pk) keys[k] = data[k]
  return { changes: Number(info.changes), keys, row: opGet(name, { keys }) }
}

function opUpdate(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const keys = normalizeKeys(t, p)
  const data = pickColumns(t, p.data)
  for (const k of t.pk) delete data[k]
  if (t.updatedAt && data[t.updatedAt] === undefined) data[t.updatedAt] = Date.now()
  const cols = Object.keys(data)
  if (!cols.length) throw new WorkerError('VALIDATION_ERROR', 'data 不能为空')
  const sql =
    'UPDATE ' + qi(name) + ' SET ' + cols.map((c) => qi(c) + ' = ?').join(', ') +
    ' WHERE ' + t.pk.map((k) => qi(k) + ' = ?').join(' AND ')
  const info = db.prepare(sql).run(...cols.map((c) => data[c]), ...t.pk.map((k) => keys[k]))
  const changes = Number(info.changes)
  if (changes === 0 && p.required === true) {
    throw new WorkerError('NOT_FOUND', `${name} 不存在: ${JSON.stringify(keys)}`)
  }
  return { changes, keys, row: opGet(name, { keys }) }
}

function opDelete(name, params) {
  const t = TABLES[name]
  const p = requireParams(params)
  const keys = normalizeKeys(t, p)
  const sql =
    'DELETE FROM ' + qi(name) + ' WHERE ' + t.pk.map((k) => qi(k) + ' = ?').join(' AND ')
  const info = db.prepare(sql).run(...t.pk.map((k) => keys[k]))
  const changes = Number(info.changes)
  if (changes === 0 && p.required === true) {
    throw new WorkerError('NOT_FOUND', `${name} 不存在: ${JSON.stringify(keys)}`)
  }
  return { changes, keys }
}

// ── 专用方法 ──────────────────────────────────────────────────────────────────
function userVersion() {
  const row = db.prepare('PRAGMA user_version').get()
  return Number(row.user_version || 0)
}

function setUserVersion(v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new WorkerError('VALIDATION_ERROR', `非法 user_version: ${v}`)
  }
  db.exec('PRAGMA user_version = ' + n)
}

function schemaInfo() {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
  let journalMode = null
  try {
    journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode
  } catch {
    /* 忽略 */
  }
  let foreignKeys = null
  try {
    foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1
  } catch {
    /* 忽略 */
  }
  let sqliteVersion = null
  try {
    sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v
  } catch {
    /* 忽略 */
  }
  return {
    userVersion: userVersion(),
    dbPath,
    tables,
    indexes,
    journalMode,
    foreignKeys,
    sqliteVersion
  }
}

function doMigrate(params) {
  const p = requireParams(params)
  if (!Array.isArray(p.steps)) {
    throw new WorkerError('VALIDATION_ERROR', 'migrate 需要 params.steps 数组')
  }
  for (const s of p.steps) {
    if (!s || !Number.isInteger(s.version) || s.version <= 0) {
      throw new WorkerError('VALIDATION_ERROR', 'migrate step.version 必须是正整数')
    }
    if (!Array.isArray(s.statements) || s.statements.some((x) => typeof x !== 'string')) {
      throw new WorkerError('VALIDATION_ERROR', 'migrate step.statements 必须是字符串数组')
    }
  }
  const from = userVersion()
  const pending = p.steps
    .filter((s) => s.version > from)
    .sort((a, b) => a.version - b.version)
  const applied = []
  for (const step of pending) {
    db.exec('BEGIN')
    try {
      for (const sql of step.statements) db.exec(sql)
      setUserVersion(step.version)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 忽略 */
      }
      const err = mapDbError(e)
      err.message = `迁移 v${step.version}（${step.name || ''}）失败: ` + err.message
      throw err
    }
    applied.push({ version: step.version, name: step.name || '' })
  }
  return { from, to: userVersion(), applied }
}

function checkpoint() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return { ok: true }
}

function vacuumInto(params) {
  const p = requireParams(params)
  const target = p.path
  if (typeof target !== 'string' || !target.trim()) {
    throw new WorkerError('VALIDATION_ERROR', 'maintenance.vacuumInto 需要 params.path')
  }
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) {
    throw new WorkerError('CONFLICT', `备份目标已存在: ${target}`)
  }
  // VACUUM INTO 的目标路径不能参数化，只能内联；用 '' 转义单引号
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  return { path: target, size: statSync(target).size }
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}

/** knowledge 的 LIKE 关键词检索（预算内全量优先，超预算才裁剪；FTS5 归 user_version=2） */
function searchKnowledge(params) {
  const p = requireParams(params)
  if (typeof p.query !== 'string' || !p.query.trim()) {
    throw new WorkerError('VALIDATION_ERROR', 'knowledge.search 需要非空 query')
  }
  const limit = clampLimit(p.limit, 20, 200)
  const like = '%' + likeEscape(p.query.trim()) + '%'
  const where = [`("title" LIKE ? ESCAPE '\\' OR "content" LIKE ? ESCAPE '\\' OR "source_name" LIKE ? ESCAPE '\\')`]
  const args = [like, like, like]
  if (typeof p.status === 'string' && p.status) {
    where.push('"status" = ?')
    args.push(p.status)
  }
  return db
    .prepare(
      'SELECT "id", "title", "type", "source_name", "status", ' +
        'substr(coalesce("content", \'\'), 1, 400) AS snippet ' +
        'FROM "knowledge" WHERE ' +
        where.join(' AND ') +
        ' ORDER BY "updated_at" DESC LIMIT ?'
    )
    .all(...args, limit)
}

// ── 白名单分发表 ──────────────────────────────────────────────────────────────
const HANDLERS = {
  ping: () => ({ pong: true, pid: process.pid, ts: Date.now() }),
  'schema.info': () => schemaInfo(),
  migrate: (p) => doMigrate(p),
  'maintenance.checkpoint': () => checkpoint(),
  'maintenance.vacuumInto': (p) => vacuumInto(p),
  'knowledge.search': (p) => searchKnowledge(p)
}

// 8 张业务表 + app_meta 的统一 CRUD（Commit 02+ 的 Manager 直接消费）
for (const name of TABLE_NAMES) {
  HANDLERS[name + '.list'] = (p) => opList(name, p)
  HANDLERS[name + '.get'] = (p) => opGet(name, p)
  HANDLERS[name + '.create'] = (p) => opCreate(name, p)
  HANDLERS[name + '.upsert'] = (p) => opUpsert(name, p)
  HANDLERS[name + '.update'] = (p) => opUpdate(name, p)
  HANDLERS[name + '.delete'] = (p) => opDelete(name, p)
  HANDLERS[name + '.count'] = (p) => opCount(name, p)
}

// 白名单方法名（含在 handleLine 里特判的 shutdown），用于错误提示与验收断言
const ALLOWED_METHODS = [...Object.keys(HANDLERS), 'shutdown'].sort()

// ── 输出 ──────────────────────────────────────────────────────────────────────
function writeLine(payload) {
  try {
    process.stdout.write(JSON.stringify(payload) + '\n')
  } catch (e) {
    process.stderr.write('[db-worker] 输出失败: ' + e.message + '\n')
  }
}

function respondOk(id, data) {
  writeLine({ id, ok: true, data: data === undefined ? null : data })
}

function respondErr(id, err) {
  const code = (err && err.code) || 'DB_ERROR'
  const message = (err && err.message) || String(err)
  const envelope = { code, message }
  if (err && err.details !== undefined) envelope.details = err.details
  writeLine({ id, ok: false, error: envelope })
}

// ── 关闭 ──────────────────────────────────────────────────────────────────────
let closing = false
function gracefulExit(reason, respondTo) {
  if (closing) return
  closing = true
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (e) {
    process.stderr.write('[db-worker] checkpoint 失败: ' + e.message + '\n')
  }
  try {
    db.close()
  } catch (e) {
    process.stderr.write('[db-worker] close 失败: ' + e.message + '\n')
  }
  if (respondTo !== undefined && respondTo !== null) {
    respondOk(respondTo, { bye: true, reason })
  }
  // 让 stdout 先 flush 再退出
  process.stdout.write('', () => process.exit(0))
  setTimeout(() => process.exit(0), 200).unref?.()
}

// ── 串行处理 ──────────────────────────────────────────────────────────────────
let chain = Promise.resolve()

function handleLine(line) {
  let req
  try {
    req = JSON.parse(line)
  } catch (e) {
    process.stderr.write('[db-worker] 无法解析的请求行: ' + line.slice(0, 200) + '\n')
    return
  }
  const id = req && req.id !== undefined ? req.id : null
  const method = req && typeof req.method === 'string' ? req.method : null
  if (!method) {
    respondErr(id, new WorkerError('VALIDATION_ERROR', '请求缺少 method'))
    return
  }

  if (method === 'shutdown') {
    respondOk(id, { bye: true, reason: 'shutdown' })
    gracefulExit('shutdown')
    return
  }

  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, method) ? HANDLERS[method] : null
  if (!handler) {
    respondErr(
      id,
      new WorkerError('VALIDATION_ERROR', `未知方法（不在白名单内）: ${method}`, {
        allowed: ALLOWED_METHODS
      })
    )
    return
  }

  try {
    const data = handler(req.params)
    respondOk(id, data)
  } catch (e) {
    // 未捕获异常回结构化 error，绝不自杀
    respondErr(id, e instanceof WorkerError ? e : mapDbError(e))
  }
}

let stdinBuf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk
  let nl
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl).trim()
    stdinBuf = stdinBuf.slice(nl + 1)
    if (!line) continue
    if (line === 'shutdown' || line === '{"method":"shutdown"}') {
      gracefulExit('stdin-shutdown')
      continue
    }
    chain = chain.then(() => handleLine(line))
  }
})
process.stdin.on('end', () => gracefulExit('stdin-end'))
process.stdin.on('close', () => gracefulExit('stdin-close'))

process.on('SIGTERM', () => gracefulExit('SIGTERM'))
process.on('SIGINT', () => gracefulExit('SIGINT'))

process.on('uncaughtException', (e) => {
  process.stderr.write('[db-worker] uncaughtException（保持存活）: ' + (e && e.stack ? e.stack : e) + '\n')
})
process.on('unhandledRejection', (e) => {
  process.stderr.write('[db-worker] unhandledRejection（保持存活）: ' + (e && e.stack ? e.stack : e) + '\n')
})

process.stderr.write(`[db-worker] pid=${process.pid} db=${dbPath} user_version=${userVersion()}\n`)
