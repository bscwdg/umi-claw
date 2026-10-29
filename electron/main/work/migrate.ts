// work/migrate.ts —— work.db → plugins/work/data.db 的一次性导入（Phase 2 / D2）
//
// 通用逻辑在 `electron/main/pluginDataImport.ts`；这里只固定 work 的表清单与排除项。
// 历史（对抗验收 A2/A3/A5）修掉的三处问题都在通用实现里：
//   - 错误分类：只有明确的「没有这张表/方法」才跳过；
//   - upsert：中断后重跑不会主键冲突；
//   - 分页：worker 单次 5000 行上限，按页拉满。

import {
  HOST_APP_META_PREFIXES,
  WORK_TABLES,
  importTableData,
  type ImportResult,
  type ImportTarget,
  type LegacyReader
} from '../pluginDataImport'

export type { ImportResult, ImportTarget, LegacyReader }

export async function importWorkDataIfNeeded(options: {
  source: LegacyReader
  target: ImportTarget
  pluginDataDir: string
  pageSize?: number
  logger?: (line: string) => void
}): Promise<ImportResult> {
  return importTableData({
    ...options,
    tables: WORK_TABLES,
    skipKeyPrefixes: HOST_APP_META_PREFIXES
  })
}
