// plugins/hello/main.ts —— Phase 0/1 契约演示插件（main 侧）
//
// 验证点：manifest 校验、activate、注册 IPC、注册定时任务、**按 inject 拿服务**、
// 停用时全部回收。只从 kernel 取类型与 definePlugin，不 import electron / 任何 manager。

import { definePlugin } from '../../electron/main/kernel'

export default definePlugin({
  activate(ctx) {
    // 注入的服务：manifest.inject 里声明了 config 才有；没声明这里就是 undefined
    const config = ctx.services.config
    const activations = (config?.get<number>('activations', 0) ?? 0) + 1
    config?.set('activations', activations)

    ctx.registerIpc('ping', (payload) => ({
      pong: true,
      echo: payload ?? null,
      at: Date.now()
    }))

    ctx.registerIpc('state', () => ({
      id: ctx.id,
      version: ctx.version,
      hostVersion: ctx.host.version,
      jobs: ctx.jobs.count(),
      activations: config?.get<number>('activations', 0) ?? null,
      services: Object.keys(ctx.services).sort()
    }))

    // 周期任务：停用后必须被清掉（验收断言 jobCount 归零、不再触发）
    ctx.jobs.every(60_000, () => ctx.logger.info('hello tick'), { name: 'hello-tick' })

    ctx.logger.info(`已激活（第 ${activations} 次；服务：${Object.keys(ctx.services).join(',') || '无'}）`)

    return () => ctx.logger.info('activate 返回的 cleanup 已执行')
  },
  deactivate() {
    // 这里没有外部资源要释放；留作契约示例（在注册物清理之后调用）
  }
})
