// contextEngine.ts —— Context Engine（PLAN-2.0.md Commit 06）
//
// 契约（§一 产品智能原则 / §二 硬规则 9、13 / §四 Schema / §五 IPC / §六 Context Pack / §七 Commit 06）：
//   - 交付物：把 **Business + Knowledge + Watchlist + Platform** 组装成一个 **Context Pack**
//     （§六 原文：`{ business, knowledge[], watchlist[], customer, platform, task }`），
//     **一次组装、一次调用**。消费方是主进程侧 07（Gateway Client）/ 08（Advisor）/ 09（Content Center）。
//   - **Knowledge 检索策略（§六 v1.10 写死，本提交落地）**：α 阶段**预算内全量打包** ——
//     先本地估算 business + 全部 ready knowledge 的 token；占所选模型上下文窗口 ≤60% 时**全部注入、
//     不做检索**；**超预算才退化为 LIKE 关键词裁剪**（按 query 命中排序截断并标注截断）。
//     理由：顾问类问题（「客户嫌贵怎么回」）与文档标题（「套系价目表」）常无字面重合，
//     LIKE 会漏掉最相关的资料；只有全量注入才验证得了「AI 认识这个商家」。
//   - **token 一律本地估算，不依赖 Gateway**：Commit 00 实测 Gateway 的 `usage` 恒为 0
//     （prompt/completion/total 全 0），预算不能建立在它的统计上。估算器是确定性的启发式
//     （中日韩字符 1 token/字、ASCII 1/4 token/字符、换行 1、其余 1.5），**偏保守（宁可少塞）**；
//     标定与局限见「待拍板」。
//   - **不裁剪 business**：business 是「AI 认识你」的核心（§一 产品智能原则），预算只作用于
//     knowledge。business 自身就超预算时记日志并让 knowledge 空载，而不是把商家资料砍一半。
//   - **不静默丢**：没进包的 ready 条目一律在 `dropped[]` 留痕（含原因）；被截断的条目
//     `truncated:true` 且正文带显式标记（与 knowledgeManager 的超长截断同精神）。
//   - **硬规则 9**：每个方法显式接收 projectId，绝不读 currentProject 隐式推断。
//   - **硬规则 13**：本模块**不做任何 HTTP 调用、不碰 GATEWAY_TOKEN**（那是 07 的职责）；
//     本文件不 import 任何网络模块，唯一出站路径由 07 提供。
//   - 本模块**不 import electron**，依赖（四个 Manager + logger）全部注入 → 纯 Node 可 bundle 测试。
//
// 与 §五 IPC 的关系：§五 **没有** context pack 的渲染端通道（`marketing.context` 是
// current-project 切换，属 Commit 03）。Context Pack 是**主进程内部**的数据结构，消费方是
// 07/08/09 的主进程代码，所以本提交**不新增 IPC 通道**，只把引擎接进主进程 wiring（见汇报「待拍板」）。

import { AppError, ERROR_CODES } from '../database/errors'
import {
  BUSINESS_COMPLETENESS_FIELDS,
  WATCHLIST_MAX,
  type BusinessManager,
  type BusinessRow,
  type WatchlistManager
} from './businessManager'
import {
  KNOWLEDGE_QUERY_MAX_LENGTH,
  KNOWLEDGE_STATUS_READY,
  MAX_SEARCH_LIMIT,
  type KnowledgeManager,
  type KnowledgeRow
} from './knowledgeManager'
import type { ProjectManager } from './projectManager'
import { getPlatformRule } from './platformRules'

// ── 常量（§六 / §七 Commit 06 / §十） ─────────────────────────────────────────

/** §四 `contents.platform`：发布平台（xiaohongshu / douyin）；Commit 10 起规则模板挂 pack.platformRule */
export const PLATFORMS = ['xiaohongshu', 'douyin'] as const
export type Platform = (typeof PLATFORMS)[number]

/** §六 Context Pack 的六个键（顺序即渲染顺序；静态可核对，防「加了字段没人知道」） */
export const CONTEXT_PACK_KEYS = ['business', 'knowledge', 'watchlist', 'customer', 'platform', 'task'] as const

