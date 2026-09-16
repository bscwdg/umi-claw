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

/** 新建的排前面（同级按 id 收敛，避免渲染顺序抖动） */
function sortProjects(list: Project[]): Project[] {
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
    select
  }
})
