// projectManager.ts —— Project CRUD + conversation_key 生成 + 切换持久化（PLAN-2.0.md Commit 03）
//
// 契约（§一 / §二 硬规则 9 / §四 / §五 / §六 / §十）：
//   - Project = 一个独立商家 / 品牌 / 门店的 AI 工作空间（不是一次性活动）
//   - 每个业务方法**显式接收 projectId**，绝不读全局 currentProject 做隐式推断
//   - `conversation_key` 在创建时生成（uuid），随行持久化，**生命周期内不变**；
//     OpenClaw 会话隔离 user = `conv:<projectId>:<conversation_key>`（§六）
//   - `current_project_id` 存 `app_meta`（白名单键），本模块是它唯一的读写方
//   - 删除语义**逐字**按 §十「删除 Project（v1.10 修订）」：
//       先删 `data/projects/<id>/` 目录（占用失败重试并记日志）→ 再删 DB 行（级联清结构化数据）
//       删行失败**不声称成功**：保留 DB 行、报错、支持幂等重试（目录已不存在则直接删行）
//       物理删除，无软删
//
// 设计约束：本模块**不 import electron**，依赖（DatabaseClient / dataDir / logger）全部注入，
// 因此在纯 Node 下可被 esbuild bundle 后直接测试（test/project.accept.mjs）。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, ERROR_CODES, errorCodeOf } from '../database/errors'
import type { DatabaseClient } from '../database/database'

/** `app_meta` 中存放「当前 Project」的键名（§四 app_meta 白名单内） */
export const CURRENT_PROJECT_META_KEY = 'current_project_id'

/** 新建 Project 的初始状态 */
export const PROJECT_STATUS_ACTIVE = 'active'

/** `data/projects/<id>/` 相对 data 目录的位置（§三 目录策略；Commit 05 存原文用） */
export const PROJECTS_SUBDIR = 'projects'

/** 允许 update 的字段白名单（禁止改 id / conversation_key / created_at / status） */
export const PROJECT_UPDATABLE_FIELDS = ['name', 'industry', 'description'] as const
export type ProjectUpdatableField = (typeof PROJECT_UPDATABLE_FIELDS)[number]

export const DEFAULT_DIR_REMOVE_RETRIES = 3
export const DEFAULT_DIR_REMOVE_RETRY_DELAY_MS = 150

/** projects 表一行（与 §四 DDL / db-worker.mjs 的 projects 白名单一一对应） */
export interface ProjectRow {
  id: string
  name: string
  industry: string | null
  description: string | null
  status: string
  /** 会话隔离键：user = conv:<projectId>:<conversation_key> */
  conversation_key: string
  created_at: number
  updated_at: number
}

export interface CreateProjectInput {
  name: string
  industry?: string | null
  description?: string | null
}

export type UpdateProjectInput = Partial<{
  name: string
  industry: string | null
  description: string | null
}>

/** deleteProject 的返回：描述这次删除真实做了什么（供 UI / 日志核对） */
export interface DeleteProjectResult {
  id: string
  /** 本次是否真的删除了目录（false = 目录本就不存在，幂等重试路径） */
  dirRemoved: boolean
  /** DB 行是否已删除（只有成功才返回；失败一律抛错，不返回 false） */
  rowDeleted: boolean
  /** 被删的正好是当前 Project 时，是否成功清空了 current_project_id */
  currentCleared: boolean
}

export interface ProjectManagerOptions {
  /** DB Worker 客户端（唯一的数据访问通道，硬规则 8） */
  database: DatabaseClient
  /** 应用数据目录（约定 `.../data`）；本项目只在该目录下操作 `projects/` 子目录 */
  dataDir: string
  /** 日志（默认静默）；删除重试、幂等路径、孤儿指针自愈都走这里 */
  logger?: (message: string) => void
  /** 目录删除重试次数，默认 3 */
  dirRemoveRetries?: number
  /** 每次重试间隔，默认 150ms */
  dirRemoveRetryDelayMs?: number
}

export class ProjectManager {
  private readonly database: DatabaseClient
  private readonly dataDir: string
  private readonly logger?: (message: string) => void
  private readonly dirRemoveRetries: number
  private readonly dirRemoveRetryDelayMs: number

