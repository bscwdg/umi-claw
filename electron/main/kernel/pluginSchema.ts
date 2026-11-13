// kernel/pluginSchema.ts —— 从插件自带的 migrations/*.sql 推导「表结构 + 迁移步骤」（Phase 1 WP2）
//
// 为什么不在 plugin.json 里手写 tables：那样会有两份真相（SQL 与清单），改一边忘一边
// 就出现「表建了但白名单不认」。这里直接解析 SQL，SQL 是唯一真相。
//
// 解析范围（够插件用，刻意保守）：
//   - CREATE TABLE [IF NOT EXISTS] <name> ( ... )        → 表名 + 列 + 主键
//   - ALTER TABLE <name> ADD COLUMN <col> ...            → 追加列
//   - 其它语句（INDEX / PRAGMA / INSERT）原样进迁移步骤，不参与结构推导
// 解析不出来的 DDL 不会让插件起不来：该表退化为「不在白名单」，由验收/日志暴露。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginTableDef {
  pk: string[]
  columns: string[]
  createdAt: string | null
  updatedAt: string | null
}

export interface PluginMigrationStep {
  version: number
  name: string
  statements: string[]
}

export interface PluginSchemaDef {
  tables: Record<string, PluginTableDef>
  steps: PluginMigrationStep[]
  targetUserVersion: number
}

const TABLE_CONSTRAINTS = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'])

/**
 * 迁移语句白名单（PLAN-5.0 A3a）。
 *
 * 为什么只允许三类：插件迁移由宿主直接交给 SQLite 执行，`ATTACH` 可跨库读写、
 * `VACUUM INTO` 可任意路径写、`PRAGMA` 可改连接级行为——这些都会绕过插件 DB 的
 * 参数化 CRUD 与数据目录边界。官方插件现有迁移全部是 CREATE/ALTER/INDEX，
 * 因此白名单不会误伤；第三方迁移也必须遵守（见 PLUGIN-API §5）。
 */
const MIGRATION_ALLOWED = [
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?\s*\(/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?\s+ON\s+/i,
  /^ALTER\s+TABLE\s+["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?\s+ADD\s+(?:COLUMN\s+)?["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?/i
]

const MIGRATION_FORBIDDEN =
  /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|INSERT|DROP|CREATE\s+(?:TRIGGER|VIEW|VIRTUAL\s+TABLE))\b/i

/** 单条迁移语句是否在白名单内（供 loadPluginSchema 与验收共用） */
export function isAllowedMigrationStatement(statement: string): boolean {
  const text = statement.trim()
  if (!text) return false
  // 黑名单匹配前先抹掉字符串字面量：DEFAULT 'insert' 这类合法默认值不能误伤。
  const masked = text.replace(/'(?:[^']|'')*'/g, "''")
  // 防止 `CREATE TABLE ... ATTACH ...` 这类前缀匹配混过（即使 SQLite 会语法错，
  // 也不该让它进入宿主执行路径）。
  if (MIGRATION_FORBIDDEN.test(masked)) return false
  return MIGRATION_ALLOWED.some((re) => re.test(text))
}


/** 解析单个 SQL 文件 → 语句数组（按分号切，忽略字符串里的分号不追求完美） */
export function splitStatements(sql: string): string[] {
  // 先去掉 `--` 行注释与 `/* *\/` 块注释：否则 `-- 说明\nCREATE TABLE ...` 整段会被
  // 当成一条以注释开头的语句，CREATE 正则匹配不到（P25 踩过）
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')

  const out: string[] = []
  let current = ''
  let inString = false
  for (const ch of cleaned) {
    if (ch === "'") inString = !inString
    if (ch === ';' && !inString) {
      const trimmed = current.trim()
      if (trimmed) out.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) out.push(tail)
  return out
}

/** 解析 CREATE TABLE / ALTER TABLE ADD COLUMN，把结果并入 tables */
export function applyStatement(tables: Record<string, PluginTableDef>, statement: string): void {
  const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\(([\s\S]*)\)\s*(?:STRICT\s*(?:,\s*WITHOUT\s+ROWID)?|WITHOUT\s+ROWID)?\s*$/i.exec(
    statement.trim()
  )
  if (create) {
    const [, name, body] = create
    const def: PluginTableDef = { pk: [], columns: [], createdAt: null, updatedAt: null }
    for (const part of splitTopLevel(body)) {
      const piece = part.trim()
      if (!piece) continue
      const first = piece.split(/\s+/)[0].toUpperCase()
      if (TABLE_CONSTRAINTS.has(first)) {
        const pk = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(piece)
        if (pk) def.pk = pk[1].split(',').map((c) => unquote(c.trim())).filter(Boolean)
        continue
      }
      const col = unquote(piece.split(/\s+/)[0])
      if (!col) continue
      def.columns.push(col)
    }
    if (!def.pk.length && def.columns.includes('id')) def.pk = ['id']
    if (!def.pk.length && def.columns.length) def.pk = [def.columns[0]]
    if (def.columns.includes('created_at')) def.createdAt = 'created_at'
    if (def.columns.includes('updated_at')) def.updatedAt = 'updated_at'
    tables[name] = def
    return
  }

  const alter = /^ALTER\s+TABLE\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+ADD\s+(?:COLUMN\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i.exec(
    statement.trim()
  )
  if (alter) {
    const [, name, col] = alter
    const def = tables[name]
    if (def && !def.columns.includes(col)) {
      def.columns.push(col)
      if (col === 'created_at') def.createdAt = 'created_at'
      if (col === 'updated_at') def.updatedAt = 'updated_at'
    }
  }
}

/** 按顶层逗号切分（括号/字符串里的逗号不切） */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let current = ''
  for (const ch of body) {
    if (ch === "'") inString = !inString
    if (!inString) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts
}

function unquote(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, '')
}

/**
 * 解析插件目录下的 migrations。
 *
 * 文件命名：`001_init.sql`、`002_add_remind.sql` —— 前缀数字即 user_version。
 * 返回的 tables 是**所有迁移叠加后**的最终结构（迁移里的 ALTER 会被合入）。
 */
export function loadPluginSchema(migrationsDir: string): PluginSchemaDef {
  const tables: Record<string, PluginTableDef> = {}
  const steps: PluginMigrationStep[] = []

  if (!existsSync(migrationsDir)) return { tables, steps, targetUserVersion: 0 }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const version = Number.parseInt(file, 10)
    if (!Number.isFinite(version) || version <= 0) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    const statements = splitStatements(sql)
    for (const statement of statements) {
      if (!isAllowedMigrationStatement(statement)) {
        throw new Error(
          `插件迁移包含不允许的语句（${file}）：${statement.slice(0, 120)}（仅允许 CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN）`
        )
      }
      applyStatement(tables, statement)
    }
    steps.push({ version, name: file.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '') || file, statements })
  }

  // 迁移版本可能不连续（001/003）：DatabaseClient 按 version 升序执行，目标取最大值
  steps.sort((a, b) => a.version - b.version)
  const target = steps.length ? steps[steps.length - 1].version : 0
  return { tables, steps, targetUserVersion: target }
}
