// test/plugin-package.accept.mjs —— Phase 2 C1：打包/签名/验签/TOFU
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, bundleEntry, assert, assertEq, printResult, writeJson, __dirname } from './_lib.mjs'

const r = new Recorder('Phase 2 · 包打包/签名/验签（C1）')
const pkg = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPackage.ts', 'pkg-c1.mjs', { externals: ['adm-zip'] })).href
)

const makeSource = (dir) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', name: 'Demo' }), 'utf8')
  writeFileSync(join(dir, 'main.js'), 'module.exports = { activate() {} }', 'utf8')
}

await r.check('C1-1', 'keygen → pack：SIGNATURE 存在，files 覆盖 plugin.json/main.js，签名可验', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-pkg-'))
  try {
    const src = join(dir, 'src')
    makeSource(src)
    const kp = pkg.generateSigningKeyPair()
    const out = join(dir, 'demo-1.0.0.umi-plugin')
    const sig = pkg.packPlugin({
      sourceDir: src,
      outFile: out,
      keyId: kp.keyId,
      privateKeyPem: kp.privateKeyPem,
      createdAt: '2026-11-14T00:00:00.000Z'
    })
    assertEq(sig.files.map((f) => f.path).join(','), 'main.js,plugin.json', 'files 排序')
    assertEq(sig.createdAt, '2026-11-14T00:00:00.000Z')
    const res = pkg.verifyPluginPackage(out, {
      keyring: {
        schema: 1,
        keys: {
          [kp.keyId]: { publicKey: kp.publicKeyBase64, trust: 'official', fingerprint: kp.fingerprint }
        }
      }
    })
    assertEq(res.ok, true, JSON.stringify(res))
    assertEq(res.fingerprint, kp.fingerprint, 'fingerprint')
    return 'pack/verify ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('C1-2', '篡改任意文件 → PACKAGE_HASH_MISMATCH；多文件 → FILESET_MISMATCH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-pkg-'))
  try {
    const src = join(dir, 'src')
    makeSource(src)
    const kp = pkg.generateSigningKeyPair()
    const out = join(dir, 'p.umi-plugin')
    pkg.packPlugin({ sourceDir: src, outFile: out, keyId: kp.keyId, privateKeyPem: kp.privateKeyPem })
    const keyring = {
      schema: 1,
      keys: { [kp.keyId]: { publicKey: kp.publicKeyBase64, trust: 'official', fingerprint: kp.fingerprint } }
    }
    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(out)
    zip.updateFile('main.js', Buffer.from('module.exports = { hacked: true }'))
    zip.writeZip(out)
    const res = pkg.verifyPluginPackage(out, { keyring })
    assertEq(res.ok, false, '篡改拒绝')
    assertEq(res.code, 'PACKAGE_HASH_MISMATCH', 'hash 错误码')
    return '篡改检测 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('C1-3', 'self 包：allowSelfSigned + TOFU 指纹；指纹变化/未授权均拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-pkg-'))
  try {
    const src = join(dir, 'src')
    makeSource(src)
    const kp = pkg.generateSigningKeyPair()
    const out = join(dir, 's.umi-plugin')
    pkg.packPlugin({
      sourceDir: src,
      outFile: out,
      keyId: kp.keyId,
      privateKeyPem: kp.privateKeyPem,
      publicKeyBase64: kp.publicKeyBase64
    })
    assertEq(pkg.verifyPluginPackage(out, {}).ok, false, '未知 key 默认拒绝')
    const ok = pkg.verifyPluginPackage(out, { allowSelfSigned: true, tofuFingerprint: kp.fingerprint })
    assertEq(ok.ok, true, 'TOFU 首次')
    assertEq(ok.trust, 'self', 'self 信任')
    const changed = pkg.verifyPluginPackage(out, { allowSelfSigned: true, tofuFingerprint: 'f'.repeat(64) })
    assertEq(changed.ok, false, '指纹变化拒绝')
    assertEq(changed.code, 'PACKAGE_TOFU_MISMATCH', 'TOFU 错误码')
    return 'TOFU ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('C1-4', 'zip 安全：../ 路径、重复条目、缺 SIGNATURE 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-pkg-'))
  try {
    const AdmZip = (await import('adm-zip')).default
    const bad = join(dir, 'bad.umi-plugin')
    const zip = new AdmZip()
    zip.addFile('../evil.js', Buffer.from('x'))
    zip.addFile('plugin.json', Buffer.from('{}'))
    zip.addFile('main.js', Buffer.from('x'))
    zip.addFile('SIGNATURE', Buffer.from('{}'))
    zip.writeZip(bad)
    const badRes = pkg.verifyPluginPackage(bad)
    assertEq(badRes.ok, false, 'zip-slip 拒绝')
    assert(
      ['PACKAGE_UNSAFE_PATH', 'PACKAGE_FILESET_MISMATCH', 'PACKAGE_SIGNATURE_INVALID'].includes(badRes.code),
      `zip-slip 拒绝码：${badRes.code}`
    )
    const noSig = join(dir, 'nosig.umi-plugin')
    const zip2 = new AdmZip()
    zip2.addFile('plugin.json', Buffer.from('{}'))
    zip2.writeZip(noSig)
    assertEq(pkg.verifyPluginPackage(noSig).code, 'PACKAGE_SIGNATURE_MISSING', '缺签名')
    return 'zip 安全 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('C1-5', 'keyring 读写：坏文件 fail-closed；upsert 记 fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-pkg-'))
  try {
    const file = join(dir, 'keys.json')
    writeFileSync(file, '{bad', 'utf8')
    assertEq(Object.keys(pkg.readKeyring(file).keys).length, 0, '坏文件为空')
    const kp = pkg.generateSigningKeyPair()
    const ring = pkg.upsertKeyringKey({ schema: 1, keys: {} }, kp.keyId, kp.publicKeyBase64, 'self')
    pkg.writeKeyring(file, ring)
    assertEq(pkg.readKeyring(file).keys[kp.keyId].fingerprint, kp.fingerprint, '持久化指纹')
    return 'keyring ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-package.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