/** **预算比例：business + knowledge 最多占上下文窗口的 60%**（§六 原文，其余留给对话历史/生成/平台规则） */
export const CONTEXT_BUDGET_RATIO = 0.6

/**
 * 默认上下文窗口（token）。选 128k 作为一期的保守默认值：
 * 07 拿到真实模型后应显式传入 `contextWindowTokens`（§六 说「具体阈值 06 按模型定」，
 * 而 §六 同时记录 `model` 取值是 `openclaw` / `openclaw/<agentId>`，**映射不到 provider 模型 id**，
 * 所以窗口必须由调用方给，不能在这张表里假装知道）。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
/** 合法窗口下界（比这更小的窗口连一份资料都放不下，属于配置错误而不是缺省） */
export const MIN_CONTEXT_WINDOW_TOKENS = 2_000
/** 合法窗口上界（防手滑写 128000000 把预算变成无上限） */
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000

/** 单次从 worker 读入的 ready 条目上限（worker `opList` 的 limit 上限就是 5000） */
export const KNOWLEDGE_PACK_MAX_ITEMS = 5_000

/** 每个区块的固定开销（标题、分隔、字段名）——估算时先扣掉，避免「账面上刚好、实际超了」 */
export const PACK_OVERHEAD_TOKENS = 64

/** 裁剪模式下单条知识至少要有这么多 token 才值得进包（塞半句话不如说明「还有更多资料」） */
export const KNOWLEDGE_ITEM_MIN_TOKENS = 120

/** 单条知识被预算截断时的显式标记（不静默丢内容，与 §七 05a 的截断精神一致） */
export const ITEM_TRUNCATE_MARKER = '\n……（本条资料已按上下文预算截断，完整内容见知识库原文）'

/**
 * 「本次未注入的资料」里最多列几个标题。
 *
 * 为什么要有上限：这段文字**也占上下文预算**。列表无界的话，被裁掉的条目越多、
 * 剩下的空间就越少，账本会变成自我强化的负数；固定 3 条 + 「等 N 条」既交代了「有东西没进」，
 * 又让成本有界（剩余条数看 `dropped` 字段 / UI）。
 */
export const DROPPED_TITLES_SHOWN = 3
/** 列表里单个标题的显示长度（超长标题不把预算吃掉） */
export const DROPPED_TITLE_MAX_CHARS = 20

/** `task` / `customer` 入参长度上限（防调用方把整篇对话塞进来） */
export const PACK_TEXT_MAX_LENGTH = 500

/** 未分类关注词的展示占位（`project_watchlist.type` 允许为 NULL） */
const WATCH_TYPE_LABELS: Record<string, string> = {
  industry: '行业',
  product: '产品',
  audience: '受众',
  region: '地域'
}

// ── 类型 ────────────────────────────────────────────────────────────────────

export type PackMode = 'full' | 'truncated'
/** 全量打包 / LIKE 关键词裁剪 / 超预算但无 query 时按时间裁剪 */
export type RetrievalMode = 'full' | 'like' | 'recency'

export interface ContextBudget {
  contextWindowTokens: number
  ratio: number
  /** 本次允许 business + knowledge 使用的 token（= floor(window × ratio)） */
  budgetTokens: number
  /** 实际用量（= 渲染后的真实估算，含区块开销） */
  usedTokens: number
  remainingTokens: number
  /** 留给对话历史 / 生成 / 平台规则的余量（= window − budgetTokens） */
  reservedTokens: number
  mode: PackMode
  knowledgeTotal: number
  knowledgeIncluded: number
  knowledgeDropped: number
  truncatedItems: number
  /** true = 库里的 ready 条目数触到 worker 单次读取上限，可能还有没读到的（显式标记，不静默） */
  listLimited: boolean
  /** business 自身超预算时为 true（此时 knowledge 空载，见文件头「不裁剪 business」） */
  businessOverBudget: boolean
}

export interface PackedKnowledge {
  id: string
  title: string
  type: string
  sourceName: string | null
  sourcePath: string | null
  content: string
  chars: number
  estimatedTokens: number
  truncated: boolean
  /** 裁剪模式下是否被 LIKE 关键词命中（全量模式下恒为 false，因为压根没做检索） */
  matchedQuery: boolean
}

