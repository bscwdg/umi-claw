// test/plugin.accept.mjs —— Phase 0 插件内核验收（真源码，纯 Node）
//
// 覆盖 PLAN-4.0 §13 的前三条验收：
//   1. 宿主零插件也能启动（discover 空目录 / 坏清单不抛）
//   2. 启停后路由、导航、IPC、定时任务全部卸载
//   3. 插件异常只禁用自身，宿主继续运行
// 以及契约细节：manifest 校验 / 能力版本 / 重复 id / 激活超时 / LIFO 清理。
//
// 用法：node test/plugin.accept.mjs（npm run accept:plugin）

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  repoRoot,
  resolveNodePath,
  domainSrc
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
const workMod = await import(
  pathToFileURL(
    bundleEntry('plugins/work/main.ts', 'work-main.mjs', {
      alias: ['electron=./test/.tmp/electron-stub.mjs'],
      externals: ['mammoth', 'exceljs', 'docx', 'pdfjs-dist']
    })
  ).href
)
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
    registry.register(makeSource({ capabilities: ['host.ipc.v1', 'host.nonexistent.v1'] }))
  } catch (e) {
    thrown = e
  }
  assert(thrown instanceof PluginManifestError, '缺能力应抛错')
  assert(thrown.message.includes('host.nonexistent.v1'), '错误里应点名缺失能力')

  const okRegistry = new PluginRegistry({ hostCapabilities: ['host.nonexistent.v1'] })
  okRegistry.register(makeSource({ capabilities: ['host.nonexistent.v1'] }))
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

// ── P9 真 hello 插件（清单 + 入口 + 插件库） ─────────────────────────────────
await r.check('P9', '真插件：hello 清单可解析，入口激活后 ping / 插件库可用', async () => {
  const ipc = createFakeIpc()
  const helloConfig = new Map()
  const notes = []
  const fakeDb = {
    path: ':memory:',
    async migrate() {},
    async list(table) {
      assertEq(table, 'notes', '只允许访问插件自己的表')
      return notes
    },
    async create(table, values) {
      assertEq(table, 'notes', '写入也走白名单')
      notes.push(values)
      return values
    },
    async get() {
      return null
    },
    async update() {
      return { changes: 0 }
    },
    async remove() {
      return { deleted: false }
    },
    async backup() {
      return { path: ':memory:' }
    }
  }
  const services = {
    config: () => ({
      get: (k, fallback) => (helloConfig.has(k) ? helloConfig.get(k) : fallback),
      set: (k, v) => {
        helloConfig.set(k, v)
      },
      all: () => Object.fromEntries(helloConfig)
    }),
    db: () => fakeDb
  }
  const registry = new PluginRegistry({
    persistedEnabled: { hello: true },
    hostServices: availableServices(services)
  })
  registry.register({
    dir: join(repoRoot, 'resources', 'plugins', 'hello'),
    source: 'resources/plugins/hello/plugin.json',
    manifest: helloManifestRaw,
    loadMain: async () => helloMod.default
  })
  const host = makeHost(registry, ipc, { services })
  const status = await host.activate('hello')

  assertEq(status.state, 'activated', 'hello 激活')
  assertEq(status.ipcMethods.join(','), 'note.add,ping,state', '三条方法')
  const pong = await ipc.invoke('plugin:hello:ping', 'hi')
  assertEq(pong.pong, true, 'ping 返回 pong')
  assertEq(pong.echo, 'hi', 'payload 透传')

  await ipc.invoke('plugin:hello:note.add', { body: '第一条' })
  assertEq(notes.length, 1, 'note.add 写入插件库')
  const st = await ipc.invoke('plugin:hello:state')
  assertEq(st.hostVersion, '4.0.0-test', 'context 里的宿主版本')
  assertEq(st.notes, 1, 'state 能读到自己的数据')

  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, '停用后无残留')
  return 'hello 全链路（含插件库）'
})

// ── P24 管理页纯逻辑（Phase 1 WP4）──────────────────────────────────────────
const adminMod = await import(
  pathToFileURL(bundleEntry('src/renderer/pluginAdmin.ts', 'plugin-admin.mjs')).href
)
const {
  matchesPluginRoute,
  disablingBreaksCurrentPage,
  stateLabel,
  errorSummary,
  sortForDisplay,
  shouldConfirmDisable,
  openableRoute,
  normalizeListPayload
} = adminMod

