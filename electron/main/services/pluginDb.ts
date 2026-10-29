// services/pluginDb.ts —— 每个插件一个独立 SQLite（Phase 1 WP2）
//
// 结构：`<dataDir>/plugins/<id>/data.db`
// 表白名单：从插件 `migrations/*.sql` 解析出来，写 `<pluginDir>/tables.json` 交给
// db-worker 的 `--tables`（worker 收到就**整体替换**内置 8 表，避免插件库拥有 work 的表）。
// 迁移：同一批 SQL 作为 user_version 步骤交给 DatabaseClient 执行（幂等 + 迁移前快照）。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseClient } from '../database/database'
import type { DbSchemaProfile } from '../database/schemas'
import { loadPluginSchema } from '../kernel/pluginSchema'
import type { PluginDbApi } from '../kernel/services'

export interface PluginDbServiceOptions {
  dataDir: string
  /** 便携 Node（configManager.getNodePath()） */
  nodePath: string
  /** resources/database/db-worker.mjs 绝对路径 */
  workerScriptPath: string
  logger?: (line: string) => void
}

export interface PluginDbService {
  forPlugin(info: { id: string; dir: string }): PluginDbApi
  /** 退出时统一关闭所有插件库 worker */
  disposeAll(): Promise<void>
}

export function createPluginDbService(opts: PluginDbServiceOptions): PluginDbService {
  const entries = new Map<string, { api: PluginDbApi; client: DatabaseClient }>()

  return {
    forPlugin({ id, dir }) {
      const existing = entries.get(id)
      if (existing) return existing.api

      const pluginDataDir = join(opts.dataDir, 'plugins', id)
      mkdirSync(pluginDataDir, { recursive: true })

      const schemaDef = loadPluginSchema(join(dir, 'migrations'))
      if (!schemaDef.steps.length) {
        throw new Error(`插件 ${id} 没有可用的 migrations（期望 ${join(dir, 'migrations', '*.sql')}）`)
      }

      const tablesPath = join(pluginDataDir, 'tables.json')
      writeFileSync(tablesPath, JSON.stringify(schemaDef.tables, null, 2), 'utf-8')

      const schema: DbSchemaProfile = {
        id: `plugin:${id}`,
        label: `插件 ${id}`,
        tables: Object.keys(schemaDef.tables),
        targetUserVersion: schemaDef.targetUserVersion,
        pendingSteps: (from: number) => schemaDef.steps.filter((step) => step.version > from),
        dbFileName: 'data.db'
      }

      const client = new DatabaseClient({
        dbPath: join(pluginDataDir, 'data.db'),
        backupDir: join(pluginDataDir, 'backup'),
        workerScriptPath: opts.workerScriptPath,
        nodePath: opts.nodePath,
        schema,
        workerArgs: ['--tables', tablesPath],
        subprocessName: `plugin-${id}-db-worker`,
        logger: opts.logger
      })

      const ensureTable = (table: string): void => {
        if (!(table in schemaDef.tables)) {
          throw new Error(`表未在插件 migrations 中定义：${table}（可用：${Object.keys(schemaDef.tables).join(', ')}）`)
        }
      }

      /** 主键对象：单主键用 `{ pk: value }` 走 worker 的简写形式 */
      const keyParams = (table: string, idValue: unknown): Record<string, unknown> => {
        const pk = schemaDef.tables[table].pk
        if (pk.length === 1) return { pk: idValue }
        if (idValue && typeof idValue === 'object') return { keys: idValue as Record<string, unknown> }
        throw new Error(`表 ${table} 是复合主键，请传 { ${pk.join(', ')} } 对象`)
      }

      const api: PluginDbApi = {
        path: join(pluginDataDir, 'data.db'),
        async migrate() {
          await client.ensureReady()
        },
        async request(method, params) {
          return (await client.request(method, (params ?? {}) as Record<string, unknown>)) as never
        },
        async list(table, query) {
          ensureTable(table)
          return (await client.request(`${table}.list`, query ?? {})) as never
        },
        async get(table, idValue) {
          ensureTable(table)
          const row = await client.request(`${table}.get`, keyParams(table, idValue))
          return (row ?? null) as never
        },
        async create(table, values) {
          ensureTable(table)
          // worker 的写协议是 { data }，不是裸对象
          return (await client.request(`${table}.create`, { data: values })) as never
        },
        async update(table, idValue, patch) {
          ensureTable(table)
          const res = await client.request<{ changes: number }>(`${table}.update`, {
            ...keyParams(table, idValue),
            data: patch
          })
          return { changes: res?.changes ?? 0 }
        },
        async remove(table, idValue) {
          ensureTable(table)
          const res = await client.request<{ deleted: boolean }>(`${table}.delete`, keyParams(table, idValue))
          return { deleted: Boolean(res?.deleted) }
        },
        async backup(reason) {
          const res = await client.backup(reason)
          return { path: res.path }
        },
        async dispose() {
          entries.delete(id)
          try {
            await client.dispose()
          } catch {
            // 关闭失败不影响停用流程
          }
        }
      }

      entries.set(id, { api, client })
      return api
    },

    async disposeAll() {
      for (const { client } of entries.values()) {
        try {
          await client.dispose()
        } catch {
          // 退出路径上不阻塞
        }
      }
      entries.clear()
    }
  }
}