export type DroppedReason = 'budget' | 'empty-content'

export interface DroppedKnowledge {
  id: string
  title: string
  reason: DroppedReason
}

export interface BusinessCompleteness {
  percent: number
  filled: string[]
  missing: string[]
}

export interface PackedWatchWord {
  keyword: string
  type: string | null
}

export interface RetrievedInfo {
  mode: RetrievalMode
  query: string | null
  /** LIKE 命中的 ready 条目数（全量模式下为 0：没做检索） */
  hits: number
}

/** §六 Context Pack（六个键 + 一轮组装的预算/取舍账本） */
export interface ContextPack {
  projectId: string
  projectName: string
  projectIndustry: string | null
  business: BusinessRow | null
  /** business 的确定性文本摘要（无字段时为 null）；AI 认识商家的最小充分集 */
  businessSummary: string | null
  businessCompleteness: BusinessCompleteness
  knowledge: PackedKnowledge[]
  watchlist: PackedWatchWord[]
  customer: string | null
  platform: Platform | null
  /** Commit 10：该发布平台的规则模板正文；platform 为 null 时也是 null（不进 60% 预算账本） */
  platformRule: string | null
  task: string | null
  budget: ContextBudget
  dropped: DroppedKnowledge[]
  retrieval: RetrievedInfo
  builtAt: number
}

export interface BuildContextPackOptions {
  /** 发布平台（§四 `contents.platform`）；不传 = 未指定（Advisor 这类不挑平台的任务） */
  platform?: string | null
  /** 本次任务说明（自由文本，如「客户嫌贵怎么回」） */
  task?: string | null
  /** 本次针对的具体客户/场景（自由文本）；不填就用 business.target_customer 那类资料，不在本字段里兜底 */
  customer?: string | null
  /** 超预算裁剪时的 LIKE 关键词；不传 = 按时间顺序裁剪 */
  query?: string | null
  /** 所选模型的上下文窗口（token）；不传用 DEFAULT_CONTEXT_WINDOW_TOKENS */
  contextWindowTokens?: number | null
}

export interface ContextEngineOptions {
  projectManager: ProjectManager
  businessManager: BusinessManager
  knowledgeManager: KnowledgeManager
  watchlistManager: WatchlistManager
  logger?: (message: string) => void
  /** 默认上下文窗口覆盖（主进程集中配置用；调用方仍可按次覆盖） */
  defaultContextWindowTokens?: number
}

// ── 本地 token 估算（§六：不依赖 Gateway 的 usage） ───────────────────────────

/** 中日韩表意文字 / 假名 / 谚文 / 全角符号：按 1 token 一个字计（偏保守） */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x303f) || // CJK 部首、标点、〇
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角 / 半角形式
    (cp >= 0x20000 && cp <= 0x3ffff) // 扩展 B 及以后
  )
}

/**
 * 本地 token 估算（确定性、零依赖、**偏保守**）。
 *
 * 口径：宽字符（CJK/全角/谚文）1 token/字；ASCII 1/4 token/字符；换行 1；
 * 其余（emoji、带变音符的拉丁字母等）1.5。最后向上取整。
 *
 * 保守方向的选择理由：低估预算会让请求真的超窗（被模型截断或报错），高估只会少塞一点资料，
 * 而 §六 的退化路径（LIKE 裁剪）本来就是为超预算准备的，所以「宁可少塞」是安全侧。
 * 实测对照（本机 Node 24，见验收脚本 C9）：纯中文 1000 字 = 1000 token 级，
 * 英文 `hello world` 类文本 ≈ 4 字符/token。
 */
