// electron/main/ipc/content.ts —— Content Center 面 IPC（PLAN-2.0.md Commit 09）
//
// 九条通道（§五 content 面枚举 6 条：list/get/create/update/generate/saveVersion；
// 本提交扩面 3 条并在汇报注明，先例：05a import/pickFile、05b recognize/abort）：
//   - `marketing:content:list`            列表（status/platform 过滤）
//   - `marketing:content:get`             单条
//   - `marketing:content:create`          新建草稿（可带热点 payload 的 sourceTopicId）
//   - `marketing:content:update`          白名单更新（含状态机与发布标记，v1.13 口径在 manager 里）
//   - `marketing:content:delete`          删除（幂等；版本随 FK 级联清）**【扩面】**
//   - `marketing:content:generate`        一次生成 3 版供选：三路并行流式（streamId=`<genTaskId>-<角度key>`）
//   - `marketing:content:generate:abort`  停止生成（两路定位：genTaskId / projectId）**【扩面】**
//   - `marketing:content:saveVersion`     存版本（source=user 改稿 / ai；activate=设回正文）
//   - `marketing:content:versions`        版本清单（历史面板）**【扩面】**
//
// 流式增量沿用 07 定死的事件名（chunk/done/error + streamId），经 forwardGatewayStream 转发；
// 每条流的版本落库发生在 wrapped handle 的 result resolve **之前**（先落库后 done，无竞态）；
// 中止/失败的流不落版本（manager 内部语义）。
//
// 失败统一信封：`{ ok: false, error: { code, message, details? } }`（与 advisor/scan 同构）。

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import { forwardGatewayStream, type GatewayStreamSink } from '../gatewayClient'
import type { AdvisorPackSummary } from './advisor'
import { summarizePack } from './advisor'
import type {
  ContentGenerationRun,
  ContentManager,
  ContentRow,
  ContentVersionRow,
  CreateContentInput,
  GenerateContentSpec,
  SaveVersionInput,
  UpdateContentInput
} from '../marketing/contentManager'

export type ContentIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_CONTENT_CHANNELS = {
  list: 'marketing:content:list',
  get: 'marketing:content:get',
  create: 'marketing:content:create',
  update: 'marketing:content:update',
  delete: 'marketing:content:delete',
  generate: 'marketing:content:generate',
  abort: 'marketing:content:generate:abort',
  saveVersion: 'marketing:content:saveVersion',
  versions: 'marketing:content:versions'
} as const

export interface ContentGenerateResult {
  genTaskId: string
  contentId: string
  projectId: string
  /** 产物类型：post（angles=3）/ shooting_script（angles=1 单槽） */
  contentType: string
  /** 业务线预设（shooting_script 用；post 恒 null）—— 不落 schema，只回传供面板复盘 */
  businessLine: string | null
  platform: string
  topic: string | null
  /** 流式面板骨架：streamId + 角度（面板按 streamId 归并 chunk；脚本只有 1 个） */
  angles: Array<{ streamId: string; angle: { key: string; label: string } }>
  /** 「AI 看见了什么」摘要（复用 08 的形状，正文不出主进程） */
  pack: AdvisorPackSummary
}

/** 已登记的流转发（streamId → cancel）与生成任务（genTaskId → streamId 列表） */
const activeStreams = new Map<string, { cancel: () => void }>()
const activeGens = new Map<string, string[]>()
let registeredManager: ContentManager | null = null

async function wrap<T>(fn: () => Promise<T>): Promise<ContentIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<ContentIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => fn(event, ...args))
}

