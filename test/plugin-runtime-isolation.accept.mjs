// test/plugin-runtime-isolation.accept.mjs —— Phase 2 P1：真实 pluginRuntime 管理隔离插件
//
// 用 FakeChild 替代 Electron utilityProcess（真机由 plugin-isolation.e2e 覆盖），
// 但走真实 createPluginRuntime().init() → startIsolatedPlugin → invoke → disposeHost，
// 证明 manager 不是未使用的 seam。

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── 配置保存 → 重启隔离进程（P2 残余：ctx.config 是启动快照） ──────────────────
//
// 与 R3 同构：安装态文件 + FakeChild 驱动真实 pluginRuntime。额外用
// ShutdownAwareChild 让 stop() 立即收到 exit（否则每次 stop 都要等 3s 超时）。
class ShutdownAwareChild extends FakeChild {
  postMessage(message) {
    super.postMessage(message)
    if (message?.type === 'shutdown') this.kill()
  }
}

/** 让 supervisor.invoke 抛「无 code 的普通 Error」：postMessage 在 Promise 执行器里同步抛 */
class ThrowingInvokeChild extends ShutdownAwareChild {
  postMessage(message) {
    if (message?.type === 'invoke') throw new Error('子进程通道炸了')
    super.postMessage(message)
  }
}

function createInstalledFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'umi-rt-'))
  const resources = join(dir, 'resources')
  const pkg = join(dir, 'plugin-packages', 'cfg', '1.0.0')
  const entry = join(dir, 'plugin-runtime', '5.0.0', 'pluginProcessChild.js')
  const dataDir = join(dir, 'plugin-data', 'cfg')
  mkdirSync(join(resources, 'plugins'), { recursive: true })
  mkdirSync(pkg, { recursive: true })
  mkdirSync(join(dir, 'plugin-runtime', '5.0.0'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(pkg, 'main.js'), 'module.exports={}', 'utf8')
  writeFileSync(entry, '// fake child', 'utf8')
  if (options.config) {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(options.config), 'utf8')
  }
  writeFileSync(
    join(dir, 'plugin-install-state.json'),
    JSON.stringify({
      schema: 1,
      plugins: {
        cfg: {
          id: 'cfg',
          version: '1.0.0',
          name: 'Cfg',
          packageDir: pkg,
          entry,
          dataDir,
          enabled: options.enabled !== false,
          configSchema: { type: 'object', properties: { interval: { type: 'number' } } }
        }
      }
    }),
    'utf8'
  )
  return { dir, resources, dataDir }
}

