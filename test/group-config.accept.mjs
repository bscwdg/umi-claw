// test/group-config.accept.mjs —— 群聊策略 → OpenClaw 配置编译验收（4.5）
//
// 验的是 electron/main/services/characterGroupConfig.ts 的纯编译层：
// - channels.qqbot.groups["*"]（回复开关/需要@/历史/群提示词）与 groupPolicy 硬闸；
// - plugins.load.paths / plugins.entries["feiyu-guard"]（随包 hook 插件 + 策略配置）；
// - 4.4 双 agent 迁移：删 feiyu-group 条目与绑定、确保 feiyu 的 qqbot 渠道绑定、
//   保留其它 agent/用户手工绑定。
// 不 spawn CLI、不写盘（applyCharacterGroupPolicy 的落盘路径由真实验收/运行验证）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertDeepEq,
  assertEq,
  bundleEntry,
  printResult,
  writeJson
} from './_lib.mjs'

const modPath = bundleEntry(
  'electron/main/services/characterGroupConfig.ts',
  'group-config.mjs'
)
const {
  buildGroupOpenClawPatch,
  buildGuardConfig,
  desiredBindings,
  guardPluginDir,
  GUARD_PLUGIN_ID
} = await import(pathToFileURL(modPath).href)

const repoRoot = join(__dirname, '..')
const pluginsRoot = join(repoRoot, 'resources', 'openclaw-plugins')
const dataDir = join(repoRoot, 'test', '.tmp', 'group-config-data')

/** 与宿主 GroupSettings 默认值一致（policy-core 的 groupPolicy.ts 是权威定义） */
function defaultGroup(overrides = {}) {
  return {
    replyEnabled: true,
    requireMention: true,
    voiceEnabled: false,
    dailyVoiceCap: 2,
    words: {
      enabled: true,
      action: 'replace',
      replaceWith: '你',
      list: ['宝宝', '宝贝', '亲爱的', '老公', '老婆', '主人']
    },
    memoryIsolated: true,
    historyLimit: 20,
    extraPrompt: '',
    ...overrides
  }
}

function input(group = defaultGroup()) {
  return { dataDir, pluginsRoot, group, timezone: 'Asia/Shanghai' }
}

const r = new Recorder('群聊策略 → OpenClaw 配置（单 agent + feiyu-guard）')

await r.check('G1', '默认策略：qqbot 群配置/回复闸/guard 插件条目 形状正确', () => {
  const { patch } = buildGroupOpenClawPatch(input())
  const qqbot = patch.channels.qqbot
  assertEq(qqbot.groupPolicy, 'open', '群回复默认开 → groupPolicy=open')
  const group = qqbot.groups['*']
  assertEq(group.requireMention, true, '默认必须 @')
  assertEq(group.historyLimit, 20, '默认历史 20')
  assertEq(group.toolPolicy, 'restricted', '群工具策略 restricted（语音由 guard 硬控，不用 none 一刀切）')
  assert(typeof group.prompt === 'string' && group.prompt.includes('群'), '群提示词存在')
  assert(group.prompt.includes('你'), '提示词含称呼规则')
  const entry = patch.plugins.entries[GUARD_PLUGIN_ID]
  assertEq(entry.enabled, true, 'guard 插件启用')
  assertEq(entry.hooks.allowConversationAccess, true, 'guard 需要对话访问授权')
  assertDeepEq(entry.config.policy, {
    replyEnabled: true,
    requireMention: true,
    voice: { enabled: false, dailyCap: 2 },
    words: {
      enabled: true,
      action: 'replace',
      replaceWith: '你',
      list: ['宝宝', '宝贝', '亲爱的', '老公', '老婆', '主人']
    },
    memoryIsolated: true,
    historyLimit: 20
  }, 'guard 配置与 GroupSettings 一一对应')
  assertEq(entry.config.version, 1, 'guard 配置版本 v1')
  assertEq(entry.config.statePath, join(dataDir, 'character', 'group-guard-state.json'), '计数状态落在 character 数据目录')
  return '群配置/闸门/插件条目/策略映射 正确'
})

await r.check('G2', '群回复关闭 → groupPolicy=disabled（硬闸，不靠提示词）', () => {
  const { patch } = buildGroupOpenClawPatch(input(defaultGroup({ replyEnabled: false })))
  assertEq(patch.channels.qqbot.groupPolicy, 'disabled', '关回复=disabled')
  assertEq(patch.plugins.entries[GUARD_PLUGIN_ID].config.policy.replyEnabled, false, 'guard 也收到关闭态（双重保险）')
  return 'groupPolicy=disabled + guard 双保险'
})

await r.check('G3', '语音/词表/记忆/历史字段进入 guard 配置', () => {
  const group = defaultGroup({
    voiceEnabled: true,
    dailyVoiceCap: 7,
    words: { enabled: true, action: 'block', replaceWith: '喂', list: ['宝', '老公'] },
    memoryIsolated: false,
    historyLimit: 5,
    extraPrompt: '群里别聊工作'
  })
  const cfg = buildGuardConfig(input(group))
  assertEq(cfg.policy.voice.enabled, true, '语音开')
  assertEq(cfg.policy.voice.dailyCap, 7, '日上限透传')
  assertEq(cfg.policy.words.action, 'block', '词过滤动作 block')
  assertEq(cfg.policy.words.list.length, 2, '词表透传')
  assertEq(cfg.policy.memoryIsolated, false, '记忆隔离可关')
  assertEq(cfg.policy.historyLimit, 5, '历史条数透传')
  const { patch } = buildGroupOpenClawPatch(input(group))
  assert(patch.channels.qqbot.groups['*'].prompt.includes('群里别聊工作'), '额外提示词进群 prompt')
  return '语音/词表/记忆/历史/额外提示词 全部进配置'
})

