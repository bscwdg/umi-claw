import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export interface LogEntry {
  line: string
  type: 'stdout' | 'stderr' | 'system'
  time: number
}

export const useClawStore = defineStore('claw', () => {
  const running = ref(false)
  const pid = ref<number | undefined>()
  const port = ref(3213)
  const startedAt = ref<number | undefined>()
  const logs = ref<LogEntry[]>([])
  const maxLogs = 1000

  // 驱动 uptime 周期刷新的「当前时间」。computed 无法追踪 Date.now()，
  // 必须借助响应式 tick，否则启动后时间会一直停在首次求值的那个值、不再跳动。
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

  // 服务运行时每秒 tick 让 uptime 跳动；停止时清掉定时器，既实现「归零」又省 CPU。
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

  async function fetchStatus() {
    const status = await window.api.claw.status()
    running.value = status.running
    pid.value = status.pid
    port.value = status.port
    startedAt.value = status.startedAt
  }

  async function start() {
    const result = await window.api.claw.start()
    if (result.success) {
      running.value = true
      startedAt.value = Date.now()
    } else {
      // 启动失败（含“已在运行中”）：以主进程真实状态为准对齐，
      // 避免前端按钮卡在“启动”态不随实际状态变化。
      await fetchStatus()
    }
    return result
  }

  async function stop() {
    const result = await window.api.claw.stop()
    if (result.success) {
      running.value = false
      startedAt.value = undefined
    } else {
      await fetchStatus()
    }
    return result
  }

  async function restart() {
    const result = await window.api.claw.restart()
    if (result.success) {
      running.value = true
      startedAt.value = Date.now()
    } else {
      await fetchStatus()
    }
    return result
  }

  // 订阅 IPC 事件
  function setupListeners() {
    const offLog = window.api.claw.onLog((data) => {
      addLog(data as LogEntry)
    })
    const offStatus = window.api.claw.onStatusChange((data) => {
      running.value = data.running
      if (data.running) {
        if (!startedAt.value) startedAt.value = Date.now()
      } else {
        startedAt.value = undefined
      }
    })
    return () => {
      offLog()
      offStatus()
    }
  }

  return {
    running, pid, port, startedAt, logs, uptime,
    addLog, clearLogs, fetchStatus,
    start, stop, restart, setupListeners
  }
})
