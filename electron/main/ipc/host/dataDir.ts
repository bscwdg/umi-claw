// electron/main/ipc/host/dataDir.ts —— 数据目录查看 / 更改 / 重启应用 IPC
//
// 为什么单独一个 registrar：数据目录解析在 configManager（依赖 electron），覆盖文件读写
// 在 dataDirBootstrap（纯 Node）。这里只做「选择 → 校验落盘 → 提示重启 → 重启」的透传
// 与信封，依赖全部注入，便于用 fake registrar 做行为测试（本文件不 import electron）。
//
// 优先用信封而不是裸返回：渲染端 call() 依赖 { ok, data } / { ok, error } 解包，
// 失败时按 code 分支（AGENTS §4.2），而「选择目录被取消」是正常路径，必须回 ok:true + null。

import type { ErrorCode } from '../../services/errors'
import type { HostIpcRegistrar } from './types'

export const DATA_DIR_CHANNELS = {
  /** 当前生效目录 + 已保存但未生效的覆盖目录 */
  get: 'config:dataDir:get',
  /** 弹目录选择框 → 校验 → 写入覆盖（取消返回 data:null） */
  choose: 'config:dataDir:choose',
  /** 重启应用使新数据目录生效（延迟执行，保证本次 IPC 回执先送达） */
  restart: 'config:dataDir:restart'
} as const

export interface DataDirIpcDeps {
  /** 当前生效的数据目录（重启后才可能变化） */
  getCurrent: () => string
  /** 已保存但尚未生效的覆盖目录（null = 无覆盖） */
  getOverride: () => string | null
  /** 已保存但本次启动不可用（移动盘/网络盘未就绪）的覆盖目录；null = 可用或无覆盖 */
  getOverrideUnusable?: () => string | null
  /** 弹目录选择框；取消返回 null。defaultPath 用于定位到当前/已选目录 */
  chooseDirectory: (defaultPath: string) => Promise<string | null>
  /** 校验并写入覆盖；失败带错误码 */
  setOverride: (
    dir: string
  ) => { ok: true; dataDir: string } | { ok: false; code?: ErrorCode; error: string }
  /** 重启应用（实现方负责延迟，保证 IPC 回执先回到渲染端） */
  restart: () => void
  logger?: (line: string) => void
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } }

function fail(code: ErrorCode, message: string): Envelope<never> {
  return { ok: false, error: { code, message } }
}

export function registerDataDirIpc(ipc: HostIpcRegistrar, deps: DataDirIpcDeps): void {
  ipc.handle(DATA_DIR_CHANNELS.get, () => ({
    ok: true,
    data: {
      current: deps.getCurrent(),
      override: deps.getOverride(),
      // 覆盖目录存在但本次启动不可用：UI 要提示「已临时回退默认目录」，不能误导成「重启生效」
      overrideUnusable: deps.getOverrideUnusable?.() ?? null
    }
  }))

  ipc.handle(DATA_DIR_CHANNELS.choose, async (): Promise<Envelope<{
    dataDir: string
    previous: string
    requiresRestart: boolean
  } | null>> => {
    let picked: string | null
    try {
      picked = await deps.chooseDirectory(deps.getOverride() ?? deps.getCurrent())
    } catch (e) {
      // 对话框本身失败不是用户取消：回信封而不是抛，否则渲染端只能看到英文 invoke 异常
      return fail('DB_ERROR', `打开目录选择框失败：${(e as Error)?.message ?? String(e)}`)
    }
    // 取消是正常路径：ok:true + null，UI 不弹错误
    if (!picked) return { ok: true, data: null }

    let result: ReturnType<DataDirIpcDeps['setOverride']>
    try {
      result = deps.setOverride(picked)
    } catch (e) {
      return fail('DB_ERROR', (e as Error)?.message ?? String(e))
    }
    if (!result.ok) return fail(result.code ?? 'VALIDATION_ERROR', result.error)
    const current = deps.getCurrent()
    return {
      ok: true,
      data: { dataDir: result.dataDir, previous: current, requiresRestart: result.dataDir !== current }
    }
  })

  ipc.handle(DATA_DIR_CHANNELS.restart, () => {
    try {
      deps.restart()
      return { ok: true, data: { restarted: true } }
    } catch (e) {
      return fail('DB_ERROR', `重启应用失败：${(e as Error)?.message ?? String(e)}`)
    }
  })
}
