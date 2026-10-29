// test/plugin.accept.mjs —— Phase 0 插件内核验收（真源码，纯 Node）
//
// 覆盖 PLAN-4.0 §13 的前三条验收：
//   1. 宿主零插件也能启动（discover 空目录 / 坏清单不抛）
//   2. 启停后路由、导航、IPC、定时任务全部卸载
//   3. 插件异常只禁用自身，宿主继续运行
// 以及契约细节：manifest 校验 / 能力版本 / 重复 id / 激活超时 / LIFO 清理。
//
// 用法：node test/plugin.accept.mjs（npm run accept:plugin）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  writeJson,
  __dirname,
  repoRoot
} from './_lib.mjs'

const r = new Recorder('Phase 0 · 插件内核（manifest / registry / lifecycle / UI registry）')

const kernelMod = await import(pathToFileURL(bundleEntry('electron/main/kernel/index.ts', 'kernel.mjs')).href)
const {
  PluginRegistry,
  PluginHost,
  parseManifest,
  PluginManifestError,
  discoverPlugins,
  pluginIpcChannel
} = kernelMod

const helloMod = await import(pathToFileURL(bundleEntry('plugins/hello/main.ts', 'hello-main.mjs')).href)
const helloManifestRaw = JSON.parse(
  readFileSync(join(repoRoot, 'resources', 'plugins', 'hello', 'plugin.json'), 'utf-8')
)

/** 假 ipcMain：记录注册/移除，暴露调用入口 */
function createFakeIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error('Attempted to register a second handler: ' + channel)
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    invoke(channel, payload) {
      const h = handlers.get(channel)
      if (!h) throw new Error('No handler registered for ' + channel)
      return h({ sender: null }, payload)
    }
  }
}

const manifest = {
  id: 'probe',
  name: '探针插件',
  version: '1.0.0',
  capabilities: ['host.ipc.v1', 'host.jobs.v1'],
  inject: ['host'],
  activation: ['onStartup'],
  contributes: { navGroup: { id: 'probe', label: '探针' }, routes: ['/probe'] },
  defaultEnabled: true
}

function makeSource(overrides = {}, mod = null) {
  return {
    dir: '/fake/probe',
    source: '<test>',
    manifest: { ...manifest, ...overrides },
    loadMain: async () => mod ?? { activate: () => undefined }
  }
}

function makeHost(registry, ipc, extra = {}) {
  return new PluginHost({
    registry,
    ipc,
    hostVersion: '4.0.0-test',
    dataDir: '/tmp/umi-test',
    logger: () => undefined,
    activationTimeoutMs: 100,
    ...extra
  })
}

// ── P1 manifest 校验 ────────────────────────────────────────────────────────
await r.check('P1', 'manifest：合法清单通过；id / 版本 / 能力格式 / 路由前缀非法时给出字段级错误', async () => {
  const ok = parseManifest(manifest)
  assertEq(ok.id, 'probe', 'id')
  assertEq(ok.activation[0], 'onStartup', 'activation 默认值')
  assertEq(ok.defaultEnabled, true, 'defaultEnabled')

  const cases = [
    [{ id: 'Bad_Id' }, 'id'],
    [{ version: '1.0' }, 'version'],
    [{ capabilities: ['hostdb'] }, 'capabilities'],
    [{ contributes: { routes: ['probe'] } }, 'contributes.routes']
  ]
  for (const [patch, field] of cases) {
    let thrown = null
    try {
      parseManifest({ ...manifest, ...patch })
    } catch (e) {
      thrown = e
    }
    assert(thrown instanceof PluginManifestError, `${field} 应抛 PluginManifestError`)
    assertEq(thrown.field, field, `${field} 的 field`)
  }
  return '4 类非法清单都被字段级拒绝'
})

// ── P2 能力版本 ─────────────────────────────────────────────────────────────
await r.check('P2', '能力版本：缺能力拒绝注册并列出缺失项；宿主能力表可注入', async () => {
  const registry = new PluginRegistry()
  let thrown = null
  try {
    registry.register(makeSource({ capabilities: ['host.ipc.v1', 'host.db.v1'] }))
  } catch (e) {
    thrown = e
  }
  assert(thrown instanceof PluginManifestError, '缺能力应抛错')
  assert(thrown.message.includes('host.db.v1'), '错误里应点名缺失能力')

  const okRegistry = new PluginRegistry({ hostCapabilities: ['host.db.v1'] })
  okRegistry.register(makeSource({ capabilities: ['host.db.v1'] }))
  assertEq(okRegistry.list().length, 1, '注入能力表后可注册')
  return '缺能力拒绝 + 能力表可注入'
})

