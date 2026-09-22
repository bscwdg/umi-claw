// work/contextManager.ts —— Context 只读快照服务（PLAN-3.0.md §14 B1 / §六）
//
// 把 ContextEngine 的产物收敛为 B1 通道允许的**只读**视图：
//   { memory_snapshot, inputs, dropped }
// 绝不暴露 prompt 全文 / 模型参数 / GATEWAY_TOKEN（硬规则 3）。
//
// scope（§14.1）：
//   latest → 当场组一个 'latest' Pack（最近一次工作记忆）
//   qa     → 读 conversations.metadata.contextSnapshot（id=runId，Commit 07 写入）
//   report → 读 reports.generation_context 最近一次 generation 的快照（id=reportId，Commit 06 写入）
//
// qa/report 缺 id → VALIDATION_ERROR；id 有但快照不存在 → NOT_FOUND。
//
// 本模块不 import electron；依赖注入（DatabaseClient / ContextEngine），纯 Node 可测。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import {
  type ContextPack,
  type SnapshotScope,
  SNAPSHOT_SCOPES
} from './contextEngine'

/** B1 只读快照（渲染端唯一可见形状） */
export interface ContextSnapshotView {
  scope: SnapshotScope
  builtAt: number
  /** 当时 Pack 的组成（摘要级，无 prompt 全文） */
  memory_snapshot: MemorySnapshot
  /** 本次输入副本 */
  inputs: {
    task: string
    query: string | null
    conversationKey: string | null
    anchorDate: string | null
  }
  /** 被裁剪 / 过滤 / 未注入的条目（含原因） */
  dropped: Array<{ id: string; title: string; section: number; reason: string }>
}

export interface MemorySnapshot {
  profileSummary: string | null
  matters: Array<{ id: string; name: string }>
  todos: Array<{ id: string; title: string; dueDate: string | null }>
  records: Array<{ id: string; occurredDate: string; content: string }>
  knowledge: Array<{ id: string; title: string; type: string; truncated: boolean }>
  historyCount: number
  retrievalMode: string
  budget: {
    mode: string
    usedTokens: number
    budgetTokens: number
    knowledgeIncluded: number
    knowledgeTotal: number
  }
}

export interface SnapshotRequest {
  scope: SnapshotScope | string
  id?: string
}

export interface ContextManagerOptions {
  database: DatabaseClient
  /** latest scope 用它当场组 Pack；由主进程注入同一个 ContextEngine 单例 */
  buildLatestPack: () => Promise<ContextPack>
  logger?: (message: string) => void
}

export class ContextManager {
  private readonly database: DatabaseClient
  private readonly buildLatestPack: () => Promise<ContextPack>

