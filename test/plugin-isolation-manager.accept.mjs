// test/plugin-isolation-manager.accept.mjs —— Phase 2 P1：runtime 管理的隔离插件生命周期
//
// 不启动 Electron：用 FakeChild 驱动 supervisor；真机链路由 plugin-isolation.e2e 覆盖。
// 目标：runtime 层有 start/stop/invoke/service/status 的稳定 seam，C2 不需要再改。

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, __dirname, assert, assertEq, bundleEntry, printResult, repoRoot, waitFor, writeJson } from './_lib.mjs'

const r = new Recorder('Phase 2 · 隔离插件生命周期管理器（P1）')
const mgrMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginIsolationManager.ts', 'iso-manager.mjs')).href
)

class FakeChild extends EventEmitter {
  sent = []
  killed = false
  postMessage(message) {
    this.sent.push(message)
  }
  kill() {
    this.killed = true
    this.emit('exit', 0)
  }
}

const spec = {
  pluginId: 'demo',
  entry: '/app/pluginProcessChild.js',
  mainPath: '/plugins/demo/main.js',
  packageDir: '/plugins/demo',
  dataDir: '/data/plugins/demo',
  services: ['kv'],
  permissions: { services: ['kv'] },
  config: { a: 1 }
}

const driveReady = async (child) => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  child.emit('message', { type: 'ready', version: '5.0.0' })
  await waitFor(() => child.sent.find((m) => m.type === 'activate'), { timeout: 1000 })
  child.emit('message', { type: 'activated' })
}

await r.check('M1', 'start：调用 buildEnv、ready/activate、状态 running；重复 start 拒绝', async () => {
  let child = null
  let envSpec = null
  const manager = mgrMod.createPluginIsolationManager({
    fork: () => {
      child = new FakeChild()
      return child
    },
    hostVersion: '5.0.0',
    buildEnv: (s) => {
      envSpec = s
      return { NODE_OPTIONS: '--experimental-permission' }
    },
    serviceCall: async () => 'svc'
  })
  try {
    const started = manager.start(spec)
    await driveReady(child)
    await started
    assert(envSpec, 'buildEnv 调用')
    assertEq(envSpec.packageDir, spec.packageDir, 'buildEnv 收到 packageDir')
    assertEq(manager.statuses().length, 1, 'statuses 1')
    assertEq(manager.statuses()[0].state, 'running', 'running')
    assertEq(child.sent.find((m) => m.type === 'init').env, undefined, 'env 不进 init（走 fork env）')
    let dup = null
    try {
      await manager.start(spec)
    } catch (e) {
      dup = e
    }
    assert(dup, '重复 start 拒绝')
  } finally {
    await manager.stopAll()
  }
  assertEq(manager.statuses().length, 0, 'stopAll 后为空')
})

await r.check('M2', 'invoke 走 supervisor；service 消息经 serviceCall 回包', async () => {
  let child = null
  let serviceArgs = null
  const manager = mgrMod.createPluginIsolationManager({
    fork: () => {
      child = new FakeChild()
      return child
    },
    hostVersion: '5.0.0',
    buildEnv: () => ({ NODE_OPTIONS: '--experimental-permission' }),
    serviceCall: async (pluginId, service, method, args) => {
      serviceArgs = { pluginId, service, method, args }
      return 'host-value'
    }
  })
  try {
    const started = manager.start(spec)
    await driveReady(child)
    await started
    const invoked = manager.invoke('demo', 'read', { x: 1 })
    const request = await waitFor(() => child.sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    child.emit('message', { type: 'result', id: request.id, ok: true, data: { pong: true } })
    assertEq((await invoked).pong, true, 'invoke 返回')

    child.emit('message', { type: 'service', id: 1, service: 'kv', method: 'get', args: ['k'] })
    const result = await waitFor(() => child.sent.find((m) => m.type === 'service-result' && m.id === 1), {
      timeout: 1000
    })
    assertEq(result.ok, true, 'service 回包')
    assertEq(result.data, 'host-value', 'service 值')
    assertEq(serviceArgs.pluginId, 'demo', 'service pluginId')
    assertEq(serviceArgs.service, 'kv', 'service 名')
  } finally {
    await manager.stopAll()
  }
})

await r.check('M3', 'stop 只停指定插件；未知 id stop 不报错；invoke 未启动拒绝', async () => {
  const children = new Map()
  const manager = mgrMod.createPluginIsolationManager({
    fork: () => {
      const c = new FakeChild()
      children.set(children.size, c)
      return c
    },
    hostVersion: '5.0.0',
    buildEnv: () => ({ NODE_OPTIONS: '--experimental-permission' }),
    serviceCall: async () => 'svc'
  })
  try {
    const a = manager.start({ ...spec, pluginId: 'a' })
    await driveReady(children.get(0))
    await a
    const b = manager.start({ ...spec, pluginId: 'b' })
    await driveReady(children.get(1))
    await b
    assertEq(manager.statuses().length, 2, '两个插件')
    await manager.stop('a')
    assertEq(manager.statuses().length, 1, 'stop a 后剩 1')
    assertEq(manager.statuses()[0].pluginId, 'b', '剩 b')
    await manager.stop('missing')
    let err = null
    try {
      await manager.invoke('missing', 'read')
    } catch (e) {
      err = e
    }
    assertEq(err?.code, 'PLUGIN_OPERATION_FAILED', '未启动 invoke 错误码')
  } finally {
    await manager.stopAll()
  }
})

await r.check('M4', '生产接线：pluginRuntime 注入 utilityProcess + 隔离方法 + disposeHost 停止全部', async () => {
  const runtime = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  const main = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf8')
  assert(runtime.includes('createPluginIsolationManager'), 'runtime 创建 manager')
  assert(
    runtime.includes('isPluginIsolationEnabled(process.env, deps.appInfo().version) && deps.utilityProcess'),
    'flag + utilityProcess 才启用'
  )
  assert(runtime.includes('startIsolatedPlugin'), '暴露 startIsolatedPlugin')
  assert(runtime.includes('await isolationManager?.stopAll()'), 'disposeHost 停全部')
  assert(/utilityProcess,/.test(main), 'main 注入 utilityProcess')
  return 'runtime 接线 ✓'
})

await r.check('M5', 'start 失败（ready 超时）回收 supervisor/child，不留在 statuses', async () => {
  let child = null
  let logs = []
  const manager = mgrMod.createPluginIsolationManager({
    fork: () => {
      child = new FakeChild()
      return child
    },
    hostVersion: '5.0.0',
    readyTimeoutMs: 80,
    buildEnv: () => ({ NODE_OPTIONS: '--experimental-permission' }),
    serviceCall: async () => 'svc',
    logger: (line) => logs.push(line)
  })
  let err = null
  try {
    await manager.start(spec)
  } catch (e) {
    err = e
  }
  assert(err, '启动失败应抛错')
  assertEq(manager.statuses().length, 0, '不留在 statuses')
  assertEq(child.killed, true, 'child 被 kill')
  assert(logs.some((line) => /启动失败/.test(line)), '有失败日志')
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-isolation-manager.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
