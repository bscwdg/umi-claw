// electron/main/fish/voice/external/availability.ts —— 外部实例失败冷却（纯内存）
//
// 只由真实 synth 结果驱动：probe 只用于设置页展示，不参与路由。
// 进程重启后清空，宁可多试一次，也不持久化可能已恢复的“不可用”状态。

const FAILURE_THRESHOLD = 2
const COOLDOWN_MS = 30_000

interface AvailabilityState {
  failures: number
  cooldownUntil: number
}

export interface ExternalAvailabilitySnapshot {
  available: boolean
  cooldownUntil: number | null
  consecutiveFailures: number
}

export class ExternalAvailabilityTracker {
  private readonly states = new Map<string, AvailabilityState>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  snapshot(id: string): ExternalAvailabilitySnapshot {
    const current = this.states.get(id)
    if (!current) {
      return { available: true, cooldownUntil: null, consecutiveFailures: 0 }
    }
    const now = this.now()
    const inCooldown = current.cooldownUntil > 0 && now < current.cooldownUntil
    if (!inCooldown && current.cooldownUntil > 0) {
      current.failures = 0
      current.cooldownUntil = 0
    }
    return {
      available: !inCooldown,
      cooldownUntil: inCooldown ? current.cooldownUntil : null,
      consecutiveFailures: current.failures
    }
  }

  isAvailable(id: string): boolean {
    return this.snapshot(id).available
  }

  recordSuccess(id: string): void {
    this.states.delete(id)
  }

  recordFailure(id: string): ExternalAvailabilitySnapshot {
    const current = this.states.get(id) ?? { failures: 0, cooldownUntil: 0 }
    current.failures += 1
    if (current.failures >= FAILURE_THRESHOLD) {
      current.cooldownUntil = this.now() + COOLDOWN_MS
    }
    this.states.set(id, current)
    return this.snapshot(id)
  }
}

export function createExternalAvailabilityTracker(
  now?: () => number
): ExternalAvailabilityTracker {
  return new ExternalAvailabilityTracker(now)
}

export const EXTERNAL_FAILURE_THRESHOLD = FAILURE_THRESHOLD
export const EXTERNAL_COOLDOWN_MS = COOLDOWN_MS
