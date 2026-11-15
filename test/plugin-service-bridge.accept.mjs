// test/plugin-service-bridge.accept.mjs —— Phase 1 B3：服务桥（权限 → 服务解析 → RPC）
//
// 覆盖：
//  1) bridge 默认按 B2 broker 拒绝/放行；未知服务/方法/危险属性报 NOT_FOUND；
//  2) child ctx.services 代理把调用转成 service RPC，宿主回 service-result；
//  3) 真 Node 子进程：插件 read() → ctx.services.kv.get → 宿主 bridge → 返回值；
//  4) 生产 fork 走 utilityProcess + env/cwd 静态接线。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertDeepEq,
  assertEq,
  bundleCjs,
  bundleEntry,
  printResult,
  repoRoot,
  resolveNodePath,
  waitFor,
  writeJson
} from './_lib.mjs'

const r = new Recorder('Phase 1 · 插件服务桥（权限 / 服务解析 / RPC）')
const bridgeMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginServiceBridge.ts', 'svc-bridge.mjs')).href
)
const adapterMod = await import(
  pathToFileURL(
    bundleEntry('electron/main/services/pluginServiceAdapters.ts', 'svc-adapter.mjs', {
      alias: ['electron=' + join(__dirname, 'electron-stub.mjs')]
    })
  ).href
)
const permMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPermissions.ts', 'svc-perms.mjs')).href
)
const errorsMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/errors.ts', 'svc-errors.mjs')).href
)

