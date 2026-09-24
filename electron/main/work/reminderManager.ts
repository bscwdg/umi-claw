// work/reminderManager.ts —— 两个固定本地通知 + 待办到点提醒（PLAN-3.0.md §八 / 硬规则 22）
//
// **护栏（硬规则 22）：提醒不是调度系统。**
// 不加自定义规则/重复规则/多提醒/日历同步。
// 2026-09-24 重新评估并经北拍板：允许**待办逐条带一个提醒时刻**，复用本文件同一个
// 30s check 循环到点触发——仍不引入 cron 框架、不做重复规则。
// 待办到点提醒的口径（北 2026-09-24 三次拍板）：
//   ① **本地通知必达**：到点一定弹本机通知，不看外发总开关、不看通道配置
//   ② **外发是加成**：总开关开 + 通道配齐才顺带投渠道；失败落 pushStatus，不重试
//   ③ **到点即消费**：弹过就写 reminded_at，不补发（宁可少一次外发，不要重复弹通知）
//
// 两个固定通知（可关，不依赖 Gateway）：
//   morning  早上一次（今日待办汇总）
//   report   18:30 一次（生成今日日报）
//
// 触发口径：主进程用轻量定时检查当前时刻是否进入对应窗口（每窗口每天最多一次），
// 命中且开关开启 → 发 Notification。这里不做 cron 框架。
//
// 本模块不直接 import electron 的 Notification（保持可测）：notifier 注入；
// 时间/开关读取通过注入函数。纯 Node 用假 notifier 断言。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** 两个固定通知 id */
export const REMINDERS = {
  MORNING: 'morning',
  REPORT: 'report'
} as const
export type ReminderId = (typeof REMINDERS)[keyof typeof REMINDERS]
export const REMINDER_IDS = [REMINDERS.MORNING, REMINDERS.REPORT] as const

/**
 * 待办到点提醒的来源标识（v0.17）。
 *
 * **不是** ReminderId、**不进** REMINDER_IDS：因此它没有时刻设置、没有独立开关、
 * 也不参与两个固定通知的「当天去重」（待办的去重靠 todos.reminded_at 落库）。
 */
export const TODO_REMINDER_ID = 'todo'

/** 触发时刻（本地 24h 制） */
export interface ReminderTime {
  hour: number
  minute: number
}

/**
 * 默认触发时刻（morning=09:00，report=18:30）。
 * 用户可在「工作设置」里改，改的是 app_meta 里的值（不改表、不加规则）；
 * 本常量保留为默认值与「恢复默认」的口径，测试也按它断言。
 */
export const DEFAULT_REMINDER_TIMES: Record<ReminderId, ReminderTime> = {
  morning: { hour: 9, minute: 0 },
  report: { hour: 18, minute: 30 }
}
/** 默认时刻别名（读当前值请用 getTimes()） */
export const REMINDER_TIMES = DEFAULT_REMINDER_TIMES

/** 检查间隔：主进程每 30s 看一次（足够，不做精确秒级） */
export const CHECK_INTERVAL_MS = 30 * 1000
/** 命中容差窗口：进入触发时刻后 60 分钟内均可（避免进程恰好未在整点运行而漏发） */
export const FIRE_GRACE_MS = 60 * 60 * 1000

const META_PREFIX = 'reminder_enabled_'
const META_TIME_PREFIX = 'reminder_time_'
const META_PUSH_ENABLED = 'reminder_push_enabled'
const META_PUSH_CHANNEL = 'reminder_push_channel'
const META_PUSH_TARGET = 'reminder_push_target'
const META_PUSH_FALLBACK_CHANNEL = 'reminder_push_fallback_channel'
const META_PUSH_FALLBACK_TARGET = 'reminder_push_fallback_target'
const META_PUSH_STATUS = 'reminder_push_status'

export interface ReminderPayload {
  title: string
  body: string
}

/**
 * 通知器（主进程注入 electron Notification；测试用记录型假件）。
 * id = 两个固定通知的 ReminderId，或待办到点提醒的 TODO_REMINDER_ID。
 */
export type Notifier = (
  id: ReminderId | typeof TODO_REMINDER_ID,
  payload: ReminderPayload
) => void

