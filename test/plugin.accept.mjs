// test/plugin.accept.mjs —— Phase 0 插件内核验收（真源码，纯 Node）
//
// 覆盖 PLAN-4.0 §13 的前三条验收：
//   1. 宿主零插件也能启动（discover 空目录 / 坏清单不抛）
//   2. 启停后路由、导航、IPC、定时任务全部卸载
//   3. 插件异常只禁用自身，宿主继续运行
// 以及契约细节：manifest 校验 / 能力版本 / 重复 id / 激活超时 / LIFO 清理。
//
// 用法：node test/plugin.accept.mjs（npm run accept:plugin）

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  assert,
  assertEq,
  bundleEntry,
  mkSrc,
  workSrc,
  printResult,
  writeJson,
  __dirname,
  repoRoot,
  resolveNodePath,
  domainSrc
} from './_lib.mjs'
import { extractServiceRefs, findUndeclaredServiceRefs } from '../scripts/plugin-service-scan.mjs'

const r = new Recorder('Phase 0 · 插件内核（manifest / registry / lifecycle / UI registry）')

// 4.2 复核补修：work/marketing 清单现在声明 abort（B3）/ consent（4.1.1 宿主单源），
// 凡是用真实清单的测试，假宿主工厂必须提供这两个服务，否则注册阶段就会报
// 「宿主不存在的服务」。这两个 fake 只满足契约形状，不参与这些用例的断言语义。
function fakeAbortService() {
  const registered = new Map()
  return {
    register(pluginId, abort) {
      registered.set(pluginId, abort)
      return () => registered.delete(pluginId)
    }
  }
}

function fakeConsentService() {
  let consent = false
  let consentAt = null
  let revokedAt = null
  return {
    async status() {
      return { consent, consentAt, revokedAt }
    },
    async grant() {
      if (!consent) {
        consent = true
        consentAt = Date.now()
        revokedAt = null
      }
      return { consent: true, consentAt }
    },
    async revoke() {
      consent = false
      consentAt = null
      revokedAt = Date.now()
      return { consent: false }
    }
  }
}

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

const kvMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginKv.ts', 'plugin-kv.mjs')).href
)
const secretsMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginSecrets.ts', 'plugin-secrets.mjs')).href
)
const { createPluginKvService } = kvMod
const { PluginSecretStore } = secretsMod

const helloMod = await import(pathToFileURL(bundleEntry('plugins/hello/main.ts', 'hello-main.mjs')).href)
const mergeDir = (base, name) => join(base, name)

