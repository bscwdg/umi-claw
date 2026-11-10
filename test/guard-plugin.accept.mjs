// test/guard-plugin.accept.mjs —— 随包 OpenClaw hook 插件 feiyu-guard 验收（4.5）
//
// 打真源码：直接 import resources/openclaw-plugins/feiyu-guard/policy.mjs + guard.mjs
// （零 npm 依赖、零 esbuild、不启 Gateway）。fake api 收集 hook 注册，注入 fake 时钟与
// 状态读写，把「群/私聊识别、回复闸、词过滤、语音条开关/日上限/按群隔离/跨天、
// 记忆隔离、渠道出站语音剥离、状态文件异常 fail-open、配置非法值」逐条打真；每条都配负向断言。
//
// 末尾 7 条 MUTATION：把 policy/guard 的判定改坏后重新 import，断言「坏实现确实会放过
// 本该拦的行为」——证明前面的断言真的能抓住逻辑回退，而不是恒绿。
//
// 用法：node test/guard-plugin.accept.mjs

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  Recorder,
  __dirname,
  assert,
  assertDeepEq,
  assertEq,
  printResult,
  tmpDir,
  writeJson
} from './_lib.mjs'

const pluginDir = join(__dirname, '..', 'resources', 'openclaw-plugins', 'feiyu-guard')
const policyModule = await import(pathToFileURL(join(pluginDir, 'policy.mjs')).href)
const guardModule = await import(pathToFileURL(join(pluginDir, 'guard.mjs')).href)

const {
  DEFAULT_WORD_LIST,
  GROUP_MEMORY_TOOLS,
  GUARD_TOOL_MATCHERS,
  GUARD_CONFIG_VERSION,
  GUARD_REASONS,
  createDefaultGuardPolicy,
  dayKey,
  emptyState,
  filterWords,
  groupKeyFromSessionKey,
  isAudioAttachment,
  isGroupTarget,
  normalizeState,
  parseGuardConfig,
  payloadHasVisibleContent,
  payloadVoiceInfo,
  voiceCounter,
  voiceUploadGroupId
} = policyModule
const { registerGuard } = guardModule

// ── 固定夹具：时区/时间/群与私聊 id ──────────────────────────────────────────
const TZ = 'Asia/Shanghai'
/** 2026-11-11 12:00 Asia/Shanghai（UTC 04:00），避开跨天边界 */
const NOON = Date.UTC(2026, 10, 11, 4, 0, 0)
const TODAY = '2026-11-11'
const YESTERDAY = '2026-11-10'
const GROUP_ID = 'a'.repeat(32)
const GROUP_ID_2 = 'b'.repeat(32)
const DM_ID = 'f'.repeat(32)
const GROUP_TO = `qqbot:group:${GROUP_ID}`
const DM_TO = `qqbot:c2c:${DM_ID}`
const GROUP_SESSION = `agent:feiyu:qqbot:group:${GROUP_ID}`
const DM_SESSION = `agent:feiyu:qqbot:direct:${DM_ID}`
const GROUP_SESSION_2 = `agent:feiyu:qqbot:group:${GROUP_ID_2}`

/** 语音上传的 tool 参数（qqbot_platform_api 的真实形状：method/path/body） */
function voiceUploadParams(groupId, overrides = {}) {
  return {
    method: 'POST',
    path: `/v2/groups/${groupId}/files`,
    body: { file_type: 3, srv_send_msg: false, file_data: 'AAAA' },
    ...overrides
  }
}

function createFakeApi(pluginConfig) {
  const registrations = new Map()
  const api = {
    id: 'feiyu-guard',
    pluginConfig,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, opts) {
      const list = registrations.get(name) ?? []
      list.push({ handler, opts })
      registrations.set(name, list)
    }
  }
  return {
    api,
    registrations,
    hook(name) {
      const list = registrations.get(name)
      return list && list.length ? list[0] : null
    },
    hookCount() {
      let total = 0
      for (const list of registrations.values()) total += list.length
      return total
    }
  }
}

/** guard 配置：默认值来自插件自身的 createDefaultGuardPolicy（与宿主 GroupSettings 对齐） */
function guardConfig({
  version = GUARD_CONFIG_VERSION,
  statePath = join(tmpDir, 'guard-plugin-state.json'),
  timezone = TZ,
  policy: policyOverride = {}
} = {}) {
  const defaults = createDefaultGuardPolicy()
  const policy = { ...defaults, ...policyOverride }
  policy.voice = { ...defaults.voice, ...(policyOverride.voice ?? {}) }
  policy.words = { ...defaults.words, ...(policyOverride.words ?? {}) }
  return { version, statePath, timezone, policy }
}

/** 注册 guard；默认固定时钟 + 收集 warn，可覆盖依赖 */
function setup(config, deps = {}) {
  const warnings = []
  const fake = createFakeApi(config)
  registerGuard(fake.api, {
    now: () => NOON,
    warn: (message) => warnings.push(String(message)),
    ...deps
  })
  return { ...fake, warnings, warningsText: () => warnings.join('\n') }
}

async function sendMessage(fake, event, ctx) {
  const entry = fake.hook('message_sending')
  assert(entry, 'message_sending hook 未注册')
  return await entry.handler(event, ctx)
}

async function callTool(fake, event, ctx) {
  const entry = fake.hook('before_tool_call')
  assert(entry, 'before_tool_call hook 未注册')
  return await entry.handler(event, ctx)
}

/** reply_payload_sending 事件：event 自带 channel/sessionKey（缺省时退回 ctx） */
function replyEvent(payload, overrides = {}) {
  return {
    payload,
    kind: 'final',
    channel: 'qqbot',
    sessionKey: GROUP_SESSION,
    ...overrides
  }
}

async function sendReplyPayload(fake, event, ctx) {
  const entry = fake.hook('reply_payload_sending')
  assert(entry, 'reply_payload_sending hook 未注册')
  return await entry.handler(event, ctx)
}

/** 渠道出站语音条 payload（audioAsVoice + 语音媒体） */
function voicePayload(overrides = {}) {
  return {
    text: '在呢',
    mediaUrl: 'voice-1.silk',
    mediaUrls: ['voice-1.silk'],
    attachments: [{ type: 'audio', mimeType: 'audio/silk', mediaUrl: 'voice-1.silk' }],
    audioAsVoice: true,
    ...overrides
  }
}

/** 内存状态存储：readState/writeState 注入；value 是「磁盘上的状态」 */
function memoryStore(initial = null) {
  let value = initial
  const writes = []
  let reads = 0
  return {
    deps: {
      readState: () => {
        reads += 1
        return value
      },
      writeState: (_statePath, state) => {
        value = state
        writes.push(state)
      }
    },
    get value() {
      return value
    },
    get reads() {
      return reads
    },
    writes
  }
}

const groupCtx = { channelId: 'qqbot', sessionKey: GROUP_SESSION }
const dmCtx = { channelId: 'qqbot', sessionKey: DM_SESSION }

const r = new Recorder('feiyu-guard OpenClaw hook 插件（群策略硬执行 + fail-open）')

