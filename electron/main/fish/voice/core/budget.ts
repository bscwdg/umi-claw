import { VOICE_ERROR_CODES, VoiceError } from './errors'
import type { VoiceStorage } from './storage'
import type { VoiceUsageDay } from './types'

const USAGE_PREFIX = 'voice:v1:usage:'

export function localDateString(ts = Date.now()): string {
  const date = new Date(ts)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function emptyUsage(date: string): VoiceUsageDay {
  return { date, chars: 0, requests: 0, failures: 0, usageTokens: 0 }
}

function usageTokensOf(usage: Record<string, unknown> | null | undefined): number {
  if (!usage) return 0
  const candidates = [usage.total_tokens, usage.tokens, usage.text_words, usage.char_count]
  for (const value of candidates) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return 0
}

export class VoiceBudget {
  constructor(
    private readonly storage: VoiceStorage,
    private readonly now: () => number = () => Date.now()
  ) {}

  async get(date = localDateString(this.now())): Promise<VoiceUsageDay> {
    const raw = await this.storage.get(`${USAGE_PREFIX}${date}`)
    if (!raw) return emptyUsage(date)
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceUsageDay>
      return {
        date,
        chars: Math.max(0, Math.floor(Number(parsed.chars) || 0)),
        requests: Math.max(0, Math.floor(Number(parsed.requests) || 0)),
        failures: Math.max(0, Math.floor(Number(parsed.failures) || 0)),
        usageTokens: Math.max(0, Math.floor(Number(parsed.usageTokens) || 0))
      }
    } catch {
      return emptyUsage(date)
    }
  }

  async check(limit: number, chars: number): Promise<void> {
    if (limit <= 0) return
    const current = await this.get()
    if (current.chars + chars > limit) {
      throw new VoiceError(
        VOICE_ERROR_CODES.BUDGET_EXCEEDED,
        `今日语音字符额度不足：已用 ${current.chars}，本次 ${chars}，上限 ${limit}`,
        { used: current.chars, requested: chars, limit }
      )
    }
  }

  async recordSuccess(
    chars: number,
    usage?: Record<string, unknown> | null
  ): Promise<VoiceUsageDay> {
    const date = localDateString(this.now())
    const current = await this.get(date)
    const next: VoiceUsageDay = {
      ...current,
      chars: current.chars + Math.max(0, Math.floor(chars)),
      requests: current.requests + 1,
      usageTokens: current.usageTokens + usageTokensOf(usage)
    }
    await this.storage.set(`${USAGE_PREFIX}${date}`, JSON.stringify(next))
    return next
  }

  async recordFailure(): Promise<VoiceUsageDay> {
    const date = localDateString(this.now())
    const current = await this.get(date)
    const next: VoiceUsageDay = { ...current, failures: current.failures + 1 }
    await this.storage.set(`${USAGE_PREFIX}${date}`, JSON.stringify(next))
    return next
  }
}
