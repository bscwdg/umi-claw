// electron/main/services/characterGroupConfig.ts —— 群聊策略 → OpenClaw 配置的唯一编译/落盘点
//
// 为什么需要它：4.4 曾用「独立 feiyu-group agent + peer=group:* 绑定」隔离群聊，
// 结果同一个 qqbot 渠道被两个 agent 抢，渠道页误判「被 feiyu-group 占用」，保存别的
// 渠道还会把 feiyu 的 qqbot 绑定解掉。现在改成单 agent：qqbot 私聊/群聊都路由到 feiyu，
// 群聊行为由本文件编译成两处官方配置：
//   1) channels.qqbot.groups["*"] —— 需要 @、群历史、群提示词（qqbot 插件原生支持）；
//   2) plugins.load.paths + plugins.entries["feiyu-guard"] —— 随包 hook 插件，硬执行
//      亲密词过滤 / 群语音开关与日上限 / 群聊不写记忆（只在群会话生效，私聊放行）。
// 新增群策略字段要同步五处：本文件编译、character/groupPolicy.ts 的模型、types.ts 的
// GROUP_PATCH_KEYS（否则 UI 局部补丁不生效）、src/character/CharacterSettings.vue 的
// draft/保存列表、插件 policy.mjs 的读取/执行。写盘一律走 openClawConfigWriter 的串行队列。

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runSerializedOpenClawConfigWrite } from '../openClawConfigWriter'
import { openClawPaths } from '../openClawPaths'
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
    /** 既有 channels.qqbot.groupPolicy；replyEnabled=true 时若原本是 allowlist 需保留，不能强改成 open */
    groupPolicy?: string
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
          config: buildGuardConfig(input)
        }
      }
    }
  }

  const replacePaths: string[] = ['plugins.load.paths']
  if (qqbotConfigured) {
    // 群聊总开关：关闭后 qqbot 插件直接不响应群消息（硬闸）；开启时群策略交给 groups["*"]。
    // 开启时保留既有 allowlist（否则会静默把所有群放开），只有非白名单才写 open。
    const keepAllowlist = current.groupPolicy === 'allowlist'
    patch.channels = {
      qqbot: {
        groupPolicy: g.replyEnabled ? (keepAllowlist ? 'allowlist' : 'open') : 'disabled',
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
      // 只有拿得到完整 bindings（来自 openclaw.json）并完成迁移后，才删 feiyu-group agent 条目：
      // 否则会留下「绑定仍引用已删除 agent」的非法配置，官方 schema 会拒掉整单 patch。
      patch.agents = { entries: { 'feiyu-group': null } }
      replacePaths.push('bindings')
    }
  }
  return { patch, replacePaths }
}

/** openclaw.json 里的 bindings 是配置真源（含 route/ACP），不要用 CLI 列表重建：
 *  - CLI `agents bindings --json` 只列 route，且会附加展示用 `description`（schema 拒）；
 *  - 直接读文件可完整保留 comment/session/ACP 绑定，也避免一次 15–20s 的 CLI spawn。 */
function readConfigBindings(cfg: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = cfg?.bindings
  // 配置存在但 bindings 键缺失/非数组 = 视为空数组：新装/清空 bindings 的用户也要补 feiyu 的
  // qqbot 绑定；只有整份 openclaw.json 读不出时才跳过（由 applyCharacterGroupPolicy 处理）。
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

/** 收敛成配置文件允许的绑定形状：保留未知字段（comment/session/ACP 等），只删 CLI 展示字段 */
function sanitizeBinding(binding: Record<string, unknown>): Record<string, unknown> | null {
  const agentId = typeof binding.agentId === 'string' ? binding.agentId.trim() : ''
  const match = binding.match
  if (!agentId || !match || typeof match !== 'object') return null
  const copy: Record<string, unknown> = { ...binding }
  delete copy.description
  copy.type = typeof binding.type === 'string' && binding.type.trim() ? binding.type.trim() : 'route'
  copy.agentId = agentId
  return copy
}

/** 迁移：去掉 feiyu-group 的 route，保留用户手工的其它绑定；确保 feiyu 有 qqbot 渠道绑定 */
export function desiredBindings(current: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const kept: Array<Record<string, unknown>> = []
  for (const raw of current) {
    const binding = sanitizeBinding(raw)
    if (!binding) continue
    if (binding.agentId === 'feiyu-group') continue
    kept.push(binding)
  }
  const hasFeiyuQqbot = kept.some((binding) => {
    const match = (binding.match ?? {}) as Record<string, unknown>
    return binding.agentId === 'feiyu' && match.channel === 'qqbot' && !match.peer && !match.accountId
  })
  if (!hasFeiyuQqbot) {
    kept.push({ type: 'route', agentId: 'feiyu', match: { channel: 'qqbot' } })
  }
  return kept
}

/** 读 openclaw.json（只读；用于保留既有 plugins.load.paths 与 bindings） */
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

/**
 * 把群聊策略应用到 openclaw.json（settings 变更 / bootstrap 时调用）。
 *
 * 不用 `openclaw config patch` CLI：网关运行时该命令会等配置锁，实测 >300s 超时（启动早期也可能
 * 与网关启动竞态），导致群策略永远落不到盘。改为在官方串行队列里直接读改写 openclaw.json：
 * - 与 configManager / 官方 patch 共用同一路径队列，不会 lost update；
 * - 写文件后网关重启才生效（RUNBOOK 已写明），不阻塞当前运行；
 * - patch 形状由 accept 里的真实 `config patch --dry-run` 校验兜底。
 */
export async function applyCharacterGroupPolicy(
  input: GroupConfigSyncInput
): Promise<GroupConfigSyncResult> {
  const configPath = openClawPaths.openClawConfig(input.dataDir)
  return runSerializedOpenClawConfigWrite(configPath, () => {
    try {
      const before = readOpenClawConfig(input.dataDir)
      // 配置读不出时不猜：整单跳过（尤其不能在没有 bindings 的情况下删 feiyu-group agent 条目，
      // 否则旧绑定仍引用它 → 官方 schema 拒绝整份 patch，群策略永远不会落盘）。
      if (!before) {
        return { ok: false, error: 'openclaw.json 不存在或无法解析，跳过群聊策略同步' }
      }
      const bindings = readConfigBindings(before)
      const qqbotRaw = before.channels && typeof before.channels === 'object'
        ? (before.channels as Record<string, unknown>).qqbot
        : undefined
      const qqbot = qqbotRaw && typeof qqbotRaw === 'object' ? (qqbotRaw as Record<string, unknown>) : undefined
      const qqbotConfigured = Boolean(qqbot)
      const { patch } = buildGroupOpenClawPatch(
        { ...input, qqbotConfigured },
        {
          loadPaths: loadPathsOf(before),
          bindings,
          groupPolicy: typeof qqbot?.groupPolicy === 'string' ? qqbot.groupPolicy : undefined
        }
      )
      const desired = applyMergePatch(before, patch)
      if (!desired || typeof desired !== 'object') {
        return { ok: false, error: '群聊策略合并结果非法，跳过写盘' }
      }
      writeOpenClawConfigAtomic(configPath, desired as Record<string, unknown>)
      return { ok: true, patch }
    } catch (error) {
      return { ok: false, error: `群聊策略写盘失败: ${(error as Error)?.message ?? String(error)}` }
    }
  })
}

/** 同目录临时文件 + rename，避免半截 JSON 被网关/其它读者看到 */
function writeOpenClawConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  const tmpPath = `${configPath}.group-policy-${process.pid}-${Date.now()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, configPath)
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