// ── P1：配置解析默认值 ───────────────────────────────────────────────────────
await r.check('P1', 'parseGuardConfig：缺省/非对象 → 与 GroupSettings 对齐的默认值', () => {
  const expectedPolicy = createDefaultGuardPolicy()
  for (const raw of [undefined, null, 'garbage', 42, []]) {
    const cfg = parseGuardConfig(raw)
    assertEq(cfg.version, GUARD_CONFIG_VERSION, `version 默认 1（输入 ${JSON.stringify(raw)}）`)
    assertEq(cfg.statePath, '', 'statePath 缺省空串')
    assertEq(cfg.timezone, 'UTC', 'timezone 缺省 UTC')
    assertDeepEq(cfg.policy, expectedPolicy, 'policy 默认值与 createDefaultGuardPolicy 一致')
  }
  // 负向：默认词表不应被共享引用污染
  const cfg = parseGuardConfig(undefined)
  cfg.policy.words.list.push('污染')
  assertEq(DEFAULT_WORD_LIST.includes('污染'), false, '默认词表常量不可被返回值污染')
  return '缺省/非法输入都收敛到同一份默认策略'
})

await r.check('P2', 'parseGuardConfig：非法值回落/夹紧、未知字段丢弃、v1 之外版本原样保留', () => {
  const cfg = parseGuardConfig({
    version: 2,
    statePath: `  C:/data/state.json  `,
    timezone: '',
    unknownTop: true,
    policy: {
      replyEnabled: 'no',
      requireMention: 0,
      voice: { enabled: 1, dailyCap: 99 },
      words: { action: 'explode', replaceWith: 7, list: [' 宝宝 ', '', '宝宝', 5] },
      memoryIsolated: 'yes',
      historyLimit: -5,
      unknownPolicy: 'x'
    }
  })
  assertEq(cfg.version, 2, '合法正整数版本原样保留（由 guard 判不支持）')
  assertEq(cfg.statePath, 'C:/data/state.json', 'statePath trim')
  assertEq(cfg.timezone, 'UTC', '空 timezone 回落 UTC')
  assertEq(cfg.policy.replyEnabled, true, '非布尔 replyEnabled 回落默认')
  assertEq(cfg.policy.requireMention, true, '数字 requireMention 回落默认')
  assertEq(cfg.policy.voice.enabled, false, '非布尔 voice.enabled 回落默认 false')
  assertEq(cfg.policy.voice.dailyCap, 20, 'dailyCap 夹到上限 20')
  assertEq(cfg.policy.words.action, 'replace', '未知 action 回落 replace')
  assertEq(cfg.policy.words.replaceWith, '你', '非字符串 replaceWith 回落默认')
  assertDeepEq(cfg.policy.words.list, ['宝宝'], '词表 trim/去重/丢非字符串')
  assertEq(cfg.policy.memoryIsolated, true, '非布尔 memoryIsolated 回落默认')
  assertEq(cfg.policy.historyLimit, 0, 'historyLimit 夹到下限 0')
  assertEq('unknownTop' in cfg, false, '顶层未知字段丢弃')
  assertEq('unknownPolicy' in cfg.policy, false, 'policy 未知字段丢弃')
  // 负向：非法版本（字符串/0/负数）回落 1，不会被误判成「支持的新版本」
  assertEq(parseGuardConfig({ version: '1' }).version, 1, '字符串版本回落 1')
  assertEq(parseGuardConfig({ version: 0 }).version, 1, '0 回落 1')
  return '非法值全部夹紧/回落，未知字段不落进结果'
})

// ── P3：群/私聊识别 ──────────────────────────────────────────────────────────
await r.check('P3', 'isGroupTarget：qqbot 群命中（to/sessionKey 两条路），私聊/未知/其它渠道放行', () => {
  assertEq(isGroupTarget({ to: GROUP_TO }), true, 'to=qqbot:group:<id> → 群')
  assertEq(isGroupTarget({ to: GROUP_TO.toUpperCase() }), true, '目标前缀大小写不敏感')
  assertEq(isGroupTarget({ sessionKey: GROUP_SESSION }), true, 'sessionKey 含 :qqbot:group: → 群')
  assertEq(isGroupTarget({ to: '', sessionKey: GROUP_SESSION, channelId: 'qqbot' }), true, 'to 缺失时 sessionKey 兜底')
  assertEq(
    isGroupTarget({ channelId: 'qqbot', sessionKey: 'legacy:group:1' }),
    true,
    '老宿主 sessionKey 带 :group: 时用 ctx.channelId=qqbot 补证'
  )
  // 负向
  assertEq(isGroupTarget({ to: DM_TO, sessionKey: DM_SESSION }), false, 'qqbot:c2c 私聊 → 放行')
  assertEq(isGroupTarget({ sessionKey: DM_SESSION }), false, 'direct sessionKey → 放行')
  assertEq(isGroupTarget({}), false, '没有任何字段 → 放行（视为私聊）')
  assertEq(isGroupTarget(undefined), false, 'undefined → 放行')
  assertEq(isGroupTarget({ to: 'qqbot:channel:123' }), false, 'QQ 频道不是群 → 放行')
  assertEq(
    isGroupTarget({ to: 'telegram:group:123', sessionKey: 'agent:feiyu:telegram:group:123' }),
    false,
    '非 qqbot 渠道即使含 :group: 也不拦'
  )
  assertEq(
    isGroupTarget({ sessionKey: 'agent:feiyu:telegram:group:123' }),
    false,
    '无 channelId 时非 qqbot 的 :group: 也不误判（只认 :qqbot:group:）'
  )
  assertEq(isGroupTarget({ to: GROUP_TO, channelId: 'telegram' }), false, 'channelId 非 qqbot 时一票否决')
  return '群/私聊两条判据 + 非 QQ 渠道负向都正确'
})

// ── P4：按天日期键 ───────────────────────────────────────────────────────────
await r.check('P4', 'dayKey：时区正确、跨天边界、非法时区回落 UTC、非法时间不抛错', () => {
  assertEq(dayKey(NOON, TZ), TODAY, '上海 12:00 → 2026-11-11')
  const justBefore = Date.UTC(2026, 10, 10, 15, 59, 59) // 上海 23:59:59
  const justAfter = justBefore + 1000 // 上海 00:00:00
  assertEq(dayKey(justBefore, TZ), YESTERDAY, '跨天前一秒 → 11-10')
  assertEq(dayKey(justAfter, TZ), TODAY, '跨天后一秒 → 11-11（按本地时区而非 UTC）')
  // 负向：同一时刻在 UTC 与上海属于不同天，证明不是「一律用 UTC」
  const evening = Date.UTC(2026, 10, 10, 20, 0, 0) // 上海 11-11 04:00，UTC 11-10
  assertEq(dayKey(evening, TZ), TODAY, '上海视角是 11-11')
  assertEq(dayKey(evening, 'UTC'), YESTERDAY, 'UTC 视角是 11-10（时区参数真的生效）')
  assertEq(dayKey(evening, 'Mars/Base'), YESTERDAY, '非法时区回落 UTC（不抛错）')
  assert(/^\d{4}-\d{2}-\d{2}$/.test(dayKey('not-a-number', TZ)), '非法 now 仍返回合法日期键')
  return '时区生效 + 跨天边界 + 非法入参都安全'
})

