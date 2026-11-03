// test/boundary.accept.mjs —— 插件边界门禁的回归（WP5 W5-0）
//
// 为什么要有这一套：2026-11-02 审查实测原门禁可被 4 类写法绕过
// （动态 import()、export ... from、require()、services/../ipc 路径穿越），
// 且 managerElectron 仍在扫已删空的 electron/main/{work,marketing}，
// 「0 条」是「什么都没扫」的假绿。这里把纯函数逐条钉住，并断言扫描目录非空。
//
// 用法：node test/boundary.accept.mjs（npm run accept 首套）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Recorder, __dirname, assert, assertEq, printResult, repoRoot, writeJson } from './_lib.mjs'
import {
  NONLITERAL_SPEC,
  classifyPluginSpecifier,
  findManagerElectronHits,
  findPluginHostTypeOnlyRefs,
  findPluginHostViolations,
  listManagerDirs,
  managerElectronRefs,
  moduleReferences,
  normalizeSpecifier
} from '../scripts/check-boundaries.mjs'

const r = new Recorder('boundary（插件边界门禁：解析 / 路径归一 / 扫描目录 / 基线）')
const PLUGIN_FILE = 'plugins/work/main.ts'

await r.check('B1', '静态 import/export ... from 命中（含跨行），行号准确', async () => {
  const src = [
    "import {", // 1
    '  registerWorkIpc', // 2
    "} from '../../electron/main/ipc/work'", // 3
    '', // 4
    "export { registerMarketingIpc } from '../../electron/main/ipc/marketing'" // 5
  ].join('\n')
  const refs = moduleReferences(src)
  assertEq(refs.length, 2, `应抽出 2 条引用，实际 ${refs.length}`)
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs[0].spec, refs[0].typeOnly), 'electron/main/ipc/work', '多行 import 命中')
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs[1].spec, refs[1].typeOnly), 'electron/main/ipc/marketing', 'export-from 命中')
  assertEq(refs[0].line, 1, '行号应为语句起始行 1')
  return '多行 import + export-from 均命中'
})

await r.check('B2', '纯类型引用放行（import type / 全部成员带 type）', async () => {
  const src = [
    "import type { WorkIpcDeps } from '../../electron/main/ipc/work'",
    "import { type A, type B } from '../../electron/main/ipc/marketing'",
    "import { valueOne } from '../../electron/main/services/errors'"
  ].join('\n')
  const refs = moduleReferences(src)
  const verdicts = refs.map((ref) => classifyPluginSpecifier(PLUGIN_FILE, ref.spec, ref.typeOnly))
  assertEq(verdicts[0], null, 'import type 放行')
  assertEq(verdicts[1], null, '全 type 成员放行')
  assertEq(verdicts[2], null, 'kernel/services 白名单放行')
  // 类型导入若漏判成值导入会误报，这里反向确认 refs 的 typeOnly 标记
  assertEq(refs[0].typeOnly, true, 'import type 应标记 typeOnly')
  assertEq(refs[1].typeOnly, true, '全 type 成员应标记 typeOnly')
  return '类型导入 2 类放行，服务白名单放行'
})

await r.check('B3', '动态 import() / require() 命中（旧门禁的漏检写法）', async () => {
  const src = [
    "const a = await import('../../electron/main/ipc/work')",
    "const b = require('../../electron/main/ipc/marketing')",
    "const c = import('../../electron/main/services/errors')"
  ].join('\n')
  const refs = moduleReferences(src)
  assertEq(refs.length, 3, `应抽出 3 条引用，实际 ${refs.length}`)
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs[0].spec, refs[0].typeOnly), 'electron/main/ipc/work', '动态 import 命中')
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs[1].spec, refs[1].typeOnly), 'electron/main/ipc/marketing', 'require 命中')
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs[2].spec, refs[2].typeOnly), null, '动态 import services 放行')
  assertEq(refs[0].kind, 'dynamic', 'kind 标记 dynamic')
  assertEq(refs[1].kind, 'require', 'kind 标记 require')
  return 'dynamic import / require 均命中，services 放行'
})

