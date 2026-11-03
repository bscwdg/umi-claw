// electron/main/services/dbTypes.ts —— 数据库相关的共享类型（4.2 B4）
//
// 为什么单独一个文件：marketing 的 IPC 层需要 `DatabaseClient` 的几个方法签名，
// 那是宿主 database/database.ts 的类类型——插件按契约不能直接 import 它。
// 这里给出**结构化的窄接口**（只含实际用到的 5 个方法）+ 两个返回类型。
//
// 纯类型文件，不含运行时值。

/** PRAGMA / 表清单等诊断信息（与 database.ts 的同名类型保持字段一致） */
export interface DatabaseStatus {
  ready: boolean
  dbPath: string
  backupDir: string
  userVersion: number | null
  tables: string[]
  indexes: string[]
  journalMode: string | null
  foreignKeys: boolean | null
  sqliteVersion: string | null
  workerPid: number | null
  pendingRequests: number
  migrated: boolean
}

export interface BackupResult {
  path: string
  size: number
  reason: string
  pruned: string[]
}

/**
 * 插件侧使用的数据库窄接口（4.2 B4）。
 *
 * 只声明营销 IPC 层真正调用的方法（实测：dbStatus / ping / metaGet / metaSet / backup）。
 * 用它替代 `DatabaseClient` 类类型：插件不依赖宿主的类实现细节，也能注入 fake。
 */
export interface DatabaseLike {
  dbStatus(options?: { initialize?: boolean }): Promise<DatabaseStatus>
  ping(): Promise<boolean>
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
  backup(reason: string): Promise<BackupResult>
}
