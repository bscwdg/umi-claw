// electron/main/character/proactiveSender.ts —— 主动消息的外发落地（宿主侧 I/O）
//
// 为什么需要它：4.3 的主动性只 emit 了应用内 bubble，而桌宠窗口（M1）下线，
// 用户什么都看不到，却照样消耗当日额度。4.4 起把消息真正送到用户配置过的渠道：
//   1) 读 feiyu 的 agent 库 conversations（谁最近跟大肥鱼说过话）；
//   2) 用「聊天渠道」列表过滤：只发 boundTo === feiyu 且未被标记 blockedReason 的渠道
//      （与角色页「已选渠道」同口径，用户看到不可选的渠道不会被偷偷发到）；
//   3) 选最近聊天的渠道（规则见 proactiveTarget.ts）；
//   4) 走官方 CLI `message send`（按会话记录带上 --account / --thread-id），
//      不直接调渠道 API、不写 openclaw.json。
//
// 失败一律返回 false（manager 会降级成应用内气泡并照常记账）；不重试、不换渠道，
// 避免一次主动消息在多个会话里刷屏。日志只写退出码，不带 CLI stderr（可能含路径/凭据）。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CliRunner } from './agentPatchRunner'
import { CHARACTER_AGENT_ID } from './agentConfig'
import { listChatChannels } from './channelBindings'
import { pickProactiveTarget, type ProactiveConversation, type ProactiveTarget } from './proactiveTarget'

export interface ProactiveSenderOptions {
  dataDir: string
  /** 便携 Node（读 agent 的 SQLite 用；Electron 内置 Node 未必启用 node:sqlite） */
  nodePath: string
  /** 已装配好的官方 CLI runner（与渠道绑定共用同一套环境） */
  runner: CliRunner
  agentId?: string
  logger?: (message: string) => void
  /** 测试注入：默认读 feiyu 的 agent 库（channels = 已绑定渠道，只查这些） */
  readConversations?: (
    agentId: string,
    channels: readonly string[]
  ) => Promise<ProactiveConversation[]>
  /** 测试注入：默认 listChatChannels */
  readBoundChannels?: (agentId: string) => Promise<string[]>
  /** QQ 直发：CLI 不支持 qqbot，生产由 wiring 注入；其它渠道仍走 CLI */
  sendDirect?: (target: ProactiveTarget, text: string) => Promise<boolean>
}

export interface ProactiveSender {
  /** 发送一条主动消息；false = 没发出去（调用方降级气泡） */
  send(text: string, conversationId?: string): Promise<boolean>
}

/** 每个渠道取最近多少条：按渠道分别查，避免「全局 LIMIT」把绑定渠道的会话挤掉 */
const CONVERSATION_LIMIT = 20

/** SQLite 只读读取：只取渠道/目标/类型/时间/账号/线程，不取消息正文 */
function readConversationsFromDb(
  nodePath: string,
  dbPath: string,
  channels: readonly string[],
  logger: (message: string) => void
): Promise<ProactiveConversation[]> {
  return new Promise((resolve) => {
    if (!channels.length) {
      resolve([])
      return
    }
    if (!existsSync(nodePath)) {
      logger('[character] 主动消息读会话失败：便携 Node 不存在')
      resolve([])
      return
    }
    if (!existsSync(dbPath)) {
      logger('[character] 主动消息读会话失败：agent 会话库不存在（她还没在外部渠道说过话）')
      resolve([])
      return
    }
    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
      'const channels = JSON.parse(process.env.UCLawBoundChannels || "[]");',
      'const out = [];',
      'const stmt = db.prepare("SELECT conversation_id, channel, delivery_target, kind, updated_at, account_id, thread_id FROM conversations WHERE channel = ? ORDER BY updated_at DESC LIMIT ' +
        CONVERSATION_LIMIT +
        '");',
      'for (const channel of channels) {',
      '  for (const row of stmt.all(channel)) out.push(row);',
      '}',
      'db.close();',
      'process.stdout.write(JSON.stringify(out));'
    ].join('\n')
    execFile(
      nodePath,
      ['-e', script, dbPath],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, UCLawBoundChannels: JSON.stringify(channels) }
      },
      (error, stdout) => {
        if (error) {
          logger('[character] 主动消息读会话失败：会话库无法只读打开（可能被占用或表结构不符）')
          resolve([])
          return
        }
        try {
          const raw = JSON.parse(String(stdout || '[]')) as Array<Record<string, unknown>>
          const out: ProactiveConversation[] = []
          for (const row of raw) {
            const channel = String(row?.channel ?? '').trim()
            const target = String(row?.delivery_target ?? '').trim()
            if (!channel || !target) continue
            const accountId = String(row?.account_id ?? '').trim()
            const threadId = String(row?.thread_id ?? '').trim()
            const conversationId = String(row?.conversation_id ?? '').trim()
            out.push({
              ...(conversationId ? { conversationId } : {}),
              channel,
              target,
              kind: row?.kind === 'group' ? 'group' : row?.kind === 'channel' ? 'channel' : 'direct',
              updatedAt: Number(row?.updated_at ?? 0),
              ...(accountId ? { accountId } : {}),
              ...(threadId ? { threadId } : {})
            })
          }
          resolve(out)
        } catch {
          logger('[character] 主动消息读会话失败：会话库返回内容无法解析')
          resolve([])
        }
      }
    )
  })
}

