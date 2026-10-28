import { promises as fs } from 'fs'
import { dirname } from 'path'
import { VOICE_ERROR_CODES, VoiceError } from './core/errors'
import { isVoiceKeyKind } from './core/settings'
import type { VoiceKeyKind, VoiceKeyStatus } from './core/types'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface SecretData {
  tts?: string
  clone?: string
}

function tailOf(value: string): string {
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`
}

export class VoiceSecretStore {
  constructor(
    private readonly filePath: string,
    private readonly encryption: SecretEncryption
  ) {}

  private get available(): boolean {
    try {
      return this.encryption.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private async load(): Promise<SecretData> {
    if (!this.available) return {}
    try {
      const encrypted = await fs.readFile(this.filePath)
      const plaintext = this.encryption.decryptString(encrypted)
      const parsed = JSON.parse(plaintext) as SecretData
      return {
        tts: typeof parsed.tts === 'string' && parsed.tts ? parsed.tts : undefined,
        clone: typeof parsed.clone === 'string' && parsed.clone ? parsed.clone : undefined
      }
    } catch {
      return {}
    }
  }

  private async save(data: SecretData): Promise<void> {
    if (!this.available) {
      throw new VoiceError(
        VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
        '系统安全存储不可用，密钥无法持久化'
      )
    }
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const encrypted = this.encryption.encryptString(JSON.stringify(data))
    const tmp = `${this.filePath}.${process.pid}-${Date.now()}.tmp`
    await fs.writeFile(tmp, encrypted, { mode: 0o600 })
    await fs.rename(tmp, this.filePath)
  }

  async get(kind: VoiceKeyKind): Promise<string | null> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    const data = await this.load()
    return kind === 'tts' ? data.tts ?? null : data.clone ?? null
  }

  async set(kind: VoiceKeyKind, value: string): Promise<VoiceKeyStatus> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    const key = value.trim()
    if (!key || key.length < 8 || key.length > 2048) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, 'API Key 格式不正确')
    }
    const data = await this.load()
    data[kind] = key
    await this.save(data)
    return { hasKey: true, tail: tailOf(key) }
  }

  async clear(kind: VoiceKeyKind): Promise<VoiceKeyStatus> {
    if (!isVoiceKeyKind(kind)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法密钥类型')
    }
    const data = await this.load()
    delete data[kind]
    await this.save(data)
    return { hasKey: false, tail: null }
  }

  async status(): Promise<{
    encryptionAvailable: boolean
    tts: VoiceKeyStatus
    clone: VoiceKeyStatus
  }> {
    const encryptionAvailable = this.available
    const data = await this.load()
    return {
      encryptionAvailable,
      tts: { hasKey: !!data.tts, tail: data.tts ? tailOf(data.tts) : null },
      clone: { hasKey: !!data.clone, tail: data.clone ? tailOf(data.clone) : null }
    }
  }
}
