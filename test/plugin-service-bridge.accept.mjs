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

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-service-bridge.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
