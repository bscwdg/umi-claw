// templates/plugin/main.ts —— 最小插件模板（只依赖公开 SDK）
//
// 复制到 plugins/<id>/main.ts 后改 id / 名称；不要直接 import electron/main 或宿主内部模块。
// 公开面见 doc/PLUGIN-API.md；这个模板只用 registerIpc + jobs，最稳。

import { definePlugin } from '../../plugin-sdk/src/public'

export default definePlugin({
  async activate(ctx) {
    ctx.registerIpc('ping', async (payload) => ({
      ok: true,
      data: { pong: true, echo: payload ?? null }
    }))
    ctx.jobs.every(60_000, async () => ctx.logger.info('template tick'), { name: 'template-tick' })
    return () => ctx.logger.info('template cleanup')
  }
})
