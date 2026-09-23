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

import { ipcMain, dialog, BrowserWindow } from 'electron'
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
import type { ContextManager, SnapshotRequest } from '../work/contextManager'
import type { RouterManager } from '../work/routerManager'
import type { TodayManager } from '../work/todayManager'
import type { ReportManager } from '../work/reportManager'
import type { QaManager } from '../work/qaManager'
import type { ToolManager } from '../work/toolManager'
import type { KnowledgeManager } from '../work/knowledgeManager'
import type { WizardManager } from '../work/wizardManager'
import type { ReminderManager, ReminderId } from '../work/reminderManager'
import { forwardGatewayStream } from '../gatewayClient'

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

/** Commit 04：只读 Context 快照（§14 B1） */
export const WORK_CONTEXT_CHANNELS = {
  snapshot: 'work:context:snapshot'
} as const

/** Commit 05：今日聚合 + 一句话路由（B3 永不失败） */
export const WORK_TODAY_CHANNELS = {
  get: 'work:today:get'
} as const
export const WORK_ROUTER_CHANNELS = {
  route: 'work:router:route'
} as const

/** Commit 06：报告流（§14 reports；generate/regenerate 走 SSE） */
export const WORK_REPORTS_CHANNELS = {
  list: 'work:reports:list',
  get: 'work:reports:get',
  aggregate: 'work:reports:aggregate',
  generate: 'work:reports:generate',
  abortGenerate: 'work:reports:abortGenerate',
  saveDraft: 'work:reports:saveDraft',
  confirm: 'work:reports:confirm',
  regenerate: 'work:reports:regenerate',
  versions: 'work:reports:versions'
} as const

/** Commit 07：工作问答 + 工具箱（§14 qa/tools） */
export const WORK_QA_CHANNELS = {
  ask: 'work:qa:ask',
  abortAsk: 'work:qa:abortAsk'
} as const
export const WORK_TOOLS_CHANNELS = {
  list: 'work:tools:list',
  run: 'work:tools:run',
  abortRun: 'work:tools:abortRun'
} as const

/** Commit 08：工作知识库（§14 knowledge） */
export const WORK_KNOWLEDGE_CHANNELS = {
  list: 'work:knowledge:list',
  get: 'work:knowledge:get',
  create: 'work:knowledge:create',
  update: 'work:knowledge:update',
  delete: 'work:knowledge:delete',
  search: 'work:knowledge:search',
  import: 'work:knowledge:import',
  pickFile: 'work:knowledge:pickFile'
} as const

/** Commit 09：冷启动向导 + 本地提醒（§八 / §14；无渲染端新增读通道之外的东西） */
export const WORK_WIZARD_CHANNELS = {
  status: 'work:wizard:status',
  grantConsent: 'work:wizard:grantConsent',
  complete: 'work:wizard:complete',
  decide: 'work:wizard:decide',
  readMapping: 'work:wizard:readMapping'
} as const
export const WORK_REMINDER_CHANNELS = {
  setEnabled: 'work:reminder:setEnabled',
  check: 'work:reminder:check'
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

/** 需要 IpcMainInvokeEvent（拿 sender 转发 SSE）的 handle */
function handleEvent(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<WorkIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => fn(event, ...args))
}

export interface WorkIpcDeps {
  profile: ProfileManager
  matters: MatterManager
  todos: TodoManager
  records: RecordManager
  context: ContextManager
  today: TodayManager
  router: RouterManager
  reports: ReportManager
  qa: QaManager
  tools: ToolManager
  knowledge: KnowledgeManager
  wizard: WizardManager
  reminder: ReminderManager
}

