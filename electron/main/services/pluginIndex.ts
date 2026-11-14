// electron/main/services/pluginIndex.ts —— C4 静态签名索引（官方/伙伴）
//
// 索引只读、不联网：官方/伙伴签名 JSON 随包或手动导入，验签后才展示可安装版本。
// 索引 schema 与签名原文固定，避免 C4/C6 各写一套。

import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PluginKeyring } from './pluginPackage'

export interface PluginIndexEntry {
  id: string
  version: string
  url: string
  sha256: string
  size?: number
}

export interface PluginIndex {
  schema: 1
  generatedAt: string
  entries: PluginIndexEntry[]
}

export interface PluginIndexEnvelope {
  index: PluginIndex
  keyId: string
  alg: 'ed25519'
  signature: string
}

export function canonicalIndexPayload(index: PluginIndex): string {
  return JSON.stringify({
    schema: index.schema,
    generatedAt: index.generatedAt,
    entries: [...index.entries].sort((a, b) => (a.id + '@' + a.version < b.id + '@' + b.version ? -1 : 1))
  })
}

export function verifyPluginIndex(
  envelope: PluginIndexEnvelope,
  keyring: PluginKeyring
): { ok: true; index: PluginIndex } | { ok: false; code: string; message: string } {
  if ((envelope as unknown as { schema?: unknown }).schema !== undefined) {
    return { ok: false, code: 'INDEX_INVALID', message: '多余 schema 字段' }
  }
  if (envelope.alg !== 'ed25519') return { ok: false, code: 'INDEX_INVALID', message: 'alg' }
  const key = keyring.keys[envelope.keyId]
  if (!key) return { ok: false, code: 'INDEX_KEY_UNKNOWN', message: envelope.keyId }
  const index = envelope.index
  if (!index || index.schema !== 1 || !Array.isArray(index.entries)) {
    return { ok: false, code: 'INDEX_INVALID', message: 'schema/entries' }
  }
  for (const entry of index.entries) {
    if (!entry.id || !entry.version || !entry.url || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      return { ok: false, code: 'INDEX_INVALID', message: JSON.stringify(entry) }
    }
  }
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' })
    const ok = verify(
      null,
      Buffer.from(canonicalIndexPayload(index), 'utf8'),
      publicKey,
      Buffer.from(envelope.signature, 'base64')
    )
    if (!ok) return { ok: false, code: 'INDEX_SIGNATURE_MISMATCH', message: '签名不匹配' }
  } catch (e) {
    return { ok: false, code: 'INDEX_INVALID', message: (e as Error).message }
  }
  return { ok: true, index }
}

export function readPluginIndex(file: string): PluginIndexEnvelope | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PluginIndexEnvelope
  } catch {
    return null
  }
}