await r.check('P24', '管理页逻辑：路由归属判定 / 停用拦截 / 状态文案 / 失败排序', async () => {
  assertEq(matchesPluginRoute(['/hello'], '/hello'), true, '精确命中')
  assertEq(matchesPluginRoute(['/hello'], '/hello/x'), true, '前缀命中')
  assertEq(matchesPluginRoute(['/hello'], '/helloworld'), false, '不误伤同前缀单词')
  assertEq(matchesPluginRoute(undefined, '/hello'), false, '无路由不命中')

  const running = { id: 'hello', name: 'Hello', version: '0.1.0', state: 'activated', enabled: true, ipcMethods: [], jobCount: 0, contributes: { routes: ['/hello'] } }
  const disabled = { ...running, enabled: false, state: 'disabled' }
  assertEq(disablingBreaksCurrentPage(running, '/hello'), true, '当前页属于它 → 要拦')
  assertEq(disablingBreaksCurrentPage(running, '/dashboard'), false, '不在它的页面 → 不拦')
  assertEq(disablingBreaksCurrentPage(disabled, '/hello'), false, '已停用不拦')

  assertEq(stateLabel(running), '运行中', '运行中文案')
  assertEq(stateLabel(disabled), '已停用', '停用中文案')
  assertEq(stateLabel({ ...running, state: 'failed', error: { code: 'X', message: 'm' } }), '加载失败', '失败文案')
  assertEq(errorSummary({ ...running, error: { code: 'X', stage: 'manifest', message: '坏了' } }), 'X（manifest）：坏了', '失败摘要')

  const sorted = sortForDisplay([
    { ...running, id: 'b' },
    { ...running, id: 'a', state: 'failed' }
  ])
  assertEq(sorted.map((s) => s.id).join(','), 'a,b', '失败项排前')
  return '5 个纯函数行为正确'
})