/** 今日待办汇总数据提供器（morning 通知正文用） */
export type MorningSummaryProvider = () => Promise<{ count: number; titles: string[] }>

/**
 * 日报草稿自动生成结果（report 通知用）。
 *
 * 本地闭环：到点先**生成草稿**（进「报告」页等待人工确认），再发通知。
 * **不自动外发**——草稿仍需人工确认（硬规则 5：Human-in-the-loop）。
 * 不提供该依赖时退回「提醒你去生成」的旧文案（保持既有行为可测）。
 */
export type DailyDraftResult =
  | { status: 'generated'; reportId: string }
  | { status: 'empty' }
  | { status: 'error'; message: string }
export type DailyDraftProvider = () => Promise<DailyDraftResult>

/**
 * 可用于外发的渠道枚举。
 *
 * ⚠️ `dingtalk` **仅登记用于提示**：OpenClaw 没有任何钉钉渠道实现
 * （docs/channels、dist、插件目录全盘搜索均为空），所以它永远不可选。
 * 保留在枚举里是为了在 UI 提示里明确告诉用户「为什么不给选」，而不是静默消失。
 */
export const PUSH_CHANNELS = ['feishu', 'wecom', 'openclaw-weixin', 'dingtalk'] as const
export type PushChannel = (typeof PUSH_CHANNELS)[number]

/** OpenClaw 实际支持推送的渠道（钉钉不在内） */
export const SUPPORTED_PUSH_CHANNELS = ['feishu', 'wecom', 'openclaw-weixin'] as const

export interface PushConfig {
  /** 默认**关**：未显式开启绝不外发（避免「装了就用」的意外外发） */
  enabled: boolean
  /** 首选渠道 */
  channel: PushChannel | null
  /** 次选（兜底）渠道：首选失败时接着试 */
  fallbackChannel: PushChannel | null
  target: string | null
  fallbackTarget: string | null
}

/** 最近一次外发结果（失败提示用；存 app_meta，不新增表） */
export interface PushStatus {
  at: number
  /** 实际最后尝试的渠道 */
  channel: PushChannel | null
  ok: boolean
  /** 失败原因（ok=true 时为 null） */
  message: string | null
}

/**
 * 一个可推送渠道的展示项。
 *
 * 可选中的条件是 `configured && supported`（北：没配置肯定不能推）。
 * 下拉只展示满足条件的；其余在提示里点名（含原因）。
 */
export interface PushChannelOption {
  channel: PushChannel
  label: string
  /** 在「渠道接入」里已填齐凭证（或插件已有账号） */
  configured: boolean
  /** OpenClaw 有该渠道实现（钉钉为 false） */
  supported: boolean
}

/**
 * 由主进程注入：读「渠道接入」的真实配置状态。
 * 本模块不读 app.json / 插件账号（保持纯 Node 可测）。
 */
export type PushChannelProvider = () => Promise<PushChannelOption[]>

/** 外发结果；失败只记录不抛（本地通知已送达，外发尽力而为） */
export type PushResult = { ok: true } | { ok: false; message: string }
/** 单次外发：告知投到哪个渠道 + 目标。id 仅作来源标注（生产实现不读它） */
export type Pusher = (
  id: string,
  payload: ReminderPayload,
  dest: { channel: PushChannel; target: string }
) => Promise<PushResult>

/**
 * 到点待提醒的待办（TodoManager 过滤后提供，只给提醒/投递所需字段）。
 */
export interface DueTodoReminder {
  id: string
  title: string
  dueDate: string | null
  /** v3：精确到期时刻（有则文案里带出 HH:mm；缺省只显示日期） */
  dueAt?: number | null
}
export type ListDueTodoReminders = () => Promise<DueTodoReminder[]>
export type MarkTodoReminded = (id: string, ts: number) => Promise<void>

/**
 * 一个**已发现的**推送目标（由 OpenClaw 自己记录，用户不需手填）。
 *
 * 来源：agent 库 `conversations` 表 —— OpenClaw 记住「谁跟它说过话」，
 * 含 `channel` / `delivery_target` / `kind`。UI 只展示友好标签，不暴露原始 ID。
 */
