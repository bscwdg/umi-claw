// test/plugin-isolation.accept.mjs —— Phase 1 B1：插件进程 supervisor / child 协议 / 开关
//
// 两层验收：
//   1) supervisor 状态机（纯 Node + FakeChild）：start→running、invoke、stop、崩溃重启、
//      启动失败 disabled、心跳 hang、5min/3 次熔断；
//   2) child 入口真进程（Node fork + CJS bundle）：init→ready→activate→registerIpc→invoke→shutdown。
// 不启动 Electron：utilityProcess 的 fork 由 B0 spike 验证；这里锁协议与状态机。

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleCjs,
  printResult,
  repoRoot,
  resolveNodePath,
  waitFor,
  writeJson
} from './_lib.mjs'

const r = new Recorder('Phase 1 · 插件进程隔离（supervisor / child 协议 / 开关）')

// 通过 esbuild 读真 TS（不在 Node 里直接 import TS）
const supervisorMod = await import(
  pathToFileURL(bundleCjs('electron/main/kernel/pluginSupervisor.ts', 'isolation-supervisor.cjs')).href
)
const flagMod = await import(
  pathToFileURL(bundleCjs('electron/main/kernel/pluginIsolation.ts', 'isolation-flag.cjs')).href
)

class FakeChild extends EventEmitter {
  constructor({ hangPing = false, crashOnInit = false, ignoreInit = false, wrongPong = false, killDelayMs = 0, throwOnPing = false } = {}) {
    super()
    this.pid = 100 + FakeChild.seq++
    this.hangPing = hangPing
    this.crashOnInit = crashOnInit
    this.ignoreInit = ignoreInit
    this.wrongPong = wrongPong
    this.killDelayMs = killDelayMs
    this.throwOnPing = throwOnPing
    this.sent = []
    this.killed = false
  }
  postMessage(message) {
    this.sent.push(message)
    if (message.type === 'ping' && this.throwOnPing) throw new Error('port closed')
    if (message.type === 'init') {
      if (this.crashOnInit) setImmediate(() => this.emit('exit', 1))
      else if (!this.ignoreInit) setImmediate(() => this.emit('message', { type: 'ready', version: '4.3.0' }))
    } else if (message.type === 'activate') {
      setImmediate(() => this.emit('message', { type: 'activated' }))
    } else if (message.type === 'ping') {
      if (!this.hangPing) {
        setImmediate(() =>
          this.emit('message', { type: 'pong', id: this.wrongPong ? message.id + 999 : message.id })
        )
      }
    } else if (message.type === 'invoke') {
      setImmediate(() =>
        this.emit('message', {
          type: 'result',
          id: message.id,
          ok: true,
          data: { echo: message.payload ?? null }
        })
      )
    } else if (message.type === 'shutdown') {
      setImmediate(() => this.emit('exit', 0))
    }
  }
  kill() {
    this.killed = true
    setTimeout(() => this.emit('exit', 0), this.killDelayMs)
  }
  crash() {
    this.emit('exit', 1)
  }
}
FakeChild.seq = 0

const spec = {
  pluginId: 'fixture',
  entry: '/fake/child.js',
  mainPath: '/fake/main.cjs',
  dataDir: '/fake/data',
  hostVersion: '4.3.0'
}

await r.check('I1', 'supervisor：start→running / invoke 往返 / stop→stopped', async () => {
  let child = null
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => (child = new FakeChild()),
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000
  })
  await sup.start(spec)
  assertEq(sup.state, 'running', '启动后 running')
  const data = await sup.invoke('ping', 'hello')
  assertEq(data.echo, 'hello', 'invoke 结果透传')
  assertEq(child.sent.some((m) => m.type === 'init'), true, '发送 init')
  assertEq(child.sent.some((m) => m.type === 'activate'), true, '发送 activate')
  await sup.stop()
  assertEq(sup.state, 'stopped', 'stop 后 stopped')
  await sup.dispose()
  return 'start/invoke/stop ✓'
})

