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
const ERROR_TEXT: Record<string, string> = {
  VALIDATION_ERROR: '填写内容不合法，请检查后重试',
  NOT_FOUND: '该商家不存在，可能已被删除',
  CONFLICT: '与已有数据冲突，请检查后重试',
  DB_ERROR: '数据保存失败，请稍后重试',
  SETUP_REQUIRED: '请先完成环境初始化（运行时未就绪）',
  OPENCLAW_NOT_READY: 'OpenClaw 尚未启动，请稍后重试',
  OPENCLAW_TIMEOUT: '请求超时，请重试',
  OPENCLAW_AUTH_ERROR: 'OpenClaw 鉴权失败，请检查配置',
  FILE_NOT_FOUND: '原始文件不存在',
  FILE_PARSE_ERROR: '文件解析失败'
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
    searchKnowledge
  }
})
