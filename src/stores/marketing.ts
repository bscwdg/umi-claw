// src/stores/marketing.ts —— 商家（Project）状态（PLAN-2.0.md Commit 03）
//
// 契约（主会话 UI 直接按此写，勿改签名）：
//   projects: Ref<Project[]>            currentProjectId: Ref<string | null>
//   currentProject: ComputedRef<Project | null>
//   loading: Ref<boolean>               error: Ref<string | null>
//   load() / create() / rename() / remove() / select()
//
// 错误处理约定（§五）：
//   - 一律解包 `{ ok:false, error:{ code, message } }`，**按 code 分支**，
//     禁止 `error.message.includes()` 判断（服务端文案会变，code 不会）
//   - `error` 存「人话」：服务端 message 优先，其次 code → 文案表兜底
//   - `load()` **不抛出**（拉取失败只置 error，UI 无需 try/catch 以免 unhandled rejection）
//     其余动作失败时置 error **并抛出**：调用方需要知道是否真的成功（例如关弹窗）

import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export interface Project {
  id: string
  name: string
  industry: string | null
  description: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface CreateProjectPayload {
  name: string
  industry?: string
  description?: string
}

export type UpdateProjectPayload = Partial<{
  name: string
  industry: string | null
  description: string | null
}>

// ── Commit 04：Business（商家大脑，与 Project 1:1）+ Watchlist（关注词，手工增删） ──

/** `businesses` 表一行（1:1；`get` 无行时 `business` 为 null，不是错误） */
export interface Business {
  id: string
  project_id: string
  name: string | null
  brand: string | null
  city: string | null
  address: string | null
  phone: string | null
  positioning: string | null
  target_customer: string | null
  tone: string | null
  created_at: number
  updated_at: number
}

/** `project_watchlist` 表一行 */
export interface WatchItem {
  project_id: string
  keyword: string
  type: string | null
  enabled: number
  created_at: number
}

/**
 * 资料完整度（**Business 维度**，§七 Commit 04）计分字段：六个等权。
 * 与 `electron/main/marketing/businessManager.ts` 的 `BUSINESS_COMPLETENESS_FIELDS` 必须一致
 * （跨 tsconfig 无法共享常量，由 test/business.accept.mjs 做静态一致性核对）。
 */
export const BUSINESS_COMPLETENESS_FIELDS: string[] = [
  'name',
  'brand',
  'city',
  'positioning',
  'target_customer',
  'tone'
]

/** 完整度字段 → 人话（卡片展示「还缺：品牌、定位」用；字段名本身是稳定标识） */
export const BUSINESS_FIELD_LABELS: Record<string, string> = {
  name: '商家名称',
  brand: '品牌名',
  city: '城市',
  address: '地址',
  phone: '电话',
  positioning: '定位',
  target_customer: '目标客户',
  tone: '语气风格'
}

/** 关注词上限（与 WatchlistManager 的 WATCHLIST_MAX 一致） */
export const WATCHLIST_MAX = 10

/** 行业预设类型（UI 的预设词挂靠用） */
export const WATCHLIST_PRESET_TYPES: string[] = ['industry', 'product', 'audience', 'region']

/** 可写入 business 的字段（与后端白名单一致；其余字段在 saveBusiness 里被剔除再发 IPC） */
const BUSINESS_WRITABLE_FIELDS: string[] = [
  'name',
  'brand',
  'city',
  'address',
  'phone',
  'positioning',
  'target_customer',
  'tone'
]

/** IPC 统一信封（与 preload / ipc/marketing.ts 的 IpcResult 对应） */
type IpcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error?: { code?: string; message?: string; details?: unknown } }

/** 带 code 的前端错误：UI 可 `catch (e) { if ((e as MarketingIpcError).code === 'NOT_FOUND') ... }` */
export class MarketingIpcError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'MarketingIpcError'
    this.code = code
    this.details = details
  }
}

/** code → 人话（只此一处；未知 code 退化到服务端 message） */
export const ERROR_TEXT: Record<string, string> = {
  VALIDATION_ERROR: '填写内容不合法，请检查后重试',
  NOT_FOUND: '该商家不存在，可能已被删除',
  CONFLICT: '与已有数据冲突，请检查后重试',
  DB_ERROR: '数据保存失败，请稍后重试',
  SETUP_REQUIRED: '请先完成环境初始化（运行时未就绪）',
  OPENCLAW_NOT_READY: 'OpenClaw 尚未启动，请稍后重试',
  OPENCLAW_TIMEOUT: '请求超时，请重试',
  OPENCLAW_AUTH_ERROR: 'OpenClaw 鉴权失败，请检查配置',
  FILE_NOT_FOUND: '原始文件不存在',
  FILE_PARSE_ERROR: '文件解析失败',
  HOT_SOURCE_ERROR: '热点数据源暂时不可用，请稍后重试'
}

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof MarketingIpcError) return e.message || fallback
  if (e instanceof Error) return e.message || fallback
  return fallback
}

function envelopeToError(res: IpcEnvelope<unknown> | null | undefined, fallback: string): MarketingIpcError {
  const error = res && res.ok === false ? res.error : undefined
  const code = typeof error?.code === 'string' && error.code ? error.code : 'DB_ERROR'
  const serverMessage = typeof error?.message === 'string' ? error.message.trim() : ''
  return new MarketingIpcError(code, serverMessage || ERROR_TEXT[code] || fallback, error?.details)
}

function toProject(row: any): Project {
  return {
    id: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    industry: row?.industry ?? null,
    description: row?.description ?? null,
    status: String(row?.status ?? 'active'),
    created_at: Number(row?.created_at ?? 0),
    updated_at: Number(row?.updated_at ?? 0)
  }
}

function toBusiness(row: any): Business {
  return {
    id: String(row?.id ?? ''),
    project_id: String(row?.project_id ?? ''),
    name: row?.name ?? null,
    brand: row?.brand ?? null,
    city: row?.city ?? null,
    address: row?.address ?? null,
    phone: row?.phone ?? null,
    positioning: row?.positioning ?? null,
    target_customer: row?.target_customer ?? null,
    tone: row?.tone ?? null,
    created_at: Number(row?.created_at ?? 0),
    updated_at: Number(row?.updated_at ?? 0)
  }
}

function toWatchItem(row: any): WatchItem {
  return {
    project_id: String(row?.project_id ?? ''),
    keyword: String(row?.keyword ?? ''),
    type: row?.type ?? null,
    enabled: Number(row?.enabled ?? 0),
    created_at: Number(row?.created_at ?? 0)
  }
}

/** 只发白名单字段（后端对未知字段是硬拒绝的；这里兜住 UI 直接传 `{...business}` 的常见写法） */
function pickBusinessPayload(data: Partial<Business> | null | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (!data) return out
  for (const field of BUSINESS_WRITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue
    const value = (data as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null) {
      out[field] = null
      continue
    }
    if (typeof value !== 'string') continue
    out[field] = value
  }
  return out
}

/** 关注词排序：created_at 升序，同刻按 keyword（与后端 listWatchlist 一致，避免渲染抖动） */
function sortWatchlist(list: WatchItem[]): WatchItem[] {
  return [...list].sort(
    (a, b) => a.created_at - b.created_at || a.keyword.localeCompare(b.keyword)
  )
}

/** 新建的排前面（同级按 id 收敛，避免渲染顺序抖动） */
function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
}

// ── Commit 05a：Knowledge（知识库）────────────────────────────────────────────

/**
 * `knowledge_items` 表一行。
 * `type`：text / markdown / url / faq / docx / xlsx / pdf（§四 type 已放开，read 侧按字符串收）。
 * `source_path`：文件类为相对 dataDir 的路径（`projects/<id>/<文件名>`）、url 类为原始 URL、
 * 手输 text/faq 为 `null`；`content` 为**导入时解析一次**落库的文本（运行时不再解析）。
 */
export interface KnowledgeItem {
  id: string
  project_id: string
  title: string
  type: string
  source_path: string | null
  source_name: string | null
  content: string | null
  status: string
  created_at: number
  updated_at: number
}

/** 检索命中（只带 UI 要展示的三列） */
export interface KnowledgeHit {
  id: string
  title: string
  snippet: string
}

/** 导入入参（与主进程 `ImportKnowledgeInput` 一致；UI 只发这些字段） */
export interface ImportKnowledgePayload {
  type: string
  title?: string
  text?: string
  url?: string
  filePath?: string
}

/** `status='ready'` 才计入「已建知识库」，也才是 AI 能吃的资料（与后端检索口径一致） */
export const KNOWLEDGE_READY_STATUS = 'ready'