// ── P5：词过滤 replace ───────────────────────────────────────────────────────
await r.check('P5', 'filterWords replace：命中改写/多处替换；未命中、禁用、空词表不改写', () => {
  const words = {
    enabled: true,
    action: 'replace',
    replaceWith: '你',
    list: ['宝宝', '主人']
  }
  const hit = filterWords('宝宝，主人早上好，宝宝', words)
  assertEq(hit.content, '你，你早上好，你', '所有命中词都替换成 replaceWith')
  assertEq(hit.changed, true, '命中 → changed=true')
  assertEq(hit.cancel, undefined, 'replace 动作不取消消息')
  assertDeepEq(hit.matched, ['宝宝', '主人'], 'matched 记录命中的词')
  // 负向
  assertEq(filterWords('今天天气不错', words).changed, false, '未命中 → changed=false')
  assertEq(filterWords('今天天气不错', words).content, '今天天气不错', '未命中不改写内容')
  assertEq(filterWords('宝宝', { ...words, enabled: false }).changed, false, '禁用 → 不改写')
  assertEq(filterWords('宝宝', { ...words, list: [] }).changed, false, '空词表 → 不改写')
  assertEq(filterWords(undefined, words).changed, false, '非法文本 → 不改写且不抛错')
  return '替换语义与三条负向都正确'
})

// ── P6：词过滤 block ─────────────────────────────────────────────────────────
await r.check('P6', 'filterWords block：命中取消整条；未命中不改写、不取消', () => {
  const words = { enabled: true, action: 'block', replaceWith: '你', list: ['老公'] }
  const hit = filterWords('老公你回来啦', words)
  assertEq(hit.cancel, true, '命中 → cancel=true')
  assertEq(hit.reason, 'word-blocked', 'block 原因码')
  assertEq(hit.content, '老公你回来啦', 'block 不改写内容（取消整条即可）')
  // 负向
  const miss = filterWords('你好呀', words)
  assertEq(miss.cancel, undefined, '未命中不取消')
  assertEq(miss.changed, false, '未命中不改写')
  assertEq(filterWords('老公', { ...words, enabled: false }).cancel, undefined, '禁用时不取消')
  return 'block 命中取消 + 未命中/禁用负向正确'
})

// ── P7：状态归一 + 语音计数纯函数 ───────────────────────────────────────────
await r.check('P7', '状态与语音计数：跨天/坏 JSON/未知版本清零，按群隔离，cap=0 全拦', () => {
  assertDeepEq(normalizeState(null, TODAY), emptyState(TODAY), 'null → 空状态')
  assertDeepEq(
    normalizeState({ version: 1, day: TODAY, counts: { [GROUP_ID]: 2, other: 0, bad: -1, str: '3' } }, TODAY),
    { version: 1, day: TODAY, counts: { [GROUP_ID]: 2 } },
    '只保留非负整数计数'
  )
  // 负向：跨天/未知版本/损坏结构都必须清零（否则昨天用满会误拦今天）
  assertDeepEq(
    normalizeState({ version: 1, day: YESTERDAY, counts: { [GROUP_ID]: 5 } }, TODAY).counts,
    {},
    '跨天清零'
  )
  assertDeepEq(
    normalizeState({ version: 2, day: TODAY, counts: { [GROUP_ID]: 5 } }, TODAY).counts,
    {},
    '未知状态版本清零'
  )
  assertDeepEq(normalizeState({ counts: 'oops' }, TODAY).counts, {}, '损坏 counts → 空')

  const fresh = emptyState(TODAY)
  assertEq(voiceCounter.decide(fresh, { groupId: GROUP_ID, enabled: true, dailyCap: 2 }).allow, true, '未用满 → 允许')
  assertEq(voiceCounter.decide(fresh, { groupId: GROUP_ID, enabled: false, dailyCap: 2 }).reason, GUARD_REASONS.VOICE_DISABLED, '关闭 → voice-disabled')
  assertEq(voiceCounter.decide(fresh, { groupId: GROUP_ID, enabled: true, dailyCap: 0 }).allow, false, 'cap=0 → 全拦')
  const full = { version: 1, day: TODAY, counts: { [GROUP_ID]: 2 } }
  assertEq(voiceCounter.decide(full, { groupId: GROUP_ID, enabled: true, dailyCap: 2 }).reason, GUARD_REASONS.VOICE_DAILY_CAP, '用满 → daily-cap')
  // 按群隔离 + 不可变
  const recorded = voiceCounter.record(full, GROUP_ID_2)
  assertEq(voiceCounter.countOf(recorded, GROUP_ID), 2, '记录别的群不影响本群计数')
  assertEq(voiceCounter.countOf(recorded, GROUP_ID_2), 1, '新群从 0 起计 +1')
  assertEq(voiceCounter.countOf(full, GROUP_ID_2), 0, 'record 不修改原状态（纯函数）')
  return '归一/清零/隔离/cap 边界全部正确'
})

// ── P8：渠道出站语音识别/剥离 + 计数键 ──────────────────────────────────────
await r.check('P8', 'payloadVoiceInfo 剥离语音保留文本/非音频 media；groupKey 与 platform path 同源', () => {
  assertEq(groupKeyFromSessionKey(GROUP_SESSION), GROUP_ID, '群 sessionKey → 群 openid')
  assertEq(groupKeyFromSessionKey(`agent:x:qqbot:group:${GROUP_ID}:sub:1`), GROUP_ID, '子会话仍取同一群键')
  assertEq(groupKeyFromSessionKey(DM_SESSION), '', '私聊 sessionKey 不是群键')
  assertEq(groupKeyFromSessionKey(undefined), '', '缺失 sessionKey → 空串')
  assertEq(isAudioAttachment({ type: 'audio' }), true, 'type=audio')
  assertEq(isAudioAttachment({ mimeType: 'audio/ogg' }), true, 'mimeType=audio/*')
  assertEq(isAudioAttachment({ contentType: 'AUDIO/MPEG' }), true, 'contentType=audio/*（大小写不敏感）')
  assertEq(isAudioAttachment({ kind: 'audio' }), true, 'kind=audio（前向兼容）')
  assertEq(isAudioAttachment({ mimeType: 'image/png' }), false, '图片不算音频')
  assertEq(isAudioAttachment(undefined), false, '缺失附件不算音频')

  // audioAsVoice + 单 mediaUrl：剥媒体、关标记、留 text
  const single = payloadVoiceInfo({ text: '在呢', mediaUrl: 'v.silk', audioAsVoice: true })
  assertEq(single.isVoice, true, 'audioAsVoice → 语音 payload')
  assertEq(single.changed, true, '有媒体 → changed')
  assertEq(single.removedMedia, 1, '剥掉 1 个语音媒体')
  assertEq(single.payload.text, '在呢', '文本保留')
  assertEq(single.payload.audioAsVoice, false, '标记关闭')
  assertEq('mediaUrl' in single.payload, false, '单 mediaUrl 被删除')
  // attachments 下标对齐：语音在前、图片在后 → 只剥语音
  const aligned = payloadVoiceInfo({
    text: '看图',
    mediaUrls: ['v.silk', 'pic.png'],
    attachments: [{ type: 'audio' }, { type: 'image', mimeType: 'image/png' }],
    audioAsVoice: false
  })
  assertEq(aligned.isVoice, true, 'attachments 里有音频 → 语音 payload')
  assertDeepEq(aligned.payload.mediaUrls, ['pic.png'], '保留非音频 media')
  assertDeepEq(aligned.payload.attachments, [{ type: 'image', mimeType: 'image/png' }], '附件同步对齐剥离')
  assertEq(aligned.removedMedia, 1, '只剥 1 个')
  // 负向：没有语音信号 → 原样
  const plain = { text: 'hi', mediaUrls: ['pic.png'], attachments: [{ type: 'image' }] }
  assertEq(payloadVoiceInfo(plain).isVoice, false, '图片回复不是语音')
  assertEq(payloadVoiceInfo(plain).payload, plain, '非语音 payload 原样引用（不复制）')
  assertEq(payloadVoiceInfo({ text: 'hi' }).isVoice, false, '纯文本不是语音')
  // audioAsVoice 无 media：仍按语音策略处理（取消或剥离标记）
  const noMedia = payloadVoiceInfo({ audioAsVoice: true })
  assertEq(noMedia.isVoice, true, 'audioAsVoice 无媒体也算语音意图')
  assertEq(noMedia.payload.audioAsVoice, false, '标记被关闭')
  // 可见内容判定
  assertEq(payloadHasVisibleContent({ text: ' ' }), false, '空白文本不算可见内容')
  assertEq(payloadHasVisibleContent({ text: '', mediaUrls: [] }), false, '无文本无媒体 → 无内容')
  assertEq(payloadHasVisibleContent({ mediaUrls: ['pic.png'] }), true, '有媒体 → 有内容')
  assertEq(payloadHasVisibleContent({ presentation: { blocks: [] } }), true, 'presentation 也算内容（避免误取消）')
  return '语音识别/对齐剥离/计数键/可见内容判定都正确'
})

