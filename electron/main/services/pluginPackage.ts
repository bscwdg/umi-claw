// electron/main/services/pluginPackage.ts —— `.umi-plugin` 打包/签名/验签（C1）
//
// 只依赖 node:crypto + adm-zip；zip 元数据一律不信任：解包后按签名 files 逐项
// 哈希，文件集必须精确一致。签名原文复用 pluginPackageFormat，避免 CLI 与
// 宿主各写一套 canonical。

import AdmZip from 'adm-zip'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  assertFileSetComplete,
  canonicalSignaturePayload,
  fingerprintFromPublicKey,
  normalizeSignatureFiles,
  sha256Hex,
  validateSignatureShape,
  type PackageSignature,
  type SignatureFile
} from './pluginPackageFormat'

export interface PluginKeyring {
  schema: 1
  keys: Record<string, { publicKey: string; trust: 'official' | 'partner' | 'self'; fingerprint: string }>
}

export const EMPTY_KEYRING: PluginKeyring = { schema: 1, keys: {} }

export function generateSigningKeyPair(): {
  privateKeyPem: string
  publicKeyBase64: string
  fingerprint: string
  keyId: string
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const fingerprint = fingerprintFromPublicKey(spki)
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyBase64: spki.toString('base64'),
    fingerprint,
    keyId: `self-${fingerprint.slice(0, 16)}`
  }
}

function listPackageFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`PACKAGE_REPARSE_POINT:${full}`)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

export interface PackOptions {
  sourceDir: string
  outFile: string
  keyId: string
  privateKeyPem: string
  publicKeyBase64?: string
  createdAt?: string
}

export function packPlugin(options: PackOptions): PackageSignature {
  const paths = listPackageFiles(options.sourceDir).filter((path) => path !== 'SIGNATURE')
  if (!paths.includes('plugin.json') || !paths.includes('main.js')) {
    throw new Error('PACKAGE_REQUIRED_FILE_MISSING')
  }
  const files: SignatureFile[] = normalizeSignatureFiles(
    paths.map((path) => ({ path, sha256: sha256Hex(readFileSync(join(options.sourceDir, path))) }))
  )
  const signature: PackageSignature = {
    schema: 1,
    keyId: options.keyId,
    alg: 'ed25519',
    createdAt: options.createdAt ?? new Date().toISOString(),
    files,
    ...(options.publicKeyBase64 ? { publicKey: options.publicKeyBase64 } : {}),
    signature: ''
  }
  signature.signature = sign(
    null,
    Buffer.from(canonicalSignaturePayload(signature), 'utf8'),
    createPrivateKey(options.privateKeyPem)
  ).toString('base64')

  const zip = new AdmZip()
  for (const path of paths) zip.addFile(path, readFileSync(join(options.sourceDir, path)))
  zip.addFile('SIGNATURE', Buffer.from(JSON.stringify(signature, null, 2), 'utf8'))
  zip.writeZip(options.outFile)
  return signature
}

export interface VerifyOptions {
  keyring?: PluginKeyring
  /** self 包 TOFU：首次确认后传入已记录指纹；指纹变化必须拒绝 */
  tofuFingerprint?: string
  allowSelfSigned?: boolean
}

export type VerifyResult =
  | { ok: true; signature: PackageSignature; fingerprint: string; trust: 'official' | 'partner' | 'self' }
  | { ok: false; code: string; message: string }