const marketingMod = await import(
  pathToFileURL(
    bundleEntry('plugins/marketing/main.ts', 'marketing-main.mjs', {
      alias: ['electron=./test/.tmp/electron-stub.mjs'],
      externals: ['mammoth', 'exceljs', 'docx', 'pdfjs-dist']
    })
  ).href
)

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
    legacyDb: () => ({ list: async () => [] }),
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
await r.check('P32', '渲染端边界：插件 UI 只准经 hostBridge 触达 window.api', async () => {
  const dir = join(repoRoot, 'plugins')

  /** 递归收集插件源文件（renderer.ts + ui/** + main.ts，排除 node_modules） */
  const collect = (pluginDir, out = []) => {
    for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
      const full = join(pluginDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        collect(full, out)
      } else if (/\.(ts|vue)$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => collect(join(dir, d.name)))
  assert(files.length > 0, '至少有一个插件源文件')

  const bridge = join(dir, 'shared', 'hostBridge.ts')
  let bridgeSeen = false
  for (const file of files) {
    // 去掉注释再扫：注释里解释「不要用 window.api」不该被当成违规
    const src = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const name = file.replace(repoRoot, '')
    assert(!/window\.electron/.test(src), `${name} 不应使用 window.electron`)
    assert(!/from ['"]electron['"]/.test(src), `${name} 不应 import electron`)
    assert(!/require\(/.test(src), `${name} 不应 require`)
    // 纯 UI 插件不需要调 IPC；一旦调了，必须走宿主注入的 host.invoke（而不是 window.api）
    if (/\.invoke\(/.test(src)) {
      assert(/host\.invoke/.test(src), `${name} 调 IPC 时必须走 host.invoke`)
    }
    // window.api 只允许出现在桥接层（Phase 4 把 80+ 处直连收敛到一处，后续换 host.invoke 只改一个文件）
    // 覆盖点号、可选链、方括号、解构与「先赋给变量再取」等常见绕过写法
    const touchesHostApi =
      /window\s*\??\.\s*api/.test(src) ||
      /window\s*\[\s*['\"]api['\"]\s*\]/.test(src) ||
      /\\{[^}]*\\bapi\\b[^}]*\\}\\s*=\\s*window/.test(src) ||
      /(?:const|let|var)\\s+\\w+\\s*=\\s*window\\b[\\s\\S]{0,40}?\\.api\\b/.test(src) ||
      /globalThis[\\s\\S]{0,20}?window[\\s\\S]{0,20}?\\.api/.test(src)
    if (touchesHostApi) {
      assertEq(file, bridge, `${name} 直接用了 window.api——请改走 plugins/shared/hostBridge`)
      bridgeSeen = true
    }
  }
  const bridgeSrc = readFileSync(bridge, 'utf-8')
  assert(/window/.test(bridgeSrc) && /\bapi\b/.test(bridgeSrc), 'hostBridge 应封装 window.api（否则说明这一层没生效）')
  return `${files.length} 个插件源文件都守边界，window.api 只在 hostBridge`
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
const dbClientMod = await import(
  pathToFileURL(bundleEntry('electron/main/database/database.ts', 'work-legacy-db.mjs')).href
)
const schemasMod = await import(
  pathToFileURL(bundleEntry('electron/main/database/schemas.ts', 'work-schemas.mjs')).href
)
const genericImportMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginDataImport.ts', 'plugin-import.mjs')).href
)

const migrateMod = await import(
  pathToFileURL(bundleEntry(workSrc('migrate.ts'), 'work-migrate.mjs')).href
)

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
  const abortCalls = []
  const services = {
    legacyDb: () => ({ list: async () => [] }),
    db: () => fakeDb,
    openclaw: () => gateway,
    abort: () => ({
      register(pluginId, abort) {
        abortCalls.push(pluginId)
        return () => {}
      }
    }),
    consent: () => fakeConsentService(),
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
  assert(abortCalls.includes('work'), 'work 在 activate 时把中止函数登记到 abortRegistry（B3 复核补修）')
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
    legacyDb: () => ({ list: async () => [] }),
    db: () => pluginDb.forPlugin({ id: 'work', dir: join(repoRoot, 'plugins', 'work') }),
    abort: () => fakeAbortService(),
    consent: () => fakeConsentService(),
    openclaw: () => ({
      getStatus: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      chat: async () => ({ text: '', model: null }),
      stream: () => {
        throw new Error('not used')
      }
    }),
    legacyDb: () => ({ list: async () => [] }),
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

    // 4.0.1 P1：停用/退出时必须中止 work 域在途的模型调用（不看源码只看行为无法在纯 Node 里造在途流，
    // 这里钉住接线：stopBackgroundWork 调 reminder.stop + 四个 manager 的 abortAll，且 cleanup/deactivate 都真实调用）。
    const workMainSrc = readFileSync(join(repoRoot, 'plugins', 'work', 'main.ts'), 'utf-8')
    const stopCalls = (workMainSrc.match(/stopBackgroundWork\(/g) || []).length
    assert(stopCalls >= 3, '定义 + cleanup + deactivate 三处调用 stopBackgroundWork（实际 ' + stopCalls + '）')
    for (const m of [
      'qa.abortAll',
      'tools.abortAll',
      'reports.abortAll',
      'openclawSummary.abortAll'
    ]) {
      assert(workMainSrc.includes(m), '停用中止在途：' + m)
    }
    // 只数函数体字符串挡不住「函数还在但调用点退回 reminder.stop()」——再钉住两处调用上下文
    assert(
      /return \(\) => \{[\s\S]{0,240}?stopBackgroundWork\(work\)/.test(workMainSrc),
      'cleanup 必须调 stopBackgroundWork'
    )
    assert(
      /if \(runtime\) stopBackgroundWork\(runtime\)/.test(workMainSrc),
      'deactivate 兜底路径必须调 stopBackgroundWork'
    )
  } finally {
    await host.disposeAll()
    await pluginDb.disposeAll()
  }
  return '停用摘通道 + 数据持久'
})
// ── P39 旧库一次性导入：work.db（只读）→ plugins/work/data.db ────────────────
await r.check('P39', '旧库导入：只读 work.db 把数据搬进插件库，幂等且不改旧库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-workimport-'))
  const { DatabaseClient } = dbClientMod
  const { DB_SCHEMAS } = schemasMod
  const { importWorkDataIfNeeded } = migrateMod

  const oldDb = new DatabaseClient({
    dbPath: join(root, 'work.db'),
    backupDir: join(root, 'backup'),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs'),
    nodePath: resolveNodePath(),
    schema: DB_SCHEMAS.work,
    subprocessName: 'legacy-work-db'
  })
  const pluginDb = createPluginDbService({
    dataDir: root,
    nodePath: resolveNodePath(),
    workerScriptPath: join(repoRoot, 'resources', 'database', 'db-worker.mjs')
  })

  try {
    await oldDb.ensureReady()
    await oldDb.request('matters.create', { data: { id: 'm1', name: '旧库事项', status: 'active', created_at: 1, updated_at: 1 } })
    await oldDb.request('todos.create', { data: { id: 't1', title: '旧库待办', state: 'confirmed', source: 'manual', created_at: 1, updated_at: 1 } })

    const target = pluginDb.forPlugin({ id: 'work', dir: join(repoRoot, 'plugins', 'work') })
    const result = await importWorkDataIfNeeded({
      source: oldDb,
      target,
      pluginDataDir: join(root, 'plugins', 'work')
    })

    assertEq(result.imported, true, '首次导入执行')
    assertEq(result.counts.matters, 1, 'matters 导入 1 行')
    assertEq(result.counts.todos, 1, 'todos 导入 1 行')

    const matters = await target.request('matters.list', {})
    assertEq(matters.length, 1, '插件库能查到导入的事项')
    assertEq(matters[0].name, '旧库事项', '内容一致')

    // 旧库只读：原数据还在，没有被清空或改写
    const oldRows = await oldDb.request('matters.list', {})
    assertEq(oldRows.length, 1, '旧库数据未被改动')

    // 幂等：第二次直接跳过
    const again = await importWorkDataIfNeeded({
      source: oldDb,
      target,
      pluginDataDir: join(root, 'plugins', 'work')
    })
    assertEq(again.imported, false, '第二次跳过')
    assert(again.skipped.includes('already-imported'), '跳过原因')
    assertEq((await target.request('matters.list', {})).length, 1, '重复导入不会翻倍')
  } finally {
    await oldDb.dispose()
    await pluginDb.disposeAll()
  }
  return '导入幂等 + 旧库只读'
})
// ── P40 导入健壮性（P2 报告 A2/A3/A5）：分页 / upsert 续传 / 错误分类 / 缺表跳过 ──
await r.check('P40', '导入健壮性：分页拉满、重跑靠 upsert 续传、非缺表错误不写标记', async () => {
  const { importWorkDataIfNeeded } = migrateMod
  const dir = mkdtempSync(join(tmpdir(), 'umi-import-'))

  // 1) 分页：source 每次最多给 2 行，7 行数据应分 4 页全导入
  {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: 'm' + i, name: 'n' + i }))
    const source = {
      async request(method, params = {}) {
        const table = method.split('.')[0]
        if (table !== 'matters') return []
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 5000)
        return rows.slice(offset, offset + limit)
      }
    }
    const written = []
    const target = { async request(method, params) { written.push(params.data); return {} } }
    const res = await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'page'), pageSize: 2 })
    assertEq(res.counts.matters, 7, '分页拉满 7 行')
    assertEq(written.length, 7, '目标写入 7 行')
    assert(res.pages.matters >= 4, '页数 >= 4：' + res.pages.matters)
  }

  // 2) 续传：第一次第 3 张表抛错 → 不写标记；第二次全成功；重跑用 upsert 不冲突
  {
    let failOnce = true
    const source = {
      async request(method) {
        const table = method.split('.')[0]
        if (table === 'todos' && failOnce) throw new Error('磁盘打嗝')
        return table === 'profile' ? [{ id: 'default', call_name: '老王' }] : []
      }
    }
    const seen = new Map()
    const target = {
      async request(method, params) {
        seen.set(params.data.id, params.data)
        return {}
      }
    }
    let threw = false
    try {
      await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'retry') })
    } catch {
      threw = true
    }
    assert(threw, '第一次应抛错')
    assertEq(existsSync(join(dir, 'retry', '.imported')), false, '失败不写标记')
    failOnce = false
    const second = await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'retry') })
    assertEq(second.imported, true, '第二次成功')
    assertEq(second.counts.profile, 1, 'profile 续传成功')
    assertEq(seen.size, 1, '不会重复写入（upsert 收敛）')
  }

  // 3) 错误分类：库未就绪类错误必须冒泡，不能当缺表吞掉
  {
    const source = {
      async request() {
        throw new Error('库结构与工作域不符，缺少表: knowledge')
      }
    }
    const target = { async request() { return {} } }
    let threw = false
    try {
      await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'strict') })
    } catch {
      threw = true
    }
    assert(threw, '库未就绪必须抛错')
    assertEq(existsSync(join(dir, 'strict', '.imported')), false, '不能写完成标记')
  }

  // 4) 缺表只跳过该表，其它表照常导入
  {
    const source = {
      async request(method) {
        const table = method.split('.')[0]
        if (table === 'knowledge') throw new Error('no such table: knowledge')
        return table === 'matters' ? [{ id: 'm1', name: '合同' }] : []
      }
    }
    const target = { async request() { return {} } }
    const res = await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'skip') })
    assert(res.skipped.includes('knowledge'), 'knowledge 被跳过')
    assertEq(res.counts.matters, 1, '其它表照常导入')
  }

  // 5) voice 配置不随导入进入插件库
  {
    const source = {
      async request(method) {
        const table = method.split('.')[0]
        if (table === 'app_meta') {
          return [
            { key: 'wizard_consent', value: 'granted' },
            { key: 'voice:v1:settings', value: '{"secret":1}' }
          ]
        }
        return []
      }
    }
    const written = []
    const target = { async request(method, params) { written.push(params.data.key); return {} } }
    await importWorkDataIfNeeded({ source, target, pluginDataDir: mergeDir(dir, 'voice') })
    assert(written.includes('wizard_consent'), '合规状态要导入')
    assert(!written.includes('voice:v1:settings'), 'voice 配置不应导入')
  }

  return '分页 / 续传 / 错误分类 / 缺表 / voice 过滤 全部正确'
})
// ── P41 marketing 插件：装配 Manager + 注册 marketing:* 通道，停用即摘除 ──────
await r.check('P41', 'marketing 插件：默认开启；启用后 marketing:* 通道可用，停用清零', async () => {
  const ipc = createFakeIpc()
  const calls = []
  const dataDir = mkdtempSync(join(tmpdir(), 'umi-mkt-'))
  const fakeDb = {
    path: join(dataDir, 'plugins', 'marketing', 'data.db'),
    async migrate() {},
    async metaGet() {
      return null
    },
    async metaSet() {
      return { changes: 1 }
    },
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'projects.list') return [{ id: 'p1', name: '示例项目', status: 'active' }]
      if (method.endsWith('.list')) return []
      if (method.endsWith('.get')) return null
      if (method.endsWith('.create')) return params?.data ?? {}
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
      return { path: 'x' }
    }
  }
  const stubGateway = {
    getStatus: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
    ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
    chat: async () => ({ text: '', model: null }),
    stream: () => {
      throw new Error('not used')
    }
  }
  const abortCalls = []
  const services = {
    legacyDb: () => ({ list: async () => [] }),
    db: () => fakeDb,
    openclaw: () => stubGateway,
    abort: () => ({
      register(pluginId, abort) {
        abortCalls.push(pluginId)
        return () => {}
      }
    }),
    consent: () => fakeConsentService(),
    legacyDb: () => ({ list: async () => [] }),
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

  const manifestForMkt = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'plugins', 'marketing', 'plugin.json'), 'utf-8')
  )
  // 决策调整：营销域默认**开启**（承接 3.0/2.0 已有功能，升级后菜单不能消失）；
  // 用户可在能力中心关闭。
  assertEq(manifestForMkt.defaultEnabled, true, '营销域默认开启')

  const registry = new PluginRegistry({
    hostServices: availableServices(services),
    persistedEnabled: { marketing: true }
  })
  registry.register({
    dir: join(repoRoot, 'plugins', 'marketing'),
    source: 'resources/plugins/marketing/plugin.json',
    manifest: manifestForMkt,
    loadMain: async () => marketingMod.default
  })
  const host = makeHost(registry, ipc, {
    services,
    activationTimeoutMs: 20000,
    paths: {
      appPath: repoRoot,
      resourcesPath: join(repoRoot, 'resources'),
      isPackaged: false,
      nodePath: process.execPath
    }
  })

  try {
    const status = await host.activate('marketing')
    assertEq(status.state, 'activated', 'marketing 激活：' + JSON.stringify(status.error))
    assert(
      abortCalls.includes('marketing'),
      'marketing 在 activate 时把中止函数登记到 abortRegistry（B3 复核补修）'
    )
    assert(status.channels.some((c) => c.startsWith('marketing:')), '注册了 marketing:* 通道')
    assert(status.channels.length > 20, '通道数量应覆盖 5 组 IPC：' + status.channels.length)
    assert(
      status.channels.includes('marketing:gateway:status'),
      '注册了 marketing:gateway:status（WP6-b 拆域后仍随插件租约注册）'
    )
    assert(
      status.channels.includes('marketing:gateway:ensureReady'),
      '注册了 marketing:gateway:ensureReady（WP6-b 拆域后仍随插件租约注册）'
    )

    const list = await ipc.invoke('marketing:project:list', {})
    assertEq(list.ok, true, '通道返回 ok')
    assertEq(list.data.length, 1, '经 Manager 查到 1 个项目')
    assert(calls.some((c) => c.method === 'projects.list'), 'Manager 走到了注入的库')

    await host.disposeAll()
    assertEq(ipc.handlers.size, 0, '停用后 marketing:* 通道全部摘除')
  } finally {
    await host.disposeAll()
  }
  return `marketing 通道 ${'(见上)'} 条，停用清零`
})
// ── P42 通用导入：marketing 11 表清单 + 分页 + voice 前缀排除 ─────────────────
await r.check('P42', '通用导入：marketing 表清单完整，按页拉满且排除宿主 voice 配置', async () => {
  const { importTableData, MARKETING_TABLES, HOST_APP_META_PREFIXES } = genericImportMod
  assertEq(MARKETING_TABLES.length, 11, 'marketing 11 表')
  assertEq(MARKETING_TABLES[0], 'projects', '先导 projects（外键根）')
  assertEq(MARKETING_TABLES[MARKETING_TABLES.length - 1], 'app_meta', 'app_meta 最后')

  const dir = mkdtempSync(join(tmpdir(), 'umi-mkt-import-'))
  const rowsByTable = {
    projects: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    app_meta: [
      { key: 'marketing:lastProject', value: 'p1' },
      { key: 'voice:v1:settings', value: '{"secret":1}' }
    ]
  }
  const source = {
    async request(method, params = {}) {
      const table = method.split('.')[0]
      const rows = rowsByTable[table] ?? []
      const offset = Number(params.offset ?? 0)
      const limit = Number(params.limit ?? 5000)
      return rows.slice(offset, offset + limit)
    }
  }
  const written = []
  const target = {
    async request(method, params) {
      written.push({ method, key: params.data?.key ?? params.data?.id })
      return {}
    }
  }
  const res = await importTableData({
    source,
    target,
    pluginDataDir: dir,
    tables: MARKETING_TABLES,
    skipKeyPrefixes: HOST_APP_META_PREFIXES,
    pageSize: 2
  })
  assertEq(res.counts.projects, 3, 'projects 3 行（分页 2+1）')
  assertEq(res.pages.projects, 2, '分 2 页拉取')
  assertEq(res.counts.app_meta, 1, 'app_meta 只导入 1 条（voice 被排除）')
  assert(!written.some((w) => w.key === 'voice:v1:settings'), 'voice 配置未写入')
  assert(written.every((w) => w.method.endsWith('.upsert')), '全部走 upsert')
  return '清单/分页/排除 正确'
})
// ── P44 宿主不得再注册 marketing IPC（装箱回退防线）────────────────────────
await r.check('P44', '宿主入口不再注册 marketing 5 组 IPC，装配只发生在插件里', async () => {
  const hostSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
  const pluginSrc = readFileSync(join(repoRoot, 'plugins', 'marketing', 'main.ts'), 'utf-8')
  const fns = [
    'registerMarketingIpc',
    'registerAdvisorIpc',
    'registerScanIpc',
    'registerContentIpc',
    'registerHotIpc'
  ]
  for (const fn of fns) {
    const re = new RegExp(fn + '\\(')
    assert(!re.test(hostSrc), `electron/main/index.ts 不应再调用 ${fn}`)
    assert(re.test(pluginSrc), `plugins/marketing/main.ts 应调用 ${fn}`)
  }

  // 4.1 WP5-b：插件装配已抽到 services/pluginRuntime，index 只经它初始化（装配层无直接单测，
  // 这里用静态断言钉住关键接线，避免「抽走后 index 又自己拼一套」）
  assert(hostSrc.includes('createPluginRuntime'), 'index.ts 应使用 createPluginRuntime')
  assert(/pluginRuntime = createPluginRuntime\(/.test(hostSrc), 'index.ts 应创建 runtime')
  assert(hostSrc.includes('await pluginRuntime.init()'), 'index.ts 应调用 runtime.init()')
  assert(
    !/from '\.\/services\/(pluginDb|pluginSecrets|pluginKv)'/.test(hostSrc),
    'index.ts 不应直接 import 插件服务实现（只允许 runtime 持有）'
  )
  const runtimeSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'),
    'utf-8'
  )
  for (const needle of [
    'plugin:list',
    'plugin:setEnabled',
    'registry.enabledSnapshot()',
    "broadcast('plugin:changed'"
  ]) {
    assert(runtimeSrc.includes(needle), 'pluginRuntime 应包含 ' + needle)
  }

  // 4.1 WP5-a 第一批：窗口/app/log/shell/dialog/obsidian 共 19 个宿主通道拆到 ipc/host/misc.ts
  const miscSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'misc.ts'),
    'utf-8'
  )
  const miscChannels = [
    'window:minimize',
    'window:maximize',
    'window:close',
    'window:close-resolve',
    'window:close-cancel',
    'app:getVersion',
    'log:getLogs',
    'log:clearLogs',
    'shell:openExternal',
    'dialog:showMessage',
    'obsidian:getConfig',
    'obsidian:saveConfig',
    'obsidian:selectVault',
    'obsidian:getIndexStatus',
    'obsidian:rebuildIndex',
    'obsidian:cancelIndex',
    'obsidian:testEmbedding',
    'obsidian:getEmbeddingPresets',
    'obsidian:testSearch'
  ]
  // 通道注册是「api.handle(\s*'<channel>'」形状（可能换行），不能只匹配单行字面量
  const hasIpcHandler = (src, ch, api = 'ipcMain') =>
    new RegExp(`${api}\\.handle\\(\\s*'${ch}'`).test(src)
  for (const ch of miscChannels) {
    assert(hasIpcHandler(miscSrc, ch), 'misc.ts 应注册 ' + ch)
  }
  for (const prefix of ['window:', 'app:', 'log:', 'shell:', 'dialog:', 'obsidian:']) {
    assert(!hostSrc.includes(`ipcMain.handle('${prefix}`), 'index.ts 不应再直接注册 ' + prefix)
  }
  assert(/registerMiscIpc\(\{/.test(hostSrc), 'index.ts 应调用 registerMiscIpc')

  // 4.1 WP5-a 第二批：技能 11 + 渠道 3 拆到 ipc/host/{skills,channels}.ts
  const skillsSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'skills.ts'),
    'utf-8'
  )
  const skillsChannels = [
    'skills:list',
    'skills:install',
    'skills:uninstall',
    'skills:getInstalledSkills',
    'skills:toggleSkillStatus',
    'skills:removeSkill',
    'skills:importSkillZip',
    'skills:probeRemote',
    'skills:installSkills',
    'skills:applyUpdates',
    'skills:getPendingUpdates'
  ]
  for (const ch of skillsChannels) {
    assert(hasIpcHandler(skillsSrc, ch, 'ipc'), 'skills.ts 应注册 ' + ch)
  }
  const channelsSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'channels.ts'),
    'utf-8'
  )
  for (const ch of [
    'channels:isPluginInstalled',
    'channels:installPlugin',
    'channels:getStatuses'
  ]) {
    assert(hasIpcHandler(channelsSrc, ch, 'ipc'), 'channels.ts 应注册 ' + ch)
  }
  for (const prefix of ['skills:', 'channels:']) {
    assert(!hostSrc.includes(`ipcMain.handle('${prefix}`), 'index.ts 不应再直接注册 ' + prefix)
  }
  assert(/registerSkillsIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerSkillsIpc(ipcMain')
  assert(/registerChannelsIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerChannelsIpc(ipcMain')

  // 4.1 WP5-a 第三批：应用配置 8 个通道拆到 ipc/host/config.ts
  const configSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'config.ts'),
    'utf-8'
  )
  for (const ch of [
    'config:get',
    'config:save',
    'config:reset',
    'config:getDataDir',
    'config:getPresetModels',
    'config:refreshModelPresets',
    'config:getModelPresetsInfo',
    'config:openDataDir'
  ]) {
    assert(hasIpcHandler(configSrc, ch, 'ipc'), 'config.ts 应注册 ' + ch)
  }
  assert(!hostSrc.includes(`ipcMain.handle('config:`), 'index.ts 不应再直接注册 config:')
  assert(/registerConfigIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerConfigIpc(ipcMain')

  // 4.1 WP5-a 第四批：claw 7 + test-connection 1 拆到 ipc/host/{claw,modelConnection}.ts
  const clawSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'claw.ts'),
    'utf-8'
  )
  for (const ch of [
    'claw:start',
    'claw:stop',
    'claw:restart',
    'claw:status',
    'claw:waitReady',
    'claw:openWeb',
    'claw:get-token'
  ]) {
    assert(hasIpcHandler(clawSrc, ch, 'ipc'), 'claw.ts 应注册 ' + ch)
  }
  const modelConnSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'modelConnection.ts'),
    'utf-8'
  )
  assert(hasIpcHandler(modelConnSrc, 'test-connection', 'ipc'), 'modelConnection.ts 应注册 test-connection')
  for (const prefix of ['claw:', 'test-connection']) {
    assert(!hostSrc.includes(`ipcMain.handle('${prefix}`), 'index.ts 不应再直接注册 ' + prefix)
  }
  assert(/registerClawIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerClawIpc(ipcMain')
  assert(
    /registerModelConnectionIpc\(\s*ipcMain/.test(hostSrc),
    'index.ts 应调用 registerModelConnectionIpc(ipcMain'
  )

  // 4.1 WP5-a 第五批：终端 5 通道拆到 ipc/host/terminal.ts
  const terminalSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'terminal.ts'),
    'utf-8'
  )
  for (const ch of ['term:run', 'term:pty-start', 'term:pty-input', 'term:pty-stop', 'term:pty-resize']) {
    assert(hasIpcHandler(terminalSrc, ch, 'ipc'), 'terminal.ts 应注册 ' + ch)
  }
  assert(!hostSrc.includes(`ipcMain.handle('term:`), 'index.ts 不应再直接注册 term:')
  assert(/registerTerminalIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerTerminalIpc(ipcMain')

  // 4.1 WP5-a 第六批（收尾）：env 7 通道拆到 ipc/host/env.ts
  const envSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'env.ts'),
    'utf-8'
  )
  for (const ch of [
    'env:check',
    'env:init',
    'env:update',
    'env:checkLatest',
    'env:getInfo',
    'env:nodeVersions',
    'env:updateNode',
    // 4.2 B2：便携 Node 写入探针结果（横幅 + 一键重装的数据源）
    'env:runtimeProbe'
  ]) {
    assert(hasIpcHandler(envSrc, ch, 'ipc'), 'env.ts 应注册 ' + ch)
  }
  assert(!hostSrc.includes(`ipcMain.handle('env:`), 'index.ts 不应再直接注册 env:')
  assert(/registerEnvIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 应调用 registerEnvIpc(ipcMain')

  // handler 守恒：index 0 + misc 19 + skills 11 + channels 3 + config 8 + claw 7 + modelConn 1 + term 5 + env 8 + importStatus 2 = 64
  const importStatusSrc = readFileSync(
    join(repoRoot, 'electron', 'main', 'ipc', 'host', 'importStatus.ts'),
    'utf-8'
  )
  const countHandles = (src, api) => (src.match(new RegExp(`${api}\\.handle\\(`, 'g')) || []).length
  const hostCount = countHandles(hostSrc, 'ipcMain')
  const miscCount = countHandles(miscSrc, 'ipcMain')
  const skillsCount = countHandles(skillsSrc, 'ipc')
  const channelsCount = countHandles(channelsSrc, 'ipc')
  const configCount = countHandles(configSrc, 'ipc')
  const clawCount = countHandles(clawSrc, 'ipc')
  const modelConnCount = countHandles(modelConnSrc, 'ipc')
  const termCount = countHandles(terminalSrc, 'ipc')
  const envCount = countHandles(envSrc, 'ipc')
  const importCount = countHandles(importStatusSrc, 'ipc')
  assertEq(hostCount, 0, 'index.ts 应不再直接注册 ipcMain.handle')
  assertEq(miscCount, 19, 'misc.ts 应注册 19 个通道')
  assertEq(skillsCount, 11, 'skills.ts 应注册 11 个通道')
  assertEq(channelsCount, 3, 'channels.ts 应注册 3 个通道')
  assertEq(configCount, 8, 'config.ts 应注册 8 个通道')
  assertEq(clawCount, 7, 'claw.ts 应注册 7 个通道')
  assertEq(modelConnCount, 1, 'modelConnection.ts 应注册 1 个通道')
  assertEq(termCount, 5, 'terminal.ts 应注册 5 个通道')
  assertEq(envCount, 8, 'env.ts 应注册 8 个通道（4.2 B2 新增 env:runtimeProbe）')
  assertEq(importCount, 2, 'importStatus.ts 应注册 2 个通道（4.0.2 P2）')
  assertEq(
    hostCount +
      miscCount +
      skillsCount +
      channelsCount +
      configCount +
      clawCount +
      modelConnCount +
      termCount +
      envCount +
      importCount,
    64,
    '宿主 handler 总数应为 61+2+1（4.0.2 P2 import 通道 + 4.2 B2 runtimeProbe）'
  )
  return '宿主零注册 / 插件全注册 / 装配在 runtime / 61+2+1 通道守恒'
})

// ── P43 旧库导入走服务注入（防「清单忘了 inject」导致死代码）─────────────────
await r.check('P43', '两个插件都在 inject 里声明 legacyDb，且激活后真的触发导入', async () => {
  for (const id of ['work', 'marketing']) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'resources', 'plugins', id, 'plugin.json'), 'utf-8'))
    assert(manifest.inject.includes('legacyDb'), `${id} 清单必须 inject legacyDb（否则导入是死代码）`)
  }

  const root = mkdtempSync(join(tmpdir(), 'umi-legacy-inject-'))
  const ipc = createFakeIpc()
  const upserts = []
  const fakeDb = {
    path: join(root, 'plugins', 'marketing', 'data.db'),
    async migrate() {},
    async metaGet() {
      return null
    },
    async metaSet() {
      return { changes: 1 }
    },
    async request(method, params) {
      if (method.endsWith('.upsert')) upserts.push({ method, data: params?.data })
      if (method === 'projects.list') return [{ id: 'p1', name: '旧项目' }]
      if (method.endsWith('.list')) return []
      return {}
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
      return { path: 'x' }
    }
  }
  const services = {
    legacyDb: () => ({ list: async () => [] }),
    db: () => fakeDb,
    abort: () => fakeAbortService(),
    consent: () => fakeConsentService(),
    openclaw: () => ({
      getStatus: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      ensureReady: async () => ({ ready: false, port: null, baseUrl: null, endpointsEnabled: false }),
      chat: async () => ({ text: '', model: null }),
      stream: () => {
        throw new Error('not used')
      }
    }),
    legacyDb: () => ({ list: async () => [] }),
    hostOps: () => ({
      notify: () => undefined,
      push: async () => ({ ok: true }),
      listPushChannels: async () => [],
      listPushTargets: async () => [],
      locateOldDbs: () => [],
      readOldDb: async () => ({})
    }),
    // 旧库只读：只给 projects 一行，app_meta 带 voice 前缀（应被排除）
    legacyDb: () => ({
      list: async (table) => {
        if (table === 'projects') return [{ id: 'p1', name: '旧项目' }]
        if (table === 'app_meta') {
          return [
            { key: 'marketing:lastProject', value: 'p1' },
            { key: 'voice:v1:settings', value: '{"secret":1}' }
          ]
        }
        return []
      }
    }),
    config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) })
  }

  const manifestForMkt = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'plugins', 'marketing', 'plugin.json'), 'utf-8')
  )
  const registry = new PluginRegistry({
    hostServices: availableServices(services),
    persistedEnabled: { marketing: true }
  })
  registry.register({
    dir: join(repoRoot, 'plugins', 'marketing'),
    source: 'resources/plugins/marketing/plugin.json',
    manifest: manifestForMkt,
    loadMain: async () => marketingMod.default
  })
  const host = makeHost(registry, ipc, {
    services,
    dataDir: root,
    activationTimeoutMs: 20000,
    paths: {
      appPath: repoRoot,
      resourcesPath: join(repoRoot, 'resources'),
      isPackaged: false,
      nodePath: process.execPath
    }
  })

  try {
    const status = await host.activate('marketing')
    assertEq(status.state, 'activated', '激活：' + JSON.stringify(status.error))

    // 导入是后台的：轮询等 .imported
    const marker = join(root, 'plugins', 'marketing', '.imported')
    for (let i = 0; i < 50 && !existsSync(marker); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert(existsSync(marker), '激活后应写 .imported（说明真的走了 legacyDb 服务）')
    assert(
      upserts.some((u) => u.data?.id === 'p1'),
      '旧库 projects 被 upsert 进插件库'
    )
    assert(!upserts.some((u) => u.data?.key === 'voice:v1:settings'), 'voice 配置仍被排除')

    // 4.0.2 P2：导入状态落盘（ok），供宿主横幅读取
    const statusPath = join(root, 'plugins', 'marketing', 'import-status.json')
    const importStatus = JSON.parse(readFileSync(statusPath, 'utf-8'))
    assertEq(importStatus.state, 'ok', '导入成功后状态文件 state=ok')
    assertEq(importStatus.pluginId, 'marketing', '状态文件记录 pluginId')
    assert((importStatus.counts?.projects ?? 0) >= 1, '状态文件带 counts.projects')

    // 失败路径：reader 抛错 → 状态 failed 且错误继续冒泡（失败不写 .imported 的既有语义不变）
    const failDir = mkdtempSync(join(tmpdir(), 'umi-import-fail-'))
    let failed = null
    try {
      await genericImportMod.importTableData({
        source: {
          request: async () => {
            throw new Error('boom-read')
          }
        },
        target: { request: async () => ({ changes: 1 }) },
        pluginDataDir: failDir,
        tables: ['projects']
      })
    } catch (e) {
      failed = e
    }
    assert(failed, 'reader 抛错应冒泡')
    const failStatus = JSON.parse(readFileSync(join(failDir, 'import-status.json'), 'utf-8'))
    assertEq(failStatus.state, 'failed', '失败路径状态文件 state=failed')
    assert(/boom-read/.test(failStatus.error ?? ''), '失败状态记录错误信息')

    // 重试注册表：注册 → 可执行 → 清理后拒绝（插件停用即摘）
    let retried = 0
    genericImportMod.registerLegacyImportRetry('retry-p2', async () => {
      retried += 1
    })
    await genericImportMod.runLegacyImportRetry('retry-p2')
    assertEq(retried, 1, '重试执行器被调用一次')
    genericImportMod.clearLegacyImportRetry('retry-p2')
    let retryError = null
    try {
      await genericImportMod.runLegacyImportRetry('retry-p2')
    } catch (e) {
      retryError = e
    }
    assert(retryError, '清理后重试应抛错（插件未激活/已停用）')

    // skipped：已有 .imported 且未 force → 不导入，状态 skipped
    const skipDir = mkdtempSync(join(tmpdir(), 'umi-import-skip-'))
    writeFileSync(join(skipDir, '.imported'), '{}')
    const skipResult = await genericImportMod.importTableData({
      source: { request: async () => [{ id: 'p9' }] },
      target: { request: async () => ({ changes: 1 }) },
      pluginDataDir: skipDir,
      tables: ['projects']
    })
    assertEq(skipResult.imported, false, '已有标记且未 force → skipped')
    const skipStatus = JSON.parse(readFileSync(join(skipDir, 'import-status.json'), 'utf-8'))
    assertEq(skipStatus.state, 'skipped', 'skipped 状态落盘')

    // force：绕过 .imported 真重跑（幂等 upsert），状态回到 ok
    const forceResult = await genericImportMod.importTableData({
      source: { request: async () => [{ id: 'p9' }] },
      target: { request: async () => ({ changes: 1 }) },
      pluginDataDir: skipDir,
      tables: ['projects'],
      force: true
    })
    assertEq(forceResult.imported, true, 'force 应绕过 .imported 再导一次')
    assertEq(forceResult.counts.projects, 1, 'force 导入计数正确')
    const forceStatus = JSON.parse(readFileSync(join(skipDir, 'import-status.json'), 'utf-8'))
    assertEq(forceStatus.state, 'ok', 'force 成功后状态回到 ok')

    // 宿主壳接线：preload 暴露通道、App 横幅有重试按钮
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    assert(preloadSrc.includes("'plugin:import:status'"), 'preload 暴露 plugin:import:status')
    assert(preloadSrc.includes("'plugin:import:retry'"), 'preload 暴露 plugin:import:retry')
    const appSrc = readFileSync(join(repoRoot, 'src', 'App.vue'), 'utf-8')
    assert(appSrc.includes('重试导入') && appSrc.includes('importFailures'), 'App 有失败横幅 + 重试按钮')
  } finally {
    await host.disposeAll()
  }
  return '清单声明 + 服务注入 + 导入执行 全链路'
})
// ── P45 故障隔离压测：坏插件不拖垮宿主与好插件 ─────────────────────────────
await r.check('P45', '故障隔离：抛错 / 挂死 / 坏清单的插件都不影响其它插件与宿主', async () => {
  const ipc = createFakeIpc()
  const mk = (id, main) => ({
    dir: `/fake/${id}`,
    source: '<test>',
    manifest: { ...manifest, id },
    loadMain: async () => main
  })

  const registry = new PluginRegistry({ persistedEnabled: { good1: true, boom: true, hang: true, good2: true } })
  registry.register(mk('good1', { activate: (ctx) => ctx.registerIpc('ping', () => 'pong') }))
  registry.register(mk('boom', {
    activate: () => {
      throw new Error('故意炸')
    }
  }))
  registry.register(mk('hang', { activate: () => new Promise(() => undefined) }))
  // 坏清单：注册阶段就失败（不阻塞其它人）
  let badManifestRejected = false
  try {
    registry.register({
      dir: '/fake/bad',
      source: '<test>',
      manifest: { id: 'BAD ID!', name: 'bad', version: '1.0.0', capabilities: [], inject: [], channels: [], activation: [], contributes: {}, defaultEnabled: true },
      loadMain: async () => ({ activate: () => undefined })
    })
  } catch {
    badManifestRejected = true
  }
  registry.register(mk('good2', { activate: (ctx) => ctx.registerIpc('ping', () => 'pong2') }))

  const host = makeHost(registry, ipc, { activationTimeoutMs: 300 })
  try {
    const statuses = await host.activateAll()
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]))
    assertEq(byId.good1.state, 'activated', 'good1 正常激活')
    assertEq(byId.good2.state, 'activated', 'good2 正常激活')
    assertEq(byId.boom.state, 'failed', 'boom 失败')
    assert(byId.boom.error?.code.includes('PLUGIN_ACTIVATION_FAILED'), 'boom 有失败码：' + JSON.stringify(byId.boom.error))
    assertEq(byId.hang.state, 'failed', 'hang 超时失败')
    assert(/timeout/.test(String(byId.hang.error?.stage ?? '')), 'hang 标记为超时：' + JSON.stringify(byId.hang.error))
    assert(badManifestRejected, '坏清单在注册阶段被拒')

    // 宿主仍可用：好插件的通道能调
    assertEq(await ipc.invoke('plugin:good1:ping'), 'pong', 'good1 通道可用')
    assertEq(await ipc.invoke('plugin:good2:ping'), 'pong2', 'good2 通道可用')
    // 失败插件不留通道
    assertEq(ipc.handlers.has('plugin:boom:ping'), false, '失败插件无残留通道')
  } finally {
    await host.disposeAll()
  }
  assertEq(ipc.handlers.size, 0, '全部卸载后 handler 清零')
  return '4 类故障全部隔离'
})

