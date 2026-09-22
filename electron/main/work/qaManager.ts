// work/qaManager.ts —— 工作问答（PLAN-3.0.md §十 / §六 / §14 qa / §14.1 B1）
//
// 工作问答 **grounded 于工作记忆**：吃 Context Pack（qa scope，近 3 天记录），
// SSE 流式回答。答不出时要能说明「缺什么」，而不是硬编。
//
// 关键：**ask 必须把 runId → Pack 快照存下来**（§14.1，否则 context.snapshot qa 无数据）。
// 不新增表，写进 conversations 行的 metadata.contextSnapshot（同 B1 只读口径）。
//
// 本模块不 import electron；DB / ContextEngine / GatewayClient 注入，纯 Node 可测。

import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { type ContextEngine, type ContextPack, type SnapshotScope, renderContextPackText } from './contextEngine'
import { toView } from './contextManager'
import type { GatewayClient, GatewayStreamHandle } from '../gatewayClient'

/** QA 会话键（长期、滚动摘要，§6.4） */
export const QA_CONVERSATION_KEY = 'conv:work:qa'

export interface AskParams {
  question: string
  /** 默认 conv:work:qa；追问可传同一键 */
  conversationKey?: string
}

export interface QaRunHandle {
  runId: string
  conversationKey: string
  stream: GatewayStreamHandle
}

export interface QaManagerOptions {
  database: DatabaseClient
  contextEngine: ContextEngine
  gateway: GatewayClient
  newId?: () => string
  now?: () => number
  logger?: (message: string) => void
}

export class QaManager {
  private readonly database: DatabaseClient
  private readonly contextEngine: ContextEngine
  private readonly gateway: GatewayClient
  private readonly newId: () => string
  private readonly now: () => number
  private readonly logger?: (message: string) => void
  private readonly runs = new Map<string, QaRunHandle>()

  constructor(options: QaManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'QaManager 需要注入式依赖配置')
    }
    for (const [name, dep, method] of [
      ['database', options.database, 'request'],
      ['contextEngine', options.contextEngine, 'buildPack'],
      ['gateway', options.gateway, 'createChatStream']
    ] as const) {
      if (!dep || typeof (dep as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `QaManager 缺少依赖: ${name}`)
      }
    }
    this.database = options.database
    this.contextEngine = options.contextEngine
    this.gateway = options.gateway
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  private log(m: string): void {
    this.logger?.(m)
  }

  /**
   * 提问（SSE）：
   *   ① 校验问题
   *   ② 组 qa Context Pack（grounding）
   *   ③ 落 user 对话行
   *   ④ 唯一 runId 建流，立即返回
   *   ⑤ 流结束落 assistant 行 + metadata.contextSnapshot（§14.1）
   */
  async ask(params: AskParams): Promise<QaRunHandle> {
    const question = typeof params?.question === 'string' ? params.question.trim() : ''
    if (!question) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '问题不能为空', { field: 'question' })
    }
    if (question.length > 2000) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '问题不能超过 2000 字', { field: 'question' })
    }
    const conversationKey =
      typeof params.conversationKey === 'string' && params.conversationKey.trim()
        ? params.conversationKey.trim()
        : QA_CONVERSATION_KEY

    // Context Pack（qa scope，含本会话历史）
    const pack: ContextPack = await this.contextEngine.buildPack('qa' as SnapshotScope, {
      task: question,
      conversationKey
    })

    const ts = this.now()
    // user 对话行
    await this.database.request('conversations.create', {
      data: {
        id: this.newId(),
        conversation_key: conversationKey,
        run_id: null,
        role: 'user',
        content: question,
        created_at: ts
      }
    })

    const runId = this.newId()
    // system = 渲染后的 Pack（grounding），user = 问题
    const stream = this.gateway.createChatStream({
      conversationKey,
      messages: [
        { role: 'system', content: buildQaSystemPrompt(pack) },
        { role: 'user', content: question }
      ],
      stream: true
    })
    const handle: QaRunHandle = { runId, conversationKey, stream }
    this.runs.set(runId, handle)
    void this.finishRun(handle, pack)
    this.log(`[qa] ask run=${runId}`)
    return handle
  }

  async abortAsk(runId: string): Promise<{ aborted: boolean }> {
    const handle = this.runs.get(runId)
    if (!handle) return { aborted: false }
    handle.stream.cancel()
    return { aborted: true }
  }

  /** 流结束：落 assistant 对话行 + metadata.contextSnapshot（runId 可溯源） */
  private async finishRun(handle: QaRunHandle, pack: ContextPack): Promise<void> {
    try {
      const result = await handle.stream.result
      const ts = this.now()
      if (result.aborted) {
        this.log(`[qa] run=${handle.runId} 中止`)
        // 仍记录一条 aborted assistant（无快照），便于 UI 收尾；非必需，此处不强行落
        return
      }
      const snapshot = toView(pack, 'qa')
      const metadata = JSON.stringify({
        runId: handle.runId,
        conversationKey: handle.conversationKey,
        created_at: ts,
        status: 'confirmed',
        contextSnapshot: snapshot
      })
      await this.database.request('conversations.create', {
        data: {
          id: this.newId(),
          conversation_key: handle.conversationKey,
          run_id: handle.runId,
          role: 'assistant',
          content: result.text,
          metadata,
          created_at: ts
        }
      })
      this.log(`[qa] run=${handle.runId} 完成 → assistant + snapshot`)
    } catch (e) {
      this.log(`[qa] run=${handle.runId} 失败: ${(e as Error)?.message}`)
    } finally {
      this.runs.delete(handle.runId)
    }
  }
}

function buildQaSystemPrompt(pack: ContextPack): string {
  return [
    '你是工作助手，基于下面的工作记忆回答用户问题。',
    '规则：只依据记忆中的事实作答；记忆里没有依据时，明确说「我手头没有相关记录」并指出缺什么；不编造。',
    '回答简洁、结构化，必要时分点。',
    '',
    renderContextPackText(pack)
  ].join('\n')
}

export function createQaManager(options: QaManagerOptions): QaManager {
  return new QaManager(options)
}
