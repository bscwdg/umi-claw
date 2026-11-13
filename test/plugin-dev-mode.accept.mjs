// test/plugin-dev-mode.accept.mjs —— Phase 1 B5：开发者模式闸门
//
// 关键判据：打包版即使设置 env 也拒绝；dev 只有两个 env 同时设置才允许 build；
// 开关本身不引入第三方安装入口。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  writeJson
} from './_lib.mjs'

const r = new Recorder('Phase 1 · 开发者模式闸门（B5）')
const devMod = await import(pathToFileURL(bundleEntry('electron/main/kernel/devMode.ts', 'dev-mode.mjs')).href)

await r.check('D1', '打包版即使设置 UMI_DEV_PLUGINS/UMI_DEV_BUILD 也拒绝', async () => {
  const state = devMod.resolveDevMode({
    isPackaged: true,
    env: { UMI_DEV_PLUGINS: '1', UMI_DEV_BUILD: '1' }
  })
  assertEq(state.plugins, false, '打包版 plugins=false')
  assertEq(state.build, false, '打包版 build=false')
  assertEq(state.reason, 'packaged-build', '拒绝原因')
  return '打包版拒绝 ✓'
})

await r.check('D2', '未设置 env 默认关闭；只设 build 也不开', async () => {
  assertEq(devMod.resolveDevMode({ isPackaged: false, env: {} }).plugins, false, '默认关闭')
  const buildOnly = devMod.resolveDevMode({ isPackaged: false, env: { UMI_DEV_BUILD: '1' } })
  assertEq(buildOnly.plugins, false, 'build-only 不开 plugins')
  assertEq(buildOnly.build, false, 'build-only 不开 build')
  return '默认关闭 ✓'
})

await r.check('D3', 'dev 版两个 env 同时设置才开 build，并带风险提示', async () => {
  const pluginsOnly = devMod.resolveDevMode({ isPackaged: false, env: { UMI_DEV_PLUGINS: '1' } })
  assertEq(pluginsOnly.plugins, true, 'plugins 开启')
  assertEq(pluginsOnly.build, false, '未设 build 不开')
  assert(pluginsOnly.warning?.includes('开发者模式'), '风险提示')

  const both = devMod.resolveDevMode({
    isPackaged: false,
    env: { UMI_DEV_PLUGINS: '1', UMI_DEV_BUILD: '1' }
  })
  assertEq(both.plugins, true, 'plugins 开启')
  assertEq(both.build, true, 'build 开启')
  return 'dev 双开关 ✓'
})

await r.check('D4', '接线：plugin:dev-mode IPC 带 {ok,data} 信封 + preload + 管理页横幅；纯闸门不扫描/不加载', async () => {
  const runtime = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  const preload = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf8')
  const page = readFileSync(join(repoRoot, 'src', 'views', 'PluginManager.vue'), 'utf8')
  assert(runtime.includes("'plugin:dev-mode'"), 'IPC 通道')
  assert(
    /handle\('plugin:dev-mode',\s*\(\)\s*=>\s*\(\{\s*ok:\s*true,\s*data:\s*resolveDevMode/.test(runtime),
    'handler 必须返回 {ok:true,data} 信封（preload 按信封解包）'
  )
  assert(preload.includes('devMode: () => call<'), 'preload 走 call 解包')
  assert(page.includes('dev-banner'), '管理页风险横幅')
  assert(page.includes('devMode?.plugins'), '横幅由 devMode 驱动')
  assert(!/dev-plugins/.test(runtime), '本批不扫描 dev-plugins（不引入入口）')
  return 'dev-mode 连接线（含信封） ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-dev-mode.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
