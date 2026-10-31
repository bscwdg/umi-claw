// electron/main/character/types.ts —— 大肥鱼角色：类型、常量、默认值
//
// 设计约束（PLAN-FISH-CHARACTER v1.1）：
// - 角色是宿主模块（不是插件）：需要窗口/托盘/语音/网关单例；
// - 数据只走宿主 app_meta 的 fish:v2:* 键，不建表（与 voice 同口径）；
// - 不新增知识库：世界书/热梗/日记全部走既有 Obsidian（MCP 检索）；
// - 默认关闭（D8）：enabled=false 时整段不启动，不影响宿主。

/** IPC 通道（宿主 `character:*` 命名空间，与插件租约互不冲突） */
export const CHARACTER_CHANNELS = {
  statusGet: 'character:status:get',
  stateGet: 'character:state:get',
  settingsGet: 'character:settings:get',
  settingsSet: 'character:settings:set',
  interact: 'character:interact',
  reset: 'character:reset',
  bootstrapRun: 'character:bootstrap:run',
  bootstrapStatus: 'character:bootstrap:status',
  windowPet: 'character:window:pet',
  windowPetPos: 'character:window:pet:pos'
} as const

/** 错误码（渲染端按 code 分支，不读 message） */
export const CHARACTER_ERROR_CODES = {
  NOT_READY: 'CHARACTER_NOT_READY',
  DISABLED: 'CHARACTER_DISABLED',
  STORE_IO: 'CHARACTER_STORE_IO',
  BAD_PAYLOAD: 'CHARACTER_BAD_PAYLOAD',
  RESET_FORBIDDEN: 'CHARACTER_RESET_FORBIDDEN'
} as const
export type CharacterErrorCode =
  (typeof CHARACTER_ERROR_CODES)[keyof typeof CHARACTER_ERROR_CODES]

export class CharacterError extends Error {
  readonly code: CharacterErrorCode
  readonly details?: unknown
  constructor(code: CharacterErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'CharacterError'
    this.code = code
    this.details = details
  }
}

export type CharacterIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export function toCharacterEnvelope<T>(data: T): CharacterIpcResult<T> {
  return { ok: true, data }
}

export function toCharacterErrorEnvelope(error: unknown): CharacterIpcResult<never> {
  if (error instanceof CharacterError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: CHARACTER_ERROR_CODES.STORE_IO, message }
  }
}

/** 数据键前缀（PLAN-FISH-CHARACTER §4.1） */
export const FISH_KEY_PREFIX = 'fish:v2:'
export const FISH_KEYS = {
  meta: `${FISH_KEY_PREFIX}meta`,
  state: `${FISH_KEY_PREFIX}state`,
  settings: `${FISH_KEY_PREFIX}settings`,
  unlocks: `${FISH_KEY_PREFIX}unlocks`,
  dedup: `${FISH_KEY_PREFIX}dedup`,
  pet: `${FISH_KEY_PREFIX}pet`,
  day: (date: string) => `${FISH_KEY_PREFIX}day:${date}`,
  life: (date: string) => `${FISH_KEY_PREFIX}life:${date}`
} as const

export const CHARACTER_SCHEMA_VERSION = 1

/** 宿主 app_meta KV（work.db）；value=null 表示删除 */
export interface CharacterKv {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<unknown>
}

export type CharacterStage = 0 | 1 | 2 | 3 | 4
export const CHARACTER_STAGE_LABELS: Record<CharacterStage, string> = {
  0: '初识',
  1: '眼熟',
  2: '熟客',
  3: '自己人',
  4: '搭子以上'
}

