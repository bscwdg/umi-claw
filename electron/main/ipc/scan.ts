// electron/main/ipc/scan.ts —— 扫描件/图片 AI 识别面 IPC（PLAN-2.0.md Commit 05b）
//
// 三条通道（05b 的业务通道；流式增量沿用 07 定死的事件名 + forwardGatewayStream）：
//   - `marketing:knowledge:recognize`          → 显式触发一次识别：取图（扫描 PDF 逐页 / 资料图）→
//                                                逐图经 07 流式送 multimodal → 推 chunk 给发起方；
//                                                立即返回 `{ taskId, kind, images, suggestedTitle }`，
//                                                产出是**待人工确认的文本**（result），不落库
//   - `marketing:knowledge:recognize:abort`     → 停止识别（两路定位：taskId 或 projectId；
//                                                recognizer 的注册表覆盖「栅格化窗口」，不再有空转期；
//                                                幂等，照抄 08 语义）
//   - `marketing:knowledge:commitRecognized`    → 人工确认后入库（05a 联动：knowledgeManager.commitRecognized；
//                                                type=pdf/image、status=ready；硬规则 10 的落点）
//
// §五 扩面说明：`knowledge:` 的枚举里原只有 6 个方法，05a 已扩 import/pickFile；本提交再扩
// recognize / recognize:abort / commitRecognized 三条（已写进 05b 汇报「新增通道」，待拍板补 §五）。
//
// 失败统一信封：`{ ok: false, error: { code, message, details? } }`（与 ipc/advisor.ts 同构）。
// multimodal 未配置 → VALIDATION_ERROR + reason='multimodal-model-not-configured'：
// 预检在栅格化前由 recognizer 抛（stage='precheck'），最终防线在 07（按次解析）——两处同 payload，
// 这里**原样透传**（不包装、不降级）；渲染端翻成人话引导去配置。

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { toErrorEnvelope, type ErrorEnvelope } from '../database/errors'
import { forwardGatewayStream, type GatewayStreamSink } from '../gatewayClient'
import type { ScanRecognizer, RecognitionRun } from '../marketing/scanRecognizer'
import type { CommitRecognizedInput, KnowledgeManager, KnowledgeRow } from '../marketing/knowledgeManager'

export type ScanIpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

export const MARKETING_SCAN_CHANNELS = {
  recognize: 'marketing:knowledge:recognize',
  abort: 'marketing:knowledge:recognize:abort',
  commitRecognized: 'marketing:knowledge:commitRecognized'
} as const

export interface ScanRecognizeInput {
  filePath: string
  type?: string
}

export interface ScanRecognizeResult {
  taskId: string
  projectId: string
  kind: 'pdf' | 'image'
  suggestedTitle: string
  images: Array<{ page: number; width: number; height: number; bytes: number; downscaled: boolean }>
}

/** 已登记的流转发（recognize 返航之后才有）；栅格化窗口内的任务由 recognizer 自己的注册表覆盖 */
const activeScans = new Map<string, { cancel: () => void }>()
let registeredRecognizer: ScanRecognizer | null = null

async function wrap<T>(fn: () => Promise<T>): Promise<ScanIpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: toErrorEnvelope(e) }
  }
}

function handle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<ScanIpcResult<unknown>>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => fn(event, ...args))
}

export function registerScanIpc(scanRecognizer: ScanRecognizer, knowledgeManager: KnowledgeManager): void {
  registeredRecognizer = scanRecognizer

  handle(MARKETING_SCAN_CHANNELS.recognize, (event, projectId: string, input?: ScanRecognizeInput) =>
    wrap<ScanRecognizeResult>(async () => {
      const run: RecognitionRun = await scanRecognizer.recognize(projectId ?? '', {
        filePath: input?.filePath ?? '',
        type: input?.type
      })
      // 推给**发起调用的那个** webContents；事件名/载荷形状是 07 定的（chunk/done/error + streamId）
      const sink = event.sender as unknown as GatewayStreamSink
      const forward = forwardGatewayStream(sink, run.taskId, run.handle)
      activeScans.set(run.taskId, forward)
      void forward.done.finally(() => activeScans.delete(run.taskId))
      return {
        taskId: run.taskId,
        projectId: run.projectId,
        kind: run.kind,
        suggestedTitle: run.suggestedTitle,
        images: run.images.map((img) => ({
          page: img.page,
          width: img.width,
          height: img.height,
          bytes: img.bytes,
          downscaled: img.downscaled
        }))
      } satisfies ScanRecognizeResult
    })
  )

  // 中止。**两路定位**（外部复审：栅格化窗口里渲染端还没拿到 taskId，不能让它空转）：
  //   1) 有 taskId → recognizer.cancelTask（覆盖栅格化窗口）+ 已登记的流转发；
  //   2) 无 taskId 但有 projectId → recognizer.cancelByProject（UI 约束同商家同时至多一个识别）。
  // 幂等：未找到/已结束 → aborted:false，不报错（面板卸载与切商家总会调一次）。
  handle(MARKETING_SCAN_CHANNELS.abort, (_event, taskId: string, projectId?: string) =>
    wrap<{ taskId: string; projectId: string | null; aborted: boolean }>(async () => {
      const id = typeof taskId === 'string' ? taskId.trim() : ''
      const pid = typeof projectId === 'string' ? projectId.trim() : ''
      let aborted = false
      if (registeredRecognizer) {
        if (id) aborted = registeredRecognizer.cancelTask(id)
        else if (pid) aborted = registeredRecognizer.cancelByProject(pid) > 0
      }
      const forward = id ? activeScans.get(id) : undefined
      if (forward) {
        try {
          forward.cancel()
        } catch {
          /* 忽略 */
        }
        activeScans.delete(id)
        aborted = true
      }
      return { taskId: id, projectId: pid || null, aborted }
    })
  )

  // 人工确认后才走到这里（硬规则 10）：确认弹窗的「确认入库」按钮是唯一触发点。
  handle(MARKETING_SCAN_CHANNELS.commitRecognized, (_event, projectId: string, input: CommitRecognizedInput) =>
    wrap<KnowledgeRow>(() => knowledgeManager.commitRecognized(projectId, input ?? ({} as CommitRecognizedInput)))
  )
}

/**
 * 退出前中止所有在途识别（before-quit 第四路；照抄 abortAllAdvisorStreams）。
 * recognizer 自己的注册表覆盖「流式窗口 + 栅格化窗口」两半（栅格化期 forward 尚未登记，
 * activeScans 里根本没有那些任务）。
 */
export function abortAllScanStreams(): number {
  let count = 0
  for (const [, forward] of activeScans) {
    try {
      forward.cancel()
      count += 1
    } catch {
      /* 忽略 */
    }
  }
  activeScans.clear()
  if (registeredRecognizer) {
    // 栅格化窗口/流式窗口里 recognizer 记着的任务（recognize 已返航的那些会被 recognizer
    // 的同一个 cancel 命中； recognizer 注册表在终结时已自删，所以这里只会数到真在途的）
    count += registeredRecognizer.cancelAll()
  }
  return count
}

/** 测试/巡检用：已登记流转发的在途数（不参与任何业务判定） */
export function activeScanCount(): number {
  return activeScans.size
}