// ── P32 渲染端能力边界（静态扫描）+ 管理页新增纯函数 ────────────────────────
await r.check('P32', '渲染端边界：插件 renderer 不得直接用 window.api / electron / require', async () => {
  const dir = join(repoRoot, 'plugins')
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, 'renderer.ts'))
    .filter((f) => existsSync(f))
  assert(files.length > 0, '至少有一个插件 renderer')

  for (const file of files) {
    // 去掉注释再扫：注释里解释「不要用 window.api」不该被当成违规
    const src = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const name = file.replace(repoRoot, '')
    assert(!/window\.api/.test(src), `${name} 不应使用 window.api（宿主 API）`)
    assert(!/window\.electron/.test(src), `${name} 不应使用 window.electron`)
    assert(!/from ['"]electron['"]/.test(src), `${name} 不应 import electron`)
    assert(!/require\(/.test(src), `${name} 不应 require`)
    assert(/host\.invoke|invoke</.test(src), `${name} 应通过 host.invoke 调自己的能力`)
  }
  return `${files.length} 个插件 renderer 都守边界`
})

await r.check('P33', '管理页新增逻辑：确认条件 / 可打开路由 / 列表载荷防御 / 路径规整', async () => {
  const running = {
    id: 'hello',
    name: 'Hello',
    version: '0.1.0',
    state: 'activated',
    enabled: true,
    ipcMethods: [],
    jobCount: 0,
    contributes: { routes: ['/hello'] }
  }
  assertEq(shouldConfirmDisable(running), true, '运行中且有页面 → 要确认')
  assertEq(shouldConfirmDisable({ ...running, state: 'failed' }), false, '失败态不确认')
  assertEq(shouldConfirmDisable({ ...running, contributes: {} }), false, '没页面不确认')
  assertEq(openableRoute(running), '/hello', '运行中给链接')
  assertEq(openableRoute({ ...running, enabled: false }), '', '停用不给链接')
  assertEq(openableRoute({ ...running, state: 'failed' }), '', '失败不给链接')

  assertEq(matchesPluginRoute(['/hello'], '/Hello'), true, '大小写不敏感（与 vue-router 一致）')
  assertEq(matchesPluginRoute(['/hello'], '/hello/'), true, '尾斜杠宽松')
  assertEq(matchesPluginRoute(['/'], '/dashboard'), true, '根路由按接管处理')

  let threw = false
  try {
    normalizeListPayload({ ok: true })
  } catch {
    threw = true
  }
  assert(threw, '非数组载荷应报错而不是塞进 v-for')
  assertEq(normalizeListPayload([running]).length, 1, '数组原样返回')
  return '4 个新增函数行为正确'
})

// ── P34/P35 通道租约（D1）+ 域源码定位（D3）────────────────────────────────
await r.check('P34', '通道租约：跨插件唯一、只能注册租用命名空间、停用即摘除', async () => {
  const ipc = createFakeIpc()
  const manifestWithChannels = (id, channels) => ({ ...manifest, id, channels })
  const registry = new PluginRegistry()

  // 租约唯一
  registry.register({
    dir: '/fake/w1',
    source: '<test>',
    manifest: manifestWithChannels('w1', ['work']),
    loadMain: async () => ({ activate: () => undefined })
  })
  let dup = false
  try {
    registry.register({
      dir: '/fake/w2',
      source: '<test>',
      manifest: manifestWithChannels('w2', ['work']),
      loadMain: async () => ({ activate: () => undefined })
    })
  } catch (e) {
    dup = String(e.message).includes('已被插件 w1 租用')
  }
  assert(dup, '同一命名空间不能租给两个插件')

  // 只能注册自己租的命名空间
  const reg2 = new PluginRegistry()
  reg2.register({
    dir: '/fake/lease',
    source: '<test>',
    manifest: manifestWithChannels('lease', ['work']),
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerChannelIpc('work:records:list', () => [{ id: 'r1' }])
        try {
          ctx.registerChannelIpc('other:whatever', () => 1)
        } catch (e) {
          ctx.registerIpc('no-lease', () => e.code ?? 'NO_CODE')
        }
        try {
          ctx.registerChannelIpc('plugin:hack', () => 1)
        } catch (e) {
          ctx.registerIpc('reserved', () => (e instanceof Error ? 'PLUGIN_PREFIX_REJECTED' : 'NOPE'))
        }
      }
    })
  })
  const host = makeHost(reg2, ipc)
  const status = await host.activate('lease')
  assertEq(status.state, 'activated', '激活成功')
  assertEq(status.channels.join(','), 'work:records:list', '只登记了租约通道')
  assertEq((await ipc.invoke('work:records:list'))[0].id, 'r1', '通道可调用')
  assertEq(await ipc.invoke('plugin:lease:no-lease'), 'CHANNEL_NOT_LEASED', '未租命名空间被拒')
  assertEq(await ipc.invoke('plugin:lease:reserved'), 'PLUGIN_PREFIX_REJECTED', 'plugin: 前缀被拒')

  // 另一个插件抢同一通道 → 冲突
  const reg3 = new PluginRegistry()
  reg3.register({
    dir: '/fake/steal',
    source: '<test>',
    manifest: manifestWithChannels('steal', ['work']),
    loadMain: async () => ({
      activate(ctx) {
        try {
          ctx.registerChannelIpc('work:records:list', () => [])
        } catch (e) {
          ctx.registerIpc('steal', () => e.code ?? 'NO_CODE')
        }
      }
    })
  })
  const host2 = makeHost(reg3, ipc)
  const stealStatus = await host2.activate('steal')
  assertEq(stealStatus.state, 'activated', 'steal 应激活：' + JSON.stringify(stealStatus.error))
  assertEq(await ipc.invoke('plugin:steal:steal'), 'CHANNEL_CONFLICT', '同一通道不能双占')

  await host.disposeAll()
  await host2.disposeAll()
  assertEq(ipc.handlers.size, 0, '停用后租约通道也被摘除')
  return '租约唯一 + 命名空间校验 + 停用摘除'
})

await r.check('P35', 'domainSrc：装箱前后都能定位到域源码（D3 适配层）', async () => {
  const before = domainSrc('work', 'index.ts')
  assertEq(before, join(repoRoot, 'electron', 'main', 'index.ts'), '当前未装箱 → 回落旧路径')
  assert(existsSync(before), '回落路径存在')
  const missing = domainSrc('work', 'not-exists.ts')
  assertEq(missing, join(repoRoot, 'electron', 'main', 'not-exists.ts'), '不存在的文件也给出旧路径（由断言自己报缺失）')
  return '适配层可用'
})

