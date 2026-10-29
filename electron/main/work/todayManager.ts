// work/todayManager.ts —— 「今日」页聚合（PLAN-3.0.md §5.1 / §14 today）
//
// `get(date?)` 一次拉齐今日页所需，避免渲染端串多个 IPC：
//   - 今日待办：confirmed（今日到期 + 无日期 + **已逾期**）
//   - AI 提取待办：candidate（带「AI 提取」标记，批量确认/忽略）
//   - 今日记录：confirmed
//   - 待确认记录：candidate（带「AI 候选」，记入/忽略）
//   - 日报状态：当天 daily report 是否存在（draft/confirmed；18:30 后可生成高亮）
//
// 本模块不 import electron；只通过注入的 DatabaseClient 读，纯 Node 可测。

import { dateOf, normalizeDate } from './todoManager'

export interface TodayTodoItem {
  id: string
  title: string
  dueDate: string | null
  /** v3：精确到期时刻（null = 只按 dueDate 当天到期） */
  dueAt: number | null
  matterId: string | null
  source: string
  /** 已逾期（有 dueAt 按 dueAt 判；否则按 dueDate < 今天），仍 confirmed */
  overdue: boolean
  /** v2：到点提醒时刻（epoch ms；null = 不提醒） */
  remindAt: number | null
}

export interface TodayCandidateTodoItem {
  id: string
  title: string
  dueDate: string | null
  matterId: string | null
}

export interface TodayRecordItem {
  id: string
  content: string
  occurredTime: string | null
  matterId: string | null
}

export interface TodayCandidateRecordItem {
  id: string
  content: string
  occurredTime: string | null
  matterId: string | null
  filteredReason: string | null
}

export interface DailyReportStatus {
  /** 当天是否已生成日报 */
  exists: boolean
  reportId: string | null
  /** draft / confirmed；不存在为 null */
  status: 'draft' | 'confirmed' | null
  /** 当前是否过了建议生成时刻（18:30） */
  canGenerate: boolean
}

export interface TodayView {
  date: string
  weekday: number
  /** 问候语（按小时：早上好/下午好/晚上好） */
  greeting: string
  todos: TodayTodoItem[]
  candidateTodos: TodayCandidateTodoItem[]
  records: TodayRecordItem[]
  candidateRecords: TodayCandidateRecordItem[]
  report: DailyReportStatus
  /** 汇总计数（徽标） */
  counts: {
    todos: number
    candidateTodos: number
    records: number
    candidateRecords: number
  }
}

export interface TodayManagerOptions {
  database: import('../database/database').DatabaseClient
  /** 注入当前时间（问候/18:30 判定/默认今天） */
  now?: () => number
}

export class TodayManager {
  private readonly database: import('../database/database').DatabaseClient
  private readonly now: () => number

  constructor(options: TodayManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('TodayManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new Error('TodayManager 缺少依赖: database')
    }
    this.database = options.database
    this.now = options.now ?? (() => Date.now())
  }

  async get(date?: string): Promise<TodayView> {
    const ts = this.now()
    const today = date ? normalizeDate(date) : dateOf(ts)
    const nowDt = new Date(ts)

    // ── 待办（confirmed）：今日 + 无日期 + 逾期 ──
    const todoRows = await this.database.request<Array<Record<string, unknown>>>('todos.list', {
      where: { state: 'confirmed' },
      order: [
        { column: 'due_date', direction: 'asc' },
        { column: 'created_at', direction: 'desc' }
      ],
      limit: 5000
    })
    const todos: TodayTodoItem[] = todoRows
      .map((t) => {
        const due = t.due_date === null || t.due_date === undefined ? null : String(t.due_date)
        const dueAt = t.due_at === null || t.due_at === undefined ? null : Number(t.due_at)
        return {
          id: String(t.id),
          title: String(t.title ?? ''),
          dueDate: due,
          dueAt,
          matterId: t.matter_id === null || t.matter_id === undefined ? null : String(t.matter_id),
          source: String(t.source ?? 'manual'),
          overdue: dueAt !== null ? dueAt < ts : due !== null && due < today,
          remindAt:
            t.remind_at === null || t.remind_at === undefined ? null : Number(t.remind_at)
        }
      })
      // 收今日到期、无日期（open-ended，始终展示）、已逾期
      .filter((t) => t.dueDate === null || t.dueDate === today || t.overdue)

    // ── AI 提取待办（candidate）：展示今日相关（今日/无日期/逾期） ──
    const candidateTodoRows = await this.database.request<Array<Record<string, unknown>>>('todos.list', {
      where: { state: 'candidate' },
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: 5000
    })
    const candidateTodos: TodayCandidateTodoItem[] = candidateTodoRows
      .map((t) => ({
        id: String(t.id),
        title: String(t.title ?? ''),
        dueDate: t.due_date === null || t.due_date === undefined ? null : String(t.due_date),
        matterId: t.matter_id === null || t.matter_id === undefined ? null : String(t.matter_id)
      }))
      .filter((t) => t.dueDate === null || t.dueDate <= today)

    // ── 今日 confirmed 记录 ──
    const recordRows = await this.database.request<Array<Record<string, unknown>>>('activity_log.list', {
      where: { occurred_date: today, status: 'confirmed' },
      order: [
        { column: 'occurred_time', direction: 'asc' },
        { column: 'created_at', direction: 'asc' }
      ],
      limit: 5000
    })
    const records: TodayRecordItem[] = recordRows.map((r) => ({
      id: String(r.id),
      content: String(r.content ?? ''),
      occurredTime: r.occurred_time === null || r.occurred_time === undefined ? null : String(r.occurred_time),
      matterId: r.matter_id === null || r.matter_id === undefined ? null : String(r.matter_id)
    }))

    // ── 今日 candidate 记录（待确认；ignored 的 filtered_reason 不算待确认）──
    const candidateRecordRows = await this.database.request<Array<Record<string, unknown>>>('activity_log.list', {
      where: { occurred_date: today, status: 'candidate' },
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: 5000
    })
    const candidateRecords: TodayCandidateRecordItem[] = candidateRecordRows.map((r) => ({
      id: String(r.id),
      content: String(r.content ?? ''),
      occurredTime: r.occurred_time === null || r.occurred_time === undefined ? null : String(r.occurred_time),
      matterId: r.matter_id === null || r.matter_id === undefined ? null : String(r.matter_id),
      filteredReason: r.filtered_reason === null || r.filtered_reason === undefined ? null : String(r.filtered_reason)
    }))

    // ── 当天日报状态 ──
    const dailyRows = await this.database.request<Array<Record<string, unknown>>>('reports.list', {
      where: { type: 'daily', period: today },
      limit: 1
    })
    const daily = dailyRows[0] ?? null
    const hour = nowDt.getHours()
    const minute = nowDt.getMinutes()
    const after1830 = hour > 18 || (hour === 18 && minute >= 30)

    return {
      date: today,
      weekday: nowDt.getDay(),
      greeting: greetingFor(hour),
      todos,
      candidateTodos,
      records,
      candidateRecords,
      report: {
        exists: daily !== null,
        reportId: daily ? String(daily.id) : null,
        status: daily ? (String(daily.status) as 'draft' | 'confirmed') : null,
        canGenerate: after1830
      },
      counts: {
        todos: todos.length,
        candidateTodos: candidateTodos.length,
        records: records.length,
        candidateRecords: candidateRecords.length
      }
    }
  }
}

function greetingFor(hour: number): string {
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function createTodayManager(options: TodayManagerOptions): TodayManager {
  return new TodayManager(options)
}
