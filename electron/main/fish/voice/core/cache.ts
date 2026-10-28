import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'

const AUDIO_ID_RE = /^[a-f0-9]{64}\.(mp3|wav)$/

export interface CachedAudioFile {
  audioId: string
  path: string
  mime: string
  bytes: number
}

export function voiceCacheKey(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((v) => String(v ?? '')).join('|')).digest('hex')
}

export function voiceAudioId(hash: string, extension: 'mp3' | 'wav'): string {
  return `${hash}.${extension}`
}

export class VoiceAudioCache {
  private readonly root: string

  constructor(cacheDir: string) {
    this.root = resolve(cacheDir)
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
  }

  private pathOf(audioId: string): string {
    if (!AUDIO_ID_RE.test(audioId)) {
      throw new Error('非法音频 ID')
    }
    return join(this.root, audioId)
  }

  mimeOf(audioId: string): string {
    return audioId.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
  }

  async get(audioId: string): Promise<CachedAudioFile | null> {
    if (!AUDIO_ID_RE.test(audioId)) return null
    const path = this.pathOf(audioId)
    try {
      const stat = await fs.stat(path)
      if (!stat.isFile() || stat.size <= 0) return null
      const now = new Date()
      await fs.utimes(path, now, now).catch(() => undefined)
      return { audioId, path, mime: this.mimeOf(audioId), bytes: stat.size }
    } catch {
      return null
    }
  }

  async read(audioId: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
    const found = await this.get(audioId)
    if (!found) return null
    const buffer = await fs.readFile(found.path)
    return { mime: found.mime, bytes: new Uint8Array(buffer) }
  }

  async put(
    hash: string,
    extension: 'mp3' | 'wav',
    data: Buffer
  ): Promise<CachedAudioFile> {
    await this.ensureReady()
    const audioId = voiceAudioId(hash, extension)
    const target = this.pathOf(audioId)
    const tmp = `${target}.${process.pid}-${Date.now()}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, target)
    return { audioId, path: target, mime: this.mimeOf(audioId), bytes: data.length }
  }

  async clear(): Promise<number> {
    await this.ensureReady()
    let freed = 0
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mp3|wav|tmp)$/.test(entry.name)) continue
      const file = join(this.root, entry.name)
      try {
        const stat = await fs.stat(file)
        freed += stat.size
        await fs.unlink(file)
      } catch {
        // 并发播放/写入时尽力清理，不把单个文件失败升级成整体失败
      }
    }
    return freed
  }

  async cleanup(maxBytes: number): Promise<number> {
    await this.ensureReady()
    const files: Array<{ path: string; size: number; mtimeMs: number }> = []
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mp3|wav)$/.test(entry.name)) continue
      const path = join(this.root, entry.name)
      try {
        const stat = await fs.stat(path)
        files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // 文件可能刚被另一个任务清理
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total <= maxBytes) return 0
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let freed = 0
    for (const file of files) {
      if (total <= maxBytes) break
      try {
        await fs.unlink(file.path)
        total -= file.size
        freed += file.size
      } catch {
        // 忽略并发删除
      }
    }
    return freed
  }
}