await r.check('S1', 'bridge：未授权拒绝；授权后按 method 调用；unknown/危险方法 NOT_FOUND', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const audit = permMod.createPermissionAudit(join(dir, 'audit.log'))
    const broker = permMod.createPermissionBroker({
      store,
      audit,
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    const kv = {
      data: new Map(),
      get(k) {
        return this.data.get(k) ?? null
      },
      set(k, v) {
        this.data.set(k, v)
        return true
      },
      _secret: 'do-not-touch'
    }
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: (id, name) => (name === 'kv' ? kv : undefined),
      broker
    })
    let denied = null
    try {
      await bridge.call('p1', 'kv', 'get', 'k')
    } catch (e) {
      denied = e
    }
    assertEq(denied?.code, errorsMod.ERROR_CODES.PLUGIN_PERMISSION_DENIED, '未授权 code')

    store.grant('p1', { services: ['kv', 'db'] })
    assertEq(await bridge.call('p1', 'kv', 'set', ['k', 'v']), true, 'set 两参数调用')
    assertEq(await bridge.call('p1', 'kv', 'get', ['k']), 'v', 'get 单参数调用')

    for (const [service, method] of [
      ['db', 'request'],
      ['kv', 'missing'],
      ['kv', 'constructor'],
      ['kv', 'toString'],
      ['kv', '_secret']
    ]) {
      let err = null
      try {
        await bridge.call('p1', service, method, [])
      } catch (e) {
        err = e
      }
      assertEq(err?.code, errorsMod.ERROR_CODES.NOT_FOUND, `${service}.${method} 应 NOT_FOUND`)
    }
    return 'bridge 权限/方法边界 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S2', 'bridge：服务抛 AppError 原样透传；普通异常包 PLUGIN_OPERATION_FAILED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['kv'] })
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: () => ({
        appError() {
          throw new errorsMod.AppError(errorsMod.ERROR_CODES.CONFLICT, '冲突')
        },
        boom() {
          throw new Error('炸了')
        }
      }),
      broker
    })
    let appErr = null
    try {
      await bridge.call('p1', 'kv', 'appError', null)
    } catch (e) {
      appErr = e
    }
    assertEq(appErr?.code, errorsMod.ERROR_CODES.CONFLICT, 'AppError 透传')
    let plain = null
    try {
      await bridge.call('p1', 'kv', 'boom', null)
    } catch (e) {
      plain = e
    }
    assertEq(plain?.code, errorsMod.ERROR_CODES.PLUGIN_OPERATION_FAILED, '普通异常包装')
    return '错误映射 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S3', '真 Node 子进程：插件 ctx.services.kv.get 经 RPC 回宿主并返回', async () => {
  const childBundle = bundleCjs('electron/main/kernel/pluginProcessChild.ts', 'svc-child-bundle.cjs')
  const wrapper = join(__dirname, '.tmp', 'svc-child-wrapper.cjs')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    wrapper,
    `const { startPluginProcessChild } = require(${JSON.stringify(childBundle)})\nstartPluginProcessChild()\n`,
    'utf8'
  )
  const fixture = join(repoRoot, 'test', 'fixtures', 'service-plugin.cjs')
  const dataDir = mkdtempSync(join(tmpdir(), 'umi-svc-child-'))
  const node = resolveNodePath() ?? process.execPath
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(node, [wrapper], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = []
  const serviceCalls = []
  child.on('message', (m) => {
    messages.push(m)
    if (m.type === 'service') {
      serviceCalls.push(m)
      child.send({
        type: 'service-result',
        id: m.id,
        ok: m.service === 'kv' && (m.method === 'get' || m.method === 'set'),
        data: m.method === 'set' ? true : 'host-value',
        error: { code: 'NOT_FOUND', message: 'no' }
      })
    }
  })
  const waitMessage = (type) => waitFor(() => messages.find((m) => m.type === type), { timeout: 8000 })
  try {
    child.send({
      type: 'init',
      pluginId: 'svc',
      mainPath: fixture,
      dataDir,
      hostVersion: '4.3.0',
      services: ['kv']
    })
    await waitMessage('ready')
    child.send({ type: 'activate' })
    await waitMessage('activated')
    child.send({ type: 'invoke', id: 1, method: 'write' })
    const writeResult = await waitMessage('result')
    assertEq(writeResult.ok, true, 'write invoke ok')
    assertEq(serviceCalls.length, 1, 'write 一次 service RPC')
    assertEq(serviceCalls[0].method, 'set', 'write method')
    assertEq(Array.isArray(serviceCalls[0].args), true, 'args 数组')
    assertEq(serviceCalls[0].args.length, 2, 'set 收到两个实参')
    child.send({ type: 'invoke', id: 2, method: 'read' })
    const result = await waitFor(
      () => messages.find((m) => m.type === 'result' && m.id === 2),
      { timeout: 8000 }
    )
    assertEq(result.ok, true, 'read invoke ok')
    assertEq(result.data, 'host-value', 'service 返回值穿透')
    assertEq(serviceCalls.length, 2, '两次 service RPC')
    child.send({ type: 'shutdown' })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    assertEq(code, 0, 'shutdown 退出')
    return 'ctx.services RPC ✓'
  } finally {
    if (!child.killed) child.kill()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

await r.check('S4', '生产 fork：utilityProcess + cwd + env（B2 NODE_OPTIONS）静态接线', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'kernel', 'pluginSupervisor.ts'), 'utf8')
  assert(/utilityProcess\.fork/.test(src), '使用 utilityProcess.fork')
  assert(/cwd:\s*spec\.cwd/.test(src), '传 cwd（权限相对路径依赖）')
  assert(/env:\s*spec\.env/.test(src), '传权限 env')
  assert(/onService/.test(src), 'supervisor 接服务桥')
  return '生产 fork 接线 ✓'
})

await r.check('S5', 'pluginRuntime 接线：callPluginService 走权限 broker + serviceFactories', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  assert(/createPluginServiceBridge/.test(src), '创建 service bridge')
  assert(/callPluginService\(pluginId, service, method, args\)/.test(src), '暴露 callPluginService')
  assert(/broker:\s*permissionBroker/.test(src), 'bridge 接权限 broker')
  assert(/resolveService:\s*\(pluginId, name\)/.test(src), '解析宿主服务')
  return 'pluginRuntime 服务桥接线 ✓'
})