export function createProactiveSender(options: ProactiveSenderOptions): ProactiveSender {
  const agentId = options.agentId ?? CHARACTER_AGENT_ID
  const logger = options.logger ?? (() => undefined)
  const dbPath = join(
    options.dataDir,
    'config',
    '.openclaw',
    'agents',
    agentId,
    'agent',
    'openclaw-agent.sqlite'
  )

  const readBoundChannels =
    options.readBoundChannels ??
    (async (id: string): Promise<string[]> => {
      const channels = await listChatChannels(options.runner, id)
      // 与角色页「已选渠道」同口径：blockedReason 非空 = 用户看到不可选（多账号/被其它 agent 占用）
      return channels
        .filter((channel) => channel.boundTo === 'feiyu' && !channel.blockedReason)
        .map((channel) => channel.id)
    })

  // 每次都现读绑定：主动消息最多每小时一条，性能不是问题；缓存会让刚取消的渠道仍被发到
  async function boundChannels(): Promise<string[]> {
    try {
      return await readBoundChannels(agentId)
    } catch (error) {
      // 读不到绑定就不发：宁可降级气泡，也不能擅自发到用户没勾选的渠道
      logger(`[character] 读取聊天渠道失败: ${(error as Error)?.message ?? String(error)}`)
      return []
    }
  }

  const readConversations =
    options.readConversations ??
    ((_agentId: string, channels: readonly string[]) =>
      readConversationsFromDb(options.nodePath, dbPath, channels, logger))

  return {
    async send(text: string, conversationId?: string): Promise<boolean> {
      const message = text.trim()
      if (!message) return false
      const channels = await boundChannels()
      if (!channels.length) {
        logger('[character] 主动消息跳过：还没有绑定给大肥鱼的聊天渠道')
        return false
      }
      const conversations = await readConversations(agentId, channels)
      const preferred = conversationId
        ? conversations.find((conversation) => conversation.conversationId === conversationId)
        : undefined
      if (conversationId && !preferred) {
        logger('[character] 主动消息跳过：锁定会话已不在当前绑定渠道中')
        return false
      }
      const preferredTarget = preferred
        ? pickProactiveTarget([preferred], [preferred.channel])
        : null
      const target = preferredTarget ?? pickProactiveTarget(conversations, channels)
      if (!target) {
        logger('[character] 主动消息跳过：已绑定渠道里没有可用的会话（先在外面对她说句话）')
        return false
      }
      if (target.channel === 'qqbot' && options.sendDirect) {
        const sent = await options.sendDirect(target, message)
        if (!sent) logger('[character] 主动消息 QQ 直发失败（CLI 不支持 qqbot，不重试）')
        return sent
      }
      const args = [
        'message',
        'send',
        '--channel',
        target.channel,
        '--target',
        target.target,
        '--message',
        message
      ]
      // 多账号渠道 / 线程会话：会话记录里有就原样带回，避免发到默认账号或父会话
      if (target.accountId) args.push('--account', target.accountId)
      if (target.threadId) args.push('--thread-id', target.threadId)
      const result = await options.runner.run(args)
      if (result.code !== 0) {
        logger(`[character] 主动消息外发失败（exit ${result.code}）`)
        return false
      }
      return true
    }
  }
}
