// pluginIsolation.ts —— 第三方插件进程隔离开关（PLAN-5.0 Phase 1 B1）
//
// 默认 off：4.3 行为完全不变；只有显式 `UMI_PLUGIN_ISOLATION=1` 才启用隔离路径。
// 用独立模块而不是到处读 process.env，便于测试与后续「打包版强制拒绝 dev 开关」复用。

export const PLUGIN_ISOLATION_ENV = 'UMI_PLUGIN_ISOLATION'

export function isPluginIsolationEnabled(env: NodeJS.ProcessEnv = process.env, hostVersion?: string): boolean {
  const flag = env[PLUGIN_ISOLATION_ENV]
  if (flag === '1') return true
  if (flag === '0') return false
  // 5.0 起隔离默认开启；4.x 分支仍默认关闭（本文件只在 5.0 分支生效）
  return Boolean(hostVersion && /^5\./.test(hostVersion))
}
