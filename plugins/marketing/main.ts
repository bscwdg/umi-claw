// plugins/marketing/main.ts —— 营销域插件（Phase 3）
//
// 装配顺序：插件库 migrate → createMarketingRuntime → 注册 marketing:* / advisor / scan / content / hot 通道。
// 默认启用（承接 3.0/2.0 已有功能；用户可在能力中心关闭）。

import type { PluginContext } from '../../electron/main/kernel'
import { definePlugin } from '../../electron/main/kernel'
import { createMarketingRuntime, type MarketingRuntime } from '../../electron/main/marketing/runtime'
import { setChannelRegistrar } from '../../electron/main/ipc/channelRegistrar'
import { registerMarketingIpc } from '../../electron/main/ipc/marketing'
import { registerAdvisorIpc } from '../../electron/main/ipc/advisor'
import { registerScanIpc } from '../../electron/main/ipc/scan'
import { registerContentIpc } from '../../electron/main/ipc/content'
import { registerHotIpc } from '../../electron/main/ipc/hot'
import { registerMarketingGatewayIpc } from '../../electron/main/ipc/gateway'
import {
  abortAllAdvisorStreams,
  abortAllContentGenerations,
  abortAllScanStreams
} from '../../electron/main/ipc'
import { join } from 'node:path'
import { resolvePdfjsAssets } from '../../electron/main/work/parsers/pdfjsAssets'
import { buildOpenClawGateway } from './gatewayAdapter'
import { importTableData, MARKETING_TABLES, HOST_APP_META_PREFIXES } from '../../electron/main/pluginDataImport'

let runtime: MarketingRuntime | null = null

/** 停用/清理时统一收尾：在途 collector、Advisor/扫描件/内容生成的 SSE 全部中止 */
function stopBackgroundWork(marketing: MarketingRuntime): void {
  const attempt = (label: string, fn: () => number): void => {
    try {
      const n = fn()
      if (n > 0) console.log(`[marketing] 停用：已中止 ${n} 个${label}`)
    } catch (e) {
      console.warn(`[marketing] 停用中止${label}失败：`, (e as Error)?.message ?? e)
    }
  }
  attempt('热点采集', () => marketing.hot.cancelActiveCollectors())
  attempt('Advisor 流', () => abortAllAdvisorStreams())
  attempt('扫描件识别', () => abortAllScanStreams())
  attempt('内容生成', () => abortAllContentGenerations())
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
      // 栅格化前预检：没配多模态模型就直接返回，别先花几秒解码 PDF（Phase 4 审查 #7）
      multimodalConfigured: ctx.services.hostOps
        ? () => ctx.services.hostOps!.isMultimodalConfigured()
        : undefined,
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

    // 激活后立刻尝试一次（不阻塞激活：失败只记日志）
    void marketing.hot.tickDue().catch(() => undefined)

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
      // marketing:gateway:* 也归本插件（宿主不再代劳，停用即摘）
      registerMarketingGatewayIpc(buildOpenClawGateway(openclaw))
    } catch (e) {
      setChannelRegistrar(null)
      throw e
    }

    // 热点后台采集：60s 一轮，随插件启停（宿主不再持有定时器）
    ctx.jobs.every(
      60_000,
      async () => {
        try {
          const summary = await marketing.hot.tickDue()
          if (summary) {
            ctx.logger.info(`[hot] 定时采集 total=${summary.topicsTotal} +${summary.inserted}`)
          }
        } catch (e) {
          ctx.logger.warn('[hot] 定时采集失败', { message: (e as Error)?.message ?? String(e) })
        }
      },
      { name: 'hot-tick' }
    )

    // 系统唤醒后立即补一轮（宿主把 powerMonitor.resume 广播成 onResume）
    const offResume = ctx.host.onResume?.(() => {
      void marketing.hot.tickDue().catch((e) => ctx.logger.warn('[hot] 唤醒补采失败', { message: String(e) }))
    })
    if (offResume) ctx.onDispose(offResume)

    // 注册阶段结束：复位注册器，避免宿主后续注册自己的通道时被劫持（审查 P0#1）
    setChannelRegistrar(null)

    runtime = marketing
    ctx.logger.info(`营销域就绪（库 ${db.path}）`)

    return () => {
      // 停用要把后台任务一起收掉：collector 最长 45s、SSE 还在烧 token，
      // 而通道已摘除（用户连停止按钮都点不了）——必须先 abort 再让内核 dispose 库（审查 #5）。
      stopBackgroundWork(marketing)
      runtime = null
      setChannelRegistrar(null)
    }
  },
  deactivate() {
    if (runtime) stopBackgroundWork(runtime)
    runtime = null
    setChannelRegistrar(null)
  }
})
