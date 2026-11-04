// electron/main/character/channelBindings.ts —— 大肥鱼的多渠道聊天绑定（OpenClaw bindings）
//
// 为什么需要它：应用内聊天显式走 `openclaw/feiyu`，但外部渠道（QQ/飞书/企微/微信…）
// 的入站消息归哪个 agent 由 OpenClaw 的 `bindings` 决定。应用此前只写渠道凭据、
// 不写 bindings，所以外部渠道永远到不了大肥鱼。这里用官方 CLI 管理绑定：
//   - 读：`openclaw channels list --json`（已配置渠道）+ `openclaw agents bindings --json`
//   - 写：`openclaw agents bind/unbind --agent feiyu --bind <channel>`（不直接写 openclaw.json）
//
// 边界（第二轮对抗复核后收紧）：
// - 只自动接管「单账号、且未被其它 agent 以默认账号/peer 规则占用」的渠道；
//   多账号、或其它 agent 已有非 wildcard/peer 绑定的渠道不允许在这里抢。
// - 正常保存/停用只增删本功能创建的 **channel 级**（无 accountId）绑定；用户手工配的
//   account/peer 级绑定保留。只有「删除全部」才 `unbind --all`（agent 都要删了）。
// - 保存失败回滚到操作前的 channel 级绑定（逐渠道 unbind/bind），并回读校验；
//   不再用 `unbind --all` 做正常保存，避免一失败就把旧渠道全清掉。

import { CHARACTER_AGENT_ID } from './agentConfig'
import type { CliRunner } from './agentPatchRunner'

export interface ChatChannel {
  /** OpenClaw 渠道 id（如 qqbot/feishu/wecom/openclaw-weixin） */
  id: string
  label: string
  accounts: string[]
  /** feiyu：已绑定大肥鱼；other：已被其它 agent 绑定；null：未绑定 */
  boundTo: 'feiyu' | 'other' | null
  /** 不允许在应用内接管的理由；null 表示可勾选 */
  blockedReason: 'multi-account' | 'other-agent' | null
  blockedBy?: string
}

export interface ChatChannelsSetResult {
  channels: ChatChannel[]
  added: string[]
  removed: string[]
}

interface RawBinding {
  agentId?: string
  match?: {
    channel?: string
    accountId?: string
    peer?: { kind?: string; id?: string }
    guildId?: string
    teamId?: string
  }
}

interface RawChannelEntry {
  label?: string
  accounts?: string[]
  installed?: boolean
  origin?: string
}

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function parseJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new Error(`读取${what}失败（返回非 JSON）`)
  }
}

/** 从 CLI 失败输出里取一条可执行提示；不把 stderr 原样带进 UI/日志 */
function cliFailureMessage(result: { code: number; stdout: string }, action: string): string {
  try {
    const parsed = JSON.parse(result.stdout) as {
      error?: { message?: unknown }
      issues?: Array<{ message?: unknown }>
      conflicts?: unknown[]
      missing?: unknown[]
    }
    const issue = parsed?.issues?.[0]?.message
    const message = parsed?.error?.message ?? issue
    if (Array.isArray(parsed?.conflicts) && parsed.conflicts.length > 0) {
      return '渠道已被其它 agent 占用，请先在 OpenClaw 侧解绑该渠道'
    }
    if (Array.isArray(parsed?.missing) && parsed.missing.length > 0) {
      return `${action}未生效：OpenClaw 没有找到对应绑定，请刷新后重试`
    }
    if (typeof message === 'string' && message.trim()) {
      const text = message.trim()
      if (/config is invalid|invalid config|配置无效/i.test(text)) {
        return 'OpenClaw 配置无效，请先在控制台修复（或运行 openclaw doctor）后重试'
      }
      return `${action}失败：${text.slice(0, 160)}`
    }
  } catch {
    /* 非 JSON 输出：只回退出码 */
  }
  return `${action}失败（exit ${result.code}）`
}

