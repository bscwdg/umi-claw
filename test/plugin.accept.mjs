// test/plugin.accept.mjs —— Phase 0 插件内核验收（真源码，纯 Node）
//
// 覆盖 PLAN-4.0 §13 的前三条验收：
//   1. 宿主零插件也能启动（discover 空目录 / 坏清单不抛）
//   2. 启停后路由、导航、IPC、定时任务全部卸载
//   3. 插件异常只禁用自身，宿主继续运行
// 以及契约细节：manifest 校验 / 能力版本 / 重复 id / 激活超时 / LIFO 清理。
//
// 用法：node test/plugin.accept.mjs（npm run accept:plugin）

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  createJsonStateStore,
  createPluginConfigStore,
  availableServices,
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

// ── P10 停用的插件不加载 ────────────────────────────────────────────────────
await r.check('P10', '停用的插件：直接调 activate 也不加载（防止被别处误激活）', async () => {
  const ipc = createFakeIpc()
  let loaded = 0
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/off',
    source: '<test>',
    manifest: { ...manifest, id: 'off', defaultEnabled: false },
    loadMain: async () => {
      loaded += 1
      return { activate: () => undefined }
    }
  })
  const host = makeHost(registry, ipc)
  const status = await host.activate('off')
  assertEq(loaded, 0, '不应加载入口')
  assertEq(status.state, 'validated', '状态不前进')
  return '停用即不加载'
})

// ── P11 并发启用去重 ────────────────────────────────────────────────────────
await r.check('P11', '并发 setEnabled(true)×2：activate 只执行一次（不重复注册）', async () => {
  const ipc = createFakeIpc()
  let loaded = 0
  let activations = 0
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/race',
    source: '<test>',
    manifest: { ...manifest, id: 'race' },
    loadMain: async () => {
      loaded += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        activate: (ctx) => {
          activations += 1
          ctx.registerIpc('once', () => 'once')
        }
      }
    }
  })
  const host = makeHost(registry, ipc)
  const [a, b] = await Promise.all([host.setEnabled('race', true), host.setEnabled('race', true)])
  assertEq(loaded, 1, '入口只加载一次')
  assertEq(activations, 1, 'activate 只执行一次')
  assertEq(a.state, 'activated', '第一个状态')
  assertEq(b.state, 'activated', '第二个状态')
  assertEq(ipc.handlers.size, 1, '只有一条 handler')
  return '并发去重生效'
})

// ── P12 方法名约束 ──────────────────────────────────────────────────────────
await r.check('P12', '方法名约束：含冒号/空白的方法名被拒绝（防止通道伪造与解析歧义）', async () => {
  for (const bad of ['a:b', 'a b', '']) {
    let thrown = null
    try {
      pluginIpcChannel('probe', bad)
    } catch (e) {
      thrown = e
    }
    assert(thrown instanceof Error, `${JSON.stringify(bad)} 应被拒绝`)
  }
  assertEq(pluginIpcChannel('probe', 'ok_1'), 'plugin:probe:ok_1', '合法方法名')
  return '冒号/空白/空串均拒绝'
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
  const helloConfig = new Map()
  const registry = new PluginRegistry({
    persistedEnabled: { hello: true },
    hostServices: ['host', 'config']
  })
  registry.register({
    dir: join(repoRoot, 'resources', 'plugins', 'hello'),
    source: 'resources/plugins/hello/plugin.json',
    manifest: helloManifestRaw,
    loadMain: async () => helloMod.default
  })
  const host = makeHost(registry, ipc, {
    services: {
      config: () => ({
        get: (k, fallback) => (helloConfig.has(k) ? helloConfig.get(k) : fallback),
        set: (k, v) => {
          helloConfig.set(k, v)
        },
        all: () => Object.fromEntries(helloConfig)
      })
    }
  })
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
    },
    hasRoute(name) {
      return routes.has(name)
    },
    getRoutes() {
      return [...routes.values()]
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

await r.check('U3', 'UI 导航：按 order 排序，同 id 组合并条目（按 to 去重）', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)
  registry.apply('a', { nav: { id: 'x', label: 'X', order: 90, items: [{ to: '/a', icon: 'a', label: 'A' }] } })
  registry.apply('c', { nav: { id: 'x', label: 'X', order: 90, items: [{ to: '/c', icon: 'c', label: 'C' }] } })
  registry.apply('b', { nav: { id: 'y', label: 'Y', order: 10, items: [] } })

  assertEq(pluginNavGroups.value.map((g) => g.id).join(','), 'y,x', 'order 升序')
  const x = pluginNavGroups.value.find((g) => g.id === 'x')
  assertEq(x.items.map((i) => i.to).join(','), '/a,/c', '同 id 组合并两个插件的条目')
  assertEq(pluginNavGroups.value.filter((g) => g.id === 'x').length, 1, '同 id 仍只有一组')

  registry.remove('c')
  assertEq(
    (pluginNavGroups.value.find((g) => g.id === 'x')?.items ?? []).map((i) => i.to).join(','),
    '/a',
    '停用 c 只撤它自己的条目'
  )
  registry.clear()
  return '排序 + 合并 + 按归属撤销'
})

