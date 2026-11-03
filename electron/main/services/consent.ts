// electron/main/services/consent.ts —— 用户协议共识服务（宿主单源）
//
// 为什么要独立成服务：
//   协议闸门是**产品级**的，不应随某个插件的启停而消失。此前它绑在 work 插件的
//   wizardManager 上：work 停用 → `work:wizard:status` 没有 handler → 渲染端
//   `No handler registered`，且 `assertConsent()` 的回落逻辑会在「插件库没有但宿主库有」
//   时放行，导致**撤销同意失效**（真实缺陷，非潜在风险）。
//
// 现在的口径：
//   1. **宿主库是唯一权威**（`<dataDir>/work.db` 的 app_meta），键名沿用
//      `wizard_consent` / `wizard_consent_at`，升级用户的历史数据天然有效。
//   2. **插件库只作为迁移来源**，只在「宿主库尚无结论 + 无墓碑」时读一次。
//   3. **撤销写墓碑** `consent_revoked_at`：一旦撤销，任何迁移都不再把它复活（P1）。
//   4. 迁移是**幂等**的：宿主库已有结论就跳过。
//
// 为什么不做双写：双写必然再次出现「两个库状态不一致」，而这次缺陷正是这么来的。

import { AppError, ERROR_CODES } from './errors'

/** 能读写 app_meta 的最小接口（宿主 DatabaseClient 与 PluginDbApi 都满足） */
export interface ConsentStoreLike {
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<unknown>
}

/** 与既有数据兼容的键名（沿用 3.0 起的命名，不迁移键） */
export const CONSENT_KEYS = {
  GRANTED: 'wizard_consent',
  GRANTED_AT: 'wizard_consent_at',
  /** 撤销墓碑：存在即表示用户明确撤销过，迁移不得复活 */
  REVOKED_AT: 'consent_revoked_at'
} as const

export const CONSENT_GRANTED = 'granted'

export interface ConsentStatus {
  consent: boolean
  consentAt: number | null
  /** 撤销墓碑时间（非 null 表示撤销过） */
  revokedAt: number | null
}

export interface ConsentServiceDeps {
  /** 权威存储（宿主库）。返回 null 表示库还没就绪 */
  hostDb: () => ConsentStoreLike | null
  /** 迁移来源（插件库）。仅在 work 启用时提供，避免为了读开关建库 */
  pluginDb: () => ConsentStoreLike | null
  now: () => number
  logger?: (message: string) => void
}

export interface MigrateResult {
  /** 是否真的写入宿主库 */
  migrated: boolean
  /** 跳过原因（migrated=false 时给出） */
  skipped?: 'tombstone' | 'host-already-decided' | 'no-source' | 'plugin-db-unavailable'
}

export interface ConsentService {
  status(): Promise<ConsentStatus>
  grant(): Promise<{ consent: true; consentAt: number }>
  revoke(): Promise<{ consent: false }>
  /** 启动闸门：未同意则抛 VALIDATION_ERROR（reason: 'consent-required'） */
  ensure(): Promise<void>
  /** 从插件库单向迁移（幂等；有墓碑时不复活） */
  migrateFromPluginDb(): Promise<MigrateResult>
}

