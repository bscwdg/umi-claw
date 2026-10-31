// electron/main/character/manager.ts —— CharacterManager：生命周期 / 状态 / 设置 / 交互
//
// 纯 Node（不 import electron），便于接受验收脚本直接打真源码。
// 失败只降级自身：init 抛错由 wiring 捕获并记录，不影响宿主启动。

import {
  CHARACTER_ERROR_CODES,
  CharacterError,
  createDefaultCharacterState,
  mergeCharacterSettings,
  type CharacterEvent,
  type CharacterInteractInput,
  type CharacterResetOptions,
  type CharacterSettings,
  type CharacterState,
  type CharacterStatus
} from './types'
import type { CharacterStore } from './store'

export interface CharacterManagerOptions {
  store: CharacterStore
  now?: () => number
  logger?: (message: string) => void
  onEvent?: (event: CharacterEvent) => void
}

const FAMILIARITY_CAP = 100
const INTIMACY_CAP = 100

export class CharacterManager {
  private readonly store: CharacterStore
  private readonly now: () => number
  private readonly logger: (message: string) => void
  private readonly onEvent?: (event: CharacterEvent) => void

  private settings: CharacterSettings | null = null
  private state: CharacterState | null = null
  private initialized = false
  private dependencyStatus: Omit<
    CharacterStatus,
    'enabled' | 'ready' | 'storeReady'
  > = {
    agentReady: false,
    gatewayReady: false,
    obsidianReady: false,
    qqReady: false,
    ttsReady: false,
    sttReady: false,
    memorySearchReady: false
  }

  constructor(options: CharacterManagerOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? (() => undefined)
    this.onEvent = options.onEvent
  }

  async init(): Promise<void> {
    if (this.initialized) return
    const existingSettings = await this.store.readSettings()
    this.settings = existingSettings
    this.state = await this.store.readState()
    // 首启落一份默认值，避免每次读到「不存在」都重新推导
    await this.store.writeSettings(existingSettings)
    await this.store.writeState(this.state)
    await this.store.prune()
    this.initialized = true
    this.logger(`[character] 初始化完成（enabled=${existingSettings.enabled}）`)
  }

  /** C02/C08 完成后由 wiring 回填依赖就绪态 */
  setDependencyStatus(patch: Partial<CharacterStatus>): void {
    this.dependencyStatus = {
      ...this.dependencyStatus,
      agentReady:
        typeof patch.agentReady === 'boolean' ? patch.agentReady : this.dependencyStatus.agentReady,
      gatewayReady:
        typeof patch.gatewayReady === 'boolean'
          ? patch.gatewayReady
          : this.dependencyStatus.gatewayReady,
      obsidianReady:
        typeof patch.obsidianReady === 'boolean'
          ? patch.obsidianReady
          : this.dependencyStatus.obsidianReady,
      qqReady: typeof patch.qqReady === 'boolean' ? patch.qqReady : this.dependencyStatus.qqReady,
      ttsReady: typeof patch.ttsReady === 'boolean' ? patch.ttsReady : this.dependencyStatus.ttsReady,
      sttReady: typeof patch.sttReady === 'boolean' ? patch.sttReady : this.dependencyStatus.sttReady,
      memorySearchReady:
        typeof patch.memorySearchReady === 'boolean'
          ? patch.memorySearchReady
          : this.dependencyStatus.memorySearchReady
    }
  }

  isEnabled(): boolean {
    return Boolean(this.settings?.enabled)
  }

  getStatus(): CharacterStatus {
    const enabled = this.isEnabled()
    return {
      enabled,
      ready: this.initialized && enabled,
      storeReady: this.initialized,
      ...this.dependencyStatus
    }
  }

  async getState(): Promise<CharacterState> {
    this.assertInitialized()
    if (!this.state) throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色状态尚未加载')
    return { ...this.state }
  }

  async getSettings(): Promise<CharacterSettings> {
    this.assertInitialized()
    if (!this.settings) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色设置尚未加载')
    }
    return clone(this.settings)
  }

  async updateSettings(patch: unknown): Promise<CharacterSettings> {
    this.assertInitialized()
    if (!this.settings) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '角色设置尚未加载')
    }
    const next = mergeCharacterSettings(this.settings, patch)
    this.settings = next
    await this.store.writeSettings(next)
    this.emit({ type: 'settings', payload: clone(next), at: this.now() })
    return clone(next)
  }

  async interact(input: CharacterInteractInput): Promise<CharacterState> {
    this.assertInitialized()
    if (!this.isEnabled()) {
      throw new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '大肥鱼未启用')
    }
    const state = await this.getState()
    const now = this.now()
    const kind = input?.kind
    if (kind !== 'pat' && kind !== 'feed' && kind !== 'dismiss') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的互动类型')
    }
    if (kind === 'pat') state.familiarity = Math.min(FAMILIARITY_CAP, state.familiarity + 1)
    if (kind === 'feed') state.intimacy = Math.min(INTIMACY_CAP, state.intimacy + 1)
    if (kind === 'pat' || kind === 'feed') {
      state.lastInteractionAt = now
      state.mood = kind === 'pat' ? '被摸头了' : '吃饱了'
    }
    state.updatedAt = now
    await this.store.writeState(state)
    this.state = state
    this.emit({ type: 'state', payload: clone(state), at: now })
    return { ...state }
  }

  async reset(options: CharacterResetOptions = {}): Promise<{ scope: string }> {
    this.assertInitialized()
    const scope = options.scope ?? 'values'
    if (scope !== 'values' && scope !== 'memory' && scope !== 'all') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '未知的重置范围')
    }
    await this.store.reset(scope)
    if (scope === 'all') {
      this.settings = await this.store.readSettings()
    }
    this.state = await this.store.readState()
    if (this.state.bornAt === 0) this.state = createDefaultCharacterState(this.now())
    this.emit({ type: 'state', payload: clone(this.state), at: this.now() })
    return { scope }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new CharacterError(CHARACTER_ERROR_CODES.NOT_READY, '大肥鱼尚未初始化')
    }
  }

  private emit(event: CharacterEvent): void {
    try {
      this.onEvent?.(event)
    } catch (error) {
      this.logger(`[character] 事件推送失败: ${(error as Error)?.message ?? String(error)}`)
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
