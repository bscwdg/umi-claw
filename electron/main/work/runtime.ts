// work/runtime.ts —— work 域各 Manager 的装配工厂（Phase 2 装箱前置）
//
// 为什么抽出来：原来这 150 行在 `main/index.ts` 的 initWorkManagers 里，直接摸 app/
// configManager/窗口通知，导致「work 域」无法整体搬进插件。这里把**构造**与
// **宿主副作用**分开：
//   - 本文件只管「用给定的 database/gateway/dataDir 造出 17 个 Manager」；
//   - 通知、外发、旧库定位、pdfjs 路径这些宿主能力由调用方注入（deps）。
// 插件化后由 plugins/work 调用它；未装箱前由 main 调用，行为不变。

import { createProfileManager, type ProfileManager } from './profileManager'
import { createMatterManager, type MatterManager } from './matterManager'
import { createTodoManager, type TodoManager } from './todoManager'
import { createRecordManager, type RecordManager } from './recordManager'
import { createContextEngine, type ContextEngine, type SnapshotScope } from './contextEngine'
import { createContextManager, type ContextManager } from './contextManager'
import { createRouterManager, type RouterManager } from './routerManager'
import { createTodayManager, type TodayManager } from './todayManager'
import { createReportManager, type ReportManager } from './reportManager'
import { createQaManager, type QaManager } from './qaManager'
import { createToolManager, type ToolManager } from './toolManager'
import { createKnowledgeManager, type KnowledgeManager } from './knowledgeManager'
import { createWizardManager, type WizardManager } from './wizardManager'
import { createReminderManager, type ReminderManager } from './reminderManager'
import {
  createOpenClawSummaryManager,
  type OpenClawSummaryManager
} from './openclawSummaryManager'
import type { GatewayClient } from '../gatewayClient'
import type { OldDbLocator, OldDbReader } from './wizardManager'
import type { Notifier, PushChannelProvider, Pusher } from './reminderManager'
export type { WorkDatabase } from './database'

import type { WorkDatabase } from './database'

/** pdfjs 运行时资产（宿主解析后注入，work 不自己摸 app 路径） */
export interface WorkPdfjsAssets {
  root: string
  cmapsDir: string
  standardFontsDir: string
  workerPath: string
  modulePath: string
}

export interface WorkRuntimeDeps {
  database: WorkDatabase
  /**
   * Gateway 客户端。插件侧传的是 `ctx.services.openclaw` 适配出来的对象，
   * 结构与 GatewayClient 的公开面一致（chat / createChatStream / getStatus / ensureReady）。
   */
  gateway: GatewayClient
  dataDir: string
  pdfjsAssets: WorkPdfjsAssets
  logger?: (message: string) => void
  /** 系统通知（提醒） */
  notifier: Notifier
  /** 渠道外发（短提示） */
  pusher: Pusher
  listPushChannels: PushChannelProvider
  listPushTargets: (channel: string) => ReturnType<PushChannelProvider> | Promise<unknown>
  locateOldDbs: OldDbLocator
  readOldDb: OldDbReader
}

export interface WorkRuntime {
  profile: ProfileManager
  matters: MatterManager
  todos: TodoManager
  records: RecordManager
  context: ContextManager
  contextEngine: ContextEngine
  today: TodayManager
  router: RouterManager
  reports: ReportManager
  qa: QaManager
  tools: ToolManager
  knowledge: KnowledgeManager
  wizard: WizardManager
  reminder: ReminderManager
  openclawSummary: OpenClawSummaryManager
}

/**
 * 构造 work 域全部 Manager（顺序敏感，别随意调整）：
 * openclawSummary 必须先于 reminder（提醒循环要用它的 runScheduled），
 * reports 必须先于 reminder（到点生成日报草稿）。
 */
export function createWorkRuntime(deps: WorkRuntimeDeps): WorkRuntime {
  const log = deps.logger ?? ((m: string) => console.log(m))
  const database = deps.database

  const profile = createProfileManager({ database })
  const matters = createMatterManager({ database })
  const todos = createTodoManager({ database })
  const records = createRecordManager({ database })

  // ContextEngine 读同一个 DB 单例；latest Pack 用 scope='latest' 当场组
  const contextEngine = createContextEngine({ database, logger: log })
  const context = createContextManager({
    database,
    buildLatestPack: () => contextEngine.buildPack('latest' as SnapshotScope, {})
  })

  const today = createTodayManager({ database })
  const router = createRouterManager()

  const reports = createReportManager({
    database,
    contextEngine,
    gateway: deps.gateway,
    logger: log
  })
  const qa = createQaManager({
    database,
    contextEngine,
    gateway: deps.gateway,
    logger: log
  })
  const tools = createToolManager({
    records,
    todos,
    gateway: deps.gateway,
    logger: log
  })

  const knowledge = createKnowledgeManager({
    database,
    dataDir: deps.dataDir,
    pdfjsAssets: deps.pdfjsAssets,
    logger: log
  })

  const openclawSummary = createOpenClawSummaryManager({
    database,
    records,
    gateway: deps.gateway,
    logger: log
  })

  const wizard = createWizardManager({
    database,
    locateOldDbs: deps.locateOldDbs,
    readOldDb: deps.readOldDb,
    logger: log
  })

  const reminder = createReminderManager({
    database,
    notifier: deps.notifier,
    getMorningSummary: async () => {
      const list = await todos.list({ state: 'confirmed' })
      const todayStr = new Date().toISOString().slice(0, 10)
      const relevant = list.filter((t) => t.due_date === null || String(t.due_date) <= todayStr)
      return { count: relevant.length, titles: relevant.map((t) => t.title) }
    },
    // 方案 A（v0.9 拍板）：按配置外发**短提示**（不含正文），正文仍需人工确认
    pusher: deps.pusher,
    listPushChannels: deps.listPushChannels,
    listPushTargets: (channel) => deps.listPushTargets(channel) as never,
    listDueTodoReminders: async () =>
      (await todos.listDueReminders()).map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.due_date,
        dueAt: t.due_at
      })),
    markTodoReminded: (id, ts) => todos.markReminded(id, ts),
    // 本地闭环（硬规则 22 重评估后拍板）：到点先自动生成日报草稿，再发通知。
    generateDailyDraft: async () => {
      try {
        const handle = await reports.generate({ type: 'daily' })
        const result = await handle.stream.result
        if (result.aborted) return { status: 'error', message: '生成已中止' }
        return { status: 'generated', reportId: handle.reportId }
      } catch (e) {
        const err = e as { details?: { reason?: string }; message?: string }
        if (err?.details?.reason === 'no-records') return { status: 'empty' }
        return { status: 'error', message: err?.message ?? '未知错误' }
      }
    },
    // v0.18：日报时刻前 30 分钟桥接 OpenClaw 总结当天工作
    summarizeDaily: () => openclawSummary.runScheduled(),
    logger: log
  })

  return {
    profile,
    matters,
    todos,
    records,
    context,
    contextEngine,
    today,
    router,
    reports,
    qa,
    tools,
    knowledge,
    wizard,
    reminder,
    openclawSummary
  }
}
