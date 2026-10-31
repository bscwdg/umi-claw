// openclaw.json 的「legacy webhook 迁移」完成标记维护
//
// 背景（2026-10 启动慢专项）：
//   OpenClaw 启动时的 startup-config-preflight 会检查
//   `meta.migrations.webhookListeners`；只要不是 `true`（且历史渠道没逐个登记）就会重新跑
//   `HISTORICAL_WEBHOOK_CHANNELS`（telegram / feishu / msteams / nextcloud-talk）的迁移，
//   而迁移要动态加载这些插件的 doctor 契约。
//
//   实测在 Windows 上（无符号链接权限、插件文件被安全软件/复制过程占用）该加载会失败：
//     [plugins/doctor-contracts] failed ... EPERM: operation not permitted, symlink ...
//     [plugins/doctor-contracts] failed ... copy path changed during operation
//   迁移带 warning 抛错 → OpenClaw **不会**写入完成标记 → 每次启动重跑，单次约 3 分钟。
//
//   OpenClaw 对「配置由外部程序管理」的场景，官方要求由外部程序写入该标记
//   （源码提示：Add the required legacyWebhook endpoints and
//    meta.migrations.webhookListeners completion marker in that source, then restart.）。
//   本应用就是 openclaw.json 的外部管理者，因此在这里兜底补齐。
//
// 说明：补标记只跳过「历史 webhook listener 迁移」，不会跳过其它迁移
// （modelPolicyAllowlist / utilityModelSeparation 等仍由 OpenClaw 自己记录）。
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

export type JsonRecord = Record<string, unknown>

/** 官方 startup-config-preflight 里使用的完成标记键 */
export const WEBHOOK_MIGRATION_FLAG = 'webhookListeners'

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 是否已完成 legacy webhook 迁移（官方口径：meta.migrations.webhookListeners === true） */
export function hasWebhookMigrationMarker(config: unknown): boolean {
  if (!isRecord(config)) return false
  const meta = config.meta
  if (!isRecord(meta)) return false
  const migrations = meta.migrations
  if (!isRecord(migrations)) return false
  return migrations[WEBHOOK_MIGRATION_FLAG] === true
}

/**
 * 就地补齐 legacy webhook 迁移完成标记（幂等）。
 *
 * 只增补 `meta.migrations.webhookListeners = true`，不改动其它 meta/迁移键；
 * 已带标记时原样返回（changed=false）。
 */
export function applyWebhookMigrationMarker(config: JsonRecord): {
  config: JsonRecord
  changed: boolean
} {
  if (hasWebhookMigrationMarker(config)) return { config, changed: false }
  const meta = isRecord(config.meta) ? config.meta : {}
  const migrations = isRecord(meta.migrations) ? meta.migrations : {}
  migrations[WEBHOOK_MIGRATION_FLAG] = true
  meta.migrations = migrations
  config.meta = meta
  return { config, changed: true }
}

export interface EnsureWebhookMarkerResult {
  /** 是否真的改写了文件 */
  changed: boolean
  /** 改写前备份到的路径（仅 changed=true 且备份成功时有值） */
  backupPath?: string
  /** 跳过原因（文件缺失/无法解析等；不抛异常，调用方只需记日志） */
  error?: string
}

/**
 * 对磁盘上的 openclaw.json 补齐标记：先备份原文件，再「临时文件 + rename」原子写回。
 *
 * - 文件不存在（尚未初始化环境）或不是合法 JSON 时不动作，返回 error 供调用方记录；
 * - 备份为 `openclaw.json.webhook-marker-bak.<yyyyMMddHHmmss>`，方便回滚；
 * - 写入保持 2 空格缩进 + 结尾换行，与官方写入器风格一致。
 */
export function ensureWebhookMigrationMarkerFile(
  filePath: string,
  now: () => number = Date.now
): EnsureWebhookMarkerResult {
  try {
    if (!existsSync(filePath)) return { changed: false }
    const raw = readFileSync(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      return { changed: false, error: 'openclaw.json 不是合法 JSON，跳过 webhook 迁移标记补齐' }
    }
    if (!isRecord(parsed)) {
      return { changed: false, error: 'openclaw.json 顶层不是对象，跳过 webhook 迁移标记补齐' }
    }
    const { config, changed } = applyWebhookMigrationMarker(parsed)
    if (!changed) return { changed: false }

    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 14)
    const backupPath = `${filePath}.webhook-marker-bak.${stamp}`
    try {
      copyFileSync(filePath, backupPath)
    } catch {
      // 备份 best-effort：备份失败不阻止修正（原文件内容仍在下面 rename 前的临时文件可追溯）
    }

    const tmpPath = `${filePath}.webhook-marker-tmp-${process.pid}`
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    renameSync(tmpPath, filePath)
    return { changed: true, backupPath }
  } catch (e) {
    return { changed: false, error: (e as Error)?.message || String(e) }
  }
}
