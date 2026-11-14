// electron/main/services/pluginPackageFormat.ts —— `.umi-plugin` 包格式与签名的可执行契约
//
// P0 冻结的签名原文不能只写在文档里：C1 的 pack/sign/verify 必须共用这里，
// 否则「按 path 升序 + 固定字段顺序」会出现两套实现。本模块只做纯函数，
// 不读盘、不碰 Electron；zip 解包由 C1 负责，调用前先做文件集校验。

import { createHash } from 'node:crypto'

export interface SignatureFile {
  path: string
  sha256: string
}

export interface PackageSignature {
  schema: 1
  keyId: string
  alg: 'ed25519'
  createdAt: string
  files: SignatureFile[]
  publicKey?: string
  signature: string
}

const HEX64 = /^[a-f0-9]{64}$/
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** 文件路径只允许 zip 内相对 POSIX 路径；反斜杠/绝对路径/.. 一律拒绝 */
export function normalizeSignaturePath(path: string): string | null {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return path
}

/** files 必须按 path 升序；重复/大小写折叠冲突都拒绝（Windows 大小写不敏感） */
export function normalizeSignatureFiles(files: SignatureFile[]): SignatureFile[] {
  const normalized = files.map((file) => ({ path: normalizeSignaturePath(file.path), sha256: file.sha256 }))
  if (normalized.some((file) => file.path === null)) throw new Error('SIGNATURE_INVALID_PATH')
  const seen = new Set<string>()
  const seenLower = new Set<string>()
  for (const file of normalized) {
    if (seen.has(file.path!)) throw new Error('SIGNATURE_DUPLICATE_PATH')
    if (seenLower.has(file.path!.toLowerCase())) throw new Error('SIGNATURE_CASE_COLLISION')
    seen.add(file.path!)
    seenLower.add(file.path!.toLowerCase())
  }
  return normalized.sort((a, b) => (a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0)) as SignatureFile[]
}

/** 签名原文：固定字段顺序 + files 升序 + 无空白；C1/CLI/verify 共用 */
export function canonicalSignaturePayload(signature: PackageSignature): string {
  return JSON.stringify({
    schema: signature.schema,
    keyId: signature.keyId,
    alg: signature.alg,
    createdAt: signature.createdAt,
    files: signature.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
  })
}

/** 结构校验：C1 在验签前先跑，避免把畸形 JSON 当签名原文 */
export function validateSignatureShape(input: unknown): { ok: true; signature: PackageSignature } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['不是对象'] }
  const sig = input as Partial<PackageSignature>
  if (sig.schema !== 1) errors.push('schema 必须为 1')
  if (typeof sig.keyId !== 'string' || !sig.keyId.trim()) errors.push('keyId 为空')
  if (sig.alg !== 'ed25519') errors.push('alg 必须为 ed25519')
  if (typeof sig.createdAt !== 'string' || !UTC_ISO.test(sig.createdAt)) errors.push('createdAt 必须为 UTC ISO-8601 毫秒')
  if (typeof sig.signature !== 'string' || !sig.signature) errors.push('signature 为空')
  if (sig.publicKey !== undefined && typeof sig.publicKey !== 'string') errors.push('publicKey 必须为 base64 字符串')
  if (!Array.isArray(sig.files) || sig.files.length === 0) errors.push('files 为空')
  if (Array.isArray(sig.files)) {
    for (const file of sig.files) {
      if (!file || typeof file.path !== 'string' || !HEX64.test(file.sha256)) {
        errors.push(`files 项非法：${JSON.stringify(file)}`)
        continue
      }
      if (!normalizeSignaturePath(file.path)) errors.push(`路径非法：${file.path}`)
    }
    try {
      const sorted = normalizeSignatureFiles(sig.files)
      const original = sig.files.map((file) => file.path)
      if (sorted.some((file, index) => file.path !== original[index])) errors.push('files 未按 path 升序')
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, signature: sig as PackageSignature }
}

/** 解包后文件集必须与签名 files 精确一致：多一个/少一个都不行 */
export function assertFileSetComplete(
  actualPaths: string[],
  files: SignatureFile[]
): { ok: true } | { ok: false; errors: string[] } {
  const actual = new Set(actualPaths.filter((path) => path !== 'SIGNATURE'))
  const signed = new Set(files.map((file) => file.path))
  const errors: string[] = []
  for (const path of signed) if (!actual.has(path)) errors.push(`缺少签名文件：${path}`)
  for (const path of actual) if (!signed.has(path)) errors.push(`未签名文件：${path}`)
  return errors.length ? { ok: false, errors } : { ok: true }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** TOFU 指纹：sha256(SPKI DER) 小写 hex（P0 冻结定义） */
export function fingerprintFromPublicKey(spkiDer: Buffer): string {
  return sha256Hex(spkiDer)
}
