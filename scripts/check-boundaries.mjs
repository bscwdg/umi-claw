// scripts/check-boundaries.mjs —— 插件边界门禁（零依赖，WP3 阶段 A）
//
// 为什么不装 eslint：本机 NODE_ENV=production 时 `npm i -D` 会把 devDependencies
// 整棵删掉（已实测：449 packages removed、双 typecheck 变红）。用零依赖脚本达到
// 同样目的，且不受 npm 环境影响。
//
// 检查两件事（对应 AGENTS.md §5.1 与 §4.1）：
//   1. plugins/** 不得 import electron/main 下除 kernel / services 以外的模块
//   2. electron/main/{work,marketing} 的 Manager 层不得 import electron 副作用
//
// 基线（scripts/boundary-baseline.json）只准降不准升：违规数 > 基线 → 退出码 1。
//
// 用法：node scripts/check-boundaries.mjs [--update] [--json]

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(repoRoot, 'scripts', 'boundary-baseline.json')

function walk(dir, out = []) {
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

/**
 * 抽出全部 import 语句（支持多行），并判定它是否「纯类型」。
 *
 * 为什么不能用「只看单行」：多行 import 的收尾行是 `} from '...'`，
 * 首行才是 `import ...`。而且「全部成员都带 type」也是一种类型导入
 * （`import { type A, type B } from '...'`），不能只认 `import type`。
 */
function importStatements(src) {
  const out = []
  // 逐个匹配 import ... from '...'，允许跨行
  const re = /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const stmt = m[0]
    const spec = m[1]
    const explicitlyType = /^import\s+type\b/.test(stmt)
    // 取花括号内的成员列表
    const brace = stmt.match(/\{([\s\S]*?)\}/)
    let allMembersType = false
    if (brace) {
      const members = brace[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      allMembersType = members.length > 0 && members.every((x) => x.startsWith('type '))
    }
    out.push({ spec, isTypeOnly: explicitlyType || allMembersType, stmt })
  }
  return out
}

const PLUGIN_ALLOW = /^[./\\]*electron\/main\/(kernel|services)(\/|$)/

function checkPlugins() {
  const files = walk(join(repoRoot, 'plugins'))
  const hits = []
  for (const abs of files) {
    const src = readFileSync(abs, 'utf8')
    const lineOf = (spec) => {
      const idx = src.indexOf(spec)
      return idx < 0 ? 0 : src.slice(0, idx).split('\n').length
    }
    for (const stmt of importStatements(src)) {
      const spec = stmt.spec
      if (!spec.includes('electron/main/')) continue
      if (PLUGIN_ALLOW.test(spec)) continue
      if (stmt.isTypeOnly) continue
      hits.push({
        file: relative(repoRoot, abs),
        line: lineOf(spec),
        spec,
        text: stmt.stmt.split('\n')[0].trim()
      })
    }
  }
  return hits
}

function checkManagers() {
  const dirs = [join(repoRoot, 'electron/main/work'), join(repoRoot, 'electron/main/marketing')]
  const hits = []
  for (const dir of dirs) {
    for (const abs of walk(dir)) {
      if (!abs.endsWith('.ts')) continue
      const src = readFileSync(abs, 'utf8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^import\s+.*from\s+'electron'/.test(line.trim())) {
          hits.push({ file: relative(repoRoot, abs), line: i + 1, text: line.trim() })
        }
      }
    }
  }
  return hits
}

const pluginHits = checkPlugins()
const managerHits = checkManagers()
const current = { pluginHostBoundary: pluginHits.length, managerElectron: managerHits.length }

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : { pluginHostBoundary: 0, managerElectron: 0 }

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n', 'utf8')
  console.log('基线已更新：', JSON.stringify(current))
  process.exit(0)
}

const failures = []
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
  console.log(JSON.stringify({ current, baseline, pluginHits, managerHits }, null, 2))
  process.exit(failures.length ? 1 : 0)
}

if (pluginHits.length) {
  console.log(`\n插件越界 import（${pluginHits.length} 条）：`)
  for (const h of pluginHits) console.log(`  ${h.file}:${h.line}  ${h.text}`)
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

console.log(`\n✓ 边界门禁通过：pluginHostBoundary=${current.pluginHostBoundary}（基线 ${baseline.pluginHostBoundary}），managerElectron=${current.managerElectron}（基线 ${baseline.managerElectron}）`)
process.exit(0)
