import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { VoiceStorage } from './storage'

type VoiceJson = Record<string, string>

/**
 * 1.0 用的单文件 JSON 存储：键值全放在 userData/fish/voice.json。
 * - 原子写（tmp + rename）
 * - 读坏文件时备份为 .corrupt-<ts>，随后按空档案重建
 * - 写操作串行，避免并发覆盖
 */
export function createJsonVoiceStorage(filePath: string): VoiceStorage {
  let cache: VoiceJson | null = null
  let writing: Promise<void> = Promise.resolve()

  async function read(): Promise<VoiceJson> {
    if (cache) return cache
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      cache =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as VoiceJson)
          : {}
    } catch {
      // 文件不存在按空档案处理；存在但解析失败则备份后重建
      try {
        await fs.stat(filePath)
        await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => undefined)
      } catch {
        // 文件本就不存在
      }
      cache = {}
    }
    return cache
  }

  async function flush(data: VoiceJson): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}-${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fs.rename(tmp, filePath)
  }

  return {
    async get(key: string): Promise<string | null> {
      const data = await read()
      return typeof data[key] === 'string' ? data[key] : null
    },
    async set(key: string, value: string | null): Promise<void> {
      const data = await read()
      const next: VoiceJson = { ...data }
      if (value === null) delete next[key]
      else next[key] = value
      cache = next
      writing = writing.then(() => flush(next)).catch(() => undefined)
      await writing
    }
  }
}
