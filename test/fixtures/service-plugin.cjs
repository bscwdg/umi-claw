// test/fixtures/service-plugin.cjs —— B3 子进程服务代理验收插件
// 激活后暴露 read()，内部通过 ctx.services.kv 走宿主 RPC。
module.exports = {
  activate(ctx) {
    ctx.registerIpc('read', async () => await ctx.services.kv.get('k'))
    ctx.registerIpc('write', async () => await ctx.services.kv.set('k', 'v'))
  }
}
