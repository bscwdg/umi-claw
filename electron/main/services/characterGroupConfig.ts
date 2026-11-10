// electron/main/services/characterGroupConfig.ts —— 群聊策略 → OpenClaw 配置的唯一编译/落盘点
//
// 为什么需要它：4.4 曾用「独立 feiyu-group agent + peer=group:* 绑定」隔离群聊，
// 结果同一个 qqbot 渠道被两个 agent 抢，渠道页误判「被 feiyu-group 占用」，保存别的
// 渠道还会把 feiyu 的 qqbot 绑定解掉。现在改成单 agent：qqbot 私聊/群聊都路由到 feiyu，
// 群聊行为由本文件编译成两处官方配置：
//   1) channels.qqbot.groups["*"] —— 需要 @、群历史、群提示词（qqbot 插件原生支持）；
//   2) plugins.load.paths + plugins.entries["feiyu-guard"] —— 随包 hook 插件，硬执行
//      亲密词过滤 / 群语音开关与日上限 / 群聊不写记忆（只在群会话生效，私聊放行）。
// 新增群策略字段时只改这里的编译 + character/groupPolicy.ts 的模型；UI/插件各自读同一份
// 语义，避免三处漂移。写盘一律走 openClawConfigWriter 的官方 config patch 串行队列。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

import { applyOpenClawConfigPatch, collectLossyIdArrayReplacePaths } from '../openClawConfigWriter'
import { openClawPaths } from '../openClawPaths'
import { buildOpenClawEnv } from '../openClawPaths'
import { buildGroupPrompt, type GroupSettings } from '../character/groupPolicy'

export const GUARD_PLUGIN_ID = 'feiyu-guard'

/** 群聊配置编译所需的宿主输入 */
export interface GroupConfigSyncInput {
  dataDir: string
  /** <resources>/openclaw-plugins（开发态 appPath/resources，打包态 resourcesPath/resources） */
  pluginsRoot: string
  group: GroupSettings
  timezone?: string
  now?: () => number
  /** qqbot 渠道是否已配置；未配置时只装 guard 插件、不写 channels/bindings（避免造出半截渠道配置） */
  qqbotConfigured?: boolean
}

export interface GroupConfigSyncResult {
  ok: boolean
  error?: string
  /** 实际写入的 merge patch（测试用） */
  patch?: Record<string, unknown>
}

export function guardPluginDir(pluginsRoot: string): string {
  return join(pluginsRoot, GUARD_PLUGIN_ID)
}

/** guard 插件配置（与插件 policy.mjs 的 parseGuardConfig 一一对应） */
export function buildGuardConfig(input: GroupConfigSyncInput): Record<string, unknown> {
  const g = input.group
  return {
    version: 1,
    statePath: join(input.dataDir, 'character', 'group-guard-state.json'),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    policy: {
      replyEnabled: g.replyEnabled,
      requireMention: g.requireMention,
      voice: { enabled: g.voiceEnabled, dailyCap: g.dailyVoiceCap },
      words: {
        enabled: g.words.enabled,
        action: g.words.action,
        replaceWith: g.words.replaceWith,
        list: [...g.words.list]
      },
      memoryIsolated: g.memoryIsolated,
      historyLimit: g.historyLimit
    }
  }
}

/**
 * 编译群聊策略对应的 openclaw.json merge patch。
 * 纯函数（不读盘），方便 accept 直接断言形状；现有 plugins.load.paths / bindings 由调用方
 * 通过 current 传入（避免这里再做一次磁盘/CLI 读取）。
 */
export function buildGroupOpenClawPatch(
  input: GroupConfigSyncInput,
  current: {
    loadPaths?: string[]
    bindings?: Array<Record<string, unknown>>
  } = {}
): { patch: Record<string, unknown>; replacePaths: string[] } {
  const g = input.group
  const pluginDir = guardPluginDir(input.pluginsRoot)
  const loadPaths = [...new Set([...(current.loadPaths ?? []), pluginDir])]
  const qqbotConfigured = input.qqbotConfigured !== false

  const patch: Record<string, unknown> = {
    plugins: {
      load: { paths: loadPaths },
      entries: {
        [GUARD_PLUGIN_ID]: {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: buildGuardConfig(input)
        }
      }
    },
    // 4.4 的双 agent 迁移：删掉 feiyu-group 条目与其 peer 绑定，只保留 feiyu 的渠道绑定
    agents: { entries: { 'feiyu-group': null } }
  }

  const replacePaths: string[] = ['plugins.load.paths']
  if (qqbotConfigured) {
    // 群聊总开关：关闭后 qqbot 插件直接不响应群消息（硬闸）；开启时群策略交给 groups["*"]
    patch.channels = {
      qqbot: {
        groupPolicy: g.replyEnabled ? 'open' : 'disabled',
        groups: {
          '*': {
            requireMention: g.requireMention,
            toolPolicy: 'restricted',
            prompt: buildGroupPrompt(g),
            historyLimit: g.historyLimit
          }
        }
      }
    }
    if (current.bindings) {
      patch.bindings = desiredBindings(current.bindings)
      replacePaths.push('bindings')
    }
  }
  return { patch, replacePaths }
}