// ── P46 启动预算：插件并行激活（串行会线性叠加）────────────────────────────
await r.check('P46', '并行激活：3 个各 sleep 120ms 的插件总耗时应接近 1 个', async () => {
  const ipc = createFakeIpc()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ids = ['p1', 'p2', 'p3']
  const registry = new PluginRegistry({ persistedEnabled: Object.fromEntries(ids.map((id) => [id, true])) })
  for (const id of ids) {
    registry.register({
      dir: `/fake/${id}`,
      source: '<test>',
      manifest: { ...manifest, id },
      loadMain: async () => ({
        activate: async () => {
          await sleep(120)
        }
      })
    })
  }
  const host = makeHost(registry, ipc, { activationTimeoutMs: 3000 })
  try {
    const started = Date.now()
    const statuses = await host.activateAll()
    const elapsed = Date.now() - started
    assertEq(statuses.filter((s) => s.state === 'activated').length, 3, '三个都激活')
    assert(elapsed < 300, `并行激活应 <300ms（实际 ${elapsed}ms；串行至少 360ms）`)
  } finally {
    await host.disposeAll()
  }
  return '并行启动生效'
})

// ── P47 打包契约：资源副本与清单一致 ────────────────────────────────────────
await r.check('P47', '打包契约：resources/plugins 的清单与 migrations 和源码一致', async () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
  assertEq(pkg.build.extraResources[0].from, 'resources', 'resources 整目录进安装包')
  assert(pkg.build.files.includes('dist-electron/**/*'), 'dist-electron 进 asar')

  for (const id of ['work', 'marketing', 'hello']) {
    const srcManifest = JSON.parse(readFileSync(join(repoRoot, 'plugins', id, 'plugin.json'), 'utf-8'))
    const packedManifest = JSON.parse(
      readFileSync(join(repoRoot, 'resources', 'plugins', id, 'plugin.json'), 'utf-8')
    )
    assertEq(JSON.stringify(packedManifest), JSON.stringify(srcManifest), `${id} 清单副本与源码一致`)

    const srcMigrations = join(repoRoot, 'plugins', id, 'migrations')
    const packedMigrations = join(repoRoot, 'resources', 'plugins', id, 'migrations')
    if (existsSync(srcMigrations)) {
      const srcFiles = readdirSync(srcMigrations).filter((f) => f.endsWith('.sql')).sort()
      const packedFiles = readdirSync(packedMigrations).filter((f) => f.endsWith('.sql')).sort()
      assertEq(packedFiles.join(','), srcFiles.join(','), `${id} migrations 副本完整`)
    }
  }

  for (const file of [
    'resources/collector/index.mjs',
    'resources/database/db-worker.mjs',
    'resources/database/db-worker-marketing.mjs'
  ]) {
    assert(existsSync(join(repoRoot, file)), `${file} 存在（打包 required）`)
  }
  return '清单/migrations/worker/collector 都在包里'
})
// ── P58 服务注入闭包：ctx.services.* 必须在 plugin.json.inject 里声明 ─────────
// 4.2 复核补修：B3 的 abort / 4.1.1 的 consent 都只在 main.ts 里取 ctx.services，
// 但 manifest.inject 没声明 → 内核只注入 inject 列表 → 两处 `if (abort)` / `consent?.`
// 静默回落，注册与宿主单源在生产中从未生效。这条断言把「用了但没声明」变成红。
await r.check(
  'P58',
  '服务注入闭包：ctx.services.* 都在 plugin.json.inject 里；生产服务工厂覆盖 SERVICE_NAMES',
  async () => {
    const problems = findUndeclaredServiceRefs(join(repoRoot, 'plugins'))
    assertEq(
      problems.length,
      0,
      '服务注入闭包不完整：\n' +
        problems.map((p) => `${p.pluginId}/${p.file}: ${p.services.join(', ')}`).join('\n')
    )
    // 明确钉住两处回归点：work 同时需要 abort（4.2 B3）与 consent（4.1.1 宿主单源），
    // marketing 需要 abort（4.2 B3）。
    for (const [id, needed] of [
      ['work', ['abort', 'consent']],
      ['marketing', ['abort']]
    ]) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins', id, 'plugin.json'), 'utf-8'))
      for (const name of needed) {
        assert(manifest.inject.includes(name), `${id} 插件 inject 必须声明 ${name}`)
      }
    }
    // 反向：任何插件 inject 声明的服务都必须有生产工厂；否则插件激活时抛
    // SERVICE_NOT_INJECTED（原 P0 的镜像失败模式，假宿主会掩盖）。
    // 注意不能要求 SERVICE_NAMES 全都有工厂：voice 等是契约预留、当前无插件消费。
    const runtimeSrc = readFileSync(
      join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'),
      'utf-8'
    )
    const injected = new Set()
    for (const id of readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })) {
      if (!id.isDirectory()) continue
      const manifestPath = join(repoRoot, 'plugins', id.name, 'plugin.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      for (const name of manifest.inject ?? []) if (name !== 'host') injected.add(name)
    }
    // 只在 buildServiceFactories 的返回对象里找工厂：PluginRuntimeDeps 的类型声明里
    // 也有 `abort: () => ...` 之类的字面量，全文件正则会把它们当成工厂（假绿）。
    const factoriesStart = runtimeSrc.indexOf('const buildServiceFactories')
    const factoriesEnd = runtimeSrc.indexOf('const registerHostIpc')
    assert(factoriesStart >= 0 && factoriesEnd > factoriesStart, '应在 pluginRuntime 找到 buildServiceFactories 段')
    const factoriesSrc = runtimeSrc.slice(factoriesStart, factoriesEnd)
    const missingFactory = [...injected].filter(
      (name) => !new RegExp(`\\b${name}\\s*:\\s*\\(`).test(factoriesSrc)
    )
    assertEq(missingFactory.length, 0, 'pluginRuntime 缺少被插件 inject 的服务工厂：' + missingFactory.join(','))

    // 正向控制：扫描器本身必须能认出四种写法（否则「空扫描」也会绿）
    for (const [src, expected] of [
      ['const a = ctx.services.abort', 'abort'],
      ['const c = ctx.services?.consent', 'consent'],
      ["const k = ctx.services['kv']", 'kv'],
      ['const { abort = noop, consent: c } = ctx.services', 'abort'],
      ['const { abort = noop, consent: c } = ctx.services', 'consent']
    ]) {
      assert(extractServiceRefs(src).includes(expected), `扫描器应识别 ${expected}：${src}`)
    }
    for (const [pluginId, expected] of [
      ['work', ['abort', 'consent', 'db']],
      ['marketing', ['abort']]
    ]) {
      const refs = extractServiceRefs(readFileSync(join(repoRoot, 'plugins', pluginId, 'main.ts'), 'utf-8'))
      for (const name of expected) {
        assert(refs.includes(name), `${pluginId}/main.ts 扫描应包含 ${name}（实际 ${refs.join(',')}）`)
      }
    }
    return 'ctx.services 使用与 inject 一致；被 inject 的服务均有工厂'
  }
)
// ── P48 gateway 面按域拆分：marketing:gateway 归插件 ────────────────────────
await r.check('P48', 'gateway 通道归属：宿主只注册 work 面，marketing 面由插件注册', async () => {
  const hostSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
  const pluginSrc = readFileSync(join(repoRoot, 'plugins', 'marketing', 'main.ts'), 'utf-8')
  assert(/registerWorkGatewayIpc\(/.test(hostSrc), '宿主注册 work gateway 面')
  assert(!/registerMarketingGatewayIpc\(/.test(hostSrc), '宿主不再注册 marketing gateway 面')
  assert(/registerMarketingGatewayIpc\(/.test(pluginSrc), '营销插件注册自己的 gateway 面')
  return '按域拆分完成'
})

// ── P49 宿主系统事件：resume 能广播给插件（ctx.host.onResume）───────────────
await r.check('P49', 'resume 广播：插件经 ctx.host.onResume 订阅，清理时退订', async () => {
  const ipc = createFakeIpc()
  let resumeHandler = null
  const hostEvents = {
    onResume(callback) {
      resumeHandler = callback
      return () => {
        if (resumeHandler === callback) resumeHandler = null
      }
    }
  }
  let ticks = 0
  const registry = new PluginRegistry({ persistedEnabled: { p: true } })
  registry.register({
    dir: '/fake/p',
    source: '<test>',
    manifest: { ...manifest, id: 'p' },
    loadMain: async () => ({
      activate: (ctx) => {
        const off = ctx.host.onResume?.(() => {
          ticks += 1
        })
        if (off) ctx.onDispose(off)
      }
    })
  })
  const host = makeHost(registry, ipc, { hostEvents })
  const status = await host.activate('p')
  assertEq(status.state, 'activated', '激活：' + JSON.stringify(status.error))
  assert(typeof resumeHandler === 'function', '插件拿到了 onResume 订阅')
  resumeHandler()
  resumeHandler()
  assertEq(ticks, 2, '每次唤醒都触发回调')
  await host.disposeAll()
  assertEq(resumeHandler, null, '停用后自动退订，不留悬空回调')
  return 'resume 订阅/退订正确'
})
// ── P50 多模态预检：能力注入 + 运行时透传 ───────────────────────────────────
await r.check('P50', '扫描件识别在栅格化前预检：hostOps 暴露能力，插件注入给 runtime', async () => {
  const servicesSrc = readFileSync(join(repoRoot, 'electron', 'main', 'kernel', 'services.ts'), 'utf-8')
  assert(/isMultimodalConfigured\(\): boolean/.test(servicesSrc), 'HostOpsApi 暴露 isMultimodalConfigured')

  const hostSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
  assert(/isMultimodalConfigured: \(\) => Boolean\(resolveGatewayModels\(\)\.multimodal\)/.test(hostSrc), '宿主按次读配置实现')

  const pluginSrc = readFileSync(join(repoRoot, 'plugins', 'marketing', 'main.ts'), 'utf-8')
  assert(/multimodalConfigured:/.test(pluginSrc), '插件把预检注入 runtime')

  const runtimeSrc = readFileSync(join(repoRoot, mkSrc('runtime.ts')), 'utf-8')
  assert(/multimodalConfigured: deps\.multimodalConfigured/.test(runtimeSrc), 'runtime 透传给 scanRecognizer')
  return '预检链完整'
})
// ── P51 Dashboard 去插件依赖：营销摘要走插槽，兼容垫片已删 ──────────────────
await r.check('P51', '控制台营销摘要走插件插槽：宿主零 store 依赖，垫片已删除', async () => {
  const dashSrc = readFileSync(join(repoRoot, 'src', 'views', 'Dashboard.vue'), 'utf-8')
  assert(!/stores\/marketing/.test(dashSrc), 'Dashboard 不再 import 插件 store')
  assert(!/useProjectSwitcher/.test(dashSrc), 'Dashboard 不再 import 插件 composable')
  assert(/'dashboard\.marketing'/.test(dashSrc), 'Dashboard 渲染 dashboard.marketing 插槽')
  assert(!/marketingReady/.test(dashSrc), '不再在宿主里探测营销插件状态（插槽自己负责）')

  assert(!existsSync(join(repoRoot, 'src', 'stores', 'marketing.ts')), '兼容垫片 src/stores/marketing.ts 已删除')
  assert(
    !existsSync(join(repoRoot, 'src', 'composables', 'useProjectSwitcher.ts')),
    '兼容垫片 useProjectSwitcher.ts 已删除'
  )

  const rendererSrc = readFileSync(join(repoRoot, 'plugins', 'marketing', 'renderer.ts'), 'utf-8')
  assert(/'dashboard\.marketing': DashboardMarketingCard/.test(rendererSrc), '插件注册控制台插槽')
  assert(/slot: \{/.test(rendererSrc) && /topbar: ProjectSwitcher/.test(rendererSrc), '顶栏插槽仍在')
  return '宿主零依赖 / 插槽归插件 / 垫片清零'
})
// ── P52 注册器不越界：激活结束后必须复位，宿主注册才不会被劫持 ────────────────
await r.check('P52', '通道注册器只在激活阶段存在：营销插件就绪后 hasChannelRegistrar()=false', async () => {
  // 单入口 bundle：插件装配与注册器必须是**同一个模块实例**，否则断言恒真（空断言）
  const entry = await import(
    pathToFileURL(
      bundleEntry('test/fixtures/plugin-registrar-entry.ts', 'plugin-registrar-entry.mjs', {
        alias: ['electron=./test/.tmp/electron-stub.mjs'],
        externals: ['mammoth', 'exceljs', 'docx', 'pdfjs-dist']
      })
    ).href
  )

  const services = {
    abort: () => fakeAbortService(),
    consent: () => fakeConsentService(),
    db: () => ({
      path: ':memory:',
      async migrate() {},
      async metaGet() {
        return null
      },
      async metaSet() {
        return { changes: 1 }
      },
      async request() {
        return []
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
        return { path: 'x' }
      }
    }),
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
      readOldDb: async () => ({}),
      isMultimodalConfigured: () => false
    }),
    legacyDb: () => ({ list: async () => [] }),
    config: () => ({ get: () => undefined, set: () => undefined, all: () => ({}) })
  }

  const manifestForMkt = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'plugins', 'marketing', 'plugin.json'), 'utf-8')
  )
  const registry = new PluginRegistry({
    hostServices: availableServices(services),
    persistedEnabled: { marketing: true }
  })
  registry.register({
    dir: join(repoRoot, 'plugins', 'marketing'),
    source: 'resources/plugins/marketing/plugin.json',
    manifest: manifestForMkt,
    loadMain: async () => entry.marketing
  })
  const ipc = createFakeIpc()
  const host = makeHost(registry, ipc, {
    services,
    activationTimeoutMs: 20000,
    paths: {
      appPath: repoRoot,
      resourcesPath: join(repoRoot, 'resources'),
      isPackaged: false,
      nodePath: process.execPath
    }
  })

  try {
    assertEq(entry.hasChannelRegistrar(), false, '激活前没有插件接管')
    const status = await host.activate('marketing')
    assertEq(status.state, 'activated', '激活：' + JSON.stringify(status.error))
    assertEq(entry.hasChannelRegistrar(), false, '激活结束后必须复位（否则宿主注册会被劫持）')

    // 关键回归：修复前这里会抛 CHANNEL_NOT_LEASED（被营销注册器接管）
    let hijackError = null
    try {
      entry.registerWorkGatewayIpc({ getStatus: async () => ({}), ensureReady: async () => ({}) })
    } catch (e) {
      hijackError = e
    }
    assertEq(hijackError, null, '宿主注册 work gateway 不应被劫持：' + String(hijackError))
  } finally {
    await host.disposeAll()
  }
  return '注册器生命周期正确'
})

