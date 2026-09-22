// electron/main/ipc/work.ts —— work 域 IPC（PLAN-3.0.md §14 契约）
//
// Commit 02 面：work.profile / work.matters / work.todos
//
// 契约（§14）：
//   - `profile`：{ get, update } —— 单行；完整度随 get 返回（不单独开通道）
//   - `matters`：{ list, create, update, delete, suggestMatter }
//   - `todos`：{ list, create, update, delete, complete, uncomplete, confirm, ignore,
//                confirmBatch, ignoreBatch }
//   - 参数约定（v0.7 钉死）：所有 id 是首个位置参数；update 局部更新；
//     delete 幂等（不返回 NOT_FOUND）；list 新→旧；`state` 不由调用方传（由 source 决定）
//   - 失败统一信封：{ ok:false, error:{ code, message, details? } }；成功 { ok:true, data }
//   - 渲染端按 `code` 分支，禁止 error.message.includes()
//
// 本模块只做参数透传与信封包装；业务规则全在 Manager 层（可纯 Node 测）。

import { ipcMain } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { ProfileManager, UpdateProfileInput } from '../work/profileManager'
import type { CreateMatterInput, MatterManager, UpdateMatterInput } from '../work/matterManager'
import type { CreateTodoInput, ListTodosParams, TodoManager, UpdateTodoInput } from '../work/todoManager'
import type {
  CreateRecordInput,
  ListRecordsParams,
  ProposeCandidateInput,
  RecordManager,
  UpdateRecordInput
} from '../work/recordManager'

/** IPC 统一返回信封（§14.2） */
export type WorkIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const WORK_PROFILE_CHANNELS = {
  get: 'work:profile:get',
  update: 'work:profile:update'
} as const

export const WORK_MATTERS_CHANNELS = {
  list: 'work:matters:list',
  create: 'work:matters:create',
  update: 'work:matters:update',
  delete: 'work:matters:delete',
  suggestMatter: 'work:matters:suggestMatter'
} as const

export const WORK_TODOS_CHANNELS = {
  list: 'work:todos:list',
  create: 'work:todos:create',
  update: 'work:todos:update',
  delete: 'work:todos:delete',
  complete: 'work:todos:complete',
  uncomplete: 'work:todos:uncomplete',
  confirm: 'work:todos:confirm',
  ignore: 'work:todos:ignore',
  confirmBatch: 'work:todos:confirmBatch',
  ignoreBatch: 'work:todos:ignoreBatch'
} as const

/** Commit 03：工作记录 + 候选管线（§2.2 / §4.1） */
export const WORK_RECORDS_CHANNELS = {
  list: 'work:records:list',
  get: 'work:records:get',
  create: 'work:records:create',
  update: 'work:records:update',
  delete: 'work:records:delete',
  confirm: 'work:records:confirm',
  ignore: 'work:records:ignore',
  restore: 'work:records:restore',
  confirmBatch: 'work:records:confirmBatch',
  ignoreBatch: 'work:records:ignoreBatch',
  listFiltered: 'work:records:listFiltered',
  proposeCandidate: 'work:records:proposeCandidate'
} as const

