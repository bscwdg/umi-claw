// test/_ui.mjs —— UI 验收辅助：SFC 编译 + 桩件 + esbuild 打包
//
// 目标：在**零新增依赖**（无 vitest/jsdom）下，对真实 .vue 源码做组件级验收。
//   - 用 @vue/compiler-sfc（vue 自带）把 <script setup> + template 编译成 ESM 模块
//   - esbuild 打包解析 '@/...' 别名与 .ts 依赖；vue 保持 external 以共享同一实例
//   - vue-router 用桩替换（页面只用到 useRouter/useRoute）
//   - 用 @vue/server-renderer 渲染，捕获渲染期 Vue 警告（能抓到模板/引用类真 bug）

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parse as parseSfc, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createRenderer } from 'vue'
import { repoRoot, tmpDir } from './_lib.mjs'

const STUB_DIR = join(tmpDir, 'stubs')

/** 把 Windows 路径转成 esbuild 可接受的形式 */
function posix(p) {
  return p.replace(/\\/g, '/')
}

export function esbuildBin() {
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  if (!existsSync(bin)) throw new Error(`未找到 esbuild CLI: ${bin}`)
  return bin
}

/**
 * esbuild 打包任意绝对路径入口（bundleEntry 的通用版：不强制 external electron，
 * 因为 UI 验收需要把 electron 换成桩件）。
 */
export function esbuildBundle(entryAbs, outName, { externals = [], alias = [] } = {}) {
  mkdirSync(tmpDir, { recursive: true })
  const outfile = join(tmpDir, outName)
  const args = [
    entryAbs,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    ...externals.map((n) => `--external:${n}`),
    ...alias.map((a) => `--alias:${a}`),
    '--log-level=warning',
    `--outfile=${outfile}`
  ]
  const res = spawnSync(esbuildBin(), args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    cwd: repoRoot
  })
  if (res.status !== 0) {
    throw new Error(`esbuild 失败（${entryAbs}）:\n${res.stdout || ''}${res.stderr || ''}`)
  }
  if (!existsSync(outfile)) throw new Error(`esbuild 未产出 ${outfile}`)
  return outfile
}

/** 写桩件，返回路径（每次调用覆盖，保证内容可控） */
export function writeStubs() {
  mkdirSync(STUB_DIR, { recursive: true })

  const routerStub = join(STUB_DIR, 'vue-router.mjs')
  writeFileSync(
    routerStub,
    [
      '// vue-router 桩：页面只用 useRouter/useRoute',
      'export function useRouter() { return { push() {}, replace() {}, go() {} } }',
      'export function useRoute() { return { query: {}, params: {}, path: "/", name: null } }',
      'export function createRouter() { return { install() {} } }',
      'export function createWebHashHistory() { return {} }',
      'export default { install() {} }'
    ].join('\n')
  )

  const electronStub = join(STUB_DIR, 'electron.mjs')
  writeFileSync(
    electronStub,
    [
      '// electron 桩：捕获 contextBridge 暴露面 / 记录 invoke；响应可注入',
      '// 注意：本桩会被 esbuild 内联进各 bundle，模块导出会变成多份实例，',
      '// 因此调用记录/响应都走 globalThis（跨 bundle 唯一）。',
      'export const __invokes = (globalThis.__invokes = globalThis.__invokes || [])',
      'export const contextBridge = {',
      '  exposeInMainWorld(key, value) {',
      '    globalThis.__exposed = globalThis.__exposed || {}',
      '    globalThis.__exposed[key] = value',
      '  }',
      '}',
      '// 测试通过 globalThis.__ipcResponses[channel] 注入返回值（可为函数）',
      'export const ipcRenderer = {',
      '  invoke: async (channel, ...args) => {',
      '    const inv = globalThis.__invokes || (globalThis.__invokes = [])',
      '    inv.push({ channel, args })',
      '    const map = globalThis.__ipcResponses || {}',
      '    const v = map[channel]',
      '    const data = typeof v === "function" ? await v(...args) : (v === undefined ? null : v)',
      '    if (data && typeof data === "object" && "ok" in data) return data',
      '    return { ok: true, data }',
      '  },',
      '  // 订阅类通道也记下来（通道对齐验收要拿渲染端真实订阅的名字）',
      '  on(channel) { (globalThis.__onChannels || (globalThis.__onChannels = [])).push(channel) },',
      '  off() {}, once() {}, removeListener() {}, removeAllListeners() {}',
      '}',
      '// 主进程侧：注册/注销 handler 都记入 globalThis.__handlers（通道对齐验收用）',
      'export const ipcMain = {',
      '  handle(channel) {',
      '    const m = globalThis.__handlers || (globalThis.__handlers = new Map())',
      '    m.set(channel, true)',
      '  },',
      '  removeHandler(channel) {',
      '    const m = globalThis.__handlers || (globalThis.__handlers = new Map())',
      '    m.delete(channel)',
      '  },',
      '  on() {}, off() {}, once() {}',
      '}',
      'export const app = {}',
      'export const dialog = {}',
      'export const BrowserWindow = { getFocusedWindow: () => null }'
    ].join('\n')
  )

  const toolkitStub = join(STUB_DIR, 'electron-toolkit-preload.mjs')
  writeFileSync(
    toolkitStub,
    [
      '// @electron-toolkit/preload 桩',
      'export const electronAPI = { ipcRenderer: {}, webFrame: {}, webUtils: {}, process: { platform: process.platform, versions: process.versions, env: {} } }',
      'export default electronAPI'
    ].join('\n')
  )

  return { routerStub, electronStub, toolkitStub }
}