/** 称呼：默认「你」；用户设置后立即生效；禁忌名单为空表示不限制 */
export interface CharacterSettings {
  enabled: boolean
  proactive: {
    enabled: boolean
    silenceDays: number
    dailyCap: number
    quietFrom: string
    quietTo: string
    contentTypes: string[]
    channel: 'qq' | 'app'
    silentUntil: number
  }
  voice: {
    enabled: boolean
    requestAllowed: boolean
    dailyCap: number
    sttEnabled: boolean
  }
  memory: { autoEnabled: boolean; confirmImportant: boolean }
  pet: { visible: boolean; size: 'small' | 'medium' | 'large'; clickThrough: boolean }
  safety: { aiDisclosure: boolean; crisisRedirect: boolean; ageConfirmed: boolean }
  relationship: {
    mode: 'companion' | 'sister' | 'lover'
    userName: string
    address: string
    taboo: string[]
  }
}

export interface CharacterState {
  bornAt: number
  stage: CharacterStage
  familiarity: number
  intimacy: number
  streakDays: number
  lastInteractionAt: number
  addressForm: string
  mood: string
  updatedAt: number
}

export interface CharacterMeta {
  schemaVersion: number
  days: string[]
}

/** 宿主/依赖就绪情况（C01 只填 storeReady；C02 补 agent/obsidian/qq） */
export interface CharacterStatus {
  enabled: boolean
  ready: boolean
  storeReady: boolean
  agentReady: boolean
  gatewayReady: boolean
  obsidianReady: boolean
  qqReady: boolean
  ttsReady: boolean
  sttReady: boolean
  memorySearchReady: boolean
}

export type CharacterInteractKind = 'pat' | 'feed'
export type CharacterInteractInput = { kind: CharacterInteractKind } | { kind: 'dismiss'; bubbleId: string }

/** 桌宠窗口尺寸（DIP）；大小档位来自设置 pet.size */
export const PET_SIZE_MAP: Record<'small' | 'medium' | 'large', { width: number; height: number }> = {
  small: { width: 220, height: 260 },
  medium: { width: 280, height: 330 },
  large: { width: 340, height: 400 }
}

export interface CharacterPetState {
  x: number
  y: number
  width: number
  height: number
  clickThrough: boolean
  visible: boolean
}

export function createDefaultPetState(): CharacterPetState {
  const size = PET_SIZE_MAP.medium
  return {
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    clickThrough: false,
    visible: false
  }
}

/** 把位置夹到工作区内（多屏/改分辨率后不越界；x/y 为窗口左上角，DIP） */
export function clampPetPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  workArea: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const maxX = workArea.x + Math.max(0, workArea.width - width)
  const maxY = workArea.y + Math.max(0, workArea.height - height)
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(y, workArea.y), maxY))
  }
}

export interface CharacterResetOptions {
  /** values=只清数值；memory=+日记与关系；all=+agent/bindings/Obsidian 归档（C09 实现） */
  scope?: 'values' | 'memory' | 'all'
  keepPersona?: boolean
}

export type CharacterEvent =
  | { type: 'state'; payload: CharacterState; at: number }
  | { type: 'settings'; payload: CharacterSettings; at: number }

export const DEFAULT_CHARACTER_SETTINGS: CharacterSettings = {
  enabled: false,
  proactive: {
    enabled: true,
    silenceDays: 3,
    dailyCap: 2,
    quietFrom: '23:30',
    quietTo: '08:00',
    contentTypes: ['morning', 'thinkingOfYou', 'herDay', 'anniversary'],
    channel: 'qq',
    silentUntil: 0
  },
  voice: { enabled: true, requestAllowed: true, dailyCap: 10, sttEnabled: true },
  memory: { autoEnabled: true, confirmImportant: true },
  pet: { visible: true, size: 'medium', clickThrough: false },
  safety: { aiDisclosure: true, crisisRedirect: true, ageConfirmed: false },
  relationship: { mode: 'companion', userName: '', address: '你', taboo: [] }
}

export function createDefaultCharacterState(now: number): CharacterState {
  return {
    bornAt: now,
    stage: 0,
    familiarity: 0,
    intimacy: 0,
    streakDays: 0,
    lastInteractionAt: 0,
    addressForm: '你',
    mood: '平静',
    updatedAt: now
  }
}

