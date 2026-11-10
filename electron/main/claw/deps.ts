// electron/main/claw/deps.ts —— 拆分出来的 claw 子模块共用依赖形状
//
// 为什么单独一个文件：这些子模块按 AGENTS §4.1 写成「纯函数 + 显式 deps」，
// 日志回调的形状若在 6 个模块里各声明一次，迟早会漂移；集中一处，
// 也方便对照 clawManager.ts 里那份唯一的 _addLog 实现。

/** 网关日志类型（与 clawManager 的 LogEntry['type'] 同口径） */
export type ClawLogType = 'stdout' | 'stderr' | 'system'

/** 显式注入的日志回调：主进程里最终落到 ClawManager._addLog */
export type ClawLogger = (line: string, type: ClawLogType) => void
