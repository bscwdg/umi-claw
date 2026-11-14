// test/plugin-contract.accept.mjs —— 插件 API v1 契约验收（PLAN-5.0 A5）
//
// 用 templates/plugin 作为「按文档写出来的插件」：
//   - manifest 能过 parseManifest / apiVersion / engines
//   - main.ts 只依赖 plugin-sdk/public（不 import electron/main、不 import src）
//   - 通过真 PluginHost 完成 activate → registerIpc → jobs → dispose 全链路
//   - migrations 能过 loadPluginSchema 白名单
// 这样以后改 API 时，模板/契约会先红，而不是等第三方插件来踩。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  writeJson
} from './_lib.mjs'

const r = new Recorder('Phase 0 · 插件 API v1 契约（模板 / SDK / 生命周期）')
const templateDir = join(repoRoot, 'templates', 'plugin')

const kernel = await import(
  pathToFileURL(bundleEntry('electron/main/kernel/index.ts', 'contract-kernel.mjs')).href
)
const { PluginRegistry, PluginHost, parseManifest } = kernel

const publicSdk = await import(
  pathToFileURL(bundleEntry('plugin-sdk/src/public.ts', 'contract-public-sdk.mjs')).href
)

const templateMod = await import(
  pathToFileURL(bundleEntry('templates/plugin/main.ts', 'contract-template-main.mjs')).href
)

function createFakeIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    async invoke(channel, payload) {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`No handler: ${channel}`)
      return fn({}, payload)
    }
  }
}

await r.check('C1', '模板 manifest：id/apiVersion/engines 可解析，迁移过 DDL 白名单', async () => {
  const raw = JSON.parse(readFileSync(join(templateDir, 'plugin.json'), 'utf8'))
  const manifest = parseManifest(raw, 'templates/plugin/plugin.json')
  assertEq(manifest.id, 'example', 'id')
  assertEq(manifest.apiVersion, 1, 'apiVersion')
  assertEq(manifest.engines?.host, '>=4.3.0 <6.0.0', 'engines.host')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert(
    kernel.satisfiesHostRange(pkg.version, manifest.engines.host),
    `宿主实际版本 ${pkg.version} 必须满足模板 engines（预发布也要支持）`
  )

  const schemaMod = await import(
    pathToFileURL(bundleEntry('electron/main/kernel/pluginSchema.ts', 'contract-schema.mjs')).href
  )
  const schema = schemaMod.loadPluginSchema(join(templateDir, 'migrations'))
  assertEq(schema.targetUserVersion, 1, '迁移版本')
  assert(Boolean(schema.tables.example_notes), '解析出 example_notes 表')
  return '模板 manifest/migrations ✓'
})

await r.check('C2', '模板 main 只依赖公开 SDK：无 electron/main、无 src、definePlugin 为函数', async () => {
  assertEq(typeof publicSdk.definePlugin, 'function', 'public.definePlugin 导出')
  const rawSrc = readFileSync(join(templateDir, 'main.ts'), 'utf8')
  // 只检查代码，注释里的「不要 import electron/main」不算依赖
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert(!src.includes('electron/main'), '模板不得 import electron/main')
  assert(!src.includes("from '@/"), '模板不得 import src 别名')
  assert(!src.includes("from 'electron'"), '模板不得 import electron')
  assert(/plugin-sdk\/src\/public/.test(src), '模板只从 public SDK 取 definePlugin')
  return '模板依赖面收窄 ✓'
})

await r.check('C3', '模板 activate：registerIpc 可调用、jobs 计数、dispose 后 handler/任务清零', async () => {
  const ipc = createFakeIpc()
  const raw = JSON.parse(readFileSync(join(templateDir, 'plugin.json'), 'utf8'))
  const registry = new PluginRegistry({ hostVersion: '4.3.0', persistedEnabled: { example: true } })
  registry.register({
    dir: templateDir,
    source: 'templates/plugin/plugin.json',
    manifest: raw,
    loadMain: async () => templateMod.default
  })
  const dataDir = mkdtempSync(join(tmpdir(), 'umi-contract-'))
  try {
    const host = new PluginHost({
      registry,
      ipc,
      hostVersion: '4.3.0',
      dataDir,
      activationTimeoutMs: 5000
    })
    const status = await host.activate('example')
    assertEq(status.state, 'activated', '激活：' + JSON.stringify(status.error))
    const pong = await ipc.invoke('plugin:example:ping', 'hi')
    assertEq(pong.ok, true, 'ping.ok（统一信封）')
    assertEq(pong.data.pong, true, 'ping.data.pong')
    assertEq(pong.data.echo, 'hi', 'payload 透传')
    assertEq(status.jobCount, 1, '注册 1 个周期任务')

    await host.disposeAll()
    assertEq(ipc.handlers.size, 0, '停用后 IPC 清零')
    assertEq(registry.get('example')?.jobCount ?? 0, 0, '停用后任务清零')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
  return '模板生命周期 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-contract.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
