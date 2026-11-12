// electron/main/fish/voice/external/externalServiceStore.ts —— 本地 TTS 实例 JSON 存储
//
// 实例文件只保存连接参数，不保存 Key。坏文件按历史 jsonStore 的做法备份后重建，
// 避免一个损坏实例让整张语音页打不开。

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import { normalizeExternalBaseUrl, normalizeProfilesPath } from './openaiSpeech'
import type {
  ExternalTtsFormat,
  ExternalTtsService,
  ExternalTtsServiceInput
} from './types'

const EXTERNAL_ID_RE = /^ext:[a-f0-9-]{36}$/

type FetchFile = { version: number; services: ExternalTtsService[] }

function invalid(message: string): VoiceError {
  return new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, message)
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalid(`${label}必须是字符串`)
  const out = value.trim()
  if (!out) throw invalid(`${label}不能为空`)
  if (out.length > maxLength) throw invalid(`${label}过长（上限 ${maxLength} 字符）`)
  return out
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return text(value, label, maxLength)
}

function formatOf(value: unknown): ExternalTtsFormat {
  if (value === undefined) return 'mp3'
  if (value === 'mp3' || value === 'wav') return value
  throw invalid('响应格式只支持 mp3 或 wav')
}

function profilesPathOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return normalizeProfilesPath(value) || undefined
}

export function isExternalServiceId(value: unknown): value is string {
  return typeof value === 'string' && EXTERNAL_ID_RE.test(value)
}

function validateService(value: unknown): ExternalTtsService {
  const src = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (!isExternalServiceId(src.id)) throw invalid('本地 TTS 实例 ID 不合法')
  if (src.kind !== 'openai-speech') throw invalid('本地 TTS 协议不合法')
  return {
    id: src.id,
    kind: 'openai-speech',
    label: text(src.label, '实例名称', 80),
    baseUrl: normalizeExternalBaseUrl(src.baseUrl),
    model: text(src.model, '模型名', 256),
    voice: text(src.voice, '音色', 256),
    responseFormat: formatOf(src.responseFormat),
    ...(typeof src.profilesPath === 'string' && src.profilesPath
      ? { profilesPath: normalizeProfilesPath(src.profilesPath) }
      : {}),
    createdAt:
      typeof src.createdAt === 'number' && Number.isFinite(src.createdAt)
        ? src.createdAt
        : Date.now(),
    updatedAt:
      typeof src.updatedAt === 'number' && Number.isFinite(src.updatedAt)
        ? src.updatedAt
        : Date.now()
  }
}

export class ExternalServiceStore {
  private cache: ExternalTtsService[] | null = null
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async read(): Promise<ExternalTtsService[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<FetchFile> | null
      const services = Array.isArray(parsed?.services)
        ? parsed.services.flatMap((item) => {
            try {
              return [validateService(item)]
            } catch {
              return []
            }
          })
        : []
      this.cache = services
    } catch {
      try {
        await fs.stat(this.filePath)
        await fs
          .rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`)
          .catch(() => undefined)
      } catch {
        // 文件本就不存在
      }
      this.cache = []
    }
    return this.cache
  }

  private async flush(services: ExternalTtsService[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}-${this.now()}.tmp`
    const payload: FetchFile = { version: 1, services }
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
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

  async list(): Promise<ExternalTtsService[]> {
    await this.settle()
    return [...(await this.read())].sort((a, b) => a.createdAt - b.createdAt)
  }

  async get(id: unknown): Promise<ExternalTtsService | null> {
    if (!isExternalServiceId(id)) return null
    await this.settle()
    return (await this.read()).find((item) => item.id === id) ?? null
  }

  async save(input: ExternalTtsServiceInput): Promise<ExternalTtsService> {
    return this.enqueue(async () => {
      const services = [...(await this.read())]
      const id = input.id === undefined ? `ext:${randomUUID()}` : input.id
      if (!isExternalServiceId(id)) throw invalid('本地 TTS 实例 ID 不合法')
      const index = services.findIndex((item) => item.id === id)
      const current = index >= 0 ? services[index] : null
      if (input.id !== undefined && !current) throw invalid('本地 TTS 实例不存在')
      const timestamp = this.now()
      let nextProfilesPath = {}
      if (input.profilesPath === undefined) {
        if (current?.profilesPath) nextProfilesPath = { profilesPath: current.profilesPath }
      } else {
        const normalizedProfilesPath = profilesPathOf(input.profilesPath)
        if (normalizedProfilesPath) nextProfilesPath = { profilesPath: normalizedProfilesPath }
      }
      const next: ExternalTtsService = {
        id,
        kind: 'openai-speech',
        label: optionalText(input.label, '实例名称', 80) ?? current?.label ?? '',
        baseUrl: normalizeExternalBaseUrl(
          input.baseUrl === undefined ? current?.baseUrl : input.baseUrl
        ),
        model: optionalText(input.model, '模型名', 256) ?? current?.model ?? '',
        voice: optionalText(input.voice, '音色', 256) ?? current?.voice ?? '',
        responseFormat:
          input.responseFormat === undefined
            ? current?.responseFormat ?? 'mp3'
            : formatOf(input.responseFormat),
        ...nextProfilesPath,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      // optionalText 的“保持原值”会绕过 required 校验；统一再过一次完整校验。
      const validated = validateService(next)
      if (index >= 0) services[index] = validated
      else services.push(validated)
      await this.flush(services)
      this.cache = services
      return validated
    })
  }

  async remove(id: unknown): Promise<boolean> {
    if (!isExternalServiceId(id)) return false
    return this.enqueue(async () => {
      const services = await this.read()
      const next = services.filter((item) => item.id !== id)
      if (next.length === services.length) return false
      await this.flush(next)
      this.cache = next
      return true
    })
  }
}

export function createExternalServiceStore(
  filePath: string,
  now?: () => number
): ExternalServiceStore {
  return new ExternalServiceStore(filePath, now)
}
