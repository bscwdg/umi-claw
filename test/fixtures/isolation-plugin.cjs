// test/fixtures/isolation-plugin.cjs —— B1 子进程协议验收用的最小 CJS 插件
// 故意不走 plugins/ 扫描：它只验证 child entry 的 init/activate/registerIpc/jobs/deactivate。
let ticks = 0
module.exports = {
  activate(ctx) {
    ctx.registerIpc('ping', (payload) => ({
      pong: true,
      echo: payload ?? null,
      host: ctx.host,
      pluginId: ctx.pluginId
    }))
    ctx.jobs.every(60_000, () => {
      ticks += 1
    }, { name: 'fixture-tick' })
    return () => {
      // 清理回调必须能被子进程 deactivate 执行
    }
  },
  deactivate() {
    ticks = 0
  }
}