// ── 扫描件/图片 AI 识别（Commit 05b）：类型 ─────────────────────────────────

/** 识别入参（与主进程 ScanRecognizeInput 一致）：只认扫描 PDF 与资料图 */
export interface RecognizeScanPayload {
  filePath: string
  type?: 'pdf' | 'image'
}

/** 确认入库入参（人工确认后才提交；与主进程 CommitRecognizedInput 一致） */
export interface CommitRecognizedPayload {
  filePath: string
  /** 05b 只允许识别类条目：pdf（扫描件）/ image（资料图） */
  type: 'pdf' | 'image'
  title?: string | null
  /** 用户在确认弹窗里校对后的文本（以它为准，不是模型原文） */
  content: string
}

export interface ScanImageInfo {
  page: number
  width: number
  height: number
  bytes: number
  downscaled: boolean
}

export interface ScanTaskInfo {
  taskId: string
  kind: 'pdf' | 'image'
  filePath: string
  suggestedTitle: string
  images: ScanImageInfo[]
}

/**
 * 「疑似价格」本地判据（与 `scanRecognizer.PRICE_SUSPECT_PATTERN` 同源；
 * 跨 tsconfig 无法共享常量 → 两份正则由 test/scan.accept.mjs 做静态一致性核对防漂移）。
 */
export const PRICE_SUSPECT_REGEX = /[¥￥$]\s*\d|\d+(?:[.,]\d+)?\s*(?:元|人民币|块(?:钱)?)/

/**
 * 过程性进度标记（与主进程 `scanRecognizer.SCAN_PROGRESS_MARKER_PATTERN` 同字面量，
 * 静态同源校验由 test/scan.accept.mjs 负责）：中止态没有 done 的权威汇总替换，
 * 确认弹窗打开前用 `scanCleanText` 剥掉这些行，避免「正在识别…」混进文档正文。
 */
export const SCAN_PROGRESS_MARKER_REGEX =
  /^\s*(?:【正在识别(?:第 \d+ 页 \/ 共 \d+ 页|：[^\n】]*)】|（第 \d+ 页识别失败，重试 1 次…）)\s*$/gm

// ── Content Center（Commit 09）：类型 ──────────────────────────────────────────────

/** 内容状态机（与主进程 CONTENT_STATUSES 同源；人工推进，无自动跳转） */
export const CONTENT_STATUSES = ['draft', 'review', 'approved', 'published', 'archived'] as const

/** 状态 → 人话（徽章文案） */
export const CONTENT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  review: '待审核',
  approved: '已通过',
  published: '已发布',
  archived: '已归档'
}

/** `contents` 表一行 */
export interface ContentItem {
  id: string
  project_id: string
  title: string | null
  platform: string | null
  topic: string | null
  source_topic_id: string | null
  content: string | null
  status: string
  published_at: number | null
  effect_note: string | null
  created_at: number
  updated_at: number
}

/** `content_versions` 表一行 */
export interface ContentVersion {
  id: string
  content_id: string
  version: number
  content: string
  source: string | null
  prompt: string | null
  created_at: number
}

export interface ContentListQuery {
  status?: string | null
  platform?: string | null
  limit?: number
}

export interface CreateContentPayload {
  title?: string | null
  platform?: string | null
  topic?: string | null
  content?: string | null
  /** 热点雷达 payload 溯源（hot_topics.id；11 上线前只有测试路径会带） */
  sourceTopicId?: string | null
}

export interface UpdateContentPayload {
  title?: string | null
  platform?: string | null
  topic?: string | null
  content?: string | null
  status?: string
  published_at?: number | null
  effect_note?: string | null
}

/** 生成入参（与主进程 GenerateContentSpec 一致；platform 必填） */
export interface ContentGenerateSpec {
  contentId?: string | null
  platform: string
  topic?: string | null
  title?: string | null
  customer?: string | null
  sourceTopicId?: string | null
  query?: string | null
}

/** 生成面板里一个版本位的流式状态 */
export interface ContentAngleSlot {
  streamId: string
  angleKey: string
  label: string
  text: string
  streaming: boolean
  done: boolean
  aborted: boolean
  errorCode: string | null
  errorMessage: string | null
}

export interface ContentGenState {
  genTaskId: string
  contentId: string
  projectId: string
  platform: string
  topic: string | null
  pack: AdvisorPackSummary | null
  angles: ContentAngleSlot[]
}

export interface ContentGenerateResult {
  genTaskId: string
  contentId: string
  angles: Array<{ streamId: string; key: string; label: string }>
  pack: AdvisorPackSummary | null
}

function toContentItem(row: any): ContentItem {
  return {
    id: String(row?.id ?? ''),
    project_id: String(row?.project_id ?? ''),
    title: row?.title ?? null,
    platform: row?.platform ?? null,
    topic: row?.topic ?? null,
    source_topic_id: row?.source_topic_id ?? null,
    content: row?.content ?? null,
    status: String(row?.status ?? 'draft'),
    published_at: row?.published_at === null || row?.published_at === undefined ? null : Number(row.published_at),
    effect_note: row?.effect_note ?? null,
    created_at: Number(row?.created_at ?? 0),
    updated_at: Number(row?.updated_at ?? 0)
  }
}

function toContentVersion(row: any): ContentVersion {
  return {
    id: String(row?.id ?? ''),
    content_id: String(row?.content_id ?? ''),
    version: Number(row?.version ?? 0),
    content: String(row?.content ?? ''),
    source: row?.source ?? null,
    prompt: row?.prompt ?? null,
    created_at: Number(row?.created_at ?? 0)
  }
}

/** 新草稿排前面（同级按 id 收敛；与后端 listContents 展示序一致） */
function sortContents(list: ContentItem[]): ContentItem[] {
  return [...list].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
}

// ── Hot Radar（Commit 11）：类型 ───────────────────────────────────────────────

/** project_hot_topics 评分缓存（Commit 12 才会有真值；11 恒为 null） */
export interface HotTopicScore {
  match_score: number | null
  platform_fit: number | null
  reason: string | null
  content_angle: string | null
  lifecycle_advice: string | null
  scored_at: number | null
}

/** `hot_topics` 一行（snake_case 与主进程/DB 一致；跨 tsconfig 不共享，静态契约由 hot.accept.mjs 核对） */
export interface HotTopic {
  id: string
  source_platform: string
  source: string
  origin: string
  title: string
  url: string | null
  fingerprint: string
  heat: number | null
  rank: number | null
  lifecycle: string | null
  first_seen_at: number
  last_seen_at: number
  /** 12 的商家相关度评分；11 LEFT 关联不到时为 null */
  score: HotTopicScore | null
}

/** 单个数据源一轮采集的结果 */
export interface HotSourceStatus {
  source: string
  sourcePlatform: string
  origin: 'board' | 'calendar'
  ok: boolean
  count: number
  error?: string
}

/** 一轮采集的完整状态（持久化在 app_meta.hot_source_status） */
export interface HotCollectStatus {
  fetchedAt: number
  durationMs: number
  sources: HotSourceStatus[]
  inserted: number
  updated: number
  samples: number
  expiredDeleted: number
  topicsTotal: number
}

/** marketing:hot:list 返回的雷达视图 */
export interface HotRadarView {
  /** 本次调用是否新跑了一轮（时间差未到跳过/打开页时为 null） */
  collected: HotCollectStatus | null
  lastStatus: HotCollectStatus | null
  lastError: string | null
  board: HotTopic[]
  calendar: HotTopic[]
}

/** marketing:hot:score 单批结果（Commit 12） */
export interface HotScoreBatchResult {
  scored: number
  failed: number
  total: number
  remaining: number
  forced: boolean
  suggestion: HotTodaySuggestion | null
}

/** 雷达顶部「今日建议」（v1.12：1 条主推 + 理由 + 时机） */
export interface HotTodaySuggestion {
  topicId: string
  title: string
  sourcePlatform: string
  url: string | null
  lifecycle: string | null
  matchScore: number
  platformFit: number
  reason: string
  timing: string
}

function toHotRadar(data: any): HotRadarView {
  return {
    collected: data?.collected ?? null,
    lastStatus: data?.lastStatus ?? null,
    lastError: typeof data?.lastError === 'string' ? data.lastError : null,
    board: Array.isArray(data?.board) ? data.board : [],
    calendar: Array.isArray(data?.calendar) ? data.calendar : []
  }
}