export function estimateTokens(text: unknown): number {
  if (text === null || text === undefined) return 0
  const s = typeof text === 'string' ? text : String(text)
  if (!s) return 0
  let weight = 0
  for (const ch of s) {
    if (ch === '\n' || ch === '\r') {
      weight += 1
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (isWideChar(cp)) weight += 1
    else if (cp < 0x80) weight += 0.25
    else weight += 1.5
  }
  return Math.ceil(weight)
}

/** 在 token 预算内取最长的前缀（裁剪模式给单条资料切片用）；不劈开代理对 */
export function sliceToTokenBudget(text: string, maxTokens: number): string {
  const s = String(text ?? '')
  if (maxTokens <= 0 || !s) return ''
  if (estimateTokens(s) <= maxTokens) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  // 别把代理对劈成半个字符（半个代理对在 JSON / 模型侧都是坏数据）
  if (lo > 0 && lo < s.length) {
    const code = s.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1
  }
  return s.slice(0, lo)
}

// ── 确定性文本化（无 AI、无平台规则模板——模板归 Commit 10） ──────────────────

/** business → 文本摘要；一个字段都没有 → `null`（08 据此「主动追问缺口」，§一） */
export function summarizeBusiness(business: BusinessRow | null): string | null {
  if (!business) return null
  const lines: string[] = []
  const push = (label: string, value: string | null): void => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) lines.push(`${label}：${text}`)
  }
  push('名称', business.name)
  push('品牌', business.brand)
  push('城市', business.city)
  push('定位', business.positioning)
  push('目标客群', business.target_customer)
  push('语气', business.tone)
  push('地址', business.address)
  push('电话', business.phone)
  return lines.length ? lines.join('\n') : null
}

/** §七 Commit 04 的六项等权口径（直接复用 businessManager 的常量，避免第二份真相） */
export function computeBusinessCompleteness(business: BusinessRow | null): BusinessCompleteness {
  const filled: string[] = []
  const missing: string[] = []
  for (const field of BUSINESS_COMPLETENESS_FIELDS) {
    const raw = business ? (business as unknown as Record<string, unknown>)[field] : null
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text) filled.push(field)
    else missing.push(field)
  }
  const total = BUSINESS_COMPLETENESS_FIELDS.length
  return {
    percent: total ? Math.round((filled.length / total) * 100) : 0,
    filled,
    missing
  }
}

function renderKnowledgeBody(item: PackedKnowledge, index: number): string {
  const head = `[${index}] 《${item.title}》（${item.type}）`
  return item.content ? `${head}\n${item.content}` : head
}

function watchWordLabel(word: PackedWatchWord): string {
  const label = word.type ? WATCH_TYPE_LABELS[word.type] : null
  return label ? `${word.keyword}（${label}）` : word.keyword
}

/**
 * Context Pack → 确定性纯文本块（给 07/08 拼请求用）。
 * **平台规则模板（Commit 10）不渲染在这里**：它属于 §六 预留的 40%（对话历史/生成/平台规则），
 * 若并进本块，探针会把模板算进 60% 预算挤掉商家资料；消费方取 `pack.platformRule` 另起区块注入。
 * 组装时的预算账本与这里渲染出的文本同源，因此「账面上没超」在渲染后依然成立（验收 C10 断言）。
 */
export function renderContextPackText(pack: ContextPack): string {
  const parts: string[] = []

  parts.push('【商家资料】')
  parts.push(pack.businessSummary ?? '（商家资料尚未填写）')

  if (pack.watchlist.length) {
    parts.push('')
    parts.push('【老板关注的方向】')
    parts.push(pack.watchlist.map((w) => watchWordLabel(w)).join(' / '))
  }

  const scope: string[] = []
  if (pack.platform) scope.push(`发布平台：${pack.platform}`)
  if (pack.customer) scope.push(`对象客户：${pack.customer}`)
  if (pack.task) scope.push(`本次任务：${pack.task}`)
  if (scope.length) {
    parts.push('')
    parts.push('【本次语境】')
    parts.push(scope.join('\n'))
  }

  parts.push('')
  const total = pack.budget.knowledgeTotal
  const included = pack.knowledge.length
  const suffix =
    pack.budget.mode === 'full'
      ? '全部注入'
      : `超上下文预算，已按相关度裁剪 ${included}/${total} 条`
  parts.push(`【商家知识库】（${included}/${total} 条，${suffix}）`)
  if (!included) {
    parts.push(total > 0 ? '（预算不足，本次未注入任何资料；需要时请补充资料或缩小问题范围）' : '（知识库为空，请先导入资料）')
  } else {
    pack.knowledge.forEach((item, i) => {
      parts.push(renderKnowledgeBody(item, i + 1))
    })
  }

  if (pack.dropped.length) {
    parts.push('')
    const shown = pack.dropped.slice(0, DROPPED_TITLES_SHOWN).map((d) => shortTitle(d.title))
    const more = pack.dropped.length > shown.length ? ` 等 ${pack.dropped.length} 条` : ''
    parts.push(`【本次未注入的资料】${shown.join('、')}${more}`)
  }

  return parts.join('\n')
}