// ── G0：注册形状 ─────────────────────────────────────────────────────────────
await r.check('G0', 'registerGuard：注册 message_sending + reply_payload_sending + before_tool_call', () => {
  const fake = setup(guardConfig())
  assertEq(fake.hookCount(), 3, '注册三个 hook')
  const sending = fake.hook('message_sending')
  assert(sending, 'message_sending 已注册')
  assertEq(sending.opts, undefined, 'message_sending 不需要 matcher')
  const reply = fake.hook('reply_payload_sending')
  assert(reply, 'reply_payload_sending 已注册（渠道出站语音兜底）')
  assertEq(reply.opts, undefined, 'reply_payload_sending 不需要 matcher')
  const gate = fake.hook('before_tool_call')
  assert(gate, 'before_tool_call 已注册')
  assertDeepEq(gate.opts.matcher, [...GUARD_TOOL_MATCHERS], 'matcher 覆盖语音网关与三个写工具')
  assertDeepEq([...GUARD_TOOL_MATCHERS], ['qqbot_platform_api', 'write', 'edit', 'apply_patch'], 'matcher 常量按契约固定')
  return '三个 hook 与 matcher 形状正确'
})

// ── G1：群回复总开关 ─────────────────────────────────────────────────────────
await r.check('G1', '群回复关闭：QQ 群出站 cancel，私聊/未知会话/其它渠道放行', async () => {
  const fake = setup(guardConfig({ policy: { replyEnabled: false } }))
  const group = await sendMessage(fake, { to: GROUP_TO, content: '你好' }, groupCtx)
  assertDeepEq(group, { cancel: true, cancelReason: GUARD_REASONS.REPLY_DISABLED }, '群消息取消并带原因码')
  // 负向
  assertEq(await sendMessage(fake, { to: DM_TO, content: '你好' }, dmCtx), undefined, '私聊放行')
  assertEq(await sendMessage(fake, { content: '你好' }, undefined), undefined, 'ctx 缺失 → 放行')
  assertEq(
    await sendMessage(fake, { to: 'telegram:group:1', content: '你好' }, { channelId: 'telegram', sessionKey: 'agent:feiyu:telegram:group:1' }),
    undefined,
    '非 QQ 群不取消'
  )
  // 负向：只有 sessionKey 也认得群
  const bySession = await sendMessage(fake, { content: '你好' }, groupCtx)
  assertDeepEq(bySession, { cancel: true, cancelReason: GUARD_REASONS.REPLY_DISABLED }, 'to 缺失时按 sessionKey 判定为群')
  return '群取消 + 私聊/未知/其它渠道负向正确'
})

// ── G2：词过滤 hook ──────────────────────────────────────────────────────────
await r.check('G2', '词过滤 hook：replace 改写群出站；block 取消；私聊/禁用/未命中原样放行', async () => {
  const replaceFake = setup(guardConfig())
  const rewritten = await sendMessage(replaceFake, { to: GROUP_TO, content: '宝宝你好' }, groupCtx)
  assertDeepEq(rewritten, { content: '你你好' }, '群里命中词 → 返回改写后的 content')
  // 负向
  assertEq(await sendMessage(replaceFake, { to: DM_TO, content: '宝宝你好' }, dmCtx), undefined, '私聊不改写')
  assertEq(await sendMessage(replaceFake, { to: GROUP_TO, content: '今天吃什么' }, groupCtx), undefined, '未命中不改写')
  assertEq(
    await sendMessage(setup(guardConfig({ policy: { words: { enabled: false } } })), { to: GROUP_TO, content: '宝宝' }, groupCtx),
    undefined,
    '词过滤关闭不改写'
  )
  assertEq(await sendMessage(replaceFake, { to: GROUP_TO, content: undefined }, groupCtx), undefined, 'content 缺失不抛错')

  const blockFake = setup(guardConfig({ policy: { words: { action: 'block' } } }))
  assertDeepEq(
    await sendMessage(blockFake, { to: GROUP_TO, content: '老婆我回来了' }, groupCtx),
    { cancel: true, cancelReason: GUARD_REASONS.WORD_BLOCKED },
    'block 动作命中 → 取消整条群消息'
  )
  assertEq(await sendMessage(blockFake, { to: GROUP_TO, content: '我回来了' }, groupCtx), undefined, 'block 未命中放行')
  return 'replace/block 与私聊/禁用/未命中负向都正确'
})

// ── G3：群语音开关 ───────────────────────────────────────────────────────────
await r.check('G3', '群语音开关：关闭拦群语音上传；图片/非 files 路径/私聊/c2c 全部放行', async () => {
  const fake = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  const blocked = await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx)
  assertDeepEq(blocked, { block: true, blockReason: GUARD_REASONS.VOICE_DISABLED }, '关闭 → block 并带原因码')
  // 负向：不是语音上传的一律放行
  const image = await callTool(
    fake,
    { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID, { body: { file_type: 1 } }) },
    groupCtx
  )
  assertEq(image, undefined, '图片上传（file_type=1）放行')
  const plain = await callTool(fake, { toolName: 'qqbot_platform_api', params: { method: 'POST', path: `/v2/groups/${GROUP_ID}/files` } }, groupCtx)
  assertEq(plain, undefined, '没有 body 的 files 请求放行')
  const infoPath = await callTool(
    fake,
    { toolName: 'qqbot_platform_api', params: { method: 'GET', path: `/v2/groups/${GROUP_ID}/info` } },
    groupCtx
  )
  assertEq(infoPath, undefined, '非 /files 路径放行')
  const c2c = await callTool(
    fake,
    { toolName: 'qqbot_platform_api', params: { method: 'POST', path: `/v2/users/${DM_ID}/files`, body: { file_type: 3 } } },
    dmCtx
  )
  assertEq(c2c, undefined, '私聊语音上传放行')
  const groupVoiceInDm = await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, dmCtx)
  assertEq(groupVoiceInDm, undefined, '私聊会话里的群上传参数也放行（按会话判定）')
  return '关闭态拦截 + 五条放行负向都正确'
})

