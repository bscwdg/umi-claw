// test/plugin-runtime-isolation.accept.mjs —— Phase 2 P1：真实 pluginRuntime 管理隔离插件
//
// 用 FakeChild 替代 Electron utilityProcess（真机由 plugin-isolation.e2e 覆盖），
// 但走真实 createPluginRuntime().init() → startIsolatedPlugin → invoke → disposeHost，
// 证明 manager 不是未使用的 seam。

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, __dirname, assert, assertDeepEq, assertEq, bundleEntry, printResult, repoRoot, waitFor, writeJson } from './_lib.mjs'

const r = new Recorder('Phase 2 · pluginRuntime 隔离生命周期（P1）')
const runtimeMod = await import(
  pathToFileURL(
    bundleEntry('electron/main/services/pluginRuntime.ts', 'runtime-isolation.mjs', {
      stubElectron: true,
      externals: ['adm-zip']
    })
  ).href
)

class FakeChild extends EventEmitter {
  sent = []
  killed = false
  postMessage(m) {
    this.sent.push(m)
  }
  kill() {
    this.killed = true
    this.emit('exit', 0)
  }
}

const driveReady = async (child) => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  child.emit('message', { type: 'ready', version: '5.0.0' })
  await waitFor(() => child.sent.find((m) => m.type === 'activate'), { timeout: 1000 })
  child.emit('message', { type: 'activated' })
}

function createDeps(dir, resources, fork) {
  const handlers = new Map()
  return {
    dataDir: () => dir,
    nodePath: () => process.execPath,
    resourcesRoot: () => resources,
    workDatabase: () => null,
    openLegacyDatabase: () => null,
    hostOps: () => ({}),
    notifications: () => ({}),
    openclaw: () => ({}),
    consent: () => ({ status: async () => ({}), grant: async () => ({}), revoke: async () => ({}) }),
    abort: () => ({ register: () => () => {}, abortAll: () => {} }),
    encryption: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    ipc: {
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel)
    },
    appInfo: () => ({ version: '5.0.0', appPath: repoRoot, resourcesPath: resources, isPackaged: false }),
    subscribeResume: () => () => {},
    broadcast: () => {},
    logger: () => {},
    utilityProcess: { fork },
    __handlers: handlers
  }
}