// ── P25~P27 每插件独立库（Phase 1 WP2）──────────────────────────────────────
const schemaMod = await import(
  pathToFileURL(bundleEntry('electron/main/kernel/pluginSchema.ts', 'plugin-schema.mjs')).href
)
const { loadPluginSchema } = schemaMod
const dbMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginDb.ts', 'plugin-db.mjs')).href
)
const { createPluginDbService } = dbMod

await r.check('P25', 'schema 解析：从 hello 的 migrations 推出表/列/主键/目标版本', async () => {
  const schema = loadPluginSchema(join(repoRoot, 'plugins', 'hello', 'migrations'))
  assertEq(schema.targetUserVersion, 1, '目标版本')
  assertEq(schema.steps.length, 1, '一步迁移')
  const notes = schema.tables.notes
  assert(Boolean(notes), '解析出 notes 表')
  assertEq(notes.pk.join(','), 'id', '主键')
  assertEq(notes.columns.join(','), 'id,body,created_at,updated_at', '列顺序与内容')
  assertEq(notes.createdAt, 'created_at', 'createdAt 元列')
  return 'SQL → 结构推导正确'
})

await r.check('P26', '插件库：真 worker + 真迁移 + CRUD（notes 能建、work 的表不可见）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-plugindb-'))
  const pluginDir = join(root, 'alpha')
  mkdirSync(join(pluginDir, 'migrations'), { recursive: true })
  writeFileSync(
    join(pluginDir, 'migrations', '001_init.sql'),
    'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER);',
    'utf-8'
  )

  const svc = createPluginDbService({
    dataDir: join(root, 'data'),
    nodePath: resolveNodePath(),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs')
  })

  try {
    const db = svc.forPlugin({ id: 'alpha', dir: pluginDir })
    await db.migrate()
    await db.create('notes', { id: 'n1', body: 'hello', created_at: 1 })
    const rows = await db.list('notes')
    assertEq(rows.length, 1, '写入后能查到')
    assertEq(rows[0].body, 'hello', '内容正确')
    assert(String(db.path).endsWith(join('plugins', 'alpha', 'data.db')), '库文件在插件目录下')

    const tablesJson = JSON.parse(
      readFileSync(join(root, 'data', 'plugins', 'alpha', 'tables.json'), 'utf-8')
    )
    assertEq(Object.keys(tablesJson).join(','), 'notes', 'tables.json 只有插件自己的表')

    let rejected = false
    try {
      await db.list('todos')
    } catch (e) {
      rejected = String(e.message).includes('未在插件 migrations 中定义')
    }
    assert(rejected, '未知表应被拒绝')
  } finally {
    await svc.disposeAll()
  }
  return '真 worker 建库 + CRUD + 白名单'
})

await r.check('P27', '插件库隔离：两插件各自的库互不可见；重复 migrate 幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-plugindb2-'))
  for (const id of ['a', 'b']) {
    mkdirSync(join(root, id, 'migrations'), { recursive: true })
    writeFileSync(
      join(root, id, 'migrations', '001_init.sql'),
      `CREATE TABLE IF NOT EXISTS items_${id} (id TEXT PRIMARY KEY, v TEXT);`,
      'utf-8'
    )
  }
  const svc = createPluginDbService({
    dataDir: join(root, 'data'),
    nodePath: resolveNodePath(),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs')
  })

  try {
    const a = svc.forPlugin({ id: 'a', dir: join(root, 'a') })
    const b = svc.forPlugin({ id: 'b', dir: join(root, 'b') })
    await a.migrate()
    await b.migrate()
    await a.create('items_a', { id: '1', v: 'A' })

    assertEq((await a.list('items_a')).length, 1, 'a 库有数据')
    let bCannot = false
    try {
      await b.list('items_a')
    } catch {
      bCannot = true
    }
    assert(bCannot, 'b 看不到 a 的表')
    assert(a.path !== b.path, '两个插件库文件不同')

    await a.migrate()
    assertEq((await a.list('items_a')).length, 1, '重复 migrate 保留数据')
  } finally {
    await svc.disposeAll()
  }
  return '库隔离 + 迁移幂等'
})