await r.check('G4', 'plugins.load.paths 追加 guard 目录且保留既有路径（去重）', () => {
  const { patch } = buildGroupOpenClawPatch(input(), {
    loadPaths: ['/opt/other-plugin', guardPluginDir(pluginsRoot)]
  })
  const paths = patch.plugins.load.paths
  assertEq(paths.filter((p) => p === guardPluginDir(pluginsRoot)).length, 1, 'guard 目录只出现一次')
  assert(paths.includes('/opt/other-plugin'), '既有 load path 保留')
  return 'load.paths 合并去重'
})

await r.check('G5', '迁移：删 feiyu-group 条目与绑定，确保 feiyu 的 qqbot 渠道绑定，保留其它绑定', () => {
  const { patch } = buildGroupOpenClawPatch(input(), {
    bindings: [
      { type: 'route', agentId: 'feiyu-group', match: { channel: 'qqbot', peer: { kind: 'group', id: '*' } } },
      { type: 'route', agentId: 'feiyu', match: { channel: 'qqbot' } },
      { type: 'route', agentId: 'main', match: { channel: 'telegram' } },
      { type: 'route', agentId: 'main', match: { channel: 'qqbot', peer: { kind: 'group', id: 'g1' } } }
    ]
  })
  assertEq(patch.agents.entries['feiyu-group'], null, 'feiyu-group agent 条目置 null 删除')
  const bindings = patch.bindings
  assert(!bindings.some((b) => b.agentId === 'feiyu-group'), 'feiyu-group 绑定被删')
  assert(bindings.some((b) => b.agentId === 'feiyu' && b.match.channel === 'qqbot' && !b.match.peer), 'feiyu qqbot 渠道绑定保留')
  assert(bindings.some((b) => b.agentId === 'main' && b.match.channel === 'telegram'), '其它渠道绑定保留')
  assert(bindings.some((b) => b.agentId === 'main' && b.match.peer), '其它 agent 的 peer 规则保留（用户手工绑定不碰）')
  return '双 agent 迁移 + 用户绑定保留'
})

await r.check('G6', 'desiredBindings：缺 feiyu qqbot 绑定会补；不重复；空数组也补', () => {
  const withExisting = desiredBindings([
    { type: 'route', agentId: 'feiyu', match: { channel: 'qqbot' } },
    { type: 'route', agentId: 'main', match: { channel: 'feishu' } }
  ])
  assertEq(withExisting.filter((b) => b.agentId === 'feiyu' && b.match.channel === 'qqbot').length, 1, '不重复添加')
  const empty = desiredBindings([])
  assertDeepEq(empty, [{ type: 'route', agentId: 'feiyu', match: { channel: 'qqbot' } }], '空绑定补默认')
  return '补绑定/去重'
})

await r.check('G7', '幂等：同一输入两次编译结果深度相等', () => {
  const a = buildGroupOpenClawPatch(input())
  const b = buildGroupOpenClawPatch(input())
  assertDeepEq(a.patch, b.patch, '同样输入 → 同样 patch')
  return '编译幂等'
})

await r.check('G8', 'qqbot 未配置：只装 guard 插件、不写半截 channels/bindings', () => {
  const { patch, replacePaths } = buildGroupOpenClawPatch(
    { ...input(), qqbotConfigured: false },
    { bindings: [{ type: 'route', agentId: 'feiyu-group', match: { channel: 'qqbot', peer: { kind: 'group', id: '*' } } }] }
  )
  assertEq(patch.channels, undefined, '不写 channels.qqbot（避免造出缺 appId 的半截配置）')
  assertEq(patch.bindings, undefined, '不碰 bindings（避免把 feiyu 绑到不存在的渠道）')
  assertEq(patch.agents.entries['feiyu-group'], null, 'feiyu-group 条目仍清掉')
  assertEq(patch.plugins.entries[GUARD_PLUGIN_ID].enabled, true, 'guard 插件照装')
  assert(!replacePaths.includes('bindings'), 'replacePaths 不含 bindings')
  return '未配置渠道时安全降级'
})

await r.check('G9', 'qqbot 已配置：channels 与 bindings 都写、replacePaths 含 bindings', () => {
  const { patch, replacePaths } = buildGroupOpenClawPatch(
    { ...input(), qqbotConfigured: true },
    { bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }] }
  )
  assertEq(patch.channels.qqbot.groupPolicy, 'open', '渠道已配置才写群策略')
  assert(Array.isArray(patch.bindings), '写 bindings')
  assert(replacePaths.includes('bindings'), 'replacePaths 含 bindings')
  return '已配置渠道时正常写'
})

await r.check('G10', '双真源防护：configManager 不再用 app.json 旧表单覆盖角色管理的群策略', () => {
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'configManager.ts'), 'utf-8')
  assert(src.includes('qqbotManagedByCharacter'), 'configManager 有「角色已管理群策略」判定')
  assert(
    /if \(!qqbotManagedByCharacter\) \{[\s\S]{0,400}?qqCfg\.groupPolicy[\s\S]{0,200}?qqCfg\.requireMention/.test(src),
    '旧表单 groupPolicy/requireMention 写入必须被该判定包住'
  )
  return '旧表单不再覆盖角色页群策略'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-group-config.json'), result)
process.exitCode = ok ? 0 : 1