/** 页面用到的 '@/' 别名（仅这两个 composable，显式列出比前缀猜测稳） */
export function aliasForComposables() {
  return [
    `@/composables/useToast=${posix(join(repoRoot, 'src', 'composables', 'useToast.ts'))}`,
    `@/composables/useWorkStream=${posix(join(repoRoot, 'src', 'composables', 'useWorkStream.ts'))}`
  ]
}

/**
 * 把 .vue 编译成可直接 import 的 ESM（script setup + render 合成一个默认导出）。
 * 返回打包后的模块路径。
 */
export function compileVuePage(fileRelPath, outName, { routerStub }) {
  const abs = join(repoRoot, fileRelPath)
  const source = readFileSync(abs, 'utf-8')
  const id = 'ui' + outName.replace(/[^a-z0-9]/gi, '')

  const { descriptor, errors } = parseSfc(source, { filename: abs })
  if (errors.length) throw new Error(`SFC 解析失败 ${fileRelPath}: ${errors[0].message}`)
  if (!descriptor.scriptSetup) throw new Error(`${fileRelPath} 没有 <script setup>`)
  if (!descriptor.template) throw new Error(`${fileRelPath} 没有 template`)

  const script = compileScript(descriptor, { id, inlineTemplate: false })
  const tpl = compileTemplate({
    source: descriptor.template.content,
    filename: abs,
    id,
    compilerOptions: {
      bindingMetadata: script.bindings,
      // 关掉静态提升：自定义宿主渲染器不实现 insertStaticContent，避免无谓报错
      hoistStatic: false
    }
  })
  if (tpl.errors.length) throw new Error(`模板编译失败 ${fileRelPath}: ${tpl.errors[0]}`)

  // 把 script 的 default 导出改名，挂上 render，再作为 default 导出
  let code = script.content.replace(/export\s+default\s+/, 'const __component = ')
  const tplBody = tpl.code.replace(/export\s+function\s+render/, 'function render')
  const assembled = `${code}\n${tplBody}\n__component.render = render\nexport default __component\n`

  // 写为 .ts：编译产物仍含 TS 语法（页面用 lang="ts"），需 esbuild 的 TS loader
  const assembledPath = join(tmpDir, `${outName}.sfc.ts`)
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(assembledPath, assembled)

  return esbuildBundle(assembledPath, `${outName}.bundle.mjs`, {
    externals: ['vue', '@vue/server-renderer'],
    alias: [...aliasForComposables(), `vue-router=${posix(routerStub)}`]
  })
}

/** 打包真实 preload，返回其暴露的 api 对象（真桥面，不是猜的） */
export function loadRealPreloadApi({ electronStub, toolkitStub }) {
  const entry = join(repoRoot, 'electron', 'preload', 'index.ts')
  const bundle = esbuildBundle(entry, 'ui-preload.bundle.mjs', {
    externals: ['vue'],
    alias: [
      `electron=${posix(electronStub)}`,
      `@electron-toolkit/preload=${posix(toolkitStub)}`
    ]
  })
  return bundle
}

/**
 * 加载真实 preload 桥，返回其 `api` 对象。
 *
 * preload 在非 contextIsolation 分支会写 `window.api`；Node 下先备好 window 才能拿到。
 * 用**真 preload 源码**（非手写 mock），因此验证的是真桥面。
 */
export async function importPreloadApi({ electronStub, toolkitStub }) {
  const bundle = loadRealPreloadApi({ electronStub, toolkitStub })
  globalThis.window = globalThis.window || {}
  await import(pathToFileURL(bundle).href)
  const api = globalThis.window.api
  if (!api) throw new Error('preload 未暴露 api（检查 contextIsolated 分支）')
  return api
}