await r.check('B4', '路径穿越先归一化再判定（services/../ipc 不能被白名单放过）', async () => {
  const traversal = '../../electron/main/services/../ipc/work'
  assertEq(
    normalizeSpecifier(PLUGIN_FILE, traversal),
    'electron/main/ipc/work',
    '归一化应把 services/.. 收回 main'
  )
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, traversal), 'electron/main/ipc/work', '穿越写法必须命中')
  // 反例：归一化后真正落在 services / kernel 的路径应放行
  const allowed = '../../electron/main/services/../services/errors'
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, allowed), null, '归一化后落在 services 应放行')
  const bare = classifyPluginSpecifier(PLUGIN_FILE, 'electron')
  assertEq(bare, 'electron', '插件直接 import electron 包也算宿主依赖')
  return '穿越命中、services/kernel 放行、裸 electron 命中'
})

await r.check('B5', 'Manager 规则只认 electron 包，不误报 electron/main/services', async () => {
  const good = [
    "import { app } from 'electron'",
    "import type { BrowserWindow } from 'electron'",
    "import { AppError } from '../../../electron/main/services/errors'"
  ].join('\n')
  const hits = managerElectronRefs(good)
  assertEq(hits.length, 1, `应只命中 1 条 electron 值导入，实际 ${hits.length}`)
  const required = "const { ipcMain } = require('electron')"
  assertEq(managerElectronRefs(required).length, 1, 'require(electron) 也应命中')
  return '值导入命中、type 与 services 不误报'
})

await r.check('B6', '扫描目录非空且指向 plugins/<id>/domain（防「扫空目录恒 0」假绿）', async () => {
  const dirs = listManagerDirs()
  assert(dirs.length >= 2, `至少应扫到 work/marketing 两个域目录，实际 ${dirs.length}`)
  const rels = dirs.map((d) => d.replace(repoRoot, '').replace(/\\/g, '/'))
  assert(rels.some((d) => d.endsWith('/plugins/work/domain')), '必须包含 plugins/work/domain')
  assert(rels.some((d) => d.endsWith('/plugins/marketing/domain')), '必须包含 plugins/marketing/domain')
  // 当前实测 0 条：若有人把域代码搬回宿主目录，先在这里红
  const hits = findManagerElectronHits()
  assertEq(hits.length, 0, `Manager 层不应有 electron 值导入，实际 ${hits.map((h) => h.file + ':' + h.line).join(', ')}`)
  return `扫描 ${dirs.length} 个域目录，electron 命中 0`
})

await r.check('B7', 'live 扫描与基线一致（不高于基线，且基线文件可读）', async () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'boundary-baseline.json'), 'utf8'))
  assertEq(typeof baseline.pluginHostBoundary, 'number', '基线应有 pluginHostBoundary')
  assertEq(typeof baseline.managerElectron, 'number', '基线应有 managerElectron')
  // WP6 收尾：基线已收紧到 0 且是硬约束，禁止用 --update 悄悄改回 1
  assertEq(baseline.pluginHostBoundary, 0, 'pluginHostBoundary 必须保持 0（硬约束）')
  const hits = findPluginHostViolations()
  assert(hits.length <= baseline.pluginHostBoundary, `实测 ${hits.length} 不得高于基线 ${baseline.pluginHostBoundary}`)
  // 命中项必须带可排障的 kind；清零后（WP6）也不该让本断言变红
  for (const hit of hits) {
    assert(
      ['static', 'side-effect', 'dynamic', 'require', 'dynamic-nonliteral', 'require-nonliteral'].includes(hit.kind),
      `命中项 kind 非法：${hit.file}:${hit.line} ${hit.kind}`
    )
  }
  return `实测 ${hits.length} 条 ≤ 基线 ${baseline.pluginHostBoundary}`
})

