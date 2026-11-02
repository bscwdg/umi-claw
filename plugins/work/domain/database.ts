// work/database.ts —— work 域对数据库的最小依赖面（Phase 2 装箱）
//
// 17 个 Manager 只用到 `database.request(method, params)`。把它们从具体的
// `DatabaseClient` 类解耦出来有两个好处：
//   1. 装箱后可以注入「插件库适配器」（ctx.services.db + request 逃生门），一行 Manager 不用改；
//   2. Manager 单测不用再构造/桩一个 34 个成员的类。
//
// 注意：`DatabaseClient` 结构性满足本接口，未装箱时直接传实例即可。

export interface WorkDatabase {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** app_meta 读写（提醒时刻、外发开关等偏好都落在 app_meta） */
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
}