await r.check('U4', 'UI 路由冲突：插件不能覆盖内核路由名/路径（拒绝安装且不破坏内核路由）', async () => {
  const router = createFakeRouter()
  router.addRoute({ path: '/hello', name: 'hello' })
  const registry = new PluginUiRegistry(router)

  let nameConflict = false
  try {
    registry.apply('p', { routes: [{ path: '/other', name: 'hello' }] })
  } catch {
    nameConflict = true
  }
  assert(nameConflict, '同名路由应被拒绝')
  assert(router.hasRoute('hello'), '内核路由仍在')

  let pathConflict = false
  try {
    registry.apply('p', { routes: [{ path: '/hello', name: 'plugin-p-hello' }] })
  } catch {
    pathConflict = true
  }
  assert(pathConflict, '同路径路由应被拒绝')
  assertEq(registry.ids().length, 0, '失败安装无残留')
  return '命名/路径冲突都拒绝'
})

await r.check('U5', 'UI 插槽：多插件共用同名插槽，停一个只删自己的组件', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)
  const A = { name: 'A' }
  const B = { name: 'B' }
  registry.apply('a', { slot: { 'settings.side': A } })
  registry.apply('b', { slot: { 'settings.side': B } })
  assertEq((pluginSlots.value['settings.side'] ?? []).length, 2, '两个组件都在')

  registry.remove('a')
  const left = pluginSlots.value['settings.side'] ?? []
  assertEq(left.length, 1, '只剩 b 的组件')
  assertEq(left[0], B, '留下的是 B')
  registry.clear()
  assertEq(Object.keys(pluginSlots.value).length, 0, 'clear 后清空')
  return '按插件归属撤销'
})

await r.check('U6', 'UI 导航：共享 group id 时停用其一，另一插件导航仍保留', async () => {
  const router = createFakeRouter()
  const registry = new PluginUiRegistry(router)
  registry.apply('a', { nav: { id: 'plugins', label: '插件', order: 90, items: [{ to: '/a', icon: 'a', label: 'A' }] } })
  registry.apply('b', { nav: { id: 'plugins', label: '插件', order: 90, items: [{ to: '/b', icon: 'b', label: 'B' }] } })
  registry.remove('b')
  assertEq(pluginNavGroups.value.length, 1, '组还在')
  assertEq(pluginNavGroups.value[0].items.map((i) => i.to).join(','), '/a', '只撤 b 的条目')
  registry.clear()
  return '共享组不互删'
})