await r.check('I2', 'supervisor：崩溃后按退避重启（crashed→starting→running）', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    backoffMs: [10]
  })
  await sup.start(spec)
  children[0].crash()
  await waitFor(() => sup.state === 'running' && children.length === 2, { timeout: 1000 })
  assertEq(sup.state, 'running', '重启后 running')
  assertEq(children.length, 2, '只重启一次')
  await sup.dispose()
  return '崩溃重启 ✓'
})

await r.check('I3', 'supervisor：启动阶段退出 → disabled，不自动重启', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ crashOnInit: true })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    backoffMs: [10]
  })
  let threw = null
  try {
    await sup.start(spec)
  } catch (e) {
    threw = e
  }
  assert(threw, 'start 应 reject')
  await waitFor(() => sup.state === 'disabled', { timeout: 1000 })
  assertEq(sup.state, 'disabled', '启动失败 disabled')
  assertEq(children.length, 1, '不自动重启')
  await sup.dispose()
  return '启动失败 disabled ✓'
})

await r.check('I4', 'supervisor：心跳 hang → kill → crashed（不拖垮宿主）', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ hangPing: true })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 10,
    backoffMs: [10]
  })
  await sup.start(spec)
  await waitFor(() => sup.state === 'crashed' || sup.state === 'disabled', { timeout: 1500 })
  assertEq(children[0].killed, true, 'hang 后 kill 子进程')
  await sup.dispose()
  return '心跳 hang 检测 ✓'
})

await r.check('I5', 'supervisor：5min 内连续崩溃达到上限 → disabled（熔断）', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    backoffMs: [5],
    crashLimit: 2,
    crashWindowMs: 5000
  })
  await sup.start(spec)
  children[0].crash()
  await waitFor(() => sup.state === 'running' && children.length === 2, { timeout: 1000 })
  children[1].crash()
  await waitFor(() => sup.state === 'disabled', { timeout: 1000 })
  assertEq(sup.state, 'disabled', '熔断 disabled')
  await sup.dispose()
  return '崩溃熔断 ✓'
})

 await r.check('I6', 'child 入口真进程：init→ready→activate→registerIpc→invoke→shutdown', async () => {
  const childBundle = bundleCjs('electron/main/kernel/pluginProcessChild.ts', 'isolation-child-bundle.cjs')
  const wrapper = join(__dirname, '.tmp', 'isolation-child-wrapper.cjs')
  writeFileSync(
    wrapper,
    `const { startPluginProcessChild } = require(${JSON.stringify(childBundle)})\nstartPluginProcessChild()\n`,
    'utf8'
  )
  const fixture = join(repoRoot, 'test', 'fixtures', 'isolation-plugin.cjs')
  const node = resolveNodePath() ?? process.execPath
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  delete env.ELECTRON_RUN_AS_NODE
  const childData = mkdtempSync(join(tmpdir(), 'umi-child-'))
  const child = spawn(node, [wrapper], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = []
  child.on('message', (m) => messages.push(m))
  const waitMessage = (type) => waitFor(() => messages.find((m) => m.type === type), { timeout: 8000 })
  try {
    child.send({
      type: 'init',
      pluginId: 'fixture',
      mainPath: fixture,
      dataDir: childData,
      hostVersion: '4.3.0'
    })
    await waitMessage('ready')
    child.send({ type: 'activate' })
    await waitMessage('activated')
    child.send({ type: 'invoke', id: 1, method: 'ping', payload: 'hello' })
    const result = await waitMessage('result')
    assertEq(result.ok, true, 'invoke ok')
    assertEq(result.data.echo, 'hello', 'payload 透传')
    assertEq(result.data.host.version, '4.3.0', 'ctx.host.version')
    assertEq(result.data.pluginId, 'fixture', 'ctx.pluginId')
    child.send({ type: 'shutdown' })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    assertEq(code, 0, 'shutdown 后 exit 0')
    return `child 协议全链路 ✓（${messages.length} 条消息）`
  } finally {
    if (!child.killed) child.kill()
    rmSync(childData, { recursive: true, force: true })
  }
})

await r.check('I7', '开关默认 off：只有 UMI_PLUGIN_ISOLATION=1 才启用', async () => {
  assertEq(flagMod.isPluginIsolationEnabled({}), false, '未设置 = off')
  assertEq(flagMod.isPluginIsolationEnabled({ UMI_PLUGIN_ISOLATION: '0' }), false, '0 = off')
  assertEq(flagMod.isPluginIsolationEnabled({ UMI_PLUGIN_ISOLATION: '1' }), true, '1 = on')
  return 'flag 默认 off ✓'
})

await r.check('I8', '生产接线：pluginRuntime 暴露 isolationEnabled()，默认 off 不改变 4.3 行为', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  assert(/isPluginIsolationEnabled/.test(src), 'pluginRuntime 引用隔离开关')
  assert(/isolationEnabled\(\)/.test(src), 'PluginRuntime 暴露 isolationEnabled()')
  assert(!/utilityProcess\.fork/.test(src), 'B1 不在 pluginRuntime 直接 fork（supervisor 由 B2/B3 接）')
  return 'flag 接线 ✓'
})

