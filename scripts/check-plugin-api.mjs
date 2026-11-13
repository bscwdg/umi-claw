// scripts/check-plugin-api.mjs —— 插件 API 迁移 ratchet（PLAN-5.0 A2/A3b）
//
// 为什么单独一个门禁：`check-boundaries.mjs` 只管「插件不得 import electron/main 内部」，
// 但 SDK 迁移需要三个方向的可量化进度：
//   1) plugins/** 直接 import electron/main（值 / 类型）——应逐步归零；
//   2) plugins/** 直接 import 宿主渲染端（`@/` 或相对 src/）——应逐步归零；
//   3) plugins/** 直接消费 `plugins/shared/hostBridge`——应逐步归零/收窄。
// 基线只准降不准升；`--update` 才写，上调必须 `--allow-raise --note`。
//
// 用法：node scripts/check-plugin-api.mjs [--update] [--json]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleReferences, normalizeSpecifier, walk } from './check-boundaries.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(repoRoot, 'scripts', 'plugin-api-baseline.json')

/** 扫描 plugins/**，返回四项计数（供 CLI 与 accept 共用） */
export function scanPluginApi(root = repoRoot) {
  const counts = {
    pluginHostImport: 0,
    pluginHostTypeOnly: 0,
    pluginUiHostImport: 0,
    pluginUiHostTypeOnly: 0,
    hostBridgeConsumers: 0
  }
  for (const abs of walk(join(root, 'plugins'))) {
    const fileRel = relative(root, abs).replace(/\\/g, '/')
    if (!/\.(ts|vue)$/.test(fileRel)) continue
    const src = readFileSync(abs, 'utf8')
    let consumesHostBridge = false
    for (const ref of moduleReferences(src)) {
      const spec = ref.spec
      if (spec === '<non-literal>') continue

      // 1) 宿主主进程
      const normalized = spec.startsWith('.') ? normalizeSpecifier(fileRel, spec) : null
      const target = normalized ?? (spec.startsWith('electron/main/') ? spec : null)
      if (target && target.startsWith('electron/main/')) {
        if (ref.typeOnly) counts.pluginHostTypeOnly += 1
        else counts.pluginHostImport += 1
      }

      // 2) 宿主渲染端（@/ 或相对 src/）
      if (spec.startsWith('@/') || (normalized && normalized.startsWith('src/'))) {
        if (ref.typeOnly) counts.pluginUiHostTypeOnly += 1
        else counts.pluginUiHostImport += 1
      }

      // 3) hostBridge 消费者（按文件去重）
      if (spec.includes('shared/hostBridge')) consumesHostBridge = true
    }
    if (consumesHostBridge) counts.hostBridgeConsumers += 1
  }
  return counts
}

export function readBaseline(path = baselinePath) {
  if (!existsSync(path)) {
    return {
      pluginHostImport: 0,
      pluginHostTypeOnly: 0,
      pluginUiHostImport: 0,
      pluginUiHostTypeOnly: 0,
      hostBridgeConsumers: 0
    }
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const current = scanPluginApi()
  const baseline = readBaseline()
  const failures = []

  if (process.argv.includes('--update')) {
    // ratchet 只准降：上调必须显式 --allow-raise + --note（与 check-boundaries 同口径）
    const raised = Object.keys(current).filter((k) => current[k] > (baseline[k] ?? 0))
    const noteIdx = process.argv.indexOf('--note')
    const givenNote = noteIdx >= 0 ? String(process.argv[noteIdx + 1] ?? '').trim() : ''
    let raiseNote = ''
    if (raised.length) {
      const detail = raised.map((k) => `${k} ${baseline[k] ?? 0}→${current[k]}`).join(', ')
      raiseNote = givenNote
      if (!process.argv.includes('--allow-raise')) {
        console.error(`\n✗ 拒绝上调基线（ratchet 只准降）：${detail}`)
        console.error('  若确属新暴露的真实耦合，用 --allow-raise --note "<原因>" 并在提交信息写明')
        process.exit(1)
      }
      if (!raiseNote) {
        console.error(`\n✗ --allow-raise 必须同时给 --note "<原因>"：${detail}`)
        process.exit(1)
      }
    }
    // 保留既有 _note；上调追加原因；纯收紧时允许用 --note 重写说明。
    let nextNote = baseline._note
    if (raiseNote) {
      const stamp = new Date().toISOString().slice(0, 10)
      nextNote = `${nextNote ? nextNote + ' | ' : ''}${stamp} raised by --note: ${raiseNote}`
    } else if (givenNote) {
      nextNote = givenNote
    }
    const next = nextNote ? { ...current, _note: nextNote } : current
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    console.log('基线已更新：', JSON.stringify(current))
    process.exit(0)
  }

  for (const key of Object.keys(current)) {
    const limit = baseline[key] ?? 0
    if (current[key] > limit) failures.push(`${key}: ${current[key]} > 基线 ${limit}`)
    if (current[key] < limit) console.log(`提示：${key} 已降到 ${current[key]}（基线 ${limit}），可跑 --update 收紧`)
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ current, baseline, failures }, null, 2))
    process.exit(failures.length ? 1 : 0)
  }
  if (failures.length) {
    console.error('\n✗ 插件 API ratchet 失败：')
    for (const f of failures) console.error('  ' + f)
    process.exit(1)
  }
  console.log(
    `✓ 插件 API ratchet 通过：host=${current.pluginHostImport}(+${current.pluginHostTypeOnly} type) ` +
      `ui=${current.pluginUiHostImport}(+${current.pluginUiHostTypeOnly} type) hostBridge=${current.hostBridgeConsumers}`
  )
  process.exit(0)
}
