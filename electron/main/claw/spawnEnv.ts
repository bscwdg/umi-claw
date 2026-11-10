// electron/main/claw/spawnEnv.ts —— 拉起网关前的环境/日志准备（副作用集中在这里）
//
// 为什么单独拆出来：_spawnGateway 里的 env 拼装、webhook 标记兜底、语音 TTS 注入、
// V8 编译缓存目录、detached 日志 fd 都是自包含的「准备动作」，不需要碰 ClawManager
// 的状态机；抽成显式入参/出参后，spawn 主体只剩顺序与错误分支，读起来才看得清
// 「哪些失败阻断启动、哪些只是 warning」。
//
// 注意：`commonEnv` 的 construction（buildOpenClawEnv 结果上叠加 PORT 等）刻意留在
// clawManager.ts —— 那里的注释说明「不得在 commonEnv 之后重新 spread process.env」，
// 这段顺序必须有断言守着。

import { mkdirSync, openSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { toOpenClawProviderKey } from '../modelConfig'
import type { EnsureWebhookMarkerResult } from '../openclawWebhookMarker'
import type { ClawLogger } from './deps'

/**
 * legacy webhook 迁移标记的补齐结果落日志。
 *
 * OpenClaw 只在迁移「无 warning」时才写入 meta.migrations.webhookListeners；
 * 插件 doctor 契约在 Windows 上加载失败（符号链接权限/文件占用）会让它每次启动重跑
 * 该迁移（实测 185s）。官方对「外部管理的配置」明确要求由外部程序写入标记。
 * 实现细节见 openclawWebhookMarker.ts 顶部说明。
 */
export async function logWebhookMarkerResult(
  log: ClawLogger,
  ensure: () => Promise<EnsureWebhookMarkerResult>
): Promise<void> {
  try {
    const marker = await ensure()
    const legacy = marker.skippedLegacyChannels ?? []
    if (marker.changed) {
      log(
        '[gateway] 已补齐 legacy webhook 迁移完成标记（避免每次启动重复迁移，实测约 3 分钟）' +
          (marker.backupPath ? `；原文件备份：${marker.backupPath}` : ''),
        'system'
      )
    } else if (legacy.length > 0) {
      // 有 legacyWebhook 端点：官方要求「补端点 + 补标记」双管齐下，我们只负责标记这一半，
      // 所以这里交回 OpenClaw 官方迁移，不强行标记完成。
      log(
        `[gateway] 检测到 legacyWebhook 配置（${legacy.join(' / ')}），保留 OpenClaw 官方迁移、不补完成标记`,
        'stderr'
      )
    } else if (marker.error) {
      log(`[gateway] webhook 迁移标记补齐跳过：${marker.error}`, 'stderr')
    }
  } catch (e: any) {
    log(`[gateway] webhook 迁移标记补齐异常：${e?.message || e}`, 'stderr')
  }
}

/**
 * 对话内语音：密钥只以环境变量注入，绝不写进 openclaw.json。
 * 注入失败不影响网关启动，只落一行 stderr 日志。
 */
export async function collectVoiceTtsEnv(
  log: ClawLogger,
  provider: (() => Promise<Record<string, string>>) | null
): Promise<Record<string, string>> {
  if (!provider) return {}
  try {
    return await provider()
  } catch (e) {
    log(`语音 TTS 环境变量注入失败（不影响网关启动）: ${(e as Error)?.message}`, 'stderr')
    return {}
  }
}

/**
 * V8 编译缓存目录：渠道插件包很大（feishu 73MB），每次冷启动都要重新编译 JS。
 * NODE_COMPILE_CACHE 让 Node 把编译产物缓存到磁盘，后续启动复用（Node 22+ 支持）。
 * 缓存放 data 目录内，不把任何数据迁出用户既有的数据盘；建目录失败返回空串。
 */
export function ensureNodeCompileCacheDir(dataDir: string): string {
  try {
    const dir = join(dataDir, 'cache', 'node-compile')
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return ''
  }
}

/** 注入网关进程的模型服务商环境变量（只取激活 provider；custom 允许空 key） */
export interface GatewayProviderInput {
  id: string
  name: string
  apiKey: string
  baseUrl: string
}

/**
 * 由激活 provider 生成环境变量。
 * 返回 error 表示「缺 API Key」这类必须阻断启动的配置问题（调用方直接返回失败）。
 */
export function buildProviderEnv(activeProvider: GatewayProviderInput | undefined): {
  env: Record<string, string>
  error?: string
} {
  const env: Record<string, string> = {}
  if (!activeProvider) return { env }
  if (!activeProvider.apiKey && activeProvider.id !== 'custom') {
    return { env, error: `${activeProvider.name} API Key 未配置` }
  }
  env.OPENAI_API_KEY = activeProvider.apiKey || ''
  env.OPENAI_BASE_URL = activeProvider.baseUrl ?? ''

  // 同时写一份以服务商安全 key 命名的环境变量，便于 OpenClaw 内联 provider 识别。
  const envKeyBase = toOpenClawProviderKey(activeProvider.id)
  const upperCleanKey = envKeyBase.replace(/-/g, '_').toUpperCase()

  env[`${upperCleanKey}_API_KEY`] = activeProvider.apiKey || ''
  env[`${upperCleanKey}_BASE_URL`] = activeProvider.baseUrl ?? ''
  return { env }
}

/** detached 日志文件与 fd（「退出应用保留网关」模式） */
export interface DetachedGatewayLogs {
  logFile: string
  errFile: string
  logFd: number | undefined
  errFd: number | undefined
  detached: boolean
}

/**
 * 「退出应用保留网关」需要子进程脱离本实例：detached + 把 stdout/stderr 写文件，
 * 否则 App 退出后管道关闭，网关写日志会中断/崩溃。默认关闭，行为与原来完全一致。
 * 打开失败时返回 detached=false（退回管道模式）。
 */
export function openDetachedGatewayLogs(
  keepOnQuit: boolean,
  dataDir: string
): DetachedGatewayLogs {
  const logFile = join(dataDir, 'logs', 'openclaw-gateway.log')
  const errFile = join(dataDir, 'logs', 'openclaw-gateway.err.log')
  if (!keepOnQuit) {
    return { logFile, errFile, logFd: undefined, errFd: undefined, detached: false }
  }
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    writeFileSync(logFile, '')
    writeFileSync(errFile, '')
    const logFd = openSync(logFile, 'a')
    const errFd = openSync(errFile, 'a')
    return { logFile, errFile, logFd, errFd, detached: true }
  } catch {
    return { logFile, errFile, logFd: undefined, errFd: undefined, detached: false }
  }
}