// ── P13~P20 审查/对抗报告里点出的边界 ────────────────────────────────────────
await r.check('P13', '幂等：已激活插件再 setEnabled(true) 不重复激活、状态不被污染', async () => {
  const ipc = createFakeIpc()
  let activations = 0
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/idem',
    source: '<test>',
    manifest: { ...manifest, id: 'idem' },
    loadMain: async () => ({
      activate: (ctx) => {
        activations += 1
        ctx.registerIpc('ping', () => 'pong')
      }
    })
  })
  const host = makeHost(registry, ipc)
  await host.setEnabled('idem', true)
  const again = await host.setEnabled('idem', true)
  assertEq(activations, 1, 'activate 只执行一次')
  assertEq(again.state, 'activated', '状态仍 activated')
  assertEq(ipc.handlers.size, 1, 'handler 不重复')
  return '幂等短路'
})

await r.check('P14', '停用打断在途激活：最终 disabled，不留 handler/定时器', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/late',
    source: '<test>',
    manifest: { ...manifest, id: 'late' },
    loadMain: async () => ({
      activate: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        ctx.registerIpc('late', () => 'late')
        ctx.jobs.every(20, () => undefined)
      }
    })
  })
  const host = makeHost(registry, ipc)
  const pending = host.activate('late')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await host.setEnabled('late', false)
  const status = await pending
  assertEq(status.state, 'disabled', '状态 disabled')
  assertEq(ipc.handlers.size, 0, '无 handler')
  assertEq(status.jobCount, 0, '无定时器')
  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, 'disposeAll 后仍无残留')
  return '在途激活被正确打断'
})

await r.check('P15', '激活超时后迟到注册被拒：handler/定时器都不再产生', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry()
  registry.register({
    dir: '/fake/slow2',
    source: '<test>',
    manifest: { ...manifest, id: 'slow2' },
    loadMain: async () => ({
      activate: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        ctx.registerIpc('late', () => 'late')
        ctx.jobs.every(20, () => undefined)
      }
    })
  })
  const host = makeHost(registry, ipc, { activationTimeoutMs: 40 })
  const status = await host.activate('slow2')
  assertEq(status.state, 'failed', '超时后 failed')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assertEq(ipc.handlers.size, 0, '迟到注册没有落地')
  assertEq(host.statuses().find((s) => s.id === 'slow2').jobCount, 0, '迟到定时器没有落地')
  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, 'disposeAll 后仍干净')
  return '超时后彻底失活'
})

await r.check('P16', '清单 id 与构建期入口不一致 → 拒绝注册（防止以 A 的 id 加载 B 的代码）', async () => {
  const registry = new PluginRegistry()
  let message = ''
  try {
    registry.register({ ...makeSource({ id: 'declared' }), entryId: 'entry' })
  } catch (e) {
    message = e.message
  }
  assert(message.includes('入口'), '错误应说明入口与清单不一致')
  return 'id 一致性校验'
})

await r.check('P17', '清单声明未知 inject 服务 → 拒绝注册并点名', async () => {
  const registry = new PluginRegistry()
  let message = ''
  try {
    registry.register(makeSource({ inject: ['db'] }))
  } catch (e) {
    message = e.message
  }
  assert(message.includes('db'), '错误点名未知服务')
  return 'inject 白名单'
})

await r.check('P18', 'onDemand 插件不参与启动激活（声明与行为一致）', async () => {
  const registry = new PluginRegistry()
  let loaded = 0
  registry.register({
    dir: '/fake/ondemand',
    source: '<test>',
    manifest: { ...manifest, id: 'od', activation: ['onDemand'] },
    loadMain: async () => {
      loaded += 1
      return { activate: () => undefined }
    }
  })
  const host = makeHost(registry, createFakeIpc())
  const statuses = await host.activateAll()
  assertEq(statuses.length, 0, '不在激活目标里')
  assertEq(loaded, 0, '未加载入口')
  return 'onDemand 留到 Phase 1'
})

