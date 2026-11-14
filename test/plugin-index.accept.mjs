// test/plugin-index.accept.mjs —— Phase 2 C4：静态签名索引
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Recorder, bundleEntry, assert, assertEq, printResult, writeJson, __dirname } from './_lib.mjs'
import { join } from 'node:path'

const fingerprintFromPublicKey = (der) => createHash('sha256').update(der).digest('hex')

const r = new Recorder('Phase 2 · 静态签名索引（C4）')
const mod = await import(pathToFileURL(bundleEntry('electron/main/services/pluginIndex.ts', 'index-c4.mjs')).href)

const keypair = generateKeyPairSync('ed25519')
const spki = keypair.publicKey.export({ format: 'der', type: 'spki' })
const publicKey = spki.toString('base64')
const fingerprint = fingerprintFromPublicKey(spki)
const keyId = 'official-test'
const keyring = { schema: 1, keys: { [keyId]: { publicKey, trust: 'official', fingerprint } } }

const index = {
  schema: 1,
  generatedAt: '2026-11-14T00:00:00.000Z',
  entries: [
    { id: 'demo', version: '1.1.0', url: 'https://example.invalid/demo-1.1.0.umi-plugin', sha256: 'a'.repeat(64) },
    { id: 'demo', version: '1.0.0', url: 'https://example.invalid/demo-1.0.0.umi-plugin', sha256: 'b'.repeat(64) }
  ]
}
const signEnvelope = (idx) => ({
  index: idx,
  keyId,
  alg: 'ed25519',
  signature: sign(
    null,
    Buffer.from(mod.canonicalIndexPayload(idx), 'utf8'),
    createPrivateKey(keypair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  ).toString('base64')
})

await r.check('C4-1', '合法索引：canonical 排序后验签通过', async () => {
  const res = mod.verifyPluginIndex(signEnvelope(index), keyring)
  assertEq(res.ok, true, JSON.stringify(res))
  assertEq(res.index.entries.length, 2, 'entries')
  return '索引验签 ✓'
})

await r.check('C4-2', '篡改 entries / 未知 key / 坏签名均拒绝', async () => {
  const env = signEnvelope(index)
  const tampered = { ...env, index: { ...index, entries: [...index.entries, { id: 'x', version: '1.0.0', url: 'u', sha256: 'c'.repeat(64) }] } }
  assertEq(mod.verifyPluginIndex(tampered, keyring).code, 'INDEX_SIGNATURE_MISMATCH', '篡改拒绝')
  assertEq(mod.verifyPluginIndex(env, { schema: 1, keys: {} }).code, 'INDEX_KEY_UNKNOWN', '未知 key')
  assertEq(mod.verifyPluginIndex({ ...env, signature: 'AAAA' }, keyring).code, 'INDEX_SIGNATURE_MISMATCH', '坏签名')
  return '索引拒绝 ✓'
})

await r.check('C4-3', 'schema/entry 校验：非法 sha256/缺字段拒绝', async () => {
  const bad = { ...index, entries: [{ id: 'demo', version: '1.0.0', url: 'u', sha256: 'ZZZ' }] }
  const res = mod.verifyPluginIndex(signEnvelope(bad), keyring)
  assertEq(res.ok, false, '非法 entry')
  return '索引 schema ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-index.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
