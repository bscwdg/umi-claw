// plugins/work/main.ts —— 工作域插件（Phase 2）
//
// 装配顺序：插件库 migrate → createWorkRuntime（宿主注入 db/gateway/副作用）
//          → 注册 work:* 通道（走 ctx.registerChannelIpc，停用即摘除）。
//
// 数据边界：Phase 2 首批仍用宿主 work.db（voice 也绑在这个库上），
// 由宿主以 `ctx.services.db` 注入；下一步切到 `<dataDir>/plugins/work/data.db`。

import { definePlugin, type PluginContext } from '../../electron/main/kernel'
import { createWorkRuntime, type WorkRuntime } from './domain/runtime'
import { registerWorkIpc, setWorkIpcRegistrar, type WorkIpcDeps } from './main/ipc/work'
import { resolvePdfjsAssets } from '../../electron/main/services/knowledge/parsers/pdfjsAssets'
import { importWorkDataIfNeeded } from './domain/migrate'
import { clearLegacyImportRetry, registerLegacyImportRetry } from '../../electron/main/services/pluginDataImport'
import type { GatewayClient } from '../../electron/main/gatewayClient'
import { join } from 'node:path'

let runtime: WorkRuntime | null = null

/** 宿主（main）在过渡期用它读向导状态；装箱完成后删除 */
export function getWorkRuntime(): WorkRuntime | null {
  return runtime
}

/**
 * OpenClaw 服务 → GatewayClient 形状。
 *
 * 全应用只有一个 GatewayClient（宿主持有），这里只是把窄接口适配回 Manager 认识的结构；
 * 插件拿不到 token，也控制不了网关进程。
 */
function gatewayAdapter(openclaw: NonNullable<PluginContext['services']['openclaw']>): GatewayClient {
  return {
    getStatus: () => openclaw.status(),
    ensureReady: () => openclaw.ensureReady(),
    chat: async (input) => {
      const started = Date.now()
      const res = await openclaw.chat(input)
      return {
        text: res.text,
        chunks: 0,
        usage: null,
        // model 必须透传：报告落库的 generation_context.model 依赖它（审查 P2 附注）
        model: res.model ?? null,
        aborted: false,
        ms: Date.now() - started
      }
    },
    createChatStream: (input) => {
      const handle = openclaw.stream(input)
      return {
        iterator: handle.iterator,
        result: handle.result.then((r) => ({
          text: r.text,
          chunks: r.chunks,
          usage: null,
          model: null,
          aborted: r.aborted,
          ms: 0
        })),
        cancel: () => handle.cancel()
      }
    }
  } as unknown as GatewayClient
}

/**
 * 停用/退出时中止 work 域在途的模型调用。
 *
 * 为什么必须有：通道被摘掉后 SSE 流不会自己停，上游仍在产出 token（用户看不到，但仍在继续烧）。
 * marketing 早就有同类 `stopBackgroundWork`；work 之前只 `reminder.stop()`（4.0.1 P1 修项）。
 */
function stopBackgroundWork(work: WorkRuntime): void {
  const attempt = (label: string, fn: () => number): void => {
    try {
      const n = fn()
      if (n > 0) console.log(`[work] 停用：已中止 ${n} 个${label}`)
    } catch (e) {
      console.warn(`[work] 停用中止${label}失败：`, (e as Error)?.message ?? e)
    }
  }
  work.reminder.stop()
  attempt('问答流', () => work.qa.abortAll())
  attempt('工具调用', () => work.tools.abortAll())
  attempt('日报生成', () => work.reports.abortAll())
  attempt('OpenClaw 总结', () => work.openclawSummary.abortAll())
}