/** 设置白名单合并：只允许已知字段，数组整体替换，数值夹到合理范围 */
export function mergeCharacterSettings(
  base: CharacterSettings,
  patch: unknown
): CharacterSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const src = patch as Record<string, unknown>
  const out: CharacterSettings = JSON.parse(JSON.stringify(base)) as CharacterSettings
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled

  const proactive = src.proactive as Record<string, unknown> | undefined
  if (proactive && typeof proactive === 'object') {
    const p = out.proactive
    if (typeof proactive.enabled === 'boolean') p.enabled = proactive.enabled
    if (typeof proactive.silenceDays === 'number') p.silenceDays = clamp(proactive.silenceDays, 0, 14)
    if (typeof proactive.dailyCap === 'number') p.dailyCap = clamp(proactive.dailyCap, 0, 10)
    if (typeof proactive.quietFrom === 'string' && isHhMm(proactive.quietFrom)) p.quietFrom = proactive.quietFrom
    if (typeof proactive.quietTo === 'string' && isHhMm(proactive.quietTo)) p.quietTo = proactive.quietTo
    if (Array.isArray(proactive.contentTypes)) {
      p.contentTypes = proactive.contentTypes.filter((x): x is string => typeof x === 'string').slice(0, 20)
    }
    if (proactive.channel === 'qq' || proactive.channel === 'app') p.channel = proactive.channel
    if (typeof proactive.silentUntil === 'number') p.silentUntil = Math.max(0, proactive.silentUntil)
  }

  const voice = src.voice as Record<string, unknown> | undefined
  if (voice && typeof voice === 'object') {
    const v = out.voice
    if (typeof voice.enabled === 'boolean') v.enabled = voice.enabled
    if (typeof voice.requestAllowed === 'boolean') v.requestAllowed = voice.requestAllowed
    if (typeof voice.dailyCap === 'number') v.dailyCap = clamp(voice.dailyCap, 0, 100)
    if (typeof voice.sttEnabled === 'boolean') v.sttEnabled = voice.sttEnabled
  }

  const memory = src.memory as Record<string, unknown> | undefined
  if (memory && typeof memory === 'object') {
    if (typeof memory.autoEnabled === 'boolean') out.memory.autoEnabled = memory.autoEnabled
    if (typeof memory.confirmImportant === 'boolean') out.memory.confirmImportant = memory.confirmImportant
  }

  const pet = src.pet as Record<string, unknown> | undefined
  if (pet && typeof pet === 'object') {
    if (typeof pet.visible === 'boolean') out.pet.visible = pet.visible
    if (pet.size === 'small' || pet.size === 'medium' || pet.size === 'large') out.pet.size = pet.size
    if (typeof pet.clickThrough === 'boolean') out.pet.clickThrough = pet.clickThrough
  }

  const safety = src.safety as Record<string, unknown> | undefined
  if (safety && typeof safety === 'object') {
    if (typeof safety.aiDisclosure === 'boolean') out.safety.aiDisclosure = safety.aiDisclosure
    if (typeof safety.crisisRedirect === 'boolean') out.safety.crisisRedirect = safety.crisisRedirect
    if (typeof safety.ageConfirmed === 'boolean') out.safety.ageConfirmed = safety.ageConfirmed
  }

  const rel = src.relationship as Record<string, unknown> | undefined
  if (rel && typeof rel === 'object') {
    const r = out.relationship
    if (rel.mode === 'companion' || rel.mode === 'sister' || rel.mode === 'lover') r.mode = rel.mode
    if (typeof rel.userName === 'string') r.userName = rel.userName.slice(0, 40)
    if (typeof rel.address === 'string' && rel.address.trim()) r.address = rel.address.trim().slice(0, 40)
    if (Array.isArray(rel.taboo)) {
      r.taboo = rel.taboo.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 30)
    }
  }

  return out
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

function isHhMm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}