/** 列表里的短标题（截长 + 压空白；只在渲染层用，不改数据） */
function shortTitle(title: string): string {
  const t = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > DROPPED_TITLE_MAX_CHARS ? t.slice(0, DROPPED_TITLE_MAX_CHARS) + '…' : t
}

// ── 引擎 ────────────────────────────────────────────────────────────────────

export class ContextEngine {
  private readonly projectManager: ProjectManager
  private readonly businessManager: BusinessManager
  private readonly knowledgeManager: KnowledgeManager
  private readonly watchlistManager: WatchlistManager
  private readonly logger?: (message: string) => void
  private readonly defaultContextWindowTokens: number

  constructor(options: ContextEngineOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextEngine 需要注入式依赖配置')
    }
    for (const [name, manager, method] of [
      ['projectManager', options.projectManager, 'getProject'],
      ['businessManager', options.businessManager, 'getBusiness'],
      ['knowledgeManager', options.knowledgeManager, 'listKnowledge'],
      ['watchlistManager', options.watchlistManager, 'listWatchlist']
    ] as const) {
      if (!manager || typeof (manager as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `ContextEngine 缺少依赖: ${name}`)
      }
    }
    this.projectManager = options.projectManager
    this.businessManager = options.businessManager
    this.knowledgeManager = options.knowledgeManager
    this.watchlistManager = options.watchlistManager
    this.logger = options.logger
    this.defaultContextWindowTokens =
      options.defaultContextWindowTokens === undefined || options.defaultContextWindowTokens === null
        ? DEFAULT_CONTEXT_WINDOW_TOKENS
        : requireWindow(options.defaultContextWindowTokens, 'defaultContextWindowTokens')
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  /**
   * 组装一个 Context Pack。
   *
   * 顺序（§六）：project 存在性 → business → watchlist → knowledge（ready）→ 预算判定 →
   * 全量注入 or LIKE 裁剪 → 账本。
   *
   * 错误语义：project 不存在 → `NOT_FOUND`；参数非法 → `VALIDATION_ERROR`；
   * 依赖层的错误（`SETUP_REQUIRED` / `DB_ERROR` …）**原样透传**，不做包装（§五 要求渲染端按 code 分支）。
   */
  async buildContextPack(projectId: string, options: BuildContextPackOptions = {}): Promise<ContextPack> {
    const pid = requireId(projectId, 'buildContextPack')
    const platform = normalizePlatform(options?.platform)
    const platformRule = platform ? getPlatformRule(platform) : null
    const task = optionalPackText(options?.task, 'task')
    const customer = optionalPackText(options?.customer, 'customer')
    const query = optionalQuery(options?.query)
    const window = this.resolveWindow(options?.contextWindowTokens)

    // ── 1. project（不存在 → NOT_FOUND，不静默返回空包） ──
    const project = await this.projectManager.getProject(pid)

    // ── 2. Business（1:1，无行 → null：首填场景不是错误） ──
    const business = await this.businessManager.getBusiness(pid)

    // ── 3. Watchlist（只取 enabled=1 的词喂上下文；禁用词不进包） ──
    const watchRows = await this.watchlistManager.listWatchlist(pid)
    const watchlist: PackedWatchWord[] = (Array.isArray(watchRows) ? watchRows : [])
      .filter((row) => Number(row?.enabled ?? 0) === 1)
      .slice(0, WATCHLIST_MAX)
      .map((row) => ({
        keyword: String(row.keyword ?? '').trim(),
        type: row.type === undefined || row.type === null ? null : String(row.type)
      }))
      .filter((word) => word.keyword.length > 0)

    // ── 4. Knowledge：一次读入 ready 条目（worker 单次上限 5000，触顶显式标记） ──
    const rawRows = await this.knowledgeManager.listKnowledge(pid, { limit: KNOWLEDGE_PACK_MAX_ITEMS })
    const rows = Array.isArray(rawRows) ? rawRows : []
    const listLimited = rows.length >= KNOWLEDGE_PACK_MAX_ITEMS
    if (listLimited) {
      this.log(`[context] ⚠️ project=${pid} 的 ready 条目达到单次读取上限 ${KNOWLEDGE_PACK_MAX_ITEMS}，本次只打包前 ${rows.length} 条`)
    }

    const candidates: KnowledgeRow[] = []
    const dropped: DroppedKnowledge[] = []
    for (const row of rows) {
      if (!row || row.status !== KNOWLEDGE_STATUS_READY) continue
      const content = typeof row.content === 'string' ? row.content : ''
      if (!content.trim()) {
        dropped.push({ id: String(row.id), title: String(row.title ?? ''), reason: 'empty-content' })
        continue
      }
      candidates.push(row)
    }

    // ── 5. 预算与取舍 ──
    const budgetTokens = Math.floor(window * CONTEXT_BUDGET_RATIO)
    const businessSummary = summarizeBusiness(business)
    const completeness = computeBusinessCompleteness(business)

    // 先算「非知识部分」的固定开销：两个区块头 + business 摘要 + 关注词 + 语境
    const fixedTokens =
      PACK_OVERHEAD_TOKENS +
      estimateTokens(businessSummary ?? '（商家资料尚未填写）') +
      (watchlist.length ? estimateTokens(watchlist.map((w) => watchWordLabel(w)).join(' / ')) + estimateTokens('【老板关注的方向】') : 0) +
      (platform || customer || task ? estimateTokens([platform, customer, task].filter(Boolean).join('\n')) + estimateTokens('【本次语境】') : 0)

    const businessOverBudget = fixedTokens > budgetTokens
    if (businessOverBudget) {
      this.log(
        `[context] ⚠️ project=${pid} 的 business 自身开销 ${fixedTokens} tokens 已超预算 ${budgetTokens}（窗口 ${window}）；` +
          '按 §一「不裁剪 business」保留商家资料、本次不再注入知识资料'
      )
    }

    // 取舍前先立一个「探针」：**账本 = 实际渲染出的文本**。
    // 不这么做的话，只能靠「固定开销 + 逐条估算」去猜渲染后的真实字数，边界上必然出现
    // 「账面刚好、渲染后超了」（本提交验收 C9/C10 就是抓到这个才改成现在的写法）。
    const budgetSkeleton: ContextBudget = {
      contextWindowTokens: window,
      ratio: CONTEXT_BUDGET_RATIO,
      budgetTokens,
      usedTokens: 0,
      remainingTokens: 0,
      reservedTokens: window - budgetTokens,
      mode: 'full',
      knowledgeTotal: candidates.length,
      knowledgeIncluded: 0,
      knowledgeDropped: 0,
      truncatedItems: 0,
      listLimited,
      businessOverBudget
    }
    const probePack = (
      items: PackedKnowledge[],
      droppedItems: DroppedKnowledge[],
      probeMode: PackMode
    ): ContextPack => ({
      projectId: pid,
      projectName: project.name,
      projectIndustry: project.industry ?? null,
      business: business ?? null,
      businessSummary,
      businessCompleteness: completeness,
      knowledge: items,
      watchlist,
      customer,
      platform,
      platformRule,
      task,
      budget: { ...budgetSkeleton, mode: probeMode },
      dropped: droppedItems,
      retrieval: { mode: 'full', query: null, hits: 0 },
      builtAt: 0
    })
    const measure = (items: PackedKnowledge[], droppedItems: DroppedKnowledge[], probeMode: PackMode): number =>
      estimateTokens(renderContextPackText(probePack(items, droppedItems, probeMode)))

    const asDropped = (row: KnowledgeRow): DroppedKnowledge => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      reason: 'budget'
    })

    const allPacked = candidates.map((row) => packItem(row, false, false))
    const mode: PackMode =
      !businessOverBudget && measure(allPacked, dropped, 'full') <= budgetTokens ? 'full' : 'truncated'

    let knowledge: PackedKnowledge[]
    let retrieval: RetrievedInfo
    let droppedList: DroppedKnowledge[] = dropped
    if (mode === 'full') {
      knowledge = allPacked
      retrieval = { mode: 'full', query: null, hits: 0 }
    } else {
      const ranked = await this.rankForTruncation(pid, candidates, query)
      retrieval = ranked.info
      const chosen: PackedKnowledge[] = []
      for (let i = 0; i < ranked.entries.length; i++) {
        const entry = ranked.entries[i]
        // 尚未轮到的一律先按「落选」计入探针——因为渲染出的未注入清单也占预算
        const rest = ranked.entries.slice(i + 1).map((e) => asDropped(e.row))
        const packed = packItem(entry.row, false, entry.matched)
        if (measure([...chosen, packed], [...dropped, ...rest], 'truncated') <= budgetTokens) {
          chosen.push(packed)
          continue
        }
        // 放不下整条：剩余空间还够一段有意义的内容就截断收入，然后收手
        const sliceBudget =
          budgetTokens -
          measure(chosen, [...dropped, ...rest], 'truncated') -
          PACK_OVERHEAD_TOKENS -
          estimateTokens(String(entry.row.title ?? '')) -
          estimateTokens(ITEM_TRUNCATE_MARKER)
        if (sliceBudget >= KNOWLEDGE_ITEM_MIN_TOKENS) {
          chosen.push(packItem(entry.row, true, entry.matched, sliceBudget))
        }
        break
      }
      // 保险丝：估算与渲染之间的极小差值也不许越界——真超了就按同一顺序从尾部让位
      let includedCount = chosen.length
      const rebuildDropped = (): DroppedKnowledge[] => [
        ...dropped,
        ...ranked.entries.slice(includedCount).map((e) => asDropped(e.row))
      ]
      droppedList = rebuildDropped()
      while (includedCount > 0 && measure(chosen.slice(0, includedCount), droppedList, 'truncated') > budgetTokens) {
        includedCount -= 1
        droppedList = rebuildDropped()
      }
      knowledge = chosen.slice(0, includedCount)
    }

    if (droppedList.length || knowledge.some((item) => item.truncated)) {
      this.log(
        `[context] project=${pid} 裁剪：注入 ${knowledge.length}/${candidates.length} 条，` +
          `未注入 ${droppedList.filter((d) => d.reason === 'budget').length} 条` +
          `（mode=${mode}，query=${query ?? '（无，按时间）'}）`
      )
    }
    const droppedForPack = droppedList

    const pack: ContextPack = {
      projectId: pid,
      projectName: project.name,
      projectIndustry: project.industry ?? null,
      business: business ?? null,
      businessSummary,
      businessCompleteness: completeness,
      knowledge,
      watchlist,
      customer,
      platform,
      platformRule,
      task,
      budget: {
        contextWindowTokens: window,
        ratio: CONTEXT_BUDGET_RATIO,
        budgetTokens,
        usedTokens: 0,
        remainingTokens: 0,
        reservedTokens: window - budgetTokens,
        mode,
        knowledgeTotal: candidates.length,
        knowledgeIncluded: knowledge.length,
        knowledgeDropped: droppedForPack.filter((d) => d.reason === 'budget').length,
        truncatedItems: knowledge.filter((item) => item.truncated).length,
        listLimited,
        businessOverBudget
      },
      dropped: [...droppedForPack].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)),
      retrieval,
      builtAt: Date.now()
    }

    // 用量以**渲染后的真实文本**为准（账本与实际同源，验收 C10 断言 usedTokens ≤ budgetTokens）
    const usedTokens = estimateTokens(renderContextPackText(pack))
    pack.budget.usedTokens = usedTokens
    pack.budget.remainingTokens = Math.max(0, budgetTokens - usedTokens)
    return pack
  }

  /** 裁剪模式的排序：有 query → LIKE 命中优先（命中集内按最近更新）；无 query → 按时间（list 已是新→旧） */
  private async rankForTruncation(
    projectId: string,
    candidates: KnowledgeRow[],
    query: string | null
  ): Promise<{ entries: Array<{ row: KnowledgeRow; matched: boolean }>; info: RetrievedInfo }> {
    if (!query) {
      return {
        entries: candidates.map((row) => ({ row, matched: false })),
        info: { mode: 'recency', query: null, hits: 0 }
      }
    }
    const hits = await this.knowledgeManager.searchKnowledge(projectId, query, MAX_SEARCH_LIMIT)
    const hitIds = (Array.isArray(hits) ? hits : []).map((h) => String(h?.id ?? ''))
    const order = new Map<string, number>()
    hitIds.forEach((id, index) => {
      if (id) order.set(id, index)
    })
    const matched = candidates.filter((row) => order.has(String(row.id)))
    const rest = candidates.filter((row) => !order.has(String(row.id)))
    matched.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0))
    return {
      entries: [...matched.map((row) => ({ row, matched: true })), ...rest.map((row) => ({ row, matched: false }))],
      info: { mode: 'like', query, hits: matched.length }
    }
  }

  private resolveWindow(value: unknown): number {
    if (value === undefined || value === null) return this.defaultContextWindowTokens
    return requireWindow(value, 'contextWindowTokens')
  }
}

