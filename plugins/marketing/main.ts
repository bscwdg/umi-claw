// plugins/marketing/main.ts —— 营销域插件（Phase 3）
//
// 装配顺序：插件库 migrate → createMarketingRuntime → 注册 marketing:* / advisor / scan / content / hot 通道。
// 默认**不启用**（PLAN 决策：营销域是可选重负载插件，默认关，用户在能力中心开启）。

import type { PluginContext } from '../../electron/main/kernel'
import { definePlugin } from '../../electron/main/kernel'
import { createMarketingRuntime, type MarketingRuntime } from '../../electron/main/marketing/runtime'
import { setChannelRegistrar } from '../../electron/main/ipc/channelRegistrar'
import { registerMarketingIpc } from '../../electron/main/ipc/marketing'
import { registerAdvisorIpc } from '../../electron/main/ipc/advisor'
import { registerScanIpc } from '../../electron/main/ipc/scan'
import { registerContentIpc } from '../../electron/main/ipc/content'
import { registerHotIpc } from '../../electron/main/ipc/hot'
import { join } from 'node:path'
import { resolvePdfjsAssets } from '../../electron/main/work/parsers/pdfjsAssets'
import { buildOpenClawGateway } from './gatewayAdapter'
import { importTableData, MARKETING_TABLES, HOST_APP_META_PREFIXES } from '../../electron/main/pluginDataImport'

let runtime: MarketingRuntime | null = null

/** 宿主在过渡期读取（热点定时采集等）；装箱完成后可删除 */
export function getMarketingRuntime(): MarketingRuntime | null {
  return runtime
}

/**
 * 插件库 API → ipc/marketing.ts 需要的 DatabaseClient 形状。
 *
 * 该文件只用到 dbStatus / ping / metaGet / metaSet / request 五个方法；
 * 其余依赖（project/business/knowledge）都走 Manager，不直接碰库。
 */
function databaseFacade(db: NonNullable<PluginContext['services']['db']>) {
  return {
    dbStatus: async (options?: { initialize?: boolean }) => ({
      path: db.path,
      schemaVersion: 0,
      tableCount: 0,
      initialized: true,
      ...options
    }),
    ping: async () => true,
    metaGet: (key: string) => db.metaGet(key),
    metaSet: (key: string, value: string | null) => db.metaSet(key, value),
    request: (method: string, params?: Record<string, unknown>) => db.request(method, params)
  }
}

export default definePlugin({
  async activate(ctx) {
    const db = ctx.services.db
    const openclaw = ctx.services.openclaw
    if (!db || !openclaw) throw new Error('marketing 插件缺少必需服务（db / openclaw）')

    await db.migrate()

    const runtimeDir = ctx.host.paths.resourcesPath
    const marketing = createMarketingRuntime({
      database: db,
      gateway: buildOpenClawGateway(openclaw),
      dataDir: ctx.host.dataDir,
      pdfjsAssets: resolvePdfjsAssets({
        isPackaged: ctx.host.paths.isPackaged,
        appPath: ctx.host.paths.appPath,
        resourcesPath: ctx.host.paths.resourcesPath
      }),
      nodePath: ctx.host.paths.nodePath,
      collectorScriptPath: `${runtimeDir}/collector/index.mjs`,
      getDailyhotBase: () => ctx.services.config?.get('dailyhotBase') ?? null,
      logger: (m) => ctx.logger.info(m)
    })

    // 旧库数据一次性导入（只读 umi-claw.db → 插件库）：后台跑，失败不写标记
    const legacy = ctx.services.legacyDb
    if (legacy) {
      void importTableData({
        source: { request: (method, params) => legacy.list(method.split('.')[0], params) },
        target: db,
        pluginDataDir: join(ctx.host.dataDir, 'plugins', 'marketing'),
        tables: MARKETING_TABLES,
        skipKeyPrefixes: HOST_APP_META_PREFIXES,
        logger: (line) => ctx.logger.info(line)
      }).catch((e) => ctx.logger.warn('旧库数据导入失败（下次启动重试）', e))
    }

    // 所有 marketing:* 通道走同一注册器：停用插件时由内核统一摘除
    setChannelRegistrar({
      handle: (channel, fn) =>
        ctx.registerChannelIpc(channel, (_payload, _event, args) => fn(...((args ?? []) as unknown[]))),
      handleEvent: (channel, fn) =>
        ctx.registerChannelIpc(channel, (_payload, event, args) =>
          fn(event as never, ...((args ?? []) as unknown[]))
        )
    })

    try {
      const facade = databaseFacade(db) as never
      registerMarketingIpc(
        facade,
        marketing.projects,
        marketing.business,
        marketing.watchlist,
        marketing.knowledge
      )
      registerAdvisorIpc(marketing.advisor)
      registerScanIpc(marketing.scan, marketing.knowledge)
      registerContentIpc(marketing.content)
      registerHotIpc(marketing.hot, marketing.hotScore)
    } catch (e) {
      setChannelRegistrar(null)
      throw e
    }

    runtime = marketing
    ctx.logger.info(`营销域就绪（库 ${db.path}）`)

    return () => {
      runtime = null
      setChannelRegistrar(null)
    }
  },
  deactivate() {
    runtime = null
    setChannelRegistrar(null)
  }
})
