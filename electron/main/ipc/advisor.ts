// electron/main/ipc/advisor.ts —— AI Advisor 面 IPC（PLAN-2.0.md Commit 08）
//
// 三条通道（08 自己的业务通道；流式事件名沿用 07 的约定）：
//   - `marketing:advisor:ask`            → 发起一轮问答：组装 Context Pack（06）→ 调 Gateway（07）
//                                          流式推给**发起调用的那个渲染进程**（`event.sender`），
//                                          立即返回 `{ streamId, pack: 摘要 }` 让面板能在流开始前就渲染「AI 看见了什么」
//   - `marketing:advisor:abort`          → 停止生成（按 streamId 中止上游；07 已验「真断连」）
//   - `marketing:advisor:watchCandidates`→ Watchlist AI 扩词候选（§七 08；**不写库**，用户勾选后走 04 的 addWatch）
//
// 流式增量走 07 定死的事件名（`marketing:gateway:chunk` / `done` / `error`，payload 带 `streamId`）：
// 07 只提供 `forwardGatewayStream` 助手与事件名，**注册归业务提交**（§五 的两条边界之一）。
//
// 失败统一信封：`{ ok: false, error: { code, message, details? } }`（与 ipc/marketing.ts 同构）

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import { forwardGatewayStream, type GatewayStreamSink } from '../gatewayClient'
import type { AdvisorAskInput, AdvisorManager, WatchCandidate } from '../marketing/advisorManager'
import type { ContextPack } from '../marketing/contextEngine'

export type AdvisorIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_ADVISOR_CHANNELS = {
  ask: 'marketing:advisor:ask',
  abort: 'marketing:advisor:abort',
  watchCandidates: 'marketing:advisor:watchCandidates'
} as const

/** 「AI 看见了什么」的**摘要**（不含资料正文：正文留在主进程，避免无谓地过渲染进程） */
export interface AdvisorPackSummary {
  knowledgeIncluded: number
  knowledgeTotal: number
  knowledgeDropped: number
  mode: 'full' | 'truncated'
  retrievalMode: string
  usedTokens: number
  budgetTokens: number
  contextWindowTokens: number
  /** 商家资料完整度 + 缺口（面板据此提示「补上价目表可到 80%」/「建议补充：…」） */
  businessCompleteness: { percent: number; missing: string[] }
  watchlistCount: number
}

export interface AdvisorAskResult {
  streamId: string
  projectId: string
  platform: string | null
  pack: AdvisorPackSummary
}

export interface AdvisorWatchCandidatesResult {
  candidates: WatchCandidate[]
}

/** 在途流（streamId → 取消器）；`abort` 与流结束都以它为准，避免面板泄漏上游请求 */
const activeStreams = new Map<string, { cancel: () => void }>()

async function wrap<T>(fn: () => Promise<T>): Promise<AdvisorIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<AdvisorIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => fn(event, ...args))
}

/** Context Pack → 面板摘要（纯映射，不动数据） */
export function summarizePack(pack: ContextPack): AdvisorPackSummary {
  return {
    knowledgeIncluded: pack.budget.knowledgeIncluded,
    knowledgeTotal: pack.budget.knowledgeTotal,
    knowledgeDropped: pack.budget.knowledgeDropped,
    mode: pack.budget.mode,
    retrievalMode: pack.retrieval.mode,
    usedTokens: pack.budget.usedTokens,
    budgetTokens: pack.budget.budgetTokens,
    contextWindowTokens: pack.budget.contextWindowTokens,
    businessCompleteness: {
      percent: pack.businessCompleteness.percent,
      missing: [...pack.businessCompleteness.missing]
    },
    watchlistCount: pack.watchlist.length
  }
}

let streamSeq = 0

export function registerAdvisorIpc(advisor: AdvisorManager): void {
  handle(MARKETING_ADVISOR_CHANNELS.ask, (event, input: AdvisorAskInput) =>
    wrap<AdvisorAskResult>(async () => {
      const turn = await advisor.ask(input ?? ({} as AdvisorAskInput))
      const streamId = `advisor-${++streamSeq}-${Date.now().toString(36)}`
      // 推给**发起调用的那个** webContents（多窗口/多面板各自归并自己的 streamId）
      const sink = event.sender as unknown as GatewayStreamSink
      const forward = forwardGatewayStream(sink, streamId, turn.handle)
      activeStreams.set(streamId, forward)
      void forward.done.finally(() => activeStreams.delete(streamId))
      return {
        streamId,
        projectId: turn.projectId,
        platform: turn.platform,
        pack: summarizePack(turn.pack)
      } satisfies AdvisorAskResult
    })
  )

  handle(MARKETING_ADVISOR_CHANNELS.abort, (_event, streamId: string) =>
    wrap<{ streamId: string; aborted: boolean }>(async () => {
      const id = typeof streamId === 'string' ? streamId.trim() : ''
      const forward = id ? activeStreams.get(id) : undefined
      if (!forward) {
        // 幂等：流已结束/不存在都不算错误（面板卸载时总会调一次 abort）
        return { streamId: id, aborted: false }
      }
      forward.cancel()
      activeStreams.delete(id)
      return { streamId: id, aborted: true }
    })
  )

  handle(MARKETING_ADVISOR_CHANNELS.watchCandidates, (_event, projectId: string, options?: { count?: number }) =>
    wrap<AdvisorWatchCandidatesResult>(async () => {
      const res = await advisor.suggestWatchlist(projectId, options ?? {})
      return { candidates: res.candidates }
    })
  )
}

/** 退出前中止所有在途流（避免应用退出时还挂着上游请求） */
export function abortAllAdvisorStreams(): number {
  const count = activeStreams.size
  for (const [, forward] of activeStreams) {
    try {
      forward.cancel()
    } catch {
      /* 忽略 */
    }
  }
  activeStreams.clear()
  return count
}
