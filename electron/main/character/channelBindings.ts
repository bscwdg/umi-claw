// electron/main/character/channelBindings.ts —— 大肥鱼的多渠道聊天绑定（OpenClaw bindings）
//
// 为什么需要它：应用内聊天显式走 `openclaw/feiyu`，但外部渠道（QQ/飞书/企微/微信…）
// 的入站消息归哪个 agent 由 OpenClaw 的 `bindings` 决定。应用此前只写渠道凭据、
// 不写 bindings，所以外部渠道永远到不了大肥鱼。这里用官方 CLI 管理绑定：
//   - 读：`openclaw channels list --json`（已配置渠道）+ `openclaw agents bindings --json`
//   - 写：`openclaw agents bind/unbind --agent feiyu --bind <channel>`（不直接写 openclaw.json）
//
// 边界（对抗复核后收紧）：
// - 只自动接管「单账号、且未被其它 agent 以默认账号/peer 规则占用」的渠道；
//   多账号、或其它 agent 已有非 wildcard 绑定的渠道不允许在这里抢，避免 CLI conflict
//   或「显示成功但默认账号仍归别人」。
// - 写操作先 `unbind --all` 清掉 feiyu 自己的旧绑定，再逐个 bind；任一失败回滚并报错，
//   避免半成功。`--all` 只影响 feiyu，不会碰其它 agent 的绑定。
// - 渠道级绑定无法只接管私聊：该渠道内被渠道策略放行的会话（含群聊）都会路由给 feiyu。

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
  match?: { channel?: string; accountId?: string }
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
    }
    const issue = parsed?.issues?.[0]?.message
    const message = parsed?.error?.message ?? issue
    if (Array.isArray(parsed?.conflicts) && parsed.conflicts.length > 0) {
      return '渠道已被其它 agent 占用，请先在 OpenClaw 侧解绑该渠道'
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
 * wildcard（accountId:"*"）是 channel 级兜底，feiyu 的 account 级绑定能盖过它；
 * 默认账号/具体账号/peer 规则都会优先，硬抢会 conflict 或静默不生效，直接标记不可选。
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
    const accountId = typeof binding.match?.accountId === 'string' ? binding.match.accountId.trim() : ''
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

function ownedChannels(bindings: RawBinding[], agentId: string): string[] {
  return [...collectChannelOwners(bindings)]
    .filter(([, owners]) => owners.has(agentId))
    .map(([channel]) => channel)
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
  return channels.map((channel) => {
    const owners = collectChannelOwners(bindings).get(channel.id)
    const boundTo: ChatChannel['boundTo'] =
      owners && owners.has(agentId) ? 'feiyu' : owners && owners.size > 0 ? 'other' : null
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

async function unbindAll(runner: CliRunner, agentId: string): Promise<void> {
  const result = await runner.run(['agents', 'unbind', '--agent', agentId, '--all', '--json'])
  if (result.code !== 0) {
    throw new Error(cliFailureMessage(result, '断开聊天渠道'))
  }
}

async function bindOne(runner: CliRunner, agentId: string, channel: string): Promise<void> {
  const result = await runner.run(['agents', 'bind', '--agent', agentId, '--bind', channel, '--json'])
  if (result.code !== 0) {
    throw new Error(cliFailureMessage(result, `绑定「${channel}」`))
  }
}

/**
 * 设置「大肥鱼可聊天的渠道」：
 * 1) 先校验目标渠道都已配置、单账号、未被其它 agent 以默认账号/peer 规则占用；
 * 2) 用 `unbind --agent feiyu --all` 清掉 feiyu 旧绑定（只动 feiyu）；
 * 3) 逐个 bind；任一失败回滚 feiyu 全部绑定并报错，避免半成功；
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
  const removed = ownedChannels(bindings, agentId)
  if (removed.length) await unbindAll(runner, agentId)
  try {
    for (const id of nextIds) await bindOne(runner, agentId, id)
  } catch (error) {
    // 回滚本次写入（只影响 feiyu），避免「一半渠道绑上了」的假成功
    await unbindAll(runner, agentId).catch(() => undefined)
    throw error
  }

  const after = await listChatChannels(runner, agentId)
  const notBound = nextIds.filter((id) => !after.some((c) => c.id === id && c.boundTo === 'feiyu'))
  if (notBound.length) {
    await unbindAll(runner, agentId).catch(() => undefined)
    throw new Error(`渠道绑定未生效：${notBound.join(', ')}`)
  }
  return { channels: after, added: nextIds, removed }
}

/** 清空 feiyu 的全部渠道绑定（停用/删除全部时调用；失败由调用方决定是否阻断） */
export async function clearChatChannels(
  runner: CliRunner,
  agentId: string = CHARACTER_AGENT_ID
): Promise<{ removed: string[] }> {
  const bindings = await readRawBindings(runner)
  const removed = ownedChannels(bindings, agentId)
  if (!removed.length) return { removed: [] }
  await unbindAll(runner, agentId)
  const after = await readRawBindings(runner)
  const remaining = ownedChannels(after, agentId)
  if (remaining.length) throw new Error(`仍有渠道绑定未清理：${remaining.join(', ')}`)
  return { removed }
}