// ── P53/P54 停用与在途激活的收敛（对抗 F1/F2）──────────────────────────────
await r.check('P53', '停用打断激活：迟到 cleanup 只执行一次（不双跑）', async () => {
  const ipc = createFakeIpc()
  let cleanupRuns = 0
  let releaseGate = null
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const registry = new PluginRegistry({ persistedEnabled: { slow: true } })
  registry.register({
    dir: '/fake/slow',
    source: '<test>',
    manifest: { ...manifest, id: 'slow' },
    loadMain: async () => ({
      activate: async () => {
        await gate
        return () => {
          cleanupRuns += 1
        }
      }
    })
  })
  const host = makeHost(registry, ipc, { activationTimeoutMs: 1000 })
  const activating = host.activate('slow')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const disabled = await host.setEnabled('slow', false)
  assertEq(disabled.state, 'disabled', '停用立即返回 disabled')
  releaseGate()
  await activating.catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assertEq(cleanupRuns, 1, 'cleanup 必须恰好执行一次（双跑=资源被清两遍）')
  await host.disposeAll()
  return 'cleanup 单次执行'
})

await r.check('P54', '停用不被在途激活拖住：activate 永不 resolve 时也在 1s 内返回', async () => {
  const ipc = createFakeIpc()
  const registry = new PluginRegistry({ persistedEnabled: { hang: true } })
  registry.register({
    dir: '/fake/hang',
    source: '<test>',
    manifest: { ...manifest, id: 'hang' },
    loadMain: async () => ({ activate: () => new Promise(() => undefined) })
  })
  const host = makeHost(registry, ipc, { activationTimeoutMs: 1500 })
  // 不要 await：activate 永不 resolve，会等满 activationTimeout（P54 变慢的根因）
  void host.activate('hang').catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const started = Date.now()
  const disabled = await host.setEnabled('hang', false)
  const elapsed = Date.now() - started
  assertEq(disabled.state, 'disabled', '状态 disabled')
  assert(elapsed < 1000, `停用耗时 ${elapsed}ms 应 <1000ms（不能等满 activationTimeout）`)
  await host.disposeAll()
  return `停用耗时 ${elapsed}ms`
})