await r.check('I9', 'stop 在 crashed/待重启时取消 restartTimer，不再自动拉起', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    backoffMs: [200]
  })
  await sup.start(spec)
  children[0].crash()
  assertEq(sup.state, 'crashed', '先进入 crashed')
  await sup.stop()
  assertEq(sup.state, 'stopped', 'stop 后 stopped')
  await new Promise((r) => setTimeout(r, 300))
  assertEq(children.length, 1, '待重启定时器已取消，不再 fork')
  await sup.dispose()
  return 'stop 取消待重启 ✓'
})

await r.check('I10', 'ready 超时 → disabled 且不因 kill 后的 exit 误重启', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ ignoreInit: true })
      children.push(c)
      return c
    },
    readyTimeoutMs: 30,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    backoffMs: [10]
  })
  let threw = null
  try {
    await sup.start(spec)
  } catch (e) {
    threw = e
  }
  assert(threw, 'ready 超时应 reject')
  await waitFor(() => sup.state === 'disabled', { timeout: 1000 })
  await new Promise((r) => setTimeout(r, 200))
  assertEq(sup.state, 'disabled', '终态 disabled')
  assertEq(children.length, 1, 'kill 后的 exit 不得触发重启')
  await sup.dispose()
  return 'ready 超时 disabled ✓'
})

await r.check('I11', '错误 id 的 pong 不能续命（心跳仍超时）', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ wrongPong: true })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 10,
    backoffMs: [10],
    crashLimit: 1
  })
  await sup.start(spec)
  await waitFor(() => sup.state === 'crashed' || sup.state === 'disabled', { timeout: 1500 })
  assertEq(children[0].killed, true, '错误 pong 后仍 kill')
  await sup.dispose()
  return 'pong id 校验 ✓'
})