/** 解析 `channels list --json` 的 chat 节点（只保留已配置渠道） */
export function parseChannelList(stdout: string): Array<{ id: string; label: string; accounts: string[] }> {
  const parsed = parseJson<{ chat?: Record<string, RawChannelEntry> }>(stdout, '渠道列表')
  const chat = parsed?.chat ?? {}
  return Object.entries(chat)
    .filter(([, entry]) => entry && entry.installed !== false)
    .map(([id, entry]) => ({
      id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : id,
      accounts: Array.isArray(entry.accounts) ? entry.accounts.map(String) : []
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/** 解析 `agents bindings --json`（数组；兼容单个对象） */
export function parseBindings(stdout: string): RawBinding[] {
  const parsed = parseJson<RawBinding[] | RawBinding>(stdout, '渠道绑定')
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
}

/** 绑定渠道 → 当前绑定的 agent（channel 级；账号级归并到同一渠道） */
export function collectChannelOwners(bindings: RawBinding[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const binding of bindings) {
    const channel = typeof binding.match?.channel === 'string' ? binding.match.channel : ''
    const agentId = typeof binding.agentId === 'string' ? binding.agentId : ''
    if (!channel || !agentId) continue
    const set = owners.get(channel) ?? new Set<string>()
    set.add(agentId)
    owners.set(channel, set)
  }
  return owners
}

/**
 * 其它 agent 是否占着这个渠道、让 feiyu 无法安全接管。
 * - 其它 agent 的默认账号/具体账号绑定会优先，硬抢冲突 → 阻塞；
 * - 带 peer/guild/team 的规则优先级更高，即使 accountId:"*" 也阻塞；
 * - 纯 channel wildcard（accountId:"*"、无 peer 等）才允许 feiyu 的默认账号绑定接管。
 */
function findBlockingOwner(
  bindings: RawBinding[],
  channel: string,
  agentId: string
): { agentId: string } | null {
  for (const binding of bindings) {
    if (binding.match?.channel !== channel) continue
    const owner = typeof binding.agentId === 'string' ? binding.agentId : ''
    if (!owner || owner === agentId) continue
    const match = binding.match ?? {}
    if (match.peer || match.guildId || match.teamId) return { agentId: owner }
    const accountId = typeof match.accountId === 'string' ? match.accountId.trim() : ''
    if (accountId === '*') continue
    return { agentId: owner }
  }
  return null
}

/** 目标渠道与当前已绑定渠道的差集（去重、保序） */
export function planChannelChanges(
  current: readonly string[],
  desired: readonly string[]
): { add: string[]; remove: string[] } {
  const currentSet = new Set(current)
  const desiredSet = new Set(desired)
  return {
    add: [...desiredSet].filter((id) => !currentSet.has(id)),
    remove: [...currentSet].filter((id) => !desiredSet.has(id))
  }
}

/** 校验渲染端传入的渠道列表：去重、限制数量、拒绝非法 id */
export function normalizeDesiredChannels(desired: unknown): string[] {
  if (!Array.isArray(desired)) throw new Error('渠道列表必须是数组')
  const out: string[] = []
  for (const value of desired) {
    if (typeof value !== 'string') throw new Error('渠道 id 必须是字符串')
    const id = value.trim()
    if (!CHANNEL_ID_PATTERN.test(id)) throw new Error(`非法渠道 id：${value}`)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > 12) throw new Error('一次最多配置 12 个聊天渠道')
  return out
}

async function readRawBindings(runner: CliRunner): Promise<RawBinding[]> {
  const result = await runner.run(['agents', 'bindings', '--json'])
  if (result.code !== 0) throw new Error(cliFailureMessage(result, '读取渠道绑定'))
  return parseBindings(result.stdout)
}

/** 本功能创建的 channel 级绑定（无 accountId；不碰用户手工 account/peer 绑定） */
function managedChannels(bindings: RawBinding[], agentId: string): string[] {
  const out: string[] = []
  for (const binding of bindings) {
    if (binding.agentId !== agentId) continue
    const channel = typeof binding.match?.channel === 'string' ? binding.match.channel : ''
    if (!channel) continue
    const accountId = typeof binding.match?.accountId === 'string' ? binding.match.accountId.trim() : ''
    if (accountId) continue
    if (!out.includes(channel)) out.push(channel)
  }
  return out
}

/** 已配置渠道 + 当前绑定归属 + 是否可接管（供角色页「聊天渠道」卡片） */
export async function listChatChannels(
  runner: CliRunner,
  agentId: string = CHARACTER_AGENT_ID
): Promise<ChatChannel[]> {
  const [channelsResult, bindings] = await Promise.all([
    runner.run(['channels', 'list', '--json']),
    readRawBindings(runner)
  ])
  if (channelsResult.code !== 0) {
    throw new Error(cliFailureMessage(channelsResult, '读取渠道列表'))
  }
  const channels = parseChannelList(channelsResult.stdout)
  const owners = collectChannelOwners(bindings)
  return channels.map((channel) => {
    const channelOwners = owners.get(channel.id)
    const boundTo: ChatChannel['boundTo'] =
      channelOwners && channelOwners.has(agentId)
        ? 'feiyu'
        : channelOwners && channelOwners.size > 0
          ? 'other'
          : null
    const multiAccount = channel.accounts.length > 1
    const blocker = multiAccount ? null : findBlockingOwner(bindings, channel.id, agentId)
    const blockedReason: ChatChannel['blockedReason'] = multiAccount
      ? 'multi-account'
      : blocker
        ? 'other-agent'
        : null
    return {
      ...channel,
      boundTo,
      blockedReason,
      ...(blocker ? { blockedBy: blocker.agentId } : {})
    }
  })
}

async function bindOne(runner: CliRunner, agentId: string, channel: string): Promise<void> {
  const result = await runner.run(['agents', 'bind', '--agent', agentId, '--bind', channel, '--json'])
  if (result.code !== 0) throw new Error(cliFailureMessage(result, `绑定「${channel}」`))
}

async function unbindOne(runner: CliRunner, agentId: string, channel: string): Promise<void> {
  const result = await runner.run(['agents', 'unbind', '--agent', agentId, '--bind', channel, '--json'])
  if (result.code !== 0) throw new Error(cliFailureMessage(result, `断开「${channel}」`))
}

/**
 * 设置「大肥鱼可聊天的渠道」：
 * 1) 校验目标渠道都已配置、单账号、未被其它 agent 以默认账号/peer 规则占用；
 * 2) 只对差集操作：移除的 channel 级绑定 unbind，新增的 bind；
 * 3) 失败时回滚本次改动（恢复移除的绑定、撤掉新增的绑定），再抛出可读错误；
 * 4) 回读校验。
 */
export async function setChatChannels(
  runner: CliRunner,
  desired: unknown,
  agentId: string = CHARACTER_AGENT_ID
): Promise<ChatChannelsSetResult> {
  const nextIds = normalizeDesiredChannels(desired)
  const channels = await listChatChannels(runner, agentId)
  for (const id of nextIds) {
    const channel = channels.find((item) => item.id === id)
    if (!channel) throw new Error(`渠道未配置：${id}`)
    if (channel.blockedReason === 'multi-account') {
      throw new Error(`「${channel.label}」是多账号渠道，暂不支持在应用内自动接管；请用 OpenClaw 原生配置逐账号绑定`)
    }
    if (channel.blockedReason === 'other-agent') {
      throw new Error(
        `「${channel.label}」已被 ${channel.blockedBy ?? '其它 agent'} 占用（默认账号/peer 规则），请先在 OpenClaw 侧解绑`
      )
    }
  }

  const bindings = await readRawBindings(runner)
  const current = managedChannels(bindings, agentId)
  const plan = planChannelChanges(current, nextIds)
  if (!plan.add.length && !plan.remove.length) {
    return { channels, added: [], removed: [] }
  }

  const rollback = async (): Promise<string[]> => {
    const problems: string[] = []
    for (const id of plan.add) {
      try {
        await unbindOne(runner, agentId, id)
      } catch (error) {
        problems.push(`撤回 ${id} 失败：${(error as Error)?.message ?? String(error)}`)
      }
    }
    for (const id of plan.remove) {
      try {
        await bindOne(runner, agentId, id)
      } catch (error) {
        problems.push(`恢复 ${id} 失败：${(error as Error)?.message ?? String(error)}`)
      }
    }
    return problems
  }

  try {
    for (const id of plan.remove) await unbindOne(runner, agentId, id)
    for (const id of plan.add) await bindOne(runner, agentId, id)
  } catch (error) {
    const problems = await rollback()
    const suffix = problems.length ? `；回滚未完全成功：${problems.join('；')}` : ''
    throw new Error(`${(error as Error)?.message ?? String(error)}${suffix}`)
  }

  const after = await listChatChannels(runner, agentId)
  const notBound = nextIds.filter((id) => !after.some((c) => c.id === id && c.boundTo === 'feiyu'))
  if (notBound.length) {
    const problems = await rollback()
    const suffix = problems.length ? `；回滚未完全成功：${problems.join('；')}` : ''
    throw new Error(`渠道绑定未生效：${notBound.join(', ')}${suffix}`)
  }
  return { channels: after, added: plan.add, removed: plan.remove }
}

/** 清空本功能创建的 channel 级绑定（停用时用；保留用户手工 account/peer 绑定） */
export async function clearChatChannels(
  runner: CliRunner,
  agentId: string = CHARACTER_AGENT_ID
): Promise<{ removed: string[] }> {
  const bindings = await readRawBindings(runner)
  const current = managedChannels(bindings, agentId)
  if (!current.length) return { removed: [] }
  for (const id of current) await unbindOne(runner, agentId, id)
  const after = await readRawBindings(runner)
  const remaining = managedChannels(after, agentId)
  if (remaining.length) throw new Error(`仍有渠道绑定未清理：${remaining.join(', ')}`)
  return { removed: current }
}

/** 删除全部：清掉 feiyu 的所有 route binding（含手工 account/peer），再删 agent */
export async function clearAllChatChannels(
  runner: CliRunner,
  agentId: string = CHARACTER_AGENT_ID
): Promise<{ removed: string[] }> {
  const bindings = await readRawBindings(runner)
  const removed = [...collectChannelOwners(bindings)]
    .filter(([, owners]) => owners.has(agentId))
    .map(([channel]) => channel)
  if (!removed.length) return { removed: [] }
  const result = await runner.run(['agents', 'unbind', '--agent', agentId, '--all', '--json'])
  if (result.code !== 0) throw new Error(cliFailureMessage(result, '清理全部渠道绑定'))
  const after = await readRawBindings(runner)
  if ([...collectChannelOwners(after)].some(([, owners]) => owners.has(agentId))) {
    throw new Error('仍有 feiyu 渠道绑定未清理')
  }
  return { removed }
}
