// test/plugin-api.accept.mjs —— 插件 API 迁移 ratchet 验收（PLAN-5.0 A2/A3b）
//
// 断言三件事：
//   1) live 扫描不高于基线（host / UI / hostBridge 三类耦合只准降）；
//   2) 基线文件结构完整（缺键 = 门禁悄悄失效）；
//   3) SDK public 不泄漏 internal（dataDir/paths/registerChannelIpc/hostOps/legacyDb/consent/abort）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  printResult,
  repoRoot,
  writeJson
} from './_lib.mjs'
import { readBaseline, scanPluginApi } from '../scripts/check-plugin-api.mjs'

const r = new Recorder('Phase 0 · 插件 API ratchet（SDK 迁移）')

const KEYS = [
  'pluginHostImport',
  'pluginHostTypeOnly',
  'pluginUiHostImport',
  'pluginUiHostTypeOnly',
  'hostBridgeConsumers'
]

await r.check('A1', '基线文件结构完整，live 扫描不高于基线（三类耦合只准降）', async () => {
  const baseline = readBaseline()
  for (const key of KEYS) {
    assertEq(typeof baseline[key], 'number', `基线缺 ${key}（门禁会悄悄失效）`)
  }
  const current = scanPluginApi()
  for (const key of KEYS) {
    assert(
      current[key] <= baseline[key],
      `${key}: ${current[key]} > 基线 ${baseline[key]}（新增宿主耦合；--update 上调需 --allow-raise --note）`
    )
  }
  return JSON.stringify(current)
})

await r.check('A2', 'SDK public 不泄漏 internal：无 dataDir/paths/registerChannelIpc/hostOps/legacyDb/consent/abort', async () => {
  const publicPath = join(repoRoot, 'plugin-sdk', 'src', 'public.ts')
  assert(existsSync(publicPath), 'plugin-sdk/src/public.ts 存在')
  const raw = readFileSync(publicPath, 'utf8')
  // 只检查代码，不把注释里的「为什么不能暴露 internal」误判成泄漏
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const forbidden of [
    'registerChannelIpc',
    'hostOps',
    'legacyDb',
    'dataDir',
    'paths:',
    'PluginContext as KernelPluginContext'
  ]) {
    assert(!src.includes(forbidden), `public.ts 不应出现 internal 名称：${forbidden}`)
  }
  // 必须暴露窄上下文与 definePlugin
  assert(/PluginContextV1/.test(src), '公开上下文为 PluginContextV1')
  assert(/function definePlugin/.test(src), 'definePlugin 本地导出')
  return 'public 面收窄 ✓'
})

await r.check('A3', 'SDK 四入口齐备（public/official/client/testing）', async () => {
  for (const name of ['public.ts', 'official.ts', 'client.ts', 'testing.ts']) {
    assert(existsSync(join(repoRoot, 'plugin-sdk', 'src', name)), `plugin-sdk/src/${name} 存在`)
  }
  const official = readFileSync(join(repoRoot, 'plugin-sdk', 'src', 'official.ts'), 'utf8')
  assert(/electron\/main\/kernel/.test(official), 'official 承接 kernel（internal）')
  for (const sub of ['official-errors.ts', 'official-gateway.ts', 'official-context.ts', 'official-knowledge.ts', 'official-import.ts', 'official-db.ts', 'official-host.ts']) {
    assert(existsSync(join(repoRoot, 'plugin-sdk', 'src', sub)), `official 子路径 ${sub} 存在`)
  }
  return 'SDK 入口齐备 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-api.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
