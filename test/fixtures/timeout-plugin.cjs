// test/fixtures/timeout-plugin.cjs —— B4 服务超时探针
module.exports = {
  activate(ctx) {
    ctx.registerIpc('go', async () => await ctx.services.kv.get('k'))
  }
}
