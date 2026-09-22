// work/toolManager.ts —— AI 工具箱（PLAN-3.0.md §十 / §2.2 / §14 tools）
//
// **薄边界**：工具箱只收用户**已有的文本**（粘贴/转写），加工或产出。
// 工具按 §2.2 产出型/加工型分流：
//   产出型 → 结果走 record 候选管线（proposeCandidate）
//   加工型 → 直接回文本，不落任何工作记录
//
// 工具（一期）：
//   minutes   会议纪要（产出型 + 待办提取）
//   email_draft 邮件起草（产出型）
//   polish    润色（加工型）
//   translate 翻译（加工型）
//   summary   摘要（加工型）
//   email_polish 邮件润色（加工型）
//
// 待办提取（minutes）：AI 顺带抽待办 → 每条 source=extracted → candidate，人工确认。
//
// 本模块不 import electron；DB / RecordManager / GatewayClient 注入，纯 Node 可测。

import { AppError, ERROR_CODES } from '../database/errors'
import type { GatewayClient, GatewayStreamHandle } from '../gatewayClient'
import {
  OUTPUT_TYPE_CLASSIFICATION,
  type OutputType
} from './recordManager'
import type { RecordManager } from './recordManager'
import type { TodoManager } from './todoManager'

export const TOOL_IDS = [
  'minutes',
  'email_draft',
  'polish',
  'translate',
  'summary',
  'email_polish'
] as const
export type ToolId = (typeof TOOL_IDS)[number]

export interface ToolInfo {
  id: ToolId
  label: string
  /** productive = 结果进候选；processing = 直接回文本 */
  kind: 'productive' | 'processing'
  /** 是否需要长文本素材 */
  needsSource: boolean
  description: string
}

/** 工具元数据（稳定，UI 渲染按钮；label 用中文） */
export const TOOLS: ToolInfo[] = [
  { id: 'minutes', label: '会议纪要', kind: 'productive', needsSource: true, description: '长文本 → 纪要 + 待办' },
  { id: 'email_draft', label: '邮件起草', kind: 'productive', needsSource: false, description: '要点 → 邮件草稿' },
  { id: 'polish', label: '润色', kind: 'processing', needsSource: true, description: '改通顺/改语气' },
  { id: 'translate', label: '翻译', kind: 'processing', needsSource: true, description: '中英日互译' },
  { id: 'summary', label: '摘要', kind: 'processing', needsSource: true, description: '长文本 → 摘要' },
  { id: 'email_polish', label: '邮件润色', kind: 'processing', needsSource: true, description: '已有草稿改邮件语气' }
]

export interface RunToolParams {
  /** 字符串；getTool 运行时校验（未知 → VALIDATION_ERROR），IPC 边界可安全传 string */
  toolId: string
  /** 已有文本（薄边界：加工型必填；email_draft 可只给要点） */
  text: string
  /** 工具会话键；不传每次唯一（支持「再正式一点」追问时复用） */
  conversationKey?: string
  /** 加工型的额外指令（如「更正式」） */
  instruction?: string
}

export interface ToolRunHandle {
  runId: string
  toolId: ToolId
  conversationKey: string
  stream: GatewayStreamHandle
}

export interface ToolManagerOptions {
  records: RecordManager
  todos: TodoManager
  gateway: GatewayClient
  newId?: () => string
  logger?: (message: string) => void
}

export class ToolManager {
  private readonly records: RecordManager
  private readonly todos: TodoManager
  private readonly gateway: GatewayClient
  private readonly newId: () => string
  private readonly logger?: (message: string) => void
  private readonly runs = new Map<string, ToolRunHandle>()

