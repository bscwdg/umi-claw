// composables/useWorkStream.ts —— work 域 SSE 流式归并
//
// 订阅 work:stream:{chunk,done,error}（preload 桥），按 runId 过滤，
// 累积 delta 成文本；done/error 收口。多个组件各自 new 一个、只听自己的 runId。
//
// 用法：
//   const s = useWorkStream()
//   s.bind(runId)                 // generate/ask 返回后立刻 bind（别漏早期 chunk）
//   s.text.value                 // 增量文本
//   await s.done                  // 结束（{aborted,text}）
//   s.unsubscribe()             // 组件卸载
//
// 注意：bind 前若事件已到会丢，因此调用方应在 invoke 返回后同步 bind，
// 或用 start() 先订阅再 invoke（推荐后者，见 useOneShotRun）。

import { ref } from 'vue'

export interface StreamDonePayload {
  runId: string
  chunks: number
  text: string | null
  aborted: boolean
}

export function useWorkStream() {
  const text = ref('')
  const runId = ref<string | null>(null)
  const running = ref(false)
  const error = ref<{ code: string; message: string; details?: unknown } | null>(null)
  const aborted = ref(false)

  let currentRunId: string | null = null
  /** bind 前的竞态缓冲：runId → delta[]（flush on bind） */
  const pending = new Map<string, string[]>()
  let resolveDone: ((v: StreamDonePayload) => void) | null = null
  let rejectDone: ((e: NonNullable<typeof error.value>) => void) | null = null
  // Promise settle 不可逆：每次 bind（新一轮运行）必须重建 done，
  // 否则第二次 await 会立即拿到上一轮的旧结果
  let donePromise = makeDonePromise()
  function makeDonePromise(): Promise<StreamDonePayload> {
    return new Promise<StreamDonePayload>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
  }
  let settled = false

  const onChunk = (e: { runId: string; delta: string }): void => {
    if (e.runId === currentRunId) {
      text.value += e.delta
    } else if (!settled) {
      // 还没 bind 或属于别的 run：缓冲（只留近期，防无限增长）
      const arr = pending.get(e.runId) ?? []
      arr.push(e.delta)
      if (arr.length > 4000) arr.shift()
      pending.set(e.runId, arr)
    }
  }
  const onDone = (e: StreamDonePayload): void => {
    if (e.runId === currentRunId || (!settled && pending.has(e.runId))) {
      if (e.text) text.value = e.text
      aborted.value = e.aborted
      currentRunId = e.runId
      finish(e)
    }
  }
  const onError = (e: { runId: string; error: NonNullable<typeof error.value> }): void => {
    if (e.runId === currentRunId || (!settled && pending.has(e.runId))) {
      currentRunId = e.runId
      error.value = e.error
      finishWithError(e.error)
    }
  }

  const offChunk = window.api.work.stream.onChunk(onChunk)
  const offDone = window.api.work.stream.onDone(onDone)
  const offError = window.api.work.stream.onError(onError)

  function finish(payload: StreamDonePayload): void {
    if (settled) return
    settled = true
    running.value = false
    resolveDone?.(payload)
  }
  function finishWithError(e: NonNullable<typeof error.value>): void {
    if (settled) return
    settled = true
    running.value = false
    rejectDone?.(e)
  }

  /** 绑定本次 runId（invoke 返回后立刻调；flush 已缓冲 chunk） */
  function bind(runIdValue: string): void {
    // 先取出缓冲：reset() 会清空 pending，顺序反了则缓冲永远拿不到
    const buffered = pending.get(runIdValue) ?? []
    reset()
    donePromise = makeDonePromise()
    currentRunId = runIdValue
    runId.value = runIdValue
    running.value = true
    if (buffered.length) text.value = buffered.join('')
    pending.delete(runIdValue)
  }

  function reset(): void {
    currentRunId = null
    runId.value = null
    pending.clear()
    text.value = ''
    error.value = null
    aborted.value = false
    running.value = false
    settled = false
  }

  function unsubscribe(): void {
    offChunk()
    offDone()
    offError()
  }

  return {
    text,
    runId,
    running,
    error,
    aborted,
    // getter：bind 会重建 donePromise，这里必须读最新值（值拷贝会永远指向旧 promise）
    get done() {
      return donePromise
    },
    bind,
    reset,
    unsubscribe
  }
}