// ── P3 激活：IPC / 任务 / 命名空间 ──────────────────────────────────────────
await r.check('P3', '激活：注册 plugin:<id>:<method> 通道 + 定时任务；handler 可调用', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/probe',
    source: '<test>',
    manifest,
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerIpc('ping', (payload) => ({ pong: true, echo: payload }))
        ctx.jobs.every(60_000, () => undefined, { name: 'tick' })
      }
    })
  })
  const host = makeHost(registry, ipc)
  const status = await host.activate('probe')

  assertEq(status.state, 'activated', '状态')
  assertEq(status.ipcMethods.join(','), 'ping', '方法清单')
  assertEq(status.jobCount, 1, '任务数')
  assertEq(pluginIpcChannel('probe', 'ping'), 'plugin:probe:ping', '通道名')

  const res = await ipc.invoke('plugin:probe:ping', { hello: 1 })
  assertEq(res.pong, true, 'handler 返回')
  assertEq(res.echo.hello, 1, 'payload 透传')

  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, '停用后无残留 handler')
  return '激活 + 调用 + 清理'
})

// ── P4 停用：注册物与任务全部回收 ───────────────────────────────────────────
await r.check('P4', '停用：handler 被 removeHandler、任务清零、LIFO 清理顺序正确', async () => {
  const ipc = createFakeIpc()
  const order = []
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/probe',
    source: '<test>',
    manifest,
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerIpc('a', () => 1)
        ctx.registerIpc('b', () => 2)
        ctx.onDispose(() => order.push('d1'))
        ctx.onDispose(() => order.push('d2'))
        ctx.jobs.timeout(10_000, () => undefined)
        return () => order.push('cleanup')
      }
    })
  })
  const host = makeHost(registry, ipc)
  await host.activate('probe')
  assertEq(ipc.handlers.size, 2, '激活后 2 条 handler')

  const status = await host.setEnabled('probe', false)
  assertEq(status.state, 'disabled', '状态为 disabled')
  assertEq(ipc.handlers.size, 0, '停用后 handler 全移除')
  assertEq(status.jobCount, 0, '任务清零')
  // activate 返回的 cleanup 最后入栈 → 最先执行；d2 后登记 → 先于 d1
  assertEq(order.join('>'), 'cleanup>d2>d1', 'LIFO 顺序')
  return '回收干净，LIFO 顺序正确'
})

// ── P5 失败隔离 ─────────────────────────────────────────────────────────────
await r.check('P5', '失败隔离：activate 抛错 → failed + 回滚 IPC；其它插件照常激活', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/broken',
    source: '<test>',
    manifest: { ...manifest, id: 'broken' },
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerIpc('half', () => 'half')
        throw new Error('故意炸')
      }
    })
  })
  registry.register({
    dir: '/fake/probe',
    source: '<test>',
    manifest,
    loadMain: async () => ({ activate: (ctx) => void ctx.registerIpc('ok', () => 'ok') })
  })

  const host = makeHost(registry, ipc)
  const statuses = await host.activateAll()
  const broken = statuses.find((s) => s.id === 'broken')
  const probe = statuses.find((s) => s.id === 'probe')

  assertEq(broken.state, 'failed', 'broken 应为 failed')
  assertEq(broken.error.message, '故意炸', '错误信息保留')
  assertEq(broken.ipcMethods.length, 0, '半注册的 IPC 已回滚')
  assertEq(probe.state, 'activated', '另一个插件照常激活')
  assert(!ipc.handlers.has('plugin:broken:half'), 'broken 的 handler 不存在')
  assert(ipc.handlers.has('plugin:probe:ok'), 'probe 的 handler 存在')
  return '失败只禁用自身'
})

// ── P6 重复 id ──────────────────────────────────────────────────────────────
await r.check('P6', '重复 id：注册第二个同 id 插件直接拒绝', async () => {
  const registry = new PluginRegistry()
  registry.register(makeSource())
  let code = null
  try {
    registry.register(makeSource())
  } catch (e) {
    code = e.code
  }
  assertEq(code, 'DUPLICATE_ID', '错误码')
  return 'DUPLICATE_ID'
})

// ── P7 坏清单不炸宿主 ───────────────────────────────────────────────────────
await r.check('P7', '零插件/坏清单：discover 不抛，坏清单只标记 loadError', async () => {
  const entries = {
    good: async () => ({ activate: () => undefined }),
    missing: async () => ({ activate: () => undefined }),
    broken: async () => ({ activate: () => undefined }),
    ghost: async () => ({ activate: () => undefined })
  }
  const found = discoverPlugins({
    root: join(repoRoot, 'test', 'fixtures', 'plugins'),
    entries
  })
  const byId = Object.fromEntries(found.map((f) => [f.id, f]))

  assertEq(found.length, 4, '四个入口都产出条目')
  assert(byId.good.manifest && byId.good.manifest.id === 'good', '合法清单被解析')
  assertEq(byId.missing.loadError, 'MANIFEST_MISSING', '缺清单标记')
  assert(Boolean(byId.broken.loadError), '坏 JSON 标记')
  assertEq(byId.ghost.manifest && byId.ghost.manifest.id, 'ghost', '磁盘有清单但未登记者仍可解析（由宿主决定是否加载）')
  return '坏插件不影响宿主'
})