  constructor(options: ProjectManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ProjectManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ProjectManager 缺少依赖: database')
    }
    if (typeof options.dataDir !== 'string' || !options.dataDir) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ProjectManager 缺少依赖: dataDir')
    }
    this.database = options.database
    this.dataDir = options.dataDir
    this.logger = options.logger
    this.dirRemoveRetries = Math.max(1, Number(options.dirRemoveRetries) || DEFAULT_DIR_REMOVE_RETRIES)
    this.dirRemoveRetryDelayMs = Math.max(
      0,
      options.dirRemoveRetryDelayMs === undefined
        ? DEFAULT_DIR_REMOVE_RETRY_DELAY_MS
        : Number(options.dirRemoveRetryDelayMs)
    )
  }

  // ── 只读辅助 ────────────────────────────────────────────────────────────────

  /** `data/projects/<id>/`（本模块是这段路径的唯一生产方） */
  projectDir(projectId: string): string {
    return join(this.dataDir, PROJECTS_SUBDIR, requireId(projectId, 'projectDir'))
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 列表 / 单条 ─────────────────────────────────────────────────────────────

  /** 全量 Project（按创建时间升序，同刻按 id 收敛；排序不稳定会让 UI 抖动） */
  async listProjects(): Promise<ProjectRow[]> {
    const rows = await this.database.request<ProjectRow[]>('projects.list', {
      order: ['created_at', 'id']
    })
    return Array.isArray(rows) ? rows : []
  }

  /** 单条；不存在 → NOT_FOUND（不返回 null，避免调用方误把 undefined 当「无数据」） */
  async getProject(projectId: string): Promise<ProjectRow> {
    const id = requireId(projectId, 'getProject')
    const row = await this.database.request<ProjectRow | null>('projects.get', { keys: { id } })
    if (!row) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Project 不存在: ${id}`, { projectId: id })
    }
    return row
  }

  // ── 创建 ────────────────────────────────────────────────────────────────────

  /**
   * 新建 Project：生成 id 与 conversation_key（均 uuid v4），写 created_at/updated_at，
   * 并顺手建好 `data/projects/<id>/` 目录（Commit 05 存原文用）。
   *
   * 顺序：先建目录 → 再插行；插行失败则回滚刚建的目录。
   * 理由：DB 行是唯一真相来源，孤儿**行**（无目录）可被后续懒建目录修复，
   * 而孤儿**目录**对用户不可见、永远没人清，属于净泄漏。
   */
  async createProject(input: CreateProjectInput): Promise<ProjectRow> {
    const name = requireName(input?.name)
    const industry = optionalText(input?.industry)
    const description = optionalText(input?.description)

    const id = randomUUID()
    const now = Date.now()
    const dir = this.projectDir(id)
    const createdDir = this.ensureProjectDir(dir)

    const data = {
      id,
      name,
      industry,
      description,
      status: PROJECT_STATUS_ACTIVE,
      // conversation_key：创建时生成、随行持久化、生命周期内不变（§六）
      conversation_key: randomUUID(),
      created_at: now,
      updated_at: now
    }

    try {
      const res = await this.database.request<{ row: ProjectRow }>('projects.create', { data })
      this.log(`[project] 已创建 ${id}（${name}），目录=${dir}`)
      return res?.row ?? ((await this.getProject(id)) as ProjectRow)
    } catch (e) {
      if (createdDir) {
        // 回滚刚建的目录，避免留下不可见的孤儿目录（尽力而为，失败不掩盖原始错误）
        try {
          rmSync(dir, { recursive: true, force: true })
          this.log(`[project] 插行失败，已回滚目录: ${dir}`)
        } catch (cleanupError) {
          this.log(`[project] 回滚目录失败（需人工清理）: ${dir} — ${errorText(cleanupError)}`)
        }
      }
      // 保留上游错误码（SETUP_REQUIRED 不能被吞成 DB_ERROR，前端要据此引导去环境初始化）
      if (errorCodeOf(e)) throw e
      throw new AppError(ERROR_CODES.DB_ERROR, `创建 Project 失败: ${errorText(e)}`)
    }
  }

  // ── 更新 ────────────────────────────────────────────────────────────────────

  /**
   * 更新白名单字段（name / industry / description），刷新 updated_at。
   * **conversation_key / id / created_at 一律不可改**：未知字段直接 VALIDATION_ERROR
   * （渲染端传错字段要炸在入口，不能静默丢弃——静默丢弃会让「改了但没生效」变成幽灵 bug）。
   */
  async updateProject(projectId: string, patch: UpdateProjectInput): Promise<ProjectRow> {
    const id = requireId(projectId, 'updateProject')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'updateProject 需要一个 patch 对象', { field: 'patch' })
    }

    const unknown = Object.keys(patch).filter(
      (k) => !(PROJECT_UPDATABLE_FIELDS as readonly string[]).includes(k)
    )
    if (unknown.length) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `不允许更新的字段: ${unknown.join(', ')}（可更新: ${PROJECT_UPDATABLE_FIELDS.join(', ')}）`,
        { fields: unknown, allowed: [...PROJECT_UPDATABLE_FIELDS] }
      )
    }

    const data: Record<string, unknown> = {}
    if ('name' in patch) data.name = requireName(patch.name)
    if ('industry' in patch) data.industry = optionalText(patch.industry)
    if ('description' in patch) data.description = optionalText(patch.description)

    // 空 patch：不改任何东西，也就不该刷新 updated_at（避免无意义的写入与时间戳漂移）
    if (!Object.keys(data).length) {
      return this.getProject(id)
    }

    // 先确认存在：拿 NOT_FOUND，而不是 0 行更新的静默成功
    await this.getProject(id)

    data.updated_at = Date.now()
    await this.database.request('projects.update', { keys: { id }, data })
    return this.getProject(id)
  }

  // ── 删除（§十 逐字实现） ────────────────────────────────────────────────────

  /**
   * 删除 Project：**先删目录 → 再删 DB 行**（§十）。
   *
   * - 目录删除最终失败 → 抛 DB_ERROR + `details.reason='project-dir-remove-failed'`，
   *   **DB 行不动**（用户看到「删除失败」，可以重试；绝不让结构化数据与目录状态分叉）
   * - 目录已不存在（上次重试删掉了目录、行没删成）→ 直接删行，幂等
   * - 删行失败 → **不声称成功**：抛错并带 `details.reason='db-row-delete-failed'`，
   *   DB 行保留（SQLite 保证），用户再点一次「重试删除」即可
   * - 删掉的正好是当前 Project → 清空 `current_project_id`（理由见 setCurrentProject 注释）
   */
  async deleteProject(projectId: string): Promise<DeleteProjectResult> {
    const id = requireId(projectId, 'deleteProject')
    // 不存在 → NOT_FOUND（别把「已删过」当成功，UI 需要区分）
    await this.getProject(id)
    // 「当前 Project」必须在删行**之前**取：删行之后 current_project_id 就指向一个不存在的 row，
    // 再读只会走悬空自愈路径，拿不到「原本指向谁」这个事实。
    const currentBefore = await this.getCurrentProject()

    const dir = this.projectDir(id)
    let dirRemoved = false
    if (existsSync(dir)) {
      // 目录删除失败会直接抛出 DB_ERROR，DB 行保持不动
      await this.removeProjectDir(dir, id)
      dirRemoved = true
    } else {
      this.log(`[project] 目录不存在，直接删行（幂等重试路径）: ${dir}`)
    }

    try {
      const res = await this.database.request<{ changes: number }>('projects.delete', {
        keys: { id }
      })
      if (Number(res?.changes ?? 0) < 1) {
        // 理论上不会发生（上面刚 getProject 过）；发生了就是并发删除，按 NOT_FOUND 报
        throw new AppError(ERROR_CODES.NOT_FOUND, `Project 已被删除: ${id}`, { projectId: id })
      }
    } catch (e) {
      // 目录已删但行没删掉：明说现状 + 幂等重试指引，绝不假装成功
      throw new AppError(
        errorCodeOf(e) ?? ERROR_CODES.DB_ERROR,
        `Project 目录已删除，但数据库行删除失败: ${id}；请重试删除（幂等）`,
        {
          reason: 'db-row-delete-failed',
          projectId: id,
          path: dir,
          cause: errorText(e)
        }
      )
    }

    // 级联清理（businesses / knowledge_items / …）由 SQLite ON DELETE CASCADE 负责，
    // 此处校验一次作为「真的级联了」的证据，失败只记日志（不反转已成功的删除）。
    await this.assertCascadeSettled(id)

    let currentCleared = false
    if (currentBefore?.id === id) {
      try {
        await this.setCurrentProject(null)
        currentCleared = true
        this.log(`[project] 已删除当前 Project，current_project_id 已清空: ${id}`)
      } catch (e) {
        // 行已物理删除，此处失败不能反过来报「删除失败」；残留的悬空指针由
        // getCurrentProject() 的自愈逻辑在下次读取时清掉（见该方法注释）
        this.log(`[project] 清空 current_project_id 失败（下次读取会自愈）: ${errorText(e)}`)
      }
    }

    this.log(`[project] 已删除 ${id}（目录=${dirRemoved ? '已删' : '原本不存在'}）`)
    return { id, dirRemoved, rowDeleted: true, currentCleared }
  }

  /** 删行后确认没有残留的 project 子数据（级联是否真的生效的可执行证据） */
  private async assertCascadeSettled(id: string): Promise<void> {
    try {
      for (const table of ['businesses', 'knowledge_items'] as const) {
        const res = await this.database.request<{ count: number }>(`${table}.count`, {
          where: { project_id: id }
        })
        const left = Number(res?.count ?? 0)
        if (left > 0) {
          this.log(`[project] ⚠️ ${table} 仍残留 ${left} 行 project_id=${id}（级联未清空）`)
        }
      }
    } catch (e) {
      this.log(`[project] 级联校验跳过: ${errorText(e)}`)
    }
  }

  /**
   * 删除 `data/projects/<id>/`：失败重试 + 记日志；重试用尽仍失败 → DB_ERROR。
   *
   * Windows 上目录/文件被占用（别的进程持句柄）会让 recursive remove 抛 EBUSY/EPERM，
   * 这类占用往往是瞬时的（杀毒扫描、索引器），所以重试是有效策略而非走过场。
   */
  private async removeProjectDir(dir: string, projectId: string): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= this.dirRemoveRetries; attempt++) {
      if (!existsSync(dir)) return // 幂等：已不存在即视为成功
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 0 })
        if (!existsSync(dir)) {
          if (attempt > 1) this.log(`[project] 目录删除在第 ${attempt} 次重试后成功: ${dir}`)
          return
        }
        lastError = new Error('rmSync 返回但目录仍然存在')
      } catch (e) {
        lastError = e
      }
      this.log(
        `[project] 删除 Project 目录失败（第 ${attempt}/${this.dirRemoveRetries} 次）: ${dir} — ${errorText(lastError)}`
      )
      if (attempt < this.dirRemoveRetries) await delay(this.dirRemoveRetryDelayMs)
    }
    throw new AppError(
      ERROR_CODES.DB_ERROR,
      `无法删除 Project 目录（可能被其他程序占用），已保留数据库记录，可稍后重试: ${dir}`,
      {
        reason: 'project-dir-remove-failed',
        path: dir,
        projectId,
        attempts: this.dirRemoveRetries,
        cause: errorText(lastError)
      }
    )
  }

  // ── 当前 Project（app_meta.current_project_id） ─────────────────────────────

  /**
   * 读取当前 Project。
   *
   * 自愈：元数据指向一个已不存在的 project（例如手工改过库、或上次清空失败）时，
   * 清空该指针并返回 null —— 悬空指针会让 UI 与 §六 的 user=conv:<projectId>:<key>
   * 拼装到一个不存在的 projectId 上，宁可当作「未选择」。
   */
  async getCurrentProject(): Promise<ProjectRow | null> {
    const raw = await this.database.metaGet(CURRENT_PROJECT_META_KEY)
    const id = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    if (!id) return null
    try {
      return await this.getProject(id)
    } catch (e) {
      if (errorCodeOf(e) === ERROR_CODES.NOT_FOUND) {
        this.log(`[project] current_project_id 指向已不存在的 Project（${id}），已清空`)
        try {
          await this.setCurrentProject(null)
        } catch (clearError) {
          this.log(`[project] 清空悬空 current_project_id 失败: ${errorText(clearError)}`)
        }
        return null
      }
      throw e
    }
  }

  /**
   * 设置当前 Project（null = 清空）。
   *
   * 校验 projectId 必须存在（NOT_FOUND）——写一个不存在的 id 只会制造悬空指针。
   * 清空时写 `null` 而不是删行：`app_meta` 是单值键，保留行语义更直观（key 仍可被 count/list 看到）。
   */
  async setCurrentProject(projectId: string | null): Promise<{ currentProjectId: string | null }> {
    if (projectId === null || projectId === undefined) {
      await this.database.metaSet(CURRENT_PROJECT_META_KEY, null)
      this.log('[project] 已清空 current_project_id')
      return { currentProjectId: null }
    }
    const id = requireId(projectId, 'setCurrentProject')
    const project = await this.getProject(id)
    await this.database.metaSet(CURRENT_PROJECT_META_KEY, project.id)
    this.log(`[project] 当前 Project = ${project.id}（${project.name}）`)
    return { currentProjectId: project.id }
  }

  // ── 目录 ────────────────────────────────────────────────────────────────────

  /** 返回「本次是否由我创建了该目录」（用于插行失败时判断该不该回滚） */
  private ensureProjectDir(dir: string): boolean {
    if (existsSync(dir)) return false
    mkdirSync(dir, { recursive: true })
    return true
  }
}

/** 工厂（与 DatabaseClient 同风格；便于纯 Node 测试与后续 Manager 复用） */
export function createProjectManager(options: ProjectManagerOptions): ProjectManager {
  return new ProjectManager(options)
}

// ── 校验辅助（全部抛 §五 的 VALIDATION_ERROR） ────────────────────────────────

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

function requireName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project 名称不能为空', { field: 'name' })
  }
  return name
}

/** 可选文本：undefined/null → null；空串/空白 → null（避免 '' 与 null 两种「空」并存） */
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '可选字段必须是字符串', { field: typeof value })
  }
  const text = value.trim()
  return text ? text : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
