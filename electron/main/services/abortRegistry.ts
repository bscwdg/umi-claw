// electron/main/services/abortRegistry.ts —— 后台任务中止注册表（4.2 B3）
//
// 为什么要有它：
//   宿主的退出流程原先直接从 `ipc/index.ts`（一个知道所有插件内部结构的 barrel）
//   取 4 个 `abort*` 函数来中止在途流：
//     abortAllAdvisorStreams / abortAllScanStreams / abortAllContentGenerations / abortHotCollectors
//   这 4 个函数**实体都在 plugins/marketing/main/ipc/*.ts**——宿主反向依赖插件内部，
//   是 WP6 之后仍残留的最后一类越界（虽然门禁只扫插件→宿主方向，扫不到这条）。
//
// 而且它们出现在 `disposeHost()` 之后：插件 deactivate 已经中止过一轮，这里只是兜底。
//
// 现在改成插件**自注册**：activate 时把「中止我的后台任务」这个能力登记进来，
// 停用/退出时自动摘除。宿主只持有抽象登记，不知道任何插件内部实现。

export interface AbortRegistry {
  /** 登记一个中止函数，返回摘除函数（适合直接给 ctx.onDispose） */
  register(pluginId: string, abort: () => number): () => void
  /** 依次执行所有登记的中止函数；单个抛错不影响其余；返回中止总数 */
  abortAll(): { total: number; byPlugin: Record<string, number> }
  /** 当前登记数（验收用） */
  size(): number
}

export function createAbortRegistry(): AbortRegistry {
  const entries = new Map<string, Set<() => number>>()

  return {
    register(pluginId, abort) {
      let set = entries.get(pluginId)
      if (!set) {
        set = new Set()
        entries.set(pluginId, set)
      }
      set.add(abort)
      return () => {
        const cur = entries.get(pluginId)
        if (!cur) return
        cur.delete(abort)
        if (cur.size === 0) entries.delete(pluginId)
      }
    },

    abortAll() {
      const byPlugin: Record<string, number> = {}
      let total = 0
      for (const [pluginId, set] of entries) {
        for (const abort of set) {
          try {
            const n = abort()
            if (n > 0) {
              byPlugin[pluginId] = (byPlugin[pluginId] ?? 0) + n
              total += n
            }
          } catch {
            // 单个插件的中止失败不应阻断退出流程（尽力而为，与既有语义一致）
          }
        }
      }
      return { total, byPlugin }
    },

    size() {
      let n = 0
      for (const set of entries.values()) n += set.size
      return n
    }
  }
}
