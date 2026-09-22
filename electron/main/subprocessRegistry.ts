// subprocessRegistry.ts —— 便携 Node 子进程注册表（PLAN-3.0.md §三 / 硬规则 2）
//
// 所有「便携 Node 拉起的常驻/长任务子进程」（work db-worker、obsidian indexer…）
// 启动即注册：{ name, pid, gracefulStop() }。
// downloadManager._stopRuntimeProcesses() 先逐个 gracefulStop（上限 3s），
// 再按 ExecutablePath 精确 taskkill / pkill —— 保留原 pid 精确匹配逻辑，
// 不退化成按进程名杀。
//
// Electron 无关（纯 Node 可测）。

export interface RegisteredSubprocess {
  /** 唯一名字，如 'work-db-worker' */
  name: string
  /** 子进程 pid */
  pid: number
  /** 优雅停止（超时由调用方控制） */
  gracefulStop: () => Promise<void>
}

export interface StopResult {
  name: string
  pid: number
  ok: boolean
  error?: string
}

class SubprocessRegistry {
  private entries = new Map<string, RegisteredSubprocess>()

  /** 注册并按名字去重（同名覆盖：旧进程应已退出，否则记 warning 日志） */
  register(entry: RegisteredSubprocess): () => void {
    const existing = this.entries.get(entry.name)
    if (existing && existing.pid !== entry.pid) {
      console.warn(`[subprocessRegistry] ${entry.name} 重复注册（旧 pid=${existing.pid}）`)
    }
    this.entries.set(entry.name, entry)
    // 返回反注册函数，子进程 exit 时调用
    return () => {
      const cur = this.entries.get(entry.name)
      if (cur && cur.pid === entry.pid) this.entries.delete(entry.name)
    }
  }

  unregister(name: string): void {
    this.entries.delete(name)
  }

  list(): RegisteredSubprocess[] {
    return [...this.entries.values()]
  }

  get(name: string): RegisteredSubprocess | undefined {
    return this.entries.get(name)
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * 逐个优雅停止（等待上限 timeoutMs）。单个失败不阻断其他进程，
   * 失败信息随结果返回，供调用方决定是否落到强杀分支。
   */
  async stopAll(timeoutMs = 3000): Promise<StopResult[]> {
    const entries = this.list()
    const results: StopResult[] = []
    for (const entry of entries) {
      try {
        await withTimeout(entry.gracefulStop(), timeoutMs, entry.name)
        results.push({ name: entry.name, pid: entry.pid, ok: true })
      } catch (e) {
        results.push({
          name: entry.name,
          pid: entry.pid,
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return results
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} 优雅停止超时（${timeoutMs}ms）`)),
      timeoutMs
    )
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 全局单例：主进程各处共享同一个注册表 */
export const subprocessRegistry = new SubprocessRegistry()
