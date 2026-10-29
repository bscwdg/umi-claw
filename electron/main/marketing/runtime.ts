// marketing/runtime.ts —— marketing 域各 Manager 的装配工厂（Phase 3 装箱）
//
// 与 work/runtime.ts 同一套路：本文件只负责「用给定的 database/gateway/路径造出 Manager」，
// 宿主副作用（pdfjs 资产解析、collector 路径、便携 node）由调用方注入。

import { createProjectManager, type ProjectManager } from './projectManager'
import {
  createBusinessManager,
  createWatchlistManager,
  type BusinessManager,
  type WatchlistManager
} from './businessManager'
import { createKnowledgeManager, type KnowledgeManager } from './knowledgeManager'
import { createContextEngine, type ContextEngine } from './contextEngine'
import { createAdvisorManager, type AdvisorManager } from './advisorManager'
import { createContentManager, type ContentManager } from './contentManager'
import { createScanRecognizer, type ScanRecognizer } from './scanRecognizer'
import { createHotManager, type HotManager } from './hotManager'
import { createHotScoreManager, type HotScoreManager } from './hotScoreManager'
import type { MarketingDatabase } from './database'
import type { GatewayClient } from '../gatewayClient'

export type { MarketingDatabase } from './database'

export interface MarketingPdfjsAssets {
  root: string
  cmapsDir: string
  standardFontsDir: string
  workerPath: string
  modulePath: string
}

export interface MarketingRuntimeDeps {
  database: MarketingDatabase
  /** 全应用唯一的 GatewayClient（宿主注入适配器；插件拿不到 token） */
  gateway: GatewayClient
  dataDir: string
  pdfjsAssets: MarketingPdfjsAssets
  /** 运行 collector 的 node（与 db worker 同口径） */
  nodePath: string
  /** resources/collector/index.mjs 绝对路径 */
  collectorScriptPath: string
  /** 每次采集前读 DailyHotApi base URL（v1.22 精神：改配置不重启） */
  getDailyhotBase?: () => string | null
  /** 多模态是否已配置（扫描件识别用） */
  multimodalConfigured?: () => boolean
  logger?: (message: string) => void
}

export interface MarketingRuntime {
  projects: ProjectManager
  business: BusinessManager
  watchlist: WatchlistManager
  knowledge: KnowledgeManager
  contextEngine: ContextEngine
  advisor: AdvisorManager
  content: ContentManager
  scan: ScanRecognizer
  hot: HotManager
  hotScore: HotScoreManager
}

export function createMarketingRuntime(deps: MarketingRuntimeDeps): MarketingRuntime {
  const log = deps.logger ?? (() => undefined)

  const projects = createProjectManager({ database: deps.database, dataDir: deps.dataDir, logger: log })
  const business = createBusinessManager({ database: deps.database, logger: log })
  const watchlist = createWatchlistManager({ database: deps.database, logger: log })
  const knowledge = createKnowledgeManager({
    database: deps.database,
    dataDir: deps.dataDir,
    pdfjsAssets: deps.pdfjsAssets,
    logger: log
  })
  // §五 没有 context pack 通道：引擎产出是主进程内部数据，不注册 IPC（宿主/插件都不暴露）。
  const contextEngine = createContextEngine({
    projectManager: projects,
    businessManager: business,
    knowledgeManager: knowledge,
    watchlistManager: watchlist,
    logger: log
  })
  const advisor = createAdvisorManager({
    contextEngine,
    gateway: deps.gateway,
    watchlistManager: watchlist,
    logger: log
  })
  const content = createContentManager({
    database: deps.database,
    contextEngine,
    gateway: deps.gateway,
    logger: log
  })
  const scan = createScanRecognizer({
    gateway: deps.gateway,
    pdfjsAssets: deps.pdfjsAssets,
    multimodalConfigured: deps.multimodalConfigured,
    logger: log
  })
  const hot = createHotManager({
    database: deps.database,
    collectorScriptPath: deps.collectorScriptPath,
    nodePath: deps.nodePath,
    getDailyhotBase: deps.getDailyhotBase,
    logger: log
  })
  const hotScore = createHotScoreManager({
    database: deps.database,
    contextEngine,
    gateway: deps.gateway,
    logger: log
  })

  return { projects, business, watchlist, knowledge, contextEngine, advisor, content, scan, hot, hotScore }
}
