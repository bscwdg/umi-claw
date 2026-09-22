// work/todoManager.ts —— 待办 + 状态机（PLAN-3.0.md §4.2 / §14 契约 / 参数约定 7）
//
// 契约（§4.2 钉死）：
//   - 状态机：candidate ──[确认]──→ confirmed(open) ──[勾完成]──→ done
//             手动新建 ──────────→ confirmed(open)
//             candidate ──[忽略]──→ ignored
//             done（routine）──自动生成下一次──→ confirmed(open)
//   - **初始状态由 `source` 决定，不由调用方传**（参数约定 7）：
//       manual    → confirmed(open)
//       extracted → candidate        （AI 提取，带「AI 提取」标记）
//       routine   → confirmed(open)
//   - **联动规则**（§4.2 规则 1-3）：
//       1. 勾完成 → 自动插入工作记录 `source=todo, status=confirmed, source_ref=<todoId>`
//       2. 取消勾选 → 该自动记录**未被编辑过**则一并撤回；已编辑则保留并断开 source_ref
//       3. 例事勾完成 → 自动生成下一条 confirmed(open) + 落工作记录
//   - `state` 取值：candidate / confirmed / done / ignored（open 与 done 用同一字段表达，
//     `confirmed` = 未完成，`done` = 已完成；见 state 与 done_at 的组合语义）
//
// 设计约束：本模块**不 import electron**，依赖注入，可在纯 Node 下测试。
// 注意：本模块直接写 `activity_log` 表（联动规则是 DB 级事实，不依赖 Commit 03 的 RecordManager）。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** 待办来源（决定初始状态） */
export const TODO_SOURCES = ['manual', 'extracted', 'routine'] as const
export type TodoSource = (typeof TODO_SOURCES)[number]

/** 待办状态 */
export const TODO_STATE_CANDIDATE = 'candidate'
export const TODO_STATE_CONFIRMED = 'confirmed'
export const TODO_STATE_DONE = 'done'
export const TODO_STATE_IGNORED = 'ignored'

/** 例事规则（一期最简：daily / weekly，待拍板 ⑧） */
export const ROUTINE_RULES = ['daily', 'weekly'] as const
export type RoutineRule = (typeof ROUTINE_RULES)[number]

/**
 * `source` → 初始 `state`（参数约定 7，accept 直接断言这三条）。
 * **这是唯一的真相来源**：调用方不得传 state。
 */
export const INITIAL_STATE_BY_SOURCE: Record<TodoSource, string> = {
  manual: TODO_STATE_CONFIRMED,
  extracted: TODO_STATE_CANDIDATE,
  routine: TODO_STATE_CONFIRMED
}

/** todos 表一行（与 schema.ts DDL / db-worker 白名单一一对应） */
export interface TodoRow {
  id: string
  title: string
  due_date: string | null
  matter_id: string | null
  source: string
  routine_rule: string | null
  state: string
  done_at: number | null
  created_at: number
  updated_at: number
}

/** 允许 update 的字段白名单（禁止改 id / source / state / created_at） */
export const TODO_UPDATABLE_FIELDS = ['title', 'due_date', 'matter_id', 'routine_rule'] as const

export interface CreateTodoInput {
  title: string
  dueDate?: string | null
  matterId?: string | null
  /** 来源；默认 manual（手动新建 → 直接 confirmed）。**state 不接受传入** */
  source?: TodoSource
  /** 例事规则（仅 source=routine 有意义） */
  routineRule?: RoutineRule | null
}

export interface UpdateTodoInput {
  title?: string
  dueDate?: string | null
  matterId?: string | null
  routineRule?: RoutineRule | null
}

export interface ListTodosParams {
  state?: string | 'all'
  date?: string
  matterId?: string
  limit?: number
}

/** complete/uncomplete 的返回：描述这次动作真实做了什么（供 UI/日志核对） */
export interface CompleteTodoResult {
  todo: TodoRow
  /** 本次自动落下的工作记录 id（无则 null） */
  recordId: string | null
  /** 例事是否顺带生成了下一次待办 */
  nextTodoId: string | null
}

export interface UncompleteTodoResult {
  todo: TodoRow
  /** 自动记录被撤回（未被编辑过） */
  recordRetracted: boolean
  /** 自动记录被保留但断开 source_ref（已被编辑过） */
  recordDetached: boolean
}

export interface BatchResult {
  /** 实际发生状态迁移的 id 列表 */
  affected: string[]
  /** 已是目标状态/不存在，未改动 */
  skipped: string[]
}

export interface TodoManagerOptions {
  database: DatabaseClient
  logger?: (message: string) => void
  newId?: () => string
  now?: () => number
}