/** 工厂（与 ProjectManager / BusinessManager / KnowledgeManager 同风格） */
export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  return new ContextEngine(options)
}

// ── 内部辅助 ────────────────────────────────────────────────────────────────

/** 单条 → 包内条目；`truncate=true` 时按剩余预算切片并挂显式标记 */
function packItem(row: KnowledgeRow, truncate: boolean, matched: boolean, budgetTokens?: number): PackedKnowledge {
  const rawContent = String(row.content ?? '')
  const content = truncate ? sliceToTokenBudget(rawContent, Math.max(0, (budgetTokens ?? 0))) + ITEM_TRUNCATE_MARKER : rawContent
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    type: String(row.type ?? ''),
    sourceName: row.source_name ?? null,
    sourcePath: row.source_path ?? null,
    content,
    chars: content.length,
    estimatedTokens: PACK_OVERHEAD_TOKENS + estimateTokens(String(row.title ?? '')) + estimateTokens(content),
    truncated: truncate,
    matchedQuery: matched
  }
}

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

function requireWindow(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_CONTEXT_WINDOW_TOKENS || n > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `${field} 必须是 ${MIN_CONTEXT_WINDOW_TOKENS}~${MAX_CONTEXT_WINDOW_TOKENS} 之间的整数（实际 ${String(value)}）`,
      { field, value: value as unknown as number, min: MIN_CONTEXT_WINDOW_TOKENS, max: MAX_CONTEXT_WINDOW_TOKENS }
    )
  }
  return n
}