await r.check('B9', 'type-only 越界单列统计：基线 0，且与值越界分开计数（4.2 B4）', async () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'boundary-baseline.json'), 'utf8'))
  assertEq(typeof baseline.pluginHostTypeOnly, 'number', '基线应有 pluginHostTypeOnly')
  assertEq(baseline.pluginHostTypeOnly, 0, 'pluginHostTypeOnly 必须保持 0（类型依赖同样绑死实现）')

  const typeHits = findPluginHostTypeOnlyRefs()
  assert(
    typeHits.length <= baseline.pluginHostTypeOnly,
    `type-only 实测 ${typeHits.length} 不得高于基线 ${baseline.pluginHostTypeOnly}`
  )

  // 与值越界分开计数：两套命中不得互相污染
  const valueHits = findPluginHostViolations()
  assert(
    valueHits.every((h) => !typeHits.some((t) => t.file === h.file && t.line === h.line)),
    '值越界与类型越界命中列表不得重叠'
  )

  // 纯类型也判越界（白名单内不算）
  const bad = classifyPluginSpecifier(PLUGIN_FILE, '../../electron/main/ipc/work', true)
  assertEq(bad, null, 'classifyPluginSpecifier 本身仍对 typeOnly 放行（兼容 B2 契约）')
  const viaRefs = findPluginHostTypeOnlyRefs
  assert(typeof viaRefs === 'function', 'findPluginHostTypeOnlyRefs 应导出')

  return `type-only ${typeHits.length} ≤ 基线 ${baseline.pluginHostTypeOnly}；与值越界不重叠`
})