export class TodoManager {
  private readonly database: DatabaseClient
  private readonly logger?: (message: string) => void
  private readonly newId: () => string
  private readonly now: () => number

  constructor(options: TodoManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'TodoManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'TodoManager 缺少依赖: database')
    }
    this.database = options.database
    this.logger = options.logger
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 读 ──────────────────────────────────────────────────────────────────────

  async list(params: ListTodosParams = {}): Promise<TodoRow[]> {
    const where: Record<string, unknown> = {}
    if (params.state && params.state !== 'all') {
      if (![TODO_STATE_CANDIDATE, TODO_STATE_CONFIRMED, TODO_STATE_DONE, TODO_STATE_IGNORED].includes(params.state as never)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 state: ${params.state}`, { field: 'state' })
      }
      where.state = params.state
    }
    if (params.date !== undefined) {
      where.due_date = params.date === null ? null : normalizeDate(params.date)
    }
    if (params.matterId !== undefined) where.matter_id = params.matterId
    return this.database.request<TodoRow[]>('todos.list', {
      where,
      order: [{ column: 'created_at', direction: 'desc' }],
      limit: params.limit
    })
  }

  async get(id: string): Promise<TodoRow> {
    const row = await this.database.request<TodoRow | null>('todos.get', {
      keys: { id: requireId(id, 'get') }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `待办不存在: ${id}`)
    return row
  }

  // ── 写 ──────────────────────────────────────────────────────────────────────

  /**
   * 新建。**`state` 由 `source` 决定**（参数约定 7），调用方传 state 一律忽略。
   */
  async create(input: CreateTodoInput): Promise<TodoRow> {
    if (!input || typeof input !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'create 需要一个入参对象')
    }
    const title = normalizeTitle(input.title)
    const source = normalizeSource(input.source)
    const state = INITIAL_STATE_BY_SOURCE[source]
    const routineRule = source === 'routine' ? normalizeRoutineRule(input.routineRule, true) : normalizeRoutineRule(input.routineRule, false)
    const dueDate = input.dueDate === undefined || input.dueDate === null ? null : normalizeDate(input.dueDate)
    const matterId = normalizeOptionalId(input.matterId, 'matterId')
    const ts = this.now()
    const id = this.newId()
    await this.database.request('todos.create', {
      data: {
        id,
        title,
        due_date: dueDate,
        matter_id: matterId,
        source,
        routine_rule: routineRule,
        state,
        created_at: ts,
        updated_at: ts
      }
    })
    this.log(`[todo] 新建 ${id}（source=${source} → state=${state}）`)
    return this.get(id)
  }

  /** 局部更新（未传字段不动）。**不允许改 state**——状态迁移走 confirm/ignore/complete。 */
  async update(id: string, patch: UpdateTodoInput): Promise<TodoRow> {
    const todoId = requireId(id, 'update')
    if (!patch || typeof patch !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'update 需要一个 patch 对象')
    }
    const data: Record<string, unknown> = {}
    if (patch.title !== undefined) data.title = normalizeTitle(patch.title)
    if (patch.dueDate !== undefined) {
      data.due_date = patch.dueDate === null ? null : normalizeDate(patch.dueDate)
    }
    if (patch.matterId !== undefined) data.matter_id = normalizeOptionalId(patch.matterId, 'matterId')
    if (patch.routineRule !== undefined) data.routine_rule = normalizeRoutineRule(patch.routineRule, false)
    if (!Object.keys(data).length) {
      this.log(`[todo] update(${todoId}) 空 patch，未改动`)
      return this.get(todoId)
    }
    await this.database.request('todos.update', { keys: { id: todoId }, data, required: true })
    return this.get(todoId)
  }

  /** 删除（幂等，参数约定 3：不存在 → false 且不报错） */
  async delete(id: string): Promise<{ id: string; rowDeleted: boolean }> {
    const todoId = requireId(id, 'delete')
    const res = await this.database.request<{ changes: number }>('todos.delete', {
      keys: { id: todoId }
    })
    return { id: todoId, rowDeleted: Number(res?.changes ?? 0) > 0 }
  }

  // ── 状态迁移 ────────────────────────────────────────────────────────────────

  /** candidate → confirmed（§4.2：AI 提取待办需人工确认） */
  async confirm(id: string): Promise<TodoRow> {
    return this.transition(id, [TODO_STATE_CANDIDATE], TODO_STATE_CONFIRMED, 'confirm')
  }

  /** candidate → ignored（留在库中，UI 默认隐藏） */
  async ignore(id: string): Promise<TodoRow> {
    return this.transition(id, [TODO_STATE_CANDIDATE], TODO_STATE_IGNORED, 'ignore')
  }

  /** 批量确认（§14：AI 提取的待办支持批量确认） */
  async confirmBatch(ids: string[]): Promise<BatchResult> {
    return this.batchTransition(ids, [TODO_STATE_CANDIDATE], TODO_STATE_CONFIRMED)
  }

  /** 批量忽略 */
  async ignoreBatch(ids: string[]): Promise<BatchResult> {
    return this.batchTransition(ids, [TODO_STATE_CANDIDATE], TODO_STATE_IGNORED)
  }

  /**
   * 勾完成（§4.2 规则 1 + 3）。
   *
   * 1. `confirmed(open) → done`，落 `done_at`
   * 2. **自动插入工作记录** `source=todo, status=confirmed, source_ref=<todoId>`
   * 3. 例事（`source=routine` 且带 `routine_rule`）→ 自动生成下一条 `confirmed(open)`
   */
  async complete(id: string): Promise<CompleteTodoResult> {
    const todoId = requireId(id, 'complete')
    const todo = await this.get(todoId)
    if (todo.state === TODO_STATE_DONE) {
      // 幂等：已完成的再勾不重复落记录
      this.log(`[todo] complete(${todoId}) 已是 done，幂等返回`)
      return { todo, recordId: null, nextTodoId: null }
    }
    if (todo.state !== TODO_STATE_CONFIRMED) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `只有 confirmed 的待办可以勾完成（当前 state=${todo.state}）`,
        { field: 'state', current: todo.state }
      )
    }
    const ts = this.now()
    await this.database.request('todos.update', {
      keys: { id: todoId },
      data: { state: TODO_STATE_DONE, done_at: ts },
      required: true
    })

    // 联动规则 1：自动落工作记录（用户自己的动作 → 直接 confirmed，来源≠事实）
    const recordId = this.newId()
    await this.database.request('activity_log.create', {
      data: {
        id: recordId,
        content: todo.title,
        // 双时间语义（§2.2.1）：完成动作发生在今天，记录即今天
        occurred_date: dateOf(ts),
        occurred_time: null,
        source: 'todo',
        source_ref: todoId,
        status: 'confirmed',
        matter_id: todo.matter_id,
        confirmed_at: ts,
        created_at: ts,
        updated_at: ts
      }
    })

    // 联动规则 3：例事勾完成 → 自动生成下一次
    let nextTodoId: string | null = null
    if (todo.source === 'routine' && todo.routine_rule) {
      const nextId = this.newId()
      await this.database.request('todos.create', {
        data: {
          id: nextId,
          title: todo.title,
          due_date: nextDueDate(todo.routine_rule, ts),
          matter_id: todo.matter_id,
          source: 'routine',
          routine_rule: todo.routine_rule,
          state: TODO_STATE_CONFIRMED,
          created_at: ts,
          updated_at: ts
        }
      })
      nextTodoId = nextId
      this.log(`[todo] 例事 ${todoId} 完成 → 生成下一次 ${nextId}`)
    }

    this.log(`[todo] complete(${todoId}) → 记录 ${recordId}`)
    return { todo: await this.get(todoId), recordId, nextTodoId }
  }

  /**
   * 取消勾选（§4.2 规则 2）：`done → confirmed(open)`。
   *
   * - 自动生成的记录**未被编辑过**（`updated_at === created_at` 且内容仍等于待办标题）→ 一并撤回
   * - 已被编辑过 → **保留记录并断开 `source_ref`**（用户的编辑不能因为取消勾选而丢）
   */
  async uncomplete(id: string): Promise<UncompleteTodoResult> {
    const todoId = requireId(id, 'uncomplete')
    const todo = await this.get(todoId)
    if (todo.state !== TODO_STATE_DONE) {
      this.log(`[todo] uncomplete(${todoId}) 不是 done，幂等返回`)
      return { todo, recordRetracted: false, recordDetached: false }
    }
    const ts = this.now()
    await this.database.request('todos.update', {
      keys: { id: todoId },
      data: { state: TODO_STATE_CONFIRMED, done_at: null },
      required: true
    })

    // 找回该待办自动生成的记录
    const records = await this.database.request<Array<{ id: string; content: string; created_at: number; updated_at: number }>>(
      'activity_log.list',
      { where: { source: 'todo', source_ref: todoId } }
    )
    let recordRetracted = false
    let recordDetached = false
    for (const rec of records) {
      const untouched = Number(rec.updated_at) === Number(rec.created_at) && rec.content === todo.title
      if (untouched) {
        await this.database.request('activity_log.delete', { keys: { id: rec.id } })
        recordRetracted = true
        this.log(`[todo] uncomplete(${todoId}) → 撤回未编辑记录 ${rec.id}`)
      } else {
        // 断开关联：source 保持 todo 事实，但不再指向这条待办
        await this.database.request('activity_log.update', {
          keys: { id: rec.id },
          data: { source_ref: null, updated_at: ts },
          required: true
        })
        recordDetached = true
        this.log(`[todo] uncomplete(${todoId}) → 记录 ${rec.id} 已被编辑，保留并断开 source_ref`)
      }
    }
    return { todo: await this.get(todoId), recordRetracted, recordDetached }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    fromStates: string[],
    toState: string,
    opName: string
  ): Promise<TodoRow> {
    const todoId = requireId(id, opName)
    const todo = await this.get(todoId)
    if (todo.state === toState) {
      this.log(`[todo] ${opName}(${todoId}) 已是 ${toState}，幂等返回`)
      return todo
    }
    if (!fromStates.includes(todo.state)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `${opName} 只允许 ${fromStates.join('/')} → ${toState}（当前 state=${todo.state}）`,
        { field: 'state', current: todo.state }
      )
    }
    await this.database.request('todos.update', {
      keys: { id: todoId },
      data: { state: toState },
      required: true
    })
    return this.get(todoId)
  }

  private async batchTransition(ids: string[], fromStates: string[], toState: string): Promise<BatchResult> {
    if (!Array.isArray(ids) || !ids.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '批量操作需要非空 ids 数组', { field: 'ids' })
    }
    const affected: string[] = []
    const skipped: string[] = []
    for (const raw of ids) {
      const todoId = typeof raw === 'string' ? raw.trim() : ''
      if (!todoId) {
        skipped.push(String(raw))
        continue
      }
      const row = await this.database.request<TodoRow | null>('todos.get', { keys: { id: todoId } })
      // 批量操作**不因单条失败而中断**：不存在/状态不符一律计入 skipped
      if (!row || !fromStates.includes(row.state)) {
        skipped.push(todoId)
        continue
      }
      await this.database.request('todos.update', {
        keys: { id: todoId },
        data: { state: toState },
        required: true
      })
      affected.push(todoId)
    }
    this.log(`[todo] 批量 → ${toState}：改动 ${affected.length}，跳过 ${skipped.length}`)
    return { affected, skipped }
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function requireId(id: unknown, op: string): string {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${op} 需要非空 id`, { field: 'id' })
  return value
}

function normalizeTitle(title: unknown): string {
  const value = typeof title === 'string' ? title.trim() : ''
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '待办标题不能为空', { field: 'title' })
  if (value.length > 200) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '待办标题不能超过 200 字', { field: 'title' })
  }
  return value
}