await r.check('R8', 'plugin:config:set：写盘后 stop→start，新进程拿到新配置快照', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init
    assertDeepEq(
      children[0].sent.find((m) => m.type === 'init')?.config,
      { interval: 1000 },
      '首次启动读的是盘上旧配置'
    )

    const saving = call('plugin:config:set', { id: 'cfg', config: { interval: 5000 } })
    await waitFor(() => children[1], { timeout: 2000 })
    await driveReady(children[1])
    const saved = await saving
    assertEq(saved.ok, true, JSON.stringify(saved))
    assertEq(saved.data.restarted, true, '返回 restarted:true')
    assertEq(saved.data.interval, 5000, '响应保留配置字段')
    assertEq(children.length, 2, '旧进程 stop 后重新 start')
    assertEq(children[0].killed, true, '旧进程已终止')
    assertDeepEq(
      children[1].sent.find((m) => m.type === 'init')?.config,
      { interval: 5000 },
      '新进程 ctx.config 是新值'
    )
    assertDeepEq(
      JSON.parse(readFileSync(join(fx.dataDir, 'config.json'), 'utf8')),
      { interval: 5000 },
      'config.json 落盘'
    )
    assertEq(runtime.isolatedStatuses().length, 1, '重启后仍只有一个进程')
    assertEq(runtime.isolatedStatuses()[0].state, 'running', '重启后 running')
    return '配置保存 → stop→start ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R9', 'plugin:config:set：插件未运行（停用）时只写文件，不自动拉起', async () => {
  const fx = createInstalledFixture({ enabled: false })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    await runtime.init()
    assertEq(children.length, 0, '停用态 init 不启动')
    const saved = await call('plugin:config:set', { id: 'cfg', config: { interval: 3000 } })
    assertEq(saved.ok, true, JSON.stringify(saved))
    assertEq(saved.data.restarted, false, '未运行 → restarted:false')
    assertEq(saved.data.interval, 3000, '响应保留配置字段')
    assertEq(children.length, 0, '配置保存不应自动拉起进程')
    assertEq(runtime.isolatedStatuses().length, 0, '仍无进程')
    assertDeepEq(
      JSON.parse(readFileSync(join(fx.dataDir, 'config.json'), 'utf8')),
      { interval: 3000 },
      '配置已落盘'
    )
    return '未运行只写不启 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R10', 'plugin:config:set：重启失败不拖垮保存（ok:true + restarted:false + warning）', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init

    const saving = call('plugin:config:set', { id: 'cfg', config: { interval: 7000 } })
    await waitFor(() => children[1], { timeout: 2000 })
    // 新进程启动阶段直接退出 → startInstalledRecord 抛错，进入 warning 分支
    children[1].emit('exit', 1)
    const saved = await saving
    assertEq(saved.ok, true, '重启失败仍返回保存成功')
    assertEq(saved.data.restarted, false, 'restarted:false')
    assertEq(saved.data.interval, 7000, '响应保留配置字段')
    assert(Boolean(saved.data.warning), '带 warning 说明重启失败')
    assertDeepEq(
      JSON.parse(readFileSync(join(fx.dataDir, 'config.json'), 'utf8')),
      { interval: 7000 },
      '配置仍已落盘（不能因重启失败回滚）'
    )
    assertEq(runtime.isolatedStatuses().length, 0, '进程未恢复，等用户处理')
    return '重启失败可观测且不丢配置 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R11', 'plugin:config:set：supervisor 处于 crashed（非 running）时只写盘，不抢 stop/start', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init
    // 非主动退出 → crashed。supervisor 会在 backoff（1s）后自行重拉；
    // 本断言只看「配置保存这一拍」不能额外 fork / stop（避免和自动重拉抢进程，
    // 也避免把 disabled 熔断态意外复活）。
    children[0].emit('exit', 1)
    assertEq(runtime.isolatedStatuses()[0]?.state, 'crashed', '先进入 crashed')
    const saved = await call('plugin:config:set', { id: 'cfg', config: { interval: 6000 } })
    assertEq(saved.ok, true, JSON.stringify(saved))
    assertEq(saved.data.restarted, false, 'crashed 不重启')
    assert(
      String(saved.data.warning ?? '').includes('自动重拉仍用旧配置，可点「启动」用新配置恢复'),
      'crashed 时 warning 说明自动重拉用旧配置、可点启动恢复'
    )
    assertEq(children.length, 1, '没有额外 fork')
    assertEq(
      children[0].sent.some((m) => m.type === 'shutdown'),
      false,
      '没有向 crashed 进程发 shutdown'
    )
    assertDeepEq(
      JSON.parse(readFileSync(join(fx.dataDir, 'config.json'), 'utf8')),
      { interval: 6000 },
      '配置仍写盘'
    )
    return 'crashed 只写不重启 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

// ── plugin:isolated:invoke 错误码透传 ─────────────────────────────────────────
//
// 子进程的 PLUGIN_NOT_FOUND 是「该插件没有 run 方法」的唯一可靠信号（管理页按 code 分支）。
// 走真实 runtime + supervisor 链路：子进程回 result 错误 → supervisor.invoke reject →
// IPC 信封必须保留登记码；普通 Error / 伪造 code 仍兜底 PLUGIN_OPERATION_FAILED。
async function withRunningInstalledPlugin(childFactory, fn) {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = childFactory()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init
    return await fn({ fx, children, runtime, call })
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
}

await r.check('R12', 'plugin:isolated:invoke：子进程 PLUGIN_NOT_FOUND 原样透传到 IPC 信封', async () => {
  return withRunningInstalledPlugin(() => new ShutdownAwareChild(), async ({ children, call }) => {
    const invoking = call('plugin:isolated:invoke', { id: 'cfg', method: 'run' })
    const req = await waitFor(() => children[0].sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    children[0].emit('message', {
      type: 'result',
      id: req.id,
      ok: false,
      error: { code: 'PLUGIN_NOT_FOUND', message: '插件未注册方法 run' }
    })
    const envelope = await invoking
    assertEq(envelope.ok, false, '失败信封')
    assertEq(envelope.error?.code, 'PLUGIN_NOT_FOUND', '子进程错误码透传（管理页可提示未提供 run）')
    assertEq(envelope.error?.message, '插件未注册方法 run', 'message 原样')
    return 'PLUGIN_NOT_FOUND 透传 ✓'
  })
})

await r.check('R13', 'plugin:isolated:invoke：普通 Error（无 code）仍兜底 PLUGIN_OPERATION_FAILED', async () => {
  return withRunningInstalledPlugin(() => new ThrowingInvokeChild(), async ({ call }) => {
    const envelope = await call('plugin:isolated:invoke', { id: 'cfg', method: 'run' })
    assertEq(envelope.ok, false, '失败信封')
    assertEq(envelope.error?.code, 'PLUGIN_OPERATION_FAILED', '无 code 兜底')
    assertEq(envelope.error?.message, '子进程通道炸了', 'message 原样')
    return '普通 Error 兜底 ✓'
  })
})

await r.check('R14', 'plugin:isolated:invoke：未登记/原型链 code（toString）不透传，兜底 PLUGIN_OPERATION_FAILED', async () => {
  return withRunningInstalledPlugin(() => new ShutdownAwareChild(), async ({ children, call }) => {
    const invoking = call('plugin:isolated:invoke', { id: 'cfg', method: 'run' })
    const req = await waitFor(() => children[0].sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    children[0].emit('message', {
      type: 'result',
      id: req.id,
      ok: false,
      // ERROR_CODES 继承自 Object.prototype，`'toString' in ERROR_CODES` 为 true；
      // 必须用 hasOwnProperty 判定，否则原型链 key 会被当错误码透传给渲染端。
      error: { code: 'toString', message: '伪造错误码' }
    })
    const envelope = await invoking
    assertEq(envelope.ok, false, '失败信封')
    assertEq(envelope.error?.code, 'PLUGIN_OPERATION_FAILED', '非登记码不得透传')
    assertEq(envelope.error?.message, '伪造错误码', 'message 原样')
    return '未知 code 兜底 ✓'
  })
})

await r.check('R16', 'plugin:isolated:start：停掉的插件可恢复，running 幂等，未安装 NOT_FOUND', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init
    // 保存配置重启失败等场景会把进程停掉；UI 需要一个恢复入口而不是重启 App
    await runtime.stopIsolatedPlugin('cfg')
    assertEq(runtime.isolatedStatuses().length, 0, '先停掉进程')
    const starting = call('plugin:isolated:start', { id: 'cfg' })
    await waitFor(() => children[1], { timeout: 2000 })
    await driveReady(children[1])
    const started = await starting
    assertEq(started.ok, true, JSON.stringify(started))
    assertEq(Array.isArray(started.data), true, '返回 isolatedStatuses()')
    assertEq(
      started.data.find((status) => status.pluginId === 'cfg')?.state,
      'running',
      '重新启动后 running：' + JSON.stringify(started.data)
    )
    assertEq(children.length, 2, '重新 fork 一次')

    // 幂等：running 时再次点「启动」不重复 fork
    const again = await call('plugin:isolated:start', { id: 'cfg' })
    assertEq(again.ok, true, '已 running 幂等 ok')
    assertEq(children.length, 2, 'running 不重复 fork')

    // 未安装
    const missing = await call('plugin:isolated:start', { id: 'nope' })
    assertEq(missing.ok, false, '未安装失败')
    assertEq(missing.error?.code, 'NOT_FOUND', '未安装 NOT_FOUND')
    return 'isolated:start 恢复入口 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R17', 'plugin:isolated:start：停用插件明确拒绝，不偷偷启动', async () => {
  const fx = createInstalledFixture({ enabled: false })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    await runtime.init()
    assertEq(children.length, 0, '停用态 init 不启动')
    const res = await call('plugin:isolated:start', { id: 'cfg' })
    assertEq(res.ok, false, '停用插件启动应失败')
    assertEq(res.error?.code, 'PLUGIN_OPERATION_FAILED', '明确回失败码')
    assertEq(children.length, 0, '不偷偷 fork')
    return '停用拒绝 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R18', 'plugin:isolated:start：crashed 状态可先 stop 再按盘上新配置恢复', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '1'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    const init = runtime.init()
    await waitFor(() => children[0], { timeout: 2000 })
    await driveReady(children[0])
    await init
    // 非主动退出 → crashed；此时 supervisor 仍在表里，直接 startInstalledRecord 会抛「已启动」
    children[0].emit('exit', 1)
    assertEq(runtime.isolatedStatuses()[0]?.state, 'crashed', '先进入 crashed')
    const starting = call('plugin:isolated:start', { id: 'cfg' })
    await waitFor(() => children[1], { timeout: 2000 })
    await driveReady(children[1])
    const started = await starting
    assertEq(started.ok, true, JSON.stringify(started))
    assertEq(started.data.find((item) => item.pluginId === 'cfg')?.state, 'running', '恢复后 running')
    assertEq(children.length, 2, 'crashed 恢复重新 fork')
    assertDeepEq(
      children[1].sent.find((item) => item.type === 'init')?.config,
      { interval: 1000 },
      '新进程用盘上配置'
    )
    return 'crashed 可恢复 ✓'
  } finally {
    process.env.UMI_PLUGIN_ISOLATION = '0'
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

await r.check('R19', 'plugin:isolated:start：隔离运行时未启用时明确报错，不谎报成功', async () => {
  const fx = createInstalledFixture({ config: { interval: 1000 } })
  const children = []
  process.env.UMI_PLUGIN_ISOLATION = '0'
  const deps = createDeps(fx.dir, fx.resources, () => {
    const child = new ShutdownAwareChild()
    children.push(child)
    return child
  })
  const runtime = runtimeMod.createPluginRuntime(deps)
  const call = (channel, payload) => deps.__handlers.get(channel)(null, payload)
  try {
    await runtime.init()
    const res = await call('plugin:isolated:start', { id: 'cfg' })
    assertEq(res.ok, false, '未启用应失败')
    assertEq(res.error?.code, 'PLUGIN_OPERATION_FAILED', '明确错误码')
    assertEq(children.length, 0, '不启动')
    return '未启用明确报错 ✓'
  } finally {
    await runtime.disposeHost()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-runtime-isolation.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
