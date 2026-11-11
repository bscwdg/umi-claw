// scripts/check-style-tokens.mjs —— 样式 token 门禁（零依赖，对齐 check-boundaries.mjs）
//
// 为什么独立脚本而不是 eslint：本机 NODE_ENV=production 时 npm i -D 会删掉
// devDependencies（check-boundaries.mjs 头注已实测记录），零依赖脚本不受影响。
//
// 检查（只扫 <style> 块与 .css 文件，不扫 script 里的颜色常量）：
//   1. hardColor        hex / rgb() / rgba() 裸值
//   2. rem              rem 单位（全项目只用 px）
//   3. badVarName       不存在的旧变量名（--bg-primary/--bg-secondary/--border-color/--text-color）
//   4. globalOverride   scoped 样式重定义全局保留类（.btn/.card/.badge/.form-*/.toggle/.modal-*/.alert/.toast）
//   5. bareRadius       border-radius 裸 px（应走 --radius-*）
//   6. bareFontSize     font-size 裸 px（应走 --text-*）
//
// 白名单整体豁免：SVG 插画、透明桌宠窗、token 定义文件；plugins/** 单独分组冻结。
// 基线（scripts/style-tokens-baseline.json）只准降不准升，--update 重写。
//
// 用法：node scripts/check-style-tokens.mjs [--update] [--json]

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(repoRoot, 'scripts', 'style-tokens-baseline.json')

/** 整体豁免文件（相对仓库根，正斜杠） */
export const STYLE_WHITELIST = [
  'src/character/art/FishState.vue',
  'src/character/PetWindow.vue',
  'src/assets/style.css',
  'src/theme/themes.ts'
]

/** scoped 中禁止重定义的全局保留类（负向先行排除 .btn-primary 这类修饰符） */
const GLOBAL_CLASSES = [
  'btn', 'card', 'badge', 'form-input', 'form-select', 'form-textarea',
  'toggle', 'modal-overlay', 'modal-card', 'alert', 'toast'
]

export const CHECK_KEYS = [
  'hardColor', 'rem', 'badVarName', 'globalOverride', 'bareRadius', 'bareFontSize'
]

/** 剥离 /* * / 块注释（样式块内唯一合法注释形式） */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 提取 vue SFC 的 style 块；非 vue 文件按全文处理 */
export function extractStyleBlocks(src, filename) {
  if (!filename.endsWith('.vue')) {
    return [{ content: src, scoped: false }]
  }
  const blocks = []
  const re = /<style([^>]*)>([\s\S]*?)<\/style>/gi
  let m
  while ((m = re.exec(src)) !== null) {
    blocks.push({ content: m[2], scoped: /\bscoped\b/.test(m[1]) })
  }
  return blocks
}

/** 计算子串在全文中的 1 起始行号 */
function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

function collect(regex, content, baseOffset, file) {
  const out = []
  for (const m of content.matchAll(regex)) {
    out.push({ file, line: lineOf(content, m.index) + (baseOffset ?? 0), match: m[0].trim() })
  }
  return out
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g
const RGB_RE = /rgba?\([^)]*\)/g
const REM_RE = /[0-9.]+rem\b/gi
const BAD_VAR_RE = /--(?:bg-primary|bg-secondary|border-color|text-color)\b/g
const BARE_RADIUS_RE = /border-radius:\s*([0-9]+)px/gi
const BARE_FONT_RE = /font-size:\s*([0-9]+)px/gi
const OVERRIDE_RE = new RegExp(
  `(?:^|\\})\\s*\\.(${GLOBAL_CLASSES.join('|')})(?![\\w-])[^{]*\\{`,
  'gm'
)

/**
 * 扫描单文件，返回六项命中数组（已剥注释、已按 style 块切分）。
 * 白名单文件由上层过滤，本函数不判白名单。
 */
