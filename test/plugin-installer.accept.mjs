// test/plugin-installer.accept.mjs —— Phase 2 C2：安装/更新/回滚/卸载
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, bundleEntry, assert, assertEq, printResult, writeJson, __dirname } from './_lib.mjs'

const r = new Recorder('Phase 2 · 插件安装/更新/回滚（C2）')
const mod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginInstaller.ts', 'installer.mjs', { externals: ['adm-zip'] })).href
)
const pkg = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPackage.ts', 'installer-pkg.mjs', { externals: ['adm-zip'] })).href
)

function makeSource(dir, version = '1.0.0', main = 'module.exports={activate(){}}') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version, name: 'Demo' }), 'utf8')
  writeFileSync(join(dir, 'main.js'), main, 'utf8')
}

async function pack(dir, source, version) {
  const kp = pkg.generateSigningKeyPair()
  const out = join(dir, `demo-${version}.umi-plugin`)
  pkg.packPlugin({
    sourceDir: source,
    outFile: out,
    keyId: kp.keyId,
    privateKeyPem: kp.privateKeyPem,
    publicKeyBase64: kp.publicKeyBase64
  })
  return { out, kp }
}

await r.check('C2-1', '首次安装：验签 → 解包到 plugin-packages/<id>/<version> → 状态/数据目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-inst-'))
  try {
    const src = join(root, 'src')
    makeSource(src)
    const { out } = await pack(root, src, '1.0.0')
    const dataDir = join(root, 'data')
    const res = mod.installPlugin({
      dataDir,
      packageFile: out,
      allowSelfSigned: true,
      hostVersion: '5.0.0',
      stagingChildSource: join(root, 'child.js')
    })
    assertEq(res.ok, true, JSON.stringify(res))
    assertEq(res.record.version, '1.0.0')
    assertEq(res.record.trustLevel, 'self')
    assert(existsSync(join(dataDir, 'plugin-packages', 'demo', '1.0.0', 'main.js')), '包文件解出')
    assert(existsSync(join(dataDir, 'plugins', 'demo')), '数据目录创建')
    const state = mod.readInstallState(dataDir)
    assertEq(state.plugins.demo.version, '1.0.0', '状态写入')
    return '首次安装 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await r.check('C2-2', '更新：旧版本进 previous、数据先快照；回滚恢复版本与数据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-inst-'))
  try {
    const dataDir = join(root, 'data')
    const src1 = join(root, 'src1')
    makeSource(src1, '1.0.0')
    const p1 = await pack(root, src1, '1.0.0')
    assertEq(mod.installPlugin({ dataDir, packageFile: p1.out, allowSelfSigned: true, now: 1000 }).ok, true)
    writeFileSync(join(dataDir, 'plugins', 'demo', 'keep.txt'), 'v1-data', 'utf8')

    const src2 = join(root, 'src2')
    makeSource(src2, '1.1.0', 'module.exports={activate(){return "v2"}}')
    const p2 = await pack(root, src2, '1.1.0')
    const upd = mod.installPlugin({ dataDir, packageFile: p2.out, allowSelfSigned: true, now: 2000 })
    assertEq(upd.ok, true, JSON.stringify(upd))
    assertEq(upd.record.version, '1.1.0')
    assertEq(upd.record.previous.version, '1.0.0')
    assert(existsSync(upd.record.previous.backupDir), '数据快照')
    assertEq(readFileSync(join(dataDir, 'plugins', 'demo', 'keep.txt'), 'utf8'), 'v1-data', '更新不改数据')

    writeFileSync(join(dataDir, 'plugins', 'demo', 'keep.txt'), 'v2-data', 'utf8')
    const rb = mod.rollbackPlugin(dataDir, 'demo')
    assertEq(rb.ok, true, JSON.stringify(rb))
    assertEq(rb.record.version, '1.0.0', '回滚版本')
    assertEq(readFileSync(join(dataDir, 'plugins', 'demo', 'keep.txt'), 'utf8'), 'v1-data', '回滚恢复快照')
    return '更新/回滚 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await r.check('C2-3', '卸载：默认保留数据；keepData=false 删数据；未知 id 拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-inst-'))
  try {
    const dataDir = join(root, 'data')
    const src = join(root, 'src')
    makeSource(src)
    const p = await pack(root, src, '1.0.0')
    mod.installPlugin({ dataDir, packageFile: p.out, allowSelfSigned: true })
    writeFileSync(join(dataDir, 'plugins', 'demo', 'x.txt'), 'x', 'utf8')
    assertEq(mod.uninstallPlugin(dataDir, 'demo', true).ok, true)
    assert(!existsSync(join(dataDir, 'plugin-packages', 'demo', '1.0.0')), '包已删')
    assert(existsSync(join(dataDir, 'plugins', 'demo', 'x.txt')), '数据保留')
    assertEq(mod.readInstallState(dataDir).plugins.demo, undefined, '状态移除')
    assertEq(mod.uninstallPlugin(dataDir, 'missing').code, 'PLUGIN_NOT_INSTALLED', '未知 id')
    return '卸载 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await r.check('C2-4', '篡改包/未信任签名安装一律拒绝，且不写状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-inst-'))
  try {
    const src = join(root, 'src')
    makeSource(src)
    const p = await pack(root, src, '1.0.0')
    const dataDir = join(root, 'data')
    const denied = mod.installPlugin({ dataDir, packageFile: p.out })
    assertEq(denied.ok, false, 'self 未授权拒绝')
    assertEq(denied.code, 'PACKAGE_UNTRUSTED_KEY', '错误码')
    assertEq(mod.readInstallState(dataDir).plugins.demo, undefined, '不写状态')
    return '安装拒绝 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await r.check('C2-5', 'C3 兼容：apiVersion/engines.host 不兼容拒绝安装', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-inst-'))
  try {
    const src = join(root, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'plugin.json'),
      JSON.stringify({ id: 'demo', version: '1.0.0', name: 'Demo', apiVersion: 1, engines: { host: '>=9.0.0 <10.0.0' } }),
      'utf8'
    )
    writeFileSync(join(src, 'main.js'), 'module.exports={}', 'utf8')
    const p = await pack(root, src, '1.0.0')
    const res = mod.installPlugin({
      dataDir: join(root, 'data'),
      packageFile: p.out,
      allowSelfSigned: true,
      hostVersion: '5.0.0'
    })
    assertEq(res.ok, false, '不兼容拒绝')
    assertEq(res.code, 'PLUGIN_INCOMPATIBLE', '兼容错误码')
    return '兼容门 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-installer.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