// ── P8 激活超时 ─────────────────────────────────────────────────────────────
await r.check('P8', '激活超时：插件 activate 挂住 → failed（不拖死宿主）', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/slow',
    source: '<test>',
    manifest: { ...manifest, id: 'slow' },
    loadMain: async () => ({ activate: () => new Promise(() => undefined) })
  })
  const host = makeHost(registry, ipc, { activationTimeoutMs: 50 })
  const status = await host.activate('slow')
  assertEq(status.state, 'failed', '状态')
  assert(status.error.message.includes('激活超时'), '错误信息应说明超时')
  return '超时被隔离'
})

// ── P9 真 hello 插件（清单 + 入口） ─────────────────────────────────────────
await r.check('P9', '真插件：resources/plugins/hello 清单可解析，入口激活后 ping 可用', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry({ persistedEnabled: { hello: true } })
  registry.register({
    dir: join(repoRoot, 'resources', 'plugins', 'hello'),
    source: 'resources/plugins/hello/plugin.json',
    manifest: helloManifestRaw,
    loadMain: async () => helloMod.default
  })
  const host = makeHost(registry, ipc)
  const status = await host.activate('hello')

  assertEq(status.state, 'activated', 'hello 激活')
  assertEq(status.ipcMethods.join(','), 'ping,state', '两条方法')
  const pong = await ipc.invoke('plugin:hello:ping', 'hi')
  assertEq(pong.pong, true, 'ping 返回 pong')
  assertEq(pong.echo, 'hi', 'payload 透传')
  const st = await ipc.invoke('plugin:hello:state')
  assertEq(st.hostVersion, '4.0.0-test', 'context 里的宿主版本')

  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, '停用后无残留')
  return 'hello 全链路'
})

// ── U1~U3 渲染端注册表 ──────────────────────────────────────────────────────
const uiMod = await import(pathToFileURL(bundleEntry('src/renderer/pluginUi.ts', 'plugin-ui.mjs')).href)
const { PluginUiRegistry, pluginNavGroups, pluginSlots } = uiMod

function createFakeRouter() {
  const routes = new Map()
  return {
    routes,
    addRoute(route) {
      const name = route.name ?? route.path
      routes.set(name, route)
      return () => routes.delete(name)
    }
  }
}

await r.check('U1', 'UI 注册：apply 后路由/导航组/插槽都在，remove 后完全消失', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)

  registry.apply('hello', {
    routes: [{ path: '/hello', name: 'h', component: {} }],
    nav: { id: 'plugins', label: '插件', order: 90, items: [{ to: '/hello', icon: '👋', label: 'Hello' }] },
    slot: { 'settings.side': {} }
  })

  assert(router.routes.has('h'), '路由已注册')
  assertEq(pluginNavGroups.value.length, 1, '导航组已加入')
  assertEq(pluginNavGroups.value[0].id, 'plugins', '导航组 id')
  assertEq((pluginSlots.value['settings.side'] ?? []).length, 1, '插槽已登记')

  registry.remove('hello')
  assert(!router.routes.has('h'), '路由已移除')
  assertEq(pluginNavGroups.value.length, 0, '导航组已移除')
  assertEq((pluginSlots.value['settings.side'] ?? []).length, 0, '插槽已移除')
  return '安装/卸载对称'
})

await r.check('U2', 'UI 注册：apply 中途抛错 → 不留下半装状态', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)
  let threw = false
  try {
    registry.apply('bad', {
      routes: [{ path: '/bad', name: 'bad', component: {} }],
      setup() {
        throw new Error('setup 炸了')
      }
    })
  } catch {
    threw = true
  }
  assert(threw, 'apply 应把错误抛给调用方')
  assert(!router.routes.has('bad'), '半装的路由已回滚')
  assertEq(registry.ids().length, 0, '注册表无残留')
  return '失败不留半装'
})

await r.check('U3', 'UI 注册：导航组按 order 排序，重复 id 覆盖不叠加', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)
  registry.apply('a', { nav: { id: 'x', label: 'X', order: 90, items: [] } })
  registry.apply('b', { nav: { id: 'y', label: 'Y', order: 10, items: [] } })
  assertEq(pluginNavGroups.value.map((g) => g.id).join(','), 'y,x', 'order 升序')

  registry.apply('a', { nav: { id: 'x', label: 'X2', order: 90, items: [] } })
  assertEq(pluginNavGroups.value.filter((g) => g.id === 'x').length, 1, '同 id 不叠加')
  assertEq(pluginNavGroups.value.find((g) => g.id === 'x').label, 'X2', '内容被覆盖')
  registry.clear()
  return '排序 + 幂等'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
