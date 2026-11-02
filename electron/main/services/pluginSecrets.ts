// electron/main/services/pluginSecrets.ts —— 按插件命名空间的密钥存储（WP4 C4.1）
//
// 兑现 PLAN-4.0 §8.2：safeStorage 按 `plugin:<id>:<key>` 加密，插件只能看到自己的。
//
// 为什么不复用 VoiceSecretStore：那个类把字段写死在 tts/clone 两个 key 上，
// 且文件路径固定为语音目录。这里是通用命名空间存储，一个插件一个文件：
//   <dataDir>/plugins/<id>/secrets.bin
//
// 安全约束（与 §8.2 一致）：
//   - 只走 safeStorage 加解密，明文永不落盘
//   - 加密不可用时拒绝写入（不静默降级成明文）
//   - 值不进日志：对外只暴露 key 列表与「是否已设置」

import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface PluginSecretsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  clear(key: string): Promise<void>
  /** 已设置的 key 列表（不返回值本体） */
  keys(): Promise<string[]>
  /** 当前环境是否支持加密（false 时 set 会抛错） */
  available(): boolean
}

type SecretMap = Record<string, string>

export class PluginSecretStore implements PluginSecretsApi {
  constructor(
    private readonly filePath: string,
    private readonly encryption: SecretEncryption
  ) {}

  available(): boolean {
    try {
      return this.encryption.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private async load(): Promise<SecretMap> {
    if (!this.available()) return {}
    try {
      const encrypted = await fsp.readFile(this.filePath)
      const plain = this.encryption.decryptString(encrypted)
      const parsed = JSON.parse(plain) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      const out: SecretMap = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch {
      // 文件不存在 / 损坏：当作空，不抛（避免插件因坏文件而无法启动）
      return {}
    }
  }

  private async save(map: SecretMap): Promise<void> {
    const plain = JSON.stringify(map)
    const encrypted = this.encryption.encryptString(plain)
    await fsp.mkdir(dirname(this.filePath), { recursive: true })
    // 先写临时文件再 rename，避免半截文件
    const tmp = this.filePath + '.tmp'
    await fsp.writeFile(tmp, encrypted)
    await fsp.rename(tmp, this.filePath)
  }

  async get(key: string): Promise<string | null> {
    const map = await this.load()
    const value = map[key]
    return typeof value === 'string' ? value : null
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.available()) {
      throw new Error('当前环境不支持安全存储（safeStorage 不可用），拒绝写入凭证')
    }
    const map = await this.load()
    map[key] = value
    await this.save(map)
  }

  async clear(key: string): Promise<void> {
    const map = await this.load()
    if (!(key in map)) return
    delete map[key]
    await this.save(map)
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.load()).sort()
  }
}