await r.check('R1', 'flag off：runtime 不创建 manager，startIsolatedPlugin 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  process.env.UMI_PLUGIN_ISOLATION = '0'
  let forked = 0
  const runtime = runtimeMod.createPluginRuntime(
    createDeps(dir, resources, () => {
      forked += 1
      return new FakeChild()
    })
  )
  try {
    await runtime.init()
    let err = null
    try {
      await runtime.startIsolatedPlugin({
        pluginId: 'p',
        entry: '/x/child.js',
        mainPath: '/x/main.js',
        packageDir: '/x',
        dataDir: '/x/data'
      })
    } catch (e) {
      err = e
    }
    assertEq(err?.code, 'PLUGIN_OPERATION_FAILED', 'flag off 拒绝码')
    assertEq(forked, 0, '不 fork')
    assertEq(runtime.isolatedStatuses().length, 0, '无状态')
  } finally {
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('R2', 'flag on：runtime.startIsolatedPlugin → invoke → statuses → disposeHost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  let child = null
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const runtime = runtimeMod.createPluginRuntime(
    createDeps(dir, resources, () => {
      child = new FakeChild()
      return child
    })
  )
  try {
    await runtime.init()
    const started = runtime.startIsolatedPlugin({
      pluginId: 'p',
      entry: join(__dirname, '.tmp', 'fake-child.js'),
      mainPath: join(dir, 'main.js'),
      packageDir: dir,
      dataDir: join(dir, 'data'),
      services: []
    })
    await driveReady(child)
    await started
    assertEq(runtime.isolatedStatuses().length, 1, 'runtime statuses')
    assertEq(runtime.isolatedStatuses()[0].state, 'running', 'running')
    const invoked = runtime.invokeIsolated('p', 'ping', { x: 1 })
    const req = await waitFor(() => child.sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    child.emit('message', { type: 'result', id: req.id, ok: true, data: { pong: true } })
    assertEq((await invoked).pong, true, 'runtime invoke')
    await runtime.disposeHost()
    assertEq(runtime.isolatedStatuses().length, 0, 'disposeHost 后为空')
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('R3', '安装态文件驱动：runtime.init 自动启动 enabled 隔离插件（C2 产品接线）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  const pkg = join(dir, 'plugin-packages', 'p', '1.0.0')
  const entry = join(dir, 'plugin-runtime', '5.0.0', 'pluginProcessChild.js')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  mkdirSync(pkg, { recursive: true })
  mkdirSync(join(dir, 'plugin-runtime', '5.0.0'), { recursive: true })
  writeFileSync(join(pkg, 'main.js'), 'module.exports={}', 'utf8')
  writeFileSync(entry, '// fake child', 'utf8')
  writeFileSync(
    join(dir, 'plugin-install-state.json'),
    JSON.stringify({
      schema: 1,
      plugins: {
        p: { version: '1.0.0', name: 'P', packageDir: pkg, entry, enabled: true }
      }
    }),
    'utf8'
  )
  let child = null
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const runtime = runtimeMod.createPluginRuntime(
    createDeps(dir, resources, () => {
      child = new FakeChild()
      return child
    })
  )
  try {
    const init = runtime.init()
    await waitFor(() => child, { timeout: 2000 })
    await driveReady(child)
    await init
    assertEq(runtime.isolatedStatuses().length, 1, 'init 自动启动')
    assertEq(runtime.isolatedStatuses()[0].pluginId, 'p', 'pluginId')
    assertEq(runtime.isolatedStatuses()[0].version, '1.0.0', 'version')
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

const pkgMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPackage.ts', 'runtime-pkg.mjs', { externals: ['adm-zip'] })).href
)

await r.check('R4', 'runtime.installFromPackage：安装 + 自动启动隔离插件（C2 产品链路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'inst', version: '1.0.0', name: 'Inst' }), 'utf8')
  writeFileSync(join(src, 'main.js'), 'module.exports={}', 'utf8')
  const kp = pkgMod.generateSigningKeyPair()
  const pkgFile = join(dir, 'inst.umi-plugin')
  pkgMod.packPlugin({
    sourceDir: src,
    outFile: pkgFile,
    keyId: kp.keyId,
    privateKeyPem: kp.privateKeyPem,
    publicKeyBase64: kp.publicKeyBase64
  })
  let child = null
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const runtime = runtimeMod.createPluginRuntime(
    createDeps(dir, resources, () => {
      child = new FakeChild()
      return child
    })
  )
  try {
    await runtime.init()
    const installing = runtime.installFromPackage({ packageFile: pkgFile, allowSelfSigned: true })
    await waitFor(() => child, { timeout: 2000 })
    await driveReady(child)
    const result = await installing
    assertEq(result.ok, true, JSON.stringify(result))
    assertEq(result.record.version, '1.0.0', '安装版本')
    assertEq(runtime.installedPlugins().plugins.inst.version, '1.0.0', '安装态')
    assertEq(runtime.isolatedStatuses().length, 1, '自动启动')
    assertEq(runtime.isolatedStatuses()[0].pluginId, 'inst', '隔离状态 id')
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('R5', '产品 IPC：plugin:install → grant → isolated:invoke → rollback → installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'ipc-p', version: '1.0.0', name: 'IPC', permissions: { services: ['kv'] } }), 'utf8')
  writeFileSync(join(src, 'main.js'), 'module.exports={activate(ctx){ctx.registerIpc("ping", async()=>"pong")}}', 'utf8')
  const kp = pkgMod.generateSigningKeyPair()
  const pkgFile = join(dir, 'ipc-p.umi-plugin')
  pkgMod.packPlugin({ sourceDir: src, outFile: pkgFile, keyId: kp.keyId, privateKeyPem: kp.privateKeyPem, publicKeyBase64: kp.publicKeyBase64 })
  let child = null
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(dir, resources, () => {
    child = new FakeChild()
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    await runtime.init()
    const installing = call('plugin:install', { packageFile: pkgFile, allowSelfSigned: true })
    await waitFor(() => child, { timeout: 6000 })
    await driveReady(child)
    const installed = await installing
    assertEq(installed.ok, true, JSON.stringify(installed))
    const granted = await call('plugin:permissions:grant', { id: 'ipc-p' })
    assertEq(granted.ok, true, 'grant IPC '+JSON.stringify(granted))
    const invoking = call('plugin:isolated:invoke', { id: 'ipc-p', method: 'ping' })
    const req = await waitFor(() => child.sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    child.emit('message', { type: 'result', id: req.id, ok: true, data: 'pong' })
    assertEq((await invoking).data, 'pong', 'invoke IPC')
    const rolled = call('plugin:rollback', { id: 'ipc-p' })
    assertEq((await rolled).error?.code, 'PLUGIN_NO_PREVIOUS', 'rollback 无上一版本时拒绝')
    assertEq(call('plugin:installed').data.plugins['ipc-p'].version, '1.0.0', 'installed IPC')
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('R6', 'OpenClaw 会话键隔离：第三方强制 conv:plugin:<id>:*，官方不改写', async () => {
  const mod = await import(
    pathToFileURL(bundleEntry('electron/main/services/pluginServiceAdapters.ts', 'adapter-keys.mjs', { alias: ['electron=' + join(__dirname, 'electron-stub.mjs')] })).href
  )
  let seen = ''
  const gateway = { chat: async (input) => { seen = input.conversationKey; return { text: 'x', model: 'm' } } }
  const third = mod.createOpenClawService(() => gateway, 'third', true)
  await third.chat({ conversationKey: 'conv:work:qa' })
  assertEq(seen, 'conv:plugin:third:work:qa', '官方键改写')
  await third.chat({ conversationKey: 'conv:plugin:work:work:qa' })
  assertEq(seen, 'conv:plugin:third:work:qa', '他插件键不得放行')
  await third.chat({ conversationKey: 'conv:plugin:third:ok' })
  assertEq(seen, 'conv:plugin:third:ok', '自己的键保留')
  const official = mod.createOpenClawService(() => gateway, 'work', false)
  await official.chat({ conversationKey: 'conv:work:qa' })
  assertEq(seen, 'conv:work:qa', '官方内置不改写')
  return '会话键隔离 ✓'
})

await r.check('R7', '产品 IPC：plugin:pick-package 一律回 {ok,data} 信封（取消 = data:null，不报错）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  const deps = createDeps(dir, resources, () => new FakeChild())
  const runtime = runtimeMod.createPluginRuntime(deps)
  try {
    await runtime.init()
    const handler = deps.__handlers.get('plugin:pick-package')
    assert(handler, 'pick-package handler 已注册')
    // 平台不给选择器（理论上不会发生）：也必须走空信封，而不是裸返回
    assertDeepEq(await handler(null), { ok: true, data: null }, '无 pickPackage 时 data:null')
    // 用户点「取消」：dialog 返回 null —— preload 的 call() 只认 {ok,data}，
    // 裸 null 会被当成失败抛「IPC plugin:pick-package 失败」
    deps.pickPackage = async () => null
    assertDeepEq(await handler(null), { ok: true, data: null }, '取消是成功信封 + data:null')
    const picked = join(dir, 'demo.umi-plugin')
    deps.pickPackage = async () => picked
    assertDeepEq(await handler(null), { ok: true, data: picked }, '选中返回路径')
    deps.pickPackage = async () => {
      throw new Error('dialog 崩了')
    }
    const failed = await handler(null)
    assertEq(failed.ok, false, '选择器异常回失败信封')
    assertEq(failed.error?.code, 'PLUGIN_OPERATION_FAILED', '失败码')
    return 'pick-package 信封 ✓'
  } finally {
    await runtime.disposeHost()
    rmSync(dir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-runtime-isolation.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