await r.check('P55', '激活超时：迟到返回的 cleanup 仍然执行（不能泄漏插件资源）', async () => {
  const ipc = createFakeIpc()
  let cleanupRuns = 0
  const registry = new PluginRegistry({ persistedEnabled: { late: true } })
  registry.register({
    dir: '/fake/late',
    source: '<test>',
    manifest: { ...manifest, id: 'late' },
    loadMain: async () => ({
      activate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return () => {
          cleanupRuns += 1
        }
      }
    })
  })
  const host = makeHost(registry, ipc, { activationTimeoutMs: 100 })
  const status = await host.activate('late')
  assertEq(status.state, 'failed', '超时失败')
  assert(/timeout/.test(String(status.error?.stage ?? '')), '失败阶段是超时：' + JSON.stringify(status.error))
  await new Promise((resolve) => setTimeout(resolve, 400))
  assertEq(cleanupRuns, 1, '迟到 resolve 的 cleanup 必须执行且只执行一次')
  await host.disposeAll()
  return '迟到 cleanup 执行一次'
})
await r.check(
  'P56',
  'ctx.kv / ctx.secrets 契约真实可用：注入 + 命名空间隔离 + 加密不可用拒绝（4.0.1 P7）',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'umi-kv-'))
    const seen = {}
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(v, 'utf8'),
      decryptString: (b) => b.toString('utf8')
    }
    const factories = {
      kv: (info) => createPluginKvService(root, info.id),
      secrets: (info) =>
        new PluginSecretStore(join(root, 'plugins', info.id, 'secrets.bin'), encryption)
    }
    const registry = new PluginRegistry({ hostServices: availableServices(factories) })
    registry.register({
      dir: '/fake/kv',
      source: '<test>',
      manifest: { ...manifest, id: 'kvtest', inject: ['host', 'kv', 'secrets'] },
      loadMain: async () => ({
        activate: async (ctx) => {
          assertEq(Object.keys(ctx.services).sort().join(','), 'kv,secrets', '只注入声明的服务')
          const kv = ctx.services.kv
          const secrets = ctx.services.secrets
          await kv.set('theme', 'dark')
          await kv.set('gone', 'x')
          await kv.set('gone', null)
          seen.kvKeys = await kv.keys()
          seen.kvTheme = await kv.get('theme')
          await secrets.set('token', 's3cret')
          seen.secretKeys = await secrets.keys()
          seen.secretValue = await secrets.get('token')
          return () => undefined
        }
      })
    })
    const host = makeHost(registry, createFakeIpc(), { services: factories })
    const status = await host.activate('kvtest')
    assertEq(status.state, 'activated', '激活成功：' + JSON.stringify(status.error))
    assertEq(seen.kvKeys.join(','), 'theme', 'KV keys 过滤前缀，null 即删除')
    assertEq(seen.kvTheme, 'dark', 'KV round-trip')
    assertEq(seen.secretKeys.join(','), 'token', 'secrets keys 不返回值')
    assertEq(seen.secretValue, 's3cret', 'secrets round-trip（加密器注入）')

    // 命名空间隔离：另一个插件实例同 dataDir，键互不可见
    const other = createPluginKvService(root, 'other')
    await other.set('theme', 'light')
    const back = createPluginKvService(root, 'kvtest')
    assertEq(await back.get('theme'), 'dark', '其他插件改不到本插件键')
    assertEq(await other.get('theme'), 'light', '对方命名空间独立')

    // 加密不可用 → available=false 且 set 拒绝、不落明文
    const unavailable = new PluginSecretStore(join(root, 'plugins', 'kvtest', 's2.bin'), {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    })
    assertEq(unavailable.available(), false, '不可用可判定')
    let threw = null
    try {
      await unavailable.set('k', 'v')
    } catch (e) {
      threw = e
    }
    assert(threw, '不可用时 set 拒绝')
    assert(!existsSync(join(root, 'plugins', 'kvtest', 's2.bin')), '拒绝写入（不落明文）')
    await host.disposeAll()
    rmSync(root, { recursive: true, force: true })
    return 'kv/secrets 契约 ✓'
  }
)

