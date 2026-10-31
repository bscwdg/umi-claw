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
 * - `starting`：启动流程进行中——包含「spawn 之前」的主进程准备阶段
 *   （清理残留 / 配置 patch / doctor），以及「spawn 之后、/health 通之前」的加载阶段。
 */
export const useClawStore = defineStore('claw', () => {
  const running = ref(false)
  const pid = ref<number | undefined>()
  const port = ref(3213)
  const startedAt = ref<number | undefined>()
  const ready = ref(false)
  const starting = ref(false)
  const startupMs = ref<number | undefined>()
  /** 启动阶段：preparing=准备配置 / spawning=已拉起进程 / loading=端口已监听、插件渠道加载中 / ready=已就绪 */
  const phase = ref<'idle' | 'preparing' | 'spawning' | 'loading' | 'ready'>('idle')
  /** 历史估算的总启动耗时（毫秒）：用于「预计还需 N 秒」 */
  const estimatedStartupMs = ref<number | undefined>()
  /** 预计剩余秒数（只在启动中且有历史时有效） */
  const etaRemainingSeconds = computed(() => {
    const est = estimatedStartupMs.value
    const spawnAt = spawnedAt.value
    // 估算的是 spawn→health；准备阶段（还没 spawn）不显示，避免把准备时间重复计入
    if (!est || !starting.value || !spawnAt) return undefined
    if (phase.value !== 'spawning' && phase.value !== 'loading') return undefined
    return Math.max(0, Math.ceil((est - (now.value - spawnAt)) / 1000))
  })
  /** main 侧记录的 spawn 时刻（ETA 基准：估算的是 spawn→health） */
  const spawnedAt = ref<number | undefined>()
  /** 启动失败/超时原因（就绪探测结束后仍失败时给出） */
  const startupError = ref('')
  /** doctor --fix / 状态库迁移进行中（网关未起但非静止）：前端据此显示「正在修复配置…」 */
  const maintenance = ref(false)
  const logs = ref<LogEntry[]>([])
  const maxLogs = 1000

  /**
   * 就绪等待代际：stop / restart / 新一次 start 都会自增。
   * 旧代际里挂起的 waitReady（可能长达数分钟）返回时必须被丢弃，
   * 否则用户主动停止会看到「启动失败」，或自动修复重启成功后残留红色错误条。
   */
  let readyEpoch = 0

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

  /** 启动中已等待秒数（从点击「启动」算起，含主进程准备阶段） */
  const startingSeconds = computed(() => {
    if (!starting.value || !startedAt.value) return 0
    return Math.max(0, Math.floor((now.value - startedAt.value) / 1000))
  })

  /** 当前阶段的中文说明（Dashboard 展示「现在在等什么」） */
  const phaseLabel = computed(() => {
    switch (phase.value) {
      case 'preparing':
        return '准备配置'
      case 'spawning':
        return '启动网关进程'
      case 'loading':
        return '加载渠道插件'
      case 'ready':
        return '已就绪'
      default:
        return '未启动'
    }
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
    if (status.bootPhase) phase.value = status.bootPhase
    if (status.running && typeof status.startedAt === 'number') spawnedAt.value = status.startedAt
    if (typeof status.estimateStartupMs === 'number') estimatedStartupMs.value = status.estimateStartupMs
    if (!status.running) {
      resetReady()
      phase.value = 'idle'
    }
  }

  /**
   * 后台等待网关就绪（不阻塞 start/restart 返回）。
   * 失败/超时写 `startupError`；代际过期（stop/restart）时静默丢弃结果。
   */
  async function trackReady(
    epoch: number,
    timeoutMs?: number
  ): Promise<{ ready: boolean; error?: string; stale?: boolean }> {
    try {
      const result = await window.api.claw.waitReady(timeoutMs)
      if (epoch !== readyEpoch) {
        // 期间用户停止/又重启过：旧等待结果作废，不能覆盖新状态，更不能弹「启动失败」。
        return { ready: false, stale: true }
      }
      if (result.ready) {
        ready.value = true
        starting.value = false
        phase.value = 'ready'
        startupError.value = ''
        startupMs.value = result.elapsedMs
        // 就绪后把计时基准换成 main 的 spawn 时刻，让「运行时长」不含启动准备阶段
        startedAt.value = Date.now() - result.elapsedMs
        return { ready: true }
      }
      starting.value = false
      ready.value = false
      phase.value = 'idle'
      startupError.value = result.error || '网关启动失败'
      return { ready: false, error: startupError.value }
    } catch (e) {
      if (epoch !== readyEpoch) return { ready: false, stale: true }
      starting.value = false
      ready.value = false
      startupError.value = e instanceof Error ? e.message : String(e)
      return { ready: false, error: startupError.value }
    }
  }

  function beginStarting(): number {
    readyEpoch += 1
    phase.value = 'preparing'
    spawnedAt.value = undefined
    running.value = true
    startedAt.value = Date.now()
    starting.value = true
    ready.value = false
    startupError.value = ''
    startupMs.value = undefined
    return readyEpoch
  }

  async function start() {
    // 先进入「启动中」再等主进程：spawn 之前还有 ghost 清理 / 配置 patch / doctor，
    // 这段（可能数分钟）如果不显示启动中，界面会一直停在「已停止」，像点了没反应。
    const epoch = beginStarting()
    const result = await window.api.claw.start()
    if (result.success) {
      void trackReady(epoch)
    } else {
      // 启动失败（含「已在运行中」）：以主进程真实状态为准对齐，并作废本次等待。
      readyEpoch += 1
      await fetchStatus()
    }
    return result
  }

  async function stop() {
    readyEpoch += 1
    phase.value = 'idle'
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
    const epoch = beginStarting()
    const result = await window.api.claw.restart()
    if (result.success) {
      void trackReady(epoch)
    } else {
      readyEpoch += 1
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
      if (data.port) port.value = data.port
      // doctor 修复中：主进程在 maintenanceActive 翻转时主动推一次
      if (typeof data.maintenance === 'boolean') maintenance.value = data.maintenance
      if (typeof data.ready === 'boolean') ready.value = data.ready
      if (typeof data.starting === 'boolean') starting.value = data.starting
      if (typeof data.startupMs === 'number') startupMs.value = data.startupMs
      if (data.bootPhase) phase.value = data.bootPhase
      if (starting.value && typeof data.startedAt === 'number') spawnedAt.value = data.startedAt
      if (typeof data.estimateStartupMs === 'number') estimatedStartupMs.value = data.estimateStartupMs
      // 启动中不要把计时基准换成 main 的 spawn 时间：否则「已等 N 秒」会在 spawn 时被清零
      if (typeof data.startedAt === 'number' && !starting.value) startedAt.value = data.startedAt
      if (data.running) {
        if (!startedAt.value) startedAt.value = Date.now()
        // 网关已就绪（含 exit 78 自动修复后重启成功）：清掉之前的失败提示
        if (data.ready === true) startupError.value = ''
      } else {
        startedAt.value = undefined
        resetReady()
        phase.value = 'idle'
        startupError.value = ''
      }
    })
    return () => {
      offLog()
      offStatus()
    }
  }

  return {
    running, pid, port, startedAt, ready, starting, startupMs, startupError, phase, phaseLabel,
    estimatedStartupMs, etaRemainingSeconds, spawnedAt,
    maintenance, logs, uptime, startingSeconds,
    addLog, clearLogs, fetchStatus,
    start, stop, restart, trackReady, setupListeners
  }
})