export function verifyPluginPackage(file: string, options: VerifyOptions = {}): VerifyResult {
  let zip: AdmZip
  try {
    zip = new AdmZip(file)
  } catch (e) {
    return { ok: false, code: 'PACKAGE_INVALID_ZIP', message: (e as Error).message }
  }
  const entries = zip.getEntries()
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some((p) => p === '..')) {
      return { ok: false, code: 'PACKAGE_UNSAFE_PATH', message: name }
    }
    names.push(name)
  }
  const lower = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (lower.has(key)) return { ok: false, code: 'PACKAGE_DUPLICATE_ENTRY', message: name }
    lower.add(key)
  }
  const sigEntry = zip.getEntry('SIGNATURE')
  if (!sigEntry) return { ok: false, code: 'PACKAGE_SIGNATURE_MISSING', message: '缺少 SIGNATURE' }
  let parsed: unknown
  try {
    parsed = JSON.parse(sigEntry.getData().toString('utf8'))
  } catch {
    return { ok: false, code: 'PACKAGE_SIGNATURE_INVALID', message: 'SIGNATURE 不是 JSON' }
  }
  const shape = validateSignatureShape(parsed)
  if (!shape.ok) return { ok: false, code: 'PACKAGE_SIGNATURE_INVALID', message: shape.errors.join('; ') }

  const signature = shape.signature
  const keyring = options.keyring ?? EMPTY_KEYRING
  const known = keyring.keys[signature.keyId]
  let publicKeyBase64 = known?.publicKey
  let trust: 'official' | 'partner' | 'self' = known?.trust ?? 'self'
  if (!publicKeyBase64) {
    if (!signature.publicKey) return { ok: false, code: 'PACKAGE_KEY_UNKNOWN', message: signature.keyId }
    if (!options.allowSelfSigned) return { ok: false, code: 'PACKAGE_UNTRUSTED_KEY', message: signature.keyId }
    publicKeyBase64 = signature.publicKey
  }
  let spki: Buffer
  try {
    spki = Buffer.from(publicKeyBase64, 'base64')
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    const ok = verify(
      null,
      Buffer.from(canonicalSignaturePayload(signature), 'utf8'),
      key,
      Buffer.from(signature.signature, 'base64')
    )
    if (!ok) return { ok: false, code: 'PACKAGE_SIGNATURE_MISMATCH', message: '签名不匹配' }
  } catch (e) {
    return { ok: false, code: 'PACKAGE_SIGNATURE_INVALID', message: (e as Error).message }
  }
  const fingerprint = fingerprintFromPublicKey(spki)
  if (known && known.fingerprint !== fingerprint) {
    return { ok: false, code: 'PACKAGE_KEY_FINGERPRINT_MISMATCH', message: signature.keyId }
  }
  if (trust === 'self') {
    if (options.tofuFingerprint && options.tofuFingerprint !== fingerprint) {
      return { ok: false, code: 'PACKAGE_TOFU_MISMATCH', message: '自签指纹变化' }
    }
    if (!options.allowSelfSigned) return { ok: false, code: 'PACKAGE_UNTRUSTED_KEY', message: signature.keyId }
  }
  const complete = assertFileSetComplete(names, signature.files)
  if (!complete.ok) return { ok: false, code: 'PACKAGE_FILESET_MISMATCH', message: complete.errors.join('; ') }
  for (const expected of signature.files) {
    const actual = sha256Hex(zip.getEntry(expected.path)!.getData())
    if (actual !== expected.sha256) {
      return { ok: false, code: 'PACKAGE_HASH_MISMATCH', message: expected.path }
    }
  }
  return { ok: true, signature, fingerprint, trust }
}

/** 写入本地 keyring（仅 official/partner/self 已确认公钥）；原子替换由调用方负责 */
export function upsertKeyringKey(
  keyring: PluginKeyring,
  keyId: string,
  publicKeyBase64: string,
  trust: 'official' | 'partner' | 'self'
): PluginKeyring {
  const fingerprint = fingerprintFromPublicKey(Buffer.from(publicKeyBase64, 'base64'))
  return {
    schema: 1,
    keys: { ...keyring.keys, [keyId]: { publicKey: publicKeyBase64, trust, fingerprint } }
  }
}

export function readKeyring(file: string): PluginKeyring {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PluginKeyring
    if (parsed.schema === 1 && parsed.keys && typeof parsed.keys === 'object') return parsed
  } catch {
    // 坏文件 fail-closed 为空 keyring
  }
  return { ...EMPTY_KEYRING }
}

export function writeKeyring(file: string, keyring: PluginKeyring): void {
  writeFileSync(file, JSON.stringify(keyring, null, 2), 'utf8')
}

export function hashFile(file: string): string {
  return sha256Hex(readFileSync(file))
}

export { createHash }
