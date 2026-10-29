// scripts/gen-plugin-entries.mjs —— 扫描 plugins/*/plugin.json，生成两端的入口表
//
// 为什么要有这一步（PLAN-4.0 §5）：插件 UI / main 代码必须在**构建期**被静态引用，
// 运行期才知道有哪些入口可以 import。手工维护入口表容易漏（漏了就是「装了但不生效」），
// 所以由清单生成，并在 predev/prebuild 自动跑。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(repoRoot, 'plugins')

const MAIN_OUT = join(repoRoot, 'electron', 'main', 'kernel', 'plugins.main.generated.ts')
const UI_OUT = join(repoRoot, 'src', 'renderer', 'plugins.renderer.generated.ts')

function listPlugins() {
  if (!existsSync(pluginsDir)) return []
  const out = []
  for (const name of readdirSync(pluginsDir)) {
    const manifestPath = join(pluginsDir, name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch (e) {
      throw new Error(`plugins/${name}/plugin.json 不是合法 JSON：${e.message}`)
    }
    if (typeof manifest.id !== 'string' || manifest.id !== name) {
      throw new Error(`plugins/${name}/plugin.json 的 id 必须与目录名一致（实际 ${JSON.stringify(manifest.id)}）`)
    }
    if (!existsSync(join(pluginsDir, name, 'main.ts'))) {
      throw new Error(`plugins/${name} 缺少 main.ts`)
    }
    out.push({
      id: name,
      hasRenderer: existsSync(join(pluginsDir, name, 'renderer.ts'))
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const plugins = listPlugins()

const mainEntries = plugins
  .map((p) => `  ${JSON.stringify(p.id)}: () => import('../../../plugins/${p.id}/main').then((m) => m.default)`)
  .join(',\n')

const mainSrc = `// 由 scripts/gen-plugin-entries.mjs 生成，请勿手改（改清单后跑 npm run plugin:gen）
//
// 这是「构建期装配」的落点：插件代码在这里被静态引用，随之进 dist-electron 产物。
// 运行时只按启用状态决定是否 import + 激活，不做磁盘/网络的代码加载。

import type { PluginModule } from './plugin'

export const PLUGIN_MAIN_ENTRIES: Record<string, () => Promise<PluginModule>> = {
${mainEntries}
}
`

const uiPlugins = plugins.filter((p) => p.hasRenderer)
const uiEntries = uiPlugins
  .map((p) => `  ${JSON.stringify(p.id)}: () => import('../../plugins/${p.id}/renderer').then((m) => m.default)`)
  .join(',\n')

const uiSrc = `// 由 scripts/gen-plugin-entries.mjs 生成，请勿手改（改清单后跑 npm run plugin:gen）

import type { PluginUiModule } from './pluginUi'

export const PLUGIN_UI_ENTRIES: Record<string, () => Promise<PluginUiModule>> = {
${uiEntries}
}
`

mkdirSync(dirname(MAIN_OUT), { recursive: true })
mkdirSync(dirname(UI_OUT), { recursive: true })
writeFileSync(MAIN_OUT, mainSrc, 'utf-8')
writeFileSync(UI_OUT, uiSrc, 'utf-8')

// 清单与 migrations 是**数据**，随包放到 resources/plugins/<id>/（代码不进 resources）
const resourcesPluginsDir = join(repoRoot, 'resources', 'plugins')
for (const p of plugins) {
  const targetDir = join(resourcesPluginsDir, p.id)
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(
    join(targetDir, 'plugin.json'),
    readFileSync(join(pluginsDir, p.id, 'plugin.json'), 'utf-8'),
    'utf-8'
  )
  // migrations 是**数据**，必须随包走（插件库的表结构从这里解析）
  const migrationsSrc = join(pluginsDir, p.id, 'migrations')
  if (existsSync(migrationsSrc)) {
    const migrationsDst = join(targetDir, 'migrations')
    // 先清空：删掉的 SQL 不能继续被应用（审查 P2-13）
    rmSync(migrationsDst, { recursive: true, force: true })
    mkdirSync(migrationsDst, { recursive: true })
    for (const file of readdirSync(migrationsSrc)) {
      if (!file.endsWith('.sql')) continue
      writeFileSync(join(migrationsDst, file), readFileSync(join(migrationsSrc, file), 'utf-8'), 'utf-8')
    }
  }
}

console.log(`[plugin:gen] ${plugins.length} 个插件：${plugins.map((p) => p.id).join(', ') || '(无)'}`)
console.log(`[plugin:gen] main 入口 → ${MAIN_OUT}`)
console.log(`[plugin:gen] ui 入口   → ${UI_OUT}（${uiPlugins.length} 个有 renderer）`)
console.log(`[plugin:gen] 清单副本 → ${resourcesPluginsDir}`)