await r.check('S6', 'createUtilityProcessFork 缺 env 时 fail-closed（不默认透传 process.env）', async () => {
  const supMod = await import(
    pathToFileURL(bundleEntry('electron/main/kernel/pluginSupervisor.ts', 'svc-supervisor.mjs')).href
  )
  const fork = supMod.createUtilityProcessFork({ fork: () => { throw new Error('不应 fork') } })
  let threw = null
  try {
    fork({ pluginId: 'p', entry: '/x', mainPath: '/x/main.cjs', dataDir: '/x/data', hostVersion: '4.3.0' })
  } catch (e) {
    threw = e
  }
  assert(threw, '缺 env 应抛错')
  assertEq(threw.code, 'PLUGIN_PERMISSION_CONFIG_INVALID', '错误码')
  return 'env fail-closed ✓'
})

await r.check('S7', 'child 服务调用超时：宿主不回包时按 serviceTimeoutMs 失败，不永久挂起', async () => {
  const childMod = await import(
    pathToFileURL(bundleCjs('electron/main/kernel/pluginProcessChild.ts', 'svc-child-timeout.cjs')).href
  )
  const messages = []
  const runtime = childMod.createChildRuntime({ send: (m) => messages.push(m) })
  try {
    await runtime.handle({
      type: 'init',
      pluginId: 'timeout',
      mainPath: join(repoRoot, 'test', 'fixtures', 'timeout-plugin.cjs'),
      dataDir: join(tmpdir(), 'umi-svc-timeout'),
      hostVersion: '4.3.0',
      services: ['kv'],
      serviceTimeoutMs: 150
    })
    await runtime.handle({ type: 'activate' })
    const started = Date.now()
    await runtime.handle({ type: 'invoke', id: 7, method: 'go' })
    const result = await waitFor(() => messages.find((m) => m.type === 'result' && m.id === 7), {
      timeout: 2000
    })
    assertEq(result.ok, false, '超时返回失败')
    assertEq(result.error?.code, 'PLUGIN_OPERATION_FAILED', '超时错误码')
    assert(/超时/.test(result.error?.message ?? ''), '超时消息')
    assert(Date.now() - started < 1500, '未永久挂起')
    return '服务超时 ✓'
  } finally {
    runtime.dispose()
  }
})