await r.check(
  'P57',
  'pluginKv 并发写不丢键：同 dataDir 多实例共享缓存/串行队列（4.0.1 P8）',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'umi-kvconc-'))
    // 修复前：a/b 各持一份完整 map，a.set 会把 b 刚写的键整份抹掉
    const a = createPluginKvService(root, 'work')
    const b = createPluginKvService(root, 'marketing')
    await a.set('x', '1')
    await b.set('y', '2')
    await a.set('x', '3')
    assertEq(await createPluginKvService(root, 'work').get('x'), '3', 'a 本命名空间取到最新值')
    assertEq(
      await createPluginKvService(root, 'marketing').get('y'),
      '2',
      'b 的键没有被整份覆盖（修复前会丢）'
    )

    // 并发 20 次交替写：全部键都要在最终文件里
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).set('k' + i, String(i))))
    const onDisk = JSON.parse(readFileSync(join(root, 'plugin-kv.json'), 'utf8'))
    for (let i = 0; i < 20; i++) {
      assert(
        Object.keys(onDisk).some((k) => k.endsWith(':k' + i)),
        '并发写保留 k' + i
      )
    }

    // 跨 dataDir 隔离：不同 dataDir 各一份文件，互不覆盖
    const root2 = mkdtempSync(join(tmpdir(), 'umi-kvconc2-'))
    const otherDir = createPluginKvService(root2, 'work')
    await otherDir.set('x', 'other')
    assertEq(await otherDir.get('x'), 'other', '另一 dataDir 可写')
    assertEq(await createPluginKvService(root, 'work').get('x'), '3', '不同 dataDir 互不影响')
    assertEq(existsSync(join(root2, 'plugin-kv.json')), true, '另一 dataDir 独立文件')
    rmSync(root2, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    return '并发不丢键 ✓'
  }
)

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)