/** 迁移：去掉 feiyu-group 的 route，保留用户手工的其它绑定；确保 feiyu 有 qqbot 渠道绑定 */
export function desiredBindings(current: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const kept = current.filter((binding) => {
    const agentId = typeof binding.agentId === 'string' ? binding.agentId : ''
    if (agentId === 'feiyu-group') return false
    const match = (binding.match ?? {}) as Record<string, unknown>
    // 4.4 的群聊 peer 规则只属于 feiyu-group；其它 agent 的 peer 规则保留
    if (agentId === 'feiyu-group' && match.peer) return false
    return true
  })
  const hasFeiyuQqbot = kept.some((binding) => {
    const match = (binding.match ?? {}) as Record<string, unknown>
    return binding.agentId === 'feiyu' && match.channel === 'qqbot' && !match.peer && !match.accountId
  })
  if (!hasFeiyuQqbot) {
    kept.push({ type: 'route', agentId: 'feiyu', match: { channel: 'qqbot' } })
  }
  return kept
}

/** 读 openclaw.json（只读；用于保留既有 plugins.load.paths） */
function readOpenClawConfig(dataDir: string): Record<string, unknown> | null {
  const path = openClawPaths.openClawConfig(dataDir)
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function loadPathsOf(cfg: Record<string, unknown> | null): string[] {
  const plugins = cfg?.plugins as Record<string, unknown> | undefined
  const load = plugins?.load as Record<string, unknown> | undefined
  const paths = load?.paths
  return Array.isArray(paths) ? paths.map((p) => String(p)).filter(Boolean) : []
}

/** 用官方 CLI 读当前 agent bindings（读失败返回 null，调用方跳过 bindings 迁移） */
function readBindings(dataDir: string): Promise<Array<Record<string, unknown>> | null> {
  const nodePath = openClawPaths.nodeBinary(dataDir)
  const clawJs = openClawPaths.clawJs(dataDir)
  return new Promise((resolve) => {
    const child = spawn(nodePath, [clawJs, 'agents', 'bindings', '--json'], {
      cwd: openClawPaths.installDir(dataDir),
      env: buildOpenClawEnv(dataDir, nodePath),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })
    let out = ''
    let settled = false
    const done = (value: Array<Record<string, unknown>> | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      done(null)
    }, 15_000)
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(out.replace(/^\uFEFF/, ''))
        const list = Array.isArray(parsed) ? parsed : parsed?.bindings
        done(Array.isArray(list) ? (list as Array<Record<string, unknown>>) : null)
      } catch {
        done(null)
      }
    })
  })
}

/**
 * 把群聊策略应用到 openclaw.json（settings 变更 / bootstrap 时调用）。
 * 幂等：内容没变时 config patch 不产生实质变更；失败只返回错误，由调用方记日志，不阻塞启动。
 */
export async function applyCharacterGroupPolicy(
  input: GroupConfigSyncInput
): Promise<GroupConfigSyncResult> {
  const before = readOpenClawConfig(input.dataDir)
  const bindings = await readBindings(input.dataDir)
  const qqbotConfigured = Boolean(
    before && typeof before.channels === 'object' && before.channels !== null && (before.channels as Record<string, unknown>).qqbot
  )
  const { patch, replacePaths } = buildGroupOpenClawPatch(
    { ...input, qqbotConfigured },
    {
      loadPaths: loadPathsOf(before),
      bindings: bindings ?? undefined
    }
  )

  // 官方 CLI 对「按 id 的数组会移除既有条目」要求显式 replace-path；用原配置+局部合并
  // 算出真正会损失的路径，避免给老版本传未知参数。
  const desired = applyMergePatch(before ?? {}, patch) as Record<string, unknown>
  const extraReplace = collectLossyIdArrayReplacePaths(before ?? {}, desired)
  const allReplace = [...new Set([...replacePaths, ...extraReplace])]

  const result = await applyOpenClawConfigPatch(input.dataDir, patch, {
    replacePaths: allReplace
  })
  return {
    ok: result.ok,
    error: result.ok ? undefined : result.error || 'openclaw config patch 失败',
    patch
  }
}

/** JSON merge patch 的本地实现（只为算 replacePaths，不用于写盘） */
function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null) return null
  if (Array.isArray(patch)) return patch.map((item) => (item && typeof item === 'object' ? applyMergePatch(undefined, item) : item))
  if (typeof patch !== 'object') return patch
  const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {}
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete base[key]
      continue
    }
    base[key] = applyMergePatch(base[key], value)
  }
  return base
}

/** 供其它调用方复用的路径 helper（测试用；避免重复拼 dirname） */
export function pluginEntryPackageDir(pluginsRoot: string): string {
  return dirname(guardPluginDir(pluginsRoot))
}