await r.check('S8', 'supervisor 宿主 onService 超时：不回包时回 service-result 错误，不让宿主 Promise 永久挂起', async () => {
  const { EventEmitter } = await import('node:events')
  const supMod = await import(
    pathToFileURL(bundleEntry('electron/main/kernel/pluginSupervisor.ts', 'svc-supervisor-timeout.mjs')).href
  )
  class FakeChild extends EventEmitter {
    sent = []
    postMessage(m) {
      this.sent.push(m)
    }
    kill() {
      this.emit('exit', 0)
    }
  }
  let child = null
  const sup = supMod.createPluginSupervisor({
    fork: () => {
      child = new FakeChild()
      return child
    },
    serviceTimeoutMs: 80,
    onService: () => new Promise(() => {})
  })
  try {
    const started = sup.start({
      pluginId: 'p',
      entry: '/x/child.js',
      mainPath: '/x/main.cjs',
      dataDir: '/x/data',
      hostVersion: '4.3.0'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    child.emit('message', { type: 'ready', version: '4.3.0' })
    await waitFor(() => child.sent.find((m) => m.type === 'activate'), { timeout: 1000 })
    child.emit('message', { type: 'activated' })
    await started
    child.emit('message', { type: 'service', id: 9, service: 'kv', method: 'get', args: ['k'] })
    const result = await waitFor(() => child.sent.find((m) => m.type === 'service-result' && m.id === 9), {
      timeout: 2000
    })
    assertEq(result.ok, false, '超时回包失败')
    assertEq(result.error?.code, 'PLUGIN_OPERATION_FAILED', '超时错误码')
    assert(/超时/.test(result.error?.message ?? ''), '超时消息')
    return 'supervisor onService 超时 ✓'
  } finally {
    await sup.stop()
  }
})

await r.check('S9', 'activate 期间（starting）调 ctx.services 也能回包，不被静默丢弃', async () => {
  const { EventEmitter } = await import('node:events')
  const supMod = await import(
    pathToFileURL(bundleEntry('electron/main/kernel/pluginSupervisor.ts', 'svc-supervisor-starting.mjs')).href
  )
  class FakeChild extends EventEmitter {
    sent = []
    postMessage(m) {
      this.sent.push(m)
    }
    kill() {
      this.emit('exit', 0)
    }
  }
  let child = null
  const sup = supMod.createPluginSupervisor({
    fork: () => {
      child = new FakeChild()
      return child
    },
    onService: async () => 'during-activate'
  })
  try {
    const started = sup.start({
      pluginId: 'p',
      entry: '/x/child.js',
      mainPath: '/x/main.cjs',
      dataDir: '/x/data',
      hostVersion: '4.3.0'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    child.emit('message', { type: 'ready', version: '4.3.0' })
    await waitFor(() => child.sent.find((m) => m.type === 'activate'), { timeout: 1000 })
    child.emit('message', { type: 'service', id: 11, service: 'kv', method: 'get', args: ['k'] })
    const result = await waitFor(() => child.sent.find((m) => m.type === 'service-result' && m.id === 11), {
      timeout: 1500
    })
    assertEq(result.ok, true, 'starting 期间 service 成功')
    assertEq(result.data, 'during-activate', '返回值')
    child.emit('message', { type: 'activated' })
    await started
    return 'starting service ✓'
  } finally {
    await sup.stop()
  }
})

await r.check('S10', 'supervisor.invoke 保留子进程错误码（宿主可按 code 分支）', async () => {
  const { EventEmitter } = await import('node:events')
  const supMod = await import(
    pathToFileURL(bundleEntry('electron/main/kernel/pluginSupervisor.ts', 'svc-supervisor-code.mjs')).href
  )
  class FakeChild extends EventEmitter {
    sent = []
    postMessage(m) {
      this.sent.push(m)
    }
    kill() {
      this.emit('exit', 0)
    }
  }
  let child = null
  const sup = supMod.createPluginSupervisor({
    fork: () => {
      child = new FakeChild()
      return child
    }
  })
  try {
    const started = sup.start({
      pluginId: 'p',
      entry: '/x/child.js',
      mainPath: '/x/main.cjs',
      dataDir: '/x/data',
      hostVersion: '5.0.0'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    child.emit('message', { type: 'ready', version: '5.0.0' })
    await waitFor(() => child.sent.find((m) => m.type === 'activate'), { timeout: 1000 })
    child.emit('message', { type: 'activated' })
    await started
    const pending = sup.invoke('read', {})
    const req = await waitFor(() => child.sent.find((m) => m.type === 'invoke'), { timeout: 1000 })
    child.emit('message', {
      type: 'result',
      id: req.id,
      ok: false,
      error: { code: 'PLUGIN_PERMISSION_DENIED', message: 'denied' }
    })
    let err = null
    try {
      await pending
    } catch (e) {
      err = e
    }
    assertEq(err?.code, 'PLUGIN_PERMISSION_DENIED', 'invoke 错误码')
  } finally {
    await sup.stop()
  }
})

await r.check('S11', '服务能力面：db.backup/forPlugin/dispose 不对第三方开放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['db'] })
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: () => ({ backup: async () => ({ path: 'x' }) }),
      broker
    })
    for (const method of ['backup', 'forPlugin', 'dispose']) {
      let err = null
      try {
        await bridge.call('p1', 'db', method, [])
      } catch (e) {
        err = e
      }
      assertEq(err?.code, errorsMod.ERROR_CODES.NOT_FOUND, `${method} 被拒绝`)
    }
    return '服务能力面 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S12', 'bridge：openclaw.status 放行，getStatus 仍拒（第三方只走脱敏状态）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['openclaw'] })
    const status = { ready: true, endpointsEnabled: true, lastError: null, port: 3213 }
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: (id, name) =>
        name === 'openclaw'
          ? { status: async () => status, getStatus: async () => ({ ...status, port: 3213, token: 'secret' }) }
          : undefined,
      broker
    })
    assertEq((await bridge.call('p1', 'openclaw', 'status', [])).ready, true, 'status 放行')
    let denied = null
    try {
      await bridge.call('p1', 'openclaw', 'getStatus', [])
    } catch (e) {
      denied = e
    }
    assertEq(denied?.code, errorsMod.ERROR_CODES.NOT_FOUND, 'getStatus 仍拒')
    return 'openclaw.status 放行 / getStatus 拒绝 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S13', 'adapter：第三方 status 脱敏为 {ready,endpointsEnabled,lastError?}，官方全量不变', async () => {
  const full = {
    ready: true,
    port: 3213,
    baseUrl: 'http://127.0.0.1:3213',
    endpointsEnabled: true,
    lastError: { code: 'OPENCLAW_NOT_READY', message: '网关未就绪', details: { path: 'C:/secret/gateway' } },
    token: 'do-not-leak'
  }
  const gateway = { getStatus: async () => full }
  const third = adapterMod.createOpenClawService(() => gateway, 'third', true)
  const masked = await third.status()
  assertDeepEq(
    masked,
    {
      ready: true,
      endpointsEnabled: true,
      lastError: { code: 'OPENCLAW_NOT_READY', message: '网关未就绪' }
    },
    '第三方只拿公开承诺字段'
  )
  assertEq('port' in masked, false, '不返回 port')
  assertEq('baseUrl' in masked, false, '不返回 baseUrl')
  assertEq('token' in masked, false, '不返回 token')
  assertEq(JSON.stringify(masked).includes('secret'), false, 'lastError 不带 details/paths')

  const nullErr = adapterMod.createOpenClawService(
    () => ({ getStatus: async () => ({ ready: false, port: 1, baseUrl: 'u', endpointsEnabled: false, lastError: null }) }),
    'third',
    true
  )
  assertDeepEq(await nullErr.status(), { ready: false, endpointsEnabled: false }, '无错误时不带 lastError 键')

  const official = adapterMod.createOpenClawService(() => gateway, 'work', false)
  assertDeepEq(await official.status(), full, '官方 builtin 行为不变（全量）')
  return 'status 脱敏 ✓'
})

await r.check('S14', 'adapter：生产形状（inner OpenClawApi，无 getStatus/createChatStream）不再 TypeError', async () => {
  const calls = []
  const fullStatus = {
    ready: true,
    port: 3213,
    baseUrl: 'http://127.0.0.1:3213',
    endpointsEnabled: true,
    lastError: { code: 'OPENCLAW_NOT_READY', message: '网关未就绪', details: { path: 'C:/secret' } }
  }
  // index.ts 的 deps.openclaw 已经是 createOpenClawService(getWorkGatewayClient) 的返回值：
  // 只有 status/ensureReady/chat/stream，没有 getStatus/createChatStream。
  const inner = {
    status: async () => fullStatus,
    ensureReady: async () => ({ ...fullStatus, ready: true }),
    chat: async (input) => {
      calls.push(['chat', input])
      return { text: 'pong', model: 'm' }
    },
    stream: (input) => {
      calls.push(['stream', input])
      return {
        iterator: (async function* () {
          yield { index: 0, delta: 'x' }
        })(),
        result: Promise.resolve({ text: 'streamed', chunks: 1, aborted: false }),
        cancel: () => calls.push(['cancel'])
      }
    }
  }
  const third = adapterMod.createOpenClawService(() => inner, 'third', true)
  // 1) status：旧实现在这里空指针（inner 没有 getStatus）
  const status = await third.status()
  assertDeepEq(
    status,
    {
      ready: true,
      endpointsEnabled: true,
      lastError: { code: 'OPENCLAW_NOT_READY', message: '网关未就绪' }
    },
    'status 走 inner.status 并脱敏'
  )
  assertEq('port' in status, false, '不泄漏 port')
  // 2) ensureReady：同样脱敏
  assertDeepEq(
    await third.ensureReady(),
    {
      ready: true,
      endpointsEnabled: true,
      lastError: { code: 'OPENCLAW_NOT_READY', message: '网关未就绪' }
    },
    'ensureReady 脱敏'
  )
  // 3) chat：inner.chat 可用，且会话键仍强制隔离
  const chatRes = await third.chat({ conversationKey: 'conv:work:qa', messages: [] })
  assertEq(chatRes.text, 'pong', 'chat 正常返回')
  assertEq(chatRes.model, 'm', 'chat model 透传')
  assertEq(calls.find(([name]) => name === 'chat')[1].conversationKey, 'conv:plugin:third:work:qa', 'chat 会话键隔离')
  // 4) stream：第三方 v1 不支持流式（S18 详测传输层），adapter 侧直接安全拒绝
  let streamDenied = null
  try {
    third.stream({ conversationKey: 'conv:work:stream', messages: [] })
  } catch (e) {
    streamDenied = e
  }
  assertEq(streamDenied?.code, 'PLUGIN_OPERATION_FAILED', '第三方 stream 安全拒绝')
  // 5) 官方 builtin 用同一形状时保持全量，stream 仍可用
  const official = adapterMod.createOpenClawService(() => inner, 'work', false)
  assertDeepEq(await official.status(), fullStatus, 'builtin 全量不变')
  const builtinHandle = official.stream({ conversationKey: 'conv:work:s', messages: [] })
  assertDeepEq(
    await builtinHandle.result,
    { text: 'streamed', chunks: 1, aborted: false },
    'builtin stream 正常（OpenClawApi 形状）'
  )
  return '生产 OpenClawApi 形状兼容 ✓'
})

await r.check('S15', 'bridge：openclaw.ensureReady 对第三方拒绝（NOT_FOUND），status 仍放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['openclaw'] })
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: (id, name) =>
        name === 'openclaw'
          ? {
              status: async () => ({ ready: true }),
              // ensureReady 会触发网关拉起并回全量状态（port/baseUrl），必须被 bridge 挡住
              ensureReady: async () => ({ ready: true, port: 3213, baseUrl: 'http://127.0.0.1:3213' })
            }
          : undefined,
      broker
    })
    assertEq((await bridge.call('p1', 'openclaw', 'status', [])).ready, true, 'status 仍放行')
    let denied = null
    try {
      await bridge.call('p1', 'openclaw', 'ensureReady', [])
    } catch (e) {
      denied = e
    }
    assertEq(denied?.code, errorsMod.ERROR_CODES.NOT_FOUND, 'ensureReady 被拒')
    return 'ensureReady 收口 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S16', 'adapter：lastError/chat 错误只回 code+固定安全文案，原始串一律不出现', async () => {
  // 覆盖复核给的泄漏向量：URL、内网 IP:port、内网域名:port、UNC、引号/等号后 POSIX、
  // 带空格 Windows 路径、IPv6。
  const leakyMessage =
    'connect http://127.0.0.1:3213/v1 10.0.0.5:3213 gateway.internal:8443 \\\\server\\share "/home/u/secret" =/home/u/secret C:\\Program Files\\secret [::1]:3213'
  const full = {
    ready: false,
    port: 3213,
    baseUrl: 'http://127.0.0.1:3213',
    endpointsEnabled: false,
    lastError: { code: 'OPENCLAW_NOT_READY', message: leakyMessage, details: { path: 'C:/secret/gateway' } }
  }
  const third = adapterMod.createOpenClawService(() => ({ getStatus: async () => full }), 'third', true)
  const masked = await third.status()
  assertEq(masked.lastError?.code, 'OPENCLAW_NOT_READY', 'code 保留')
  assertEq(masked.lastError?.message, '网关未就绪', '固定安全文案（不拼原始 message）')
  const msg = masked.lastError?.message ?? ''
  for (const bad of [
    'http://',
    '127.0.0.1',
    '10.0.0.5',
    'gateway.internal',
    '8443',
    '3213',
    '\\\\server',
    '/home/u',
    'Program Files',
    '[::1]',
    'C:/secret',
    'C:\\secret'
  ]) {
    assertEq(msg.includes(bad), false, `message 不得泄漏 ${bad}`)
  }

  // code → 固定文案映射（含 auth / timeout / 其它）
  for (const [code, safe] of [
    ['OPENCLAW_AUTH_ERROR', '网关鉴权失败'],
    ['OPENCLAW_TIMEOUT', '网关超时'],
    ['SOMETHING_ELSE', '网关异常']
  ]) {
    const svc = adapterMod.createOpenClawService(
      () => ({ getStatus: async () => ({ ...full, lastError: { code, message: leakyMessage } }) }),
      'third',
      true
    )
    assertEq((await svc.status()).lastError?.message, safe, `${code} 映射固定文案`)
  }

  // chat 失败：isolated 只回 code + 安全文案（不泄漏原始 message）
  const chatGateway = {
    chat: async () => {
      const e = new Error(`chat failed: ${leakyMessage}`)
      e.code = 'OPENCLAW_TIMEOUT'
      throw e
    }
  }
  const thirdChat = adapterMod.createOpenClawService(() => chatGateway, 'third', true)
  let chatErr = null
  try {
    await thirdChat.chat({ conversationKey: 'conv:work:qa', messages: [] })
  } catch (e) {
    chatErr = e
  }
  assertEq(chatErr?.code, 'OPENCLAW_TIMEOUT', 'chat 错误 code 保留')
  assertEq(chatErr?.message, '网关超时', 'chat 错误固定安全文案')
  for (const bad of ['http://', '10.0.0.5', 'gateway.internal', '\\\\server', '/home/u', '[::1]', 'Program Files']) {
    assertEq(String(chatErr?.message ?? '').includes(bad), false, `chat 错误不得泄漏 ${bad}`)
  }

  // builtin 保持原始错误（宿主自用，不受第三方脱敏影响）
  const officialChat = adapterMod.createOpenClawService(() => chatGateway, 'work', false)
  let officialErr = null
  try {
    await officialChat.chat({ conversationKey: 'conv:work:qa', messages: [] })
  } catch (e) {
    officialErr = e
  }
  assertEq(officialErr?.code, 'OPENCLAW_TIMEOUT', 'builtin code 保留')
  assertEq(String(officialErr?.message ?? '').includes('http://'), true, 'builtin 保留原始 message')
  return '错误文案固定映射 ✓'
})

