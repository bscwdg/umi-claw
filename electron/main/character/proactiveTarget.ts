// electron/main/character/proactiveTarget.ts —— 主动消息发到哪个渠道 / 谁（纯逻辑）
//
// 4.4 拍板：主动消息不再固定发 QQ，而是发到「聊天渠道」里已绑定给大肥鱼的渠道，
// 并优先选她最近跟用户聊过的那个。规则：
//   1) 只认 boundChannels（用户没绑的渠道不能发，否则等于绕过设置）；
//   2) 渠道之间按「该渠道最近一条会话时间」排序，最近说话的先发；
//   3) 同一渠道内私聊优先——群聊/公开频道里可能有别人，主动消息不该打扰旁观者；
//   4) 没有任何可用会话返回 null，调用方降级应用内气泡（不要猜一个目标硬发）。
//
// 注意 OpenClaw 的 kind 实际有三种（DB CHECK: direct / group / channel）：Slack 这类
// 公开频道是 channel，比群聊更公开，排序放在最后；不能把它当 direct，否则会抢走私聊位置。
//
// 纯函数：不读库、不跑 CLI，方便验收直接断言（test/character.core.accept.mjs）。

export type ProactiveConversationKind = 'direct' | 'group' | 'channel'

export interface ProactiveConversation {
  /** OpenClaw 渠道 id（qqbot/feishu/wecom/…） */
  channel: string
  /** OpenClaw delivery target（如 qqbot:c2c:OPENID） */
  target: string
  kind: ProactiveConversationKind
  /** 该会话最后活跃时间（毫秒） */
  updatedAt: number
  /** 多账号渠道的账号 id（发送时传 --account） */
  accountId?: string
  /** 线程会话 id（发送时传 --thread-id） */
  threadId?: string
}

export interface ProactiveTarget {
  channel: string
  target: string
  kind: ProactiveConversationKind
  updatedAt: number
  accountId?: string
  threadId?: string
}

/** 私聊 > 群聊 > 公开频道：数值越小越优先 */
const KIND_RANK: Record<ProactiveConversationKind, number> = {
  direct: 0,
  group: 1,
  channel: 2
}

/**
 * 从「agent 记得的会话」里挑一个外发目标。
 * 输入不保证有序（取自 SQLite 时已按最近排序，但不要依赖它）。
 */
export function pickProactiveTarget(
  conversations: readonly ProactiveConversation[],
  boundChannels: readonly string[]
): ProactiveTarget | null {
  const bound = new Set(boundChannels.map((channel) => channel.trim()).filter(Boolean))
  if (!bound.size) return null

  const byChannel = new Map<string, ProactiveTarget[]>()
  for (const conversation of conversations) {
    if (!conversation) continue
    const channel = typeof conversation.channel === 'string' ? conversation.channel.trim() : ''
    if (!channel || !bound.has(channel)) continue
    const target = typeof conversation.target === 'string' ? conversation.target.trim() : ''
    if (!target) continue
    const kind: ProactiveTarget['kind'] =
      conversation.kind === 'group' ? 'group' : conversation.kind === 'channel' ? 'channel' : 'direct'
    const updatedAt = Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : 0
    const accountId =
      typeof conversation.accountId === 'string' && conversation.accountId.trim()
        ? conversation.accountId.trim()
        : undefined
    const threadId =
      typeof conversation.threadId === 'string' && conversation.threadId.trim()
        ? conversation.threadId.trim()
        : undefined
    const list = byChannel.get(channel) ?? []
    list.push({ channel, target, kind, updatedAt, accountId, threadId })
    byChannel.set(channel, list)
  }

  // 先选「最近聊过」的渠道；时间相同按 id 排序，保证结果与输入顺序无关
  let bestChannel = ''
  let bestAt = Number.NEGATIVE_INFINITY
  for (const [channel, list] of byChannel) {
    let newest = Number.NEGATIVE_INFINITY
    for (const item of list) newest = Math.max(newest, item.updatedAt)
    if (newest > bestAt || (newest === bestAt && channel < bestChannel)) {
      bestChannel = channel
      bestAt = newest
    }
  }
  if (!bestChannel) return null

  // 同一渠道：私聊 > 群聊 > 公开频道，同档再按最近活跃
  const list = byChannel.get(bestChannel) ?? []
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    if (a.target === b.target) return 0
    return a.target < b.target ? -1 : 1
  })[0]
}
