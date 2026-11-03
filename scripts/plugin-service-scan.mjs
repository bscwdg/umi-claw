// scripts/plugin-service-scan.mjs —— 插件源码里 ctx.services.* 的静态扫描（构建期 + 验收共用）
//
// 为什么要有这一步：内核只注入 plugin.json 的 inject 列表（kernel/lifecycle.ts），
// 插件 main.ts 用 `ctx.services.xxx` 却没声明时不会报错，只会静默拿到 undefined
// （4.2 复核发现 B3 的 abort、4.1.1 的 consent 都踩过）。构建期与 P58 各写一份正则
// 会漂移，所以抽成这一份，两边只调用。
//
// 支持：点号 / 可选链（ctx.services.abort、ctx.services?.abort）、字符串下标
// （ctx.services['abort']，在保留字符串的掩码上扫）、解构（含默认值 `a = x` 与别名 `a: b`）。
// 已知边界（与 AGENTS §5.1 的门禁边界同档，扫描口依赖简单词法，不做类型分析）：
//   - 别名绕过：`const s = ctx.services; s.abort` 扫不到（当前仓库无此写法）；
//   - 模板插值：`` `${ctx.services.x}` `` 整体被掩掉，扫不到；
//   - 正则字面量未掩码：`/ctx.services.x/` 可能被误报（保守方向：宁可让构建失败）；
//   - 动态键：`ctx.services[key]` 扫不到（记录为不可判定，不误报）；
//   - 只扫描 plugins/**/*.ts（不含 vendor/生成物）；注释与普通字符串/模板会先被掩码。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 把注释与模板字面量替换成空格（保留换行，便于定位）。
 * `keepStrings=true` 时保留普通字符串字面量（字符串下标需要用原字符识别）。
 * 不处理正则字面量（已知边界，见文件头）。
 */
function maskSource(src, { keepStrings = false } = {}) {
  let out = ''
  let i = 0
  const n = src.length
  const append = (s) => {
    out += s
  }
  const blank = (s) => {
    out += s.replace(/[^\n]/g, ' ')
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? n : end
      blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 2
        else j += 1
      }
      const stop = Math.min(n, j + 1)
      if (keepStrings) append(src.slice(i, stop))
      else blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === '`') {
      // 模板字面量整体掩码（${} 里的表达式也一并掩掉：已知边界，见文件头）
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') j += 2
        else if (src[j] === '`') {
          j += 1
          break
        } else j += 1
      }
      blank(src.slice(i, j))
      i = j
      continue
    }
    append(c)
    i += 1
  }
  return out
}

/** 掩码注释与字符串/模板（用于点号/解构扫描） */
export function maskCommentsAndStrings(src) {
  return maskSource(src)
}

/** 掩码注释与模板、保留普通字符串（用于 ctx.services['name'] 扫描） */
export function maskCommentsKeepStrings(src) {
  return maskSource(src, { keepStrings: true })
}

const SERVICE_ACCESS_PATTERNS = [
  // 直接点号 / 可选链：ctx.services.abort、ctx.services?.abort
  /ctx\.services\?\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /ctx\.services\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // 解构：const { abort, consent: c } = ctx.services（`a = 默认值` 也要取 a）
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*ctx\.services/g
]

// 字符串下标单独在「保留字符串」的掩码上扫（否则引号已被掩成空格，永远匹配不到）
const BRACKET_SERVICE_PATTERN = /ctx\.services\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g

/** 从一段源码中提取被访问的服务名（注释/模板已掩码；去重） */
export function extractServiceRefs(src) {
  const masked = maskCommentsAndStrings(src)
  const names = new Set()
  for (const re of SERVICE_ACCESS_PATTERNS.slice(0, 2)) {
    re.lastIndex = 0
    for (const m of masked.matchAll(re)) names.add(m[1])
  }
  BRACKET_SERVICE_PATTERN.lastIndex = 0
  for (const m of maskCommentsKeepStrings(src).matchAll(BRACKET_SERVICE_PATTERN)) names.add(m[1])
  const destructure = SERVICE_ACCESS_PATTERNS[2]
  destructure.lastIndex = 0
  for (const m of masked.matchAll(destructure)) {
    for (const part of m[1].split(',')) {
      // `a: b` 取冒号左侧；`a = 默认值` 取等号左侧；`...rest` 忽略
      const raw = part.split('=')[0].split(':')[0].trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) names.add(raw)
    }
  }
  return [...names]
}

function walkTsFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkTsFiles(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
}

/** 列出某插件目录下所有 .ts 相对路径 */
export function listPluginSourceFiles(pluginDir) {
  const out = []
  walkTsFiles(pluginDir, out)
  return out
}

/**
 * 找出「用了 ctx.services.X 但 inject 没声明」的问题。
 * 返回 `[{ pluginId, file, services: string[] }]`（已按文件聚合）。
 */
export function findUndeclaredServiceRefs(pluginsDir) {
  const problems = []
  if (!existsSync(pluginsDir)) return problems
  for (const id of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!id.isDirectory()) continue
    const pluginDir = join(pluginsDir, id.name)
    const manifestPath = join(pluginDir, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const inject = new Set(Array.isArray(manifest.inject) ? manifest.inject : [])
    for (const file of listPluginSourceFiles(pluginDir)) {
      const rel = file.slice(pluginDir.length + 1)
      const refs = extractServiceRefs(readFileSync(file, 'utf-8')).filter((name) => name !== 'host')
      const missing = refs.filter((name) => !inject.has(name))
      if (missing.length) problems.push({ pluginId: id.name, file: rel, services: missing })
    }
  }
  return problems
}