await r.check('S17', 'adapter/bridge：第三方无法用 projectId 进入宿主会话；无键合成 conv:plugin:<id>:default', async () => {
  const seen = []
  const gateway = {
    chat: async (input) => {
      seen.push(input)
      return { text: 'ok', model: 'm' }
    }
  }
  const third = adapterMod.createOpenClawService(() => gateway, 'third', true)
  await third.chat({ projectId: 'victim-project', messages: [] })
  assertEq('projectId' in seen[0], false, 'projectId 被剥离')
  assertEq(seen[0].conversationKey, 'conv:plugin:third:default', '无键合成 default 键（不留空）')
  await third.chat({ projectId: 'victim-project', conversationKey: 'conv:work:qa', messages: [] })
  assertEq('projectId' in seen[1], false, '带键时 projectId 仍被剥离')
  assertEq(seen[1].conversationKey, 'conv:plugin:third:work:qa', '已有键只改写')
  await third.chat({ conversationKey: 'conv:plugin:third:own', messages: [] })
  assertEq(seen[2].conversationKey, 'conv:plugin:third:own', '自己的键保留')

  // 走真实 bridge：服务解析返回 adapter，第三方经 ctx.services.openclaw.chat 调用
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['openclaw'] })
    const bridged = []
    const bridgedGateway = {
      chat: async (input) => {
        bridged.push(input)
        return { text: 'ok', model: 'm' }
      }
    }
    const service = adapterMod.createOpenClawService(() => bridgedGateway, 'p1', true)
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: (id, name) => (name === 'openclaw' ? service : undefined),
      broker
    })
    const result = await bridge.call('p1', 'openclaw', 'chat', [{ projectId: 'victim-project', messages: [] }])
    assertEq(result.text, 'ok', 'bridge chat 正常')
    assertEq('projectId' in bridged[0], false, 'bridge 路径 projectId 被剥离')
    assertEq(bridged[0].conversationKey, 'conv:plugin:p1:default', 'bridge 路径合成 default 键')
    return 'projectId 隔离 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('S18', 'stream 收口：bridge 拒绝、第三方 adapter 抛安全错误、builtin 正常', async () => {
  // 1) bridge 层：对第三方直接 NOT_FOUND（不进入 adapter）
  const dir = mkdtempSync(join(tmpdir(), 'umi-svc-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['openclaw'] })
    const bridge = bridgeMod.createPluginServiceBridge({
      resolveService: (id, name) =>
        name === 'openclaw' ? { status: async () => ({ ready: true }), stream: () => ({}) } : undefined,
      broker
    })
    let denied = null
    try {
      await bridge.call('p1', 'openclaw', 'stream', [{}])
    } catch (e) {
      denied = e
    }
    assertEq(denied?.code, errorsMod.ERROR_CODES.NOT_FOUND, 'bridge stream 拒绝（第三方 v1 不支持流式）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 2) adapter isolated 层：直接抛安全错误，不返回不可 structured-clone 的 handle
  const third = adapterMod.createOpenClawService(() => ({ chat: async () => ({}) }), 'third', true)
  let thrown = null
  try {
    third.stream({ messages: [] })
  } catch (e) {
    thrown = e
  }
  assertEq(thrown?.code, 'PLUGIN_OPERATION_FAILED', 'adapter isolated stream 安全拒绝')
  assert(!/AsyncGenerator|Promise|iterator/.test(thrown?.message ?? ''), '安全文案不暴露实现细节')

  // 3) builtin（fake GatewayClient，createChatStream 分支）保持原逻辑
  const streamedCalls = []
  const gatewayClient = {
    getStatus: async () => ({ ready: true, endpointsEnabled: true, port: 1, baseUrl: 'u', lastError: null }),
    createChatStream: (input) => {
      streamedCalls.push(input)
      return {
        iterator: (async function* () {
          yield { index: 0, delta: 'x' }
        })(),
        result: Promise.resolve({ text: 's', chunks: 2, aborted: false }),
        cancel: () => {}
      }
    }
  }
  const builtin = adapterMod.createOpenClawService(() => gatewayClient, 'work', false)
  const handle = builtin.stream({ conversationKey: 'conv:work:s', messages: [] })
  assertEq(typeof handle.cancel, 'function', 'builtin stream 返回 cancel')
  assertDeepEq(await handle.result, { text: 's', chunks: 2, aborted: false }, 'builtin stream result 收口')
  assertEq(streamedCalls[0].conversationKey, 'conv:work:s', 'builtin 不改写会话键')
  assertEq(streamedCalls[0].stream, true, 'builtin 传 stream:true')
  return 'stream 收口 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-service-bridge.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
