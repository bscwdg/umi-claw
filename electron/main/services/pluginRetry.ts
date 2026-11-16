// electron/main/services/pluginRetry.ts —— 失败插件重试编排（纯 Node，无 electron 依赖）
//
// 为什么单独成文件：启动时便携 Node 未就绪 → 插件库 worker 打不开 → work/marketing 激活失败
// 被记成 failed；环境初始化（init/update/updateNode）成功后需要自动恢复。这段编排有三条容易
// 写错的约束：
//   1. **单飞**：env 成功后的自动重试与插件页「刷新」触发的手动重试可能并发；两轮都拿同一份
//      失败快照，后一轮会把前一轮刚激活插件手里的 ctx.db dispose 掉 → 插件显示 activated 但
//      库已关闭，直到重启。这里用同一个 in-flight promise 合并并发调用。
//   2. **逐目标复核**：disposeFor 是 await；等待期间插件可能已被别的路径恢复，或用户刚点了
//      「停用」。disable 后若仍 setEnabled(true) 会把用户意图覆盖掉。所以 dispose 前、enable
//      前都要用最新状态重新判定（enabled && failed && 非清单级失败）。
//   3. **afterEnable 只对真正 activated 的插件调用**：宿主用它补「启用后迁移」（work 的用户
//      协议状态迁移）；失败只日志，不改变重试结果。
//
// 验收（test/plugin-retry.accept.mjs）直接 bundle 本文件打真源码，不 mock 这些分支。

import type { PluginStatus } from '../kernel/lifecycle'

/** 重试判定所需的最小状态快照（不直接依赖 registry 内部结构，便于纯 Node 打真源码） */
export interface RetryCandidate {
  id: string
  enabled: boolean
  state: string
  /** 失败阶段：manifest = 清单级失败（重试无意义） */
  errorStage?: string
}

export interface PluginRetryHost {
  /** 取最新插件状态快照（每次调用都重新取，用于并发/停用竞态复核） */
  list: () => RetryCandidate[]
  /** 关闭该插件的库缓存；失败只日志，不影响继续重试 */
  disposeFor: (id: string) => Promise<void> | void
  /** 走 lifecycle 的 retry 语义：仅 enabled + failed + 非清单级失败才真正激活 */
  retry: (id: string) => Promise<unknown>
  /** 重试成功且已 activated 后补一次宿主「启用后」迁移；失败只日志 */
  afterEnable?: (id: string) => Promise<unknown> | void
  /** 有目标且跑完后广播一次 plugin:changed（无目标不广播） */
  broadcast?: () => void
  logger?: (line: string) => void
}

export interface PluginRetrier {
  /**
   * 重试所有「启用 + 运行时失败」的插件。并发调用合并为同一次执行；返回时无论成败都已 settle
   * （单个插件失败不影响其它，失败只日志）。
   */
  retryFailed: () => Promise<void>
}

/** 可重试 = 启用 + 运行时失败（清单级失败要重新构建，重试无意义） */
export function isRetryableCandidate(candidate: RetryCandidate | null | undefined): boolean {
  if (!candidate) return false
  return candidate.enabled && candidate.state === 'failed' && candidate.errorStage !== 'manifest'
}

export function createPluginRetrier(host: PluginRetryHost): PluginRetrier {
  let inflight: Promise<void> | null = null

  const log = (line: string): void => host.logger?.(line)

  /** 在 dispose/enable 前重新读状态；插件不存在/已不满足条件就跳过 */
  const freshCandidate = (id: string): RetryCandidate | undefined =>
    host.list().find((candidate) => candidate.id === id)

  const run = async (): Promise<void> => {
    // 快照只用于确定「有哪些候选」；每个目标真正动手前还要逐条复核
    const targets = host.list().filter(isRetryableCandidate)
    if (!targets.length) return

    const reactivated: string[] = []
    for (const target of targets) {
      // 1) dispose 前复核：上一轮（或别的路径）可能已把它恢复
      if (!isRetryableCandidate(freshCandidate(target.id))) continue
      try {
        await host.disposeFor(target.id)
      } catch (e) {
        // 清缓存失败不阻塞重试：下一次 forPlugin 仍会建新 client
        log(`[plugin:${target.id}] 重试前清理插件库失败（继续重试）：${(e as Error)?.message ?? e}`)
      }
      // 2) dispose 是 await：期间可能被另一轮重试/用户停用插队；enable 前必须复核，
      //    否则会把用户刚停用的插件重新启用（P1 竞态）。
      if (!isRetryableCandidate(freshCandidate(target.id))) continue
      try {
        await host.retry(target.id)
        const after = freshCandidate(target.id)
        if (after?.state === 'activated') reactivated.push(target.id)
      } catch (e) {
        log(`[plugin:${target.id}] 重试激活失败（不影响其它插件）：${(e as Error)?.message ?? e}`)
      }
    }

    // 3) 宿主侧「启用后迁移」只补一次，且只对真正 activated 的插件（work → 用户协议迁移）
    for (const id of reactivated) {
      try {
        await host.afterEnable?.(id)
      } catch (e) {
        log(`[plugin:${id}] 重试激活后 afterEnable 失败（不影响重试结果）：${(e as Error)?.message ?? e}`)
      }
    }
    // onStatusChange 已逐插件广播；全部 settle 后再推一次，保证最终状态一致
    host.broadcast?.()
  }

  return {
    retryFailed(): Promise<void> {
      if (inflight) return inflight
      const task = run().finally(() => {
        if (inflight === task) inflight = null
      })
      inflight = task
      return task
    }
  }
}

/** 生产接线里把 PluginStatus 映射成 RetryCandidate（纯函数，验收可单独断言） */
export function toRetryCandidates(statuses: Array<Pick<PluginStatus, 'id' | 'enabled' | 'state' | 'error'>>): RetryCandidate[] {
  return statuses.map((status) => ({
    id: status.id,
    enabled: status.enabled,
    state: status.state,
    errorStage: status.error?.stage
  }))
}