// ── G4：群语音日上限/按群隔离/跨天 ──────────────────────────────────────────
await r.check('G4', '群语音日上限：前 N 条放行并落状态，第 N+1 条拦；按群隔离；跨天重置', async () => {
  let clock = NOON
  const store = memoryStore()
  const fake = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 2 } } }), {
    ...store.deps,
    now: () => clock
  })

  assertEq(await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx), undefined, '第 1 条放行')
  assertEq(await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx), undefined, '第 2 条放行')
  const third = await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx)
  assertDeepEq(third, { block: true, blockReason: GUARD_REASONS.VOICE_DAILY_CAP }, '第 3 条触发日上限')
  assertEq(store.value.day, TODAY, '状态按当天记录')
  assertEq(store.value.counts[GROUP_ID], 2, '本群计数=2')
  assertEq(store.writes.length, 2, '只有放行的那两条写状态（拦截不写）')

  // 负向：另一个群不受影响
  assertEq(await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID_2) }, { channelId: 'qqbot', sessionKey: GROUP_SESSION_2 }), undefined, '另一个群独立计数放行')
  assertEq(store.value.counts[GROUP_ID], 2, '另一个群不影响本群计数')

  // 跨天：时钟拨到次日 → 计数重置
  clock = NOON + 86_400_000
  assertEq(await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx), undefined, '次日重新可发')
  assertEq(store.value.day, '2026-11-12', '状态日期滚动到次日')
  assertEq(store.value.counts[GROUP_ID], 1, '次日计数从 0 重新计')
  return '日上限/按群隔离/跨天重置都正确'
})

// ── G5：并发下计数不丢 ──────────────────────────────────────────────────────
await r.check('G5', '并发上传：cap=2 两条都放行且计数=2；cap=1 并发只放行一条（缓存先占位）', async () => {
  const store = memoryStore()
  const fake = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 2 } } }), store.deps)
  const results = await Promise.all([
    callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx)
  ])
  assertDeepEq(results, [undefined, undefined], 'cap=2 两条并发都放行')
  assertEq(store.value.counts[GROUP_ID], 2, '计数不被并发覆盖（读-改-写只做一次）')

  const store1 = memoryStore()
  const fake1 = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store1.deps)
  const results1 = await Promise.all([
    callTool(fake1, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    callTool(fake1, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx)
  ])
  const blocked = results1.filter((result) => result && result.block === true)
  assertEq(blocked.length, 1, 'cap=1 并发恰好拦下一条')
  assertEq(blocked[0].blockReason, GUARD_REASONS.VOICE_DAILY_CAP, '拦截原因码正确')
  assertEq(store1.value.counts[GROUP_ID], 1, '只计一条')
  return '并发下计数一致，不因竞态多放'
})

// ── G6：群记忆隔离 ──────────────────────────────────────────────────────────
await r.check('G6', '记忆隔离：群会话 write/edit/apply_patch 全 block；私聊/关闭隔离/其它工具放行', async () => {
  const fake = setup(guardConfig())
  for (const toolName of ['write', 'edit', 'apply_patch']) {
    assertDeepEq(
      await callTool(fake, { toolName, params: { file_path: '/tmp/x', content: 'x' } }, groupCtx),
      { block: true, blockReason: GUARD_REASONS.MEMORY_ISOLATED },
      `群里 ${toolName} 被拦`
    )
  }
  // 负向
  assertEq(await callTool(fake, { toolName: 'write', params: {} }, dmCtx), undefined, '私聊 write 放行')
  assertEq(
    await callTool(setup(guardConfig({ policy: { memoryIsolated: false } })), { toolName: 'write', params: {} }, groupCtx),
    undefined,
    '关掉隔离后群里 write 放行'
  )
  assertEq(await callTool(fake, { toolName: 'read', params: { file_path: '/tmp/x' } }, groupCtx), undefined, '群里 read 放行')
  assertEq(await callTool(fake, { toolName: 'exec', params: { command: 'ls' } }, groupCtx), undefined, '群里 exec 不拦（已知限制）')
  assertEq(await callTool(fake, { params: {} }, groupCtx), undefined, 'toolName 缺失不抛错')
  return '三类写入工具拦截 + 四条放行负向正确'
})

