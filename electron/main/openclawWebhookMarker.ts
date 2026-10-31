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
//   迁移带 warning 抛错 → 完成标记写不进去 → 每次启动重跑，单次约 3 分钟。
//
//   OpenClaw 对「配置由外部程序管理」的场景，官方提示原文是：
//     Add the required legacyWebhook endpoints **and** meta.migrations.webhookListeners
//     completion marker in that source, then restart.
//   —— 也就是说：只有在**没有 legacyWebhook 端点需要迁移**时，才能只补完成标记。
//   因此本模块先扫描 4 个历史渠道的配置；一旦发现 legacyWebhook，就跳过补标记，
//   交回 OpenClaw 官方迁移（避免静默跳过用户真实需要的 webhook pin）。
//
// 补标记只跳过「历史 webhook listener 迁移」，不会跳过其它迁移
// （modelPolicyAllowlist / utilityModelSeparation 等仍由 OpenClaw 自己记录）。
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

export type JsonRecord = Record<string, unknown>

/** 官方 startup-config-preflight 里使用的完成标记键 */
export const WEBHOOK_MIGRATION_FLAG = 'webhookListeners'

/** 官方 legacy-webhook-pins 里的历史渠道清单（仅这些渠道有 legacyWebhook 概念） */
export const HISTORICAL_WEBHOOK_CHANNELS = [
  'telegram',
  'feishu',
  'msteams',
  'nextcloud-talk'
] as const

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深度扫描是否包含指定键（legacyWebhook 可能出现在 accounts.<id> 下） */
function containsKeyDeep(value: unknown, key: string, depth = 0): boolean {
  if (depth > 8) return false
  if (Array.isArray(value)) return value.some((v) => containsKeyDeep(v, key, depth + 1))
  if (!isRecord(value)) return false
  for (const [k, v] of Object.entries(value)) {
    if (k === key) return true
    if (containsKeyDeep(v, key, depth + 1)) return true
  }
  return false
}

/**
 * 找出配置里仍带 legacyWebhook 的历史渠道 id。
 *
 * 官方 `applyHistoricalWebhookPins` 会把这些 legacyWebhook 端点迁移/钉到 Gateway 路由；
 * 只要存在，就不能只补完成标记（否则官方会静默跳过迁移）。
 */
export function findLegacyWebhookChannels(config: unknown): string[] {
  if (!isRecord(config)) return []
  const channels = config.channels
  if (!isRecord(channels)) return []
  const hits: string[] = []
  for (const id of HISTORICAL_WEBHOOK_CHANNELS) {
    const channelConfig = channels[id]
    if (isRecord(channelConfig) && containsKeyDeep(channelConfig, 'legacyWebhook')) hits.push(id)
  }
  return hits
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
 *
 * ⚠️ 调用方必须先确认 `findLegacyWebhookChannels(config)` 为空：
 *    有 legacyWebhook 时要交回 OpenClaw 官方迁移，不能在这里补标记。
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

export interface EnsureWebhookMarkerOptions {
  /** 注入时钟（测试用） */
  now?: () => number
  /**
   * 串行化器：传入 openClawConfigWriter 的 `runSerializedOpenClawConfigWrite`，
   * 让本次写盘与官方 config patch 排队，避免 read-modify-write 与 patch 互相覆盖。
   */
  serialize?: <T>(task: () => Promise<T> | T) => Promise<T>
}

export interface EnsureWebhookMarkerResult {
  /** 是否真的改写了文件 */
  changed: boolean
  /** 改写前备份到的路径（仅 changed=true 且备份成功时有值） */
  backupPath?: string
  /** 跳过原因（文件缺失/无法解析/rename 失败等；不抛异常，调用方只需记日志） */
  error?: string
  /** 检测到 legacyWebhook 的历史渠道：非空表示「保留官方迁移，未补标记」 */
  skippedLegacyChannels?: string[]
}

/** yyyyMMddHHmmss（本地时间，精确到秒；避免 ISO 截断造成的 10 秒桶） */
function formatStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 保留原文件风格：BOM 有无、换行符、结尾是否有换行 */
function detectStyle(raw: string): { bom: boolean; eol: string; trailingEol: boolean } {
  return {
    bom: raw.startsWith('\uFEFF'),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    trailingEol: raw.endsWith('\r\n') || raw.endsWith('\n')
  }
}

function serializeConfig(config: JsonRecord, style: ReturnType<typeof detectStyle>): string {
  const json = JSON.stringify(config, null, 2).replace(/\n/g, style.eol)
  return (style.bom ? '\uFEFF' : '') + json + (style.trailingEol ? style.eol : '')
}

interface WriteOutcome {
  /** 是否走了 rename 失败后的直写回退（仅用于日志/测试观察） */
  fellBackToDirectWrite: boolean
}

/**
 * 落盘：临时文件 + rename；rename 失败（Windows 上被杀软/占用影响）回退直写。
 * finally 里始终清理 tmp，避免只读/占用场景每次启动多一份 `.webhook-marker-tmp-*` 垃圾。
 */
function writeConfigAtomically(filePath: string, content: string): WriteOutcome {
  const tmpPath = `${filePath}.webhook-marker-tmp-${process.pid}`
  let fellBackToDirectWrite = false
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    try {
      renameSync(tmpPath, filePath)
    } catch {
      fellBackToDirectWrite = true
      writeFileSync(filePath, content, 'utf-8')
    }
    return { fellBackToDirectWrite }
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* 清理 best-effort */
    }
  }
}