/**
 * 遍历 `api.work` 的叶子函数，实际调一次并收集它们发出的通道名。
 *
 * 为什么要真调：通道名写在闭包里的 `call('work:xxx')`，静态扫源码很脆；
 * 真调一次就能拿到渲染端**实际会发的**通道（IPC 桩会把 invoke 记下来）。
 * 订阅类（onChunk/onDone/onError）走 `ipcRenderer.on`，另用 `__onChannels` 收集。
 */
export async function collectRendererChannels(api) {
  const invoked = new Set()
  const subscribed = new Set()
  const walk = async (node, depth) => {
    if (!node || depth > 3) return
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'function') {
        const before = (globalThis.__invokes || []).length
        const beforeOn = (globalThis.__onChannels || []).length
        try {
          await value('__probe__', '__probe__')
        } catch {
          // 参数不合法等异常不重要：call() 已在抛错前记录了通道
        }
        const inv = globalThis.__invokes || []
        for (let i = before; i < inv.length; i++) invoked.add(inv[i].channel)
        const ons = globalThis.__onChannels || []
        for (let i = beforeOn; i < ons.length; i++) subscribed.add(ons[i])
      } else if (value && typeof value === 'object') {
        await walk(value, depth + 1)
      }
    }
  }
  await walk(api.work, 0)
  return { invoked: [...invoked], subscribed: [...subscribed] }
}

/**
 * 打包真实 work 域 IPC 注册器（ipc/work.ts + ipc/gateway.ts），
 * 调用后返回**主进程真实注册的通道集合**。
 *
 * 这是「通道对齐」验收的基础：mock IPC 能测「页面调了 A」，但测不出
 * 「主进程根本没注册 A」——那是运行时才炸的 bug（Invoke 无 handler）。
 * 这里用真源码注册、真桩件收集，两边对齐才算通过。
 *
 * 两个模块都要装：work 域 IPC 面横跨 work.ts（业务）与 gateway.ts（只读就绪面）。
 */
export async function loadWorkIpcChannels({ electronStub }) {
  const stub = {}
  // work.ts：业务通道（只包闭包、不立即调 Manager，空对象即可）
  const workBundle = esbuildBundle(
    join(repoRoot, 'electron', 'main', 'ipc', 'work.ts'),
    'ui-work-ipc.bundle.mjs',
    { externals: ['vue'], alias: [`electron=${posix(electronStub)}`] }
  )
  const workMod = await import(pathToFileURL(workBundle).href)
  if (typeof workMod.registerWorkIpc !== 'function') {
    throw new Error('ipc/work.ts 未导出 registerWorkIpc')
  }
  workMod.registerWorkIpc({
    profile: stub, matters: stub, todos: stub, records: stub, context: stub,
    today: stub, router: stub, reports: stub, qa: stub, tools: stub,
    knowledge: stub, wizard: stub, reminder: stub
  })

  // gateway.ts：只读就绪面（gateway 桩只需方法存在）
  const gwBundle = esbuildBundle(
    join(repoRoot, 'electron', 'main', 'ipc', 'gateway.ts'),
    'ui-gateway-ipc.bundle.mjs',
    { externals: ['vue'], alias: [`electron=${posix(electronStub)}`] }
  )
  const gwMod = await import(pathToFileURL(gwBundle).href)
  if (typeof gwMod.registerGatewayIpc === 'function') {
    gwMod.registerGatewayIpc({ getStatus: async () => ({}), ensureReady: async () => ({}) })
  }

  const registered = globalThis.__handlers ? [...globalThis.__handlers.keys()] : []
  return { registered, mod: workMod }
}

// ── 轻量宿主渲染器（Node 侧真挂载，无 DOM 依赖） ──────────────────────────────
//
// 用 vue 自带的 createRenderer 造一个「对象树」宿主：能真跑 setup / onMounted /
// 响应式更新，从而验证页面确实按预期调用 IPC（不是只编译通过）。
// 只实现这些页面实际涉及的节点操作，不做通用 DOM 模拟。

function makeNode(tag, text) {
  return {
    tag,
    text: text ?? '',
    props: {},
    children: [],
    parent: null,
    // v-model 走 runtime-dom 指令，直接操作这些并挂事件监听
    value: undefined,
    checked: undefined,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    // v-model 的更新钩子会调 getRootNode（比 activeElement），缺了会抛
    getRootNode() { return this },
    // <select v-model>：dev 版 runtime-dom 的 setSelected 会遍历 el.options
    // 并读 .length / .selectedIndex / .multiple；真实浏览器天然具备，宿主需补
    multiple: false,
    selectedIndex: -1,
    get options() { return this.children.filter((c) => c && c.tag === 'option') }
  }
}

