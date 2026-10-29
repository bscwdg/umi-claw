// plugins/hello/main.ts —— Phase 0 契约演示插件（main 侧）
//
// 验证点：manifest 校验、activate、注册 IPC、注册定时任务、停用时全部回收。
// 只从 kernel 取类型与 definePlugin，不 import electron。

import { definePlugin } from '../../electron/main/kernel'

export default definePlugin({
  activate(ctx) {
    ctx.registerIpc('ping', (payload) => ({
      pong: true,
      echo: payload ?? null,
      at: Date.now()
    }))

    ctx.registerIpc('state', () => ({
      id: ctx.id,
      version: ctx.version,
      hostVersion: ctx.host.version,
      jobs: ctx.jobs.count()
    }))

    // 周期任务：停用后必须被清掉（验收断言 jobCount 归零、不再触发）
    ctx.jobs.every(60_000, () => ctx.logger.info('hello tick'), { name: 'hello-tick' })

    ctx.logger.info('已激活（注册 2 条 IPC + 1 个定时任务）')

    return () => ctx.logger.info('activate 返回的 cleanup 已执行')
  },
  deactivate() {
    // 这里没有外部资源要释放；留作契约示例（在注册物清理之后调用）
  }
})