// ── P36 work 装箱准备：SQL 迁移与现有 work.db 结构等价 ─────────────────────
await r.check('P36', 'work 装箱准备：插件 migrations 解析出的结构与 work.db 等价（8 表 + v3 列）', async () => {
  const schema = loadPluginSchema(join(repoRoot, 'plugins', 'work', 'migrations'))
  assertEq(schema.targetUserVersion, 3, '目标版本 v3（与现有 work.db 一致）')
  assertEq(
    Object.keys(schema.tables).sort().join(','),
    'activity_log,app_meta,conversations,knowledge,matters,profile,reports,todos',
    '8 张表与 schema.ts 一致'
  )
  assertEq(schema.tables.todos.columns.includes('due_at'), true, 'v3 的 due_at 被合并进结构')
  assertEq(schema.tables.todos.columns.includes('remind_at'), true, 'v2 的 remind_at 被合并进结构')
  assertEq(schema.tables.app_meta.pk.join(','), 'key', 'app_meta 主键')
  assertEq(schema.tables.conversations.updatedAt, null, 'conversations 没有 updated_at')

  const root = mkdtempSync(join(tmpdir(), 'umi-workdb-'))
  const svc = createPluginDbService({
    dataDir: join(root, 'data'),
    nodePath: resolveNodePath(),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs')
  })
  try {
    const db = svc.forPlugin({ id: 'work', dir: join(repoRoot, 'plugins', 'work') })
    await db.migrate()
    await db.request('matters.create', {
      data: { id: 'm1', name: '合同', status: 'active', created_at: 1, updated_at: 1 }
    })
    const rows = await db.request('matters.list', {})
    assertEq(rows.length, 1, '迁移后能写入并查回')
    assertEq(rows[0].name, '合同', '内容正确')

    let marketingTableBlocked = false
    try {
      await db.request('projects.list', {})
    } catch {
      marketingTableBlocked = true
    }
    assert(marketingTableBlocked, '营销域的表不在 work 插件库里')
  } finally {
    await svc.disposeAll()
  }
  return 'work 结构可迁移、可用、不越界'
})

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

// ── P28~P31 审查/对抗报告里点出的服务与落盘边界 ─────────────────────────────
await r.check('P28', 'inject 门禁：未声明 config 时 ctx.config 为 undefined', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry({ hostServices: ['host', 'config'] })
  registry.register({
    dir: '/fake/gate',
    source: '<test>',
    manifest: { ...manifest, id: 'gate', inject: ['host'] },
    loadMain: async () => ({
      activate(ctx) {
        ctx.registerIpc('probe', () => ({ config: ctx.config === undefined, services: Object.keys(ctx.services) }))
      }
    })
  })
  const host = makeHost(registry, ipc, {
    services: { config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) }) }
  })
  await host.activate('gate')
  const res = await ipc.invoke('plugin:gate:probe')
  assertEq(res.config, true, 'ctx.config 必须是 undefined')
  assertEq(res.services.length, 0, 'services 也是空')
  return '别名不绕过 inject'
})

await r.check('P29', '清单级失败不可启用；运行时失败可重试', async () => {
  const registry = new PluginRegistry()
  registry.addFailed('broken', { code: 'PLUGIN_MANIFEST_INVALID', message: '坏了' }, { dir: '/x', source: '<t>' })
  let blocked = false
  try {
    registry.setEnabled('broken', true)
  } catch {
    blocked = true
  }
  assert(blocked, '清单级失败应拒绝启用')

  const ipc = createFakeIpc()
  let attempts = 0
  const reg2 = new PluginRegistry()
  reg2.register({
    dir: '/fake/retry',
    source: '<test>',
    manifest: { ...manifest, id: 'retry' },
    loadMain: async () => ({
      activate: () => {
        attempts += 1
        if (attempts === 1) throw new Error('第一次失败')
      }
    })
  })
  const host = makeHost(reg2, ipc)
  const first = await host.setEnabled('retry', true)
  assertEq(first.state, 'failed', '第一次失败')
  const second = await host.setEnabled('retry', true)
  assertEq(second.state, 'activated', '重试成功')
  assertEq(attempts, 2, '确实重试了一次')
  return '失败态闭环'
})

