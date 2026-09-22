// migration.ts —— 基于 PRAGMA user_version 的顺序迁移（不另建版本表）
//
// 基线：PLAN-3.0.md §三「核心数据模型」——结构迁移用 PRAGMA user_version（初始 1），
// migration.ts 顺序升级。DDL 的真实来源是 schema.ts，本文件只负责「版本 → 语句」编组。
//
// 执行位置：DDL 由主进程侧的 database.ts 通过 `migrate` 方法交给 db-worker.mjs 执行
// （Worker 不内置 DDL，保证 schema.ts 是单一真相来源；IPC 层不转发 migrate）。

import { SCHEMA_VERSION, SCHEMA_STATEMENTS, INDEX_STATEMENTS } from './schema'

export interface MigrationStep {
  /** 目标 user_version（正整数） */
  version: number
  /** 步骤名（写入 Worker 返回的 applied 列表，便于排障） */
  name: string
  /** 顺序执行的 SQL 语句（在单个事务内执行，失败整体回滚） */
  statements: string[]
}

/**
 * 顺序迁移步骤表。**只增不改**：已发布版本的 step 不允许再修改语句，
 * 后续结构变化一律追加新 step（如 user_version=2 的 FTS5 + trigram）。
 */
export const MIGRATION_STEPS: MigrationStep[] = [
  {
    version: 1,
    name: 'init: 8 表 + 索引',
    statements: [...SCHEMA_STATEMENTS, ...INDEX_STATEMENTS]
  }
]

/** 当前应用期望的 Schema 版本 */
export const TARGET_USER_VERSION = SCHEMA_VERSION

/** 从 from 版本起需要执行的步骤（升序） */
export function pendingSteps(from: number): MigrationStep[] {
  const current = Number.isFinite(from) ? Math.floor(from) : 0
  return MIGRATION_STEPS.filter((s) => s.version > current).sort((a, b) => a.version - b.version)
}
