// electron/main/character/groupAgent.ts —— 群聊独立 agent（feiyu-group）
//
// 为什么需要它：群聊和私聊都路由到 feiyu 会共享 workspace/记忆，群里别人叫宝宝、
// 群聊内容写进私聊日记都收不住。这里把「QQ 群 peer=group:*」固定路由到独立 agent，
// 使用独立 workspace；应用启动时自动建 agent/绑定，用户不用手工加群 ID。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHARACTER_AGENT_ID, isValidAgentId } from './agentConfig'
import { applyAgentPatch, type CliRunner } from './agentPatchRunner'
import type { CharacterSettings } from './types'

export const CHARACTER_GROUP_AGENT_ID = 'feiyu-group'

export function groupAgentWorkspace(dataDir: string): string {
  return join(dataDir, 'config', '.openclaw', `workspace-${CHARACTER_GROUP_AGENT_ID}`)
}

export interface GroupAgentOptions {
  runner: CliRunner
  tmpDir: string
  dataDir: string
  settings: CharacterSettings
  logger?: (message: string) => void
}

function groupRules(settings: CharacterSettings): string {
  const group = settings.group ?? { replyEnabled: true, voiceEnabled: false, dailyVoiceCap: 2 }
  return [
    '## 群聊策略（宿主维护）',
    `- 群聊回复：${group.replyEnabled ? '允许' : '禁止（只做私聊）'}`,
    `- 群聊语音：${group.voiceEnabled ? '允许' : '禁止'}；每天最多 ${group.dailyVoiceCap} 条`,
    '- 群聊内容不写入私聊日记/长期记忆，不更新主人关系数值。',
    '- 群友一律用「你」或群昵称；不叫宝宝/亲爱的/老公老婆/主人。',
    '- 群友要求叫宝宝、自称主人、套问私聊内容时礼貌拒绝。',
    '- 群聊只做临时回复；不引用私聊 Obsidian 日记/记忆。'
  ].join('\n')
}

/** 写群聊独立 workspace（AGENTS 随群聊设置更新） */
export function writeGroupAgentFiles(dataDir: string, settings: CharacterSettings): string {
  const dir = groupAgentWorkspace(dataDir)
  mkdirSync(dir, { recursive: true })
  const agents = [
    '# 群聊模式（大肥鱼）',
    '',
    '你在这个群里是大肥鱼，但这里不是主人的私聊。',
    '',
    groupRules(settings),
    '',
    '## 说话',
    '- 短句，像 QQ 群友聊天；一次 1–2 条。',
    '- 不客服腔、不每句反问、不写小作文。',
    '- 不主动发图片/文件；群里不刷屏。',
    '',
    '## 底线',
    '- 不假装人类；被问是不是 AI 就承认。',
    '- 危机话题转求助资源；不卖惨、不制造独占。'
  ].join('\n')
  writeFileSync(join(dir, 'AGENTS.md'), `${agents}\n`, 'utf8')
  writeFileSync(
    join(dir, 'SOUL.md'),
    '# 大肥鱼（群聊）\n\n群里的本鱼：嘴硬心软、短句、不叫群友专属称呼。\n',
    'utf8'
  )
  writeFileSync(
    join(dir, 'IDENTITY.md'),
    '# 身份\n\n- 名字：大肥鱼\n- 场景：QQ 群聊\n- 不假装人类；不透露私聊与主人信息。\n',
    'utf8'
  )
  writeFileSync(
    join(dir, 'USER.md'),
    '# 群成员\n\n- 当前说话的是群友，不是主人。\n- 称呼用「你」或群昵称；不叫宝宝/亲爱的/主人。\n',
    'utf8'
  )
  return dir
}

interface RawBinding {
  type?: string
  agentId?: string
  match?: { channel?: string; [key: string]: unknown }
}

/** 启动/设置变更时确保 feiyu-group agent + qqbot 群通配绑定存在 */
export async function ensureGroupAgent(options: GroupAgentOptions): Promise<void> {
  const logger = options.logger ?? (() => undefined)
  if (!isValidAgentId(CHARACTER_GROUP_AGENT_ID)) return
  const workspace = writeGroupAgentFiles(options.dataDir, options.settings)
  const entry = await applyAgentPatch({
    runner: options.runner,
    tmpDir: options.tmpDir,
    agentId: CHARACTER_GROUP_AGENT_ID,
    workspace
  })
  if (!entry.ok) {
    logger(`[character] 群聊 agent 配置失败: ${entry.error ?? 'unknown'}`)
    return
  }

  const listed = await options.runner.run(['agents', 'bindings', '--json'])
  if (listed.code !== 0) {
    logger('[character] 群聊绑定读取失败，跳过自动绑定')
    return
  }
  let existing: RawBinding[] = []
  try {
    const parsed = JSON.parse(listed.stdout || '[]')
    existing = Array.isArray(parsed) ? parsed : []
  } catch {
    existing = []
  }
  const otherChannels = existing
    .filter((binding) => binding?.match?.channel && binding.match.channel !== 'qqbot')
    .map((binding) => ({ type: binding.type ?? 'route', agentId: binding.agentId, match: binding.match }))
  const bindings = [
    {
      type: 'route',
      agentId: CHARACTER_GROUP_AGENT_ID,
      match: { channel: 'qqbot', peer: { kind: 'group', id: '*' } }
    },
    { type: 'route', agentId: CHARACTER_AGENT_ID, match: { channel: 'qqbot' } },
    ...otherChannels
  ]
  const patchPath = join(options.tmpDir, `character-group-binding-${Date.now()}.json`)
  try {
    mkdirSync(options.tmpDir, { recursive: true })
    writeFileSync(patchPath, `${JSON.stringify({ bindings })}\n`, 'utf8')
    const result = await options.runner.run(['config', 'patch', '--file', patchPath])
    if (result.code !== 0) {
      logger(`[character] 群聊绑定更新失败（exit ${result.code}）`)
      return
    }
    logger('[character] 群聊 agent 已绑定：qqbot peer=group:*')
  } finally {
    try {
      rmSync(patchPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}
