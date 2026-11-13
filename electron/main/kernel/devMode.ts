// devMode.ts —— 开发者模式闸门（PLAN-5.0 B5）
//
// 只在非打包版、且显式设置 env 时开启；打包版即使设置 env 也必须拒绝。
// 这是「本地开发便利」，不是第三方安装入口：4.x 仍不提供第三方安装。

export const DEV_PLUGINS_ENV = 'UMI_DEV_PLUGINS'
export const DEV_BUILD_ENV = 'UMI_DEV_BUILD'

export interface DevModeState {
  /** 是否允许开发者插件流程（本批只做闸门与风险提示，不扫描/不加载 dev-plugins） */
  plugins: boolean
  /** 是否允许直接用源码构建 dev 插件（本批只暴露闸门值） */
  build: boolean
  /** 未开启/被拒绝的原因（打包版、缺 env 等） */
  reason: string
  warning: string | null
}

export interface DevModeInput {
  isPackaged: boolean
  env: Record<string, string | undefined>
}

const WARNING = '开发者模式：仅限本地开发，插件代码不受签名校验；不要用于日常使用或分发。'

export function resolveDevMode(input: DevModeInput): DevModeState {
  if (input.isPackaged) {
    return { plugins: false, build: false, reason: 'packaged-build', warning: null }
  }
  const plugins = input.env[DEV_PLUGINS_ENV] === '1'
  const build = plugins && input.env[DEV_BUILD_ENV] === '1'
  if (!plugins) {
    return { plugins: false, build: false, reason: 'env-not-set', warning: null }
  }
  return { plugins: true, build, reason: 'dev-only', warning: WARNING }
}