  constructor(options: ContextManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextManager 缺少依赖: database')
    }
    if (typeof options.buildLatestPack !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextManager 缺少依赖: buildLatestPack')
    }
    this.database = options.database
    this.buildLatestPack = options.buildLatestPack
  }

  async snapshot(request: SnapshotRequest): Promise<ContextSnapshotView> {
    const scope = request?.scope
    if (!SNAPSHOT_SCOPES.includes(scope as SnapshotScope)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法 scope: ${String(scope)}`, { field: 'scope' })
    }
    if (scope === 'latest') {
      const pack = await this.buildLatestPack()
      return toView(pack, scope)
    }
    // qa / report：id 必填
    const id = typeof request?.id === 'string' ? request.id.trim() : ''
    if (!id) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `scope=${scope} 必须提供 id（qa=runId，report=reportId）`,
        { field: 'id' }
      )
    }
    if (scope === 'qa') return this.readQaSnapshot(id)
    return this.readReportSnapshot(id)
  }

  /** QA：runId → conversations.metadata.contextSnapshot（B1 口径） */
  private async readQaSnapshot(runId: string): Promise<ContextSnapshotView> {
    const rows = await this.database.request<Array<Record<string, unknown>>>('conversations.list', {
      where: { run_id: runId },
      limit: 10
    })
    for (const row of rows) {
      if (!row.metadata) continue
      const view = parseSnapshotMeta(String(row.metadata), 'qa')
      if (view) return view
    }
    throw new AppError(ERROR_CODES.NOT_FOUND, `找不到该问答的上下文快照: ${runId}`)
  }

  /** 报告：reportId → reports.generation_context 最近一次 generation 的快照 */
  private async readReportSnapshot(reportId: string): Promise<ContextSnapshotView> {
    const row = await this.database.request<Record<string, unknown> | null>('reports.get', {
      keys: { id: reportId }
    })
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, `报告不存在: ${reportId}`)
    if (!row.generation_context) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `该报告没有可回看的生成快照: ${reportId}`)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(row.generation_context)) as Record<string, unknown>
    } catch {
      throw new AppError(ERROR_CODES.DB_ERROR, `报告 generation_context 已损坏: ${reportId}`)
    }
    const generations = Array.isArray(parsed.generations) ? parsed.generations : []
    for (let i = generations.length - 1; i >= 0; i--) {
      const snap = (generations[i] as Record<string, unknown>)?.contextSnapshot
      if (snap && typeof snap === 'object') {
        return hydrateStored(snap as Partial<ContextSnapshotView>, 'report')
      }
    }
    throw new AppError(ERROR_CODES.NOT_FOUND, `该报告的生成快照中没有上下文视图: ${reportId}`)
  }
}

/** Pack → B1 只读视图（实时） */
export function toView(pack: ContextPack, scope: SnapshotScope): ContextSnapshotView {
  return {
    scope,
    builtAt: pack.builtAt,
    memory_snapshot: {
      profileSummary: pack.profileSummary?.text ?? null,
      matters: pack.matters.map((m) => ({ id: m.id, name: m.name })),
      todos: pack.todos.map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate })),
      records: pack.records.map((r) => ({ id: r.id, occurredDate: r.occurredDate, content: r.content })),
      knowledge: pack.knowledge.map((k) => ({ id: k.id, title: k.title, type: k.type, truncated: k.truncated })),
      historyCount: pack.history.length,
      retrievalMode: pack.retrieval.mode,
      budget: {
        mode: pack.budget.mode,
        usedTokens: pack.budget.usedTokens,
        budgetTokens: pack.budget.budgetTokens,
        knowledgeIncluded: pack.budget.knowledgeIncluded,
        knowledgeTotal: pack.budget.knowledgeTotal
      }
    },
    inputs: {
      task: pack.task,
      query: pack.retrieval.query,
      conversationKey: pack.conversationKey,
      anchorDate: null
    },
    dropped: pack.dropped.map((d) => ({ id: d.id, title: d.title, section: d.section, reason: d.reason }))
  }
}

function parseSnapshotMeta(raw: string, scope: SnapshotScope): ContextSnapshotView | null {
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>
    if (!meta.contextSnapshot || typeof meta.contextSnapshot !== 'object') return null
    return hydrateStored(meta.contextSnapshot as Partial<ContextSnapshotView>, scope)
  } catch {
    return null
  }
}

/** 校验存储的快照形状（缺字段视为损坏 → 跳过/报错，不返回半成品） */
function hydrateStored(raw: Partial<ContextSnapshotView>, scope: SnapshotScope): ContextSnapshotView {
  if (!raw.memory_snapshot || !raw.inputs || !Array.isArray(raw.dropped)) {
    throw new AppError(ERROR_CODES.DB_ERROR, `存储的上下文快照形状不完整（scope=${scope}）`)
  }
  return {
    scope,
    builtAt: Number(raw.builtAt ?? 0),
    memory_snapshot: raw.memory_snapshot as MemorySnapshot,
    inputs: raw.inputs as ContextSnapshotView['inputs'],
    dropped: raw.dropped as ContextSnapshotView['dropped']
  }
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
  return new ContextManager(options)
}