  constructor(options: ToolManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ToolManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['records', options.records, 'proposeCandidate'],
      ['todos', options.todos, 'create'],
      ['gateway', options.gateway, 'createChatStream']
    ] as const) {
      if (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `ToolManager 缺少依赖: ${name}`)
      }
    }
    this.records = options.records
    this.todos = options.todos
    this.gateway = options.gateway
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  list(): ToolInfo[] {
    return TOOLS
  }

  getTool(id: string): ToolInfo {
    const info = TOOLS.find((t) => t.id === id)
    if (!info) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `未知工具: ${id}`, { field: 'toolId' })
    return info
  }

  /**
   * 运行工具（SSE）：
   *   ① 校验工具 + 素材（加工型必须有文本）
   *   ② 唯一 runId / 工具会话键
   *   ③ 建流（system=工具指令，user=原文+补充指令）
   *   ④ 立即返回；流结束：产出型→proposeCandidate；minutes→额外提取待办
   */
  run(params: RunToolParams): ToolRunHandle {
    const tool = this.getTool(params?.toolId)
    const text = typeof params.text === 'string' ? params.text.trim() : ''

    if (tool.needsSource && !text) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${tool.label}需要提供待处理的文本`, { field: 'text' })
    }
    if (!tool.needsSource && !text && !(params.instruction ?? '').trim()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '邮件起草需提供要点或指令', { field: 'text' })
    }
    const runId = this.newId()
    const conversationKey =
      typeof params.conversationKey === 'string' && params.conversationKey.trim()
        ? params.conversationKey.trim()
        : `conv:work:tool:${tool.id}:${runId}`

    const stream = this.gateway.createChatStream({
      conversationKey,
      messages: [
        { role: 'system', content: buildToolSystemPrompt(tool, params.instruction) },
        { role: 'user', content: text || params.instruction || '' }
      ],
      stream: true
    })
    const handle: ToolRunHandle = { runId, toolId: tool.id, conversationKey, stream }
    this.runs.set(runId, handle)
    void this.finishRun(handle, tool)
    this.log(`[tool] run ${tool.id} runId=${runId}`)
    return handle
  }

  async abortRun(runId: string): Promise<{ aborted: boolean }> {
    const handle = this.runs.get(runId)
    if (!handle) return { aborted: false }
    handle.stream.cancel()
    return { aborted: true }
  }

  /** 流结束收尾：产出型 → 候选；minutes → 待办提取 */
  private async finishRun(handle: ToolRunHandle, tool: ToolInfo): Promise<void> {
    try {
      const result = await handle.stream.result
      if (result.aborted) {
        this.log(`[tool] run=${handle.runId} 中止`)
        return
      }
      if (tool.kind === 'productive') {
        // 产出型 → 走候选管线（去重 + 质量门槛都在 RecordManager）
        await this.records.proposeCandidate({
          content: result.text,
          outputType: handle.toolId as OutputType,
          conversationKey: handle.conversationKey
        })
        // minutes：顺带提取待办（AI 在同一批结果里以约定格式给出）
        if (handle.toolId === 'minutes') {
          await this.extractTodos(result.text, handle.conversationKey)
        }
      }
      // 加工型：不落任何记录，结果已由流推给渲染端
    } catch (e) {
      this.log(`[tool] run=${handle.runId} 失败: ${(e as Error)?.message}`)
    } finally {
      this.runs.delete(handle.runId)
    }
  }

  /**
   * minutes 待办提取（§十：纪要产出型 + 待办提取）。
   *
   * 一期口径：AI 在纪要末尾以 `【待办】- 标题（截止 YYYY-MM-DD）` 固定格式列出，
   * 这里做**确定性解析**（不再发一次模型），每条落 source=extracted → candidate。
   * 解析不到不报错（这次会没有待办）。
   */
  private async extractTodos(minutesText: string, conversationKey: string): Promise<number> {
    const todos = parseTodoBlock(minutesText)
    for (const t of todos) {
      await this.todos.create({
        title: t.title,
        dueDate: t.dueDate ?? null,
        source: 'extracted'
      })
    }
    this.log(`[tool] minutes 提取待办 ${todos.length} 条（${conversationKey}）`)
    return todos.length
  }
}

/** 工具 system 指令（按工具定制；加工型给操作约束） */
function buildToolSystemPrompt(tool: ToolInfo, instruction?: string): string {
  const extra = typeof instruction === 'string' && instruction.trim() ? `\n附加要求：${instruction.trim()}` : ''
  const heads: Record<ToolId, string> = {
    minutes:
      '你是会议纪要助手。把下面的会议文字整理为结构化纪要：结论 / 讨论点 / 待办。\n' +
      '待办必须在末尾以固定格式列出，每行一条：【待办】- 标题（截止 YYYY-MM-DD）；无明确日期则不写括号。\n' +
      '只依据原文，不编造未提及的内容。',
    email_draft:
      '你是邮件起草助手。根据下面的要点写一封结构完整、可直接发送的邮件（称呼/正文/落款）。\n' +
      '语气专业；只依据给定要点，不编造。',
    polish: '你是润色助手。改写下面的文本使其更通顺、专业；保持原意，不增删事实。',
    translate: '你是翻译助手。准确翻译下面的文本，保持原意与术语一致；中文译出时自然流畅。',
    summary: '你是摘要助手。把下面的文本压缩为简洁摘要，保留关键信息，不加评论。',
    email_polish: '你是邮件润色助手。把下面的草稿改为合适的邮件语气；保持事实信息不变。'
  }
  return heads[tool.id] + extra
}

/** 解析纪要末尾待办块：【待办】- 标题（截止 YYYY-MM-DD） */
export function parseTodoBlock(text: string): Array<{ title: string; dueDate: string | null }> {
  const out: Array<{ title: string; dueDate: string | null }> = []
  const lines = String(text ?? '').split(/\r?\n/)
  let inBlock = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/^[【\[]?待办[】\]]?\s*[:：]?$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    // 条目：- 标题（截止 ...）
    const m = line.match(/^[-·*]\s*(.+)$/)
    if (!m) {
      if (line) inBlock = false // 块结束
      continue
    }
    let title = m[1].trim()
    let dueDate: string | null = null
    const dm = title.match(/[（(]截止\s*(\d{4}-\d{2}-\d{2})[）)]/)
    if (dm) {
      dueDate = dm[1]
      title = title.replace(dm[0], '').trim()
    }
    if (title) out.push({ title, dueDate })
  }
  return out
}

export function createToolManager(options: ToolManagerOptions): ToolManager {
  return new ToolManager(options)
}

// 保持分类表引用一致（避免未使用告警）
void OUTPUT_TYPE_CLASSIFICATION
