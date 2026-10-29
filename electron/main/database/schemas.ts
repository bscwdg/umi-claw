// schemas.ts —— 多 schema 注册表（4.0 合并期引入，MERGE-INVENTORY R2）
//
// 为什么需要：work 与 marketing 是**两套互斥 schema**（8 表 vs 11 表，只有 app_meta 重叠），
// 且两代都把 user_version=2 用在了不同 DDL 上。数据库层因此必须「每个库一套 schema +
// 一套迁移步骤 + 一套表清单」，而不是把两套 DDL 拼成一份。
//
// 消费者：database.ts（按 schemaId 取 tables / pendingSteps / targetUserVersion）。
// 注意：DDL 仍然只在 schema.ts / marketingSchema.ts 里，是单一真相来源；
// db-worker 只负责执行，不内置 DDL。

import { SCHEMA_TABLES as WORK_TABLES, SCHEMA_VERSION as WORK_SCHEMA_VERSION } from './schema'
import { pendingSteps as workPendingSteps, type MigrationStep } from './migration'
import {
  SCHEMA_TABLES as MARKETING_TABLES,
  SCHEMA_VERSION as MARKETING_SCHEMA_VERSION
} from './marketingSchema'
import {
  pendingSteps as marketingPendingSteps,
  type MigrationStep as MarketingMigrationStep
} from './marketingMigration'

export type SchemaId = 'work' | 'marketing'

export interface DbSchemaProfile {
  /** 内置库是 'work' | 'marketing'；插件库用 plugin:<id> */
  id: string
  /** 人类可读名字（进日志/报错） */
  label: string
  /** 该库应有的表清单（assertSchemaShape 用） */
  tables: readonly string[]
  /** 当前应用支持到的 user_version */
  targetUserVersion: number
  /** from → 待执行步骤（各 schema 自己的顺序） */
  pendingSteps: (from: number) => Array<MigrationStep | MarketingMigrationStep>
  /** 约定的库文件名（仅用于报错文案与默认值） */
  dbFileName: string
}

const WORK: DbSchemaProfile = {
  id: 'work',
  label: '工作域',
  tables: WORK_TABLES,
  targetUserVersion: WORK_SCHEMA_VERSION,
  pendingSteps: workPendingSteps,
  dbFileName: 'work.db'
}

const MARKETING: DbSchemaProfile = {
  id: 'marketing',
  label: '营销域',
  tables: MARKETING_TABLES,
  targetUserVersion: MARKETING_SCHEMA_VERSION,
  pendingSteps: marketingPendingSteps,
  dbFileName: 'umi-claw.db'
}

export const DB_SCHEMAS: Record<SchemaId, DbSchemaProfile> = {
  work: WORK,
  marketing: MARKETING
}

/** 默认 work（3.0 起的主库），未知/缺省一律回落 work */
export function resolveDbSchema(id?: SchemaId): DbSchemaProfile {
  return (id && DB_SCHEMAS[id]) || WORK
}