export function registerContentIpc(manager: ContentManager): void {
  registeredManager = manager

  handle(MARKETING_CONTENT_CHANNELS.list, (_e, projectId: string, options?: { status?: string | null; platform?: string | null; limit?: number }) =>
    wrap<ContentRow[]>(() => manager.listContents(projectId, options ?? {}))
  )
  handle(MARKETING_CONTENT_CHANNELS.get, (_e, projectId: string, id: string) =>
    wrap<ContentRow>(() => manager.getContent(projectId, id))
  )
  handle(MARKETING_CONTENT_CHANNELS.create, (_e, projectId: string, input: CreateContentInput) =>
    wrap<ContentRow>(() => manager.createContent(projectId, input ?? ({} as CreateContentInput)))
  )
  handle(MARKETING_CONTENT_CHANNELS.update, (_e, projectId: string, id: string, patch: UpdateContentInput) =>
    wrap<ContentRow>(() => manager.updateContent(projectId, id, patch ?? {}))
  )
  handle(MARKETING_CONTENT_CHANNELS.delete, (_e, projectId: string, id: string) =>
    wrap<{ projectId: string; id: string; deleted: boolean }>(() => manager.deleteContent(projectId, id))
  )

  // ── 生成：一次 3 版供选（三路并行；每条流独立 streamId，面板各自渲染） ──
  handle(MARKETING_CONTENT_CHANNELS.generate, (event, projectId: string, spec: GenerateContentSpec) =>
    wrap<ContentGenerateResult>(async () => {
      const run: ContentGenerationRun = await manager.generate(projectId, spec ?? ({} as GenerateContentSpec))
      const sink = event.sender as unknown as GatewayStreamSink
      const streamIds: string[] = []
      run.streams.forEach((streamHandle, i) => {
        const streamId = run.angles[i].streamId
        const forward = forwardGatewayStream(sink, streamId, streamHandle)
        activeStreams.set(streamId, forward)
        streamIds.push(streamId)
        void forward.done.finally(() => activeStreams.delete(streamId))
      })
      activeGens.set(run.genTaskId, streamIds)
      void Promise.allSettled(run.streams.map((s) => s.result)).finally(() => activeGens.delete(run.genTaskId))
      return {
        genTaskId: run.genTaskId,
        contentId: run.contentId,
        projectId: run.projectId,
        contentType: run.contentType,
        businessLine: run.businessLine ?? null,
        platform: run.platform,
        topic: run.topic,
        angles: run.angles.map((a) => ({ streamId: a.streamId, angle: { key: a.angle.key, label: a.angle.label } })),
        pack: summarizePack(run.pack)
      } satisfies ContentGenerateResult
    })
  )

  // 停止生成：两路定位（有 genTaskId 按任务；栅格化类比——渲染端 await 期间切商家只有 projectId）。
  // 幂等：未找到 → aborted:false 不报错。中止后三路 done/落库都不发生（manager 里 isCancelled 拦截）。
  handle(MARKETING_CONTENT_CHANNELS.abort, (_e, genTaskId?: string | null, projectId?: string | null) =>
    wrap<{ genTaskId: string; projectId: string | null; aborted: boolean }>(async () => {
      const id = typeof genTaskId === 'string' ? genTaskId.trim() : ''
      const pid = typeof projectId === 'string' ? projectId.trim() : ''
      let aborted = false
      if (registeredManager) {
        if (id) aborted = registeredManager.cancelGeneration(id)
        else if (pid) aborted = registeredManager.cancelGenerationByProject(pid) > 0
      }
      for (const sid of id ? activeGens.get(id) ?? [] : []) {
        try {
          activeStreams.get(sid)?.cancel()
        } catch {
          /* 忽略 */
        }
      }
      return { genTaskId: id, projectId: pid || null, aborted }
    })
  )

  handle(
    MARKETING_CONTENT_CHANNELS.saveVersion,
    (_e, projectId: string, id: string, input: SaveVersionInput, options?: { activate?: boolean }) =>
      wrap<{ version: ContentVersionRow; content: ContentRow }>(() =>
        manager.saveVersion(projectId, id, input ?? ({} as SaveVersionInput), options ?? {})
      )
  )
  handle(MARKETING_CONTENT_CHANNELS.versions, (_e, projectId: string, id: string) =>
    wrap<ContentVersionRow[]>(() => manager.listVersions(projectId, id))
  )
}

/** 退出前中止所有在途生成（before-quit 第四路；照抄 08/05b） */
export function abortAllContentGenerations(): number {
  let count = 0
  for (const [, forward] of activeStreams) {
    try {
      forward.cancel()
    } catch {
      /* 忽略 */
    }
  }
  activeStreams.clear()
  activeGens.clear()
  if (registeredManager) count = registeredManager.cancelAllGenerations()
  return count
}

/** 巡检用：已登记流数（不参与业务判定） */
export function activeContentStreamCount(): number {
  return activeStreams.size
}