export default definePlugin({
  async activate(ctx) {
    const db = ctx.services.db
    const openclaw = ctx.services.openclaw
    const hostOps = ctx.services.hostOps
    // 用户协议（4.1.1 宿主单源）：插件经 ctx 读写，不碰自己的 app_meta。
    // 未注入时 WizardManager 回落自身 db（保持直接构造 Manager 的测试用法）。
    const consent = ctx.services.consent
    if (!db || !openclaw || !hostOps) {
      throw new Error('work 插件缺少必需服务（db / openclaw / hostOps）')
    }

    await db.migrate()

    const work = createWorkRuntime({
      database: db,
      gateway: gatewayAdapter(openclaw),
      dataDir: ctx.host.dataDir,
      pdfjsAssets: resolvePdfjsAssets({
        isPackaged: ctx.host.paths.isPackaged,
        appPath: ctx.host.paths.appPath,
        resourcesPath: ctx.host.paths.resourcesPath
      }),
      logger: (m) => ctx.logger.info(m),
      notifier: (id, payload) => hostOps.notify(id, payload),
      pusher: (id, payload, dest) => hostOps.push(id, payload, dest) as never,
      listPushChannels: async () => (await hostOps.listPushChannels()) as never,
      listPushTargets: async (channel) => (await hostOps.listPushTargets(channel)) as never,
      locateOldDbs: () => hostOps.locateOldDbs() as never,
      readOldDb: async (info) => (await hostOps.readOldDb(info)) as never,
      consent: consent ?? undefined
    })

    // work:* 通道交给插件注册器：停用插件时由内核统一摘除
    setWorkIpcRegistrar({
      handle: (channel, fn) =>
        ctx.registerChannelIpc(channel, (_payload, _event, args) => fn(...((args ?? []) as unknown[]))),
      handleEvent: (channel, fn) =>
        ctx.registerChannelIpc(channel, (_payload, event, args) =>
          fn(event as never, ...((args ?? []) as unknown[]))
        )
    })

    try {
      registerWorkIpc(work as unknown as WorkIpcDeps)
    } catch (e) {
      // 中途失败：把模块级 registrar 复位，避免残留指向已关闭的 ctx（审查 P2-12）
      setWorkIpcRegistrar(null)
      throw e
    }
    runtime = work

    // 旧库数据一次性导入（只读宿主 work.db → 插件库）：后台跑，失败不写标记、下次启动重试
    const legacy = ctx.services.legacyDb
    if (legacy) {
      const runLegacyImport = (force = false) =>
        importWorkDataIfNeeded({
          source: { request: (method, params) => legacy.list(method.split('.')[0], params) },
          target: db,
          pluginDataDir: join(ctx.host.dataDir, 'plugins', 'work'),
          force,
          logger: (line) => ctx.logger.info(line)
        })
      void runLegacyImport().catch((e) => ctx.logger.warn('旧库数据导入失败（可点顶部横幅重试）', e))
      // 4.0.2 P2：宿主的「重试导入」按钮经 services 注册表调到这里
      registerLegacyImportRetry('work', async () => {
        const result = await runLegacyImport(true)
        ctx.logger.info('旧库数据导入重试完成：' + JSON.stringify(result.counts))
      })
      // 激活失败时内核只跑 disposers（不调 deactivate）：必须靠 onDispose 摘掉执行器
      ctx.onDispose(() => clearLegacyImportRetry('work'))
    }

    // 提醒循环属于域行为：随插件启停（30s 检查、到点通知/外发、日报草稿）
    work.reminder.start()
    ctx.logger.info(`工作域就绪（库 ${db.path}）`)

    return () => {
      clearLegacyImportRetry('work')
      stopBackgroundWork(work)
      runtime = null
      setWorkIpcRegistrar(null)
    }
  },
  deactivate() {
    try {
      // 正常启停路径由 activate 返回的 cleanup 覆盖（先 rollback 再 deactivate，cleanup 已置空）；
      // 这里只兜「激活超时/异常后被停用」等 cleanup 未跑到的路径。
      if (runtime) stopBackgroundWork(runtime)
    } catch {
      // 停用路径上不阻塞
    }
    clearLegacyImportRetry('work')
    runtime = null
    setWorkIpcRegistrar(null)
  }
})