await r.check('P19', '清单级失败进 plugin:list：状态 failed + code/stage，不再只剩 console', async () => {
  const registry = new PluginRegistry()
  const record = registry.addFailed(
    'broken',
    { code: 'PLUGIN_MANIFEST_INVALID', message: 'plugin.json 解析失败' },
    { dir: '/fake/broken', source: '<test>' }
  )
  assertEq(record.state, 'failed', '状态 failed')
  assertEq(record.error.stage, 'manifest', 'stage=manifest')
  const host = makeHost(registry, createFakeIpc())
  const status = host.statuses()[0]
  assertEq(status.id, 'broken', '列表可见')
  assertEq(status.error.code, 'PLUGIN_MANIFEST_INVALID', '错误码可见')
  return '失败插件可见'
})

await r.check('P20', '状态文件为非对象（数组/null/坏 JSON）时回落 {}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-plugin-state-'))
  for (const content of ['[true]', 'null', '{ 坏', '"true"']) {
    const file = join(dir, `s-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, content, 'utf-8')
    const loaded = await createJsonStateStore(file).load()
    assertEq(JSON.stringify(loaded), '{}', `${content} 应回落 {}`)
  }
  return '四类脏状态都回落空表'
})

// ── P21~P23 服务注入（Phase 1 WP1）───────────────────────────────────────────
await r.check('P21', '服务注入：只注入 inject 声明的服务，未声明的键不存在', async () => {
  const ipc = createFakeIpc()
  const shown = []
  const values = {}
  const factories = {
    config: () => ({
      get: (k, fallback) => (k in values ? values[k] : fallback),
      set: (k, v) => {
        values[k] = v
      },
      all: () => ({ ...values })
    }),
    notifications: () => ({ show: (n) => shown.push(n) })
  }
  const registry = new PluginRegistry({ hostServices: availableServices(factories) })
  registry.register({
    dir: '/fake/svc',
    source: '<test>',
    manifest: { ...manifest, id: 'svc', inject: ['host', 'config', 'notifications'] },
    loadMain: async () => ({
      activate(ctx) {
        ctx.services.config.set('seen', 1)
        ctx.services.notifications.show({ title: 't', body: 'b' })
        ctx.registerIpc('keys', () => Object.keys(ctx.services).sort())
      }
    })
  })
  const host = makeHost(registry, ipc, { services: factories })
  const status = await host.activate('svc')
  assertEq(status.state, 'activated', '激活成功')

  const keys = await ipc.invoke('plugin:svc:keys')
  assertEq(keys.join(','), 'config,notifications', '只有声明的两个服务')
  assertEq(values.seen, 1, 'config.set 生效')
  assertEq(shown.length, 1, 'notifications.show 生效')
  return '按 inject 精确注入'
})

await r.check('P22', '未声明 inject 的插件：ctx.services 为空（拿不到任何能力）', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry({ hostServices: ['host', 'config'] })
  registry.register({
    dir: '/fake/nos',
    source: '<test>',
    manifest: { ...manifest, id: 'nos', inject: ['host'] },
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerIpc('keys', () => Object.keys(ctx.services))
      }
    })
  })
  const host = makeHost(registry, ipc, {
    services: {
      config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) })
    }
  })
  await host.activate('nos')
  const keys = await ipc.invoke('plugin:nos:keys')
  assertEq(keys.length, 0, '没有任何服务')
  return '未声明即无能力'
})

await r.check('P23', '插件配置落盘：set → flush → 重新打开仍能读到（按插件命名空间隔离）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-plugin-config-'))
  const file = join(dir, 'plugin-config.json')

  const store = createPluginConfigStore(file)
  store.serviceFor('a').set('k', 42)
  store.serviceFor('b').set('k', 'other')
  await store.flush()

  const reopened = createPluginConfigStore(file)
  assertEq(reopened.values('a').k, 42, 'a 的值')
  assertEq(reopened.values('b').k, 'other', 'b 的值')
  assertEq(JSON.stringify(reopened.values('c')), '{}', '未写过的插件是空对象')
  return '命名空间隔离 + 原子落盘'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