export interface PushTargetOption {
  /** 传给 `message send --target` 的值 */
  target: string
  /** 友好展示（如「私聊（最近对话）」） */
  label: string
  kind: 'direct' | 'group'
  updatedAt: number
}

/** 由主进程注入：按渠道列出 OpenClaw 已知的推送目标（读 agent 库） */
export type PushTargetProvider = (channel: PushChannel) => Promise<PushTargetOption[]>

/** 推送测试结果（UI 直接展示） */
export interface PushTestResult {
  ok: boolean
  channel: PushChannel | null
  message: string
}

export interface ReminderManagerOptions {
  database: DatabaseClient
  notifier: Notifier
  getMorningSummary: MorningSummaryProvider
  /** 可选：到点自动生成今日日报草稿（不提供则只发提醒） */
  generateDailyDraft?: DailyDraftProvider
  /** 可选：外发短提示到渠道（不提供则只发本地通知） */
  pusher?: Pusher
  /** 可选：列出可推送渠道及其配置状态（不提供则返回空清单，且不做「已配置」校验） */
  listPushChannels?: PushChannelProvider
  /** 可选：列出某渠道下 OpenClaw 已知的目标（不提供则需手填 target） */
  listPushTargets?: PushTargetProvider
  /** 可选（v2）：列出到点待提醒的待办；与 markTodoReminded 成对提供 */
  listDueTodoReminders?: ListDueTodoReminders
  /** 可选（v2）：标记待办已提醒（到点即消费，防重复弹） */
  markTodoReminded?: MarkTodoReminded
  now?: () => number
  logger?: (message: string) => void
}

