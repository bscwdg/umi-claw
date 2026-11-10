// electron/main/claw/types.ts —— 网关状态 / 启动阶段 / 日志条目的公开类型
//
// 为什么单独放：这三个形状同时被主进程 IPC、preload 与渲染端共用，也是 clawManager
// 对外导出的契约；拆到叶子模块后，状态组装（claw/status.ts）与其它子模块都能引用它们，
// 不会再出现「类型定义和 2500 行实现绑在同一个文件」的情况。

export interface ClawStatus {
  running: boolean
  pid?: number
  port: number
  uptime?: number
  startedAt?: number
  /** doctor --fix / 状态库迁移进行中（网关未起但非静止） */
  maintenance?: boolean
  /** 进程已起但 `/health` 还没通（启动中） */
  starting?: boolean
  /** 网关真正可用（`/health` 200） */
  ready?: boolean
  /** 就绪时刻（毫秒时间戳），未就绪为空 */
  readyAt?: number
  /** 最近一次「spawn→就绪」耗时（毫秒），便于前端/日志展示 */
  startupMs?: number
  /** 启动阶段（前端展示「现在在等什么」）：preparing/spawning/loading/ready */
  bootPhase?: BootPhase
  /** 依据最近几次启动历史估算的总耗时（毫秒），用于 UI「预计还需 N 秒」 */
  estimateStartupMs?: number
}

/** 启动阶段：preparing=主进程准备（清理/patch/doctor）；spawning=已拉起进程；loading=端口已监听、插件/渠道加载中 */
export type BootPhase = 'idle' | 'preparing' | 'spawning' | 'loading' | 'ready'

export interface LogEntry {
  line: string
  type: 'stdout' | 'stderr' | 'system'
  time: number
}
