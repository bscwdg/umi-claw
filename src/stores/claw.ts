import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

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

  const uptime = computed(() => {
    if (!running.value || !startedAt.value) return null
    const ms = Date.now() - startedAt.value
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
  })

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
    }
    return result
  }

  async function stop() {
    const result = await window.api.claw.stop()
    if (result.success) {
      running.value = false
      startedAt.value = undefined
    }
    return result
  }

  async function restart() {
    const result = await window.api.claw.restart()
    if (result.success) {
      running.value = true
      startedAt.value = Date.now()
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