// ── G7：状态文件异常 fail-open ──────────────────────────────────────────────
await r.check('G7', '状态文件读/写失败、坏 JSON、statePath 为空：记录失败但继续放行', async () => {
  // 读失败：按空状态处理，仍放行
  const readFail = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 2 } } }), {
    readState: () => {
      throw new Error('EACCES')
    },
    writeState: () => {}
  })
  assertEq(
    await callTool(readFail, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    '读失败 → 从 0 计，放行'
  )
  assert(readFail.warningsText().includes('state read failed'), '读失败留 warn 日志')

  // 写失败：仍放行，且进程内缓存继续计数（下次按新计数判定）
  const writeFail = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), {
    readState: () => null,
    writeState: () => {
      throw new Error('EPERM')
    }
  })
  assertEq(
    await callTool(writeFail, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    '写失败不阻断本次放行'
  )
  assert(writeFail.warningsText().includes('state write failed'), '写失败留 warn 日志')
  assertDeepEq(
    await callTool(writeFail, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    { block: true, blockReason: GUARD_REASONS.VOICE_DAILY_CAP },
    '写失败也不丢计数：cap=1 第二条仍被拦'
  )

  // 真实默认实现：坏 JSON 视为无状态；写入后文件是合法状态
  const corruptDir = mkdtempSync(join(tmpDir, 'guard-corrupt-'))
  const corruptPath = join(corruptDir, 'state.json')
  writeFileSync(corruptPath, '{ not json', 'utf8')
  const corrupt = setup(
    guardConfig({ statePath: corruptPath, policy: { voice: { enabled: true, dailyCap: 2 } } }),
    {}
  )
  // 注意：setup 默认注入 readState/writeState？没有——只注入 now/warn，读写走默认实现
  assertEq(
    await callTool(corrupt, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    '坏 JSON → 放行且不抛错'
  )
  const repaired = JSON.parse(readFileSync(corruptPath, 'utf8'))
  assertEq(repaired.day, TODAY, '坏文件被原子覆写为当天状态')
  assertEq(repaired.counts[GROUP_ID], 1, '放行后计数=1')

  // statePath 为空：不落盘、只警告，业务仍可用
  const noPath = setup(guardConfig({ statePath: '', policy: { voice: { enabled: true, dailyCap: 1 } } }))
  assertEq(
    await callTool(noPath, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    '无状态路径仍放行'
  )
  assert(noPath.warningsText().includes('statePath is empty'), '无状态路径留 warn 日志')

  // 未知配置版本：不注册任何 hook（一刀不拦）
  const unsupported = setup(guardConfig({ version: 2 }))
  assertEq(unsupported.hookCount(), 0, '未知版本不注册 hook（fail-open）')
  assert(unsupported.warningsText().includes('unsupported config version'), '未知版本留 warn 日志')

  // 没有 hook API 的宿主：静默返回，不抛错
  let noop = null
  noop = registerGuard({}, {})
  assertEq(typeof noop, 'function', '无 api 时返回 noop disposer')
  return '四类状态异常 + 未知版本 + 无 api 宿主都安全放行'
})

// ── G8：真实原子写 ──────────────────────────────────────────────────────────
await r.check('G8', '真实状态文件：默认实现原子写，JSON 形状固定，无临时文件残留', async () => {
  const dir = mkdtempSync(join(tmpDir, 'guard-write-'))
  const statePath = join(dir, 'character', 'group-guard-state.json')
  const fake = setup(
    guardConfig({ statePath, policy: { voice: { enabled: true, dailyCap: 3 } } }),
    {}
  )
  for (let index = 0; index < 3; index += 1) {
    assertEq(
      await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
      undefined,
      `第 ${index + 1} 条放行`
    )
  }
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assertDeepEq(saved, { version: 1, day: TODAY, counts: { [GROUP_ID]: 3 } }, '文件内容形状固定')
  const leftovers = readdirSync(join(dir, 'character')).filter((name) => name !== 'group-guard-state.json')
  assertDeepEq(leftovers, [], '没有 .tmp 残留（rename 原子生效）')
  return '原子写/固定形状/无残留都正确'
})

// ── MUTATION：改坏逻辑必须被断言抓住 ───────────────────────────────────────
const policySource = readFileSync(join(pluginDir, 'policy.mjs'), 'utf8')
const guardSource = readFileSync(join(pluginDir, 'guard.mjs'), 'utf8')

function applyMutation(source, from, to) {
  if (!source.includes(from)) throw new Error(`MUTATION 锚点不存在（测试与实现已漂移）：${from}`)
  return source.replace(from, to)
}

/** 把 policy/guard 复制到临时目录做文本变异，返回变异后的 registerGuard（同目录可解析相对 import） */
async function importMutatedGuard({ policyEdits = [], guardEdits = [] } = {}) {
  mkdirSync(tmpDir, { recursive: true })
  const dir = mkdtempSync(join(tmpDir, 'guard-mutation-'))
  let policyText = policySource
  for (const [from, to] of policyEdits) policyText = applyMutation(policyText, from, to)
  let guardText = guardSource
  for (const [from, to] of guardEdits) guardText = applyMutation(guardText, from, to)
  writeFileSync(join(dir, 'policy.mjs'), policyText, 'utf8')
  writeFileSync(join(dir, 'guard.mjs'), guardText, 'utf8')
  const url = `${pathToFileURL(join(dir, 'guard.mjs')).href}?mut=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const mutated = await import(url)
  return mutated.registerGuard
}

function setupMutated(register, config, deps = {}) {
  const warnings = []
  const fake = createFakeApi(config)
  register(fake.api, { now: () => NOON, warn: (message) => warnings.push(String(message)), ...deps })
  return { ...fake, warnings }
}

await r.check('M1', 'MUTATION：isGroupTarget 对私聊返回 true → 「私聊放行」断言会变红', async () => {
  const register = await importMutatedGuard({
    policyEdits: [["if (sessionKey.includes(':qqbot:group:')) return true", 'if (true) return true']]
  })
  const fake = setupMutated(register, guardConfig({ policy: { replyEnabled: false } }))
  const result = await sendMessage(fake, { to: DM_TO, content: '你好' }, dmCtx)
  assertDeepEq(
    result,
    { cancel: true, cancelReason: GUARD_REASONS.REPLY_DISABLED },
    '改坏后私聊被取消（说明 G1 的私聊负向断言能抓住这个回退）'
  )
  return 'mutation caught: 私聊被误判为群'
})

await r.check('M2', 'MUTATION：词 block 判定失效 → 「命中即取消」断言会变红', async () => {
  const register = await importMutatedGuard({
    guardEdits: [['if (filtered.cancel) {', 'if (false) {']]
  })
  const fake = setupMutated(register, guardConfig({ policy: { words: { action: 'block' } } }))
  const result = await sendMessage(fake, { to: GROUP_TO, content: '老婆我回来了' }, groupCtx)
  assertEq(result, undefined, '改坏后词命中不再取消（说明 G2 的 block 断言能抓住）')
  return 'mutation caught: 词 block 被绕过'
})

await r.check('M3', 'MUTATION：日上限判定失效 → 「第 N+1 条被拦」断言会变红', async () => {
  const register = await importMutatedGuard({
    policyEdits: [['if (cap <= 0 || count >= cap) {', 'if (false) {']]
  })
  const store = memoryStore({ version: 1, day: TODAY, counts: { [GROUP_ID]: 1 } })
  const fake = setupMutated(
    register,
    guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }),
    store.deps
  )
  assertEq(
    await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    '改坏后已用满仍放行（说明 G4 的日上限断言能抓住）'
  )
  return 'mutation caught: 日上限被绕过'
})

await r.check('M4', 'MUTATION：记忆隔离拦截失效 → 「群里 write 被 block」断言会变红', async () => {
  const register = await importMutatedGuard({
    guardEdits: [['if (policy.memoryIsolated && GROUP_MEMORY_TOOLS.includes(toolName)) {', 'if (false) {']]
  })
  const fake = setupMutated(register, guardConfig())
  const result = await callTool(fake, { toolName: 'write', params: { file_path: '/tmp/x' } }, groupCtx)
  assertEq(result, undefined, '改坏后群里 write 放行（说明 G6 的记忆隔离断言能抓住）')
  return 'mutation caught: 记忆隔离被绕过'
})

await r.check('M5', 'MUTATION：跨天清零失效 → 「次日重新可发」断言会变红', async () => {
  const register = await importMutatedGuard({
    policyEdits: [['if (raw.day !== target) return { version: GUARD_CONFIG_VERSION, day: target, counts: {} }', 'if (false) return { version: GUARD_CONFIG_VERSION, day: target, counts: {} }']]
  })
  const store = memoryStore({ version: 1, day: YESTERDAY, counts: { [GROUP_ID]: 5 } })
  const fake = setupMutated(
    register,
    guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }),
    store.deps
  )
  const result = await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx)
  assertDeepEq(
    result,
    { block: true, blockReason: GUARD_REASONS.VOICE_DAILY_CAP },
    '改坏后昨天的计数带到今天，次日被误拦（说明 G4 的跨天断言能抓住）'
  )
  return 'mutation caught: 跨天未清零'
})

// ── G10：reply_payload_sending 群判定 ───────────────────────────────────────
await r.check('G10', 'reply_payload_sending 群判定：channel/sessionKey 两条路；私聊/非 qqbot/纯文本/坏 event 放行', async () => {
  const off = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  // event.channel 缺失 → 用 ctx.channelId 兜底
  const byCtx = await sendReplyPayload(off, replyEvent(voicePayload(), { channel: undefined }), groupCtx)
  assertEq(byCtx?.reason, GUARD_REASONS.VOICE_DISABLED, 'channel 缺失时按 ctx.channelId=qqbot 判定为群')
  // 负向
  assertEq(
    await sendReplyPayload(off, replyEvent(voicePayload(), { sessionKey: DM_SESSION }), dmCtx),
    undefined,
    '私聊语音 payload 原样放行'
  )
  assertEq(
    await sendReplyPayload(off, replyEvent(voicePayload(), { channel: 'telegram', sessionKey: 'agent:feiyu:telegram:group:1' })),
    undefined,
    '非 qqbot 渠道放行'
  )
  assertEq(await sendReplyPayload(off, replyEvent({ text: '纯文本' }), groupCtx), undefined, '纯文本 payload 放行')
  assertEq(await sendReplyPayload(off, undefined, groupCtx), undefined, 'event 缺失不抛错')
  return '群判定两条路 + 四条负向都正确'
})

// ── G11：关群语音 → 剥离语音保留文本 ────────────────────────────────────────
await r.check('G11', '群语音关闭：reply payload 剥离语音、保留 text；reason=group-voice-disabled', async () => {
  const off = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  const result = await sendReplyPayload(off, replyEvent(voicePayload()), groupCtx)
  assertEq(result.reason, GUARD_REASONS.VOICE_DISABLED, 'reason 正确')
  assertEq(result.cancel, undefined, '有文本 → 不整条取消')
  assertEq(result.payload.text, '在呢', 'text 保留')
  assertEq(result.payload.audioAsVoice, false, 'audioAsVoice 关闭')
  assertEq(result.payload.mediaUrls.length, 0, '语音 media 被剥')
  assertDeepEq(result.payload.attachments, [], '附件同步清空')
  // 负向：原 payload 不被就地修改
  const original = voicePayload()
  await sendReplyPayload(off, replyEvent(original), groupCtx)
  assertEq(original.mediaUrls.length, 1, '原 payload 不被修改（纯函数剥离）')
  assertEq(original.audioAsVoice, true, '原 payload 标记不变')
  return '剥离语音 + 保留文本 + 不改原对象'
})

// ── G12：纯语音 payload → 整条取消 ─────────────────────────────────────────
await r.check('G12', '纯语音 payload：剥离后无 text/media → cancel；audioAsVoice 无媒体也取消', async () => {
  const off = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  assertDeepEq(
    await sendReplyPayload(off, replyEvent({ mediaUrl: 'v.silk', audioAsVoice: true }), groupCtx),
    { cancel: true, reason: GUARD_REASONS.VOICE_DISABLED },
    '纯语音（无文本）→ 整条取消'
  )
  assertDeepEq(
    await sendReplyPayload(off, replyEvent({ audioAsVoice: true }), groupCtx),
    { cancel: true, reason: GUARD_REASONS.VOICE_DISABLED },
    'audioAsVoice 且无 text/media → 取消'
  )
  // 负向：私聊纯语音仍原样放行
  assertEq(
    await sendReplyPayload(off, replyEvent({ mediaUrl: 'v.silk', audioAsVoice: true }, { sessionKey: DM_SESSION }), dmCtx),
    undefined,
    '私聊纯语音放行'
  )
  return '取消路径与私聊负向都正确'
})

// ── G13：日上限（渠道语音路径） ─────────────────────────────────────────────
await r.check('G13', 'reply 语音日上限：第 1 条放行计数、第 2 条剥离/取消；按群隔离', async () => {
  const store = memoryStore()
  const fake = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store.deps)
  assertEq(await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx), undefined, '第 1 条放行（不改 payload）')
  assertEq(store.value.counts[GROUP_ID], 1, '计入该群额度')
  const second = await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx)
  assertEq(second.reason, GUARD_REASONS.VOICE_DAILY_CAP, '第 2 条触发日上限')
  assertEq(second.payload.text, '在呢', '超限时仍保留文本')
  assertDeepEq(
    await sendReplyPayload(fake, replyEvent({ mediaUrl: 'v2.silk', audioAsVoice: true }), groupCtx),
    { cancel: true, reason: GUARD_REASONS.VOICE_DAILY_CAP },
    '超限的纯语音 → 取消'
  )
  // 负向：另一个群独立额度
  const ctx2 = { channelId: 'qqbot', sessionKey: GROUP_SESSION_2 }
  assertEq(
    await sendReplyPayload(fake, replyEvent(voicePayload(), { sessionKey: GROUP_SESSION_2 }), ctx2),
    undefined,
    '另一个群不受本群额度影响'
  )
  assertEq(store.value.counts[GROUP_ID], 1, '本群计数不被另一群改写')
  return '阈值/剥离/取消/按群隔离都正确'
})

// ── G14：attachments 对齐剥离 ───────────────────────────────────────────────
await r.check('G14', 'attachments 与 mediaUrls 下标对齐：只剥音频项、保留图片/文件项', async () => {
  const off = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  // 语音在前、图片在后
  const audioFirst = await sendReplyPayload(
    off,
    replyEvent({
      text: '看图',
      mediaUrls: ['v.silk', 'pic.png'],
      attachments: [{ type: 'audio' }, { type: 'image', mimeType: 'image/png' }],
      audioAsVoice: false
    }),
    groupCtx
  )
  assertDeepEq(audioFirst.payload.mediaUrls, ['pic.png'], '保留图片 media')
  assertDeepEq(audioFirst.payload.attachments, [{ type: 'image', mimeType: 'image/png' }], '附件同步对齐')
  // 图片在前、语音在后
  const audioSecond = await sendReplyPayload(
    off,
    replyEvent({
      text: '看图',
      mediaUrls: ['pic.png', 'v.silk'],
      attachments: [{ type: 'image' }, { type: 'audio' }],
      audioAsVoice: false
    }),
    groupCtx
  )
  assertDeepEq(audioSecond.payload.mediaUrls, ['pic.png'], '第二项语音被剥、第一项保留')
  assertEq(audioSecond.payload.attachments.length, 1, '附件只剩图片项')
  // 无 attachments 但 audioAsVoice：mediaUrls 全是语音候选
  const noAttachments = await sendReplyPayload(
    off,
    replyEvent({ text: '嗯', mediaUrls: ['v1.silk', 'v2.silk'], audioAsVoice: true }),
    groupCtx
  )
  assertDeepEq(noAttachments.payload.mediaUrls, [], '无附件信息时按 audioAsVoice 全剥')
  return '两种对齐顺序 + 无附件兜底都正确'
})

// ── G15：两条语音路径共用额度 ───────────────────────────────────────────────
await r.check('G15', '渠道语音与 platform_api 上传共用同一 group/day 额度（双向）', async () => {
  // 先 tool 上传放行 → 再 reply 语音应超限
  const store = memoryStore()
  const fake = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store.deps)
  assertEq(
    await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    undefined,
    'tool 上传第 1 条放行'
  )
  const replyAfterTool = await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx)
  assertEq(replyAfterTool.reason, GUARD_REASONS.VOICE_DAILY_CAP, 'reply 语音被同一额度拦住')
  assertEq(store.value.counts[GROUP_ID], 1, '两条路径共用同一计数键，不重复计')
  // 反向：先 reply 放行 → tool 上传应被拦
  const store2 = memoryStore()
  const fake2 = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store2.deps)
  assertEq(await sendReplyPayload(fake2, replyEvent(voicePayload()), groupCtx), undefined, 'reply 语音第 1 条放行')
  assertDeepEq(
    await callTool(fake2, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    { block: true, blockReason: GUARD_REASONS.VOICE_DAILY_CAP },
    'tool 上传被 reply 用掉的同群额度拦住'
  )
  assertEq(store2.value.counts[GROUP_ID], 1, '反向也共用同一计数')
  return '两条出站路径共用额度（双向验证）'
})

// ── G16：reply 路径 fail-open ───────────────────────────────────────────────
await r.check('G16', 'reply 路径 fail-open：状态读/写失败不阻断、handler 异常放行', async () => {
  const readFail = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 2 } } }), {
    readState: () => {
      throw new Error('EACCES')
    },
    writeState: () => {}
  })
  assertEq(
    await sendReplyPayload(readFail, replyEvent(voicePayload()), groupCtx),
    undefined,
    '读失败 → 语音照发（放行，不误剥离）'
  )
  assert(readFail.warningsText().includes('state read failed'), '读失败留 warn')

  const writeFail = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), {
    readState: () => null,
    writeState: () => {
      throw new Error('EPERM')
    }
  })
  assertEq(await sendReplyPayload(writeFail, replyEvent(voicePayload()), groupCtx), undefined, '写失败不阻断第 1 条')
  const second = await sendReplyPayload(writeFail, replyEvent(voicePayload()), groupCtx)
  assertEq(second.reason, GUARD_REASONS.VOICE_DAILY_CAP, '写失败仍按进程内计数拦住第 2 条')
  assert(writeFail.warningsText().includes('state write failed'), '写失败留 warn')

  // handler 内部异常（payload 的 mediaUrls getter 抛错）→ fail-open
  const badPayload = { text: 'x' }
  Object.defineProperty(badPayload, 'mediaUrls', {
    get() {
      throw new Error('boom')
    }
  })
  const thrown = await sendReplyPayload(setup(guardConfig()), replyEvent(badPayload), groupCtx)
  assertEq(thrown, undefined, 'handler 异常 → 返回 undefined 让原 payload 照发')
  return '三类异常都 fail-open'
})

// ── MUTATION M6/M7：渠道语音路径改坏必须被断言抓住 ──────────────────────────
await r.check('M6', 'MUTATION：剥离后改成整条 cancel → 「保留 text」断言会变红', async () => {
  const register = await importMutatedGuard({
    guardEdits: [['if (payloadHasVisibleContent(strippedPayload)) {', 'if (false) {']]
  })
  const fake = setupMutated(register, guardConfig({ policy: { voice: { enabled: false } } }))
  assertDeepEq(
    await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx),
    { cancel: true, reason: GUARD_REASONS.VOICE_DISABLED },
    '改坏后带文本的语音 payload 被整条取消（说明 G11 的「保留 text」断言能抓住）'
  )
  return 'mutation caught: 剥离退化成整条取消'
})

await r.check('M7', 'MUTATION：剥离时漏删语音 media → 「语音 media 被剥」断言会变红', async () => {
  const register = await importMutatedGuard({
    policyEdits: [['if (voiceFlags[index]) {', 'if (false) {']]
  })
  const fake = setupMutated(register, guardConfig({ policy: { voice: { enabled: false } } }))
  const result = await sendReplyPayload(
    fake,
    replyEvent({
      text: '看图',
      mediaUrls: ['v.silk', 'pic.png'],
      attachments: [{ type: 'audio' }, { type: 'image' }],
      audioAsVoice: false
    }),
    groupCtx
  )
  assertDeepEq(result.payload.mediaUrls, ['v.silk', 'pic.png'], '改坏后语音 media 仍在（说明 G11/G14 的剥离断言能抓住）')
  return 'mutation caught: 语音 media 未被剥离'
})

// ── G17：同一 payload 重放只计一次 ─────────────────────────────────────────
await r.check('G17', 'reply 语音幂等：同一 payload 对象重复派发只占一次额度', async () => {
  const store = memoryStore()
  const fake = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store.deps)
  const payload = voicePayload()
  const event = replyEvent(payload)
  assertEq(await sendReplyPayload(fake, event, groupCtx), undefined, '第 1 次派发放行并计数')
  assertEq(store.value.counts[GROUP_ID], 1, '计数 1')
  assertEq(await sendReplyPayload(fake, event, groupCtx), undefined, '同一 payload 重放放行（不重复占额度）')
  assertEq(store.value.counts[GROUP_ID], 1, '重放后计数仍为 1')
  // 负向：新 payload 才吃第二份额度 → 被拦
  const fresh = await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx)
  assertEq(fresh.reason, GUARD_REASONS.VOICE_DAILY_CAP, '新 payload 才触发日上限')
  return '同 payload 幂等 + 新 payload 正常计数'
})

// ── G9：与宿主配置编译器的形状契约 ─────────────────────────────────────────
await r.check('G9', '宿主 buildGuardConfig 输出形状原样通过 parseGuardConfig（不改写/不丢字段）', () => {
  // 形状来自 electron/main/services/characterGroupConfig.ts buildGuardConfig + GroupSettings 默认值
  const hostConfig = {
    version: 1,
    statePath: 'D:/data/character/group-guard-state.json',
    timezone: 'Asia/Shanghai',
    policy: {
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
    }
  }
  assertDeepEq(parseGuardConfig(hostConfig), hostConfig, '编译器输出与解析结果完全一致')
  // 负向：编译器新增字段时，解析结果不应把它当策略（未知字段丢弃）
  const withNewField = { ...hostConfig, policy: { ...hostConfig.policy, newPolicy: true } }
  assertEq('newPolicy' in parseGuardConfig(withNewField).policy, false, '未知策略字段不进结果')
  return '宿主编译器形状 round-trip 一致'
})

// ── G18：attachments-only 语音也要受群语音策略约束 ──────────────────────────
await r.check('G18', 'attachments-only 音频：群语音关闭/上限同样拦截（不能只认 mediaUrls/audioAsVoice）', async () => {
  const off = setup(guardConfig({ policy: { voice: { enabled: false, dailyCap: 2 } } }))
  const stripped = await sendReplyPayload(
    off,
    replyEvent({ text: '在呢', attachments: [{ type: 'audio', path: 'x.silk' }] }),
    groupCtx
  )
  assertEq(stripped.reason, GUARD_REASONS.VOICE_DISABLED, 'attachments-only 语音被识别')
  assertEq(stripped.payload.text, '在呢', 'text 保留')
  assertDeepEq(stripped.payload.attachments, [], '音频 attachment 被剥离')

  const store = memoryStore()
  const on = setup(guardConfig({ policy: { voice: { enabled: true, dailyCap: 1 } } }), store.deps)
  assertEq(
    await sendReplyPayload(on, replyEvent({ text: 'a', attachments: [{ type: 'audio' }] }), groupCtx),
    undefined,
    '第 1 条 attachments-only 语音放行并计数'
  )
  const second = await sendReplyPayload(on, replyEvent({ text: 'b', attachments: [{ mimeType: 'audio/silk' }] }), groupCtx)
  assertEq(second.reason, GUARD_REASONS.VOICE_DAILY_CAP, '第 2 条按日上限拦')
  assertEq(
    await sendReplyPayload(on, replyEvent({ text: 'c', attachments: [{ type: 'image' }] }), groupCtx),
    undefined,
    '非音频 attachments-only 放行'
  )
  return 'attachments-only 语音覆盖 + 图片负向'
})

// ── G19：replyEnabled=false 覆盖 reply_payload_sending ─────────────────────
await r.check('G19', '群回复关闭：reply_payload_sending 整条 cancel（文字/语音都取消），私聊放行', async () => {
  const fake = setup(guardConfig({ policy: { replyEnabled: false } }))
  assertDeepEq(
    await sendReplyPayload(fake, replyEvent({ text: '你好' }), groupCtx),
    { cancel: true, reason: GUARD_REASONS.REPLY_DISABLED },
    '文字 payload 取消'
  )
  assertDeepEq(
    await sendReplyPayload(fake, replyEvent(voicePayload()), groupCtx),
    { cancel: true, reason: GUARD_REASONS.REPLY_DISABLED },
    '语音 payload 取消'
  )
  assertEq(
    await sendReplyPayload(fake, replyEvent({ text: '你好' }, { sessionKey: DM_SESSION }), dmCtx),
    undefined,
    '私聊 payload 不取消'
  )
  return 'reply 路径受 replyEnabled 硬控，私聊不受影响'
})

// ── G20：replyEnabled=false 覆盖 before_tool_call 群发送 ───────────────────
await r.check('G20', '群回复关闭：qqbot_platform_api 群发送被 block，私聊工具调用放行', async () => {
  const fake = setup(guardConfig({ policy: { replyEnabled: false } }))
  assertDeepEq(
    await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, groupCtx),
    { block: true, blockReason: GUARD_REASONS.REPLY_DISABLED },
    '群平台 API 发送被 block'
  )
  assertEq(
    await callTool(fake, { toolName: 'qqbot_platform_api', params: voiceUploadParams(GROUP_ID) }, dmCtx),
    undefined,
    '私聊工具调用放行'
  )
  return 'tool 路径受 replyEnabled 硬控'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-guard-plugin.json'), result)
process.exitCode = ok ? 0 : 1