await r.check('I12', 'Electron parentPort 的 MessageEvent（.data）路径也能 ready', async () => {
  const childBundle = bundleCjs('electron/main/kernel/pluginProcessChild.ts', 'isolation-child-parentport.cjs')
  const wrapper = join(__dirname, '.tmp', 'isolation-child-parentport-wrapper.cjs')
  writeFileSync(
    wrapper,
    `process.parentPort = {
  postMessage: (m) => process.send(m),
  on: (_event, cb) => process.on('message', (m) => cb({ data: m }))
}
require(${JSON.stringify(childBundle)})
`,
    'utf8'
  )
  const fixture = join(repoRoot, 'test', 'fixtures', 'isolation-plugin.cjs')
  const node = resolveNodePath() ?? process.execPath
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const childData = mkdtempSync(join(tmpdir(), 'umi-parentport-'))
  const child = spawn(node, [wrapper], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = []
  child.on('message', (m) => messages.push(m))
  const waitMessage = (type) => waitFor(() => messages.find((m) => m.type === type), { timeout: 8000 })
  try {
    child.send({
      type: 'init',
      pluginId: 'fixture',
      mainPath: fixture,
      dataDir: childData,
      hostVersion: '4.3.0'
    })
    const ready = await waitMessage('ready')
    assertEq(ready.version, '4.3.0', 'ready.version 来自 init 的 hostVersion')
    child.send({ type: 'activate' })
    await waitMessage('activated')
    child.send({ type: 'shutdown' })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    assertEq(code, 0, 'shutdown 后 exit 0')
    return 'MessageEvent .data 解包 ✓'
  } finally {
    if (!child.killed) child.kill()
  }
})

await r.check('I13', '旧 generation 的迟到 exit/message 不影响新 child', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ killDelayMs: 30 })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000
  })
  await sup.start(spec)
  await sup.dispose()
  const old = children[0]
  await sup.start(spec)
  // 旧 child 的迟到消息/exit 不应改变新 generation
  old.emit('message', { type: 'ready', version: 'stale' })
  old.emit('exit', 1)
  await new Promise((r) => setTimeout(r, 80))
  assertEq(sup.state, 'running', '新 child 仍 running')
  assertEq(children.length, 2, '迟到 exit 不触发额外 fork')
  await sup.dispose()
  return 'generation 隔离 ✓'
})

await r.check('I14', 'disabled 是终态：stop 不能洗白，reset 才能恢复', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    crashLimit: 1,
    crashWindowMs: 5000,
    backoffMs: [10]
  })
  await sup.start(spec)
  children[0].crash()
  await waitFor(() => sup.state === 'disabled', { timeout: 1000 })
  await sup.stop()
  assertEq(sup.state, 'disabled', 'stop 不清熔断')
  let threw = null
  try {
    await sup.start(spec)
  } catch (e) {
    threw = e
  }
  assert(threw, 'disabled 直接 start 应拒绝')
  sup.reset()
  await sup.start(spec)
  assertEq(sup.state, 'running', 'reset 后可恢复')
  await sup.dispose()
  return 'disabled/reset ✓'
})

await r.check('I15', '心跳 postMessage 抛错不崩宿主，按 hang 处理', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ throwOnPing: true })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 10,
    backoffMs: [10],
    crashLimit: 1
  })
  await sup.start(spec)
  await waitFor(() => sup.state === 'crashed' || sup.state === 'disabled', { timeout: 1500 })
  assertEq(children[0].killed, true, '抛错后 kill')
  await sup.dispose()
  return 'postMessage 异常兜底 ✓'
})

await r.check('I16', 'stop 期间 start 被拒绝；stop 不 kill 新 child', async () => {
  const children = []
  const sup = new supervisorMod.PluginSupervisor({
    fork: () => {
      const c = new FakeChild({ killDelayMs: 50 })
      children.push(c)
      return c
    },
    readyTimeoutMs: 500,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    stopTimeoutMs: 100
  })
  await sup.start(spec)
  const stopping = sup.stop()
  let startThrew = null
  try {
    await sup.start(spec)
  } catch (e) {
    startThrew = e
  }
  assert(startThrew, 'stopping 中 start 应拒绝')
  await stopping
  assertEq(sup.state, 'stopped', 'stop 收敛到 stopped')
  assertEq(children.length, 1, '没有额外 fork')
  await sup.dispose()
  return 'stop/start 竞态 ✓'
})

await r.check('I17', '心跳配置非法（interval <= timeout）在构造期拒绝', async () => {
  let threw = null
  try {
    new supervisorMod.PluginSupervisor({
      fork: () => new FakeChild(),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 20
    })
  } catch (e) {
    threw = e
  }
  assert(threw, 'interval<=timeout 应抛错')
  return '心跳配置校验 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-isolation.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
