// electron/main/ipc/host/claw.ts —— OpenClaw 进程管理 IPC（4.1 WP5-a 第四批：从 index.ts 拆出）
//
// 三条安全约束必须原样保留：
//   1) 未同意用户协议不得启动（claw:start/restart 的硬性闸门）；
//   2) 环境更新进行中（envUpdateInFlight）拒绝启动/重启，避免与 doctor 迁移抢状态库；
//   3) get-token 只读标准配置路径，绝不把 token 打进日志。
// 依赖全部注入（含 assertConsent / env 更新状态 getter），宿主晚初始化语义不变。

import { join } from 'node:path'

export interface ClawIpcDeps {
  isEnvUpdateInFlight: () => boolean
  envUpdateInProgressError: string
  assertConsent: () => Promise<void>
  start: () => Promise<unknown>
  stop: () => Promise<unknown>
  getStatus: () => unknown
  waitReady: (timeoutMs?: number) => Promise<unknown>
  getPort: () => number
  openExternal: (url: string) => Promise<unknown> | unknown
  /** 配置根目录（openClawPaths.configDir(dataDir) 的结果） */
  configDir: (dataDir: string) => string
  getDataDir: () => string
  getHomeDir: () => string
  fileExists: (path: string) => boolean
  readFile: (path: string) => string
  log: (line: string) => void
}

export function registerClawIpc(
  ipc: {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  },
  deps: ClawIpcDeps
): void {
  // 硬性闸门（北 2026-09-24）：启动前必须已同意用户协议，否则拒绝并让前端弹回协议弹窗。
  const ensureConsentGate = async (): Promise<{ ok: true } | { ok: false; result: unknown }> => {
    try {
      await deps.assertConsent()
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        result: {
          success: false,
          reason: 'consent-required',
          error: (e as Error)?.message ?? '请先同意用户协议'
        }
      }
    }
  }

  ipc.handle('claw:start', async () => {
    if (deps.isEnvUpdateInFlight()) {
      return { success: false, error: deps.envUpdateInProgressError }
    }
    // 硬性闸门（3.0 安全改动，必须保留）：未同意用户协议不得启动
    const gate = await ensureConsentGate()
    if (!gate.ok) return gate.result
    return deps.start()
  })
  ipc.handle('claw:stop', async () => deps.stop())
  ipc.handle('claw:restart', async () => {
    if (deps.isEnvUpdateInFlight()) {
      return { success: false, error: deps.envUpdateInProgressError }
    }
    // 硬性闸门（3.0 安全改动，必须保留）：未同意用户协议不得启动
    const gate = await ensureConsentGate()
    if (!gate.ok) return gate.result
    await deps.stop()
    return deps.start()
  })
  ipc.handle('claw:status', () => deps.getStatus())
  // 等待网关真正就绪（/health 200）：UI 的「启动中/已就绪」与「打开网页」门禁都靠它。
  // 只读探测，不启动、不做协议闸门（启动动作仍走 claw:start/restart 的闸门）。
  ipc.handle('claw:waitReady', async (_e, timeoutMs?: number) =>
    deps.waitReady(
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : undefined
    )
  )
  ipc.handle('claw:openWeb', () => {
    const port = deps.getPort()
    return deps.openExternal(`http://localhost:${port}`)
  })

  // 一键获取 token：只扫标准配置路径（环境变量目录 → 用户家目录 → dataDir 变体）
  ipc.handle('claw:get-token', async () => {
    const userHome = deps.getHomeDir()
    const dataDir = deps.getDataDir()
    // 移除硬编码的 C:\tmp 和当前盘符根目录的随意扫描，聚焦于标准配置路径
    const envConfigDir = deps.configDir(dataDir)
    const possiblePaths = [
      // 1. 环境变量指定的核心目录 (最高优先级)
      join(envConfigDir, 'openclaw.json'),
      // 2. 用户家目录 (常见默认位置)
      join(userHome, '.openclaw', 'openclaw.json'),
      // 3. AppData 隔离数据目录的其他变体
      join(dataDir, 'openclaw', 'openclaw.json')
    ]

    deps.log('--- 🛡️ 开始扫描 OpenClaw 配置文件 ---')

    let finalPath = ''
    for (const p of possiblePaths) {
      if (deps.fileExists(p)) {
        finalPath = p
        deps.log(`✅ 命中配置文件: ${p}`)
        break
      }
    }

    try {
      if (!finalPath) {
        throw new Error(
          `未找到 OpenClaw 配置文件。已检查以下路径：\n` +
            possiblePaths.map((p) => `- ${p}`).join('\n')
        )
      }
      const configJson = JSON.parse(deps.readFile(finalPath))
      // ⚠️ 安全警告：不要在生产环境日志中打印包含 Token 的完整 JSON
      const token = configJson?.gateway?.token || configJson?.gateway?.auth?.token
      if (!token) {
        throw new Error(`配置文件存在 (${finalPath})，但缺少 gateway.token 字段`)
      }
      return { success: true, token }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      deps.log(`获取 Token 失败: ${message}`)
      return { success: false, error: message }
    }
  })
}
