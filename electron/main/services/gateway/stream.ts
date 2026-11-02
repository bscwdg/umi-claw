// electron/main/services/gateway/stream.ts —— SSE 增量 → IPC 事件透传助手
//
// 为什么下沉（4.1 WP6-b）：`ipc/{advisor,content,scan,hot}.ts` 要搬进 marketing 插件目录，
// 它们用 `forwardGatewayStream` / `MARKETING_STREAM_EVENTS`；插件只能 import services，
// 所以把纯函数与事件名从 gatewayClient 挪到这里。gatewayClient 继续 re-export 兼容旧引用。
//
// 不 import electron：sink 用结构化接口（send / isDestroyed? / once?），纯 Node 可测。

import { ERROR_CODES, errorCodeOf, type ErrorEnvelope } from '../errors'

/** SSE → IPC 透传的事件名（主进程 → 渲染进程）；work 域默认用这套 */
export const GATEWAY_STREAM_EVENTS = {
  chunk: 'work:stream:chunk',
  done: 'work:stream:done',
  error: 'work:stream:error'
} as const

/**
 * 营销域的流事件名（2.0 定死，渲染端 `stores/marketing.ts` 按它订阅）。
 * 4.0 合并（MERGE-INVENTORY C-1）：两套都保留，第 4 个参数决定用哪套，默认 work。
 */
export const MARKETING_STREAM_EVENTS = {
  chunk: 'marketing:gateway:chunk',
  done: 'marketing:gateway:done',
  error: 'marketing:gateway:error'
} as const

export interface GatewayStreamEventSet {
  chunk: string
  done: string
  error: string
}

export interface GatewayStreamDelta {
  /** 增量序号（从 1 开始，顺序即 SSE 顺序） */
  index: number
  /** 本次增量文本（可能为空串——只有 usage/finish 帧时） */
  delta: string
}

export interface GatewayStreamResultLike {
  text: string
  chunks: number
  aborted: boolean
  deliverable?: string | null
}

export interface GatewayStreamHandleLike {
  iterator: AsyncIterable<GatewayStreamDelta>
  result: Promise<GatewayStreamResultLike>
  cancel(): void
}

/** 只需要 `send` 的结构化 webContents（不 import electron；假对象只打点 send） */
export interface GatewayStreamSink {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
  /** 可选：渲染进程销毁时自动中止上游（避免白烧 token） */
  once?(event: string, listener: () => void): void
}

function isStreamHandle(source: unknown): source is GatewayStreamHandleLike {
  return Boolean(source) && typeof (source as GatewayStreamHandleLike).cancel === 'function'
}

export function toEnvelope(e: unknown): ErrorEnvelope {
  const code = errorCodeOf(e) ?? ERROR_CODES.OPENCLAW_NOT_READY
  const message = e instanceof Error && e.message ? e.message : String(e)
  const details = (e as { details?: unknown } | null | undefined)?.details
  const envelope: ErrorEnvelope = { code, message }
  if (details !== undefined) envelope.details = details
  return envelope
}

/**
 * 把流式增量按事件名推给渲染进程（只提供助手，不注册业务流通道）。
 *
 * - chunk → `{ runId, streamId, index, delta }`（两域键都发，兼容 2.0/3.0 渲染端）
 * - done  → `{ runId, streamId, chunks, text, aborted, deliverable }`
 * - error → `{ runId, streamId, error: { code, message, details? } }`
 * - `cancel()`：先中止上游，再停止推送；cancel 之后一个事件都不再发。
 */
export function forwardGatewayStream(
  webContents: GatewayStreamSink,
  runId: string,
  source: AsyncIterable<GatewayStreamDelta> | GatewayStreamHandleLike,
  events: GatewayStreamEventSet = GATEWAY_STREAM_EVENTS
): { cancel: () => void; done: Promise<void> } {
  const id = String(runId)
  let cancelled = false
  const handle = isStreamHandle(source) ? source : null
  const iterator: AsyncIterable<GatewayStreamDelta> = handle
    ? handle.iterator
    : (source as AsyncIterable<GatewayStreamDelta>)

  const done = (async () => {
    let chunks = 0
    try {
      for await (const delta of iterator) {
        if (cancelled) break
        if (webContents.isDestroyed?.()) {
          cancelled = true
          handle?.cancel()
          break
        }
        chunks += 1
        webContents.send(events.chunk, {
          runId: id,
          // 兼容键：2.0 的营销流按 `streamId` 归并，3.0 的 work 流按 `runId`。
          streamId: id,
          index: delta.index,
          delta: delta.delta
        })
      }
      if (cancelled) return
      // `handle.result` 的拒绝**不能吞**：落版本/解析结构化产物失败发生在 done 之前，
      // 吞掉会让渲染端收到一次「成功 done」，把未解析的原始输出当正文「采用」。
      const res = handle ? await handle.result : null
      if (cancelled) return
      webContents.send(events.done, {
        runId: id,
        streamId: id,
        chunks: res?.chunks ?? chunks,
        text: res?.text ?? null,
        aborted: res?.aborted ?? false,
        deliverable: res?.deliverable ?? null
      })
    } catch (e) {
      if (cancelled) return
      webContents.send(events.error, { runId: id, streamId: id, error: toEnvelope(e) })
    }
  })()
  done.catch(() => undefined)

  const cancelStream = (): void => {
    if (cancelled) return
    cancelled = true
    handle?.cancel()
  }
  // 渲染进程销毁 → 立刻中止上游（冷启动静默期实测最长 80s，窗口关了还在生成＝白烧 token）。
  // 只靠「每个 chunk 到达时查 isDestroyed()」不够：冷启动静默期根本没有 chunk 到达（复审指出）。
  webContents.once?.('destroyed', cancelStream)

  return {
    cancel: cancelStream,
    done
  }
}
