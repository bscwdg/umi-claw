import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export interface LogEntry {
  line: string
  type: 'stdout' | 'stderr' | 'system'
  time: number
}

/**
 * OpenClaw 进程/网关状态。
 *
 * 关键区分（2026-10-30 启动优化）：
 * - `running`：**进程已 spawn**（`claw:status.running`）。openclaw 此时还要加载插件/渠道，
 *   端口往往还没监听，`running=true` 不代表能打开网页；
 * - `ready`：`GET /health` 返回 200，网关真正可用；
 * - `starting`：进程在、但还没 ready（长启动期间 UI 显示「启动中 xx s」）。
 */
export const useClawStore = defineStore('claw', () => {
  const running = ref(false)
  const pid = ref<number | undefined>()
  const port = ref(3213)
  const startedAt = ref<number | undefined>()
  const ready = ref(false)
  const starting = ref(false)
  const startupMs = ref<number | undefined>()
  /** 启动失败/超时原因（就绪探测结束后仍失败时给出） */
  const startupError = ref('')
  /** doctor --fix / 状态库迁移进行中（网关未起但非静止）：前端据此显示「正在修复配置…」 */
  const maintenance = ref(false)
  const logs = ref<LogEntry[]>([])
  const maxLogs = 1000

  // 驱动 uptime / 「启动中 xx s」周期刷新的「当前时间」。
  // computed 无法追踪 Date.now()，必须借助响应式 tick。
  const now = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null

  const uptime = computed(() => {
    if (!running.value || !startedAt.value) return null
    const ms = now.value - startedAt.value
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
  })

  /** 启动中已等待秒数（未就绪时展示，避免用户以为卡死） */
  const startingSeconds = computed(() => {
    if (!starting.value || !startedAt.value) return 0
    return Math.max(0, Math.floor((now.value - startedAt.value) / 1000))
  })

  // 运行时每秒 tick 让 uptime / 启动秒数跳动；停止时清掉定时器。
  watch(
    running,
    (isRunning) => {
      if (isRunning) {
        if (!ticker) ticker = setInterval(() => (now.value = Date.now()), 1000)
      } else if (ticker) {
        clearInterval(ticker)
        ticker = null
      }
    },
    { immediate: true }
  )

  function addLog(entry: LogEntry) {
    logs.value.push(entry)
    if (logs.value.length > maxLogs) {
      logs.value = logs.value.slice(-maxLogs)
    }
  }

  function clearLogs() {
    logs.value = []
  }

  function resetReady(): void {
    ready.value = false
    starting.value = false
    startupMs.value = undefined
  }

  async function fetchStatus() {
    const status = await window.api.claw.status()
    running.value = status.running
    pid.value = status.pid
    port.value = status.port
    startedAt.value = status.startedAt
    maintenance.value = !!status.maintenance
    ready.value = !!status.ready
    starting.value = !!status.starting
    startupMs.value = status.startupMs
    if (!status.running) resetReady()
  }

  /**
   * 后台等待网关就绪（不阻塞 start/restart 返回）。
   * 失败/超时写 `startupError`，由页面决定如何提示。
   */
  async function trackReady(timeoutMs?: number): Promise<{ ready: boolean; error?: string }> {
    try {
      const result = await window.api.claw.waitReady(timeoutMs)
      if (result.ready) {
        ready.value = true
        starting.value = false
        startupError.value = ''
        startupMs.value = result.elapsedMs
        return { ready: true }
      }
      starting.value = false
      ready.value = false
      startupError.value = result.error || '网关启动失败'
      return { ready: false, error: startupError.value }
    } catch (e) {
      starting.value = false
      ready.value = false
      startupError.value = e instanceof Error ? e.message : String(e)
      return { ready: false, error: startupError.value }
    }
  }

  function beginStarting(): void {
    running.value = true
    startedAt.value = Date.now()
    starting.value = true
    ready.value = false
    startupError.value = ''
    startupMs.value = undefined
  }

  async function start() {
    const result = await window.api.claw.start()
    if (result.success) {
      beginStarting()
      void trackReady()
    } else {
      // 启动失败（含“已在运行中”）：以主进程真实状态为准对齐
      await fetchStatus()
    }
    return result
  }

  async function stop() {
    const result = await window.api.claw.stop()
    if (result.success) {
      running.value = false
      startedAt.value = undefined
      resetReady()
      startupError.value = ''
    } else {
      await fetchStatus()
    }
    return result
  }

  async function restart() {
    const result = await window.api.claw.restart()
    if (result.success) {
      beginStarting()
      void trackReady()
    } else {
      await fetchStatus()
    }
    return result
  }

  /** 手动重新等待就绪（页面「重试等待」用） */
  async function waitReadyNow(timeoutMs?: number) {
    starting.value = true
    return trackReady(timeoutMs)
  }

  // 订阅 IPC 事件
  function setupListeners() {
    const offLog = window.api.claw.onLog((data) => {
      addLog(data as LogEntry)
    })
    const offStatus = window.api.claw.onStatusChange((data: any) => {
      running.value = data.running
      if (data.port) port.value = data.port
      // doctor 修复中：主进程在 maintenanceActive 翻转时主动推一次
      if (typeof data.maintenance === 'boolean') maintenance.value = data.maintenance
      if (typeof data.ready === 'boolean') ready.value = data.ready
      if (typeof data.starting === 'boolean') starting.value = data.starting
      if (typeof data.startupMs === 'number') startupMs.value = data.startupMs
      if (typeof data.startedAt === 'number') startedAt.value = data.startedAt
      if (data.running) {
        if (!startedAt.value) startedAt.value = Date.now()
      } else {
        startedAt.value = undefined
        resetReady()
      }
    })
    return () => {
      offLog()
      offStatus()
    }
  }

  return {
    running, pid, port, startedAt, ready, starting, startupMs, startupError,
    maintenance, logs, uptime, startingSeconds,
    addLog, clearLogs, fetchStatus,
    start, stop, restart, trackReady, waitReadyNow, setupListeners
  }
})