/** 平台：不传 → null；非法 → VALIDATION_ERROR（静默归一会让「按平台分组」悄悄错位） */
function normalizePlatform(value: unknown): Platform | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'platform 必须是非空字符串或 null', { field: 'platform' })
  }
  const p = value.trim()
  if (!(PLATFORMS as readonly string[]).includes(p)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的发布平台: ${p}`, {
      field: 'platform',
      value: p,
      allowed: [...PLATFORMS]
    })
  }
  return p as Platform
}

function optionalPackText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 必须是字符串或 null`, { field, type: typeof value })
  }
  const text = value.trim()
  if (!text) return null
  if (text.length > PACK_TEXT_MAX_LENGTH) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 过长（${text.length} > ${PACK_TEXT_MAX_LENGTH}）`, {
      field,
      max: PACK_TEXT_MAX_LENGTH,
      length: text.length
    })
  }
  return text
}

function optionalQuery(value: unknown): string | null {
  const q = optionalPackText(value, 'query')
  if (q === null) return null
  if (q.length > KNOWLEDGE_QUERY_MAX_LENGTH) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `query 过长（${q.length} > ${KNOWLEDGE_QUERY_MAX_LENGTH}）`, {
      field: 'query',
      max: KNOWLEDGE_QUERY_MAX_LENGTH,
      length: q.length
    })
  }
  return q
}