/**
 * 对磁盘上的 openclaw.json 补齐标记：先备份原文件，再原子写回（失败回退直写）。
 *
 * - 文件不存在（尚未初始化环境）或不是合法 JSON 时不动作，返回 error 供调用方记录；
 * - 检测到 legacyWebhook（telegram/feishu/msteams/nextcloud-talk）时不补标记，
 *   返回 skippedLegacyChannels，交回 OpenClaw 官方迁移；
 * - 备份为 `openclaw.json.webhook-marker-bak.<yyyyMMddHHmmss>`（只在备份成功时返回路径）；
 * - 保留原文件的 BOM / CRLF / 结尾换行风格。
 */
export async function ensureWebhookMigrationMarkerFile(
  filePath: string,
  options: EnsureWebhookMarkerOptions = {}
): Promise<EnsureWebhookMarkerResult> {
  const run = async (): Promise<EnsureWebhookMarkerResult> => {
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

      const legacyChannels = findLegacyWebhookChannels(parsed)
      if (legacyChannels.length > 0) {
        // 官方提示要求「补 legacyWebhook 端点 + 完成标记」双管齐下；我们不写 legacyWebhook，
        // 所以有 legacyWebhook 时只能交回 OpenClaw 自己的迁移，不能强行标记完成。
        return { changed: false, skippedLegacyChannels: legacyChannels }
      }

      const { config, changed } = applyWebhookMigrationMarker(parsed)
      if (!changed) return { changed: false }

      const style = detectStyle(raw)
      const content = serializeConfig(config, style)
      const stamp = formatStamp((options.now ?? Date.now)())

      let backupPath: string | undefined
      const candidateBackup = `${filePath}.webhook-marker-bak.${stamp}`
      try {
        copyFileSync(filePath, candidateBackup)
        backupPath = candidateBackup
      } catch {
        // 备份失败不阻止修正：宁可没有备份，也不谎报「已备份」
      }

      try {
        writeConfigAtomically(filePath, content)
      } catch (e) {
        return { changed: false, backupPath, error: (e as Error)?.message || String(e) }
      }
      return { changed: true, backupPath }
    } catch (e) {
      return { changed: false, error: (e as Error)?.message || String(e) }
    }
  }
  return options.serialize ? options.serialize(run) : run()
}
