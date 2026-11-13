// test/fixtures/service-plugin.cjs —— B3 子进程服务代理验收插件
// 激活后暴露 read()，内部通过 ctx.services.kv 走宿主 RPC。
module.exports = {
  activate(ctx) {
    // SDK v1 最小面：onDispose / jobs.timeout / jobs.count 必须存在
    ctx.onDispose(() => {})
    ctx.jobs.timeout(1000, () => {})
    if (typeof ctx.jobs.count() !== 'number') throw new Error('jobs.count 不可用')
    ctx.registerIpc('read', async () => await ctx.services.kv.get('k'))
    ctx.registerIpc('write', async () => await ctx.services.kv.set('k', 'v'))
  }
}