/** 注册 work 域 IPC（Commit 02：profile / matters / todos） */
export function registerWorkIpc(deps: WorkIpcDeps): void {
  const { profile, matters, todos, records, context, today, router, reports, qa, tools, knowledge, wizard, reminder } = deps

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

  // ── context（Commit 04：只读快照，B1；不暴露 prompt/凭据）──
  handle(WORK_CONTEXT_CHANNELS.snapshot, (request: SnapshotRequest) =>
    wrap(() => context.snapshot(request ?? {}))
  )

  // ── today / router（Commit 05）──
  handle(WORK_TODAY_CHANNELS.get, (date?: string) => wrap(() => today.get(date)))
  // B3：router 永不失败，但仍包成功信封（错误信封路径走不到）
  handle(WORK_ROUTER_CHANNELS.route, (input: string) => wrap(async () => router.route(input)))

  // ── reports（Commit 06）──
  handle(WORK_REPORTS_CHANNELS.list, (params) => wrap(() => reports.list(params ?? {})))
  handle(WORK_REPORTS_CHANNELS.get, (id: string) => wrap(() => reports.get(id)))
  // 确定性事实聚合（不调模型）
  handle(WORK_REPORTS_CHANNELS.aggregate, (params: { type: 'daily' | 'weekly'; period?: string }) =>
    wrap(() => reports.aggregate(params?.type, params?.period))
  )
  handle(WORK_REPORTS_CHANNELS.saveDraft, (id: string, content: string) =>
    wrap(() => reports.saveDraft(id, content))
  )
  handle(WORK_REPORTS_CHANNELS.confirm, (id: string) => wrap(() => reports.confirm(id)))
  handle(WORK_REPORTS_CHANNELS.versions, (id: string) => wrap(() => reports.versions(id)))
  handle(WORK_REPORTS_CHANNELS.abortGenerate, (runId: string) =>
    wrap(() => reports.abortGenerate(runId))
  )
  // generate：返回 runId，同时把 SSE 转发给渲染端（B2：runId 即流 ID）
  handleEvent(WORK_REPORTS_CHANNELS.generate, async (event, params: { type: 'daily' | 'weekly'; period?: string }) => {
    try {
      const runHandle = await reports.generate(params ?? { type: 'daily' })
      forwardGatewayStream(event.sender, runHandle.runId, runHandle.stream)
      return {
        ok: true,
        data: { runId: runHandle.runId, reportId: runHandle.reportId, version: runHandle.version }
      }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })
  handleEvent(WORK_REPORTS_CHANNELS.regenerate, async (event, id: string) => {
    try {
      const runHandle = await reports.regenerate(id)
      forwardGatewayStream(event.sender, runHandle.runId, runHandle.stream)
      return {
        ok: true,
        data: { runId: runHandle.runId, reportId: runHandle.reportId, version: runHandle.version }
      }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })

  // ── qa / tools（Commit 07）──
  handleEvent(WORK_QA_CHANNELS.ask, async (event, params: { question: string; conversationKey?: string }) => {
    try {
      const runHandle = await qa.ask(params ?? { question: '' })
      forwardGatewayStream(event.sender, runHandle.runId, runHandle.stream)
      return { ok: true, data: { runId: runHandle.runId, conversationKey: runHandle.conversationKey } }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })
  handle(WORK_QA_CHANNELS.abortAsk, (runId: string) => wrap(() => qa.abortAsk(runId)))

  handle(WORK_TOOLS_CHANNELS.list, () => wrap(async () => tools.list()))
  handleEvent(WORK_TOOLS_CHANNELS.run, async (event, params: { toolId: string; text: string; conversationKey?: string; instruction?: string }) => {
    try {
      const runHandle = tools.run(params ?? { toolId: '', text: '' })
      forwardGatewayStream(event.sender, runHandle.runId, runHandle.stream)
      return {
        ok: true,
        data: { runId: runHandle.runId, toolId: runHandle.toolId, conversationKey: runHandle.conversationKey }
      }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })
  handle(WORK_TOOLS_CHANNELS.abortRun, (runId: string) => wrap(() => tools.abortRun(runId)))

  // ── knowledge（Commit 08）──
  handle(WORK_KNOWLEDGE_CHANNELS.list, (params: { status?: string; limit?: number }) =>
    wrap(() => knowledge.list(params ?? {}))
  )
  handle(WORK_KNOWLEDGE_CHANNELS.get, (id: string) => wrap(() => knowledge.get(id)))
  handle(WORK_KNOWLEDGE_CHANNELS.create, (input: unknown) => wrap(() => knowledge.create(input as never)))
  handle(WORK_KNOWLEDGE_CHANNELS.update, (id: string, patch: unknown) =>
    wrap(() => knowledge.update(id, patch as never))
  )
  handle(WORK_KNOWLEDGE_CHANNELS.delete, (id: string) => wrap(() => knowledge.delete(id)))
  handle(WORK_KNOWLEDGE_CHANNELS.search, (query: string, limit?: number) =>
    wrap(() => knowledge.search(query, limit))
  )
  handle(WORK_KNOWLEDGE_CHANNELS['import'], (input: unknown) =>
    wrap(() => knowledge.importKnowledge(input as never))
  )
  // pickFile：主进程原生文件选择（硬规则 23：渲染端只能拿这里的返回路径）
  handle(WORK_KNOWLEDGE_CHANNELS.pickFile, async (expectedType?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const filters =
      expectedType === 'docx'
        ? [{ name: 'Word', extensions: ['docx'] }]
        : expectedType === 'xlsx'
          ? [{ name: 'Excel', extensions: ['xlsx'] }]
          : expectedType === 'pdf'
            ? [{ name: 'PDF', extensions: ['pdf'] }]
            : [
                { name: '可导入文件', extensions: ['docx', 'xlsx', 'pdf', 'txt', 'md'] }
              ]
    const result = await (win
      ? dialog.showOpenDialog(win, {
          title: '选择要导入的文件',
          properties: ['openFile'],
          filters
        })
      : dialog.showOpenDialog({
          title: '选择要导入的文件',
          properties: ['openFile'],
          filters
        }))
    if (result.canceled || !result.filePaths.length) return { canceled: true } as never
    const filePath = result.filePaths[0]
    const name = filePath.split(/[\\/]/).pop() ?? ''
    return { canceled: false, filePath, name } as never
  })

  // ── wizard（Commit 09：冷启动状态 + 旧库三分支）──
  handle(WORK_WIZARD_CHANNELS.status, () => wrap(() => wizard.status()))
  handle(WORK_WIZARD_CHANNELS.grantConsent, () => wrap(() => wizard.grantConsent()))
  handle(WORK_WIZARD_CHANNELS.complete, () => wrap(() => wizard.complete()))
  handle(WORK_WIZARD_CHANNELS.decide, (decision: string) => wrap(() => wizard.decide(decision as never)))
  handle(WORK_WIZARD_CHANNELS.readMapping, () => wrap(() => wizard.readMapping()))

  // ── reminder（Commit 09：两个固定通知开关 + 手动检查）──
  handle(WORK_REMINDER_CHANNELS.setEnabled, (id: ReminderId, enabled: boolean) =>
    wrap(() => reminder.setEnabled(id, enabled))
  )
  handle(WORK_REMINDER_CHANNELS.check, () => wrap(() => reminder.check()))
}
