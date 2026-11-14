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
  assert(preload.includes('isolatedStatuses'), '隔离状态 IPC 已暴露')
  assert(runtime.includes("'plugin:isolated:list'"), '隔离状态 IPC 通道')
  assert(page.includes('第三方插件（.umi-plugin）'), '管理页安装入口')
  assert(page.includes('pickPackage'), '安装包选择接线')
  assert(preload.includes('pickPackage'), 'pickPackage 已暴露')
  assert(page.includes('schemaFields'), 'C6 configSchema 渲染')
  assert(preload.includes('getConfig') && preload.includes('setConfig'), 'C6 配置 IPC')
  assert(!/dev-plugins/.test(runtime), '本批不扫描 dev-plugins（不引入入口）')
  return 'dev-mode 连接线（含信封） ✓'
})

await r.check('D5', 'C6 安装入口：pick-package 信封 + 选包先验签 + TOFU 首次确认/已信任免确认', async () => {
  const runtime = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  const preload = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf8')
  const page = readFileSync(join(repoRoot, 'src', 'views', 'PluginManager.vue'), 'utf8')

  // ① handler 信封断言必须限定在 handler 函数体内。跨到下一条 handler 的正则会让
  //    旧代码（裸返回 null/路径）也假绿（对抗审查 #1）。
  const start = runtime.indexOf("handle('plugin:pick-package'")
  const end = runtime.indexOf("deps.ipc.removeHandler('plugin:diagnostics')", start)
  assert(start >= 0 && end > start, 'pick-package handler 边界可定位')
  const handlerBody = runtime.slice(start, end)
  assert(/ok: true, data: null/.test(handlerBody), '无 picker / 用户取消必须回 data:null 信封')
  assert(/ok: true, data: await deps\.pickPackage\(\)/.test(handlerBody), '选中路径必须回 data 信封')
  assert(/PLUGIN_OPERATION_FAILED/.test(handlerBody), 'picker 抛异常回失败信封（不裸抛）')
  assert(/pickPackage: \(\) => call<string \| null>\('plugin:pick-package'\)/.test(preload), 'preload 按信封解包 pick-package')

  // ② UI 状态机：重选清旧包、取消不报错、无验签结果不得确认、首次自签才要勾选
  assert(
    /async function pickInstall\(\): Promise<void> \{[\s\S]{0,600}?cancelPick\(\)[\s\S]{0,400}?window\.api\.plugins\.pickPackage\(\)/.test(page),
    '重选/取消必须先从清旧待装包开始（否则 pendingPackage 残留会绕过 TOFU）'
  )
  assert(
    /const file = await window\.api\.plugins\.pickPackage\(\)[\s\S]{0,200}?if \(!file\) return/.test(page),
    '取消是正常路径，不能弹错'
  )
  assert(
    /pendingInspect\.value = await window\.api\.plugins\.inspectPackage\(file\)/.test(page),
    '选完包先验签并把结果写入 pendingInspect'
  )
  assert(
    /if \(!pendingPackage\.value \|\| !pendingInspect\.value\) return/.test(page),
    '没有验签结果不得确认安装'
  )
  assert(
    /:disabled="installBusy \|\| \(pendingInspect\?\.trust === 'self' && pendingInspect\.tofu === 'new' && !selfTrust\)"/.test(page),
    '首次自签未勾选时禁用确认按钮'
  )
  assert(
    /v-if="pendingInspect\?\.trust === 'self' && pendingInspect\.tofu === 'new'"[\s\S]{0,200}?v-model="selfTrust"/.test(page),
    '只在「首次安装」要求显式勾选 TOFU'
  )
  assert(/inspect\.tofu === 'known' \|\| selfTrust\.value/.test(page), '已信任的 self key 更新免二次勾选')
  assert(/@click="cancelPick"/.test(page), '取消按钮走 cancelPick 清理')

  // ③ inspect 必须传 dataDir 才能区分首次/已信任
  const inspectStart = runtime.indexOf("'plugin:inspect-package'")
  const inspectEnd = runtime.indexOf("'plugin:config:get'", inspectStart)
  assert(
    inspectStart >= 0 && /dataDir: deps\.dataDir\(\)/.test(runtime.slice(inspectStart, inspectEnd)),
    'inspect-package 传 dataDir（读 plugin-trust.json 判断首次/已信任）'
  )
  return '安装入口接线 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-dev-mode.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
