// scripts/check-boundaries.mjs —— 插件边界门禁（零依赖，WP3 阶段 A；WP5 W5-0 补强）
//
// 为什么不装 eslint：本机 NODE_ENV=production 时 `npm i -D` 会把 devDependencies
// 整棵删掉（已实测：449 packages removed、双 typecheck 变红）。用零依赖脚本达到
// 同样目的，且不受 npm 环境影响。
//
// 检查两件事（对应 AGENTS.md §5.1 与 §4.1）：
//   1. plugins/** 不得引用 electron/main 下除 kernel / services 以外的模块
//      —— 覆盖 4 种写法：静态 import/export ... from、副作用 import、动态 import()、require()
//      —— 相对路径先归一化再判定，防 `services/../../ipc/work` 这类路径穿越
//   2. plugins/*/domain 的 Manager 层不得 import electron 副作用
//      （WP3 搬迁后域代码在 plugins/<id>/domain，不再是 electron/main/{work,marketing}；
//        旧目录已删空时若还扫旧路径，managerElectron=0 是「什么都没扫」的假绿）
//
// 基线（scripts/boundary-baseline.json）只准降不准升：违规数 > 基线 → 退出码 1。
// 它必须被自动链路执行（`npm run accept` 首套 + CI verify job），否则 ratchet 不成立。
//
// 用法：node scripts/check-boundaries.mjs [--update] [--json]
// 供 test/boundary.accept.mjs 导入纯函数做回归（直接 import 本文件不会执行主流程）。

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(repoRoot, 'scripts', 'boundary-baseline.json')

/** 插件允许引用的宿主模块前缀（kernel / services） */
export const PLUGIN_ALLOW_RE = /^electron\/main\/(kernel|services)(\/|$)/

export function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name.startsWith('.')) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else if (/\.(ts|vue)$/.test(name)) out.push(abs)
  }
  return out
}

/** 行号（1 基）：给命中项定位用 */
export function lineAt(src, index) {
  if (index < 0) return 0
  return src.slice(0, index).split('\n').length
}

/** 动态 import / require 的参数不是字面量：静态门禁无法判定目标，按违规处理（宁可多报） */
export const NONLITERAL_SPEC = '<non-literal>'

/**
 * 把注释替换成等长空白（保留换行），避免两类错误：
 *   - 块注释里的「行首 import」被当成真引用（误报：实测会被计成越界）；
 *   - 注释前缀打断行首锚点导致真 import 漏报（`/* x *\/ import ...` 曾整条漏掉）。
 * 字符串内容保留（specifier 本身在引号里）；模板字符串里的 import 仍可能误报，
 * 仓库现有代码没有这种写法，验收 B8 覆盖已知形态。
 */
export function maskComments(src) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | single | double | template
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += ch
      i++
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        out += '\n'
      } else {
        out += ' '
      }
      i++
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i++
      continue
    }
    // 字符串/模板字符串：原样保留，但跳过转义字符
    out += ch
    if (ch === '\\') {
      out += src[i + 1] ?? ''
      i += 2
      continue
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code'
    }
    i++
  }
  return out
}

/**
 * 抽出源码里全部模块引用（不执行、不解析 AST）。
 *
 * 为什么不用「只看 import ... from」：2026-11-02 审查实测该写法漏掉
 * `await import()`、`export { x } from`、`require()` 三类越界，以及路径穿越。
 * 这里按语句形态抓：静态 from、副作用 import、动态 import()、require()；
 * 非字面量参数（`import(someVar)`）静态无法判定，记成 NONLITERAL_SPEC 按违规处理。
 * 只判断「引用了哪个模块」，不做语义分析——宁可多报，不可漏报。
 * 注释先被 maskComments 抹掉，避免注释里的示例 import 误报/漏报。
 */
