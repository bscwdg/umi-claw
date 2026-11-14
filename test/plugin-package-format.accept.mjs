// test/plugin-package-format.accept.mjs —— Phase 2 P0：`.umi-plugin` 签名契约 golden vector
//
// 只测纯函数：C1 的 pack/sign/verify 都必须复用这些函数；golden 字符串一旦改动
// 就是包格式破坏性变更。

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, bundleEntry, assert, assertEq, printResult, writeJson, __dirname } from './_lib.mjs'

const r = new Recorder('Phase 2 · 包格式/签名契约（P0）')
const fmt = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPackageFormat.ts', 'pkg-format.mjs')).href
)

const sha = (s) => createHash('sha256').update(s).digest('hex')
const sig = {
  schema: 1,
  keyId: 'official-2026',
  alg: 'ed25519',
  createdAt: '2026-11-14T00:00:00.000Z',
  files: [
    { path: 'main.js', sha256: sha('main') },
    { path: 'plugin.json', sha256: sha('{}') }
  ],
  signature: 'BASE64'
}

await r.check('F1', 'canonical 签名原文：固定字段顺序、无空白、files 升序（golden）', async () => {
  const canonical = fmt.canonicalSignaturePayload(sig)
  const expected =
    '{"schema":1,"keyId":"official-2026","alg":"ed25519","createdAt":"2026-11-14T00:00:00.000Z","files":[{"path":"main.js","sha256":"' +
    sha('main') +
    '"},{"path":"plugin.json","sha256":"' +
    sha('{}') +
    '"}]}'
  assertEq(canonical, expected, 'golden 不一致即包格式破坏')
  assert(!canonical.includes('\n'), '无换行')
})

await r.check('F2', 'files 规范化：排序、重复 path、大小写折叠、反斜杠/绝对/.. 拒绝', async () => {
  const sorted = fmt.normalizeSignatureFiles([
    { path: 'b.js', sha256: sha('b') },
    { path: 'a.js', sha256: sha('a') }
  ])
  assertEq(sorted.map((f) => f.path).join(','), 'a.js,b.js', '按 path 升序')
  const bad = [
    [{ path: 'a.js', sha256: sha('a') }, { path: 'a.js', sha256: sha('b') }],
    [{ path: 'A.js', sha256: sha('a') }, { path: 'a.js', sha256: sha('b') }],
    [{ path: '..\\a.js', sha256: sha('a') }],
    [{ path: '/a.js', sha256: sha('a') }],
    [{ path: 'a/../b.js', sha256: sha('a') }]
  ]
  for (const files of bad) {
    let err = null
    try {
      fmt.normalizeSignatureFiles(files)
    } catch (e) {
      err = e
    }
    assert(err, `应拒绝：${JSON.stringify(files)}`)
  }
  return '路径规范化 ✓'
})

await r.check('F3', '结构校验：schema/alg/createdAt/sha256/files 空/未排序 fail-closed', async () => {
  assertEq(fmt.validateSignatureShape(sig).ok, true, '合法签名')
  const cases = [
    { ...sig, schema: 2 },
    { ...sig, alg: 'rsa' },
    { ...sig, createdAt: '2026-11-14 00:00:00' },
    { ...sig, files: [] },
    { ...sig, files: [{ path: '../x', sha256: sha('x') }] },
    { ...sig, files: [{ path: 'a.js', sha256: 'ABC' }] },
    { ...sig, files: [...sig.files].reverse() }
  ]
  for (const item of cases) {
    assertEq(fmt.validateSignatureShape(item).ok, false, `应拒绝：${JSON.stringify(item).slice(0, 80)}`)
  }
  return '结构校验 ✓'
})

await r.check('F4', '文件集精确一致：zip 多一个未签名文件也拒绝', async () => {
  assertEq(fmt.assertFileSetComplete(['main.js', 'plugin.json', 'SIGNATURE'], sig.files).ok, true, '精确匹配')
  const extra = fmt.assertFileSetComplete(['main.js', 'plugin.json', 'extra.js'], sig.files)
  assertEq(extra.ok, false, '多文件拒绝')
  const missing = fmt.assertFileSetComplete(['main.js'], sig.files)
  assertEq(missing.ok, false, '少文件拒绝')
  return '文件集精确 ✓'
})

await r.check('F5', 'sha256/fingerprint：小写 hex，指纹=sha256(SPKI DER)', async () => {
  assertEq(fmt.sha256Hex('abc'), sha('abc'), 'sha256')
  const der = Buffer.from([1, 2, 3, 4])
  assertEq(fmt.fingerprintFromPublicKey(der), sha(der), 'fingerprint')
  assert(/^[a-f0-9]{64}$/.test(fmt.fingerprintFromPublicKey(der)), '小写 hex')
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-package-format.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
