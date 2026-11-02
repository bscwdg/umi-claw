// marketing/database.ts —— marketing 域对数据库的最小依赖面（Phase 3 装箱）
//
// 与 work/database.ts 同一个套路：Manager 不再绑死 DatabaseClient 类，
// 装箱后注入「插件库适配器」即可，Manager 本身一行不用改。

export interface MarketingDatabase {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
}
