// electron/main/ipc/hot.ts —— 热点雷达面 IPC（PLAN-2.0.md Commit 11）
//
// §五 hot 面：list(projectId,{platform,force?,skipCollect?,windowHours?}) / get(topicId) /
// refresh() / score(projectId, platform, {force?})（Commit 12：AI 懒评分，按批续评）。
// 采集是主进程定时/唤醒触发的后台行为，不经 IPC 直接启动子进程——refresh 只是
// 「忽略时间差立即采一轮」的薄封装。
//
// 失败统一信封：{ ok:false, error:{code,message,details?} }（与 content/advisor 同构）。
// listRadar 内部已按 §六「整体失败降级裸榜」处理：采集全败也返回库内热点 + lastError，
// 只有参数错误才回失败信封。

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import type { HotManager, RadarView, HotTopicRow, HotCollectStatus } from '../marketing/hotManager'
import type { HotScoreManager, HotScoreBatchResult } from '../marketing/hotScoreManager'

export type HotIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_HOT_CHANNELS = {
  list: 'marketing:hot:list',
  get: 'marketing:hot:get',
  refresh: 'marketing:hot:refresh',
  score: 'marketing:hot:score'
} as const

let registeredManager: HotManager | null = null

async function wrap<T>(fn: () => Promise<T>): Promise<HotIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<HotIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, fn)
}

export function registerHotIpc(manager: HotManager, scoreManager: HotScoreManager): void {
  registeredManager = manager
  handle(MARKETING_HOT_CHANNELS.list, (_e, projectId: string, options?: { platform?: string | null; force?: boolean; skipCollect?: boolean; windowHours?: number }) =>
    wrap<RadarView>(() => registeredManager!.listRadar(projectId, options || {}))
  )
  handle(MARKETING_HOT_CHANNELS.get, (_e, topicId: string) =>
    wrap<HotTopicRow>(() => registeredManager!.getTopic(topicId))
  )
  handle(MARKETING_HOT_CHANNELS.refresh, () =>
    wrap<HotCollectStatus>(() => registeredManager!.refresh())
  )
  handle(
    MARKETING_HOT_CHANNELS.score,
    (_e, projectId: string, platform: string, options?: { force?: boolean }) =>
      wrap<HotScoreBatchResult>(() => scoreManager.scoreBatch(projectId, platform, options || {}))
  )
}

/** before-quit 调用：杀掉在途 collector 短命子进程 */
export function abortHotCollectors(): number {
  return registeredManager ? registeredManager.cancelActiveCollectors() : 0
}