export function scanFile(absPath) {
  const rel = relative(repoRoot, absPath).replace(/\\/g, '/')
  const raw = readFileSync(absPath, 'utf8')
  const result = Object.fromEntries(CHECK_KEYS.map((k) => [k, []]))
  const blocks = extractStyleBlocks(raw, absPath)

  for (const block of blocks) {
    const content = stripComments(block.content)
    result.hardColor.push(...collect(HEX_RE, content, 0, rel))
    result.hardColor.push(...collect(RGB_RE, content, 0, rel))
    result.rem.push(...collect(REM_RE, content, 0, rel))
    result.badVarName.push(...collect(BAD_VAR_RE, content, 0, rel))
    result.bareRadius.push(...collect(BARE_RADIUS_RE, content, 0, rel))
    result.bareFontSize.push(...collect(BARE_FONT_RE, content, 0, rel))
    if (block.scoped) {
      result.globalOverride.push(...collect(OVERRIDE_RE, content, 0, rel))
    }
  }
  return result
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-electron' || name.startsWith('.')) continue
    const abs = join(dir, name)
    const st = readdirSafeStat(abs)
    if (st?.isDirectory()) walk(abs, out)
    else if (/\.(vue|css)$/.test(name)) out.push(abs)
  }
  return out
}

function readdirSafeStat(abs) {
  try { return statSync(abs) } catch { return null }
}

function isWhitelisted(rel) {
  return STYLE_WHITELIST.includes(rel)
}

/** 全仓扫描，按 src / plugins 两组汇总计数与明细 */
export function collectAll() {
  const files = [
    ...walk(join(repoRoot, 'src')),
    ...walk(join(repoRoot, 'plugins'))
  ]
  const groups = {
    src: emptySummary(),
    plugins: emptySummary()
  }
  const details = []
  for (const abs of files) {
    const rel = relative(repoRoot, abs).replace(/\\/g, '/')
    if (isWhitelisted(rel)) continue
    const scanned = scanFile(abs)
    const group = rel.startsWith('plugins/') ? 'plugins' : 'src'
    for (const key of CHECK_KEYS) {
      groups[group][key] += scanned[key].length
      if (scanned[key].length) details.push(...scanned[key])
    }
  }
  return { groups, details }
}

function emptySummary() {
  return Object.fromEntries(CHECK_KEYS.map((k) => [k, 0]))
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf8'))
}

/** 棘轮：每组每项实测不得高于基线；返回违例列表 */
export function compareBaseline(groups, baseline) {
  const violations = []
  for (const group of ['src', 'plugins']) {
    const base = baseline[group]
    if (!base) {
      violations.push(`基线缺少分组 ${group}`)
      continue
    }
    for (const key of CHECK_KEYS) {
      const actual = groups[group][key]
      const allowed = base[key] ?? 0
      if (actual > allowed) {
        violations.push(`${group}.${key} 实测 ${actual} > 基线 ${allowed}`)
      }
    }
  }
  return violations
}

function writeBaseline(groups) {
  const prev = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
  const payload = {
    ...groups,
    _note: prev._note ||
      '样式 token 门禁基线（scripts/check-style-tokens.mjs）：只准降不准升；' +
      '白名单见脚本 STYLE_WHITELIST（FishState 插画 / PetWindow 透明桌宠 / token 定义文件）；' +
      'plugins 组冻结，宿主页面迁移只降 src 组。--update 重写本文件。'
  }
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

// 直接执行时跑主流程；被 test/style-tokens.accept.mjs import 时不执行
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { groups, details } = collectAll()
  if (process.argv.includes('--update')) {
    writeBaseline(groups)
    console.log('[style-tokens] 基线已更新：', JSON.stringify(groups))
    process.exit(0)
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ groups, details }, null, 2))
    process.exit(0)
  }
  const baseline = readBaseline()
  const violations = compareBaseline(groups, baseline)
  console.log('[style-tokens] 实测：', JSON.stringify(groups))
  if (violations.length) {
    console.error('[style-tokens] ❌ 门禁失败（只允许下调基线，修复样式或经评审后 --update）：')
    for (const v of violations) console.error('  - ' + v)
    process.exit(1)
  }
  console.log('[style-tokens] ✅ 全部计数 ≤ 基线')
}