export function createConsentService(deps: ConsentServiceDeps): ConsentService {
  const log = deps.logger ?? ((m: string) => console.log(m))

  const requireHost = (): ConsentStoreLike => {
    const db = deps.hostDb()
    if (!db) throw new Error('宿主数据库尚未初始化，无法判定用户协议状态')
    return db
  }

  async function readStatus(): Promise<ConsentStatus> {
    const db = deps.hostDb()
    if (!db) return { consent: false, consentAt: null, revokedAt: null }

    const raw = await db.metaGet(CONSENT_KEYS.GRANTED)
    const atRaw = await db.metaGet(CONSENT_KEYS.GRANTED_AT)
    const revokedRaw = await db.metaGet(CONSENT_KEYS.REVOKED_AT)

    const granted = raw === CONSENT_GRANTED
    const revokedAt = Number(revokedRaw ?? 0) || null

    return {
      consent: granted,
      consentAt: granted ? Number(atRaw ?? 0) || null : null,
      revokedAt
    }
  }

  return {
    async status() {
      return readStatus()
    },

    async grant() {
      const db = requireHost()
      const prev = Number((await db.metaGet(CONSENT_KEYS.GRANTED_AT)) ?? 0) || 0
      // 重复同意保留首次时间（与 wizardManager 同口径）
      const at = prev || deps.now()
      await db.metaSet(CONSENT_KEYS.GRANTED, CONSENT_GRANTED)
      await db.metaSet(CONSENT_KEYS.GRANTED_AT, String(at))
      // 重新同意时清掉墓碑：用户明确回到了同意状态
      await db.metaSet(CONSENT_KEYS.REVOKED_AT, null)
      return { consent: true, consentAt: at }
    },

    async revoke() {
      const db = requireHost()
      await db.metaSet(CONSENT_KEYS.GRANTED, null)
      await db.metaSet(CONSENT_KEYS.GRANTED_AT, null)
      // 墓碑：否则下次迁移会把插件库里的旧 granted 搬回来（P1）
      await db.metaSet(CONSENT_KEYS.REVOKED_AT, String(deps.now()))

      // 双保险：work 启用且库可开时，顺手清掉插件库里的旧键，
      // 免得将来有人绕过墓碑直接读插件库
      try {
        const plugin = deps.pluginDb()
        if (plugin) {
          await plugin.metaSet(CONSENT_KEYS.GRANTED, null)
          await plugin.metaSet(CONSENT_KEYS.GRANTED_AT, null)
        }
      } catch (e) {
        log(`[consent] 清理插件库旧键失败（墓碑已写，不影响撤销）: ${(e as Error)?.message ?? e}`)
      }

      return { consent: false }
    },

    async ensure() {
      const { consent } = await readStatus()
      if (!consent) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          '请先同意用户协议，再启动 OpenClaw',
          { reason: 'consent-required' }
        )
      }
    },

    async migrateFromPluginDb() {
      const host = deps.hostDb()
      if (!host) return { migrated: false, skipped: 'host-already-decided' }

      // 1) 墓碑优先：撤销过就不再复活（P1）
      const revokedRaw = await host.metaGet(CONSENT_KEYS.REVOKED_AT)
      if (Number(revokedRaw ?? 0) > 0) {
        return { migrated: false, skipped: 'tombstone' }
      }

      // 2) 宿主已有结论就跳过
      const hostRaw = await host.metaGet(CONSENT_KEYS.GRANTED)
      if (hostRaw !== null) {
        return { migrated: false, skipped: 'host-already-decided' }
      }

      // 3) 读插件库（work 未启用时调用方给 null，不建库）
      let plugin: ConsentStoreLike | null = null
      try {
        plugin = deps.pluginDb()
      } catch (e) {
        log(`[consent] 插件库不可用，跳过迁移: ${(e as Error)?.message ?? e}`)
      }
      if (!plugin) return { migrated: false, skipped: 'plugin-db-unavailable' }

      const pluginRaw = await plugin.metaGet(CONSENT_KEYS.GRANTED)
      if (pluginRaw !== CONSENT_GRANTED) {
        return { migrated: false, skipped: 'no-source' }
      }

      const pluginAt = Number((await plugin.metaGet(CONSENT_KEYS.GRANTED_AT)) ?? 0) || null
      await host.metaSet(CONSENT_KEYS.GRANTED, CONSENT_GRANTED)
      if (pluginAt) await host.metaSet(CONSENT_KEYS.GRANTED_AT, String(pluginAt))
      log(`[consent] 已从插件库迁移历史同意状态（${pluginAt ?? '无时间'}）`)
      return { migrated: true }
    }
  }
}
