// electron/main/fish/voice/external/localSecretStore.ts —— 本地实例独立密钥存储
//
// 本地实例可能连着用户自己的服务，Key 与火山云 Key 必须物理隔离。
// 这里复用 safeStorage 加密，但单独落 secrets.bin，绝不写进实例 JSON。

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import { isExternalServiceId } from './externalServiceStore'

export interface ExternalSecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type SecretData = Record<string, string>

function tailOf(value: string): string {
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`
}

export class ExternalVoiceSecretStore {
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly encryption: ExternalSecretEncryption
  ) {}

  private get available(): boolean {
    try {
      return this.encryption.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  canPersist(): boolean {
    return this.available
  }

  private async load(): Promise<SecretData> {
    if (!this.available) return {}
    try {
      const encrypted = await fs.readFile(this.filePath)
      const parsed = JSON.parse(this.encryption.decryptString(encrypted)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: SecretData = {}
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isExternalServiceId(id) && typeof value === 'string' && value) out[id] = value
      }
      return out
    } catch {
      return {}
    }
  }

  private async save(data: SecretData): Promise<void> {
    if (!this.available) {
      throw new VoiceError(
        VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
        '系统安全存储不可用，本地 TTS Key 无法持久化'
      )
    }
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const encrypted = this.encryption.encryptString(JSON.stringify(data))
    const tmp = `${this.filePath}.${process.pid}-${Date.now()}.tmp`
    await fs.writeFile(tmp, encrypted, { mode: 0o600 })
    await fs.rename(tmp, this.filePath)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutation.catch(() => undefined).then(fn)
    this.mutation = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async settle(): Promise<void> {
    await this.mutation.catch(() => undefined)
  }

  async get(id: unknown): Promise<string | null> {
    if (!isExternalServiceId(id)) return null
    await this.settle()
    return (await this.load())[id] ?? null
  }

  async set(id: unknown, value: unknown): Promise<{ hasKey: true; tail: string }> {
    return this.enqueue(async () => {
      if (!isExternalServiceId(id)) {
        throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '本地 TTS 实例 ID 不合法')
      }
      if (typeof value !== 'string') {
        throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, 'API Key 必须是字符串')
      }
      const key = value.trim()
      if (!key || key.length > 2048) {
        throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, 'API Key 格式不正确')
      }
      const data = await this.load()
      data[id] = key
      await this.save(data)
      return { hasKey: true as const, tail: tailOf(key) }
    })
  }

  async delete(id: unknown): Promise<void> {
    if (!isExternalServiceId(id)) return
    await this.enqueue(async () => {
      const data = await this.load()
      if (!data[id]) return
      delete data[id]
      await this.save(data)
    })
  }

  async status(id: unknown): Promise<{ hasKey: boolean; tail: string | null }> {
    await this.settle()
    const key = await this.get(id)
    return { hasKey: !!key, tail: key ? tailOf(key) : null }
  }
}

export function createExternalVoiceSecretStore(
  filePath: string,
  encryption: ExternalSecretEncryption
): ExternalVoiceSecretStore {
  return new ExternalVoiceSecretStore(filePath, encryption)
}