function toSuggestion(data: any): HotTodaySuggestion | null {
  if (!data || typeof data !== 'object' || typeof data.topicId !== 'string') return null
  return {
    topicId: data.topicId,
    title: String(data.title ?? ''),
    sourcePlatform: String(data.sourcePlatform ?? ''),
    url: typeof data.url === 'string' ? data.url : null,
    lifecycle: typeof data.lifecycle === 'string' ? data.lifecycle : null,
    matchScore: Number(data.matchScore) || 0,
    platformFit: Number(data.platformFit) || 0,
    reason: String(data.reason ?? ''),
    timing: String(data.timing ?? '')
  }
}

// ── AI Advisor（Commit 08）：类型 ───────────────────────────────────────────────

/** 面板要展示的「AI 看见了什么」摘要（主进程 `marketing:advisor:ask` 返回） */
export interface AdvisorPackSummary {
  knowledgeIncluded: number
  knowledgeTotal: number
  knowledgeDropped: number
  mode: 'full' | 'truncated'
  retrievalMode: string
  usedTokens: number
  budgetTokens: number
  contextWindowTokens: number
  businessCompleteness: { percent: number; missing: string[] }
  watchlistCount: number
}

export interface AdvisorMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 流式中（面板据此显示光标与「停止生成」） */
  streaming: boolean
  /** 被用户中止（上游真断连） */
  aborted: boolean
  /** 失败时的错误码（§五；面板按 code 分支，不解析 message） */
  errorCode: string | null
}

export interface WatchCandidate {
  keyword: string
  type: string | null
  reason: string | null
  /** 已在关注词列表里（面板置灰不可勾选） */
  existing: boolean
}

/** 发布平台选项（§四 contents.platform；Advisor 里可选） */
export const ADVISOR_PLATFORMS: Array<{ key: string; label: string }> = [
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'douyin', label: '抖音' }
]

function toKnowledgeItem(row: any): KnowledgeItem {
  return {
    id: String(row?.id ?? ''),
    project_id: String(row?.project_id ?? ''),
    title: String(row?.title ?? ''),
    type: String(row?.type ?? ''),
    source_path: row?.source_path ?? null,
    source_name: row?.source_name ?? null,
    content: row?.content ?? null,
    status: String(row?.status ?? KNOWLEDGE_READY_STATUS),
    created_at: Number(row?.created_at ?? 0),
    updated_at: Number(row?.updated_at ?? 0)
  }
}

/** 新导入的排前面（同级按 id 收敛，避免渲染顺序抖动；与后端 listKnowledge 同序） */
function sortKnowledge(list: KnowledgeItem[]): KnowledgeItem[] {
  return [...list].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
}