function createHostRenderer() {
  const nodeOps = {
    createElement: (tag) => makeNode(tag),
    createText: (text) => makeNode('#text', text),
    createComment: (text) => makeNode('#comment', text),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.children = [makeNode('#text', text)] },
    insert: (child, parent, anchor) => {
      child.parent = parent
      const list = parent.children
      const i = anchor ? list.indexOf(anchor) : -1
      if (i >= 0) list.splice(i, 0, child)
      else list.push(child)
    },
    remove: (child) => {
      const p = child.parent
      if (!p) return
      const i = p.children.indexOf(child)
      if (i >= 0) p.children.splice(i, 1)
    },
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) => {
      const p = node.parent
      if (!p) return null
      const i = p.children.indexOf(node)
      return i >= 0 ? p.children[i + 1] ?? null : null
    },
    patchProp: (el, key, _prev, next) => {
      // value/checked 需落在真实字段上（v-model 指令读的就是它们）
      if (key === 'value') { el.value = next; el.props[key] = next; return }
      if (key === 'checked') { el.checked = next; el.props[key] = next; return }
      if (key === 'multiple') { el.multiple = next; el.props[key] = next; return }
      el.props[key] = next
    },
    setScopeId: () => {},
    cloneNode: (node) => ({ ...node, children: node.children.map((c) => ({ ...c })), props: { ...node.props } }),
    insertStaticContent: () => null,
    querySelector: () => null
  }
  return createRenderer(nodeOps)
}

/** 把宿主节点树序列化成可断言的文本 */
export function serialize(node) {
  if (!node) return ''
  if (node.tag === '#text') return node.text
  if (node.tag === '#comment') return ''
  const attrs = []
  const p = node.props || {}
  // 表单断言：v-model 直接写 el.value（不经 patchProp），需单独暴露
  if (node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select') {
    const v = node.value !== undefined && node.value !== null ? node.value : p.value
    if (v !== undefined && v !== null && v !== '') attrs.push(` value="${v}"`)
    const c = node.checked !== undefined ? node.checked : p.checked
    if (c !== undefined && c !== null) attrs.push(` checked="${c}"`)
    if (p.placeholder) attrs.push(` placeholder="${p.placeholder}"`)
  }
  return `<${node.tag}${attrs.join('')}>${node.children.map(serialize).join('')}</${node.tag}>`
}

/** 最小 DOM 全局桩：只为让 runtime-dom 的 v-model 指令能跑完 */
function installDomGlobals() {
  const g = globalThis
  if (!g.document) {
    g.document = {
      activeElement: null,
      createElement: () => makeNode('div'),
      createTextNode: (t) => makeNode('#text', t),
      querySelector: () => null,
      getRootNode() { return this }
    }
  }
  // instanceof 检查用（如 getRootNode() instanceof ShadowRoot）；桩类保证为 false
  for (const name of ['Document', 'ShadowRoot', 'Element', 'Node', 'HTMLElement', 'SVGElement']) {
    if (!g[name]) g[name] = class {}
  }
}

/**
 * 真挂载一个已编译的页面组件。
 * - 注入 `window.api`（页面在 setup/onMounted 里直接取用）
 * - flush 若干轮事件循环，让 onMounted 的异步 IPC 落定
 * - 收集 Vue 运行期警告（能抓到模板里引用不存在字段这类真 bug）
 */
export async function mountPage(component, { api, flush = 8 } = {}) {
  const renderer = createHostRenderer()
  const root = makeNode('#root')
  globalThis.window = { api }
  // Vue 的 vModelText 等 runtime-dom 指令会访问 DOM 全局量（如 document.activeElement），
  // Node 下不存在 → 指令抛错、值不落。这里补最小桩（不做通用 DOM 模拟）。
  installDomGlobals()

  const warnings = []
  const origWarn = console.warn
  const origError = console.error
  console.warn = (...a) => warnings.push(a.map(String).join(' '))
  console.error = (...a) => warnings.push(a.map(String).join(' '))

  let app = null
  let mountError = null
  try {
    app = renderer.createApp(component)
    app.mount(root)
    for (let i = 0; i < flush; i++) await new Promise((r) => setTimeout(r, 0))
  } catch (e) {
    mountError = e
  } finally {
    console.warn = origWarn
    console.error = origError
  }

  return { app, root, warnings, mountError, html: serialize(root) }
}