await r.check('P30', '服务名单一来源：availableServices 的每个名字都能被真实解析', async () => {
  const factories = {
    config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) }),
    db: () => ({
      path: ':memory:',
      migrate: async () => undefined,
      list: async () => [],
      get: async () => null,
      create: async () => ({}),
      update: async () => ({ changes: 0 }),
      remove: async () => ({ deleted: false }),
      backup: async () => ({ path: ':memory:' })
    }),
    notifications: () => ({ show: () => undefined }),
    openclaw: () => ({
      status: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      chat: async () => ({ text: '', model: null }),
      stream: () => {
        throw new Error('not used')
      }
    }),
    voice: () => ({ speak: async () => undefined })
  }
  const names = availableServices(factories).filter((n) => n !== 'host')
  assertEq(names.slice().sort().join(','), 'config,db,notifications,openclaw,voice', '名单覆盖全部服务')

  for (const name of names) {
    const ipc = createFakeIpc()
    const registry = new PluginRegistry({ hostServices: availableServices(factories) })
    registry.register({
      dir: '/fake/s',
      source: '<test>',
      manifest: { ...manifest, id: 's', inject: ['host', name] },
      loadMain: async () => ({
        activate(ctx) {
          ctx.registerIpc('has', () => Boolean(ctx.services[name]))
        }
      })
    })
    const host = makeHost(registry, ipc, { services: factories })
    const status = await host.activate('s')
    assertEq(status.state, 'activated', `${name} 应可激活`)
    assertEq(await ipc.invoke('plugin:s:has'), true, `${name} 应被注入`)
    await host.disposeAll()
  }
  return '注册期校验与解析同源'
})

await r.check('P31', '配置落盘健壮性：坏文件先备份、坏值只影响该插件、写失败 flush 返回 false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-plugin-config2-'))
  const file = join(dir, 'plugin-config.json')

  writeFileSync(file, '{ 坏 JSON', 'utf-8')
  const store = createPluginConfigStore(file, { onError: () => undefined })
  assertEq(JSON.stringify(store.values('x')), '{}', '坏文件回落空表')
  assertEq(readdirSync(dir).filter((f) => f.includes('.bad-')).length, 1, '坏文件被备份')

  const cyclic = {}
  cyclic.self = cyclic
  store.serviceFor('bad').set('loop', cyclic)
  store.serviceFor('good').set('k', 1)
  assertEq(await store.flush(), false, '含坏值的 flush 返回失败')
  const reopened = createPluginConfigStore(file, { onError: () => undefined })
  assertEq(JSON.stringify(reopened.values('bad')), '{}', '坏插件未落盘')
  assertEq(reopened.values('good').k, 1, '好插件照常落盘')

  // 让父路径是个文件 → mkdirSync 必失败（比「目标是个目录」更可靠的写失败注入）
  const blockedParent = join(dir, 'blocked-parent')
  writeFileSync(blockedParent, 'x', 'utf-8')
  const dirTarget = join(blockedParent, 'plugin-config.json')
  const store2 = createPluginConfigStore(dirTarget, { onError: () => undefined })
  store2.serviceFor('p').set('k', 1)
  assertEq(await store2.flush(), false, '写失败返回 false')
  assertEq(store2.errors().length > 0, true, '失败被记录')
  return '落盘失败可见、坏值隔离'
})