export class ReminderManager {
  private readonly database: DatabaseClient
  private readonly notifier: Notifier
  private readonly getMorningSummary: MorningSummaryProvider
  private readonly generateDailyDraft?: DailyDraftProvider
  private readonly pusher?: Pusher
  private readonly listPushChannelsProvider?: PushChannelProvider
  private readonly listPushTargetsProvider?: PushTargetProvider
  private readonly listDueTodoReminders?: ListDueTodoReminders
  private readonly markTodoReminded?: MarkTodoReminded
  private readonly now: () => number
  private readonly logger?: (message: string) => void
  /** 当天已发记录（内存；key=date+id），防同窗口重复发 */
  private readonly firedToday = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(options: ReminderManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ReminderManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ReminderManager 缺少依赖: database')
    }
    if (typeof options.notifier !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ReminderManager 缺少 notifier')
    }
    if (typeof options.getMorningSummary !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ReminderManager 缺少 getMorningSummary')
    }
    this.database = options.database
    this.notifier = options.notifier
    this.getMorningSummary = options.getMorningSummary
    if (options.generateDailyDraft !== undefined && typeof options.generateDailyDraft !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'generateDailyDraft 必须是函数')
    }
    this.generateDailyDraft = options.generateDailyDraft
    if (options.pusher !== undefined && typeof options.pusher !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'pusher 必须是函数')
    }
    this.pusher = options.pusher
    if (options.listPushChannels !== undefined && typeof options.listPushChannels !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'listPushChannels 必须是函数')
    }
    this.listPushChannelsProvider = options.listPushChannels
    if (options.listPushTargets !== undefined && typeof options.listPushTargets !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'listPushTargets 必须是函数')
    }
    this.listPushTargetsProvider = options.listPushTargets
    if (options.listDueTodoReminders !== undefined && typeof options.listDueTodoReminders !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'listDueTodoReminders 必须是函数')
    }
    this.listDueTodoReminders = options.listDueTodoReminders
    if (options.markTodoReminded !== undefined && typeof options.markTodoReminded !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'markTodoReminded 必须是函数')
    }
    this.markTodoReminded = options.markTodoReminded
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  private metaKey(id: ReminderId): string {
    return META_PREFIX + id
  }

  private timeKey(id: ReminderId): string {
    return META_TIME_PREFIX + id
  }

  /** 两个通知的当前时刻（读 app_meta；未设置或脏值 → 回退默认值） */
  async getTimes(): Promise<Record<ReminderId, ReminderTime>> {
    const out = {} as Record<ReminderId, ReminderTime>
    for (const id of REMINDER_IDS) {
      const raw = await this.database.metaGet(this.timeKey(id))
      out[id] = parseTime(raw) ?? { ...DEFAULT_REMINDER_TIMES[id] }
    }
    return out
  }

  /**
   * 设置某通知的时刻（本地 24h 制）。
   * 只改「两个固定通知各自的时刻」——不加规则、不加重复、不增通知数（硬规则 22）。
   */
  async setTime(
    id: ReminderId,
    hour: number,
    minute: number
  ): Promise<{ id: ReminderId; hour: number; minute: number }> {
    if (!REMINDER_IDS.includes(id)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 reminder: ${String(id)}`)
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'hour 必须是 0-23 的整数', { field: 'hour' })
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'minute 必须是 0-59 的整数', { field: 'minute' })
    }
    await this.database.metaSet(this.timeKey(id), formatTime(hour, minute))
    this.log(`[reminder] ${id} 时刻 → ${formatTime(hour, minute)}`)
    return { id, hour, minute }
  }

  /** 外发配置（读 app_meta；脏值一律回退「关」） */
  async getPushConfig(): Promise<PushConfig> {
    const enabledRaw = await this.database.metaGet(META_PUSH_ENABLED)
    const channelRaw = await this.database.metaGet(META_PUSH_CHANNEL)
    const targetRaw = await this.database.metaGet(META_PUSH_TARGET)
    const fbChannelRaw = await this.database.metaGet(META_PUSH_FALLBACK_CHANNEL)
    const fbTargetRaw = await this.database.metaGet(META_PUSH_FALLBACK_TARGET)
    const asChannel = (v: string | null): PushChannel | null =>
      PUSH_CHANNELS.includes(v as PushChannel) ? (v as PushChannel) : null
    const asTarget = (v: string | null): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null
    return {
      enabled: enabledRaw === '1',
      channel: asChannel(channelRaw),
      fallbackChannel: asChannel(fbChannelRaw),
      target: asTarget(targetRaw),
      fallbackTarget: asTarget(fbTargetRaw)
    }
  }

  /** 最近一次外发结果（未发过 → null） */
  async getPushStatus(): Promise<PushStatus | null> {
    const raw = await this.database.metaGet(META_PUSH_STATUS)
    if (!raw) return null
    try {
      const o = JSON.parse(raw) as Partial<PushStatus>
      return {
        at: Number(o.at ?? 0),
        channel: (o.channel ?? null) as PushChannel | null,
        ok: o.ok === true,
        message: typeof o.message === 'string' ? o.message : null
      }
    } catch {
      return null
    }
  }

  private async recordPushStatus(s: PushStatus): Promise<void> {
    await this.database.metaSet(META_PUSH_STATUS, JSON.stringify(s))
  }

  /**
   * 可推送渠道清单（含配置状态）。未注入 provider 时返回空数组。
   * 下拉只应展示 `configured=true` 的渠道。
   */
  async availablePushChannels(): Promise<PushChannelOption[]> {
    if (!this.listPushChannelsProvider) return []
    return this.listPushChannelsProvider()
  }

  /**
   * 某渠道下 OpenClaw 已知的推送目标（新→旧）。
   * 未注入 provider 时返回空数组（此时才需要手填 target）。
   */
  async availablePushTargets(channel: PushChannel): Promise<PushTargetOption[]> {
    if (!PUSH_CHANNELS.includes(channel)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法外发通道: ${String(channel)}`)
    }
    if (!this.listPushTargetsProvider) return []
    return this.listPushTargetsProvider(channel)
  }

  /**
   * 推送测试：按已配置的首选→次选发一条**探针消息**（不含任何工作内容）。
   * 无论成败都记入 `pushStatus`（UI 可见），并把结果直接返回给调用方。
   */
  async testPush(): Promise<PushTestResult> {
    const cfg = await this.getPushConfig()
    if (!this.pusher) {
      return { ok: false, channel: null, message: '外发未接入' }
    }
    const plan = [
      { channel: cfg.channel, target: cfg.target },
      { channel: cfg.fallbackChannel, target: cfg.fallbackTarget }
    ].filter((p): p is { channel: PushChannel; target: string } => !!p.channel && !!p.target)
    if (!plan.length) {
      return { ok: false, channel: null, message: '请先选择渠道与目标' }
    }

    const probe: ReminderPayload = {
      title: 'Umi Claw 推送测试',
      body: '这是一条测试消息，用于验证提醒能否送达。收到即表示通道可用。'
    }

    let lastMessage = '推送失败'
    for (const dest of plan) {
      try {
        const res = await this.pusher('report' as ReminderId, probe, dest)
        if (res.ok) {
          await this.recordPushStatus({
            at: this.now(),
            channel: dest.channel,
            ok: true,
            message: '测试推送成功'
          })
          this.log(`[reminder] 测试推送成功 → ${dest.channel}`)
          return { ok: true, channel: dest.channel, message: '测试推送成功' }
        }
        lastMessage = res.message
      } catch (e) {
        lastMessage = (e as Error)?.message ?? '未知错误'
      }
      this.log(`[reminder] 测试推送 ${dest.channel} 失败: ${lastMessage}`)
    }

    await this.recordPushStatus({
      at: this.now(),
      channel: plan[plan.length - 1].channel,
      ok: false,
      message: lastMessage
    })
    return { ok: false, channel: plan[plan.length - 1].channel, message: lastMessage }
  }

  /**
   * 设置外发配置（局部更新：只传要改的字段）。
   * 开启时必须 channel + target 齐备，否则 VALIDATION_ERROR——不给「开了但不知道发哪」的状态。
   */
  async setPushConfig(patch: {
    enabled?: boolean
    channel?: PushChannel | null
    fallbackChannel?: PushChannel | null
    target?: string | null
    fallbackTarget?: string | null
  }): Promise<PushConfig> {
    const current = await this.getPushConfig()
    const next: PushConfig = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
      channel: patch.channel === undefined ? current.channel : patch.channel,
      fallbackChannel:
        patch.fallbackChannel === undefined ? current.fallbackChannel : patch.fallbackChannel,
      target: patch.target === undefined ? current.target : patch.target,
      fallbackTarget:
        patch.fallbackTarget === undefined ? current.fallbackTarget : patch.fallbackTarget
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'enabled 必须是布尔值', { field: 'enabled' })
    }
    for (const [field, value] of [
      ['channel', next.channel],
      ['fallbackChannel', next.fallbackChannel]
    ] as const) {
      if (value !== null && !PUSH_CHANNELS.includes(value)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法外发通道: ${String(value)}`, { field })
      }
      if (value !== null && !SUPPORTED_PUSH_CHANNELS.includes(value as never)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `OpenClaw 暂不支持该渠道推送：${value}`,
          { field, reason: 'push-channel-unsupported' }
        )
      }
    }
    for (const [field, value] of [
      ['target', next.target],
      ['fallbackTarget', next.fallbackTarget]
    ] as const) {
      if (value !== null && (typeof value !== 'string' || !value.trim())) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 必须是非空字符串或 null`, { field })
      }
    }
    // 首选/次选不得为同一个渠道（否则「兜底」无意义）
    if (next.channel !== null && next.channel === next.fallbackChannel) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '次选渠道不能与首选相同', {
        field: 'fallbackChannel'
      })
    }
    // 没配置的渠道不许选（北：没配置肯定不能推）——仅在有 provider 时校验
    if (this.listPushChannelsProvider) {
      const options = await this.listPushChannelsProvider()
      const byChannel = new Map(options.map((o) => [o.channel, o]))
      for (const [field, value] of [
        ['channel', next.channel],
        ['fallbackChannel', next.fallbackChannel]
      ] as const) {
        if (value === null) continue
        const hit = byChannel.get(value)
        if (hit && !hit.configured) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `渠道尚未配置，不能用于外发：${value}`, {
            field,
            reason: 'push-channel-not-configured'
          })
        }
      }
    }
    if (next.enabled) {
      if (!next.channel || !next.target) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, '开启外发前必须先配置首选通道与目标', {
          reason: 'push-not-configured'
        })
      }
      if (next.fallbackChannel && !next.fallbackTarget) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, '选了次选渠道就必须填次选目标', {
          reason: 'push-fallback-not-configured'
        })
      }
    }

    if (patch.enabled !== undefined) {
      await this.database.metaSet(META_PUSH_ENABLED, next.enabled ? '1' : '0')
    }
    if (patch.channel !== undefined) {
      await this.database.metaSet(META_PUSH_CHANNEL, next.channel ?? '')
    }
    if (patch.fallbackChannel !== undefined) {
      await this.database.metaSet(META_PUSH_FALLBACK_CHANNEL, next.fallbackChannel ?? '')
    }
    if (patch.target !== undefined) {
      await this.database.metaSet(META_PUSH_TARGET, next.target ?? '')
    }
    if (patch.fallbackTarget !== undefined) {
      await this.database.metaSet(META_PUSH_FALLBACK_TARGET, next.fallbackTarget ?? '')
    }
    this.log(
      `[reminder] 外发配置 → ${next.enabled ? '开' : '关'}${
        next.channel ? ` / ${next.channel}` : ''
      }${next.fallbackChannel ? ` → 兜底 ${next.fallbackChannel}` : ''}`
    )
    return next
  }

  /**
   * 外发短提示（方案 A）：首选失败 → 试次选（兜底）→ 记录失败提示。
   * 失败**不抛**：本地通知已送达，外发是尽力而为。
   */
  private async pushIfConfigured(id: ReminderId, payload: ReminderPayload): Promise<void> {
    if (!this.pusher) return
    const cfg = await this.getPushConfig()
    if (!cfg.enabled) return
    const res = await this.sendWithFallback(id, cfg, payload)
    if (!res.ok) this.log(`[reminder] ${id} 外发全部失败（已记失败提示）`)
  }

  /**
   * 首选 → 次选（兜底）投递，并落 pushStatus。
   *
   * - 成功即返回
   * - 通道未配齐（无 channel/target）→ **也写一条失败状态**：这种「一次都没投出去」的
   *   情况原先不落状态，UI 上完全看不出来（待办外发还会照样标记已投递 → 静默丢失）
   * - 全部失败 → 写失败提示（UI 可见）。**不抛**：外发是尽力而为。
   *
   * `sourceLabel`：pushStatus 是全局**单条**记录，不带来源就分不清是哪类外发失败。
   * 固定通知不传（保持原文案）；待办外发传「待办「标题」」。
   */
  private async sendWithFallback(
    id: string,
    cfg: PushConfig,
    payload: ReminderPayload,
    sourceLabel?: string
  ): Promise<{ ok: boolean; channel: PushChannel | null; message: string | null }> {
    const label = (message: string): string => (sourceLabel ? `${sourceLabel}：${message}` : message)
    const plan = [
      { channel: cfg.channel, target: cfg.target },
      { channel: cfg.fallbackChannel, target: cfg.fallbackTarget }
    ].filter((p): p is { channel: PushChannel; target: string } => !!p.channel && !!p.target)
    if (!plan.length) {
      const message = label('通道未配置')
      await this.recordPushStatus({ at: this.now(), channel: null, ok: false, message })
      return { ok: false, channel: null, message }
    }

    let lastMessage: string | null = null
    for (const dest of plan) {
      try {
        const res = await this.pusher!(id, payload, dest)
        if (res.ok) {
          await this.recordPushStatus({ at: this.now(), channel: dest.channel, ok: true, message: null })
          this.log(`[reminder] ${id} 已外发 → ${dest.channel}`)
          return { ok: true, channel: dest.channel, message: null }
        }
        lastMessage = res.message
        this.log(`[reminder] ${id} 外发 ${dest.channel} 失败: ${res.message}`)
      } catch (e) {
        lastMessage = (e as Error)?.message ?? '未知错误'
        this.log(`[reminder] ${id} 外发 ${dest.channel} 异常: ${lastMessage}`)
      }
    }
    // 全部失败 → 写失败提示（UI 可见）
    const message = label(lastMessage ?? '外发失败')
    await this.recordPushStatus({ at: this.now(), channel: plan[plan.length - 1].channel, ok: false, message })
    return { ok: false, channel: plan[plan.length - 1].channel, message }
  }

  /** 开关状态：默认**开启**（P0 期望提醒拉回第 3-5 天掉线） */
  async isEnabled(id: ReminderId): Promise<boolean> {
    if (!REMINDER_IDS.includes(id)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 reminder: ${String(id)}`)
    }
    const raw = await this.database.metaGet(this.metaKey(id))
    // 未写过 → 默认 true；只有显式 '0' 才关
    return raw !== '0'
  }

  /** 设置开关（只接受布尔） */
  async setEnabled(id: ReminderId, enabled: boolean): Promise<{ id: ReminderId; enabled: boolean }> {
    if (!REMINDER_IDS.includes(id)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 reminder: ${String(id)}`)
    }
    if (typeof enabled !== 'boolean') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'enabled 必须是布尔值')
    }
    await this.database.metaSet(this.metaKey(id), enabled ? '1' : '0')
    this.log(`[reminder] ${id} → ${enabled ? '开' : '关'}`)
    return { id, enabled }
  }

  /**
   * 周期检查（主进程调用；可由定时器或手动触发）。
   *
   * 命中条件：当前时间进入某通知触发窗口（时刻起 60 分钟内）、开关开启、当天未发过。
   * 返回本次实际发出的通知 id 列表（测试据此断言）。
   */
  async check(): Promise<ReminderId[]> {
    const now = new Date(this.now())
    const ts = now.getTime()
    const fired: ReminderId[] = []
    const times = await this.getTimes()

    for (const id of REMINDER_IDS) {
      const target = times[id]
      const fireAt = new Date(now)
      fireAt.setHours(target.hour, target.minute, 0, 0)
      const delta = ts - fireAt.getTime()
      // 进入时刻起 0..60min 窗口
      if (delta < 0 || delta > FIRE_GRACE_MS) continue

      const dateKey = localDateKey(now) + '|' + id
      if (this.firedToday.has(dateKey)) continue
      if (!(await this.isEnabled(id))) continue

      // 先占位再构建：report 会自动生成草稿（耗时），不先占位则下一次 check 会重复触发/重复调模型
      this.firedToday.add(dateKey)
      try {
        const payload = await this.buildPayload(id)
        this.notifier(id, payload)
        fired.push(id)
        this.log(`[reminder] 触发 ${id}`)
        // 方案 A：外发同一段短提示（不含正文）；未配置则跳过
        await this.pushIfConfigured(id, payload)
      } catch (e) {
        // 构建失败则释放占位，允许后续 check 重试（不静默丢一天）
        this.firedToday.delete(dateKey)
        this.log(`[reminder] ${id} 载荷构建失败: ${(e as Error)?.message}`)
      }
    }

    // v2：待办到点提醒（本机必达 + 外发加成；与两个固定通知相互独立）
    await this.processTodoReminders()
    return fired
  }

  /**
   * 待办到点提醒（v2 起；口径 2026-09-24 三次拍板：**本地必达 + 外发是加成**）。
   *
   * 与两个固定通知的异同，注释钉死：
   * - **本地通知必达**：到点一定弹本机通知——**不看外发总开关、不看通道配置、不需要
   *   pusher**（本地通知不依赖 Gateway / 渠道 CLI；没配渠道的人也必须被提醒）
   * - **外发是加成**：总开关开 + 通道配齐才顺带投渠道；失败落 pushStatus（带来源前缀），
   *   **不重试**——渠道被删掉重试也不会成功，瞬态失败由用户手动补发
   * - **到点即消费**：弹过就写 `reminded_at`，**不补发**（宁可少一次外发，也不要每 30s
   *   重复弹通知）。故标记紧跟在本地通知之后、外发之前
   * - **不看** morning/report 各自的开关（那是两个固定通知自己的事）
   * - 到点判定由 TodoManager 按 `remind_at` 完成；无独立时刻设置、不进 REMINDER_IDS
   * - **逐条兜底**：任一条异常（如列表与标记之间待办被删 → NOT_FOUND）不得连累同轮其它
   *   到点待办；异常那条不标记，留给下一轮 check（最坏是多弹一次本地通知）
   */
  private async processTodoReminders(): Promise<void> {
    if (!this.listDueTodoReminders || !this.markTodoReminded) return
    let due: DueTodoReminder[]
    try {
      due = await this.listDueTodoReminders()
    } catch (e) {
      this.log(`[reminder] 待办提醒查询失败（本轮跳过）: ${(e as Error)?.message}`)
      return
    }
    if (!due.length) return
    const cfg = await this.getPushConfig()
    for (const t of due) {
      try {
        const ts = this.now()
        const when = t.dueAt !== undefined && t.dueAt !== null ? formatDueAt(t.dueAt) : t.dueDate
        const payload: ReminderPayload = {
          title: '待办提醒',
          body: when ? `${t.title}（${when} 到期）` : t.title
        }
        // 1) 本地通知：必达主通道（不受总开关 / 通道配置 / pusher 有无影响）
        this.notifier(TODO_REMINDER_ID, payload)
        // 2) 立刻标记消费：本地已响过，重复弹比漏弹更烦
        await this.markTodoReminded(t.id, ts)
        // 3) 外发：尽力而为（受总开关管；未开启或未接入 pusher → 只本地通知）
        if (!cfg.enabled || !this.pusher) {
          this.log(
            `[reminder] 待办 ${t.id} 已本地通知（外发跳过：${
              !cfg.enabled ? '总开关关' : '未接入外发'
            }）`
          )
          continue
        }
        const res = await this.sendWithFallback(
          TODO_REMINDER_ID,
          cfg,
          payload,
          `待办「${t.title}」`
        )
        this.log(
          `[reminder] 待办 ${t.id} 已本地通知；外发 ${
            res.ok ? '成功 → ' + res.channel : `失败：${res.message}`
          }`
        )
      } catch (e) {
        // 未标记 → 下一轮 check 会重来（最坏多弹一次本地通知）
        this.log(
          `[reminder] 待办 ${t.id} 提醒流程异常（未标记，下一轮重试）: ${(e as Error)?.message}`
        )
      }
    }
  }

  /** 启动轻量定时器（不是调度系统：固定间隔 check，时刻判定在 check 内） */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.check().catch((e) => this.log(`[reminder] check 失败: ${(e as Error)?.message}`))
    }, CHECK_INTERVAL_MS)
    // 不阻止进程退出
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async buildPayload(id: ReminderId): Promise<ReminderPayload> {
    if (id === REMINDERS.MORNING) {
      const summary = await this.getMorningSummary()
      const body =
        summary.count === 0
          ? '今天还没有待办，可以加一件今天要做的事。'
          : `今日 ${summary.count} 项待办：${summary.titles.slice(0, 3).join('、')}${
              summary.count > 3 ? ` 等 ${summary.count} 项` : ''
            }`
      return { title: '今日待办', body }
    }
    return { title: '生成今日日报', body: await this.reportBody() }
  }

  /**
   * report 通知正文。
   * 有 generateDailyDraft 依赖时：先自动生成草稿，再按结果措辞（草稿落「报告」页等确认）。
   * 没有时：退回「点一下生成」的提醒文案。
   */
  private async reportBody(): Promise<string> {
    const t = await this.getTimes()
    const hhmm = formatTime(t.report.hour, t.report.minute)

    if (!this.generateDailyDraft) {
      return `到 ${hhmm} 了，点一下即可基于今天的记录生成日报。`
    }
    try {
      const res = await this.generateDailyDraft()
      if (res.status === 'generated') {
        return `${hhmm} 已自动汇总今天的记录，日报草稿已就绪，到「报告」页确认即可。`
      }
      if (res.status === 'empty') {
        return '今天还没有记录，先记一件事，再生成日报。'
      }
      return `自动生成日报未成功（${res.message}），到「报告」页可手动生成。`
    } catch (e) {
      return `自动生成日报未成功（${(e as Error)?.message ?? '未知错误'}），到「报告」页可手动生成。`
    }
  }
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseTime(raw: string | null): ReminderTime | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function localDateKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 待办精确到期时刻 → 外发文案里的 `MM-DD HH:mm`（本地时区） */
function formatDueAt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function createReminderManager(options: ReminderManagerOptions): ReminderManager {
  return new ReminderManager(options)
}
