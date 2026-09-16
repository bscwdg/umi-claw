// electron/main/ipc/marketing.ts —— marketing IPC 面（PLAN-2.0.md §五）
//
// Commit 02：marketing.system = { dbStatus, ping, metaGet, metaSet }（最小面，保留不动）。
// Commit 03：追加 marketing.project = { list, get, create, update, delete } 与
//            marketing.context = { getCurrentProject, setCurrentProject }。
// business / knowledge / content / hot 的 CRUD 仍归 Commit 04+，此处**不提前实现**。
//
// 每个方法都显式传 projectId（硬规则 9），IPC 层不做任何 currentProject 推断。
//
// 失败统一信封：{ ok: false, error: { code, message, details? } }
//   - code 取自 §五 错误码表（errors.ts 的 ERROR_CODES）
//   - 渲染端**禁止**用 error.message.includes() 判断，一律按 code 分支

import { ipcMain } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { BackupResult, DatabaseClient, DatabaseStatus } from '../database/database'
import type {
  CreateProjectInput,
  DeleteProjectResult,
  ProjectManager,
  ProjectRow,
  UpdateProjectInput
} from '../marketing/projectManager'

/** IPC 统一返回信封 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_SYSTEM_CHANNELS = {
  dbStatus: 'marketing:system:dbStatus',
  ping: 'marketing:system:ping',
  metaGet: 'marketing:system:metaGet',
  metaSet: 'marketing:system:metaSet'
} as const

/** §五 project 面（Commit 03） */
export const MARKETING_PROJECT_CHANNELS = {
  list: 'marketing:project:list',
  get: 'marketing:project:get',
  create: 'marketing:project:create',
  update: 'marketing:project:update',
  delete: 'marketing:project:delete'
} as const

/** §五 context 面（Commit 03）：current_project_id 存 app_meta（白名单内） */
export const MARKETING_CONTEXT_CHANNELS = {
  getCurrentProject: 'marketing:context:getCurrentProject',
  setCurrentProject: 'marketing:context:setCurrentProject'
} as const

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(channel: string, fn: (...args: any[]) => Promise<IpcResult<unknown>>): void {
  // 防御性：重复注册会抛 "Attempted to register a second handler"，先移除
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

export function registerMarketingIpc(database: DatabaseClient, projectManager: ProjectManager): void {
  handle(MARKETING_SYSTEM_CHANNELS.dbStatus, (options?: { initialize?: boolean }) =>
    wrap<DatabaseStatus>(() => database.dbStatus(options ?? {}))
  )
  handle(MARKETING_SYSTEM_CHANNELS.ping, () =>
    wrap(() => database.ping())
  )
  handle(MARKETING_SYSTEM_CHANNELS.metaGet, (key: string) =>
    wrap(() => database.metaGet(key))
  )
  handle(MARKETING_SYSTEM_CHANNELS.metaSet, (key: string, value: string | null) =>
    wrap(() => database.metaSet(key, value))
  )

  // ── project（Commit 03） ──────────────────────────────────────────────────
  handle(MARKETING_PROJECT_CHANNELS.list, () => wrap<ProjectRow[]>(() => projectManager.listProjects()))
  handle(MARKETING_PROJECT_CHANNELS.get, (projectId: string) =>
    wrap<ProjectRow>(() => projectManager.getProject(projectId))
  )
  handle(MARKETING_PROJECT_CHANNELS.create, (input: CreateProjectInput) =>
    wrap<ProjectRow>(() => projectManager.createProject(input))
  )
  handle(MARKETING_PROJECT_CHANNELS.update, (projectId: string, patch: UpdateProjectInput) =>
    wrap<ProjectRow>(() => projectManager.updateProject(projectId, patch))
  )
  handle(MARKETING_PROJECT_CHANNELS.delete, (projectId: string) =>
    wrap<DeleteProjectResult>(() => projectManager.deleteProject(projectId))
  )

  // ── context（Commit 03） ──────────────────────────────────────────────────
  handle(MARKETING_CONTEXT_CHANNELS.getCurrentProject, () =>
    wrap<ProjectRow | null>(() => projectManager.getCurrentProject())
  )
  handle(MARKETING_CONTEXT_CHANNELS.setCurrentProject, (projectId: string | null) =>
    wrap<{ currentProjectId: string | null }>(() => projectManager.setCurrentProject(projectId))
  )
}

/** 主进程内部使用（不做 IPC 暴露）：备份链路验证与退出前清理 */
export async function withMarketingBackup(
  database: DatabaseClient,
  reason: string
): Promise<BackupResult> {
  return database.backup(reason)
}
