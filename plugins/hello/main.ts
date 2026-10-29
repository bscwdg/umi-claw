// plugins/hello/main.ts —— Phase 0/1 契约演示插件（main 侧）
//
// 验证点：manifest 校验、activate、注册 IPC、注册定时任务、按 inject 拿服务
// （config 配置 + db 独立库）、停用时全部回收。
// 只从 kernel 取类型与 definePlugin，不 import electron / 任何 manager。

import { definePlugin } from '../../electron/main/kernel'

export default definePlugin({
  activate: async (ctx) => {
    // 注入的服务：manifest.inject 里声明了才有；没声明这里就是 undefined
    const config = ctx.services.config
    const db = ctx.services.db

    const activations = (config?.get<number>('activations', 0) ?? 0) + 1
    config?.set('activations', activations)

    // 插件自己的库：迁移幂等，库文件在 <dataDir>/plugins/hello/data.db
    if (db) {
      await db.migrate()
      const notes = await db.list('notes')
      ctx.logger.info(`插件库就绪：${db.path}（notes ${notes.length} 条）`)
    }

    ctx.registerIpc('ping', (payload) => ({
      pong: true,
      echo: payload ?? null,
      at: Date.now()
    }))

    ctx.registerIpc('state', async () => ({
      id: ctx.id,
      version: ctx.version,
      hostVersion: ctx.host.version,
      jobs: ctx.jobs.count(),
      activations: config?.get<number>('activations', 0) ?? null,
      services: Object.keys(ctx.services).sort(),
      notes: db ? (await db.list('notes')).length : null
    }))

    ctx.registerIpc('note.add', async (payload) => {
      if (!db) throw new Error('插件未注入 db 服务')
      const body = String((payload as { body?: unknown } | null)?.body ?? '').trim()
      if (!body) throw new Error('body 不能为空')
      const now = Date.now()
      return db.create('notes', { id: `n_${now}_${Math.random().toString(36).slice(2, 8)}`, body, created_at: now, updated_at: now })
    })

    // 周期任务：停用后必须被清掉（验收断言 jobCount 归零、不再触发）
    ctx.jobs.every(60_000, () => ctx.logger.info('hello tick'), { name: 'hello-tick' })

    ctx.logger.info(`已激活（第 ${activations} 次；服务：${Object.keys(ctx.services).join(',') || '无'}）`)

    return () => ctx.logger.info('activate 返回的 cleanup 已执行')
  },
  deactivate() {
    // 这里没有外部资源要释放；留作契约示例（在注册物清理之后调用）
  }
})
