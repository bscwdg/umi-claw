import type { NavigationGuard } from 'vue-router'

export interface EnvCheckResult {
  nodeInstalled?: boolean
  openClawInstalled?: boolean
  channelsInstalled?: boolean
  [key: string]: unknown
}

export interface SetupGuardDeps {
  /** 环境探测（生产环境包一层 window.api.env.check()） */
  check: () => Promise<EnvCheckResult>
  /** 出错时的日志出口，默认 console.error */
  onError?: (e: unknown) => void
}

/**
 * 首启 Setup 守卫（Commit 01）
 *
 * 约定（PLAN-2.0.md 第八节）：
 * - **模块级缓存**：env.check() 每个守卫实例只调一次，避免每次导航都走 IPC；
 * - 未完成判定 = `nodeInstalled && openClawInstalled`，**不含 channelsInstalled**
 *   （其语义是个人微信插件 @tencent-weixin/openclaw-weixin 是否就位，与「能不能跑起来」无关）；
 * - 目标已是 `/setup` 直接放行；
 * - env.check 异常**放行**（绝不因探测失败把用户锁死）；
 * - 重定向用 `replace`，避免用户按返回键来回弹；
 * - Setup 完成后由 Setup.vue 触发 `location.reload()`，整页重建 → 守卫实例与缓存一起重置，
 *   此时 env.check 返回已就绪，进 dashboard 不会被弹回。
 */
export function createSetupGuard(deps: SetupGuardDeps): NavigationGuard {
  const onError = deps.onError ?? ((e: unknown) => console.error('环境检测失败，放行导航：', e))
  let checked = false
  let setupRequired = false

  return async (to) => {
    if (!checked) {
      checked = true
      try {
        const info = await deps.check()
        setupRequired = !(info?.nodeInstalled && info?.openClawInstalled)
      } catch (e) {
        onError(e)
        setupRequired = false
      }
    }
    if (!setupRequired) return true
    if (to.path === '/setup') return true
    return { path: '/setup', replace: true }
  }
}
