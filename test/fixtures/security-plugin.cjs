// test/fixtures/security-plugin.cjs —— B4 负向隔离探针
// 每个方法故意尝试越界；返回值/错误码由宿主 E2E 断言（不在插件内断言，避免自证）。
const fs = require('node:fs')
const path = require('node:path')

module.exports = {
  activate(ctx) {
    ctx.registerIpc('read', async () => await ctx.services.kv.get('k'))
    ctx.registerIpc('escape', async () => {
      try {
        fs.readFileSync(ctx.config.secretPath, 'utf8')
        return { ok: true }
      } catch (e) {
        return { ok: false, code: e.code }
      }
    })
    ctx.registerIpc('spawn', async () => {
      try {
        require('node:child_process').execSync('cmd /c echo hi')
        return { ok: true }
      } catch (e) {
        return { ok: false, code: e.code }
      }
    })
    ctx.registerIpc('worker', async () => {
      try {
        const { Worker } = require('node:worker_threads')
        const w = new Worker('1', { eval: true })
        await w.terminate()
        return { ok: true }
      } catch (e) {
        return { ok: false, code: e.code }
      }
    })
    ctx.registerIpc('native', async () => {
      try {
        process.dlopen({ exports: {} }, ctx.config.nativePath)
        return { ok: true }
      } catch (e) {
        return { ok: false, code: e.code }
      }
    })
    ctx.registerIpc('env', async () => ({
      sentinel: process.env.UMI_SECRET_SENTINEL ?? null,
      path: typeof process.env.PATH === 'string',
      home: process.env.HOME ?? null,
      userProfile: process.env.USERPROFILE ?? null,
      appData: process.env.APPDATA ?? null,
      dataDir: process.env.CLAW_DATA_DIR ?? null
    }))
  }
}
