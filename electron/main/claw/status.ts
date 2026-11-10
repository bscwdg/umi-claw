// electron/main/claw/status.ts —— 把 ClawManager 的实例状态组装成对外的 ClawStatus
//
// 为什么单独拆出来：getStatus 是纯数据拼装（端口以配置为准、starting/ready/bootPhase
// 的优先级、ETA 估算），没有任何副作用；拆成纯函数后状态口径只写一份，
// ClawManager 只负责把当前实例状态喂进来。

import type { BootPhase, ClawStatus } from './types'

/** 组装 ClawStatus 所需的实例状态快照（全部由调用方现取，避免持有 ClawManager 引用） */
export interface ClawStatusState {
  /**
   * 是否持有网关子进程句柄。
   * 刻意用「有没有句柄」而不是「pid 是否已赋值」：spawn 返回后到子进程真正
   * 有 pid 之间存在窗口期，旧实现把 running 判在 `!!this.process` 上，若改成看
   * pid，会在这个窗口里把「正在启动」误报成「已停止」（bootPhase 也一起翻掉）。
   */
  hasProcess: boolean
  processPid: number | undefined
  adoptedPid: number | undefined
  /** 当前配置端口（getStatus 以配置为准，配置缺失时调用方回退到 port） */
  configPort: number
  /** 最近一次启动用的端口 */
  port: number
  startedAt: number | undefined
  maintenanceActive: boolean
  /** 启动 Promise 是否在途（spawn 前的准备阶段也算「启动中」） */
  startInFlight: boolean
  ready: boolean
  readyAt: number | undefined
  bootPhase: BootPhase
  estimateStartupMs: number | undefined
}

export function buildClawStatus(state: ClawStatusState): ClawStatus {
  const running = state.hasProcess || state.adoptedPid !== undefined
  // 端口以当前配置为准（服务可能在 App 重启前就已启动、未走 start()，
  // this.port 会停留在陈旧默认值）；配置缺失才退回最近一次启动用端口
  const currentPort = state.configPort > 0 ? state.configPort : state.port
  return {
    running,
    pid: state.processPid ?? state.adoptedPid,
    port: currentPort,
    uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
    startedAt: state.startedAt,
    // doctor --fix / 状态库迁移进行中：网关虽未起，但也不是静止，
    // 前端据此把「启动中」细化为「正在修复配置…」，避免用户以为卡死重复点击。
    maintenance: state.maintenanceActive,
    // spawn 前的准备阶段（startInFlight 在途）同样算「启动中」，避免刷新窗口显示已停止
    starting: (running && !state.ready) || (state.startInFlight && !state.ready),
    ready: running && state.ready,
    readyAt: state.readyAt,
    startupMs:
      state.adoptedPid !== undefined
        ? undefined
        : state.startedAt && state.readyAt
          ? Math.max(0, state.readyAt - state.startedAt)
          : undefined,
    bootPhase: running
      ? state.ready
        ? 'ready'
        : state.bootPhase
      : state.startInFlight
        ? 'preparing'
        : 'idle',
    estimateStartupMs: state.estimateStartupMs
  }
}