async function wrap<T>(fn: () => Promise<T>): Promise<WorkIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(channel: string, fn: (...args: any[]) => Promise<WorkIpcResult<unknown>>): void {
  // 防御性：重复注册会抛 "Attempted to register a second handler"，先移除
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

export interface WorkIpcDeps {
  profile: ProfileManager
  matters: MatterManager
  todos: TodoManager
  records: RecordManager
}

/** 注册 work 域 IPC（Commit 02：profile / matters / todos） */
export function registerWorkIpc(deps: WorkIpcDeps): void {
  const { profile, matters, todos, records } = deps

  // ── profile ──
  handle(WORK_PROFILE_CHANNELS.get, () => wrap(() => profile.get()))
  handle(WORK_PROFILE_CHANNELS.update, (input: UpdateProfileInput) => wrap(() => profile.update(input)))

  // ── matters ──
  handle(WORK_MATTERS_CHANNELS.list, (params) => wrap(() => matters.list(params ?? {})))
  handle(WORK_MATTERS_CHANNELS.create, (input: CreateMatterInput) => wrap(() => matters.create(input)))
  handle(WORK_MATTERS_CHANNELS.update, (id: string, patch: UpdateMatterInput) =>
    wrap(() => matters.update(id, patch))
  )
  handle(WORK_MATTERS_CHANNELS.delete, (id: string) => wrap(() => matters.delete(id)))
  handle(WORK_MATTERS_CHANNELS.suggestMatter, (recordText: string) =>
    wrap(() => matters.suggestMatter(recordText))
  )

  // ── todos ──
  handle(WORK_TODOS_CHANNELS.list, (params: ListTodosParams) => wrap(() => todos.list(params ?? {})))
  handle(WORK_TODOS_CHANNELS.create, (input: CreateTodoInput) => wrap(() => todos.create(input)))
  handle(WORK_TODOS_CHANNELS.update, (id: string, patch: UpdateTodoInput) =>
    wrap(() => todos.update(id, patch))
  )
  handle(WORK_TODOS_CHANNELS.delete, (id: string) => wrap(() => todos.delete(id)))
  handle(WORK_TODOS_CHANNELS.complete, (id: string) => wrap(() => todos.complete(id)))
  handle(WORK_TODOS_CHANNELS.uncomplete, (id: string) => wrap(() => todos.uncomplete(id)))
  handle(WORK_TODOS_CHANNELS.confirm, (id: string) => wrap(() => todos.confirm(id)))
  handle(WORK_TODOS_CHANNELS.ignore, (id: string) => wrap(() => todos.ignore(id)))
  handle(WORK_TODOS_CHANNELS.confirmBatch, (ids: string[]) => wrap(() => todos.confirmBatch(ids)))
  handle(WORK_TODOS_CHANNELS.ignoreBatch, (ids: string[]) => wrap(() => todos.ignoreBatch(ids)))

  // ── records（Commit 03）──
  handle(WORK_RECORDS_CHANNELS.list, (params: ListRecordsParams) => wrap(() => records.list(params ?? {})))
  handle(WORK_RECORDS_CHANNELS.get, (id: string) => wrap(() => records.get(id)))
  handle(WORK_RECORDS_CHANNELS.create, (input: CreateRecordInput) => wrap(() => records.create(input)))
  handle(WORK_RECORDS_CHANNELS.update, (id: string, patch: UpdateRecordInput) =>
    wrap(() => records.update(id, patch))
  )
  handle(WORK_RECORDS_CHANNELS.delete, (id: string) => wrap(() => records.delete(id)))
  handle(WORK_RECORDS_CHANNELS.confirm, (id: string, patch: UpdateRecordInput) =>
    wrap(() => records.confirm(id, patch ?? {}))
  )
  handle(WORK_RECORDS_CHANNELS.ignore, (id: string) => wrap(() => records.ignore(id)))
  handle(WORK_RECORDS_CHANNELS.restore, (id: string) => wrap(() => records.restore(id)))
  handle(WORK_RECORDS_CHANNELS.confirmBatch, (ids: string[]) => wrap(() => records.confirmBatch(ids)))
  handle(WORK_RECORDS_CHANNELS.ignoreBatch, (ids: string[]) => wrap(() => records.ignoreBatch(ids)))
  handle(WORK_RECORDS_CHANNELS.listFiltered, (params: { date?: string; limit?: number }) =>
    wrap(() => records.listFiltered(params ?? {}))
  )
  // 候选入队：产出型 AI 动作调用（去重 + 质量门槛都在 Manager 内）
  handle(WORK_RECORDS_CHANNELS.proposeCandidate, (input: ProposeCandidateInput) =>
    wrap(() => records.proposeCandidate(input))
  )
}