await r.check('B8', '注释 / 模板字面量 / 非字面量 / typeof / API 调用 的判定', async () => {
  // 块注释前缀不能打断识别（旧实现整条漏掉）
  const inlineComment = "/* x */ import { a } from '../../electron/main/ipc/work'"
  const refs1 = moduleReferences(inlineComment)
  assertEq(refs1.length, 1, `注释前缀后的 import 应被识别，实际 ${refs1.length}`)
  assertEq(
    classifyPluginSpecifier(PLUGIN_FILE, refs1[0].spec, refs1[0].typeOnly),
    'electron/main/ipc/work',
    '注释前缀后的越界应命中'
  )

  // 行注释 / 块注释里的示例 import 不能算（避免误报）
  const commented = [
    "// import { a } from '../../electron/main/ipc/work'",
    "/* import { b } from '../../electron/main/ipc/scan' */",
    'const x = 1'
  ].join('\n')
  assertEq(moduleReferences(commented).length, 0, '注释里的 import 不应计入')
  assertEq(
    managerElectronRefs("// 禁止 require('electron')\nconst x = 1").length,
    0,
    '注释里的 require 不应误报'
  )

  // 行首分号后的 import（旧实现因 ^ 锚点漏掉）
  const semicolon = ";import { c } from '../../electron/main/ipc/scan'"
  const refs2 = moduleReferences(semicolon)
  assertEq(refs2.length, 1, '行首分号后的 import 应被识别')
  assertEq(
    classifyPluginSpecifier(PLUGIN_FILE, refs2[0].spec, refs2[0].typeOnly),
    'electron/main/ipc/scan',
    '应命中 scan'
  )

  // 模板字面量动态 import
  const template = 'const m = await import(`../../electron/main/ipc/work`)'
  const refs3 = moduleReferences(template)
  assertEq(refs3.length, 1, '模板字面量动态 import 应被识别')
  assertEq(refs3[0].kind, 'dynamic', 'kind=dynamic')
  assertEq(
    classifyPluginSpecifier(PLUGIN_FILE, refs3[0].spec, refs3[0].typeOnly),
    'electron/main/ipc/work',
    '模板字面量越界应命中'
  )

  // 非字面量动态 import：静态无法判定 → 记成 NONLITERAL_SPEC 按违规处理
  const nonLiteral = 'const m = await import(moduleVar)'
  const refs4 = moduleReferences(nonLiteral)
  assertEq(refs4.length, 1, '非字面量动态 import 应被记录（不能静默漏过）')
  assertEq(refs4[0].spec, NONLITERAL_SPEC, 'spec 应为 non-literal 标记')
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs4[0].spec), NONLITERAL_SPEC, '非字面量按违规处理')

  // typeof import(...) 是类型查询，不能当值引用（否则 manager 规则误红）
  const typeQuery = "type M = typeof import('pdfjs-dist/legacy/build/pdf.js')"
  const refs5 = moduleReferences(typeQuery)
  assertEq(refs5.length, 1, 'typeof import 应被识别为一条引用')
  assertEq(refs5[0].typeOnly, true, 'typeof import 应标记 typeOnly')
  assertEq(
    managerElectronRefs("type T = typeof import('electron')").length,
    0,
    'typeof import(electron) 不算值引用'
  )

  // obj.import(...) 是 API 调用，不是模块加载
  assertEq(
    moduleReferences("api.knowledge.import({ type: 'url' })").length,
    0,
    '.import() API 调用不应计入'
  )

  // 正则字面量里的 `/*` 不能把其后代码整段掩掉（旧实现假阴性）
  const regexLiteral = [
    'const re = /[/*]/g',
    "import { d } from '../../electron/main/ipc/work'",
    'export const ok = re.test("/")'
  ].join('\n')
  const refs6 = moduleReferences(regexLiteral)
  assertEq(refs6.length, 1, `正则字面量后的 import 应被识别，实际 ${refs6.length}`)
  assertEq(
    classifyPluginSpecifier(PLUGIN_FILE, refs6[0].spec, refs6[0].typeOnly),
    'electron/main/ipc/work',
    '正则字面量后的越界应命中'
  )

  // 字符串 / 模板「内容」里的 import(x) / require('electron') 是文案，不应误报
  assertEq(
    moduleReferences("throw new Error('unsupported: import(specifier)')").length,
    0,
    '字符串文案里的 import(x) 不应计为动态导入'
  )
  assertEq(
    moduleReferences("throw new Error('unsupported: require(specifier)')").length,
    0,
    '字符串文案里的 require(x) 不应计为 require'
  )
  assertEq(
    managerElectronRefs("const msg = 'do not require(\"electron\") here'").length,
    0,
    '字符串文案里的 require(electron) 不应误报'
  )
  assertEq(
    moduleReferences('const s = `call import(path)`').length,
    0,
    '模板内容里的 import(x) 不应误报'
  )

  // typeof import(变量) 是类型查询：即使非字面量也不应按值违规
  const typeQueryVar = 'type T = typeof import(modulePath)'
  const refs7 = moduleReferences(typeQueryVar)
  assertEq(refs7.length, 1, 'typeof import(变量) 应被识别为一条引用')
  assertEq(refs7[0].typeOnly, true, 'typeof import(变量) 应标记 typeOnly')
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs7[0].spec, refs7[0].typeOnly), null, '类型查询放行')

  // 字符串里的 `//` 不能进入注释状态（否则后面真 import 漏掉）
  const urlString = ["const url = 'https://example.com/a'", "import { e } from '../../electron/main/ipc/hot'"].join('\n')
  const refs8 = moduleReferences(urlString)
  assertEq(refs8.length, 1, `字符串里的 // 不应吞掉后续 import，实际 ${refs8.length}`)
  assertEq(classifyPluginSpecifier(PLUGIN_FILE, refs8[0].spec, refs8[0].typeOnly), 'electron/main/ipc/hot', 'URL 字符串后的越界应命中')

  // ── 已登记的两条已知边界（G10 复核接受；修复时同步改这里的断言与 AGENTS §5.1）──
  // 1) 模板字符串 `${}` 里的表达式暂被当作模板内容掩掉 → 其中的动态 import 检不出
  const templateExpr = 'const s = `${await import("../../electron/main/ipc/work")}`'
  assertEq(moduleReferences(templateExpr).length, 0, '已知边界：模板 ${} 内动态 import 暂不识别')
  // 2) `)` 后的正则字面量启发式不识别 → 该行之后可能被误当正则而漏检
  const regexAfterParen = ["if (ok) /[/*]/.test(s)", "import { f } from '../../electron/main/ipc/scan'"].join('\n')
  assertEq(moduleReferences(regexAfterParen).length, 0, '已知边界：`)` 后正则字面量暂不识别')

  return '注释/正则字面量/字符串文案/模板内容/typeof/URL字符串/非字面量/API调用 判定正确（2 条已知边界已登记）'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-boundary.json'), result)
if (!ok) process.exit(1)