function normalizeSource(source: unknown): TodoSource {
  if (source === undefined || source === null) return 'manual'
  if (!TODO_SOURCES.includes(source as TodoSource)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 source: ${source}`, { field: 'source' })
  }
  return source as TodoSource
}

function normalizeRoutineRule(rule: unknown, required: boolean): string | null {
  if (rule === undefined || rule === null || rule === '') {
    if (required) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '例事待办必须带 routine_rule（daily/weekly）', {
        field: 'routineRule'
      })
    }
    return null
  }
  if (!ROUTINE_RULES.includes(rule as RoutineRule)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 routine_rule: ${rule}`, { field: 'routineRule' })
  }
  return rule as string
}

function normalizeOptionalId(id: unknown, field: string): string | null {
  if (id === undefined || id === null) return null
  if (typeof id !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 必须是字符串或 null`, { field })
  }
  const value = id.trim()
  return value === '' ? null : value
}

/** `YYYY-MM-DD` 严格校验（不做宽松解析，避免 2026-2-3 这类形状混进库） */
export function normalizeDate(date: unknown): string {
  const value = typeof date === 'string' ? date.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `日期必须是 YYYY-MM-DD 形式: ${String(date)}`, {
      field: 'date'
    })
  }
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `日期不存在: ${value}`, { field: 'date' })
  }
  return value
}

/** 时间戳 → `YYYY-MM-DD`（本地时区，与用户看到的「今天」一致） */
export function dateOf(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 例事下一次到期日（daily = 明天；weekly = 7 天后） */
export function nextDueDate(rule: string, fromTs: number): string | null {
  const days = rule === 'daily' ? 1 : rule === 'weekly' ? 7 : 0
  if (!days) return null
  return dateOf(fromTs + days * 24 * 60 * 60 * 1000)
}

export function createTodoManager(options: TodoManagerOptions): TodoManager {
  return new TodoManager(options)
}