export function moduleReferences(src) {
  const code = maskComments(src)
  const refs = []

  const push = (spec, kind, typeOnly, index) => {
    refs.push({ spec, kind, typeOnly, line: lineAt(code, index) })
  }

  // 静态 import / export ... from '...'（允许跨多行、行首分号；花括号成员全 type 也算类型导入）
  const staticFrom = /^[ \t;]*(import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
  let m
  while ((m = staticFrom.exec(code))) {
    const keyword = m[1]
    const head = m[0].slice(0, m[0].indexOf('from'))
    const brace = head.match(/\{([\s\S]*?)\}/)
    let allMembersType = false
    if (brace) {
      const members = brace[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      allMembersType = members.length > 0 && members.every((x) => x.startsWith('type '))
    }
    const explicitlyType = new RegExp(`^[ \t;]*${keyword}\\s+type\\b`).test(m[0])
    push(m[3], 'static', explicitlyType || allMembersType, m.index)
  }

  // 副作用 import '...'（不 from）
  const sideEffect = /^[ \t;]*import\s+['"]([^'"]+)['"]/gm
  while ((m = sideEffect.exec(code))) push(m[1], 'side-effect', false, m.index)

  // 动态 import（字面量，支持 ' " `；避开 obj.import(...) 这类 API 调用）
  const dynamicImport = /(?<![.\w$])import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  while ((m = dynamicImport.exec(code))) {
    const prefix = code.slice(Math.max(0, m.index - 8), m.index)
    push(m[1], 'dynamic', /typeof\s*$/.test(prefix), m.index)
  }

  // 动态 import（非字面量）：无法静态判定，按违规处理
  const dynamicNonLiteral = /(?<![.\w$])import\s*\(\s*(?!['"`])/g
  while ((m = dynamicNonLiteral.exec(code))) {
    const prefix = code.slice(Math.max(0, m.index - 8), m.index)
    push(NONLITERAL_SPEC, 'dynamic-nonliteral', /typeof\s*$/.test(prefix), m.index)
  }

  // require（字面量）：CommonJS 写法同样能拿到真模块 → 一律按值引用
  const requireCall = /(?<![.\w$])require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  while ((m = requireCall.exec(code))) push(m[1], 'require', false, m.index)

  // require（非字面量）
  const requireNonLiteral = /(?<![.\w$])require\s*\(\s*(?!['"`])/g
  while ((m = requireNonLiteral.exec(code))) push(NONLITERAL_SPEC, 'require-nonliteral', false, m.index)

  return refs.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
}

/**
 * 把相对 specifier 归一化成仓库相对路径（posix 分隔），供判定 allowlist。
 *
 * 路径穿越必须在这里消掉：`../../electron/main/services/../../ipc/work`
 * 归一化后是 `electron/main/ipc/work`，只看原始字符串里的 `services/` 会放过它。
 */
export function normalizeSpecifier(fromFileRel, spec) {
  const clean = spec.replace(/\\/g, '/')
  if (!clean.startsWith('.')) return null
  const base = posix.dirname(fromFileRel.replace(/\\/g, '/'))
  return posix.normalize(posix.join(base, clean))
}

/**
 * 判定一条路径引用在「插件不得引用宿主内部」规则下是否违规。
 * 返回 null 表示合法/无关；返回仓库相对路径（或裸包名）表示违规目标。
 */
export function classifyPluginSpecifier(fromFileRel, spec, typeOnly = false) {
  if (typeOnly) return null
  // 非字面量参数静态无法判定目标：按违规处理（潜在绕过入口）
  if (spec === NONLITERAL_SPEC) return spec
  const clean = spec.replace(/\\/g, '/')

  // 裸 specifier（包名/别名）：只有直接 import electron 包或写死 electron/main 路径才管
  if (!clean.startsWith('.')) {
    if (clean === 'electron' || (clean.startsWith('electron/') && !clean.startsWith('electron/main/'))) {
      return clean
    }
    const idxBare = clean.indexOf('electron/main/')
    if (idxBare < 0) return null
    const tailBare = clean.slice(idxBare)
    return PLUGIN_ALLOW_RE.test(tailBare) ? null : tailBare
  }

  // 相对 specifier：先归一化（消掉 .. / .），再判定，防 `services/../ipc` 穿越
  const normalized = normalizeSpecifier(fromFileRel, clean)
  if (!normalized) return null
  const idx = normalized.indexOf('electron/main/')
  if (idx < 0) return null
  const tail = normalized.slice(idx)
  return PLUGIN_ALLOW_RE.test(tail) ? null : tail
}

/** 扫描 plugins/**：返回宿主越界引用 */
export function findPluginHostViolations(root = repoRoot) {
  const hits = []
  for (const abs of walk(join(root, 'plugins'))) {
    const fileRel = relative(root, abs).replace(/\\/g, '/')
    const src = readFileSync(abs, 'utf8')
    for (const ref of moduleReferences(src)) {
      const target = classifyPluginSpecifier(fileRel, ref.spec, ref.typeOnly)
      if (!target) continue
      hits.push({ file: fileRel, line: ref.line, spec: ref.spec, target, kind: ref.kind })
    }
  }
  return hits
}

/**
 * Manager 扫描目录：plugins/<id>/domain（域代码 WP3 已从 electron/main/{work,marketing} 搬走）。
 * 返回真实存在的目录；验收会断言它非空，防「目录没了所以 0 条」的假绿回归。
 */
export function listManagerDirs(root = repoRoot) {
  const pluginsDir = join(root, 'plugins')
  if (!existsSync(pluginsDir)) return []
  return readdirSync(pluginsDir)
    .map((id) => join(pluginsDir, id, 'domain'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
}

/** 从一份源码里找 'electron' 包引用（Manager 层规则；纯函数，便于回归） */
export function managerElectronRefs(src) {
  return moduleReferences(src).filter(
    (ref) => !ref.typeOnly && (ref.spec === 'electron' || ref.spec.startsWith('electron/'))
  )
}

/** 扫描 plugins/<id>/domain：返回 Manager 层 import electron 副作用的命中 */
export function findManagerElectronHits(root = repoRoot) {
  const hits = []
  for (const dir of listManagerDirs(root)) {
    for (const abs of walk(dir)) {
      if (!abs.endsWith('.ts')) continue
      const fileRel = relative(root, abs).replace(/\\/g, '/')
      for (const ref of managerElectronRefs(readFileSync(abs, 'utf8'))) {
        hits.push({ file: fileRel, line: ref.line, text: `${ref.kind} '${ref.spec}'` })
      }
    }
  }
  return hits
}

// ── 主流程（被 import 时不执行）───────────────────────────────────────────────
const isMain =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const pluginHits = findPluginHostViolations()
  const managerHits = findManagerElectronHits()
  const managerDirs = listManagerDirs()
  const current = { pluginHostBoundary: pluginHits.length, managerElectron: managerHits.length }

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : { pluginHostBoundary: 0, managerElectron: 0 }

  const failures = []
  // 空目录扫描 = 什么都没查：必须显式失败，否则规则悄悄失效（2026-11-02 审查发现）
  if (managerDirs.length === 0) {
    failures.push('managerElectron 扫描目录为空（plugins/<id>/domain 不存在）')
  }

  if (process.argv.includes('--update')) {
    // 拒绝在「扫描目录为空」时固化基线：那正是域目录被搬走时最容易被误用的路径
    if (failures.length) {
      console.error('\n✗ 拒绝写基线：')
      for (const f of failures) console.error('  ' + f)
      process.exit(1)
    }
    // ratchet 只准降：上调必须显式 --allow-raise，并在提交信息 / _note 写明原因
    const raised = Object.keys(current).filter((k) => current[k] > (baseline[k] ?? 0))
    if (raised.length && !process.argv.includes('--allow-raise')) {
      const detail = raised.map((k) => `${k} ${baseline[k] ?? 0}→${current[k]}`).join(', ')
      console.error(`\n✗ 拒绝上调基线（ratchet 只准降）：${detail}`)
      console.error('  若确属新暴露的真实耦合，用 --allow-raise 并在基线 _note 写明原因')
      process.exit(1)
    }
    // 保留既有 _note：--update 只该改数字，不该把「为什么是 11」的说明擦掉
    const next = baseline._note ? { ...current, _note: baseline._note } : current
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    console.log('基线已更新：', JSON.stringify(current))
    process.exit(0)
  }

  for (const key of Object.keys(current)) {
    const limit = baseline[key] ?? 0
    if (current[key] > limit) {
      failures.push(`${key}: ${current[key]} > 基线 ${limit}`)
    }
    if (current[key] < limit) {
      console.log(`提示：${key} 已降到 ${current[key]}（基线 ${limit}），可跑 --update 收紧基线`)
    }
  }

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({ current, baseline, managerDirs, failures, pluginHits, managerHits }, null, 2)
    )
    process.exit(failures.length ? 1 : 0)
  }

  if (pluginHits.length) {
    console.log(`\n插件越界 import（${pluginHits.length} 条）：`)
    for (const h of pluginHits) console.log(`  ${h.file}:${h.line}  [${h.kind}] ${h.spec}`)
  }
  if (managerHits.length) {
    console.log(`\nManager 层 import electron（${managerHits.length} 条）：`)
    for (const h of managerHits) console.log(`  ${h.file}:${h.line}  ${h.text}`)
  }

  if (failures.length) {
    console.error('\n✗ 边界门禁失败：')
    for (const f of failures) console.error('  ' + f)
    process.exit(1)
  }

  console.log(
    `\n✓ 边界门禁通过：pluginHostBoundary=${current.pluginHostBoundary}（基线 ${baseline.pluginHostBoundary}），` +
      `managerElectron=${current.managerElectron}（基线 ${baseline.managerElectron}，扫描 ${managerDirs.length} 个域目录）`
  )
  process.exit(0)
}
