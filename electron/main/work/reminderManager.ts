// work/reminderManager.ts —— 最简两个本地通知（PLAN-3.0.md §八 / 硬规则 22）
//
// **护栏（硬规则 22）：提醒是两个固定通知，不是调度系统。**
// 不加自定义规则/重复规则/多提醒/日历同步——想做先重新评估。
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

/** 触发时刻（本地 24h 制；morning=09:00，report=18:30） */
export const REMINDER_TIMES: Record<ReminderId, { hour: number; minute: number }> = {
  morning: { hour: 9, minute: 0 },
  report: { hour: 18, minute: 30 }
}

/** 检查间隔：主进程每 30s 看一次（足够，不做精确秒级） */
export const CHECK_INTERVAL_MS = 30 * 1000
/** 命中容差窗口：进入触发时刻后 60 分钟内均可（避免进程恰好未在整点运行而漏发） */
export const FIRE_GRACE_MS = 60 * 60 * 1000

const META_PREFIX = 'reminder_enabled_'

export interface ReminderPayload {
  title: string
  body: string
}

/** 通知器（主进程注入 electron Notification；测试用记录型假件） */
export type Notifier = (id: ReminderId, payload: ReminderPayload) => void

/** 今日待办汇总数据提供器（morning 通知正文用） */
export type MorningSummaryProvider = () => Promise<{ count: number; titles: string[] }>

export interface ReminderManagerOptions {
  database: DatabaseClient
  notifier: Notifier
  getMorningSummary: MorningSummaryProvider
  now?: () => number
  logger?: (message: string) => void
}

export class ReminderManager {
  private readonly database: DatabaseClient
  private readonly notifier: Notifier
  private readonly getMorningSummary: MorningSummaryProvider
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
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  private metaKey(id: ReminderId): string {
    return META_PREFIX + id
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

    for (const id of REMINDER_IDS) {
      const target = REMINDER_TIMES[id]
      const fireAt = new Date(now)
      fireAt.setHours(target.hour, target.minute, 0, 0)
      const delta = ts - fireAt.getTime()
      // 进入时刻起 0..60min 窗口
      if (delta < 0 || delta > FIRE_GRACE_MS) continue

      const dateKey = localDateKey(now) + '|' + id
      if (this.firedToday.has(dateKey)) continue
      if (!(await this.isEnabled(id))) continue

      const payload = await this.buildPayload(id)
      this.notifier(id, payload)
      this.firedToday.add(dateKey)
      fired.push(id)
      this.log(`[reminder] 触发 ${id}`)
    }
    return fired
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
    return { title: '生成今日日报', body: '到 18:30 了，点一下即可基于今天的记录生成日报。' }
  }
}

function localDateKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function createReminderManager(options: ReminderManagerOptions): ReminderManager {
  return new ReminderManager(options)
}