// ── P37 work 插件：装配 Manager + 注册 work:* 通道 + 停用摘除 ────────────────
await r.check('P37', 'work 插件：激活后 work:* 通道可用，停用后全部摘除', async () => {
  const ipc = createFakeIpc()
  const calls = []
  const fakeDb = {
    path: ':memory:',
    async migrate() {},
    async metaGet() {
      return null
    },
    async metaSet() {
      return { changes: 1 }
    },
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'matters.list') return [{ id: 'm1', name: '合同', status: 'active' }]
      if (method.endsWith('.list')) return []
      if (method.endsWith('.get')) return null
      return { changes: 1 }
    },
    async list() {
      return []
    },
    async get() {
      return null
    },
    async create() {
      return {}
    },
    async update() {
      return { changes: 1 }
    },
    async remove() {
      return { deleted: true }
    },
    async backup() {
      return { path: ':memory:' }
    }
  }
  const gateway = {
    getStatus: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
    ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
    chat: async () => ({ text: '', model: null }),
    stream: () => {
      throw new Error('not used')
    }
  }
  const hostOps = {
    notify: () => undefined,
    push: async () => ({ ok: true }),
    listPushChannels: async () => [],
    listPushTargets: async () => [],
    locateOldDbs: () => [],
    readOldDb: async () => ({})
  }
  const services = {
    db: () => fakeDb,
    openclaw: () => gateway,
    hostOps: () => hostOps,
    config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) })
  }

  const manifestForWork = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'plugins', 'work', 'plugin.json'), 'utf-8')
  )
  const registry = new PluginRegistry({
    hostServices: availableServices(services),
    persistedEnabled: { work: true }
  })
  registry.register({
    dir: join(repoRoot, 'plugins', 'work'),
    source: 'resources/plugins/work/plugin.json',
    manifest: manifestForWork,
    loadMain: async () => workMod.default
  })
  const host = makeHost(registry, ipc, {
    services,
    paths: { appPath: repoRoot, resourcesPath: join(repoRoot, 'resources'), isPackaged: false }
  })
  const status = await host.activate('work')
  assertEq(status.state, 'activated', 'work 激活：' + JSON.stringify(status.error))
  assert(status.channels.some((c) => c.startsWith('work:')), '注册了 work:* 通道')
  assert(status.channels.includes('work:matters:list'), 'matters.list 通道存在')

  const rows = await ipc.invoke('work:matters:list', {})
  assertEq(rows.data.length, 1, '通道能查到数据（经 Manager → 注入的 db）')
  assert(calls.some((c) => c.method === 'matters.list'), 'Manager 真的走到了注入的数据库')

  await host.disposeAll()
  assertEq(ipc.handlers.size, 0, '停用后 work:* 通道全部摘除')
  return `work 插件通道 ${status.channels.length} 条，停用清零`
})
// ── P38 work 插件：停用 → 重新启用后数据仍在（真插件库） ─────────────────────
await r.check('P38', 'work 插件启停循环：停用摘通道，重新启用后数据仍在', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-workcycle-'))
  const pluginDb = createPluginDbService({
    dataDir: root,
    nodePath: resolveNodePath(),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs')
  })
  const ipc = createFakeIpc()
  const services = {
    db: () => pluginDb.forPlugin({ id: 'work', dir: join(repoRoot, 'plugins', 'work') }),
    openclaw: () => ({
      getStatus: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      chat: async () => ({ text: '', model: null }),
      stream: () => {
        throw new Error('not used')
      }
    }),
    hostOps: () => ({
      notify: () => undefined,
      push: async () => ({ ok: true }),
      listPushChannels: async () => [],
      listPushTargets: async () => [],
      locateOldDbs: () => [],
      readOldDb: async () => ({})
    }),
    config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) })
  }
  const manifestForWork = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'plugins', 'work', 'plugin.json'), 'utf-8')
  )
  const registry = new PluginRegistry({
    hostServices: availableServices(services),
    persistedEnabled: { work: true }
  })
  registry.register({
    dir: join(repoRoot, 'plugins', 'work'),
    source: 'resources/plugins/work/plugin.json',
    manifest: manifestForWork,
    loadMain: async () => workMod.default
  })
  const host = makeHost(registry, ipc, {
    services,
    activationTimeoutMs: 20000,
    paths: { appPath: repoRoot, resourcesPath: join(repoRoot, 'resources'), isPackaged: false }
  })

  try {
    const first = await host.activate('work')
    assertEq(first.state, 'activated', '首次激活：' + JSON.stringify(first.error))

    await ipc.invoke('work:matters:create', { name: '合同', status: 'active' })
    const list1 = await ipc.invoke('work:matters:list', {})
    assertEq(list1.data.length, 1, '创建后能查到')

    const disabled = await host.setEnabled('work', false)
    assertEq(disabled.state, 'disabled', '停用')
    assertEq(ipc.handlers.size, 0, '停用后 work:* 通道清零')

    const again = await host.setEnabled('work', true)
    assertEq(again.state, 'activated', '重新启用：' + JSON.stringify(again.error))
    const list2 = await ipc.invoke('work:matters:list', {})
    assertEq(list2.data.length, 1, '重新启用后数据仍在（同一个插件库）')
    assertEq(list2.data[0].name, '合同', '内容一致')
  } finally {
    await host.disposeAll()
    await pluginDb.disposeAll()
  }
  return '停用摘通道 + 数据持久'
})
const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
