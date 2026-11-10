// electron/main/claw/timeout.ts —— 启动前 best-effort 步骤的超时包装
//
// 为什么独立：启动链上「清残留 / 写 checkpoint / 补链接」都可能被磁盘或状态库锁挂住，
// 而它们的超时语义是统一的 —— 超时视为「本次跳过」而不是失败（底层 promise 无法真正取消，
// 但启动链不再等它）。放在这里，clawManager 只做同名薄委托，语义只写一份。

import type { ClawLogger } from './deps'

/**
 * 给启动前的 best-effort 步骤加超时：超时视为「本次跳过」而不是失败。
 * 底层 promise 可能继续在后台跑（无法真正取消），但启动链不再等它。
 * @returns true=任务在预算内结束（成功或失败都算）；false=超时
 */
export async function withTimeout(
  log: ClawLogger,
  task: Promise<unknown>,
  timeoutMs: number,
  label: string
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          log(`${label} 超时（${Math.round(timeoutMs / 1000)}s），已跳过（不影响启动）`, 'stderr')
          resolve(false)
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 带返回值的超时版本（用于必须拿到结果的启动前步骤）。 */
export async function withTimeoutValue<T>(
  log: ClawLogger,
  task: Promise<T>,
  timeoutMs: number,
  label: string,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          log(`${label} 超时（${Math.round(timeoutMs / 1000)}s），已跳过（不影响启动）`, 'stderr')
          resolve(fallback)
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