export const useMarketingStore = defineStore('marketing', () => {
  const projects = ref<Project[]>([]) as Ref<Project[]>
  const currentProjectId = ref<string | null>(null)
  const loading = ref<boolean>(false)
  const error = ref<string | null>(null)

  const currentProject: ComputedRef<Project | null> = computed(
    () => projects.value.find((p) => p.id === currentProjectId.value) ?? null
  )

  function upsertLocal(project: Project): void {
    const rest = projects.value.filter((p) => p.id !== project.id)
    projects.value = sortProjects([...rest, project])
  }

  /**
   * 并发拉取 list + getCurrentProject。
   * 两个请求各自独立解包：其中一个失败时，另一个已经拿到的数据照常生效（部分降级好过整页空白）。
   * 刻意**不抛出**：调用方通常在 onMounted 里直接 `store.load()`。
   */
  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    const api = window.api.marketing
    try {
      const [listRes, currentRes] = (await Promise.all([
        api.project.list(),
        api.context.getCurrentProject()
      ])) as [IpcEnvelope<any[]>, IpcEnvelope<any>]

      let firstError: MarketingIpcError | null = null

      if (listRes?.ok) {
        const rows = Array.isArray(listRes.data) ? listRes.data : []
        projects.value = sortProjects(rows.map(toProject))
      } else {
        firstError = envelopeToError(listRes, '加载商家列表失败')
      }

      if (currentRes?.ok) {
        currentProjectId.value = currentRes.data ? toProject(currentRes.data).id : null
      } else {
        // 当前 Project 拉取失败不影响列表——UI 显示列表、current 视为未选
        firstError = firstError ?? envelopeToError(currentRes, '读取当前商家失败')
      }

      if (firstError) error.value = firstError.message
    } catch (e) {
      // IPC 通道本身异常（主进程未注册 / 序列化失败）
      error.value = messageOf(e, '加载商家列表失败')
    } finally {
      loading.value = false
    }
  }

  /** 新建 + 自动切换为当前（创建成功但切换失败时仍返回已创建的 project，并置 error） */
  async function create(input: CreateProjectPayload): Promise<Project> {
    loading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.project.create({
        name: input.name,
        industry: input.industry ?? null,
        description: input.description ?? null
      })) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '创建商家失败')
      const project = toProject(res.data)
      upsertLocal(project)
      try {
        await select(project.id)
      } catch (e) {
        error.value = messageOf(e, '商家已创建，但切换为当前商家失败')
      }
      return project
    } catch (e) {
      error.value = messageOf(e, '创建商家失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      loading.value = false
    }
  }

  /** 改名 / 改行业 / 改简介（服务端禁止改 id、conversation_key、created_at） */
  async function rename(id: string, patch: UpdateProjectPayload): Promise<Project> {
    loading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.project.update(id, patch)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '保存商家信息失败')
      const project = toProject(res.data)
      upsertLocal(project)
      return project
    } catch (e) {
      error.value = messageOf(e, '保存商家信息失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      loading.value = false
    }
  }

  /** 物理删除（服务端：先删目录 → 再删 DB 行，级联清结构化数据） */
  async function remove(id: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.project.delete(id)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '删除商家失败')
      projects.value = projects.value.filter((p) => p.id !== id)
      // 删的是当前商家 → 清空（服务端也已清 current_project_id，这里同步本地状态）
      if (currentProjectId.value === id) currentProjectId.value = null
    } catch (e) {
      error.value = messageOf(e, '删除商家失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      loading.value = false
    }
  }

  /** 切换当前商家（持久化到 app_meta.current_project_id） */
  async function select(id: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.context.setCurrentProject(id)) as IpcEnvelope<{
        currentProjectId?: string | null
      }>
      if (!res?.ok) throw envelopeToError(res, '切换商家失败')
      currentProjectId.value = res.data?.currentProjectId ?? id
    } catch (e) {
      error.value = messageOf(e, '切换商家失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      loading.value = false
    }
  }

  // ── Business（商家大脑，与 Project 1:1；Commit 04） ────────────────────────

  const business = ref<Business | null>(null) as Ref<Business | null>
  const businessLoading = ref<boolean>(false)

  /**
   * 资料完整度（**Business 维度**）：六个等权字段里填了几个。
   * `missing` 返回字段名（稳定标识），中文展示用 `BUSINESS_FIELD_LABELS`。
   */
  const completeness: ComputedRef<{
    filled: number
    total: number
    percent: number
    missing: string[]
  }> = computed(() => {
    const row = business.value as unknown as Record<string, unknown> | null
    const total = BUSINESS_COMPLETENESS_FIELDS.length
    const missing: string[] = []
    let filled = 0
    for (const field of BUSINESS_COMPLETENESS_FIELDS) {
      const value = row ? row[field] : null
      if (typeof value === 'string' && value.trim()) filled += 1
      else missing.push(field)
    }
    return { filled, total, percent: total ? Math.round((filled / total) * 100) : 0, missing }
  })

  /**
   * 读商家资料。**无行 → `business = null` 且不算错误**（首次填写是正常状态）；
   * 失败也只置 `error`、**不抛出**（与 `load()` 同约定：onMounted 里直接调）。
   */
  async function loadBusiness(projectId: string): Promise<void> {
    businessLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.business.get(projectId)) as IpcEnvelope<any>
      if (!res?.ok) {
        business.value = null
        error.value = envelopeToError(res, '加载商家资料失败').message
        return
      }
      business.value = res.data ? toBusiness(res.data) : null
    } catch (e) {
      business.value = null
      error.value = messageOf(e, '加载商家资料失败')
    } finally {
      businessLoading.value = false
    }
  }

  /**
   * 保存商家资料（服务端 upsert：新建或覆盖）。**失败抛出**（调用方需知道是否真的保存了，
   * 例如决定要不要关弹窗 / 继续下一步）。未传字段服务端保留旧值；空串 = 清空。
   */
  async function saveBusiness(projectId: string, data: Partial<Business>): Promise<Business> {
    businessLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.business.upsert(
        projectId,
        pickBusinessPayload(data)
      )) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '保存商家资料失败')
      const saved = toBusiness(res.data)
      business.value = saved
      return saved
    } catch (e) {
      error.value = messageOf(e, '保存商家资料失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      businessLoading.value = false
    }
  }

  // ── Watchlist（关注词：手工增删，**不采集**；Commit 04） ────────────────────

  const watchlist = ref<WatchItem[]>([]) as Ref<WatchItem[]>
  const watchlistLoading = ref<boolean>(false)

  function upsertWatchLocal(item: WatchItem): void {
    const rest = watchlist.value.filter((w) => w.keyword !== item.keyword)
    watchlist.value = sortWatchlist([...rest, item])
  }

  /** 读关注词列表；失败只置 `error`，**不抛出** */
  async function loadWatchlist(projectId: string): Promise<void> {
    watchlistLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.watchlist.list(projectId)) as IpcEnvelope<any[]>
      if (!res?.ok) {
        watchlist.value = []
        error.value = envelopeToError(res, '加载关注词失败').message
        return
      }
      const rows = Array.isArray(res.data) ? res.data : []
      watchlist.value = sortWatchlist(rows.map(toWatchItem))
    } catch (e) {
      watchlist.value = []
      error.value = messageOf(e, '加载关注词失败')
    } finally {
      watchlistLoading.value = false
    }
  }

  /**
   * 添加关注词。失败抛出，`code` 供 UI 分支：
   *   - `CONFLICT` → 「这个词已在列表里」
   *   - `VALIDATION_ERROR` + `details.max` → 「最多 10 个词」
   */
  async function addWatch(projectId: string, keyword: string, type?: string): Promise<void> {
    watchlistLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.watchlist.add(
        projectId,
        keyword,
        type ?? null
      )) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '添加关注词失败')
      upsertWatchLocal(toWatchItem(res.data))
    } catch (e) {
      error.value = messageOf(e, '添加关注词失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      watchlistLoading.value = false
    }
  }

  /** 删除关注词（服务端幂等，重复删除不会报错） */
  async function removeWatch(projectId: string, keyword: string): Promise<void> {
    watchlistLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.watchlist.remove(projectId, keyword)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '删除关注词失败')
      const word = String(res.data?.keyword ?? keyword)
      watchlist.value = watchlist.value.filter((w) => w.keyword !== word)
    } catch (e) {
      error.value = messageOf(e, '删除关注词失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      watchlistLoading.value = false
    }
  }

  /** 启停关注词（服务端落 `enabled` 0/1；词不存在 → NOT_FOUND） */
  async function setWatchEnabled(projectId: string, keyword: string, enabled: boolean): Promise<void> {
    watchlistLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.watchlist.setEnabled(
        projectId,
        keyword,
        enabled
      )) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '更新关注词失败')
      upsertWatchLocal(toWatchItem(res.data))
    } catch (e) {
      error.value = messageOf(e, '更新关注词失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      watchlistLoading.value = false
    }
  }

  // ── Knowledge（知识库；Commit 05a） ────────────────────────────────

  const knowledge = ref<KnowledgeItem[]>([]) as Ref<KnowledgeItem[]>
  const knowledgeLoading = ref<boolean>(false)

  /**
   * 知识库完整度（Knowledge 维度，§七 v1.13 接入完整度卡片）：
   * `ready` = `status='ready'` 的条目数；**≥ 1 条即视为「已建」**（percent 0/100）。
   * 与 Business 维度的六项等权合看 `overallCompleteness`。
   */
  const knowledgeCompleteness: ComputedRef<{ ready: number; total: number; percent: number }> = computed(() => {
    const total = knowledge.value.length
    const ready = knowledge.value.filter((item) => item.status === KNOWLEDGE_READY_STATUS).length
    return { ready, total, percent: ready > 0 ? 100 : 0 }
  })

  /**
   * 总完整度：**Business 六项 + Knowledge 一项，七项等权**。
   * Knowledge 项用「已建（ready ≥ 1）」而不是条目数：
   * 老板补了 1 份套系单与补了 20 份，在「AI 是否认识这个商家」上没有质的差别。
   */
  const overallCompleteness: ComputedRef<{ filled: number; total: number; percent: number }> = computed(() => {
    const total = BUSINESS_COMPLETENESS_FIELDS.length + 1
    const filled = completeness.value.filled + (knowledgeCompleteness.value.ready > 0 ? 1 : 0)
    return { filled, total, percent: total ? Math.round((filled / total) * 100) : 0 }
  })

  /** 读知识库列表；失败只置 `error`、**不抛出**（与 load() / loadBusiness() 同约定） */
  async function loadKnowledge(projectId: string): Promise<void> {
    knowledgeLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.knowledge.list(projectId)) as IpcEnvelope<any[]>
      if (!res?.ok) {
        knowledge.value = []
        error.value = envelopeToError(res, '加载知识库失败').message
        return
      }
      const rows = Array.isArray(res.data) ? res.data : []
      knowledge.value = sortKnowledge(rows.map(toKnowledgeItem))
    } catch (e) {
      knowledge.value = []
      error.value = messageOf(e, '加载知识库失败')
    } finally {
      knowledgeLoading.value = false
    }
  }

  /**
   * 导入一条知识（文件 / URL / 文本）。成功后**刷新列表**（upsert 会覆盖既有条目，
   * 本地列表靠重拉保证与库一致）。失败抛出，`code` 供 UI 分支：
   *   - `FILE_PARSE_ERROR`（含 `details.reason='scanned-pdf'`）→ 条目标红 + 「重新导入」
   *   - `VALIDATION_ERROR`（老格式 .doc/.xls）/ `FILE_NOT_FOUND` → 就地提示
   */
  async function importKnowledge(
    projectId: string,
    input: ImportKnowledgePayload
  ): Promise<KnowledgeItem> {
    knowledgeLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.knowledge.import(projectId, input)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '导入资料失败')
      const item = toKnowledgeItem(res.data)
      const rest = knowledge.value.filter((k) => k.id !== item.id)
      knowledge.value = sortKnowledge([...rest, item])
      // 重导入会覆盖同一条（id 不变）但也可能改标题/内容，重拉一次确保列表与库一致
      await loadKnowledge(projectId)
      return item
    } catch (e) {
      error.value = messageOf(e, '导入资料失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      knowledgeLoading.value = false
    }
  }

  /** 删除知识条目（服务端幂等；本地列表同步移除） */
  async function removeKnowledge(projectId: string, id: string): Promise<void> {
    knowledgeLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.knowledge.delete(projectId, id)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '删除资料失败')
      knowledge.value = knowledge.value.filter((item) => item.id !== id)
    } catch (e) {
      error.value = messageOf(e, '删除资料失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      knowledgeLoading.value = false
    }
  }

  /**
   * 关键词检索（LIKE，中文友好）。**只读**：失败抛出（UI 要能区分「搜不到」与「搜失败」）。
   * 返回命中片段，不把结果缓存进列表（搜到的不一定是当前 project 的全部资料）。
   */
  async function searchKnowledge(projectId: string, query: string, limit?: number): Promise<KnowledgeHit[]> {
    const res = (await window.api.marketing.knowledge.search(projectId, query, limit)) as IpcEnvelope<any[]>
    if (!res?.ok) throw envelopeToError(res, '检索资料失败')
    const rows = Array.isArray(res.data) ? res.data : []
    return rows.map((row) => ({
      id: String(row?.id ?? ''),
      title: String(row?.title ?? ''),
      snippet: String(row?.snippet ?? '')
    }))
  }

  // ── AI Advisor（Commit 08） ──────────────────────────────────────────────
  //
  // 设计要点（与主进程契约对齐）：
  //   - `onChunk/onDone/onError` 是**全局**订阅（主进程事件名是 07 定死的），
  //     因此这里只订一次、并按**当前 streamId** 过滤——别的面板/别的流不会串台。
  //   - `stopAdvisor()` 既断上游（`abort`）也立刻收尾本地 UI：不等事件回来，避免按钮卡住。
  //   - 扩词候选**不写库**：勾选后走已有的 `addWatch`（04 的上限/去重/CONFLICT 语义全部复用）。
  const advisorMessages = ref<AdvisorMessage[]>([]) as Ref<AdvisorMessage[]>
  const advisorStreaming = ref(false)
  const advisorPack = ref<AdvisorPackSummary | null>(null) as Ref<AdvisorPackSummary | null>
  const advisorError = ref<string | null>(null)
  const advisorPlatform = ref<string | null>(null)
  const advisorCandidates = ref<WatchCandidate[]>([]) as Ref<WatchCandidate[]>
  const advisorCandidatesLoading = ref(false)
  let advisorStreamId: string | null = null
  let advisorOff: Array<() => void> = []
  let advisorSeq = 0

  function advisorNextId(): string {
    advisorSeq += 1
    return `advisor-${advisorSeq}-${Date.now().toString(36)}`
  }

  function advisorLastAssistant(): AdvisorMessage | null {
    for (let i = advisorMessages.value.length - 1; i >= 0; i -= 1) {
      const m = advisorMessages.value[i]
      if (m.role === 'assistant') return m
    }
    return null
  }

  /** 订阅流事件（只订一次）；返回的取消函数在 store 销毁时由调用方调用 */
  function ensureAdvisorSubscription(): void {
    if (advisorOff.length) return
    advisorOff = [
      window.api.marketing.advisor.onChunk((payload) => {
        if (!advisorStreamId || payload?.streamId !== advisorStreamId) return
        const last = advisorLastAssistant()
        if (last?.streaming) last.content += String(payload?.delta ?? '')
      }),
      window.api.marketing.advisor.onDone((payload) => {
        if (!advisorStreamId || payload?.streamId !== advisorStreamId) return
        const last = advisorLastAssistant()
        if (last) {
          last.streaming = false
          last.aborted = payload?.aborted === true
          // 主进程带回了完整文本（含被 abort 时已收到的部分），以它为准
          if (typeof payload?.text === 'string' && payload.text) last.content = payload.text
        }
        advisorStreaming.value = false
        advisorStreamId = null
      }),
      window.api.marketing.advisor.onError((payload) => {
        if (!advisorStreamId || payload?.streamId !== advisorStreamId) return
        const code = String(payload?.error?.code ?? 'DB_ERROR')
        const last = advisorLastAssistant()
        if (last) {
          last.streaming = false
          last.errorCode = code
          if (!last.content) last.content = ERROR_TEXT[code] || String(payload?.error?.message ?? '生成失败')
        }
        advisorError.value = ERROR_TEXT[code] || String(payload?.error?.message ?? '生成失败')
        advisorStreaming.value = false
        advisorStreamId = null
      })
    ]
  }

  /** 释放订阅（页面卸载时调用，避免监听器泄漏） */
  function disposeAdvisor(): void {
    for (const off of advisorOff) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
    advisorOff = []
  }

  /** 问一轮（流式）：本地先插 user/assistant 两条，增量由订阅追加 */
  async function askAdvisor(projectId: string, question: string, platform?: string | null): Promise<void> {
    const q = String(question ?? '').trim()
    if (!q) return
    if (!projectId) throw new MarketingIpcError('VALIDATION_ERROR', '请先选择一个商家')
    advisorError.value = null
    ensureAdvisorSubscription()
    advisorMessages.value.push({
      id: advisorNextId(),
      role: 'user',
      content: q,
      streaming: false,
      aborted: false,
      errorCode: null
    })
    advisorMessages.value.push({
      id: advisorNextId(),
      role: 'assistant',
      content: '',
      streaming: true,
      aborted: false,
      errorCode: null
    })
    advisorStreaming.value = true
    try {
      const res = (await window.api.marketing.advisor.ask({
        projectId,
        question: q,
        platform: platform ?? null
      })) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '提问失败')
      advisorStreamId = String(res.data?.streamId ?? '') || null
      advisorPack.value = (res.data?.pack ?? null) as AdvisorPackSummary | null
    } catch (e) {
      const err = e instanceof MarketingIpcError ? e : envelopeToError(null, '提问失败')
      const code = err.code || 'DB_ERROR'
      const last = advisorLastAssistant()
      if (last) {
        last.streaming = false
        last.errorCode = code
        last.content = last.content || ERROR_TEXT[code] || err.message
      }
      advisorError.value = ERROR_TEXT[code] || err.message
      advisorStreaming.value = false
      advisorStreamId = null
      throw e instanceof Error ? e : new MarketingIpcError(code, advisorError.value)
    }
  }

  /** 停止生成：先断上游，再立刻收尾 UI（幂等；没有在途流时静默返回） */
  async function stopAdvisor(): Promise<void> {
    const id = advisorStreamId
    advisorStreamId = null
    advisorStreaming.value = false
    const last = advisorLastAssistant()
    if (last?.streaming) {
      last.streaming = false
      last.aborted = true
    }
    if (!id) return
    try {
      await window.api.marketing.advisor.abort(id)
    } catch {
      /* 中止失败不弹错：上游最迟会因空闲超时结束，不值得打扰老板 */
    }
  }

  /** 清空对话（切商家时调用；历史由 OpenClaw sticky 会话承载，本地清空不影响服务端隔离） */
  function clearAdvisor(): void {
    advisorMessages.value = []
    advisorPack.value = null
    advisorError.value = null
  }

  /** 扩词候选（不写库；写库走 addWatch） */
  async function loadWatchCandidates(projectId: string, count?: number): Promise<void> {
    advisorCandidatesLoading.value = true
    advisorError.value = null
    try {
      const res = (await window.api.marketing.advisor.watchCandidates(
        projectId,
        count ? { count } : undefined
      )) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '生成候选词失败')
      const rows = Array.isArray(res.data?.candidates) ? res.data.candidates : []
      advisorCandidates.value = rows.map((row: any) => ({
        keyword: String(row?.keyword ?? ''),
        type: row?.type ?? null,
        reason: row?.reason ?? null,
        existing: row?.existing === true
      }))
    } catch (e) {
      advisorError.value = messageOf(e, '生成候选词失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', advisorError.value)
    } finally {
      advisorCandidatesLoading.value = false
    }
  }

  function clearWatchCandidates(): void {
    advisorCandidates.value = []
  }

  // ── 扫描件/图片 AI 识别（Commit 05b） ──────────────────────────────────────
  //
  // 设计要点（硬规则 10：识别文本**人工确认后才入库**）：
  //   - 本切片只产出「待确认文本」，**不写库**；唯一的写入路径是 `commitRecognized`
  //     （确认弹窗的「确认入库」按钮才会调）；
  //   - 增量事件沿用 07 定死的全局事件名（streamId = 05b 的 taskId），与 advisor 同一条
  //     事件通道但按各自 id 过滤，不串台；
  //   - 四路中止（照抄 08）：停止按钮（stopRecognize）/ 切换商家（面板 watch）/
  //     组件卸载（onBeforeUnmount 调 stopRecognize+disposeScan）/ 应用退出（主进程 before-quit）。
  const scanTask = ref<ScanTaskInfo | null>(null) as Ref<ScanTaskInfo | null>
  const scanStreaming = ref(false)
  const scanText = ref('')
  const scanAborted = ref(false)
  const scanPriceSuspected = ref(false)
  const scanErrorCode = ref<string | null>(null)
  const scanErrorReason = ref<string | null>(null)
  const scanErrorMessage = ref<string | null>(null)
  let scanStreamId: string | null = null
  let scanOff: Array<() => void> = []
  /**
   * 代际守卫（外部复审：栅格化窗口切商家会串台）：每次 clearScan/stopRecognize/新调用都推一代，
   * recognizeScan 的 await 续体发现代际变了就**丢弃结果不再回写 state**，并补发一次 abort。
   */
  let scanCallSeq = 0
  /** 当前识别任务的商家（abort 两路定位的 projectId 兼路径；clearScan 时作废） */
  let scanCurrentProjectId: string | null = null

  function scanResetError(): void {
    scanErrorCode.value = null
    scanErrorReason.value = null
    scanErrorMessage.value = null
  }

  /** 订阅识别增量（只订一次；事件名是 07 定的全局通道，按当前 taskId 过滤） */
  function ensureScanSubscription(): void {
    if (scanOff.length) return
    const stream = window.api.marketing.advisor // chunk/done/error 是 07 事件名的全局订阅入口
    scanOff = [
      stream.onChunk((payload) => {
        if (!scanStreamId || payload?.streamId !== scanStreamId) return
        scanText.value += String(payload?.delta ?? '')
      }),
      stream.onDone((payload) => {
        if (!scanStreamId || payload?.streamId !== scanStreamId) return
        scanStreamId = null
        scanStreaming.value = false
        scanAborted.value = payload?.aborted === true
        if (typeof payload?.text === 'string' && payload.text) {
          // 主进程汇总文本是权威形态（多页带页分节头），以它为准
          scanText.value = payload.text
        }
        scanPriceSuspected.value = PRICE_SUSPECT_REGEX.test(scanText.value)
      }),
      stream.onError((payload) => {
        if (!scanStreamId || payload?.streamId !== scanStreamId) return
        scanStreamId = null
        scanStreaming.value = false
        const code = String(payload?.error?.code ?? 'DB_ERROR')
        scanErrorCode.value = code
        scanErrorReason.value =
          typeof (payload?.error?.details as { reason?: unknown } | undefined)?.reason === 'string'
            ? String((payload.error!.details as { reason: string }).reason)
            : null
        scanErrorMessage.value = String(payload?.error?.message ?? ERROR_TEXT[code] ?? '识别失败')
      })
    ]
  }

  /** 释放订阅（页面卸载时调用） */
  function disposeScan(): void {
    for (const off of scanOff) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
    scanOff = []
  }

  /**
   * 发起一次识别（**用户在导入报错处点「用 AI 识别」才会调**，显式触发）。
   * 失败抛出且 `code`/`details.reason` 可供 UI 分支（multimodal 未配置要翻人话）。
   * 若 await 期间发生切商家/停止（代际变了），结果被丢弃并返回 null（已补发 abort）。
   */
  async function recognizeScan(
    projectId: string,
    input: RecognizeScanPayload
  ): Promise<ScanTaskInfo | null> {
    if (!projectId) throw new MarketingIpcError('VALIDATION_ERROR', '请先选择一个商家')
    const seq = ++scanCallSeq
    scanCurrentProjectId = projectId
    scanResetError()
    ensureScanSubscription()
    scanText.value = ''
    scanAborted.value = false
    scanPriceSuspected.value = false
    scanStreaming.value = true
    try {
      const res = (await window.api.marketing.knowledge.recognize(projectId, {
        filePath: input.filePath,
        type: input.type
      })) as IpcEnvelope<any>
      if (seq !== scanCallSeq) {
        // 栅格化窗口里用户切了商家/按了停止：不武装旧任务，并告诉主进程别继续
        const staleTaskId = String(res?.ok && res.data?.taskId ? res.data.taskId : '') || null
        if (res?.ok && staleTaskId) {
          try {
            await window.api.marketing.knowledge.abortRecognize(staleTaskId, projectId)
          } catch {
            /* 尽力中止 */
          }
        }
        return null
      }
      if (!res?.ok) throw envelopeToError(res, '识别失败')
      const info: ScanTaskInfo = {
        taskId: String(res.data?.taskId ?? ''),
        kind: res.data?.kind === 'image' ? 'image' : 'pdf',
        filePath: input.filePath,
        suggestedTitle: String(res.data?.suggestedTitle ?? ''),
        images: Array.isArray(res.data?.images) ? res.data.images : []
      }
      scanTask.value = info
      scanStreamId = info.taskId || null
      return info
    } catch (e) {
      const err = e instanceof MarketingIpcError ? e : envelopeToError(null, '识别失败')
      if (seq !== scanCallSeq) {
        // 已被停止/切商家接管：静默丢弃（用户自己取消的旧任务，错误不该染红新页面）
        return null
      }
      scanStreaming.value = false
      scanStreamId = null
      scanErrorCode.value = err.code || 'DB_ERROR'
      scanErrorReason.value =
        typeof (err.details as { reason?: unknown } | undefined)?.reason === 'string'
          ? String((err.details as { reason: string }).reason)
          : null
      scanErrorMessage.value = err.message
      throw e instanceof Error ? e : new MarketingIpcError(scanErrorCode.value!, err.message)
    }
  }

  /**
   * 停止识别：先断上游，再立刻收尾本地 UI（幂等；没有在途任务时静默返回）。
   * abort 两路定位（外部复审：栅格化窗口里手里没 taskId，不能空转）：
   * `abortRecognize(taskId ?? null, projectId)` —— 主进程按 taskId 或「该商家全部在途」取消。
   */
  async function stopRecognize(): Promise<void> {
    const id = scanStreamId
    const pid = scanCurrentProjectId
    scanCallSeq += 1 // 代际守卫：栅格化窗口里按了停止，之后的续体不得武装旧任务
    scanStreamId = null
    scanStreaming.value = false
    scanAborted.value = true
    if (!id && !pid) return
    try {
      await window.api.marketing.knowledge.abortRecognize(id, pid)
    } catch {
      /* 中止失败不弹错：上游最迟会因空闲超时结束，不值得打扰老板 */
    }
  }

  /** 清空识别状态（确认入库后 / 忽略时 / 切商家时）；推一代使在途 await 续体失效 */
  function clearScan(): void {
    const id = scanStreamId
    const pid = scanCurrentProjectId
    scanCallSeq += 1
    scanStreamId = null
    scanCurrentProjectId = null
    scanTask.value = null
    scanText.value = ''
    scanStreaming.value = false
    scanAborted.value = false
    scanPriceSuspected.value = false
    scanResetError()
    if (id || pid) {
      void window.api.marketing.knowledge.abortRecognize(id, pid).catch(() => {
        /* 尽力中止；失败不扰民 */
      })
    }
  }

  /**
   * 去掉过程性标记的识别文本（确认弹窗与价格判定的基准）。
   * 完成态里 scanText 已是 done 的权威汇总（本就无标记），中止态这里兜底。
   */
  const scanCleanText: ComputedRef<string> = computed(() =>
    String(scanText.value ?? '')
      .replace(SCAN_PROGRESS_MARKER_REGEX, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )

  /**
   * 确认入库（硬规则 10 的人工确认点：UI 必须先把内容给用户校对过才调这里）。
   * 成功刷新列表；失败抛出供弹窗提示。
   */
  async function commitRecognized(
    projectId: string,
    input: CommitRecognizedPayload
  ): Promise<KnowledgeItem> {
    knowledgeLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.knowledge.commitRecognized(projectId, {
        filePath: input.filePath,
        type: input.type,
        title: input.title ?? null,
        content: input.content
      })) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '确认入库失败')
      const item = toKnowledgeItem(res.data)
      await loadKnowledge(projectId)
      clearScan()
      return item
    } catch (e) {
      error.value = messageOf(e, '确认入库失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      knowledgeLoading.value = false
    }
  }

  // ── Content Center（Commit 09） ──────────────────────────────────────────
  //
  // 设计要点：
  //   - 生成一次 = 3 路并行流（三个固定角度）；chunk/done/error 仍是 07 全局事件，
  //     本切片只订一次并按 streamId（`<genTaskId>-<角度key>`）归并到对应版本位；
  //   - 版本行在主进程 done 前已落库（先落库后 done），因此任一流 done 后刷新版本清单必读得到；
  //   - 代际守卫同 05b（await 期间切商家/停止 → 丢弃续体 + 补发 abort）；
  //   - 不自动发布（硬规则 10）：状态推进/发布标记全是人工按钮。
  const contents = ref<ContentItem[]>([]) as Ref<ContentItem[]>
  const contentsLoading = ref<boolean>(false)
  const contentGen = ref<ContentGenState | null>(null) as Ref<ContentGenState | null>
  let contentStreamIds = new Set<string>()
  let contentOff: Array<() => void> = []
  let contentCallSeq = 0
  let contentCurrentProjectId: string | null = null

  const contentGenStreaming: ComputedRef<boolean> = computed(() =>
    (contentGen.value?.angles ?? []).some((a) => a.streaming)
  )

  function ensureContentSubscription(): void {
    if (contentOff.length) return
    const stream = window.api.marketing.advisor // 07 全局事件名的订阅入口（同 05b）
    const slotOf = (streamId: string | undefined | null) => {
      const id = String(streamId ?? '')
      if (!contentStreamIds.has(id)) return null
      return contentGen.value?.angles.find((a) => a.streamId === id) ?? null
    }
    contentOff = [
      stream.onChunk((payload) => {
        const slot = slotOf(payload?.streamId)
        if (slot?.streaming) slot.text += String(payload?.delta ?? '')
      }),
      stream.onDone((payload) => {
        const slot = slotOf(payload?.streamId)
        if (!slot) return
        slot.streaming = false
        slot.aborted = payload?.aborted === true
        // 主进程 done 携带完整文本；中止态也带已收到部分（展示用，版本不落）
        if (typeof payload?.text === 'string' && payload.text) slot.text = payload.text
        slot.done = true
      }),
      stream.onError((payload) => {
        const slot = slotOf(payload?.streamId)
        if (!slot) return
        slot.streaming = false
        slot.done = true
        slot.errorCode = String(payload?.error?.code ?? 'DB_ERROR')
        slot.errorMessage = String(payload?.error?.message ?? '')
      })
    ]
  }

  function disposeContent(): void {
    for (const off of contentOff) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
    contentOff = []
  }

  /** 读内容列表（新→旧）；失败只置 error 不抛出（load 系列同约定） */
  async function loadContents(projectId: string, options?: ContentListQuery): Promise<void> {
    contentsLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.content.list(projectId, options ?? {})) as IpcEnvelope<any[]>
      if (!res?.ok) {
        contents.value = []
        error.value = envelopeToError(res, '加载内容列表失败').message
        return
      }
      const rows = Array.isArray(res.data) ? res.data : []
      contents.value = sortContents(rows.map(toContentItem))
    } catch (e) {
      contents.value = []
      error.value = messageOf(e, '加载内容列表失败')
    } finally {
      contentsLoading.value = false
    }
  }

  /** 手工新建草稿（热点 payload 预填走这里带 sourceTopicId）；失败抛出 */
  async function createContent(projectId: string, data: CreateContentPayload): Promise<ContentItem> {
    contentsLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.content.create(projectId, data)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '新建草稿失败')
      const item = toContentItem(res.data)
      contents.value = sortContents([item, ...contents.value.filter((c) => c.id !== item.id)])
      return item
    } catch (e) {
      error.value = messageOf(e, '新建草稿失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      contentsLoading.value = false
    }
  }

  /** 白名单更新（标题/平台/选题/正文/状态/发布标记/效果备注）；失败抛出 */
  async function updateContent(
    projectId: string,
    id: string,
    patch: UpdateContentPayload
  ): Promise<ContentItem> {
    contentsLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.content.update(projectId, id, patch)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '保存失败')
      const item = toContentItem(res.data)
      contents.value = sortContents(
        contents.value.map((c) => (c.id === item.id ? item : c)).concat(
          contents.value.some((c) => c.id === item.id) ? [] : [item]
        )
      )
      return item
    } catch (e) {
      error.value = messageOf(e, '保存失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      contentsLoading.value = false
    }
  }

  /** 删除内容（幂等；版本随 FK 级联清） */
  async function removeContent(projectId: string, id: string): Promise<void> {
    contentsLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.content.delete(projectId, id)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '删除内容失败')
      contents.value = contents.value.filter((c) => c.id !== id)
    } catch (e) {
      error.value = messageOf(e, '删除内容失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      contentsLoading.value = false
    }
  }

  async function loadContentVersions(projectId: string, id: string): Promise<ContentVersion[]> {
    const res = (await window.api.marketing.content.versions(projectId, id)) as IpcEnvelope<any[]>
    if (!res?.ok) throw envelopeToError(res, '加载版本失败')
    const rows = Array.isArray(res.data) ? res.data : []
    return rows.map(toContentVersion)
  }

  /** 存版本（老板改稿 source=user）；activate=true 同时写回正文 */
  async function saveContentVersion(
    projectId: string,
    id: string,
    input: { content: string; source?: string },
    options?: { activate?: boolean }
  ): Promise<ContentVersion> {
    contentsLoading.value = true
    error.value = null
    try {
      const res = (await window.api.marketing.content.saveVersion(projectId, id, input, options)) as IpcEnvelope<any>
      if (!res?.ok) throw envelopeToError(res, '保存版本失败')
      const item = toContentItem(res.data?.content)
      contents.value = sortContents(contents.value.map((c) => (c.id === item.id ? item : c)))
      return toContentVersion(res.data?.version)
    } catch (e) {
      error.value = messageOf(e, '保存版本失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    } finally {
      contentsLoading.value = false
    }
  }

  /**
   * 发起一次生成（3 版供选）。返回后三路开始流式；若 await 期间切商家/停止（代际变了），
   * 结果丢弃并补发 abort，返回 null（同 05b 语义）。
   */
  async function generateContent(
    projectId: string,
    spec: ContentGenerateSpec
  ): Promise<ContentGenerateResult | null> {
    if (!projectId) throw new MarketingIpcError('VALIDATION_ERROR', '请先选择一个商家')
    const seq = ++contentCallSeq
    contentCurrentProjectId = projectId
    ensureContentSubscription()
    try {
      const res = (await window.api.marketing.content.generate(projectId, spec)) as IpcEnvelope<any>
      if (seq !== contentCallSeq) {
        const staleId = String(res?.ok && res.data?.genTaskId ? res.data.genTaskId : '') || null
        if (res?.ok && staleId) {
          try {
            await window.api.marketing.content.abortGenerate(staleId, projectId)
          } catch {
            /* 尽力中止 */
          }
        }
        return null
      }
      if (!res?.ok) throw envelopeToError(res, '生成失败')
      const anglesRaw = Array.isArray(res.data?.angles) ? res.data.angles : []
      contentStreamIds = new Set(anglesRaw.map((a: any) => String(a?.streamId ?? '')))
      contentGen.value = {
        genTaskId: String(res.data?.genTaskId ?? ''),
        contentId: String(res.data?.contentId ?? ''),
        projectId,
        platform: String(res.data?.platform ?? ''),
        topic: res.data?.topic ?? null,
        pack: (res.data?.pack ?? null) as AdvisorPackSummary | null,
        angles: anglesRaw.map((a: any) => ({
          streamId: String(a?.streamId ?? ''),
          angleKey: String(a?.angle?.key ?? ''),
          label: String(a?.angle?.label ?? ''),
          text: '',
          streaming: true,
          done: false,
          aborted: false,
          errorCode: null,
          errorMessage: null
        }))
      }
      return {
        genTaskId: contentGen.value.genTaskId,
        contentId: contentGen.value.contentId,
        angles: contentGen.value.angles.map((a) => ({ streamId: a.streamId, key: a.angleKey, label: a.label })),
        pack: contentGen.value.pack
      }
    } catch (e) {
      if (seq !== contentCallSeq) return null
      error.value = messageOf(e, '生成失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', error.value)
    }
  }

  /** 停止生成（两路定位）：先断上游再收尾 UI；幂等 */
  async function stopGenerate(): Promise<void> {
    const gen = contentGen.value
    const id = gen?.genTaskId ?? null
    const pid = gen?.projectId ?? contentCurrentProjectId
    contentCallSeq += 1
    if (gen) {
      for (const a of gen.angles) {
        if (a.streaming) {
          a.streaming = false
          a.done = true
          a.aborted = true
        }
      }
    }
    if (!id && !pid) return
    try {
      await window.api.marketing.content.abortGenerate(id, pid)
    } catch {
      /* 中止失败不弹错：上游最迟空闲超时结束 */
    }
  }

  /** 清空生成面板（采纳完成/忽略/切商家）；推代际使在途 await 续体失效 */
  function clearGenerate(): void {
    contentCallSeq += 1
    contentGen.value = null
    contentStreamIds = new Set()
  }

  // ── Hot Radar（Commit 11） ────────────────────────────────────────────────
  //
  // list 打开页即按时间差决定要不要采一轮（force=true 忽略时间差）；后台定时/唤醒在主进程，
  // 渲染端不直接起采集。refresh() 是全局「立即刷新」薄封装（不按 project 隔离）。
  const hotRadar = ref<HotRadarView | null>(null) as Ref<HotRadarView | null>
  const hotLoading = ref(false)
  const hotRefreshing = ref(false)
  const hotError = ref<string | null>(null)
  const hotScoring = ref(false)
  const hotScoreError = ref<string | null>(null)
  const hotSuggestion = ref<HotTodaySuggestion | null>(null)
  const hotScoreProgress = ref<{ scored: number; total: number; remaining: number } | null>(null)
  // C6：请求代际令牌。快速切商家 A→B 时，A 的迟到响应不得覆盖 B 的视图
  // （11 评分恒 null 暂无可见症状，12 上线即会「B 页显示 A 的相关度」）。
  let hotCallSeq = 0
  // Commit 12：评分续批循环的代际令牌（切商家/切平台/手动重评作废旧循环）
  let hotScoreSeq = 0
  let scoreInFlight: Promise<void> | null = null
  let scoreInFlightKey = ''

  async function loadHotRadar(
    projectId: string,
    options?: { platform?: string | null; force?: boolean; skipCollect?: boolean; windowHours?: number }
  ): Promise<HotRadarView> {
    const seq = ++hotCallSeq
    hotLoading.value = true
    hotError.value = null
    try {
      const res = (await window.api.marketing.hot.list(projectId, options ?? {})) as IpcEnvelope<HotRadarView>
      if (!res?.ok) throw envelopeToError(res, '热点雷达加载失败')
      const view = toHotRadar(res.data)
      if (seq !== hotCallSeq) return view // 迟到响应：只返回给当时的调用方，不覆盖当前视图
      hotRadar.value = view
      // C4：listRadar 全源失败时信封仍是 ok（降级裸榜），采集错误藏在 lastError 里——
      // 不提到 hotError，UI 会一直停在「正在完成第一轮采集…」
      if (view.lastError) hotError.value = view.lastError
      return view
    } catch (e) {
      if (seq === hotCallSeq) hotError.value = messageOf(e, '热点雷达加载失败')
      throw e instanceof Error ? e : new MarketingIpcError('DB_ERROR', messageOf(e, '热点雷达加载失败'))
    } finally {
      if (seq === hotCallSeq) hotLoading.value = false
    }
  }

  async function refreshHot(): Promise<HotCollectStatus> {
    const seq = ++hotCallSeq
    hotRefreshing.value = true
    hotError.value = null
    try {
      const res = (await window.api.marketing.hot.refresh()) as IpcEnvelope<HotCollectStatus>
      if (!res?.ok) throw envelopeToError(res, '热点刷新失败')
      return res.data as HotCollectStatus
    } catch (e) {
      if (seq === hotCallSeq) hotError.value = messageOf(e, '热点刷新失败')
      throw e instanceof Error ? e : new MarketingIpcError('HOT_SOURCE_ERROR', messageOf(e, '热点刷新失败'))
    } finally {
      if (seq === hotCallSeq) hotRefreshing.value = false
    }
  }

  /**
   * Commit 12：AI 懒评分续批循环。
   * 后端每批 ≤30（超量按 heat 取前 30），remaining>0 且本批真评了就续下一批；
   * 无待评时后端零模型调用直接返回（含今日建议），所以每次打开雷达调一次也不花钱。
   * 单批失败（真网实测多为网关空闲超时/排队）退让 3s 补试一次，再败才 hotScoreError
   * 黄条、榜单照常浏览；已落库批次 TTL 内不重评，重试与下次打开都只补未评条目（断点续评）。
   * 自动评分同 project×平台 single-flight；手动重新分析（force）不复用、立即起一轮。
   */
  async function runHotScoring(
    projectId: string,
    platform: 'xiaohongshu' | 'douyin',
    // getWindowHours：每批重读一次时间窗——多批评分要跑几十秒，期间用户切 24h→7d，
    // 循环结束后若拿启动时的旧值重载榜单，会出现 tab 在新窗、数据却是旧窗（复审 2）
    options: { force?: boolean; getWindowHours?: () => number } = {}
  ): Promise<void> {
    const key = projectId + '|' + platform
    if (!options.force && scoreInFlight && scoreInFlightKey === key) return scoreInFlight
    const seq = ++hotScoreSeq
    const task = (async (): Promise<void> => {
      hotScoring.value = true
      hotScoreError.value = null
      // 切平台后旧平台建议不得滞留（网关冷启动期间新平台首批未回，宁可不显示也不串台）
      hotSuggestion.value = null
      hotScoreProgress.value = null
      let force = options.force === true
      // 真网实测：30 条/批评分偶发在第二、三批撞网关空闲超时（provider 排队，非确定性错误）。
      // 已落库条目 scored_at 刚刷新、TTL 内不再入选，故重试只会补未评条目，天然断点续评不重复花钱。
      let failures = 0
      const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
      try {
        let guard = 0
        while (guard++ < 20) {
          if (seq !== hotScoreSeq) return
          let res: IpcEnvelope<HotScoreBatchResult>
          try {
            res = (await window.api.marketing.hot.score(
              projectId,
              platform,
              force ? { force: true } : {}
            )) as IpcEnvelope<HotScoreBatchResult>
            if (!res?.ok) throw envelopeToError(res, '热点 AI 分析失败')
          } catch (e) {
            // 单批失败（多为网关空闲超时/未就绪）：退让后补试一次；再败才显黄条终止，
            // 已分组的批次不受影响，下次打开雷达仍会从断点续评
            failures += 1
            if (seq !== hotScoreSeq) return
            if (failures >= 2) throw e
            await delay(3000)
            if (seq !== hotScoreSeq) return
            continue
          }
          if (seq !== hotScoreSeq) return
          failures = 0
          hotSuggestion.value = toSuggestion(res.data.suggestion)
          hotScoreProgress.value = {
            scored: res.data.scored,
            total: res.data.total,
            remaining: res.data.remaining
          }
          // 分数已落库：skipCollect 重读榜单，分组/建议即时归位，不再触发采集
          try {
            await loadHotRadar(projectId, {
              platform,
              skipCollect: true,
              windowHours: options.getWindowHours ? options.getWindowHours() : undefined
            })
          } catch {
            /* 榜单重载失败不杀评分循环：分数已落库，下次 reload/打开页自会带上 */
          }
          if (seq !== hotScoreSeq) return
          if (res.data.remaining <= 0 || res.data.scored === 0) break
          // 续批改回非 force：后端按本轮 force 水位识别未重评条目，TTL 新鲜的不会无限重评
          force = false
          // 批间退让：避免背靠背大请求在网关/provider 侧排队触发空闲超时
          await delay(1500)
          if (seq !== hotScoreSeq) return
        }
        // 复审 4：20 批 guard 耗尽（候选 >600）不能静默结束。保留进度，黄条提示稍后继续；
        // remaining>0 只可能是耗尽（正常 break 时后端 remaining 已为 0）
        if (seq === hotScoreSeq) {
          const progress = hotScoreProgress.value
          if (progress && progress.total > 0 && progress.remaining > 0) {
            hotScoreError.value =
              '热点较多，本轮已分析 ' + Math.max(0, progress.total - progress.remaining) + '/' + progress.total +
              ' 条；其余 ' + progress.remaining + ' 条稍后重新打开雷达会自动续评。'
          }
        }
      } catch (e) {
        if (seq === hotScoreSeq) {
          hotScoreError.value = messageOf(e, '热点 AI 分析失败，榜单照常浏览')
        }
      } finally {
        if (seq === hotScoreSeq) hotScoring.value = false
      }
    })()
    if (!options.force) {
      scoreInFlight = task
      scoreInFlightKey = key
      void task.finally(() => {
        if (scoreInFlight === task) {
          scoreInFlight = null
          scoreInFlightKey = ''
        }
      })
    }
    return task
  }

  /** 切商家/离开页面时清掉旧视图，防串 */
  function clearHot(): void {
    hotCallSeq += 1
    hotScoreSeq += 1
    hotRadar.value = null
    hotError.value = null
    hotScoring.value = false
    hotScoreError.value = null
    hotSuggestion.value = null
    hotScoreProgress.value = null
    scoreInFlight = null
    scoreInFlightKey = ''
  }

  return {
    projects,
    currentProjectId,
    currentProject,
    loading,
    error,
    load,
    create,
    rename,
    remove,
    select,
    business,
    businessLoading,
    completeness,
    loadBusiness,
    saveBusiness,
    watchlist,
    watchlistLoading,
    loadWatchlist,
    addWatch,
    removeWatch,
    setWatchEnabled,
    knowledge,
    knowledgeLoading,
    knowledgeCompleteness,
    overallCompleteness,
    loadKnowledge,
    importKnowledge,
    removeKnowledge,
    searchKnowledge,
    // AI Advisor（Commit 08）
    advisorMessages,
    advisorStreaming,
    advisorPack,
    advisorError,
    advisorPlatform,
    advisorCandidates,
    advisorCandidatesLoading,
    askAdvisor,
    stopAdvisor,
    clearAdvisor,
    loadWatchCandidates,
    clearWatchCandidates,
    disposeAdvisor,
    // 扫描件/图片 AI 识别（Commit 05b）
    scanTask,
    scanStreaming,
    scanText,
    scanCleanText,
    scanAborted,
    scanPriceSuspected,
    scanErrorCode,
    scanErrorReason,
    scanErrorMessage,
    recognizeScan,
    stopRecognize,
    clearScan,
    commitRecognized,
    disposeScan,
    // Content Center（Commit 09）
    contents,
    contentsLoading,
    contentGen,
    contentGenStreaming,
    loadContents,
    createContent,
    updateContent,
    removeContent,
    loadContentVersions,
    saveContentVersion,
    generateContent,
    stopGenerate,
    clearGenerate,
    disposeContent,
    // Hot Radar（Commit 11）
    hotRadar,
    hotLoading,
    hotRefreshing,
    hotError,
    loadHotRadar,
    refreshHot,
    // Commit 12：AI 懒评分 + 今日建议
    hotScoring,
    hotScoreError,
    hotSuggestion,
    hotScoreProgress,
    runHotScoring,
    clearHot
  }
})
