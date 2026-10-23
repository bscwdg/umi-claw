import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** env:progress 广播的进度载荷（主进程定义较宽，这里只声明用到的字段） */
export interface EnvProgress {
  stage: string
  step: string
  percent: number
  done?: boolean
  error?: string
  [key: string]: unknown
}

export type EnvTaskKind = 'init' | 'update' | 'node'

export interface EnvTaskResult {
  success?: boolean
  error?: string
  warning?: string
  inFlight?: boolean
  [key: string]: unknown
}

/**
 * 环境初始化 / OpenClaw 更新 / Node 更新的任务状态。
 *
 * 必须放在 pinia store 而不是 Setup.vue 本地：路由没有 keep-alive，用户在任务
 * 执行期间切到别的页面，Setup.vue 会被卸载，本地进度（initializing/progress/
 * stepLog）连同 onProgress 监听一起消失；切回来后进度卡片不见、还能重复点击
 * 触发第二套安装。store 是单例，IPC 调用与进度订阅都挂在 store 上，组件卸载
 * 不影响任务，重新挂载即可恢复全部进度展示。
 */
export const useEnvSetupStore = defineStore('envSetup', () => {
  /** 进度卡片是否可见（任务完成后也保持，直到用户手动收起） */
  const initializing = ref(false)
  const progress = ref<EnvProgress | null>(null)
  const stepLog = ref<string[]>([])
  const currentKind = ref<EnvTaskKind | null>(null)
  /**
   * 任务是否仍在执行。独立于 progress.done：最终 env:progress 完成通知可能
   * 先于 invoke 回执到达，若用 progress.done 推断会出现短暂「假空闲」窗口，
   * 用户此时再点会重置卡片，而主进程单飞只返回 inFlight，卡片便卡在 0%。
   */
  const taskAlive = ref(false)

  let offProgress: (() => void) | null = null

  /** 任务执行中（以 in-flight 状态为准，不依赖进度载荷推断） */
  const taskRunning = computed(() => taskAlive.value)

  function subscribeProgress() {
    // 重入防护：runTask 开头会先 reset，正常只会有一个订阅；
    // 组件重挂载不重新订阅（订阅生命周期跟随任务而非组件）。
    offProgress?.()
    offProgress = window.api.env.onProgress((p: EnvProgress) => {
      progress.value = p
      const msg = `[${p.stage}] ${p.step}`
      const last = stepLog.value[stepLog.value.length - 1]
      if (last !== msg) stepLog.value.push(msg)
    })
  }

  function unsubscribeProgress() {
    offProgress?.()
    offProgress = null
  }

  /**
   * 执行一个环境任务（初始化 / 更新 / Node 更新）。
   * 单飞：已有任务在跑时直接返回 inFlight，主进程 IPC 层还有第二道同样的兜底。
   * @returns 主进程回执；inFlight 表示本次未实际发起调用
   */
  async function runTask(
    kind: EnvTaskKind,
    initial: EnvProgress,
    invoke: () => Promise<EnvTaskResult>
  ): Promise<EnvTaskResult> {
    if (taskAlive.value) {
      return { success: false, error: '已有环境任务在执行，请等待当前任务完成', inFlight: true }
    }
    currentKind.value = kind
    initializing.value = true
    taskAlive.value = true
    stepLog.value = []
    progress.value = initial
    subscribeProgress()
    try {
      return await invoke()
    } catch (e: any) {
      // 统一兜住 invoke reject（如 IPC 通道异常）：否则卡片停在初始态，
      // 三个调用方也就不必各自写 .catch。错误仍以结果形式返回，由组件落错误卡片。
      return { success: false, error: e?.message || '环境任务执行失败' }
    } finally {
      // invoke 回执即任务终态（组件会据此落完成/失败卡片），之后不再需要广播；
      // 不依赖组件 onUnmounted 摘监听——切走页面时任务仍在跑，监听必须保留。
      unsubscribeProgress()
      taskAlive.value = false
    }
  }

  /** 以 invoke 回执兜底落定终态卡片（最终 env:progress 可能晚于回执到达） */
  function markDone(step: string, extra?: Partial<EnvProgress>) {
    progress.value = { stage: '完成', step, percent: 100, done: true, ...extra }
  }

  function markError(error: string) {
    if (progress.value?.error) return
    progress.value = { stage: '错误', step: error, percent: 0, done: true, error }
  }

  /** 收起进度卡片（「重新尝试」「再次检测」按钮） */
  function dismissCard() {
    initializing.value = false
    progress.value = null
    stepLog.value = []
    currentKind.value = null
  }

  return {
    initializing,
    progress,
    stepLog,
    currentKind,
    taskAlive,
    taskRunning,
    runTask,
    markDone,
    markError,
    dismissCard
  }
})
