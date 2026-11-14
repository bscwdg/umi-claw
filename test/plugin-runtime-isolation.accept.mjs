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
import { Recorder, __dirname, assert, assertEq, bundleEntry, printResult, repoRoot, waitFor, writeJson } from './_lib.mjs'

const r = new Recorder('Phase 2 · pluginRuntime 隔离生命周期（P1）')
const runtimeMod = await import(
  pathToFileURL(
    bundleEntry('electron/main/services/pluginRuntime.ts', 'runtime-isolation.mjs', { stubElectron: true })
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
    ipc: { handle: () => {}, removeHandler: () => {} },
    appInfo: () => ({ version: '5.0.0', appPath: repoRoot, resourcesPath: resources, isPackaged: false }),
    subscribeResume: () => () => {},
    broadcast: () => {},
    logger: () => {},
    utilityProcess: { fork }
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

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-runtime-isolation.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
